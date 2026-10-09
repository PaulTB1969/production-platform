// `npm run seed` — a demo customer, site and admin user in the LOCAL dev
// database, with made-up BOMs and batches, so the screens can be tried
// without Unleashed. Refuses to run against a real Postgres (DATABASE_URL set).

import { mkdir } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { openDb } from './index.js';
import { migrate } from './migrate.js';
import { masterKeyFrom } from '../secrets.js';
import { createCustomer, createSite } from '../services/platform.js';
import { createUser, listRoles } from '../services/users.js';
import { replaceRecipes, replaceComponentBatches } from '../services/stock.js';

const config = loadConfig();
if (config.databaseUrl) {
  console.error('DATABASE_URL is set — seed only runs against the local dev database.');
  process.exit(1);
}
await mkdir(config.pgliteDir, { recursive: true });
const db = await openDb(config);
await migrate(db);

const customer = await createCustomer(db, { name: 'Demo Customer' });
const site = await createSite(db, { customerId: customer.id, name: 'Demo Site', apiId: 'demo', apiKey: 'demo' },
  { masterKey: masterKeyFrom(config.masterKey) });
const sdb = db.scoped('site_' + site.id);

const bottle500 = { componentSku: 'DEMO_BOTTLE_500', componentDescription: 'Demo bottle 500ml', qtyPerUnit: 24, isBatchTracked: true };
const cap = { componentSku: 'DEMO_CAP', componentDescription: 'Demo cap', qtyPerUnit: 24, isBatchTracked: true };
const label = { componentSku: 'DEMO_LABEL_500', componentDescription: 'Demo label 500ml', qtyPerUnit: 24, isBatchTracked: false };
const shrink = { componentSku: 'DEMO_SHRINK', componentDescription: 'Demo shrink wrap (m)', qtyPerUnit: 1.2, isBatchTracked: false };
await replaceRecipes(sdb, [
  { sku: 'DEMO_P500_STILL', description: 'Demo 500ml still x24', expectedDuration: '2', lines: [bottle500, cap, label, shrink] },
  { sku: 'DEMO_P500_SPARK', description: 'Demo 500ml sparkling x24', expectedDuration: '2.5', lines: [bottle500, cap, label, shrink] },
]);
await replaceComponentBatches(sdb, [
  { componentSku: 'DEMO_BOTTLE_500', batchNumber: 'DB-2401', quantityRemaining: 6000, expiryDate: '2026-12-15' },
  { componentSku: 'DEMO_BOTTLE_500', batchNumber: 'DB-2410', quantityRemaining: 20000, expiryDate: '2027-04-30' },
  { componentSku: 'DEMO_CAP', batchNumber: 'DC-118', quantityRemaining: 30000, expiryDate: '2027-08-01' },
]);

const admin = (await listRoles(sdb, site.id)).find((r) => r.name === 'Admin');
const email = process.argv[2] || 'demo@example.test';
const { password } = await createUser(db, sdb, { customerId: customer.id, siteId: site.id }, { name: 'Demo Admin', email, roleId: admin.id });
console.log(`Seeded "Demo Customer" / "Demo Site" with demo BOMs and batches into ${config.pgliteDir}.`);
console.log(`Sign in at /login as ${email} with one-time password ${password}`);
await db.close();
