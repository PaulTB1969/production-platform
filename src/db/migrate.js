// Applies src/db/migrations/*.sql in filename order, once each, recording
// what ran in schema_migrations. Runs automatically on server start; can
// also be run on its own with `npm run migrate`.

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(db, { log = () => {} } = {}) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    await db.tx(async (q) => {
      // pg accepts multi-statement text in a simple query; PGlite needs exec().
      if (q.exec) await q.exec(sql);
      else await q.query(sql);
      await q.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    log(`applied migration ${file}`);
  }
}

// `npm run migrate`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { loadConfig } = await import('../config.js');
  const { openDb } = await import('./index.js');
  const db = await openDb(loadConfig());
  await migrate(db, { log: console.log });
  await db.close();
}
