// Platform admin console: sign-in, customers, sites with encrypted keys,
// Test & import from (a fake) Unleashed, tracking mode, duplicates.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { createAdmin, detectTracking } from '../src/services/platform.js';
import { encrypt, decrypt, masterKeyFrom } from '../src/secrets.js';

let db, server, base, cookie;
const accounts = {}; // apiId -> fake Unleashed account
const seenCreds = [];

function fakeClient({ apiId, apiKey }) {
  seenCreds.push({ apiId, apiKey });
  const acct = accounts[apiId];
  const fail = () => { const e = new Error('HTTP 403 Forbidden'); e.status = 403; throw e; };
  return {
    async get(path) {
      if (!acct || acct.key !== apiKey) fail();
      if (path === 'Companies') return { Items: [{ Guid: acct.guid, CompanyName: acct.name, BaseCurrencyCode: 'ZAR', DefaultTaxRate: 0.15 }] };
      if (path === 'Warehouses') return { Items: [{ WarehouseCode: 'MAIN', WarehouseName: 'Main', IsDefault: true }, { WarehouseCode: 'OLD', Obsolete: true }] };
      if (path === 'ProductGroups') return { Items: [{ GroupName: 'Bottles' }, { GroupName: 'Caps' }] };
      throw new Error('unexpected ' + path);
    },
    async getAll(resource) {
      if (!acct || acct.key !== apiKey) fail();
      if (resource === 'Products') return acct.products;
      throw new Error('unexpected ' + resource);
    },
  };
}

async function call(method, path, body, withCookie = true) {
  const res = await fetch(base + path, {
    method, redirect: 'manual',
    headers: { ...(withCookie && cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* page */ }
  return { status: res.status, data, headers: res.headers };
}

async function signIn(email, password) {
  const res = await fetch(base + '/admin/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password }),
  });
  return { location: res.headers.get('location'), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

before(async () => {
  db = await openDb({});
  await migrate(db);
  server = createApp({ db, config: {}, createClient: fakeClient }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await db.close(); });

test('secrets: encrypted, tamper-proof, and the master key must be 32 bytes', () => {
  const key = masterKeyFrom(Buffer.alloc(32, 1).toString('base64'));
  const blob = encrypt('my-api-key', key);
  assert.ok(!blob.includes('my-api-key'));
  assert.equal(decrypt(blob, key), 'my-api-key');
  assert.notEqual(encrypt('my-api-key', key), blob); // fresh IV each time
  assert.throws(() => decrypt(blob, masterKeyFrom(Buffer.alloc(32, 2).toString('base64'))));
  assert.throws(() => masterKeyFrom('c2hvcnQ='), /32 bytes/);
});

test('tracking mode is worked out from the product flags', () => {
  assert.equal(detectTracking({ batchTracked: 3, serialized: 0 }), 'batch');
  assert.equal(detectTracking({ batchTracked: 0, serialized: 2 }), 'serial');
  assert.equal(detectTracking({ batchTracked: 1, serialized: 1 }), 'both');
  assert.equal(detectTracking({ batchTracked: 0, serialized: 0 }), 'none');
});

test('admin console needs an admin sign-in, separate from the customer login', async () => {
  assert.equal((await call('GET', '/admin/api/customers', undefined, false)).status, 401);
  assert.equal((await call('GET', '/admin/', undefined, false)).headers.get('location'), '/admin/login');
  // A customer user's cookie doesn't open it (different cookie, path and key).
  const user = await fetch(base + '/admin/api/customers', { headers: { Cookie: 'ph_session=u.1.1.9999999999999.x' } });
  assert.equal(user.status, 401);

  const { password } = await createAdmin(db, { name: 'Paul Beatham', email: 'Paul@Example.com' });
  assert.match((await signIn('paul@example.com', 'wrong')).location, /error=wrong/);
  const s = await signIn('paul@example.com', password);
  assert.equal(s.location, '/admin/');
  cookie = s.cookie;
  // One-time password: must choose their own first.
  assert.equal((await call('GET', '/admin/api/customers')).status, 403);
  const pw = await call('POST', '/admin/api/me/password', { next: 'admin-pass-1' });
  assert.equal(pw.status, 200);
  cookie = (pw.headers.get('set-cookie') || '').split(';')[0];
  assert.equal((await call('GET', '/admin/api/customers')).status, 200);
});

test('customers and sites: keys stored encrypted, never sent back; Test & import', async () => {
  accounts.ID1 = {
    key: 'KEY1', guid: 'guid-acme', name: 'Acme Bottling (Pty) Ltd',
    products: [{ IsBatchTracked: true }, { IsBatchTracked: true }, { IsSerialized: false }, { IsBatchTracked: true, Obsolete: true }],
  };
  assert.equal((await call('POST', '/admin/api/customers', { name: '  ' })).status, 400);
  const c = (await call('POST', '/admin/api/customers', { name: 'Acme Group', vatNo: '4123', contactEmail: 'ops@acme.test' })).data;
  assert.equal(c.vatNo, '4123');

  assert.equal((await call('POST', '/admin/api/sites', { customerId: c.id, name: 'Acme Bottling', apiId: 'ID1' })).status, 400);
  const site = (await call('POST', '/admin/api/sites', { customerId: c.id, name: 'Acme Bottling', apiId: 'ID1', apiKey: 'KEY1' })).data;
  assert.equal(site.hasApiKey, true);
  assert.ok(!JSON.stringify(site).includes('KEY1'));
  const stored = (await db.query('SELECT api_key_enc FROM sites WHERE id = $1', [site.id])).rows[0].api_key_enc;
  assert.ok(stored.startsWith('v1.') && !stored.includes('KEY1'));

  const imported = (await call('POST', `/admin/api/sites/${site.id}/import`)).data;
  assert.equal(imported.companyName, 'Acme Bottling (Pty) Ltd');
  assert.equal(imported.baseCurrency, 'ZAR');
  assert.deepEqual(imported.productCounts, { total: 3, batchTracked: 2, serialized: 0 }); // obsolete left out
  assert.equal(imported.trackingDetected, 'batch');
  assert.equal(imported.tracking, 'batch');
  assert.equal(imported.productGroupCount, 2);
  assert.deepEqual(imported.warehouses.map((w) => [w.code, w.obsolete]), [['MAIN', false], ['OLD', true]]);
  assert.deepEqual(seenCreds.at(-1), { apiId: 'ID1', apiKey: 'KEY1' }); // decrypted for the call only

  // Override the tracking mode.
  const over = (await call('PATCH', `/admin/api/sites/${site.id}`, { trackingOverride: 'none' })).data;
  assert.equal(over.tracking, 'none');
  assert.equal((await call('PATCH', `/admin/api/sites/${site.id}`, { trackingOverride: 'lots' })).status, 400);

  const list = (await call('GET', '/admin/api/customers')).data;
  assert.equal(list[0].sites[0].name, 'Acme Bottling');
  assert.ok(!JSON.stringify(list).includes('KEY1') && !JSON.stringify(list).includes(stored));
});

test('wrong keys: import fails with a clear message and the site keeps its details', async () => {
  const c = (await call('POST', '/admin/api/customers', { name: 'Beta Foods' })).data;
  const site = (await call('POST', '/admin/api/sites', { customerId: c.id, name: 'Beta', apiId: 'ID1', apiKey: 'WRONG' })).data;
  const r = await call('POST', `/admin/api/sites/${site.id}/import`);
  assert.equal(r.status, 502);
  assert.match(r.data.error, /refused the API ID/);
  const after = (await call('GET', '/admin/api/customers')).data.find((x) => x.id === c.id).sites[0];
  assert.match(after.importError, /refused/);
  assert.equal(after.companyName, null);

  // Right key now — but it's the account already set up as Acme Bottling.
  await call('PATCH', `/admin/api/sites/${site.id}`, { apiKey: 'KEY1' });
  const dup = await call('POST', `/admin/api/sites/${site.id}/import`);
  assert.equal(dup.status, 409);
  assert.match(dup.data.error, /already set up as site "Acme Bottling"/);
});

test('one customer, two Unleashed accounts (separate companies)', async () => {
  accounts.ID2 = { key: 'K2', guid: 'guid-gamma-1', name: 'Gamma Water', products: [{ IsSerialized: true }, { IsBatchTracked: true }] };
  accounts.ID3 = { key: 'K3', guid: 'guid-gamma-2', name: 'Gamma Juice', products: [{}] };
  const c = (await call('POST', '/admin/api/customers', { name: 'Gamma Holdings' })).data;
  for (const [name, apiId, apiKey] of [['Gamma Water', 'ID2', 'K2'], ['Gamma Juice', 'ID3', 'K3']]) {
    const s = (await call('POST', '/admin/api/sites', { customerId: c.id, name, apiId, apiKey })).data;
    assert.equal((await call('POST', `/admin/api/sites/${s.id}/import`)).status, 200);
  }
  const sites = (await call('GET', '/admin/api/customers')).data.find((x) => x.id === c.id).sites;
  assert.deepEqual(sites.map((s) => [s.name, s.tracking]), [['Gamma Juice', 'none'], ['Gamma Water', 'both']]);

  const log = (await call('GET', '/admin/api/activity')).data.map((l) => l.action);
  assert.ok(log.includes('Added customer Gamma Holdings'));
  assert.ok(log.some((a) => a.startsWith('Imported from Unleashed: Gamma Water')));
});

test('hourly sync: each site from its own Unleashed account into its own schema', async () => {
  const { syncAllSites } = await import('../src/unleashed/syncAll.js');
  const bom = (sku) => [{ Product: { ProductCode: sku, ProductDescription: sku }, BillOfMaterialsLines: [] }];
  const clientFor = ({ apiId }) => ({
    async getAll(resource) {
      if (resource === 'BillOfMaterials') return bom(apiId === 'ID2' ? 'WATER_ONLY' : apiId === 'ID3' ? 'JUICE_ONLY' : 'ACME_ONLY');
      return [];
    },
  });
  const results = await syncAllSites(db, { masterKey: masterKeyFrom(null), createClient: clientFor });
  assert.ok(results.length >= 3 && results.every((r) => r.ok), JSON.stringify(results));
  const sites = (await db.query('SELECT id, name FROM sites WHERE imported_at IS NOT NULL')).rows;
  for (const s of sites) {
    const skus = (await db.scoped('site_' + s.id).query('SELECT sku FROM recipes')).rows.map((r) => r.sku);
    const expected = { 'Gamma Water': ['WATER_ONLY'], 'Gamma Juice': ['JUICE_ONLY'], 'Acme Bottling': ['ACME_ONLY'] }[s.name];
    assert.deepEqual(skus, expected, s.name);
  }
});
