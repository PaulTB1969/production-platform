// Sign-in: a login page that sets a signed "stay signed in" cookie (90 days),
// so each phone, iPad or laptop logs in once.
//
// Two kinds of login:
//   - Individual users (Users & Roles page): sign in with email or cell
//     number. Cookie "u.<id>.<version>.<expiry>.<HMAC>"; the version is
//     bumped on a password change, reset or deactivation, which signs that
//     user out everywhere.
//   - The shared 'production' login (APP_USER / APP_PASSWORD), with full
//     access, until it is switched off on the Users page. Cookie
//     "<expiry>.<HMAC>". Scripts can send it as a Basic auth header.
//
// The HMAC key is derived from APP_PASSWORD, so changing it signs every
// device out. req.user is set for everything behind the guard.

import express from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as users from './services/users.js';

export const COOKIE = 'ph_session';
const MAX_AGE_MS = 90 * 24 * 3600 * 1000;

// Reachable without logging in: the login page and what it needs to render.
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

function readCookie(req, name) {
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

// The user record behind a session, as the routes see it.
export function sessionUser(u) {
  return {
    id: u.id, name: u.name, shared: false, email: u.email, cell: u.cell,
    roleName: u.role_name, areas: u.areas, actions: u.actions, lines: u.lines || [],
    mustChangePassword: u.must_change_password,
  };
}

const sharedUser = (name) => ({ id: null, name, shared: true, roleName: 'Shared login', ...users.FULL_ACCESS, lines: [], mustChangePassword: false });

export function createAuth({ user, password }, { db = null, secure = false, now = () => Date.now() } = {}) {
  // Local dev without APP_USER/APP_PASSWORD: open, with full access, unless
  // someone signs in as one of the users.
  const devOpen = !user || !password;
  const key = devOpen ? randomBytes(32) : createHmac('sha256', 'production-hub-session').update(password).digest();
  const sign = (s) => createHmac('sha256', key).update(String(s)).digest('base64url');
  const cookieOpts = { httpOnly: true, secure, sameSite: 'lax', maxAge: MAX_AGE_MS, path: '/' };

  const sharedOn = async () => !db || users.sharedLoginEnabled(db);

  const setUserCookie = (res, u) => {
    const body = `u.${u.id}.${u.session_version}.${now() + MAX_AGE_MS}`;
    res.cookie(COOKIE, `${body}.${sign(body)}`, cookieOpts);
  };
  const setSharedCookie = (res) => {
    const exp = now() + MAX_AGE_MS;
    res.cookie(COOKIE, `${exp}.${sign(exp)}`, cookieOpts);
  };

  // Cookie / Basic header -> user, or null.
  async function resolve(req) {
    const v = readCookie(req, COOKIE);
    if (v) {
      const parts = v.split('.');
      if (parts[0] === 'u' && parts.length === 5 && db) {
        const [, id, ver, exp, sig] = parts;
        if (Number(exp) > now() && safeEqual(sig, sign(parts.slice(0, 4).join('.')))) {
          const u = await users.getUserById(db, Number(id));
          if (u && u.active && String(u.session_version) === ver) return sessionUser(u);
        }
      } else if (parts.length === 2 && !devOpen) {
        const [exp, sig] = parts;
        if (Number(exp) > now() && safeEqual(sig, sign(exp)) && (await sharedOn())) return sharedUser('Production (shared login)');
      }
    }
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    if (!devOpen && scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i > -1 && safeEqual(decoded.slice(0, i), user) && safeEqual(decoded.slice(i + 1), password) && (await sharedOn())) {
        return sharedUser('Production (shared login)');
      }
    }
    if (devOpen) return sharedUser('Local dev');
    return null;
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
    const name = String(req.body?.username || '').trim();
    const pw = String(req.body?.password || '');

    // The shared login.
    if (!devOpen && safeEqual(name, user) && safeEqual(pw, password)) {
      if (!(await sharedOn())) return back('shared-off');
      failures.delete(ip);
      setSharedCookie(res);
      return res.redirect(303, next);
    }

    // An individual user.
    const u = db ? await users.findUserForLogin(db, users.loginKey(name)) : null;
    if (!u || !u.active || !(await users.verifyPassword(pw, u.password_hash))) {
      fail(ip);
      return back('wrong');
    }
    failures.delete(ip);
    await users.recordLogin(db, u.id);
    await users.logActivity(db, u, 'Signed in');
    setUserCookie(res, u);
    res.redirect(303, u.must_change_password ? '/account?first=1&next=' + encodeURIComponent(next) : next);
  });
  router.post('/logout', (req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.redirect(303, '/login');
  });

  const guard = async (req, res, next) => {
    if (isPublic(req.path)) return next();
    const u = await resolve(req);
    if (!u) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Signed out — reload the page and log in again.' });
      return res.redirect(302, '/login?next=' + encodeURIComponent(req.originalUrl));
    }
    req.user = u;

    if (u.mustChangePassword && !ACCOUNT_PATHS.has(req.path) && !isAsset(req.path)) {
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Choose your own password first.' });
      return res.redirect(302, '/account?first=1');
    }
    const area = PAGE_AREAS[req.path];
    if (area && (u.areas?.[area] || 'none') === 'none') return res.redirect(302, '/?denied=' + area);
    if (ADMIN_PAGES.has(req.path) && !u.actions?.manageUsers) return res.redirect(302, '/?denied=users');
    next();
  };

  // The signed-in user's own details and password (mounted after the guard).
  const account = express.Router();
  account.get('/api/me', async (req, res) => {
    res.json({ ...req.user, sharedLoginEnabled: await sharedOn() });
  });
  account.post('/api/me/password', express.json(), async (req, res) => {
    if (req.user.shared) return res.status(400).json({ error: 'The shared login’s password is set on the server, not here.' });
    try {
      await users.changePassword(db, req.user.id, { current: req.body?.current, next: req.body?.next },
        { skipCurrent: req.user.mustChangePassword });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not change the password.' });
    }
    await users.logActivity(db, req.user, req.user.mustChangePassword ? 'Set their own password' : 'Changed their password');
    // The change signed out every other device; keep this one signed in.
    setUserCookie(res, await users.getUserById(db, req.user.id));
    res.json({ ok: true });
  });

  return { router, guard, account };
}
