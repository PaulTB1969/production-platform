import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { apiRouter } from './routes/api.js';
import { createAuth } from './auth.js';
import { adminRouter } from './routes/admin.js';
import { masterKeyFrom } from './secrets.js';
import { createUnleashedClient } from './unleashed/client.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp({ db, config, unleashed, createClient }) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Platform admin console — its own sign-in, ahead of the customer login.
  const masterKey = masterKeyFrom(config.masterKey);
  const clientFor = createClient || ((creds) => createUnleashedClient({ ...creds, clientType: config.unleashed?.clientType || 'production-platform' }));
  app.use('/admin', adminRouter({ db, masterKey, createClient: clientFor, secure: !!config.isProduction }));

  // Login page + signed cookie (shared login or individual users); Secure cookies in production (HTTPS via Caddy).
  const auth = createAuth(config.auth, { db, secure: !!config.isProduction });
  app.use(auth.router);
  app.use(auth.guard);
  app.use(auth.account);

  app.use('/api', apiRouter({ db, config, unleashed }));
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
  return app;
}
