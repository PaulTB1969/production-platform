// Stock Collection, shaped like the paper sheets. The main test replays the
// real 7 Oct 2026 sheets: the list, the RML and MFE truck sheets as the
// warehouse filled them in (Digistics lines are part of CPT), approval ->
// 6 transfers (CPT, RML-JHB, ZARMI-JHB per truck), then 2 second legs.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openSiteDb } from './helpers.js';
import { replaceRecipes, replaceComponentBatches } from '../src/services/stock.js';
import { createEntry } from '../src/services/schedule.js';
import * as coll from '../src/services/collections.js';
import { parseCollectionCsv, sheetStatus } from '../src/domain/collections.js';
import { sendTruck, sendArrival } from '../src/services/unleashedSend.js';

const D = '2026-10-07';
let db;

// Finished goods on the sheets; pallets aren't recipes (no batch needed).
const SKUS = ['GN330ST_MF', 'GN330SP_MF', 'GN750ST_MF', 'P330ST_MFSIG_PN', 'P330SP_MFSIG_PN', 'P500ST_MFSIG_PN', 'P500SP_MFSIG_PN',
  'P1.0ST_MFSIG_PN', 'P1.0SP_MFSIG_PN', 'P330ST_TIMEOUT_ZP', 'P1.0ST_TIMEOUT_ZP', 'P1.0ST_SKILPAD_ZP', 'P500SP_SKILPAD_ZP',
  'B20.0_BIB_TAP_BLUE', 'B20.0_BIB_COOLER_BLUE', 'P500ST_SHIFT_ZP', 'P500SP_SHIFT_ZP', 'P500ST_KAUAI_ZP', 'P750ST_KAUAI_ZP', 'P750ST_NU_ZP'];

beforeEach(async () => {
  db = await openSiteDb();
  await replaceRecipes(db, SKUS.map((sku) => ({ sku, description: sku, batchTracked: sku !== 'P500SP_SKILPAD_ZP', lines: [] })));
});
afterEach(() => db.close());

function fakeUnleashed() {
  const store = [];
  let n = 0;
  const u = {
    store, loseReplyNext: false,
    async post(path, body) {
      const rec = { ...body, Guid: `g${++n}`, TransferOrderNumber: `TX-${String(n).padStart(8, '0')}`, TransferStatus: 'Parked' };
      store.push(rec);
      if (u.loseReplyNext) { u.loseReplyNext = false; throw new Error('socket hang up'); }
      return rec;
    },
    async getAll() { return store; },
  };
  return u;
}

// The list as supplied to the warehouse.
const LIST_CSV = `Date,Destination,SKU,Quantity
2026-10-07,CPT,GN330ST_MF,34
2026-10-07,CPT,GN330SP_MF,30
2026-10-07,CPT,GN750ST_MF,60
2026-10-07,CPT,P330ST_MFSIG_PN,84
2026-10-07,CPT,P500ST_MFSIG_PN,144
2026-10-07,CPT,P500SP_MFSIG_PN,72
2026-10-07,CPT,P1.0ST_MFSIG_PN,80
2026-10-07,CPT,P1.0SP_MFSIG_PN,80
2026-10-07,CPT,P330ST_TIMEOUT_ZP,72
2026-10-07,CPT,P1.0ST_TIMEOUT_ZP,75
2026-10-07,CPT,P1.0ST_SKILPAD_ZP,75
2026-10-07,CPT,P500SP_SKILPAD_ZP,72
2026-10-07,CPT,B20.0_BIB_TAP_BLUE,60
2026-10-07,CPT,B20.0_BIB_COOLER_BLUE,60
2026-10-07,CPT,MF_PALLETS,14
2026-10-07,RML-JHB,P330ST_MFSIG_PN,84
2026-10-07,RML-JHB,P330SP_MFSIG_PN,84
2026-10-07,RML-JHB,MF_PALLETS,2
2026-10-07,ZARMI-JHB,P500ST_MFSIG_PN,72
2026-10-07,ZARMI-JHB,P500SP_MFSIG_PN,144
2026-10-07,ZARMI-JHB,P500ST_SHIFT_ZP,36
2026-10-07,ZARMI-JHB,P500SP_SHIFT_ZP,36
2026-10-07,ZARMI-JHB,MF_PALLETS,4
2026-10-07,Digistics (Wed Collection),P500ST_KAUAI_ZP,288
2026-10-07,Digistics (Wed Collection),P750ST_KAUAI_ZP,240
2026-10-07,Digistics (Wed Collection),P750ST_NU_ZP,80
2026-10-07,Digistics (Wed Collection),CHEP_PALLETS,8
`;

// The truck sheets as the warehouse filled them in: [section, sku, qty, batch].
const RML = [
  ['CPT', 'P330ST_MFSIG_PN', 84, '20261007'], ['CPT', 'P500ST_MFSIG_PN', 144, '20261007'], ['CPT', 'P500SP_MFSIG_PN', 72, '20261007'],
  ['CPT', 'P330ST_TIMEOUT_ZP', 84, '20261007'], ['CPT', 'P500SP_SKILPAD_ZP', 72, '20261005'], ['CPT', 'B20.0_BIB_COOLER_BLUE', 60, '20261002'],
  ['CPT', 'MF_PALLETS', 7, ''],
  ['RML-JHB', 'P330ST_MFSIG_PN', 84, '20261007'], ['RML-JHB', 'MF_PALLETS', 1, ''],
  ['ZARMI-JHB', 'P500ST_MFSIG_PN', 72, '20261007'], ['ZARMI-JHB', 'MF_PALLETS', 1, ''],
  ['CPT', 'P500ST_KAUAI_ZP', 216, '20261007 (215) 20261005 (1)'], ['CPT', 'P750ST_KAUAI_ZP', 240, '20261003'],
  ['CPT', 'P750ST_NU_ZP', 80, '20261003'], ['CPT', 'CHEP_PALLETS', 7, ''],
];
const MFE = [
  ['CPT', 'GN330ST_MF', 34, '20261007'], ['CPT', 'GN330SP_MF', 30, '20261007'], ['CPT', 'GN750ST_MF', 60, '20261007'],
  ['CPT', 'P1.0ST_MFSIG_PN', 80, '20261007'], ['CPT', 'P1.0SP_MFSIG_PN', 80, '20261007 (30) 20261001 (50)'],
  ['CPT', 'P1.0ST_TIMEOUT_ZP', 75, '20261006'], ['CPT', 'P1.0ST_SKILPAD_ZP', 75, '20261006'], ['CPT', 'B20.0_BIB_TAP_BLUE', 60, '20261005'],
  ['CPT', 'MF_PALLETS', 7, ''],
  ['RML-JHB', 'P330SP_MFSIG_PN', 84, '20261007'], ['RML-JHB', 'MF_PALLETS', 1, ''],
  ['ZARMI-JHB', 'P500SP_MFSIG_PN', 144, '20261007'], ['ZARMI-JHB', 'P500ST_SHIFT_ZP', 37, '20261007'], ['ZARMI-JHB', 'P500SP_SHIFT_ZP', 37, '20261007'],
  ['ZARMI-JHB', 'MF_PALLETS', 3, ''],
  ['CPT', 'P500ST_KAUAI_ZP', 72, '20261007'], ['CPT', 'CHEP_PALLETS', 1, ''],
];

async function loadList() {
  const { groups, errors } = parseCollectionCsv(LIST_CSV);
  assert.deepEqual(errors, []);
  await coll.uploadList(db, groups);
}
async function fillSheet(truck, rows) {
  const day = await coll.collectionDay(db, D);
  for (const [dest, sku, qty, batch] of rows) {
    const line = day.collections.find((c) => c.destination === dest).lines.find((l) => l.sku === sku);
    await coll.setLoad(db, line.id, truck, { qty, batch });
  }
}
const route = (t) => `${t.SourceWarehouse.WarehouseCode}->${t.DestinationWarehouse.WarehouseCode}`;

test('7 Oct: list -> two truck sheets -> 6 transfers -> 2 second legs', async () => {
  await loadList();
  let day = await coll.collectionDay(db, D);
  assert.deepEqual(day.collections.map((c) => [c.destination, c.lines.length]),
    [['CPT', 19], ['RML-JHB', 3], ['ZARMI-JHB', 5]]);

  await fillSheet('RML', RML);
  await fillSheet('MFE', MFE);
  const u = fakeUnleashed();

  // Not loaded yet: can't approve.
  await assert.rejects(sendTruck(db, u, D, 'RML'), /isn't marked Loaded yet/);
  await coll.setLoaded(db, D, 'RML', true);
  await coll.setLoaded(db, D, 'MFE', true);

  const rml = await sendTruck(db, u, D, 'RML');
  const mfe = await sendTruck(db, u, D, 'MFE');
  assert.equal(rml.length + mfe.length, 6);
  assert.ok([...rml, ...mfe].every((r) => r.ok));
  assert.deepEqual(u.store.map((t) => `${route(t)} ${t.Comments.replace(/ \[PH.*$/, '')}`), [
    'PRD->CPT CPT — Cape Town (RML)', 'PRD->HLD RML-JHB — RM Logistics JHB (RML)', 'PRD->HLD ZARMI-JHB — Johannesburg - Zarmi (RML)',
    'PRD->CPT CPT — Cape Town (MFE)', 'PRD->HLD RML-JHB — RM Logistics JHB (MFE)', 'PRD->HLD ZARMI-JHB — Johannesburg - Zarmi (MFE)',
  ]);
  // Lines as written on the sheet, incl. split batches, over-delivery and pallets.
  const cpt = u.store[0].TransferDetails;
  assert.deepEqual(cpt.find((x) => x.Product.ProductCode === 'P500ST_KAUAI_ZP'), { Product: { ProductCode: 'P500ST_KAUAI_ZP' }, TransferQuantity: 216, Comments: 'Batch 20261007 (215) 20261005 (1)' });
  assert.deepEqual(cpt.find((x) => x.Product.ProductCode === 'CHEP_PALLETS'), { Product: { ProductCode: 'CHEP_PALLETS' }, TransferQuantity: 7 });
  assert.equal(u.store[0].TransferDetails.find((x) => x.Product.ProductCode === 'P330ST_TIMEOUT_ZP').TransferQuantity, 84);

  day = await coll.collectionDay(db, D);
  assert.deepEqual(day.sheets.map((s) => [s.truck, sheetStatus(s)]), [['RML', 'approved'], ['MFE', 'approved'], ['INTERIM', 'open']]);

  // Second leg: one per destination, both trucks together.
  const pending = await coll.pendingArrivals(db);
  assert.deepEqual(pending.map((p) => [p.collection.destination, p.trucks.sort().join('+'), p.items.length]),
    [['RML-JHB', 'MFE+RML', 4], ['ZARMI-JHB', 'MFE+RML', 6]]);
  const zarmi = pending.find((p) => p.collection.destination === 'ZARMI-JHB').collection.id;
  const a = await sendArrival(db, u, zarmi);
  assert.equal(a.to, 'ZARMI-JHB');
  assert.equal(route(u.store[6]), 'HLD->ZARMI-JHB');
  assert.deepEqual(u.store[6].TransferDetails.map((x) => `${x.Product.ProductCode} ${x.TransferQuantity}`).sort(),
    ['MF_PALLETS 1', 'MF_PALLETS 3', 'P500SP_MFSIG_PN 144', 'P500SP_SHIFT_ZP 37', 'P500ST_MFSIG_PN 72', 'P500ST_SHIFT_ZP 37']);
  assert.deepEqual((await coll.pendingArrivals(db)).map((p) => p.collection.destination), ['RML-JHB']);
});

test('Loaded needs a batch for every batch-tracked SKU on the sheet; not for pallets or untracked products', async () => {
  await loadList();
  await fillSheet('RML', [['CPT', 'P330ST_MFSIG_PN', 84, ''], ['CPT', 'P500SP_SKILPAD_ZP', 72, ''], ['CPT', 'MF_PALLETS', 7, '']]);
  await assert.rejects(coll.setLoaded(db, D, 'RML', true), /Batch missing on the RML sheet for: CPT P330ST_MFSIG_PN\./);
  await fillSheet('RML', [['CPT', 'P330ST_MFSIG_PN', 84, '20261007']]);
  assert.ok((await coll.setLoaded(db, D, 'RML', true)).loadedAt);
});

test('approved sheets are locked; the list merges re-uploads; lines with dispatched loads stay', async () => {
  await loadList();
  await fillSheet('RML', [['CPT', 'P330ST_MFSIG_PN', 84, '20261007']]);
  await coll.setLoaded(db, D, 'RML', true);
  await sendTruck(db, fakeUnleashed(), D, 'RML');
  const day = await coll.collectionDay(db, D);
  const line = day.collections[0].lines.find((l) => l.sku === 'P330ST_MFSIG_PN');
  await assert.rejects(coll.setLoad(db, line.id, 'RML', { qty: 80, batch: 'x' }), /RML sheet is approved/);
  await assert.rejects(coll.deleteLine(db, line.id), /has been dispatched/);
  // MFE is still open for the same line.
  await coll.setLoad(db, line.id, 'MFE', { qty: 4, batch: '20261007' });
  // Re-uploading a section updates Qty Req by SKU instead of duplicating.
  await coll.uploadList(db, parseCollectionCsv('Date,Destination,SKU,Quantity\n2026-10-07,CPT,P330ST_MFSIG_PN,90\n').groups);
  const again = (await coll.collectionDay(db, D)).collections[0];
  assert.equal(again.lines.filter((l) => l.sku === 'P330ST_MFSIG_PN').length, 1);
  assert.equal(again.lines.find((l) => l.sku === 'P330ST_MFSIG_PN').qty, 90);
});

test('CSV fallback: one MFT transfer per section; undo before upload; arrival CSV per destination', async () => {
  await loadList();
  await fillSheet('MFE', MFE);
  await coll.setLoaded(db, D, 'MFE', true);
  const exp = await coll.approveTruckCsv(db, D, 'MFE');
  const csv = (await db.query('SELECT csv FROM exports WHERE id = $1', [exp.id])).rows[0].csv;
  assert.match(csv, /MFT-00000001,PRD,CPT,CPT — Cape Town \(MFE\),P1\.0SP_MFSIG_PN,80,="20261007 \(30\) 20261001 \(50\) - 80"/);
  assert.match(csv, /MFT-00000003,PRD,HLD,ZARMI-JHB — Johannesburg - Zarmi \(MFE\),MF_PALLETS,3,\r\n/);
  // Digistics lines are part of CPT: on the same transfer.
  assert.match(csv, /MFT-00000001,PRD,CPT,CPT — Cape Town \(MFE\),CHEP_PALLETS,1,/);

  const undone = await coll.undoTruckCsv(db, D, 'MFE');
  assert.equal(sheetStatus(undone.sheets[1]), 'loaded');
  const again = await coll.approveTruckCsv(db, D, 'MFE');
  const zarmi = (await coll.collectionDay(db, D)).collections.find((c) => c.destination === 'ZARMI-JHB').id;
  const arr = await coll.arrivalCsv(db, zarmi, '2026-10-09');
  assert.match((await db.query('SELECT csv FROM exports WHERE id = $1', [arr.id])).rows[0].csv, /MFT-00000007,HLD,ZARMI-JHB,ZARMI-JHB — Johannesburg - Zarmi,P500SP_MFSIG_PN,144,/);
  assert.ok(again.id);
});

test('a lost reply on approval is recovered by its tag, not sent twice', async () => {
  await loadList();
  await fillSheet('RML', [['RML-JHB', 'P330ST_MFSIG_PN', 84, '20261007']]);
  await coll.setLoaded(db, D, 'RML', true);
  const u = fakeUnleashed();
  u.loseReplyNext = true;
  const [first] = await sendTruck(db, u, D, 'RML');
  assert.equal(first.ok, false);
  assert.equal(sheetStatus((await coll.collectionDay(db, D)).sheets[0]), 'loaded');
  const [retry] = await sendTruck(db, u, D, 'RML');
  assert.deepEqual([retry.ok, retry.recovered, retry.number], [true, true, 'TX-00000001']);
  assert.equal(u.store.length, 1);
  assert.equal(sheetStatus((await coll.collectionDay(db, D)).sheets[0]), 'approved');
});

test('batch suggestions: Unleashed PRD batches plus that day\'s schedule batches; pallets offered as SKUs', async () => {
  await replaceComponentBatches(db, [{ componentSku: 'P500ST_MFSIG_PN', batchNumber: '20261002 LWH 1', quantityRemaining: 72 }]);
  await createEntry(db, { sku: 'P500ST_MFSIG_PN', line: 'PRD - UWH', plannedCases: 144, date: D });
  await db.query("INSERT INTO bulk_stock (product_code, description, qty_on_hand) VALUES ('MF_PALLETS', 'Mountain Falls White 4-way pallets', 232)");
  const { products, batches } = await coll.finishedGoodsStock(db, D);
  assert.deepEqual(batches.P500ST_MFSIG_PN.map((b) => `${b.batchNumber} ${b.source}`), ['20261002 LWH 1 unleashed', '20261007 UWH 1 schedule']);
  assert.deepEqual(products.find((p) => p.sku === 'MF_PALLETS'), { sku: 'MF_PALLETS', description: 'Mountain Falls White 4-way pallets', batchTracked: false, onHand: 232 });
});

test('several batches on one line: quantities must add up to Qty Trf', async () => {
  await loadList();
  const day = await coll.collectionDay(db, D);
  const line = day.collections.find((c) => c.destination === 'CPT').lines.find((l) => l.sku === 'P1.0SP_MFSIG_PN');
  await assert.rejects(coll.setLoad(db, line.id, 'MFE', { qty: 80, batch: '20261007 UWH 1 (30) 20261001 LWH 1 (40)' }),
    /The batch quantities add up to 70, but Qty Trf is 80\./);
  const c = await coll.setLoad(db, line.id, 'MFE', { qty: 80, batch: '20261007 UWH 1 (30) 20261001 LWH 1 (50)' });
  assert.equal(c.lines.find((l) => l.sku === 'P1.0SP_MFSIG_PN').loads[0].batch, '20261007 UWH 1 (30) 20261001 LWH 1 (50)');
});

test('interim transfer: PRD straight to the destination, no second leg; the truck carries it without transferring again', async () => {
  await loadList();
  const u = fakeUnleashed();
  // Zarmi stock moved early so the order team can invoice it; RML-JHB goes on RML as normal.
  await fillSheet('INTERIM', [['ZARMI-JHB', 'P500ST_MFSIG_PN', 72, '20261007'], ['ZARMI-JHB', 'P500SP_MFSIG_PN', 144, '20261007']]);
  await assert.rejects(coll.setLoaded(db, D, 'INTERIM', true), /no Loaded step/);
  const results = await sendTruck(db, u, D, 'INTERIM'); // no Loaded step needed
  assert.deepEqual(results.map((r) => [r.destination, r.to]), [['ZARMI-JHB', 'ZARMI-JHB']]);
  assert.deepEqual(u.store.map((t) => `${route(t)} ${t.Comments.replace(/ \[PH.*$/, '')}`),
    ['PRD->ZARMI-JHB ZARMI-JHB — Johannesburg - Zarmi (Interim transfer)']);

  // RML physically carries the interim stock plus its own load.
  let day = await coll.collectionDay(db, D);
  const zarmi = day.collections.find((c) => c.destination === 'ZARMI-JHB');
  for (const l of zarmi.lines.filter((x) => x.loads.some((y) => y.truck === 'INTERIM'))) await coll.setCarriedBy(db, l.id, 'RML');
  await assert.rejects(coll.setCarriedBy(db, zarmi.lines[0].id, 'INTERIM'), /Pick a truck/);
  await fillSheet('RML', [['RML-JHB', 'P330ST_MFSIG_PN', 84, '20261007']]);
  await coll.setLoaded(db, D, 'RML', true);
  await sendTruck(db, u, D, 'RML');
  // Only RML's own load is transferred (to HLD), not the interim stock again.
  assert.deepEqual(u.store.slice(1).map((t) => [route(t), t.TransferDetails.map((x) => x.Product.ProductCode)]),
    [['PRD->HLD', ['P330ST_MFSIG_PN']]]);

  // Second leg: RML-JHB only; Zarmi's stock is already there.
  const pending = await coll.pendingArrivals(db);
  assert.deepEqual(pending.map((p) => p.collection.destination), ['RML-JHB']);

  // The interim sheet stays open: a second interim transfer later in the day.
  await fillSheet('INTERIM', [['RML-JHB', 'P330SP_MFSIG_PN', 84, '20261007']]);
  const second = await sendTruck(db, u, D, 'INTERIM');
  assert.deepEqual(second.map((r) => r.to), ['RML-JHB']);
  // Lines already transferred can't change.
  await assert.rejects(fillSheet('INTERIM', [['ZARMI-JHB', 'P500ST_MFSIG_PN', 70, '20261007']]), /Already dispatched/);

  // A truck carrying only interim stock: approved with nothing to send.
  day = await coll.collectionDay(db, D);
  const rmlJhb = day.collections.find((c) => c.destination === 'RML-JHB').lines.find((l) => l.sku === 'P330SP_MFSIG_PN');
  await coll.setCarriedBy(db, rmlJhb.id, 'MFE');
  await coll.setLoaded(db, D, 'MFE', true);
  const before = u.store.length;
  assert.deepEqual(await sendTruck(db, u, D, 'MFE'), []);
  assert.equal(u.store.length, before);
  day = await coll.collectionDay(db, D);
  assert.deepEqual(day.sheets.map((s) => [s.truck, sheetStatus(s)]), [['RML', 'approved'], ['MFE', 'approved'], ['INTERIM', 'open']]);
  // No second leg for interim stock to RML-JHB either.
  assert.deepEqual((await coll.pendingArrivals(db)).map((p) => [p.collection.destination, p.items.map((i) => i.sku)]),
    [['RML-JHB', ['P330ST_MFSIG_PN']]]);
});

test('vehicles: add a truck, rename, switch off; codes are checked', async () => {
  await assert.rejects(coll.createVehicle(db, { code: 'a b', name: 'X' }), /short code/);
  let list = await coll.createVehicle(db, { code: 'trk3', name: 'Hired truck' });
  assert.deepEqual(list.map((v) => v.code), ['RML', 'MFE', 'TRK3', 'INTERIM']);
  await assert.rejects(coll.createVehicle(db, { code: 'TRK3' }), /already a vehicle/);
  list = await coll.updateVehicle(db, 'TRK3', { name: 'Hired 8-ton', active: false });
  assert.deepEqual(list.find((v) => v.code === 'TRK3'), { code: 'TRK3', name: 'Hired 8-ton', kind: 'truck', active: false, position: 3 });
  // Switched off: not on new days, and nothing can be loaded on it.
  await loadList();
  assert.ok(!(await coll.collectionDay(db, D)).vehicles.some((v) => v.code === 'TRK3'));
  const line = (await coll.collectionDay(db, D)).collections[0].lines[0];
  await assert.rejects(coll.setLoad(db, line.id, 'TRK3', { qty: 1, batch: 'x' }), /switched off/);
});
