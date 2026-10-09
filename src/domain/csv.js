// CSV helpers shared by the Unleashed exports and the schedule upload.
// Ported unchanged from the artifacts.

export function csvField(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Wraps a value as an Excel "text formula" so a batch number that looks like
// a date (e.g. "20260916 UWH 1") is never reinterpreted as one if someone
// opens the CSV in Excel before uploading it — this has corrupted real batch
// numbers before. Already CSV-safe; don't also run it through csvField.
export function csvTextGuard(s) {
  return '="' + String(s).replace(/"/g, '""') + '"';
}

// Rows are arrays of already-encoded cells. CRLF line endings, as Unleashed
// and Excel expect.
export function csvDocument(headers, rows) {
  return [headers.map(csvField).join(','), ...rows.map((r) => r.join(','))].join('\r\n') + '\r\n';
}

// Minimal RFC4180-ish parser: quoted fields, embedded commas, doubled-quote
// escapes, CRLF/LF — these files usually come out of Excel.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; continue; }
        inQuotes = false;
        continue;
      }
      field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { pushField(); continue; }
    if (c === '\r') continue;
    if (c === '\n') { pushRow(); continue; }
    field += c;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

// YYYY-MM-DD or YYYY/MM/DD (Excel's CSV default) -> YYYY-MM-DD, with a real
// calendar check (2026-02-30 is rejected). Day-first formats return null on
// purpose: they look valid but silently swap day and month.
export function parseFlexibleDate(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function addDaysISO(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const pad8 = (n) => String(n).padStart(8, '0');
