// Fixtures are trimmed copies of real Unleashed payloads (probe run 2026-10-01).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapBillsOfMaterials, mapBatchNumbers, mapStockOnHand } from '../src/unleashed/sync.js';
import { sign, parseUnleashedDate, buildQuery } from '../src/unleashed/client.js';

const line = (n, code, desc, isBatch, qty) => ({
  LineNumber: n, Quantity: qty, WastageQuantity: 0,
  Product: { ProductCode: code, ProductDescription: desc, IsBatchTracked: isBatch },
});

const boms = [
  {
    Obsolete: false, AutoAssignOldestBatchSerial: true, ExpectedDuration: '40m',
    Product: { ProductCode: 'P500ST_MFSIG_PN', ProductDescription: '500ml Still Signature', Obsolete: false, IsBatchTracked: true },
    BillOfMaterialsLines: [
      line(3, 'CP_BLACK', 'Black PET Caps', true, 24),
      line(1, 'BP500_SLIM', 'Bottle PET 500ml Slim', true, 24),
      line(5, 'BOX 500ST Black', 'Box 24x500ML Black', false, 1),
    ],
  },
  {
    Obsolete: false, AutoAssignOldestBatchSerial: false, ExpectedDuration: null,
    Product: { ProductCode: 'P19.0_NEW TAP', ProductDescription: '19.5 Ltr with Tap', Obsolete: true },
    BillOfMaterialsLines: [],
  },
];

test('BOMs: line flags come from the embedded product, obsolete products skipped, LineNumber order', () => {
  assert.deepEqual(mapBillsOfMaterials(boms), [{
    sku: 'P500ST_MFSIG_PN',
    description: '500ml Still Signature',
    autoAssignOldestBatch: true,
    batchTracked: true,
    expectedDuration: '40m',
    lines: [
      { componentSku: 'BP500_SLIM', componentDescription: 'Bottle PET 500ml Slim', qtyPerUnit: 24, wastageQty: 0, isBatchTracked: true },
      { componentSku: 'CP_BLACK', componentDescription: 'Black PET Caps', qtyPerUnit: 24, wastageQty: 0, isBatchTracked: true },
      { componentSku: 'BOX 500ST Black', componentDescription: 'Box 24x500ML Black', qtyPerUnit: 1, wastageQty: 0, isBatchTracked: false },
    ],
  }]);
});

test('batches: only available PRD stock', () => {
  const batch = (over) => ({
    Number: 'B1', ExpiryDate: '/Date(1822176000000)/', Quantity: 12, OriginalQty: 63,
    ProductCode: 'BP500_SLIM', WarehouseCode: 'PRD', Status: 'Available', CreatedOn: '/Date(1790784617782)/', ...over,
  });
  const out = mapBatchNumbers([
    batch({}),
    batch({ Number: 'CPT-1', WarehouseCode: 'CPT' }),
    batch({ Number: 'EMPTY', Quantity: 0 }),
    batch({ Number: 'HELD', Status: 'Quarantined' }),
  ]);
  assert.deepEqual(out, [{
    componentSku: 'BP500_SLIM', batchNumber: 'B1', quantityRemaining: 12, originalQty: 63,
    expiryDate: '2027-09-29', createdOn: '2026-09-30',
  }]);
});

test('request signing and date parsing', () => {
  // HMAC-SHA256 of the query string, base64.
  assert.equal(sign('pageSize=2', 'key'), 'WW4dfm5/Yz2K10qbS4tngX11TnslBdzGNzvKPVP71Nw=');
  // Real expiry for batch '20260929  1': UTC midnight, one year after production.
  assert.equal(parseUnleashedDate('/Date(1822176000000)/'), '2027-09-29');
  assert.equal(parseUnleashedDate(null), null);
});

test('stock on hand: PRD only, quantity on hand per product', () => {
  const soh = (code, wh, qty) => ({ ProductCode: code, ProductDescription: 'Label 500ml', WarehouseCode: wh, QtyOnHand: qty, AvailableQty: qty });
  assert.deepEqual(mapStockOnHand([soh('LP500ST_MFSIG_PN', 'PRD', 101416), soh('LP500ST_MFSIG_PN', 'CPT', 5)]), [
    { productCode: 'LP500ST_MFSIG_PN', description: 'Label 500ml', qtyOnHand: 101416, availableQty: 101416 },
  ]);
});

test('query with spaces: sent URL-encoded but signed unencoded (the live API rejects the other way)', () => {
  assert.deepEqual(buildQuery({ warehouseCode: 'PRD', productCode: 'BOX 500ST Black', pageSize: 500, skip: undefined }), {
    query: 'warehouseCode=PRD&productCode=BOX%20500ST%20Black&pageSize=500',
    signed: 'warehouseCode=PRD&productCode=BOX 500ST Black&pageSize=500',
  });
});

test('client retries reads on temporary Unleashed errors, never writes', async () => {
  const { createUnleashedClient } = await import('../src/unleashed/client.js');
  const calls = [];
  const replies = [502, 502, 200];
  const fetchImpl = async (url, opts) => {
    calls.push(opts.method);
    const status = opts.method === 'GET' ? replies.shift() : 502;
    return { ok: status === 200, status, text: async () => (status === 200 ? '{"Items":[]}' : 'Bad Gateway') };
  };
  const u = createUnleashedClient({ apiId: 'id', apiKey: 'key', baseUrl: 'https://x', clientType: 't' }, { fetchImpl, retryDelaysMs: [1, 1] });
  assert.deepEqual(await u.get('StockOnHand/1'), { Items: [] });
  assert.deepEqual(calls, ['GET', 'GET', 'GET']);
  await assert.rejects(u.post('Assemblies', {}), /HTTP 502/);
  assert.equal(calls.filter((m) => m === 'POST').length, 1);
});
