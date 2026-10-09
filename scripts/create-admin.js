// Creates a platform admin and prints a one-time password (they choose
// their own at first sign-in to /admin).
//   npm run admin:create -- "Paul Beatham" paul@example.com
// On the server: docker compose exec app node scripts/create-admin.js "Name" email

import { mkdir } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { createAdmin } from '../src/services/platform.js';

const [name, email] = process.argv.slice(2);
if (!name || !email) {
  console.error('Usage: npm run admin:create -- "Full Name" email@example.com');
  process.exit(1);
}
const config = loadConfig();
if (!config.databaseUrl) await mkdir(config.pgliteDir, { recursive: true });
const db = await openDb(config);
await migrate(db);
try {
  const { admin, password } = await createAdmin(db, { name, email });
  console.log(`Admin created: ${admin.name} <${admin.email}>`);
  console.log(`One-time password: ${password}`);
  console.log('Sign in at /admin and choose your own password.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
