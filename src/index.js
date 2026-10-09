import { mkdir } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { createApp } from './app.js';
import { createUnleashedClient } from './unleashed/client.js';
import { syncAllSites } from './unleashed/syncAll.js';
import { masterKeyFrom } from './secrets.js';

const config = loadConfig();
if (!config.databaseUrl) await mkdir(config.pgliteDir, { recursive: true });
const db = await openDb(config);
// The platform tables, then every site's own schema.
await migrate(db, { log: console.log });

const masterKey = masterKeyFrom(config.masterKey);
const createClient = (creds) => createUnleashedClient({ ...creds, clientType: config.unleashed.clientType });

const app = createApp({ db, config, createClient });
// Express 5 passes listen errors (e.g. port already in use) to the callback.
const server = app.listen(config.port, (err) => {
  if (err) {
    console.error(`Could not start on port ${config.port}: ${err.message}`);
    process.exit(1);
  }
  console.log(`Production Platform listening on http://localhost:${config.port} (${db.kind})`);
});

// Scheduled Unleashed sync for every imported site.
let timer = null;
if (config.unleashed.syncIntervalMinutes > 0) {
  const run = () => syncAllSites(db, { masterKey, createClient, log: console.log }).catch((err) => console.error('sync:', err.message));
  run();
  timer = setInterval(run, config.unleashed.syncIntervalMinutes * 60_000);
}

async function shutdown() {
  clearInterval(timer);
  server.close();
  await db.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
