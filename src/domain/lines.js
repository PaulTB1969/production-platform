// Production lines. Stored everywhere as the exact Unleashed warehouse code,
// as the artifacts did. Raw materials are receipted into the bulk store
// (PRD) and moved to a line by a Stock Requisition.

export const BULK_STORE = 'PRD';

export const LINES = ['PRD - UWH', 'PRD - LWH', 'PRD - AQB'];

export const LINE_LABELS = {
  'PRD - UWH': 'PRD - UWH — Upper Warehouse',
  'PRD - LWH': 'PRD - LWH — Lower Warehouse',
  'PRD - AQB': 'PRD - AQB — AcquaBoxe',
  Other: 'Other',
};

// Schedule jobs may also sit on the catch-all 'Other'; requisitions never do.
export const SCHEDULE_LINES = [...LINES, 'Other'];

// 'PRD - UWH' -> 'UWH' — used in finished-goods batch numbers.
export function lineShortCode(line) {
  const s = String(line || 'Other');
  return s.startsWith('PRD - ') ? s.slice(6) : s;
}

// Assemblies (CSV and API) take their components from, and put the finished
// goods into, the bulk store for now — not the line warehouses. The line
// still shows in the finished-goods batch number ("20261007 UWH 1").
// To go back to the lines: return sourceWarehouseCode(line).
export function assemblySourceWarehouse(line) { // eslint-disable-line no-unused-vars
  return BULK_STORE;
}

// Unleashed warehouse code for a schedule line. Only 'Other' or a legacy
// value needs the prefix added.
export function sourceWarehouseCode(line) {
  if (LINES.includes(line)) return line;
  return 'PRD - ' + (line || 'Other');
}

// Accepts the short code, the full code, any casing/spacing, or the old 'AB'
// code for AcquaBoxe. Anything else returns null so the caller rejects it
// (e.g. a stock-collection file uploaded to the wrong page).
export function normalizeWarehouse(v) {
  const t = (v || '').trim();
  if (!t) return 'Other';
  const upper = t.toUpperCase().replace(/\s+/g, ' ');
  if (upper === 'OTHER') return 'Other';
  let short = upper.replace(/^PRD\s*-\s*/, '');
  if (short === 'AB') short = 'AQB';
  if (['UWH', 'LWH', 'AQB'].includes(short)) return 'PRD - ' + short;
  return null;
}

// 'req_20261001_uwh' — one requisition per line per date.
export function requisitionId(date, line) {
  return 'req_' + String(date).replace(/-/g, '') + '_' + lineShortCode(line).toLowerCase();
}
