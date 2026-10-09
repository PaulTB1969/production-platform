// The platform admin console at /admin: its own sign-in (platform_admins),
// separate from customers' users, and the API behind it at /admin/api.
//
// Cookie "pp_admin" = "<id>.<version>.<expiry>.<HMAC>", path /admin, signed
// with a key derived from MASTER_KEY. Bumping the admin's session_version
// (password change) signs them out everywhere.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { UserError } from '../services/rows.js';
import * as platform from '../services/platform.js';

const ADMIN_UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'admin-ui');
const COOKIE = 'pp_admin';
const MAX_AGE_MS = 12 * 3600 * 1000; // a working day — admin access is powerful

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

export function adminRouter({ db, masterKey, createClient, supportCookie, secure = false, now = () => Date.now() }) {
  const key = createHmac('sha256', 'platform-admin-session').update(masterKey).digest();
  const sign = (s) => createHmac('sha256', key).update(s).digest('base64url');
  const cookieOpts = { httpOnly: true, secure, sameSite: 'strict', maxAge: MAX_AGE_MS, path: '/admin' };
  const setCookie = (res, a) => {
    const body = `${a.id}.${a.session_version}.${now() + MAX_AGE_MS}`;
    res.cookie(COOKIE, `${body}.${sign(body)}`, cookieOpts);
  };

  // 10 failed sign-ins per address per 15 minutes.
  const failures = new Map();
  const ipOf = (req) => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const blocked = (ip) => {
    const f = failures.get(ip);
    if (!f) return false;
    if (f.until < now()) { failures.delete(ip); return false; }
    return f.count >= 10;
  };
  const fail = (ip) => {
    const f = failures.get(ip);
    if (!f || f.until < now()) failures.set(ip, { count: 1, until: now() + 15 * 60 * 1000 });
    else f.count++;
  };

  async function currentAdmin(req) {
    const parts = String(readCookie(req, COOKIE) || '').split('.');
    if (parts.length !== 4) return null;
    const [id, ver, exp, sig] = parts;
    if (!(Number(exp) > now()) || !safeEqual(sig, sign(parts.slice(0, 3).join('.')))) return null;
    const a = await platform.getAdmin(db, Number(id));
    return a && a.active && String(a.session_version) === ver ? a : null;
  }

  const r = express.Router();
  r.use(express.json({ limit: '200kb' }));

  // ---------- sign in / out ----------
  r.get('/login', (req, res) => res.sendFile(path.join(ADMIN_UI, 'login.html')));
  r.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
    const ip = ipOf(req);
    if (blocked(ip)) return res.redirect(303, '/admin/login?error=locked');
    const a = await platform.checkAdminPassword(db, req.body?.email, req.body?.password || '');
    if (!a) { fail(ip); return res.redirect(303, '/admin/login?error=wrong'); }
    failures.delete(ip);
    await platform.logPlatform(db, a, 'Signed in to the admin console');
    setCookie(res, a);
    res.redirect(303, '/admin/');
  });
  r.post('/logout', (req, res) => {
    res.clearCookie(COOKIE, { path: '/admin' });
    res.redirect(303, '/admin/login');
  });

  // ---------- everything else needs an admin ----------
  r.use(async (req, res, next) => {
    const a = await currentAdmin(req);
    if (!a) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Signed out — sign in to the admin console again.' });
      return res.redirect(302, '/admin/login');
    }
    req.admin = a;
    if (a.must_change_password && !['/api/me', '/api/me/password'].includes(req.path) && req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'Choose your own password first.' });
    }
    next();
  });

  const log = (req, action, ids = {}, detail = {}) => platform.logPlatform(db, req.admin, action, { ...ids, detail });
  const opts = { masterKey, createClient };

  r.get('/api/me', (req, res) => res.json({
    id: req.admin.id, name: req.admin.name, email: req.admin.email, mustChangePassword: req.admin.must_change_password,
  }));
  r.post('/api/me/password', async (req, res) => {
    const a = await platform.changeAdminPassword(db, req.admin.id, { current: req.body?.current, next: req.body?.next },
      { skipCurrent: req.admin.must_change_password });
    await log(req, 'Changed their password');
    setCookie(res, a);
    res.json({ ok: true });
  });

  // Customers, each with its sites.
  r.get('/api/customers', async (req, res) => res.json(await platform.listCustomers(db)));
  r.post('/api/customers', async (req, res) => {
    const c = await platform.createCustomer(db, req.body || {});
    await log(req, 'Added customer ' + c.name, { customerId: c.id });
    res.status(201).json(c);
  });
  r.patch('/api/customers/:id', async (req, res) => {
    const c = await platform.updateCustomer(db, Number(req.params.id), req.body || {});
    await log(req, 'Changed customer ' + c.name, { customerId: c.id });
    res.json(c);
  });

  // Sites (Unleashed accounts). API keys go in, never come out.
  r.post('/api/sites', async (req, res) => {
    const s = await platform.createSite(db, req.body || {}, opts);
    await log(req, 'Added site ' + s.name, { customerId: s.customerId, siteId: s.id });
    res.status(201).json(s);
  });
  r.patch('/api/sites/:id', async (req, res) => {
    const s = await platform.updateSite(db, Number(req.params.id), req.body || {}, opts);
    const what = [req.body?.apiKey ? 'API key' : null, req.body?.apiId ? 'API ID' : null,
      'trackingOverride' in (req.body || {}) ? 'tracking' : null].filter(Boolean);
    await log(req, 'Changed site ' + s.name + (what.length ? ' (' + what.join(', ') + ')' : ''), { customerId: s.customerId, siteId: s.id });
    res.json(s);
  });
  r.post('/api/sites/:id/import', async (req, res) => {
    const id = Number(req.params.id);
    try {
      const s = await platform.testAndImport(db, id, opts);
      await log(req, 'Imported from Unleashed: ' + s.name, { customerId: s.customerId, siteId: s.id },
        { company: s.companyName, tracking: s.trackingDetected, warehouses: s.warehouses.length });
      res.json(s);
    } catch (err) {
      await log(req, 'Import from Unleashed failed', { siteId: id }, { error: err.message });
      throw err;
    }
  });

  // Support: open a customer's site (view-only unless edit), 2 hours. The
  // cookie it sets is what the customer app checks; the customer sees the
  // session on their Users & Roles page.
  r.post('/api/sites/:id/support', async (req, res) => {
    const s = await platform.startSupportSession(db, req.admin, Number(req.params.id), { reason: req.body?.reason, mode: req.body?.mode || 'view' });
    await log(req, `Opened site for support (${s.mode}): ${req.body?.reason}`, { siteId: s.site_id });
    const c = supportCookie(s.id, s.expires_at);
    res.cookie(c.name, c.value, c.opts);
    res.json({ ok: true, url: '/', mode: s.mode, expiresAt: s.expires_at });
  });
  r.get('/api/sites/:id/support', async (req, res) => res.json(await platform.listSupportSessions(db, Number(req.params.id))));

  r.get('/api/activity', async (req, res) => res.json(await platform.listPlatformActivity(db, { limit: req.query.limit })));

  r.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  r.use('/api', (err, req, res, next) => {
    if (err instanceof UserError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  // The console pages.
  r.use(express.static(ADMIN_UI, { index: 'index.html' }));
  return r;
}
