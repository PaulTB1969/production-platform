// The scheduled Unleashed sync, for every active site that has been
// imported: one after the other, each inside its own site (its schema and
// its own Unleashed account), so one customer's problem can't stop or
// affect another's.

import { siteSchema } from '../db/index.js';
import { siteCredentials } from '../services/platform.js';
import { runInSite, siteDb } from '../tenancy.js';
import { syncFromUnleashed } from './sync.js';

export async function syncAllSites(db, { masterKey, createClient, log = () => {} }) {
  const sites = (await db.query(
    `SELECT id, name FROM sites WHERE status = 'active' AND imported_at IS NOT NULL ORDER BY id`)).rows;
  const results = [];
  for (const site of sites) {
    try {
      const client = createClient(await siteCredentials(db, site.id, { masterKey }));
      const ctx = { site: { id: site.id, name: site.name }, db: db.scoped(siteSchema(site.id)), unleashed: client };
      const r = await runInSite(ctx, () => syncFromUnleashed(siteDb, client, { log: (m) => log(`[${site.name}] ${m}`) }));
      results.push({ siteId: site.id, ok: true, message: r.message });
    } catch (err) {
      results.push({ siteId: site.id, ok: false, message: err.message });
    }
  }
  return results;
}
