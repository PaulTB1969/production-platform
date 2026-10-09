// Sending to Unleashed, against a fake Unleashed that records what it gets
// and can fail on purpose — the real account is only used for the one
// labelled live test.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { replaceRecipes } from '../src/services/stock.js';
import { createEntry, updateEntry } from '../src/services/schedule.js';
import { generateRequisitions, updateRequisition, getRequisition } from '../src/services/requisitions.js';
import { getEntry } from '../src/services/schedule.js';
import { sendTransfersForDate, sendAssembliesForDate, sendTransfer, sendAssembly } from '../src/services/unleashedSend.js';
import { transferPayload, assemblyPayload, trackingPayload } from '../src/domain/unleashedPayloads.js';

const DATE = '2026-10-08';
let db;

function fakeUnleashed() {
  const store = { WarehouseStockTransfers: [], Assemblies: [] };
  let n = 0;
  const fake = {
    calls: [],
    store,
    failNext: null, // { status } — a refusal (4xx) or a lost reply (no status)
    loseReplyNext: false, // create it, then fail as if the reply never arrived
    async post(path, body) {
      fake.calls.push(['POST', path, body]);
      if (fake.failNext) { const f = fake.failNext; fake.failNext = null; const e = new Error('fake failure ' + (f.status || 'no reply')); e.status = f.status; throw e; }
      if (path.endsWith('/ProductTracking')) return body;
      const rec = { ...body, Guid: `guid-${++n}`, Comments: body.Comments };
      if (path === 'WarehouseStockTransfers') { rec.TransferOrderNumber = `TX-${String(n).padStart(8, '0')}`; rec.TransferStatus = 'Parked'; }
      if (path === 'Assemblies') { rec.AssemblyNumber = `ASM-${String(n).padStart(8, '0')}`; rec.AssemblyStatus = 'Parked'; }
      store[path].push(rec);
      if (fake.loseReplyNext) { fake.loseReplyNext = false; throw new Error('socket hang up'); }
      return rec;
    },
    async put(path, body) { fake.calls.push(['PUT', path, body]); return body; },
    async getAll(resource) { fake.calls.push(['GET', resource]); return store[resource]; },
  };
  return fake;
}

beforeEach(async () => {
  db = await openDb({});
  await migrate(db);
  await replaceRecipes(db, [{
    sku: 'P500', expectedDuration: '40m',
    lines: [
      { componentSku: 'BOTTLE', qtyPerUnit: 24, isBatchTracked: true },
      { componentSku: 'LABEL', qtyPerUnit: 24, isBatchTracked: false },
    ],
  }]);
});
afterEach(() => db.close());

async function completedRequisition() {
  await createEntry(db, { sku: 'P500', line: 'PRD - UWH', plannedCases: 10, date: DATE });
  await generateRequisitions(db, DATE);
  const id = 'req_20261008_uwh';
  const req = await getRequisition(db, id);
  await updateRequisition(db, id, { lines: req.lines.map((l) => (l.sku === 'BOTTLE' ? { ...l, batchNumber: 'B1' } : l)) });
  await updateRequisition(db, id, { status: 'done' });
  return id;
}

async function completedJob() {
  const e = await createEntry(db, { sku: 'P500', line: 'PRD - UWH', plannedCases: 10, date: DATE });
  await updateEntry(db, e.id, {
    actualCases: 10, startTime: '07:00', endTime: '09:30', notes: 'Line ran well',
    componentUsage: [
      { componentSku: 'BOTTLE', batchNumber: 'B1', qtyUsed: 200, wastage: 3 },
      { componentSku: 'BOTTLE', batchNumber: 'B2', qtyUsed: 40, wastage: 0 },
    ],
  });
  await updateEntry(db, e.id, { status: 'done' });
  return e.id;
}

test('transfer payload: PRD to the line, batch in the line comment, tagged', async () => {
  const id = await completedRequisition();
  assert.deepEqual(transferPayload(await getRequisition(db, id)), {
    Comments: 'PRD - UWH — Upper Warehouse — 8 Oct 2026 [PH req_20261008_uwh]',
    SourceWarehouse: { WarehouseCode: 'PRD' },
    DestinationWarehouse: { WarehouseCode: 'PRD - UWH' },
    TransferDetails: [
      { Product: { ProductCode: 'BOTTLE' }, TransferQuantity: 240, Comments: 'Batch B1' },
      { Product: { ProductCode: 'LABEL' }, TransferQuantity: 240 },
    ],
  });
});

test('assembly payload: actual usage and wastage per component, durations, batches', async () => {
  const id = await completedJob();
  const entry = await getEntry(db, id);
  const recipe = { expectedDuration: '40m', lines: [{ componentSku: 'BOTTLE', qtyPerUnit: 24 }, { componentSku: 'LABEL', qtyPerUnit: 24 }] };
  assert.deepEqual(assemblyPayload(entry, recipe, { productionEmail: 'p@x.co' }), {
    Product: { ProductCode: 'P500' },
    SourceWarehouse: { WarehouseCode: 'PRD' },
    DestinationWarehouse: { WarehouseCode: 'PRD' },
    Quantity: 10,
    AssembleBy: DATE,
    Comments: `Batch 20261008 UWH 1 · Components: B1; B2 · [PH ${id}]`,
    AssemblyLines: [
      { Product: { ProductCode: 'BOTTLE' }, Quantity: 240, WastageQuantity: 3 },
      { Product: { ProductCode: 'LABEL' }, Quantity: 240, WastageQuantity: 0 }, // auto from cases produced
    ],
    ExpectedDuration: '40m',
    ActualDuration: '2h 30m',
    DurationComments: 'Line ran well',
    ProductionPerson: { Email: 'p@x.co' },
  });
  assert.deepEqual(trackingPayload(entry), {
    ProductBatches: [{ Product: { ProductCode: 'BOTTLE' }, Batches: [{ BatchNumber: 'B1', Quantity: 203 }, { BatchNumber: 'B2', Quantity: 40 }] }],
  });
});

test('sends a completed requisition once; Unleashed number is kept; re-send does nothing', async () => {
  const id = await completedRequisition();
  const u = fakeUnleashed();
  const [r] = await sendTransfersForDate(db, u, DATE);
  assert.deepEqual([r.ok, r.number], [true, 'TX-00000001']);
  const req = await getRequisition(db, id);
  assert.equal(req.transferNumber, 'TX-00000001');
  assert.ok(req.exportedAt);
  // Nothing left for the date; a direct re-send is a no-op.
  await assert.rejects(sendTransfersForDate(db, u, DATE), /Nothing to send for 2026-10-08 — PRD - UWH: already sent as TX-00000001/);
  assert.equal((await sendTransfer(db, u, id)).already, true);
  assert.equal(u.store.WarehouseStockTransfers.length, 1);
  // Exported, so it can't be reopened.
  await assert.rejects(updateRequisition(db, id, { status: null }), /can't be reopened/);
});

test('lost reply: the retry finds the transfer by its tag instead of creating a second one', async () => {
  const id = await completedRequisition();
  const u = fakeUnleashed();
  u.loseReplyNext = true;
  const [first] = await sendTransfersForDate(db, u, DATE);
  assert.equal(first.ok, false);
  assert.equal(u.store.WarehouseStockTransfers.length, 1); // it did get created
  assert.ok((await getRequisition(db, id)).sendStartedAt);

  const [retry] = await sendTransfersForDate(db, u, DATE);
  assert.deepEqual([retry.ok, retry.recovered, retry.number], [true, true, 'TX-00000001']);
  assert.equal(u.store.WarehouseStockTransfers.length, 1); // still one
});

test('refused by Unleashed (4xx): error shown, safe to send again as new', async () => {
  const id = await completedRequisition();
  const u = fakeUnleashed();
  u.failNext = { status: 400 };
  const [first] = await sendTransfersForDate(db, u, DATE);
  assert.match(first.error, /fake failure 400/);
  const req = await getRequisition(db, id);
  assert.equal(req.sendStartedAt, null);
  assert.match(req.sendError, /400/);
  const [retry] = await sendTransfersForDate(db, u, DATE);
  assert.deepEqual([retry.ok, retry.recovered], [true, false]);
  assert.equal((await getRequisition(db, id)).sendError, null);
});

test('assembly: created, then batch numbers attached; a failed batch step is retried alone', async () => {
  const id = await completedJob();
  const u = fakeUnleashed();
  // Make the ProductTracking call (second POST) fail.
  const realPost = u.post;
  let posts = 0;
  u.post = async (path, body) => { if (++posts === 2) { const e = new Error('tracking refused'); e.status = 400; throw e; } return realPost(path, body); };

  const [r] = await sendAssembliesForDate(db, u, DATE, { productionEmail: 'p@x.co' });
  assert.deepEqual([r.ok, r.number, r.trackingOk], [true, 'ASM-00000001', false]);
  let entry = await getEntry(db, id);
  assert.equal(entry.unleashedNumber, 'ASM-00000001');
  assert.match(entry.trackingError, /tracking refused/);

  // Next send only re-attaches the batches (PUT), no second assembly.
  const [again] = await sendAssembliesForDate(db, u, DATE, {});
  assert.equal(again.already, true);
  assert.equal(u.store.Assemblies.length, 1);
  assert.deepEqual(u.calls.at(-1)[0], 'PUT');
  entry = await getEntry(db, id);
  assert.equal(entry.trackingError, null);

  // Sent via the API, so the exported flag can't be cleared (that would send it twice).
  await assert.rejects(updateEntry(db, id, { exportedAt: null }), /delete it there first/);
  await assert.rejects(sendAssembliesForDate(db, u, DATE, {}), /Nothing to send for 2026-10-08 — 1 already sent./);
});

test('not completed yet, or already exported by CSV: not sent', async () => {
  const e = await createEntry(db, { sku: 'P500', line: 'PRD - UWH', plannedCases: 10, date: DATE });
  const u = fakeUnleashed();
  await assert.rejects(sendAssembly(db, u, e.id), /Mark the job Completed/);
  await assert.rejects(sendAssembliesForDate(db, null, DATE), /not connected/);
  assert.equal(u.calls.length, 0);
});

test('nothing to send: the message says why (e.g. already exported by CSV)', async () => {
  const id = await completedRequisition();
  await db.query("UPDATE requisitions SET exported_at = now(), transfer_number = 'MFR-00000001' WHERE id = $1", [id]);
  await assert.rejects(sendTransfersForDate(db, fakeUnleashed(), DATE),
    /Nothing to send for 2026-10-08 — PRD - UWH: already exported by CSV as MFR-00000001\./);

  await createEntry(db, { sku: 'P500', line: 'PRD - UWH', plannedCases: 5, date: DATE });
  await assert.rejects(sendAssembliesForDate(db, fakeUnleashed(), DATE, {}), /Nothing to send for 2026-10-08 — 2 of 2 job\(s\) not marked Done yet\./);
});
