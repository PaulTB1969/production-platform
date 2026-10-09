import { mkdir } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { createApp } from './app.js';
import { createUnleashedClient } from './unleashed/client.js';
import { syncFromUnleashed } from './unleashed/sync.js';

const config = loadConfig();
if (!config.databaseUrl) await mkdir(config.pgliteDir, { recursive: true });
const db = await openDb(config);
await migrate(db, { log: console.log });

const unleashed = createUnleashedClient(config.unleashed);
if (!unleashed) console.log('Unleashed API not configured — sync disabled.');

const app = createApp({ db, config, unleashed });
// Express 5 passes listen errors (e.g. port already in use) to the callback.
const server = app.listen(config.port, (err) => {
  if (err) {
    console.error(`Could not start on port ${config.port}: ${err.message}`);
    process.exit(1);
  }
  console.log(`Production Hub listening on http://localhost:${config.port} (${db.kind})`);
});

// Scheduled Unleashed sync — replaces "ask Claude to refresh".
let timer = null;
if (unleashed && config.unleashed.syncIntervalMinutes > 0) {
  const run = () => syncFromUnleashed(db, unleashed, { log: console.log }).catch(() => {});
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
