// Database adapter. Production uses real Postgres via `pg` (DATABASE_URL).
// Without DATABASE_URL — local dev on a laptop, and the test suite — it uses
// PGlite, which is Postgres compiled to WebAssembly: same SQL, no install.
//
// Both expose the same small surface:
//   db.query(sql, params) -> { rows }
//   db.tx(async (q) => ...) -> runs fn inside BEGIN/COMMIT, q has .query
//   db.close()

const NUMERIC_OID = 1700;
const DATE_OID = 1082;

// numeric -> JS number (quantities here are small; the artifacts used plain
// numbers), date -> 'YYYY-MM-DD' string (avoids timezone shifts).
const parseNumeric = (v) => (v === null ? null : parseFloat(v));
const parseDate = (v) => v;

export async function openDb({ databaseUrl, pgliteDir } = {}) {
  if (databaseUrl) return openPg(databaseUrl);
  return openPglite(pgliteDir);
}

async function openPg(databaseUrl) {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(NUMERIC_OID, parseNumeric);
  pg.types.setTypeParser(DATE_OID, parseDate);
  const pool = new pg.Pool({ connectionString: databaseUrl });
  return {
    kind: 'postgres',
    query: (sql, params) => pool.query(sql, params),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (sql, params) => client.query(sql, params) });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function openPglite(dir) {
  const { PGlite } = await import('@electric-sql/pglite');
  const parsers = { [NUMERIC_OID]: parseNumeric, [DATE_OID]: parseDate };
  const db = dir ? new PGlite(dir, { parsers }) : new PGlite({ parsers });
  await db.waitReady;
  return {
    kind: 'pglite',
    query: (sql, params) => db.query(sql, params),
    // PGlite's transaction() also serialises against other queries, which
    // gives the same isolation the counters need.
    // exec() runs multi-statement SQL (migrations) — PGlite's query() takes
    // one statement, unlike pg's simple query.
    tx: (fn) => db.transaction((t) => fn({
      query: (sql, params) => t.query(sql, params),
      exec: (sql) => t.exec(sql),
    })),
    close: () => db.close(),
  };
}
