// Applies migrations, once each, recording what ran in a schema_migrations
// table:
//   migrations/platform/*.sql  -> the "public" schema (customers, sites, users, …)
//   migrations/site/*.sql      -> each site's own schema "site_<id>"
// Runs automatically on server start (platform + every site) and when a
// site is added; can also be run on its own with `npm run migrate`.

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { siteSchema } from './index.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

async function files(kind) {
  return (await readdir(path.join(DIR, kind))).filter((f) => f.endsWith('.sql')).sort();
}

async function apply(q, kind, file) {
  const sql = await readFile(path.join(DIR, kind, file), 'utf8');
  // pg accepts multi-statement text in a simple query; PGlite needs exec().
  if (q.exec) await q.exec(sql);
  else await q.query(sql);
  await q.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
}

const TRACKING_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;

export async function migratePlatform(db, { log = () => {} } = {}) {
  await db.query(TRACKING_TABLE);
  const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const file of await files('platform')) {
    if (done.has(file)) continue;
    await db.tx((q) => apply(q, 'platform', file));
    log(`applied platform migration ${file}`);
  }
}

// Creates the site's schema if needed and brings it up to date.
export async function migrateSite(db, siteId, { log = () => {} } = {}) {
  const schema = siteSchema(siteId);
  await db.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  const scoped = db.scoped(schema);
  await scoped.query(TRACKING_TABLE);
  const done = new Set((await scoped.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const file of await files('site')) {
    if (done.has(file)) continue;
    await scoped.tx((q) => apply(q, 'site', file));
    log(`applied ${schema} migration ${file}`);
  }
  return scoped;
}

// Platform, then every site.
export async function migrate(db, opts = {}) {
  await migratePlatform(db, opts);
  for (const { id } of (await db.query('SELECT id FROM sites ORDER BY id')).rows) await migrateSite(db, id, opts);
}

// `npm run migrate`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { loadConfig } = await import('../config.js');
  const { openDb } = await import('./index.js');
  const db = await openDb(loadConfig());
  await migrate(db, { log: console.log });
  await db.close();
}
