import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseFlexibleDate, csvField, csvTextGuard } from '../src/domain/csv.js';
import { normalizeWarehouse, requisitionId } from '../src/domain/lines.js';
import {
  computeEntryStatus, syncNonBatchTrackedUsage, addUsage, assemblyRow, wastageRow, parseScheduleCsv, actualDurationHours,
} from '../src/domain/schedule.js';
import { buildRequisitions, allocateBatch, requisitionIssues, transferRows, requisitionName } from '../src/domain/requisitions.js';

const recipe = {
  sku: 'P500', expectedDuration: '2.5',
  lines: [
    { componentSku: 'BOTTLE', componentDescription: 'Bottle 500ml', qtyPerUnit: 24, isBatchTracked: true },
    { componentSku: 'LABEL', componentDescription: 'Label', qtyPerUnit: 24, isBatchTracked: false },
  ],
};
const job = (over = {}) => ({ id: 'e1', sku: 'P500', line: 'PRD - UWH', date: '2026-10-01', plannedCases: 10, actualCases: null, status: null, componentUsage: [], seq: 1, ...over });

test('csv: quoted fields, escaped quotes, CRLF', () => {
  assert.deepEqual(parseCsv('a,"b,c","d""e"\r\n1,2,3\n'), [['a', 'b,c', 'd"e'], ['1', '2', '3']]);
  assert.equal(csvField('x,y'), '"x,y"');
  assert.equal(csvTextGuard('20260916 UWH 1'), '="20260916 UWH 1"');
});

test('dates: accepts ISO and Excel slashes, rejects day-first and impossible dates', () => {
  assert.equal(parseFlexibleDate('2026/09/22'), '2026-09-22');
  assert.equal(parseFlexibleDate('2026-02-30'), null);
  assert.equal(parseFlexibleDate('22/09/2026'), null);
});

test('warehouse normalisation', () => {
  assert.equal(normalizeWarehouse('uwh'), 'PRD - UWH');
  assert.equal(normalizeWarehouse('PRD-AB'), 'PRD - AQB');
  assert.equal(normalizeWarehouse(''), 'Other');
  assert.equal(normalizeWarehouse('JHB'), null);
  assert.equal(requisitionId('2026-10-01', 'PRD - LWH'), 'req_20261001_lwh');
});

test('entry status is derived from what has been recorded', () => {
  assert.equal(computeEntryStatus(job()), 'scheduled');
  assert.equal(computeEntryStatus(job({ actualCases: 0 })), 'in_progress');
  assert.equal(computeEntryStatus(job({ componentUsage: [{}] })), 'in_progress');
  assert.equal(computeEntryStatus(job({ status: 'done' })), 'done');
});

test('non-batch usage follows actual cases, and is not created before actuals', () => {
  assert.deepEqual(syncNonBatchTrackedUsage(job(), recipe), []);
  const u = syncNonBatchTrackedUsage(job({ actualCases: 5, componentUsage: [{ componentSku: 'LABEL', batchNumber: null, qtyUsed: 1, wastage: 3 }] }), recipe);
  assert.deepEqual(u, [{ componentSku: 'LABEL', batchNumber: null, qtyUsed: 120, wastage: 3 }]);
});

test('adding the same batch twice sums onto one line', () => {
  let u = addUsage([], { componentSku: 'BOTTLE', batchNumber: 'B1', qtyUsed: 100 });
  u = addUsage(u, { componentSku: 'BOTTLE', batchNumber: 'B1', qtyUsed: 20, wastage: 2 });
  assert.deepEqual(u, [{ componentSku: 'BOTTLE', batchNumber: 'B1', qtyUsed: 120, wastage: 2 }]);
});

test('assembly and wastage rows match the artifact columns', () => {
  const e = job({ actualCases: 9, wastageCases: 1, status: 'done', startTime: '22:00', endTime: '01:30', notes: 'ok',
    componentUsage: [{ componentSku: 'BOTTLE', batchNumber: 'B1', qtyUsed: 216, wastage: 5 }] });
  assert.equal(actualDurationHours(e), '3.50');
  assert.deepEqual(assemblyRow(e, 'MFB-00000001', { recipe, productionEmail: 'a@b.c' }), [
    'MFB-00000001', 'P500', 'PRD', 'PRD', 'Parked', '9', '2026-10-01', 'B1', '',
    '="20261001 UWH 1"', '9', '2027-10-01', '2.5', '3.50', 'ok', 'a@b.c',
  ]);
  assert.deepEqual(wastageRow(e, { productionEmail: 'a@b.c' }), [
    '2026-10-01', 'P500', 'PRD', '="20261001 UWH 1"', '1', 'BOTTLE: 5', 'ok', 'a@b.c',
  ]);
});

test('schedule upload rejects the whole file on one bad row', () => {
  const ok = parseScheduleCsv('SKU,Warehouse,Quantity,Date\nP500,uwh,10,2026/10/01\n');
  assert.deepEqual(ok, { rows: [{ sku: 'P500', line: 'PRD - UWH', plannedCases: 10, date: '2026-10-01' }], errors: [] });
  const bad = parseScheduleCsv('SKU,Warehouse,Quantity,Date\nP500,uwh,10,01/10/2026\n');
  assert.equal(bad.errors.length, 1);
});

test('requisition generation: sums scheduled jobs per line, nets non-batch balance, skips the rest', () => {
  const entries = [
    job({ id: 'a', plannedCases: 10 }),
    job({ id: 'b', plannedCases: 5 }),
    job({ id: 'c', plannedCases: 50, actualCases: 1 }), // in progress: left out
    job({ id: 'd', line: 'PRD - LWH', sku: 'NO_BOM' }),
  ];
  const out = buildRequisitions({
    date: '2026-10-01', entries,
    recipes: new Map([['P500', recipe]]),
    balances: new Map([['PRD - UWH|LABEL', 100]]),
    existingLines: new Set(['PRD - AQB']),
  });
  assert.equal(out.requisitions.length, 1);
  const r = out.requisitions[0];
  assert.equal(r.id, 'req_20261001_uwh');
  assert.deepEqual(r.lines, [
    { sku: 'BOTTLE', description: 'Bottle 500ml', batchNumber: null, qtyUsed: 360, needsBatch: true },
    { sku: 'LABEL', description: 'Label', batchNumber: null, qtyUsed: 260, needsBatch: false },
  ]);
  assert.deepEqual(out.missingRecipes, ['NO_BOM']);
  assert.deepEqual(out.skipped.map((s) => s.line).sort(), ['PRD - AQB', 'PRD - LWH']);
});

test('batch allocation: full assign, split, and merge into an existing batch line', () => {
  const lines = [{ sku: 'BOTTLE', description: '', batchNumber: null, qtyUsed: 360, needsBatch: true }];
  assert.equal(allocateBatch(lines, 0, 'B1')[0].batchNumber, 'B1');
  let split = allocateBatch(lines, 0, 'B1', 100);
  assert.deepEqual(split.map((l) => [l.batchNumber, l.qtyUsed]), [[null, 260], ['B1', 100]]);
  split = allocateBatch(split, 0, 'B1', 60);
  assert.deepEqual(split.map((l) => [l.batchNumber, l.qtyUsed]), [[null, 200], ['B1', 160]]);
  assert.deepEqual(requisitionIssues({ lines: split }), ['assign a batch to every raw material that needs one']);
});

test('transfer rows: PRD to line, name as comments, batch text-guarded', () => {
  const req = { line: 'PRD - UWH', date: '2026-10-01', lines: [{ sku: 'BOTTLE', qtyUsed: 360, batchNumber: 'B1' }] };
  assert.equal(requisitionName(req), 'PRD - UWH — Upper Warehouse — 1 Oct 2026');
  assert.deepEqual(transferRows(req, 'MFR-00000007'), [[
    'MFR-00000007', 'PRD', 'PRD - UWH', 'PRD - UWH — Upper Warehouse — 1 Oct 2026', 'BOTTLE', '360', '="B1"',
  ]]);
});
