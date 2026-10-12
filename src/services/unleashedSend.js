// Sends completed requisitions (as Warehouse Stock Transfers) and completed
// jobs (as Assemblies) straight to Unleashed, as Parked — someone completes
// them in Unleashed, as with the CSV import.
//
// No duplicates: send_started_at is saved before calling Unleashed. If a
// reply is lost (timeout, server error) the record may or may not exist
// there, so the next attempt first searches Unleashed for its [PH <id>]
// tag and adopts what it finds instead of creating another one.

import { UserError } from './rows.js';
import { getRequisition, listRequisitions } from './requisitions.js';
import { getEntry, listEntries } from './schedule.js';
import { getRecipe } from './stock.js';
import { computeEntryStatus } from '../domain/schedule.js';
import { transferPayload, assemblyPayload, trackingPayload, hasTag } from '../domain/unleashedPayloads.js';
import { prepareApproval, markApprovedIfDone, prepareArrival } from './collections.js';
import { BULK_STORE, HOLDING, warehouseOf, legName, legPayload } from '../domain/collections.js';

// 4xx = Unleashed refused it, so nothing was created and it's safe to retry
// as new. Anything else (no reply, 5xx) leaves the outcome unknown.
const definitelyNotCreated = (err) => err.status >= 400 && err.status < 500;

const dayBefore = (d) => new Date(new Date(d).getTime() - 86400e3).toISOString().slice(0, 10);

async function findByTag(client, resource, since, id) {
  const items = await client.getAll(resource, { modifiedSince: dayBefore(since) }, 200);
  return items.find((x) => hasTag(x.Comments, id)) || null;
}

// Unleashed shows the API key's owner as "Created By", so who actually
// pressed Send goes at the end of the Comments.
const signed = (payload, sentBy) => (sentBy ? { ...payload, Comments: `${payload.Comments} · Sent by ${sentBy}` } : payload);

function requireClient(client) {
  if (!client) throw new UserError('The Unleashed API is not connected (UNLEASHED_API_ID / UNLEASHED_API_KEY).', 503);
}

// ---------- transfers ----------

export async function sendTransfer(db, client, id, { sentBy } = {}) {
  requireClient(client);
  const req = await getRequisition(db, id);
  if (!req) throw new UserError('Requisition not found.', 404);
  if (req.unleashedGuid) return { id, number: req.transferNumber, already: true };
  if (req.exportedAt) throw new UserError(`Already exported by CSV as ${req.transferNumber} — not sent again.`, 409);
  if (req.status !== 'done') throw new UserError('Mark the requisition Completed before sending it.', 409);

  // A previous attempt may have reached Unleashed — look before creating.
  if (req.sendStartedAt) {
    const found = await findByTag(client, 'WarehouseStockTransfers', req.sendStartedAt, id);
    if (found) return recordTransfer(db, id, found, true);
  }

  const payload = signed(transferPayload(req), sentBy);
  await db.query('UPDATE requisitions SET send_started_at = now(), send_error = NULL WHERE id = $1', [id]);
  try {
    const created = await client.post('WarehouseStockTransfers', payload);
    return recordTransfer(db, id, created, false);
  } catch (err) {
    await db.query(
      `UPDATE requisitions SET send_error = $2${definitelyNotCreated(err) ? ', send_started_at = NULL' : ''} WHERE id = $1`,
      [id, err.message],
    );
    throw new UserError(err.message, 502);
  }
}

async function recordTransfer(db, id, t, recovered) {
  await db.query(
    `UPDATE requisitions SET unleashed_guid = $2, transfer_number = $3, exported_at = now(), send_error = NULL, updated_at = now()
      WHERE id = $1`,
    [id, t.Guid, t.TransferOrderNumber || null],
  );
  return { id, number: t.TransferOrderNumber || null, status: t.TransferStatus || 'Parked', recovered };
}

// Why a requisition isn't sent — shown when there's nothing to send.
export function transferSkipReason(r) {
  if (r.unleashedGuid) return `already sent as ${r.transferNumber || 'a transfer'}`;
  if (r.exportedAt) return `already exported by CSV${r.transferNumber ? ' as ' + r.transferNumber : ''}`;
  if (r.status !== 'done') return 'not marked Completed yet';
  if (!r.lines.length) return 'has no materials';
  return null;
}

// Every completed requisition for the date not yet in Unleashed.
export async function sendTransfersForDate(db, client, date, opts = {}) {
  requireClient(client);
  const all = await listRequisitions(db, { date });
  const todo = all.filter((r) => transferSkipReason(r) === null);
  if (todo.length === 0) {
    if (all.length === 0) throw new UserError(`No requisitions for ${date}.`);
    const why = all.map((r) => `${r.line}: ${transferSkipReason(r)}`).join('; ');
    throw new UserError(`Nothing to send for ${date} — ${why}.`);
  }
  const results = [];
  for (const r of todo) {
    try { results.push({ ok: true, line: r.line, ...(await sendTransfer(db, client, r.id, opts)) }); }
    catch (err) { results.push({ ok: false, id: r.id, line: r.line, error: err.message }); }
  }
  return results;
}

// ---------- assemblies ----------

export async function sendAssembly(db, client, id, { productionEmail, sentBy } = {}) {
  requireClient(client);
  const entry = await getEntry(db, id);
  if (!entry) throw new UserError('Job not found.', 404);
  if (entry.unleashedGuid) {
    // Created earlier; only the batch numbers may still need attaching.
    if (entry.trackingError) await attachTracking(db, client, entry, true);
    return { id, number: entry.unleashedNumber, already: true };
  }
  if (entry.exportedAt) throw new UserError('Already exported by CSV — not sent again.', 409);
  if (computeEntryStatus(entry) !== 'done') throw new UserError('Mark the job Completed before sending it.', 409);

  let created = null, recovered = false;
  if (entry.sendStartedAt) {
    created = await findByTag(client, 'Assemblies', entry.sendStartedAt, id);
    recovered = !!created;
  }
  if (!created) {
    const payload = signed(assemblyPayload(entry, await getRecipe(db, entry.sku), { productionEmail }), sentBy);
    await db.query('UPDATE schedule_entries SET send_started_at = now(), send_error = NULL WHERE id = $1', [id]);
    try {
      created = await client.post('Assemblies', payload);
    } catch (err) {
      await db.query(
        `UPDATE schedule_entries SET send_error = $2${definitelyNotCreated(err) ? ', send_started_at = NULL' : ''} WHERE id = $1`,
        [id, err.message],
      );
      throw new UserError(err.message, 502);
    }
  }
  await db.query(
    `UPDATE schedule_entries SET unleashed_guid = $2, unleashed_number = $3, exported_at = now(), send_error = NULL, updated_at = now()
      WHERE id = $1`,
    [id, created.Guid, created.AssemblyNumber || null],
  );
  // A recovered assembly may already carry its batches; replace rather than append.
  const trackingOk = await attachTracking(db, client, { ...entry, unleashedGuid: created.Guid }, recovered);
  return { id, number: created.AssemblyNumber || null, status: created.AssemblyStatus || 'Parked', recovered, trackingOk };
}

// Attaches the component batch numbers. A failure here doesn't undo the
// assembly; it's recorded and retried on the next send.
async function attachTracking(db, client, entry, replace) {
  const body = trackingPayload(entry);
  if (!body) {
    await db.query('UPDATE schedule_entries SET tracking_error = NULL WHERE id = $1', [entry.id]);
    return true;
  }
  try {
    await client[replace ? 'put' : 'post'](`Assemblies/${entry.unleashedGuid}/ProductTracking`, body);
    await db.query('UPDATE schedule_entries SET tracking_error = NULL WHERE id = $1', [entry.id]);
    return true;
  } catch (err) {
    await db.query('UPDATE schedule_entries SET tracking_error = $2 WHERE id = $1', [entry.id, err.message]);
    return false;
  }
}

// Every completed job for the date not yet in Unleashed (plus any whose
// batch numbers still need attaching).
export async function sendAssembliesForDate(db, client, date, opts) {
  requireClient(client);
  const all = await listEntries(db, { date });
  const todo = all
    .filter((e) => computeEntryStatus(e) === 'done' && ((!e.exportedAt) || (e.unleashedGuid && e.trackingError)))
    .sort((a, b) => (a.sku !== b.sku ? (a.sku < b.sku ? -1 : 1) : (a.seq || 1) - (b.seq || 1)));
  if (todo.length === 0) {
    if (all.length === 0) throw new UserError(`No jobs for ${date}.`);
    const done = all.filter((e) => computeEntryStatus(e) === 'done');
    const viaCsv = done.filter((e) => e.exportedAt && !e.unleashedGuid).length;
    const sent = done.filter((e) => e.unleashedGuid).length;
    const parts = [
      all.length > done.length ? `${all.length - done.length} of ${all.length} job(s) not marked Done yet` : null,
      viaCsv ? `${viaCsv} already exported by CSV` : null,
      sent ? `${sent} already sent` : null,
    ].filter(Boolean);
    throw new UserError(`Nothing to send for ${date} — ${parts.join(', ')}.`);
  }
  const results = [];
  for (const e of todo) {
    try { results.push({ ok: true, sku: e.sku, seq: e.seq, ...(await sendAssembly(db, client, e.id, opts)) }); }
    catch (err) { results.push({ ok: false, id: e.id, sku: e.sku, seq: e.seq, error: err.message }); }
  }
  return results;
}

// ---------- stock collections ----------
// Approving a truck sheet sends one transfer per section on that truck
// (PRD -> CPT for Cape Town and Digistics, PRD -> HLD for the rest); the
// second leg is one transfer per destination (HLD -> destination). Same
// tag-based recovery as requisitions: "cd<dispatch id>" / "ca<arrival id>".

async function sendLeg(db, client, { table, id, startedAt, tag, payload, numberCols }) {
  let t = startedAt ? await findByTag(client, 'WarehouseStockTransfers', startedAt, tag) : null;
  const recovered = !!t;
  if (!t) {
    await db.query(`UPDATE ${table} SET ${numberCols.started} = now(), send_error = NULL WHERE id = $1`, [id]);
    try {
      t = await client.post('WarehouseStockTransfers', payload);
    } catch (err) {
      await db.query(
        `UPDATE ${table} SET send_error = $2${definitelyNotCreated(err) ? `, ${numberCols.started} = NULL` : ''} WHERE id = $1`,
        [id, err.message],
      );
      throw new UserError(err.message, 502);
    }
  }
  await db.query(
    `UPDATE ${table} SET ${numberCols.guid} = $2, transfer_number = $3, ${numberCols.exported} = now(), send_error = NULL WHERE id = $1`,
    [id, t.Guid, t.TransferOrderNumber || null],
  );
  return { number: t.TransferOrderNumber || null, recovered };
}

// "Approve & send RML".
export async function sendTruck(db, client, date, truck, { sentBy } = {}) {
  requireClient(client);
  const { pending } = await prepareApproval(db, date, truck);
  const results = [];
  for (const { collection: c, dispatch: d, items, to, comments } of pending) {
    try {
      const r = await sendLeg(db, client, {
        table: 'collection_dispatches', id: d.id, startedAt: d.sendStartedAt, tag: `cd${d.id}`,
        payload: signed(legPayload({ from: BULK_STORE, to, comments, items, tag: `cd${d.id}` }), sentBy),
        numberCols: { started: 'dispatch_send_started_at', guid: 'dispatch_guid', exported: 'dispatch_exported_at' },
      });
      results.push({ ok: true, destination: c.destination, truck, to, ...r });
    } catch (err) {
      results.push({ ok: false, destination: c.destination, truck, error: err.message });
    }
  }
  await markApprovedIfDone(db, date, truck);
  return results;
}

// "Arrived — send HLD -> ZARMI-JHB": everything waiting at HLD for that destination.
export async function sendArrival(db, client, collectionId, { sentBy } = {}) {
  requireClient(client);
  const { collection: c, arrival: a, items } = await prepareArrival(db, collectionId);
  const r = await sendLeg(db, client, {
    table: 'collection_arrivals', id: a.id, startedAt: a.sendStartedAt, tag: `ca${a.id}`,
    payload: signed(legPayload({ from: HOLDING, to: warehouseOf(c.destination), comments: legName(c.destination), items, tag: `ca${a.id}` }), sentBy),
    numberCols: { started: 'send_started_at', guid: 'guid', exported: 'exported_at' },
  });
  return { ok: true, destination: c.destination, to: warehouseOf(c.destination), ...r };
}
