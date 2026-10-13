// End-to-end workflow against a real (in-memory) Postgres via PGlite:
// schedule -> generate requisition -> assign batches -> complete ->
// batch shows at the line -> record production -> exports.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { replaceRecipes, replaceComponentBatches, replaceBulkStock, replaceProductGroups } from '../src/services/stock.js';
import { mapProductGroups } from '../src/unleashed/sync.js';

const DATE = '2026-10-01';
let app, db, base;

async function api(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { Cookie: app.cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* csv */ }
  return { status: res.status, data };
}

before(async () => {
  app = await startApp();
  db = app.siteDb;
  base = app.base;
  await replaceRecipes(db, [{
    sku: 'P500', description: 'Signature 500ml', expectedDuration: '2',
    lines: [
      { componentSku: 'BOTTLE', componentDescription: 'Bottle', qtyPerUnit: 24, isBatchTracked: true },
      { componentSku: 'LABEL', componentDescription: 'Label', qtyPerUnit: 24, isBatchTracked: false },
    ],
  }]);
  await replaceComponentBatches(db, [
    { componentSku: 'BOTTLE', batchNumber: 'B-LATE', quantityRemaining: 5000, expiryDate: '2027-06-01' },
    { componentSku: 'BOTTLE', batchNumber: 'B-SOON', quantityRemaining: 300, expiryDate: '2026-12-01' },
  ]);
  // Unleashed stock on hand in PRD, including the non-batch-tracked label.
  await replaceBulkStock(db, [
    { productCode: 'BOTTLE', qtyOnHand: 5300 },
    { productCode: 'LABEL', qtyOnHand: 1000 },
  ]);
});

after(async () => {
  await app.close();
});

test('requires a sign-in', async () => {
  assert.equal((await fetch(base + '/api/schedule')).status, 401);
  assert.equal((await fetch(base + '/healthz')).status, 200);
});

test('full production day', async () => {
  // Schedule two jobs on UWH.
  const j1 = (await api('POST', '/api/schedule', { sku: 'P500', line: 'PRD - UWH', plannedCases: 10, date: DATE })).data;
  await api('POST', '/api/schedule', { sku: 'P500', line: 'PRD - UWH', plannedCases: 5, date: DATE });

  // Bulk batches come back soonest-expiry first.
  const bulk = (await api('GET', '/api/stock/bulk')).data;
  assert.deepEqual(bulk.BOTTLE.batches.map((b) => b.batchNumber), ['B-SOON', 'B-LATE']);

  // Generate: one UWH requisition, 15 cases x 24.
  const gen = (await api('POST', '/api/requisitions/generate', { date: DATE })).data;
  assert.deepEqual(gen.created, ['req_20261001_uwh']);
  // Generating again leaves the existing one alone.
  assert.deepEqual((await api('POST', '/api/requisitions/generate', { date: DATE })).data.created, []);

  let req = (await api('GET', `/api/requisitions?date=${DATE}`)).data[0];
  assert.deepEqual(req.lines.map((l) => [l.sku, l.qtyUsed, l.needsBatch]), [['BOTTLE', 360, true], ['LABEL', 360, false]]);

  // Can't complete without a batch.
  assert.equal((await api('PATCH', `/api/requisitions/${req.id}`, { status: 'done' })).status, 409);

  // Split the bottles over two batches; send a full box of 500 labels.
  const lines = [
    { ...req.lines[0], batchNumber: 'B-SOON', qtyUsed: 300 },
    { ...req.lines[0], batchNumber: 'B-LATE', qtyUsed: 60 },
    { ...req.lines[1], qtyUsed: 500 },
  ];
  req = (await api('PATCH', `/api/requisitions/${req.id}`, { lines })).data;
  req = (await api('PATCH', `/api/requisitions/${req.id}`, { status: 'done' })).data;
  assert.equal(req.status, 'done');

  // The batches are now available at UWH — and only those quantities.
  let lineStock = (await api('GET', '/api/stock/lines')).data;
  assert.deepEqual(lineStock['PRD - UWH|BOTTLE'].batches.map((b) => [b.batchNumber, b.quantityRemaining]), [['B-SOON', 300], ['B-LATE', 60]]);

  // Planned fields lock once production is recorded.
  await api('PATCH', `/api/schedule/${j1.id}`, {
    actualCases: 10, componentUsage: [{ componentSku: 'BOTTLE', batchNumber: 'B-SOON', qtyUsed: 240, wastage: 4 }],
  });
  assert.equal((await api('PATCH', `/api/schedule/${j1.id}`, { plannedCases: 12 })).status, 409);
  // No completing without a start time; reopening keeps the times.
  const refused = await api('PATCH', `/api/schedule/${j1.id}`, { status: 'done' });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /start time/);
  await api('PATCH', `/api/schedule/${j1.id}`, { startTime: '07:00' });
  const j1Now = (await api('PATCH', `/api/schedule/${j1.id}`, { status: 'done', endTime: '08:15' })).data;
  const reopened = (await api('PATCH', `/api/schedule/${j1.id}`, { status: null })).data;
  assert.deepEqual([reopened.startTime, reopened.endTime], ['07:00', '08:15']);
  await api('PATCH', `/api/schedule/${j1.id}`, { status: 'done' });
  // Labels were auto-computed from cases produced.
  assert.deepEqual(j1Now.componentUsage.find((u) => u.componentSku === 'LABEL'), { componentSku: 'LABEL', batchNumber: null, qtyUsed: 240, wastage: 0 });

  // Line stock drops by what was drawn (used + wastage).
  lineStock = (await api('GET', '/api/stock/lines')).data;
  assert.deepEqual(lineStock['PRD - UWH|BOTTLE'].batches.map((b) => [b.batchNumber, b.quantityRemaining]), [['B-SOON', 56], ['B-LATE', 60]]);

  // Label balance: 500 sent - 240 used.
  const bal = (await api('GET', '/api/stock/balances')).data.find((b) => b.sku === 'LABEL');
  assert.equal(bal.balance, 260);

  // Transfer export: numbered MFR-00000001, then nothing left to export.
  const t = (await api('POST', '/api/exports/transfers', { date: DATE })).data;
  const csv = (await api('GET', t.url)).data;
  assert.match(csv, /^\*Transfer Number,/);
  assert.match(csv, /MFR-00000001,PRD,PRD - UWH,PRD - UWH — Upper Warehouse — 1 Oct 2026,BOTTLE,300,="B-SOON"/);
  assert.equal((await api('POST', '/api/exports/transfers', { date: DATE })).status, 400);
  // Re-downloading gives the same file, no new number.
  assert.equal((await api('GET', t.url)).data, csv);
  // An exported requisition can't be reopened.
  assert.equal((await api('PATCH', `/api/requisitions/${req.id}`, { status: null })).status, 409);

  // Assemblies: only the done job, once.
  const a = (await api('POST', '/api/exports/assemblies', { date: DATE })).data;
  const aCsv = (await api('GET', a.url)).data;
  assert.equal(aCsv.trim().split('\r\n').length, 2);
  assert.match(aCsv, /MFB-00000001,P500,PRD,PRD,Parked,10,2026-10-01,B-SOON,,="20261001 UWH 1",10,2027-10-01,2,1.25,,prod@example.com/);
  assert.equal((await api('POST', '/api/exports/assemblies', { date: DATE })).status, 400);
});

test('next day: label balance at the line is netted off the new requisition', async () => {
  const next = '2026-10-02';
  await api('POST', '/api/schedule', { sku: 'P500', line: 'PRD - UWH', plannedCases: 20, date: next });
  await api('POST', '/api/requisitions/generate', { date: next });
  const req = (await api('GET', `/api/requisitions?date=${next}`)).data[0];
  // 480 labels needed, 260 already at UWH.
  assert.equal(req.lines.find((l) => l.sku === 'LABEL').qtyUsed, 220);
});

test('split moves cases to a new batch in the same family', async () => {
  const e = (await api('POST', '/api/schedule', { sku: 'P500', line: 'PRD - LWH', plannedCases: 100, date: '2026-10-03' })).data;
  assert.equal((await api('POST', `/api/schedule/${e.id}/split`, { moveQty: 100 })).status, 400);
  const { source, created } = (await api('POST', `/api/schedule/${e.id}/split`, { moveQty: 40 })).data;
  assert.equal(source.plannedCases, 60);
  assert.deepEqual([created.plannedCases, created.seq, created.groupId], [40, 2, e.groupId]);
});

test('schedule upload: updates a still-scheduled match, otherwise adds', async () => {
  const csv = 'SKU,Warehouse,Quantity,Date\r\nP500,LWH,70,2026/10/03\r\nP500,AQB,30,2026-10-03\r\n';
  const res = await api('POST', '/api/schedule/upload', undefined, { 'Content-Type': 'text/csv' });
  assert.equal(res.status, 400); // empty body
  const up = await fetch(base + '/api/schedule/upload', { method: 'POST', headers: { Cookie: app.cookie, 'Content-Type': 'text/csv' }, body: csv });
  assert.deepEqual(await up.json(), { created: 1, updated: 1 });
});

test('Excel download: one workbook with the day, batch numbers kept as text', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const res = await fetch(base + `/api/workbook.xlsx?from=${DATE}&to=2026-10-02`, { headers: { Cookie: app.cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /production-hub-2026-10-01-to-2026-10-02\.xlsx/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Schedule', 'Batch usage', 'Requisitions', 'Line batch stock', 'Raw material balance']);

  const schedule = wb.getWorksheet('Schedule');
  const done = schedule.getRows(2, schedule.rowCount - 1).find((r) => r.getCell(5).value === 'Done');
  assert.equal(done.getCell(4).value, '20261001 UWH 1');
  assert.equal(done.getCell(7).value, 10);

  const usage = wb.getWorksheet('Batch usage').getRows(2, 10).filter((r) => r.getCell(6).value === 'B-SOON');
  assert.equal(usage[0].getCell(7).value, 240);

  const reqs = wb.getWorksheet('Requisitions');
  assert.equal(reqs.getRow(2).getCell(5).value, 'MFR-00000001');
  assert.equal(typeof reqs.getRow(2).getCell(9).value, 'string');
});

test('pick list: per-line sheet with bulk stock, FEFO suggestion and blank check columns', async () => {
  const ExcelJS = (await import('exceljs')).default;
  assert.equal((await api('GET', '/api/requisitions/picklist.xlsx?date=2026-01-01')).status, 404);

  const res = await fetch(base + '/api/requisitions/picklist.xlsx?date=2026-10-02', { headers: { Cookie: app.cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /pick-list-2026-10-02\.xlsx/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['UWH']);
  const ws = wb.getWorksheet('UWH');
  assert.equal(ws.getCell('A1').value, 'Pick list — PRD - UWH — Upper Warehouse — 2 Oct 2026');
  assert.equal(ws.getRow(4).getCell(1).value, 'Product group');
  assert.equal(ws.getRow(4).getCell(8).value, '✓ Qty on floor');

  const rows = ws.getRows(5, ws.rowCount - 4).filter((r) => ['BOTTLE', 'LABEL'].includes(r.getCell(2).value));
  const bottle = rows.find((r) => r.getCell(2).value === 'BOTTLE');
  // 20 cases x 24 = 480; bulk store has B-SOON 300 + B-LATE 5000 (synced figures).
  assert.equal(bottle.getCell(4).value, 480);
  assert.equal(bottle.getCell(5).value, '— not assigned —');
  assert.equal(bottle.getCell(6).value, 5300);
  assert.equal(bottle.getCell(7).value, 'B-SOON (300), B-LATE (180)');
  assert.equal(bottle.getCell(8).value, null);
  const label = rows.find((r) => r.getCell(2).value === 'LABEL');
  assert.equal(label.getCell(4).value, 220);
  assert.equal(label.getCell(6).value, 1000); // from Unleashed stock on hand
  assert.equal(label.getCell(7).value, 'not batch-tracked');
  const summary = ws.getRows(5, ws.rowCount - 4).map((r) => r.getCell(1).value).find((v) => /bulk store/i.test(String(v)));
  assert.equal(summary, 'Bulk store holds enough of every material, as of the last Unleashed sync.');

  // Line filter: only that line's sheet, named in the file.
  const one = await fetch(base + '/api/requisitions/picklist.xlsx?date=2026-10-02&line=' + encodeURIComponent('PRD - UWH'), { headers: { Cookie: app.cookie } });
  assert.match(one.headers.get('content-disposition'), /pick-list-2026-10-02-uwh\.xlsx/);
});

test('pick list flags materials the bulk store is short of', async () => {
  const ExcelJS = (await import('exceljs')).default;
  // 300 cases x 24 = 7,200 bottles > 5,300 in the bulk store.
  await api('POST', '/api/schedule', { sku: 'P500', line: 'PRD - AQB', plannedCases: 300, date: '2026-10-07' });
  await api('POST', '/api/requisitions/generate', { date: '2026-10-07' });
  const res = await fetch(base + '/api/requisitions/picklist.xlsx?date=2026-10-07', { headers: { Cookie: app.cookie } });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const ws = wb.getWorksheet('AQB');
  const bottle = ws.getRows(5, ws.rowCount - 4).find((r) => r.getCell(2).value === 'BOTTLE');
  // en-ZA groups thousands with a (non-breaking) space: "1 900".
  assert.match(bottle.getCell(7).value, /^SHORT by 1\s900\. B-SOON \(300\), B-LATE \(5\s000\)$/);
  // Non-batch-tracked materials are checked too: 7,200 labels needed, 1,000 on hand.
  const label = ws.getRows(5, ws.rowCount - 4).find((r) => r.getCell(2).value === 'LABEL');
  assert.match(label.getCell(7).value, /^SHORT by 6\s200\. not batch-tracked$/);
  const summary = ws.getRows(5, ws.rowCount - 4).map((r) => r.getCell(1).value).find((v) => /bulk store/i.test(String(v)));
  assert.equal(summary, '2 material(s) may be short in the bulk store — check before sending.');
});

test('materials list: BOM components with batch-tracked flag, PRD stock and product group', async () => {
  await replaceProductGroups(db, mapProductGroups([
    { ProductCode: 'BOTTLE', ProductGroup: { GroupName: 'Raw Materials - Bottles' } },
    { ProductCode: 'LABEL', ProductGroup: null },
  ]));
  const list = (await api('GET', '/api/stock/materials')).data;
  assert.deepEqual(list.find((m) => m.sku === 'BOTTLE'), { sku: 'BOTTLE', description: 'Bottle', batchTracked: true, onHand: 5300, group: 'Raw Materials - Bottles' });
  assert.deepEqual(list.find((m) => m.sku === 'LABEL'), { sku: 'LABEL', description: 'Label', batchTracked: false, onHand: 1000, group: null });
  // Requisition lines carry the group too.
  const reqs = (await api('GET', '/api/requisitions')).data;
  const bottle = reqs.flatMap((r) => r.lines).find((l) => l.sku === 'BOTTLE');
  assert.equal(bottle.group, 'Raw Materials - Bottles');

  // Pick list: sorted by product group, group named on its first row, ungrouped last.
  const ExcelJS = (await import('exceljs')).default;
  const res = await fetch(base + '/api/requisitions/picklist.xlsx?date=2026-10-02', { headers: { Cookie: app.cookie } });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const ws = wb.getWorksheet('UWH');
  assert.deepEqual([5, 6].map((n) => [ws.getRow(n).getCell(1).value, ws.getRow(n).getCell(2).value]),
    [['Raw Materials - Bottles', 'BOTTLE'], ['No product group', 'LABEL']]);

  // One product group only.
  const g = await fetch(base + '/api/requisitions/picklist.xlsx?date=2026-10-02&group=' + encodeURIComponent('Raw Materials - Bottles'), { headers: { Cookie: app.cookie } });
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(Buffer.from(await g.arrayBuffer()));
  const skus = wb2.getWorksheet('UWH').getRows(5, 10).map((r) => r.getCell(2).value).filter((v) => ['BOTTLE', 'LABEL'].includes(v));
  assert.deepEqual(skus, ['BOTTLE']);
  assert.equal((await api('GET', '/api/requisitions/picklist.xlsx?date=2026-10-02&group=Nothing')).status, 404);
});

test('requisitions created by hand: a second one for the same line and date is numbered', async () => {
  const first = (await api('POST', '/api/requisitions', { date: '2026-10-02', line: 'PRD - UWH' })).data;
  assert.equal(first.seq, 2); // the generated one for that day is 1
  const third = (await api('POST', '/api/requisitions', { date: '2026-10-02', line: 'PRD - UWH' })).data;
  assert.equal(third.seq, 3);
  assert.equal(third.lines.length, 0);
  const { requisitionName } = await import('../src/domain/requisitions.js');
  assert.equal(requisitionName(third), 'PRD - UWH — Upper Warehouse — 2 Oct 2026 (3)');
  // The pick list gets one sheet per requisition.
  const ExcelJS = (await import('exceljs')).default;
  const res = await fetch(base + '/api/requisitions/picklist.xlsx?date=2026-10-02', { headers: { Cookie: app.cookie } });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['UWH', 'UWH (2)', 'UWH (3)']);
});

test('line sheets: the day per warehouse, filled in with cases and bottle batches', async () => {
  const sheets = (await api('GET', `/api/schedule/linesheets?date=${DATE}`)).data;
  assert.deepEqual(sheets.map((s) => s.form), ['UWH', 'LWH']);
  const uwh = sheets[0].sections[0];
  assert.equal(uwh.heading, 'UWH - Production Schedule');
  const first = uwh.rows[0];
  // Job 1: 10 cases, 240 bottles used + 4 wasted from B-SOON (bottles are told apart by product group).
  assert.deepEqual(
    [first.sku, first.planned, first.produced, first.prodDate, first.bottleSku, first.bottleBatch, first.bottleQty, first.closureBatch],
    ['P500', 10, 10, DATE, 'BOTTLE', 'B-SOON', '244', ''],
  );
  assert.deepEqual(sheets[1].sections.map((s) => s.heading), ['LWH - Production Schedule', 'AcquaBox']);
  assert.equal((await api('GET', '/api/schedule/linesheets')).status, 400);
});

test('complete selected: part of a requisition drawn now becomes its own completed requisition; the rest stays open', async () => {
  const { splitDraw } = await import('../src/domain/requisitions.js');
  const lines = [{ sku: 'A', qtyUsed: 800, batchNumber: 'X' }, { sku: 'B', qtyUsed: 10 }];
  assert.deepEqual(splitDraw(lines, [{ index: 0, qty: 500 }]), {
    drawn: [{ sku: 'A', qtyUsed: 500, batchNumber: 'X' }],
    remaining: [{ sku: 'A', qtyUsed: 300, batchNumber: 'X' }, { sku: 'B', qtyUsed: 10 }],
  });
  assert.throws(() => splitDraw(lines, [{ index: 0, qty: 900 }]), /Only 800/);
  assert.throws(() => splitDraw(lines, [{ index: 5 }]), /no longer on the requisition/);

  const req = (await api('POST', '/api/requisitions', { date: '2026-10-20', line: 'PRD - LWH' })).data;
  await api('PATCH', `/api/requisitions/${req.id}`, { lines: [
    { sku: 'BOTTLE', description: 'Bottle', batchNumber: 'B-SOON', qtyUsed: 200, needsBatch: true },
    { sku: 'BOTTLE', description: 'Bottle', batchNumber: null, qtyUsed: 100, needsBatch: true },
    { sku: 'LABEL', description: 'Label', batchNumber: null, qtyUsed: 50, needsBatch: false },
  ] });
  // A ticked line still needing a batch can't be completed.
  const refused = await api('POST', `/api/requisitions/${req.id}/complete-selected`, { picks: [{ index: 1 }] });
  assert.equal(refused.status, 409);
  // 120 of the bottles (batch B-SOON) and all the labels now.
  const r = await api('POST', `/api/requisitions/${req.id}/complete-selected`, { picks: [{ index: 0, qty: 120 }, { index: 2 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.completed.status, 'done');
  assert.equal(r.data.completed.seq, 2);
  assert.deepEqual(r.data.completed.lines.map((l) => [l.sku, l.batchNumber, l.qtyUsed]), [['BOTTLE', 'B-SOON', 120], ['LABEL', null, 50]]);
  assert.equal(r.data.remaining.status, null);
  assert.deepEqual(r.data.remaining.lines.map((l) => [l.sku, l.batchNumber, l.qtyUsed]), [['BOTTLE', 'B-SOON', 80], ['BOTTLE', null, 100]]);
  // The drawn batch is now at the line.
  const stock = (await api('GET', '/api/stock/lines')).data;
  assert.ok(stock['PRD - LWH|BOTTLE'].batches.some((b) => b.batchNumber === 'B-SOON' && b.quantityRemaining === 120));
  // Drawing everything that's left just completes the original.
  await api('PATCH', `/api/requisitions/${req.id}`, { lines: [{ sku: 'BOTTLE', description: 'Bottle', batchNumber: 'B-LATE', qtyUsed: 180, needsBatch: true }] });
  const last = (await api('POST', `/api/requisitions/${req.id}/complete-selected`, { picks: [{ index: 0 }] })).data;
  assert.equal(last.remaining, null);
  assert.equal(last.completed.id, req.id);
  assert.equal(last.completed.status, 'done');
});
