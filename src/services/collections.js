// Stock Collection persistence, shaped like the paper process: the day's
// list (sections + Qty Req), one truck sheet per truck (Qty Trf + Batch),
// Loaded -> Approved, transfers per section per truck, and the second leg
// per destination. Rules live in domain/collections.js.

import { groupBy, UserError } from './rows.js';
import { listEntries } from './schedule.js';
import { pad8 } from '../domain/csv.js';
import { finishedBatchNumber } from '../domain/unleashedPayloads.js';
import {
  DESTINATION_LABELS, TRUCKS, HOLDING, BULK_STORE, needsHoldingLeg, firstLegTo, warehouseOf, legName,
  truckTransfers, transferRows, transfersCsv, parseBatches,
} from '../domain/collections.js';

const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);
const num = (v) => (v === null || v === undefined ? null : Number(v));

// ---------- reading ----------

// sku -> needs a batch: only finished goods Unleashed batch-tracks (pallets
// and products it doesn't track need none).
async function batchFlags(q, skus) {
  if (!skus.length) return new Map();
  const rows = (await q.query('SELECT sku, is_batch_tracked FROM recipes WHERE sku = ANY($1)', [skus])).rows;
  return new Map(rows.map((r) => [r.sku, r.is_batch_tracked !== false]));
}

const COLS = `id, to_char(date, 'YYYY-MM-DD') AS date, destination, driver, created_at, updated_at`;

export async function listCollections(q, { date, ids } = {}) {
  const where = [];
  const params = [];
  if (date) { params.push(date); where.push(`date = $${params.length}`); }
  if (ids) { params.push(ids); where.push(`id = ANY($${params.length})`); }
  const rows = (await q.query(
    `SELECT ${COLS} FROM collections ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date DESC, created_at`, params,
  )).rows;
  if (!rows.length) return [];
  const cids = rows.map((r) => r.id);
  const lines = (await q.query('SELECT * FROM collection_lines WHERE collection_id = ANY($1) ORDER BY position, id', [cids])).rows;
  const loads = groupBy((await q.query('SELECT * FROM collection_loads WHERE line_id = ANY($1) ORDER BY truck', [lines.map((l) => l.id)])).rows, 'line_id');
  const disp = groupBy((await q.query('SELECT * FROM collection_dispatches WHERE collection_id = ANY($1) ORDER BY id', [cids])).rows, 'collection_id');
  const arr = groupBy((await q.query('SELECT * FROM collection_arrivals WHERE collection_id = ANY($1) ORDER BY id', [cids])).rows, 'collection_id');
  const flags = await batchFlags(q, [...new Set(lines.map((l) => l.sku))]);
  const byColl = groupBy(lines, 'collection_id');
  return rows.map((r) => ({
    id: r.id, date: r.date, destination: r.destination, driver: r.driver,
    label: DESTINATION_LABELS[r.destination] || r.destination,
    warehouse: warehouseOf(r.destination), viaHolding: needsHoldingLeg(r.destination),
    createdAt: iso(r.created_at),
    lines: (byColl.get(r.id) || []).map((l) => ({
      id: Number(l.id), sku: l.sku, description: l.description, qty: num(l.qty), needsBatch: flags.get(l.sku) === true,
      loads: (loads.get(l.id) || []).map((x) => ({
        id: Number(x.id), truck: x.truck, qty: num(x.qty), batch: x.batch,
        dispatchId: num(x.dispatch_id), arrivalId: num(x.arrival_id),
      })),
    })),
    dispatches: (disp.get(r.id) || []).map((d) => ({
      id: Number(d.id), truck: d.truck, createdAt: iso(d.created_at), transferNumber: d.transfer_number,
      exportedAt: iso(d.dispatch_exported_at), guid: d.dispatch_guid, sendStartedAt: iso(d.dispatch_send_started_at), sendError: d.send_error,
    })),
    arrivals: (arr.get(r.id) || []).map((a) => ({
      id: Number(a.id), createdAt: iso(a.created_at), transferNumber: a.transfer_number,
      exportedAt: iso(a.exported_at), guid: a.guid, sendStartedAt: iso(a.send_started_at), sendError: a.send_error,
    })),
  }));
}

export async function getCollection(q, id) {
  return (await listCollections(q, { ids: [id] }))[0] || null;
}

async function sheet(q, date, truck) {
  const r = (await q.query('SELECT * FROM truck_sheets WHERE date = $1 AND truck = $2', [date, truck])).rows[0];
  return { date, truck, loadedAt: iso(r?.loaded_at), approvedAt: iso(r?.approved_at) };
}

function checkTruck(truck) {
  if (!TRUCKS.includes(truck)) throw new UserError(`Unknown truck "${truck}".`);
}

// The whole day: list, both truck sheets, and what's on its way.
export async function collectionDay(q, date) {
  return {
    date,
    collections: await listCollections(q, { date }),
    sheets: await Promise.all(TRUCKS.map((t) => sheet(q, date, t))),
  };
}

// ---------- the list ----------

async function descriptions(q, skus) {
  if (!skus.length) return new Map();
  const rows = (await q.query(
    `SELECT sku, description FROM recipes WHERE sku = ANY($1)
     UNION ALL SELECT product_code, description FROM bulk_stock WHERE product_code = ANY($1)`, [skus],
  )).rows;
  const m = new Map();
  for (const r of rows) if (r.description && !m.has(r.sku)) m.set(r.sku, r.description);
  return m;
}

const newId = () => 'coll_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

// Adds a section's lines to the day's list. If the section already exists
// for that date, lines merge into it: same SKU = its Qty Req is updated.
export async function addToList(db, { date, destination, lines = [] }) {
  if (!DESTINATION_LABELS[destination]) throw new UserError(`Unknown destination "${destination}".`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new UserError('Date must be YYYY-MM-DD.');
  for (const l of lines) if (!l.sku || !(Number(l.qty) > 0)) throw new UserError('Every SKU needs a quantity greater than zero.');
  return db.tx(async (q) => {
    let id = (await q.query('SELECT id FROM collections WHERE date = $1 AND destination = $2', [date, destination])).rows[0]?.id;
    if (!id) {
      id = newId();
      await q.query('INSERT INTO collections (id, date, destination, driver, group_id) VALUES ($1, $2, $3, $4, $1)', [id, date, destination, '']);
    }
    const desc = await descriptions(q, [...new Set(lines.map((l) => l.sku))]);
    for (const l of lines) {
      const existing = (await q.query('SELECT id FROM collection_lines WHERE collection_id = $1 AND sku = $2', [id, l.sku])).rows[0];
      if (existing) {
        await q.query('UPDATE collection_lines SET qty = $2 WHERE id = $1', [existing.id, Number(l.qty)]);
      } else {
        const { m } = (await q.query('SELECT MAX(position) AS m FROM collection_lines WHERE collection_id = $1', [id])).rows[0];
        await q.query('INSERT INTO collection_lines (collection_id, position, sku, description, qty) VALUES ($1, $2, $3, $4, $5)',
          [id, (m ?? -1) + 1, l.sku, desc.get(l.sku) || '', Number(l.qty)]);
      }
    }
    await q.query('UPDATE collections SET updated_at = now() WHERE id = $1', [id]);
    return getCollection(q, id);
  });
}

export async function uploadList(db, groups) {
  for (const g of groups) await addToList(db, g);
  return { sections: groups.length, lines: groups.reduce((s, g) => s + g.lines.length, 0) };
}

async function lineWithCollection(q, lineId) {
  const l = (await q.query(`SELECT l.*, to_char(c.date, 'YYYY-MM-DD') AS date FROM collection_lines l JOIN collections c ON c.id = l.collection_id WHERE l.id = $1`, [lineId])).rows[0];
  if (!l) throw new UserError('That line no longer exists — reload the page.', 404);
  return l;
}

export async function updateLine(db, lineId, { qty }) {
  if (!(Number(qty) > 0)) throw new UserError('Qty Req must be greater than zero.');
  const l = await lineWithCollection(db, lineId);
  await db.query('UPDATE collection_lines SET qty = $2 WHERE id = $1', [lineId, Number(qty)]);
  return getCollection(db, l.collection_id);
}

export async function deleteLine(db, lineId) {
  const l = await lineWithCollection(db, lineId);
  const { n } = (await db.query('SELECT COUNT(*) AS n FROM collection_loads WHERE line_id = $1 AND dispatch_id IS NOT NULL', [lineId])).rows[0];
  if (Number(n)) throw new UserError('Part of this SKU has been dispatched — it can\'t be removed.', 409);
  await db.query('DELETE FROM collection_lines WHERE id = $1', [lineId]);
  return getCollection(db, l.collection_id);
}

export async function updateCollection(db, id, { driver }) {
  await db.query('UPDATE collections SET driver = $2, updated_at = now() WHERE id = $1', [id, String(driver || '').trim()]);
  return getCollection(db, id);
}

export async function deleteCollection(db, id) {
  const c = await getCollection(db, id);
  if (!c) throw new UserError('Section not found.', 404);
  if (c.dispatches.length) throw new UserError('Part of it has been dispatched — it can\'t be deleted.', 409);
  await db.query('DELETE FROM collections WHERE id = $1', [id]);
}

// ---------- truck sheets ----------

// Qty Trf and Batch for one line on one truck, as written on that truck's
// sheet. Empty qty and batch removes it. Locked once approved.
export async function setLoad(db, lineId, truck, { qty, batch }) {
  checkTruck(truck);
  return db.tx(async (q) => {
    const l = await lineWithCollection(q, lineId);
    const s = await sheet(q, l.date, truck);
    if (s.approvedAt) throw new UserError(`The ${truck} sheet is approved — it can no longer change.`, 409);
    const existing = (await q.query('SELECT * FROM collection_loads WHERE line_id = $1 AND truck = $2', [lineId, truck])).rows[0];
    if (existing?.dispatch_id) throw new UserError('Already dispatched — it can no longer change.', 409);
    const amount = qty === '' || qty === null || qty === undefined ? 0 : Number(qty);
    if (!(amount >= 0)) throw new UserError('Qty Trf must be a number.');
    const b = String(batch ?? '').trim() || null;
    // Several batches: their quantities must add up to Qty Trf.
    const split = parseBatches(b, amount);
    if (split.length > 1) {
      const sum = split.reduce((s, e) => s + e.qty, 0);
      if (Math.abs(sum - amount) > 1e-9) throw new UserError(`The batch quantities add up to ${sum}, but Qty Trf is ${amount}.`);
    }
    if (!amount && !b) await q.query('DELETE FROM collection_loads WHERE line_id = $1 AND truck = $2', [lineId, truck]);
    else {
      await q.query(
        `INSERT INTO collection_loads (line_id, truck, qty, batch) VALUES ($1, $2, $3, $4)
         ON CONFLICT (line_id, truck) DO UPDATE SET qty = EXCLUDED.qty, batch = EXCLUDED.batch`,
        [lineId, truck, amount, b],
      );
    }
    return getCollection(q, l.collection_id);
  });
}

// The warehouse marks the sheet loaded (or takes that back before approval).
export async function setLoaded(db, date, truck, loaded) {
  checkTruck(truck);
  return db.tx(async (q) => {
    const s = await sheet(q, date, truck);
    if (s.approvedAt) throw new UserError(`The ${truck} sheet is already approved.`, 409);
    if (loaded) {
      const { missing, transfers } = truckTransfers(await listCollections(q, { date }), truck);
      if (!transfers.length) throw new UserError(`Nothing is on the ${truck} sheet yet — fill in Qty Trf first.`);
      if (missing.length) throw new UserError(`Batch missing on the ${truck} sheet for: ${missing.join(', ')}.`, 409);
    }
    await q.query(
      `INSERT INTO truck_sheets (date, truck, loaded_at) VALUES ($1, $2, $3)
       ON CONFLICT (date, truck) DO UPDATE SET loaded_at = EXCLUDED.loaded_at`,
      [date, truck, loaded ? new Date() : null],
    );
    return sheet(q, date, truck);
  });
}

// Approval step 1 (shared by Send and CSV): one dispatch per section with
// loads on this truck, loads attached to it. Returns every dispatch for the
// truck and date not yet in Unleashed (new ones and any whose send failed),
// with what goes on it.
export async function prepareApproval(db, date, truck) {
  checkTruck(truck);
  return db.tx(async (q) => {
    const s = await sheet(q, date, truck);
    if (!s.loadedAt) throw new UserError(`The ${truck} sheet isn't marked Loaded yet.`, 409);
    const { transfers, missing } = truckTransfers(await listCollections(q, { date }), truck);
    if (missing.length) throw new UserError(`Batch missing on the ${truck} sheet for: ${missing.join(', ')}.`, 409);
    for (const { collection, loads } of transfers) {
      const { id } = (await q.query('INSERT INTO collection_dispatches (collection_id, truck) VALUES ($1, $2) RETURNING id', [collection.id, truck])).rows[0];
      await q.query('UPDATE collection_loads SET dispatch_id = $2 WHERE id = ANY($1)', [loads.map((x) => x.load.id), id]);
    }
    const day = await listCollections(q, { date });
    const pending = [];
    for (const c of day) {
      for (const d of c.dispatches) {
        if (d.truck !== truck || d.exportedAt) continue;
        const items = c.lines.flatMap((l) => l.loads.filter((x) => x.dispatchId === d.id).map((x) => ({ sku: l.sku, qty: x.qty, batch: x.batch })));
        pending.push({ collection: c, dispatch: d, items });
      }
    }
    if (!pending.length) throw new UserError(`Nothing on the ${truck} sheet left to send.`);
    return pending;
  });
}

// Approval step 2: once every dispatch of the truck is in Unleashed.
export async function markApprovedIfDone(q, date, truck) {
  const day = await listCollections(q, { date });
  const unsent = day.some((c) => c.dispatches.some((d) => d.truck === truck && !d.exportedAt));
  if (!unsent) await q.query('UPDATE truck_sheets SET approved_at = COALESCE(approved_at, now()) WHERE date = $1 AND truck = $2', [date, truck]);
}

// ---------- CSV fallback ----------

async function takeNumbers(q, count) {
  const { next } = (await q.query("SELECT next FROM counters WHERE name = 'collection_transfer' FOR UPDATE")).rows[0];
  await q.query("UPDATE counters SET next = $1 WHERE name = 'collection_transfer'", [Number(next) + count]);
  return Array.from({ length: count }, (_, i) => 'MFT-' + pad8(Number(next) + i));
}

async function saveExport(q, kind, date, filename, csv) {
  const { id } = (await q.query('INSERT INTO exports (kind, date, filename, csv) VALUES ($1, $2, $3, $4) RETURNING id',
    [kind, date, filename, csv])).rows[0];
  return { id: Number(id), kind, date, filename };
}

// Approve a truck by CSV: one MFT-numbered transfer per section.
export async function approveTruckCsv(db, date, truck) {
  const pending = await prepareApproval(db, date, truck);
  if (pending.some(({ dispatch }) => dispatch.sendStartedAt)) {
    throw new UserError('A send to Unleashed for this truck is unconfirmed — press Approve & send again instead of using the CSV, so nothing is created twice.', 409);
  }
  return db.tx(async (q) => {
    const numbers = await takeNumbers(q, pending.length);
    const rows = [];
    for (const { collection: c, dispatch: d, items } of pending) {
      const number = numbers.shift();
      rows.push(...transferRows(number, BULK_STORE, firstLegTo(c.destination), legName(c.destination, truck), items));
      await q.query('UPDATE collection_dispatches SET transfer_number = $2, dispatch_exported_at = now(), send_error = NULL WHERE id = $1', [d.id, number]);
    }
    await markApprovedIfDone(q, date, truck);
    return saveExport(q, 'dispatch', date, `stock-collection-${truck}-${date}.csv`, transfersCsv(rows));
  });
}

// Undo a CSV approval that was never uploaded: the sheet goes back to Loaded.
export async function undoTruckCsv(db, date, truck) {
  checkTruck(truck);
  return db.tx(async (q) => {
    const day = await listCollections(q, { date });
    const ds = day.flatMap((c) => c.dispatches.filter((d) => d.truck === truck));
    if (!ds.length) throw new UserError(`Nothing on ${truck} has been approved.`);
    if (ds.some((d) => d.guid || d.sendStartedAt)) throw new UserError('Sent to Unleashed via the API — delete the transfers there first.', 409);
    const arrived = day.some((c) => c.lines.some((l) => l.loads.some((x) => x.truck === truck && x.arrivalId)));
    if (arrived) throw new UserError('Its second leg has already gone — that can\'t be undone here.', 409);
    const ids = ds.map((d) => d.id);
    await q.query('UPDATE collection_loads SET dispatch_id = NULL WHERE dispatch_id = ANY($1)', [ids]);
    await q.query('DELETE FROM collection_dispatches WHERE id = ANY($1)', [ids]);
    await q.query('UPDATE truck_sheets SET approved_at = NULL WHERE date = $1 AND truck = $2', [date, truck]);
    return collectionDay(q, date);
  });
}

// ---------- second leg: HLD -> destination, one per destination ----------

// Every HLD-bound destination with dispatched loads not yet sent on, any
// date, with what's waiting (per SKU and batch, both trucks together).
export async function pendingArrivals(q) {
  const all = await listCollections(q);
  const out = [];
  for (const c of all) {
    if (!c.viaHolding) continue;
    const sentIds = new Set(c.dispatches.filter((d) => d.exportedAt).map((d) => d.id));
    const items = [];
    const trucks = new Set();
    for (const l of c.lines) {
      for (const x of l.loads) {
        if (!x.dispatchId || !sentIds.has(x.dispatchId) || x.arrivalId) continue;
        items.push({ loadId: x.id, sku: l.sku, qty: x.qty, batch: x.batch });
        trucks.add(x.truck);
      }
    }
    const unconfirmed = c.arrivals.find((a) => !a.exportedAt);
    if (items.length || unconfirmed) out.push({ collection: c, items, trucks: [...trucks], unconfirmed: unconfirmed || null });
  }
  return out;
}

// Approval of an arrival (step 1, shared by Send and CSV): an arrival row
// with the waiting loads attached — or the one whose send didn't finish.
export async function prepareArrival(db, collectionId) {
  return db.tx(async (q) => {
    const p = (await pendingArrivals(q)).find((x) => x.collection.id === collectionId);
    if (!p) throw new UserError('Nothing is waiting to go on from HLD for that destination.');
    let arrival = p.unconfirmed;
    if (!arrival) {
      const { id } = (await q.query('INSERT INTO collection_arrivals (collection_id) VALUES ($1) RETURNING id', [collectionId])).rows[0];
      await q.query('UPDATE collection_loads SET arrival_id = $2 WHERE id = ANY($1)', [p.items.map((i) => i.loadId), id]);
      arrival = { id: Number(id) };
    }
    const c = await getCollection(q, collectionId);
    const items = c.lines.flatMap((l) => l.loads.filter((x) => x.arrivalId === arrival.id).map((x) => ({ sku: l.sku, qty: x.qty, batch: x.batch })));
    return { collection: c, arrival: c.arrivals.find((a) => a.id === arrival.id), items };
  });
}

export async function arrivalCsv(db, collectionId, today) {
  const { collection: c, arrival, items } = await prepareArrival(db, collectionId);
  if (arrival.sendStartedAt) throw new UserError('A send to Unleashed for this is unconfirmed — press Send again instead.', 409);
  return db.tx(async (q) => {
    const [number] = await takeNumbers(q, 1);
    await q.query('UPDATE collection_arrivals SET transfer_number = $2, exported_at = now(), send_error = NULL WHERE id = $1', [arrival.id, number]);
    const rows = transferRows(number, HOLDING, warehouseOf(c.destination), legName(c.destination), items);
    return saveExport(q, 'arrival', today, `stock-collection-arrival-${c.destination}-${today}.csv`, transfersCsv(rows));
  });
}

// ---------- suggestions ----------

// Products for the SKU box (finished goods and pallets) and batch
// suggestions per SKU: Unleashed's PRD batches plus that date's Production
// Schedule batches. Batches are typed freely, as on the sheets.
export async function finishedGoodsStock(q, date) {
  const products = (await q.query(
    `SELECT r.sku, r.description, r.is_batch_tracked, b.qty_on_hand FROM recipes r
       LEFT JOIN bulk_stock b ON b.product_code = r.sku
     UNION ALL
     SELECT b.product_code, b.description, false, b.qty_on_hand FROM bulk_stock b
      WHERE b.product_code ILIKE '%PALLET%' AND NOT EXISTS (SELECT 1 FROM recipes r WHERE r.sku = b.product_code)
     ORDER BY 1`,
  )).rows.map((r) => ({ sku: r.sku, description: r.description || '', batchTracked: r.is_batch_tracked === true, onHand: r.qty_on_hand ?? null }));

  const batches = {};
  const ub = (await q.query(
    `SELECT component_sku AS sku, batch_number, quantity_remaining, to_char(expiry_date, 'YYYY-MM-DD') AS expiry
       FROM component_batches WHERE component_sku = ANY($1) ORDER BY expiry_date NULLS LAST, batch_number`,
    [products.map((p) => p.sku)],
  )).rows;
  for (const b of ub) (batches[b.sku] ||= []).push({ batchNumber: b.batch_number, qty: b.quantity_remaining, expiryDate: b.expiry, source: 'unleashed' });
  if (date) {
    const from = new Date(date + 'T00:00:00Z'); from.setUTCDate(from.getUTCDate() - 7);
    for (const e of await listEntries(q, { from: from.toISOString().slice(0, 10), to: date })) {
      const bn = finishedBatchNumber(e);
      if ((batches[e.sku] || []).some((b) => b.batchNumber === bn)) continue;
      const produced = e.actualCases !== null && e.actualCases !== undefined;
      (batches[e.sku] ||= []).push({
        batchNumber: bn, qty: produced ? e.actualCases : e.plannedCases, source: 'schedule',
        note: produced ? (e.status === 'done' ? 'produced, not yet in Unleashed' : 'in production') : 'planned',
      });
    }
  }
  return { products, batches };
}
