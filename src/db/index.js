// Database adapter. Production uses real Postgres via `pg` (DATABASE_URL).
// Without DATABASE_URL — local dev on a laptop, and the test suite — it uses
// PGlite, which is Postgres compiled to WebAssembly: same SQL, no install.
//
// Both expose the same small surface:
//   db.query(sql, params) -> { rows }
//   db.tx(async (q) => ...) -> runs fn inside BEGIN/COMMIT, q has .query
//   db.scoped(schema) -> the same surface, with every statement run in that
//                        schema (search_path) — one schema per site
//   db.close()
//
// Platform tables (customers, sites, users, …) live in "public"; each site's
// production data lives in its own schema "site_<id>", so one customer's
// data can't reach another's even if a query forgets a filter.

const NUMERIC_OID = 1700;
const DATE_OID = 1082;

// numeric -> JS number (quantities here are small; the artifacts used plain
// numbers), date -> 'YYYY-MM-DD' string (avoids timezone shifts).
const parseNumeric = (v) => (v === null ? null : parseFloat(v));
const parseDate = (v) => v;

const SCHEMA_RE = /^site_\d+$/;
export const siteSchema = (siteId) => {
  const n = Number(siteId);
  if (!Number.isInteger(n) || n <= 0) throw new Error('Bad site id: ' + siteId);
  return 'site_' + n;
};
const checkSchema = (s) => {
  if (!SCHEMA_RE.test(s)) throw new Error('Bad schema name: ' + s);
  return s;
};

export async function openDb({ databaseUrl, pgliteDir } = {}) {
  if (databaseUrl) return openPg(databaseUrl);
  return openPglite(pgliteDir);
}

async function openPg(databaseUrl) {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(NUMERIC_OID, parseNumeric);
  pg.types.setTypeParser(DATE_OID, parseDate);
  const pool = new pg.Pool({ connectionString: databaseUrl });

  async function tx(fn, schema) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (schema) await client.query(`SET LOCAL search_path TO ${schema}`);
      const result = await fn({ query: (sql, params) => client.query(sql, params) });
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function scopedQuery(schema, sql, params) {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${schema}`);
      return await client.query(sql, params);
    } finally {
      await client.query('RESET search_path').catch(() => {});
      client.release();
    }
  }

  return {
    kind: 'postgres',
    query: (sql, params) => pool.query(sql, params),
    tx: (fn) => tx(fn),
    scoped(schema) {
      checkSchema(schema);
      return { kind: 'postgres', schema, query: (sql, params) => scopedQuery(schema, sql, params), tx: (fn) => tx(fn, schema) };
    },
    close: () => pool.end(),
  };
}

async function openPglite(dir) {
  const { PGlite } = await import('@electric-sql/pglite');
  const parsers = { [NUMERIC_OID]: parseNumeric, [DATE_OID]: parseDate };
  const db = dir ? new PGlite(dir, { parsers }) : new PGlite({ parsers });
  await db.waitReady;
  // PGlite's transaction() also serialises against other queries, which
  // gives the same isolation the counters need — and keeps a schema switch
  // from leaking into another request's query.
  // exec() runs multi-statement SQL (migrations) — PGlite's query() takes
  // one statement, unlike pg's simple query.
  const tx = (fn, schema) => db.transaction(async (t) => {
    if (schema) await t.query(`SET LOCAL search_path TO ${schema}`);
    return fn({ query: (sql, params) => t.query(sql, params), exec: (sql) => t.exec(sql) });
  });
  return {
    kind: 'pglite',
    query: (sql, params) => db.query(sql, params),
    tx: (fn) => tx(fn),
    scoped(schema) {
      checkSchema(schema);
      return { kind: 'pglite', schema, query: (sql, params) => tx((q) => q.query(sql, params), schema), tx: (fn) => tx(fn, schema) };
    },
    close: () => db.close(),
  };
}
