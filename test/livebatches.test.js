// The batch pop-up's live check: one product's PRD batches straight from
// the site's own Unleashed account, replacing just that product's rows.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { replaceComponentBatches, listComponentBatches } from '../src/services/stock.js';

let app;
const calls = [];
const live = [
  { ProductCode: 'BOTTLE', WarehouseCode: 'PRD', Number: 'B-OLD', Quantity: 100, Status: 'Available', ExpiryDate: '/Date(1798761600000)/' },
  { ProductCode: 'BOTTLE', WarehouseCode: 'PRD', Number: 'B-NEW-TODAY', Quantity: 5000, Status: 'Available' },
  { ProductCode: 'BOTTLE', WarehouseCode: 'PRD', Number: 'B-EMPTY', Quantity: 0, Status: 'Available' },
];
const fakeClient = () => ({
  async getAll(resource, params) {
    calls.push([resource, params]);
    return live.filter((b) => b.ProductCode === params.productCode && b.WarehouseCode === params.warehouseCode);
  },
});

before(async () => {
  app = await startApp({ createClient: fakeClient });
  await replaceComponentBatches(app.siteDb, [
    { componentSku: 'BOTTLE', batchNumber: 'B-OLD', quantityRemaining: 300 },
    { componentSku: 'CAP', batchNumber: 'C-1', quantityRemaining: 50 },
  ]);
});
after(() => app.close());

test('live batches: today\'s receipt shows up, quantities refresh, other products untouched', async () => {
  const r = await app.api('GET', '/api/stock/live-batches?sku=BOTTLE');
  assert.equal(r.status, 200);
  assert.deepEqual(calls.at(-1), ['BatchNumbers', { productCode: 'BOTTLE', warehouseCode: 'PRD' }]);
  assert.deepEqual(r.data.batches.map((b) => [b.batchNumber, b.quantityRemaining]), [['B-OLD', 100], ['B-NEW-TODAY', 5000]]);
  const all = await listComponentBatches(app.siteDb);
  assert.deepEqual(all.CAP.batches.map((b) => b.batchNumber), ['C-1']);
  assert.equal((await app.api('GET', '/api/stock/live-batches')).status, 400);
});
