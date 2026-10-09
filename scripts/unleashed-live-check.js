// One-off live check of sending to Unleashed, using the app's real payload
// code. Creates ONE Parked transfer and ONE Parked assembly, both labelled
// "TEST – delete me" (Parked records move no stock), reads them back, and
// saves their ids so they can be deleted:
//   node --env-file=.env scripts/unleashed-live-check.js
//   node --env-file=.env scripts/unleashed-live-check.js --delete

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createUnleashedClient } from '../src/unleashed/client.js';
import { transferPayload, assemblyPayload, trackingPayload } from '../src/domain/unleashedPayloads.js';

const STATE = '.data/unleashed-live-test.json';
const config = loadConfig();
const u = createUnleashedClient(config.unleashed);
if (!u) throw new Error('Unleashed keys missing in .env');

if (process.argv.includes('--delete')) {
  const s = JSON.parse(readFileSync(STATE, 'utf8'));
  for (const [path, guid, label] of [['WarehouseStockTransfers', s.transferGuid, s.transferNumber], ['Assemblies', s.assemblyGuid, s.assemblyNumber]]) {
    if (!guid) continue;
    try { await u.del(`${path}/${guid}`); console.log(`deleted ${label}`); }
    catch (e) { console.log(`could not delete ${label}: ${e.message}`); }
  }
  process.exit(0);
}

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => { mkdirSync('.data', { recursive: true }); writeFileSync(STATE, JSON.stringify(state, null, 2)); };
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });

// ---- 1. Transfer ----
if (!state.transferGuid) {
  const body = transferPayload({
    id: 'live-test', line: 'PRD - UWH', date: today,
    lines: [
      { sku: 'LP500ST_MFSIG_PN', qtyUsed: 1 },
      { sku: 'BP500_SLIM', qtyUsed: 24, batchNumber: '1803225' },
    ],
  });
  body.Comments = 'TEST – delete me (Production Hub API test) ' + body.Comments;
  const t = await u.post('WarehouseStockTransfers', body);
  Object.assign(state, { transferGuid: t.Guid, transferNumber: t.TransferOrderNumber }); save();
  console.log(`TRANSFER created: ${t.TransferOrderNumber} status=${t.TransferStatus}`);
}
const tBack = await u.get(`WarehouseStockTransfers/${state.transferGuid}`);
console.log('  read back:', JSON.stringify({
  number: tBack.TransferOrderNumber, status: tBack.TransferStatus, comments: tBack.Comments,
  from: tBack.SourceWarehouse?.WarehouseCode, to: tBack.DestinationWarehouse?.WarehouseCode,
  lines: tBack.TransferDetails?.map((d) => `${d.Product?.ProductCode} x${d.TransferQuantity}${d.Comments ? ' (' + d.Comments + ')' : ''}`),
}));

// ---- 2. Assembly ----
const entry = {
  id: 'live-test', sku: 'P500ST_MFSIG_PN', line: 'PRD - UWH', date: today, seq: 1, actualCases: 1,
  startTime: '07:00', endTime: '07:05', notes: 'TEST – delete me',
  componentUsage: [
    { componentSku: 'BP500_SLIM', batchNumber: '1803225', qtyUsed: 24, wastage: 0 },
    { componentSku: 'CP_BLACK', batchNumber: '1801038', qtyUsed: 24, wastage: 0 },
  ],
};
const recipe = {
  expectedDuration: '40m',
  lines: ['BP500_SLIM', 'CP_BLKSIG330_500_OC', 'CP_BLACK', 'LP500ST_MFSIG_PN'].map((c) => ({ componentSku: c, qtyPerUnit: 24 }))
    .concat([{ componentSku: 'BOX 500ST Black', qtyPerUnit: 1 }]),
};
if (!state.assemblyGuid) {
  let created = null;
  for (const email of [config.productionEmail, 'nicolette@mountainfalls.co.za', null]) {
    const body = assemblyPayload(entry, recipe, { productionEmail: email || undefined });
    body.Comments = 'TEST – delete me (Production Hub API test) · ' + body.Comments;
    try {
      created = await u.post('Assemblies', body);
      state.productionEmailAccepted = email; save();
      console.log(`ASSEMBLY created: ${created.AssemblyNumber} status=${created.AssemblyStatus} (production person: ${email || 'none'})`);
      break;
    } catch (e) {
      console.log(`  assembly with production person ${email || 'none'} refused: ${e.message}`);
      if (!/person|email|user/i.test(e.message)) throw e;
    }
  }
  Object.assign(state, { assemblyGuid: created.Guid, assemblyNumber: created.AssemblyNumber }); save();
}

// ---- 3. Component batch numbers ----
if (!state.trackingTried) {
  try {
    await u.post(`Assemblies/${state.assemblyGuid}/ProductTracking`, trackingPayload(entry));
    state.componentTracking = 'accepted';
  } catch (e) { state.componentTracking = 'refused: ' + e.message; }
  // ---- 4. Finished-goods batch number (docs say unsupported — check) ----
  try {
    const body = trackingPayload(entry);
    body.ProductBatches.push({ Product: { ProductCode: entry.sku }, Batches: [{ BatchNumber: 'TEST 20261006 UWH 1', Quantity: 1 }] });
    await u.put(`Assemblies/${state.assemblyGuid}/ProductTracking`, body);
    state.finishedGoodsBatch = 'accepted';
  } catch (e) { state.finishedGoodsBatch = 'refused: ' + e.message; }
  state.trackingTried = true; save();
}
console.log('  component batches:', state.componentTracking);
console.log('  finished-goods batch:', state.finishedGoodsBatch);

const aBack = await u.get(`Assemblies/${state.assemblyGuid}`);
console.log('  read back:', JSON.stringify({
  number: aBack.AssemblyNumber, status: aBack.AssemblyStatus, qty: aBack.Quantity,
  from: aBack.SourceWarehouse?.WarehouseCode, to: aBack.DestinationWarehouse?.WarehouseCode,
  fgBatches: aBack.BatchNumbers, person: aBack.ProductionPerson?.Email,
  expected: aBack.ExpectedDuration, actual: aBack.ActualDuration, comments: aBack.Comments,
  lines: aBack.AssemblyLines?.map((l) => `${l.Product?.ProductCode} x${l.Quantity} waste ${l.WastageQuantity}` +
    (l.BatchNumbers?.length ? ' batches ' + l.BatchNumbers.map((b) => b.Number + ':' + b.Quantity).join(',') : '')),
}, null, 1));
