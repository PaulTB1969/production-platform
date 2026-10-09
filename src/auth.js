// Sign-in for customers' users, the site they're working in, and platform
// support sessions.
//
// Cookies:
//   ph_session  "u.<user id>.<version>.<expiry>.<HMAC>" — 90 days. The version
//               is bumped on a password change, reset or deactivation, which
//               signs that user out everywhere.
//   pp_site     the site the user last chose (checked against their access on
//               every request; not trusted on its own).
//   pp_support  "s.<support session id>.<expiry>.<HMAC>" — set by the admin
//               console when platform support opens a site. View-only unless
//               the session is in edit mode; ends after 2 hours.
//
// Everything behind the guard runs "inside" its site (tenancy.js): req.user,
// req.site, and the site's own schema and Unleashed account.

import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import * as users from './services/users.js';
import * as platform from './services/platform.js';
import { siteSchema } from './db/index.js';
import { runInSite } from './tenancy.js';

export const COOKIE = 'ph_session';
export const SITE_COOKIE = 'pp_site';
export const SUPPORT_COOKIE = 'pp_support';
const MAX_AGE_MS = 90 * 24 * 3600 * 1000;

// Reachable without signing in: the login page and what it needs to render.
const PUBLIC_PATHS = new Set(['/login', '/login.html', '/healthz', '/styles.css', '/manifest.webmanifest']);
const isPublic = (p) => PUBLIC_PATHS.has(p) || p.startsWith('/icons/') || p.startsWith('/brand/');

// Reachable while a user still has to replace their one-time password.
const isAsset = (p) => /\.(js|css|png|svg|ico|webmanifest)$/.test(p);
const ACCOUNT_PATHS = new Set(['/account', '/account.html', '/api/me', '/api/me/password', '/logout']);

// Pages and who may open them.
const PAGE_AREAS = {
  '/schedule': 'schedule', '/schedule.html': 'schedule',
  '/requisitions': 'requisitions', '/requisitions.html': 'requisitions',
  '/collections': 'collections', '/collections.html': 'collections',
  '/samples': 'samples', '/samples.html': 'samples',
};
const ADMIN_PAGES = new Set(['/users', '/users.html']);

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Only same-site paths, so the login page can't be used to redirect elsewhere.
function safeNext(v) {
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v : '/';
}

const clientIp = (req) => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

export function sessionKey(masterKey) {
  return createHmac('sha256', 'production-platform-session').update(masterKey).digest();
}

export function createAuth({ db, masterKey, createClient, secure = false, now = () => Date.now() }) {
  const key = sessionKey(masterKey);
  const sign = (s) => createHmac('sha256', key).update(String(s)).digest('base64url');
  const cookieOpts = { httpOnly: true, secure, sameSite: 'lax', maxAge: MAX_AGE_MS, path: '/' };

  const setUserCookie = (res, u) => {
    const body = `u.${u.id}.${u.session_version}.${now() + MAX_AGE_MS}`;
    res.cookie(COOKIE, `${body}.${sign(body)}`, cookieOpts);
  };

  // Each site's Unleashed client, rebuilt when its keys change.
  const clients = new Map(); // site id -> { stamp, client }
  async function clientFor(site) {
    if (!createClient) return null;
    const stamp = String(site.updated_at);
    const cached = clients.get(site.id);
    if (cached && cached.stamp === stamp) return cached.client;
    let client = null;
    try { client = createClient(await platform.siteCredentials(db, site.id, { masterKey })); } catch { client = null; }
    clients.set(site.id, { stamp, client });
    return client;
  }

  async function siteContext(siteRow) {
    return {
      site: { id: siteRow.id, name: siteRow.name, customerId: siteRow.customer_id, tracking: siteRow.tracking_override || siteRow.tracking_detected, timeZone: siteRow.time_zone },
      db: db.scoped(siteSchema(siteRow.id)),
      unleashed: await clientFor(siteRow),
    };
  }

  // A valid support session (cookie + open session + site still allows it).
  async function supportFromCookie(req) {
    const parts = String(readCookie(req, SUPPORT_COOKIE) || '').split('.');
    if (parts.length !== 4 || parts[0] !== 's') return null;
    const [, id, exp, sig] = parts;
    if (!(Number(exp) > now()) || !safeEqual(sig, sign(parts.slice(0, 3).join('.')))) return null;
    const s = await platform.getSupportSession(db, Number(id));
    if (!s || s.ended_at || new Date(s.expires_at).getTime() <= now()) return null;
    const site = (await db.query('SELECT * FROM sites WHERE id = $1', [s.site_id])).rows[0];
    if (!site || !site.support_access || site.status !== 'active') return null;
    return { session: s, site };
  }

  // Cookie -> { user, ctx } or null.
  async function resolve(req) {
    const support = await supportFromCookie(req);
    if (support) {
      const { session: s, site } = support;
      const access = s.mode === 'edit' ? users.FULL_ACCESS : users.VIEW_ACCESS;
      return {
        user: {
          id: null, name: `${s.admin_name} (support)`, support: { id: s.id, mode: s.mode, expiresAt: s.expires_at, reason: s.reason },
          roleName: 'Platform support', ...access, lines: [], mustChangePassword: false,
          sites: [{ id: site.id, name: site.name }],
        },
        ctx: await siteContext(site),
      };
    }

    const parts = String(readCookie(req, COOKIE) || '').split('.');
    if (parts[0] !== 'u' || parts.length !== 5) return null;
    const [, id, ver, exp, sig] = parts;
    if (!(Number(exp) > now()) || !safeEqual(sig, sign(parts.slice(0, 4).join('.')))) return null;
    const u = await users.getUserById(db, Number(id));
    if (!u || !u.active || String(u.session_version) !== ver) return null;

    const sites = await users.userSites(db, u.id);
    const base = {
      id: u.id, name: u.name, email: u.email, cell: u.cell, customerId: u.customer_id, support: null,
      mustChangePassword: u.must_change_password, sites: sites.map((s) => ({ id: s.id, name: s.name })),
    };
    if (!sites.length) return { user: { ...base, areas: {}, actions: {}, lines: [], roleName: null }, ctx: null };
    const wanted = Number(readCookie(req, SITE_COOKIE));
    const access = sites.find((s) => s.id === wanted) || sites[0];
    const siteRow = (await db.query('SELECT * FROM sites WHERE id = $1', [access.id])).rows[0];
    const ctx = await siteContext(siteRow);
    const role = await users.getRole(ctx.db, access.roleId);
    return {
      user: { ...base, roleName: role?.name || null, areas: role?.areas || {}, actions: role?.actions || {}, lines: access.lines },
      ctx,
    };
  }

  // Slows down password guessing: 10 failed attempts per address per 15 min.
  const failures = new Map(); // ip -> {count, until}
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

  const router = express.Router();
  router.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
    const ip = clientIp(req);
    const next = safeNext(req.body?.next);
    const back = (error) => res.redirect(303, `/login?error=${error}&next=` + encodeURIComponent(next));
    if (blocked(ip)) return back('locked');
    const u = await users.findUserForLogin(db, users.loginKey(req.body?.username));
    if (!u || !u.active || !(await users.verifyPassword(String(req.body?.password || ''), u.password_hash))) {
      fail(ip);
      return back('wrong');
    }
    failures.delete(ip);
    await users.recordLogin(db, u.id);
    // Logged in their first site's activity log.
    const first = (await users.userSites(db, u.id))[0];
    if (first) await users.logActivity(db.scoped(siteSchema(first.id)), u, 'Signed in');
    setUserCookie(res, u);
    res.clearCookie(SUPPORT_COOKIE, { path: '/' });
    res.redirect(303, u.must_change_password ? '/account?first=1&next=' + encodeURIComponent(next) : next);
  });
  router.post('/logout', async (req, res) => {
    const support = await supportFromCookie(req);
    if (support) await platform.endSupportSession(db, support.session.id);
    res.clearCookie(COOKIE, { path: '/' });
    res.clearCookie(SUPPORT_COOKIE, { path: '/' });
    res.redirect(303, '/login');
  });

  const noSitePage = (name) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/styles.css"><div class="wrap" style="margin-top:10vh;"><div class="card card-pad">
<h1>No site yet</h1><p>Hello ${String(name).replace(/[<>&"]/g, '')} — your login doesn't have access to a site yet. Ask your admin to give you access.</p>
<form method="post" action="/logout"><button type="submit" class="btn-ghost btn-small">Sign out</button></form></div></div>`;

  const guard = async (req, res, next) => {
    if (isPublic(req.path)) return next();
    const r = await resolve(req);
    if (!r) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Signed out — reload the page and log in again.' });
      return res.redirect(302, '/login?next=' + encodeURIComponent(req.originalUrl));
    }
    const u = r.user;
    req.user = u;

    if (u.mustChangePassword && !ACCOUNT_PATHS.has(req.path) && !isAsset(req.path)) {
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Choose your own password first.' });
      return res.redirect(302, '/account?first=1');
    }
    if (!r.ctx) {
      if (ACCOUNT_PATHS.has(req.path) || isAsset(req.path)) return next();
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Your login has no site access yet — ask your admin.' });
      return res.status(403).type('html').send(noSitePage(u.name));
    }
    // Support in view mode changes nothing (except ending the session).
    if (u.support?.mode === 'view' && !['GET', 'HEAD'].includes(req.method) && !['/api/support/end', '/logout'].includes(req.path)) {
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'This support session is view-only.' });
      return res.status(403).send('This support session is view-only.');
    }
    const area = PAGE_AREAS[req.path];
    if (area && (u.areas?.[area] || 'none') === 'none') return res.redirect(302, '/?denied=' + area);
    if (ADMIN_PAGES.has(req.path) && !u.actions?.manageUsers) return res.redirect(302, '/?denied=users');
    req.site = r.ctx.site;
    runInSite(r.ctx, next);
  };

  // The signed-in user's own details, password, site switch, and ending a
  // support session (mounted after the guard).
  const account = express.Router();
  account.get('/api/me', async (req, res) => {
    res.json({ ...req.user, site: req.site || null });
  });
  account.post('/api/me/password', express.json(), async (req, res) => {
    if (req.user.support) return res.status(400).json({ error: 'Support sessions have no password here.' });
    let u;
    try {
      u = await users.changePassword(db, req.user.id, { current: req.body?.current, next: req.body?.next },
        { skipCurrent: req.user.mustChangePassword });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not change the password.' });
    }
    // The change signed out every other device; keep this one signed in.
    setUserCookie(res, u);
    res.json({ ok: true });
  });
  account.post('/api/me/site', express.json(), async (req, res) => {
    const id = Number(req.body?.siteId);
    if (!req.user.sites.some((s) => s.id === id)) return res.status(403).json({ error: 'You don’t have access to that site.' });
    res.cookie(SITE_COOKIE, String(id), cookieOpts);
    res.json({ ok: true });
  });
  account.post('/api/support/end', async (req, res) => {
    if (req.user.support) await platform.endSupportSession(db, req.user.support.id);
    res.clearCookie(SUPPORT_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // For the admin console: the cookie that opens a site for support.
  const supportCookie = (sessionId, expiresAt) => {
    const body = `s.${sessionId}.${new Date(expiresAt).getTime()}`;
    return { name: SUPPORT_COOKIE, value: `${body}.${sign(body)}`, opts: { httpOnly: true, secure, sameSite: 'lax', path: '/', expires: new Date(expiresAt) } };
  };

  return { router, guard, account, supportCookie };
}
