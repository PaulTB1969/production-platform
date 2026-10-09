// Test set-ups: a site database for service-level tests, and a running app
// with a customer, a site and a signed-in admin user for HTTP tests.

import { openDb } from '../src/db/index.js';
import { migratePlatform, migrateSite, migrate } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import * as platform from '../src/services/platform.js';
import * as users from '../src/services/users.js';
import { masterKeyFrom } from '../src/secrets.js';

// A site's own schema, as the services see it. close() closes everything.
export async function openSiteDb() {
  const root = await openDb({});
  await migratePlatform(root);
  const db = await migrateSite(root, 1);
  return Object.assign(db, { root, close: () => root.close() });
}

export async function signIn(base, username, password) {
  const res = await fetch(base + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, next: '/' }),
  });
  return { location: res.headers.get('location'), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

// Signs in with a one-time password and sets a real one; returns the cookie.
export async function firstSignIn(base, username, otp, newPw) {
  const s = await signIn(base, username, otp);
  if (!/^\/account\?first=1/.test(s.location || '')) throw new Error('Expected the first-sign-in redirect, got ' + s.location);
  const res = await fetch(base + '/api/me/password', {
    method: 'POST', headers: { Cookie: s.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ next: newPw }),
  });
  if (res.status !== 200) throw new Error('Password change failed: ' + (await res.text()));
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

// cookie may be a string or { cookie } — returns { status, data, headers }.
export function caller(base) {
  return async function call(method, path, body, cookie) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (typeof body === 'string') { headers['Content-Type'] = 'text/csv'; payload = body; }
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + path, { method, headers, body: payload, redirect: 'manual' });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* csv / page */ }
    return { status: res.status, data, headers: res.headers };
  };
}

// A running app with one customer, one site and its admin, signed in.
export async function startApp({ createClient = () => null, config = {} } = {}) {
  const db = await openDb({});
  await migrate(db);
  const masterKey = masterKeyFrom(null);
  const server = createApp({ db, config: { productionEmail: 'prod@example.com', ...config }, createClient }).listen(0);
  const base = `http://localhost:${server.address().port}`;
  const customer = await platform.createCustomer(db, { name: 'Test Customer' });
  const site = await platform.createSite(db, { customerId: customer.id, name: 'Test Site', apiId: 'test-id', apiKey: 'test-key' }, { masterKey });
  const siteDb = db.scoped('site_' + site.id);
  const adminRole = (await users.listRoles(siteDb, site.id)).find((r) => r.name === 'Admin');
  const { password } = await users.createUser(db, siteDb, { customerId: customer.id, siteId: site.id },
    { name: 'Site Admin', email: 'admin@test.example', roleId: adminRole.id });
  const cookie = await firstSignIn(base, 'admin@test.example', password, 'admin-pass-1');
  const call = caller(base);
  return {
    db, server, base, customer, site, siteDb, cookie, masterKey,
    // As the site admin by default.
    api: (method, path, body, asCookie = cookie) => call(method, path, body, asCookie),
    headers: () => ({ Cookie: cookie }),
    close: async () => { server.close(); await db.close(); },
  };
}
