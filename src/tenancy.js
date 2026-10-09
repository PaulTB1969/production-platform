// The current site for this request (or sync run), via AsyncLocalStorage.
//
// The production code (services, routes) was written for one company and
// takes a `db` and an Unleashed client. It is given the stand-ins below,
// which forward every call to the current site's own schema and Unleashed
// account — so it needs no site filters, and a request can only ever touch
// the site it was opened for.

import { AsyncLocalStorage } from 'node:async_hooks';
import { UserError } from './services/rows.js';

const als = new AsyncLocalStorage();

// ctx = { site: {id, name, …}, db: scoped db, unleashed: client | null }
export const runInSite = (ctx, fn) => als.run(ctx, fn);
export const currentSite = () => als.getStore() || null;

function ctx() {
  const c = als.getStore();
  if (!c) throw new Error('No site selected for this request.');
  return c;
}

// Stand-in db: the current site's schema.
export const siteDb = {
  get kind() { return ctx().db.kind; },
  query: (sql, params) => ctx().db.query(sql, params),
  tx: (fn) => ctx().db.tx(fn),
};

// The current site's Unleashed client, or null when it has no working keys.
export const siteUnleashed = () => ctx().unleashed || null;

export function requireUnleashed() {
  const c = siteUnleashed();
  if (!c) throw new UserError('This site is not connected to Unleashed yet.', 503);
  return c;
}
