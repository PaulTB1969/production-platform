import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { apiRouter } from './routes/api.js';
import { createAuth } from './auth.js';
import { adminRouter } from './routes/admin.js';
import { masterKeyFrom } from './secrets.js';
import { createUnleashedClient } from './unleashed/client.js';
import { siteDb, siteUnleashed } from './tenancy.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// db = the platform database; each site's data is reached through its own
// schema (see tenancy.js). createClient(creds) makes an Unleashed client —
// tests pass a fake.
export function createApp({ db, config, createClient }) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  const masterKey = masterKeyFrom(config.masterKey);
  const clientFor = createClient || ((creds) => createUnleashedClient({ ...creds, clientType: config.unleashed?.clientType || 'production-platform' }));
  const secure = !!config.isProduction;
  const auth = createAuth({ db, masterKey, createClient: clientFor, secure });

  // Platform admin console — its own sign-in, ahead of the customer login.
  app.use('/admin', adminRouter({ db, masterKey, createClient: clientFor, secure, supportCookie: auth.supportCookie }));

  // Bodies are read before the sign-in guard: the guard puts the rest of the
  // request "inside" its site, and reading a body afterwards would lose that.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.text({ type: 'text/csv', limit: '2mb' }));

  app.use(auth.router);
  app.use(auth.guard);
  app.use(auth.account);

  // The production API, working on the current site's schema and Unleashed account.
  app.use('/api', apiRouter({ db: siteDb, platformDb: db, config, unleashed: siteUnleashed, masterKey }));
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
  return app;
}
