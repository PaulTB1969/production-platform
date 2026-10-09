// `npm run unleashed:probe` — fetches one small page from each resource the
// sync uses and prints the first item, so the field mapping in sync.js can
// be checked against Mountain Falls' real data. Read-only; prints no secrets.

import { loadConfig } from '../config.js';
import { createUnleashedClient } from './client.js';

const client = createUnleashedClient(loadConfig().unleashed);
if (!client) {
  console.error('Set UNLEASHED_API_ID and UNLEASHED_API_KEY in .env first.');
  process.exit(1);
}
for (const resource of ['BillOfMaterials', 'BatchNumbers', 'Warehouses']) {
  try {
    const data = await client.get(`${resource}/1`, { pageSize: 2 });
    console.log(`\n=== ${resource} (${data.Pagination?.NumberOfItems ?? '?'} items) ===`);
    console.log(JSON.stringify(data.Items?.[0] ?? data, null, 2));
  } catch (err) {
    console.log(`\n=== ${resource} === ERROR: ${err.message}`);
  }
}
