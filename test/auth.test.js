import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAuth, COOKIE } from '../src/auth.js';

let server, base, clock = Date.now();

before(() => {
  const app = express();
  const auth = createAuth({ user: 'production', password: 'right-pass' }, { now: () => clock });
  app.use(auth.router);
  app.use(auth.guard);
  app.get('/login', (req, res) => res.send('login page'));
  app.get('/api/thing', (req, res) => res.json({ ok: true }));
  app.get('/schedule', (req, res) => res.send('schedule page'));
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const get = (path, headers = {}) => fetch(base + path, { headers, redirect: 'manual' });
const login = (username, password, next = '/') => fetch(base + '/login', {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username, password, next }),
});
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

test('signed-out: pages go to the login page, the API says 401, no browser pop-up', async () => {
  const page = await get('/schedule?date=2026-10-05');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login?next=%2Fschedule%3Fdate%3D2026-10-05');
  const api = await get('/api/thing');
  assert.equal(api.status, 401);
  assert.equal(api.headers.get('www-authenticate'), null);
  assert.equal((await get('/login')).status, 200);
});

test('wrong password goes back to the login page with an error', async () => {
  const res = await login('production', 'nope', '/schedule');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/login?error=wrong&next=%2Fschedule');
  assert.equal(res.headers.get('set-cookie'), null);
});

test('right password sets a 90-day cookie that opens pages and the API', async () => {
  const res = await login(' production ', 'right-pass', '/schedule');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/schedule');
  assert.match(res.headers.get('set-cookie'), /HttpOnly/);
  assert.match(res.headers.get('set-cookie'), /Max-Age=7776000/);
  const cookie = cookieOf(res);
  assert.equal((await get('/api/thing', { Cookie: cookie })).status, 200);
  assert.equal((await get('/schedule', { Cookie: cookie })).status, 200);

  // A tampered cookie is refused; so is one past its expiry.
  assert.equal((await get('/api/thing', { Cookie: cookie.replace(/.$/, 'x') })).status, 401);
  clock += 91 * 24 * 3600 * 1000;
  assert.equal((await get('/api/thing', { Cookie: cookie })).status, 401);
  clock = Date.now();
});

test('login never redirects off the site', async () => {
  for (const next of ['https://evil.example', '//evil.example', '/\\evil.example']) {
    assert.equal((await login('production', 'right-pass', next)).headers.get('location'), '/');
  }
});

test('Basic auth header still works for scripts', async () => {
  const h = { Authorization: 'Basic ' + Buffer.from('production:right-pass').toString('base64') };
  assert.equal((await get('/api/thing', h)).status, 200);
});

test('10 wrong attempts lock that address out for 15 minutes', async () => {
  for (let i = 0; i < 10; i++) await login('production', 'guess' + i);
  const locked = await login('production', 'right-pass');
  assert.match(locked.headers.get('location'), /error=locked/);
  clock += 16 * 60 * 1000;
  assert.equal((await login('production', 'right-pass')).headers.get('location'), '/');
  clock = Date.now();
});
