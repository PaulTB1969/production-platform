// Sample Retention forms (Doc No 128): per production date, one UWH form and
// one LWH form (with an AcquaBox section). Rows are the products on the
// Production Schedule for that date and line, in run order.
//
// Filled in on screen, then signed by whoever took the samples (which locks
// the results), then signed off by management (which locks the form).

import { UserError } from './rows.js';
import { listEntries } from './schedule.js';
import { lineAllowed } from '../permissions.js';

export const FORMS = {
  UWH: { title: 'UWH Production Samples', sections: [{ line: 'PRD - UWH', heading: 'UWH - Sample' }] },
  LWH: {
    title: 'LWH Production Samples',
    sections: [{ line: 'PRD - LWH', heading: 'LWH - Samples' }, { line: 'PRD - AQB', heading: 'AcquaBox' }],
  },
};

const YN = ['Y', 'N', ''];
const MAX_SIGNATURE = 300_000; // characters of PNG data URL

export const formLines = (form) => FORMS[form].sections.map((s) => s.line);
export const formAllowed = (user, form) => !user?.lines?.length || formLines(form).some((l) => lineAllowed(user, l));

function checkForm(form) {
  if (!FORMS[form]) throw new UserError(`Unknown form "${form}" — use UWH or LWH.`, 404);
}

const COLS = `id, to_char(date, 'YYYY-MM-DD') AS date, form, results, taken_by_name, taken_by_user_id,
  taken_signature, to_char(taken_date, 'YYYY-MM-DD') AS taken_date, taken_at, signoff_name, signoff_user_id,
  signoff_signature, signoff_at, updated_at`;

async function loadRow(q, date, form) {
  return (await q.query(`SELECT ${COLS} FROM sample_forms WHERE date = $1 AND form = $2`, [date, form])).rows[0] || null;
}

async function ensureRow(q, date, form) {
  await q.query('INSERT INTO sample_forms (date, form) VALUES ($1, $2) ON CONFLICT (date, form) DO NOTHING', [date, form]);
  return loadRow(q, date, form);
}

// The form as shown and printed.
function buildForm(form, date, entries, descriptions, row) {
  const results = row?.results || {};
  const seen = new Set();
  const sections = FORMS[form].sections.map((s) => {
    const rows = [];
    for (const e of entries.filter((x) => x.line === s.line)) {
      if (seen.has(e.sku)) continue;
      seen.add(e.sku);
      rows.push({ sku: e.sku, description: descriptions.get(e.sku) || '', onSchedule: true, ...(results[e.sku] || {}) });
    }
    return { line: s.line, heading: s.heading, rows };
  });
  // Results for a product since taken off the schedule stay on the form.
  for (const [sku, r] of Object.entries(results)) {
    if (seen.has(sku)) continue;
    sections[0].rows.push({ sku, description: descriptions.get(sku) || '', onSchedule: false, ...r });
  }
  const status = row?.signoff_at ? 'signed_off' : row?.taken_at ? 'signed' : Object.keys(results).length ? 'started' : 'new';
  return {
    form, date, title: FORMS[form].title, sections, status,
    takenBy: row?.taken_at ? { name: row.taken_by_name, signature: row.taken_signature, date: row.taken_date, at: row.taken_at } : null,
    signOff: row?.signoff_at ? { name: row.signoff_name, signature: row.signoff_signature, at: row.signoff_at } : null,
  };
}

// Both forms for a date (only those the user's lines cover).
export async function sampleDay(db, date, user) {
  const entries = (await listEntries(db, { date })).sort((a, b) => (a.runOrder ?? 1e9) - (b.runOrder ?? 1e9) || (a.seq || 1) - (b.seq || 1));
  const skus = [...new Set(entries.map((e) => e.sku))];
  const rows = (await db.query(`SELECT ${COLS} FROM sample_forms WHERE date = $1`, [date])).rows;
  for (const r of rows) for (const sku of Object.keys(r.results || {})) skus.push(sku);
  const descriptions = new Map((await db.query('SELECT sku, description FROM recipes WHERE sku = ANY($1)', [skus])).rows
    .map((r) => [r.sku, r.description]));
  return Object.keys(FORMS)
    .filter((f) => formAllowed(user, f))
    .map((f) => buildForm(f, date, entries, descriptions, rows.find((r) => r.form === f)));
}

export async function getForm(db, date, form, user) {
  checkForm(form);
  return (await sampleDay(db, date, user)).find((f) => f.form === form) || null;
}

function cleanResult(body) {
  const test = String(body?.test ?? '').toUpperCase();
  const pass = String(body?.pass ?? '').toUpperCase();
  const time = String(body?.time ?? '').trim();
  if (!YN.includes(test) || !YN.includes(pass)) throw new UserError('Test and Pass are Y or N.');
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new UserError('Time must be HH:MM.');
  return { test, time, pass };
}

export async function setResult(db, date, form, sku, body) {
  checkForm(form);
  const value = cleanResult(body);
  if (!String(sku || '').trim()) throw new UserError('Product code is required.');
  return db.tx(async (q) => {
    const row = await ensureRow(q, date, form);
    if (row.signoff_at) throw new UserError('This form has been signed off — it can no longer be changed.', 409);
    if (row.taken_at) throw new UserError('This form has been signed — undo the signature to change it.', 409);
    const empty = !value.test && !value.time && !value.pass;
    if (empty) await q.query('UPDATE sample_forms SET results = results - $2::text, updated_at = now() WHERE id = $1', [row.id, sku]);
    else {
      await q.query('UPDATE sample_forms SET results = results || jsonb_build_object($2::text, $3::jsonb), updated_at = now() WHERE id = $1',
        [row.id, sku, JSON.stringify(value)]);
    }
    return value;
  });
}

function checkSignature(sig) {
  if (typeof sig !== 'string' || !sig.startsWith('data:image/png;base64,') || sig.length < 200) {
    throw new UserError('Sign in the box first.');
  }
  if (sig.length > MAX_SIGNATURE) throw new UserError('That signature is too large — clear it and sign again.');
}

// "Samples Taken By": every product needs Test; tested ones need Time and Pass.
export async function signTaken(db, date, form, { name, signature, signedDate }, user) {
  checkForm(form);
  if (!String(name || '').trim()) throw new UserError('Enter the name of whoever took the samples.');
  checkSignature(signature);
  const f = await getForm(db, date, form, user);
  const rows = f.sections.flatMap((s) => s.rows);
  if (!rows.length) throw new UserError(`There are no ${form} products on the Production Schedule for ${date}.`);
  const missing = rows.filter((r) => !r.test).map((r) => r.sku);
  if (missing.length) throw new UserError('Fill in Test (Y/N) for: ' + missing.join(', ') + '.');
  const incomplete = rows.filter((r) => r.test === 'Y' && (!r.time || !r.pass)).map((r) => r.sku);
  if (incomplete.length) throw new UserError('Fill in the Time and Pass (Y/N) for: ' + incomplete.join(', ') + '.');
  return db.tx(async (q) => {
    const row = await ensureRow(q, date, form);
    if (row.signoff_at) throw new UserError('This form has already been signed off.', 409);
    await q.query(
      `UPDATE sample_forms SET taken_by_name = $2, taken_by_user_id = $3, taken_signature = $4, taken_date = $5,
         taken_at = now(), updated_at = now() WHERE id = $1`,
      [row.id, name.trim(), user?.id ?? null, signature, signedDate || new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' })]);
  });
}

export async function undoTaken(db, date, form) {
  checkForm(form);
  const row = await loadRow(db, date, form);
  if (row?.signoff_at) throw new UserError('This form has been signed off — remove the sign-off first.', 409);
  await db.query(`UPDATE sample_forms SET taken_by_name = NULL, taken_by_user_id = NULL, taken_signature = NULL,
    taken_date = NULL, taken_at = NULL, updated_at = now() WHERE date = $1 AND form = $2`, [date, form]);
}

export async function signOff(db, date, form, { name, signature }, user) {
  checkForm(form);
  if (!String(name || '').trim()) throw new UserError('Enter your name.');
  checkSignature(signature);
  const row = await loadRow(db, date, form);
  if (!row?.taken_at) throw new UserError('The samples must be signed for (Samples Taken By) before management sign-off.', 409);
  if (row.signoff_at) throw new UserError('Already signed off.', 409);
  await db.query(`UPDATE sample_forms SET signoff_name = $2, signoff_user_id = $3, signoff_signature = $4,
    signoff_at = now(), updated_at = now() WHERE id = $1`, [row.id, name.trim(), user?.id ?? null, signature]);
}

export async function removeSignOff(db, date, form) {
  checkForm(form);
  await db.query(`UPDATE sample_forms SET signoff_name = NULL, signoff_user_id = NULL, signoff_signature = NULL,
    signoff_at = NULL, updated_at = now() WHERE date = $1 AND form = $2`, [date, form]);
}
