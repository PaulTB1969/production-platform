// `npm run seed` — loads made-up BOMs and batches into the LOCAL dev
// database so the screens can be tried before Unleashed is connected.
// Refuses to run against a real Postgres (DATABASE_URL set).

import { mkdir } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { openDb } from './index.js';
import { migrate } from './migrate.js';
import { replaceRecipes, replaceComponentBatches } from '../services/stock.js';

const config = loadConfig();
if (config.databaseUrl) {
  console.error('DATABASE_URL is set — seed only runs against the local dev database.');
  process.exit(1);
}
await mkdir(config.pgliteDir, { recursive: true });
const db = await openDb(config);
await migrate(db);

const bottle500 = { componentSku: 'DEMO_BOTTLE_500', componentDescription: 'Demo bottle 500ml', qtyPerUnit: 24, isBatchTracked: true };
const cap = { componentSku: 'DEMO_CAP', componentDescription: 'Demo cap', qtyPerUnit: 24, isBatchTracked: true };
const label = { componentSku: 'DEMO_LABEL_500', componentDescription: 'Demo label 500ml', qtyPerUnit: 24, isBatchTracked: false };
const shrink = { componentSku: 'DEMO_SHRINK', componentDescription: 'Demo shrink wrap (m)', qtyPerUnit: 1.2, isBatchTracked: false };

await replaceRecipes(db, [
  { sku: 'DEMO_P500_STILL', description: 'Demo 500ml still x24', expectedDuration: '2', lines: [bottle500, cap, label, shrink] },
  { sku: 'DEMO_P500_SPARK', description: 'Demo 500ml sparkling x24', expectedDuration: '2.5', lines: [bottle500, cap, label, shrink] },
]);
await replaceComponentBatches(db, [
  { componentSku: 'DEMO_BOTTLE_500', batchNumber: 'DB-2401', quantityRemaining: 6000, expiryDate: '2026-12-15' },
  { componentSku: 'DEMO_BOTTLE_500', batchNumber: 'DB-2410', quantityRemaining: 20000, expiryDate: '2027-04-30' },
  { componentSku: 'DEMO_CAP', batchNumber: 'DC-118', quantityRemaining: 30000, expiryDate: '2027-08-01' },
]);
console.log('Seeded demo BOMs (DEMO_P500_STILL, DEMO_P500_SPARK) and batches into', config.pgliteDir);
await db.close();
