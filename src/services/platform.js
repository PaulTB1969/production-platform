// The platform side: admins, customers and their sites (Unleashed accounts),
// and "Test & import", which reads a site's company details, warehouses,
// product groups and product tracking flags from Unleashed.

import { UserError } from './rows.js';
import { encrypt, decrypt } from '../secrets.js';
import { hashPassword, verifyPassword, oneTimePassword, checkNewPassword } from './users.js';

export const TRACKING = ['batch', 'serial', 'both', 'none'];
const DEFAULT_BASE_URL = 'https://api.unleashedsoftware.com';

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s || null;
};

// ---------- admins ----------

export async function createAdmin(db, { name, email }) {
  if (!clean(name) || !clean(email)) throw new UserError('Name and email are required.');
  const password = oneTimePassword();
  try {
    const row = (await db.query(
      `INSERT INTO platform_admins (name, email, password_hash) VALUES ($1, lower($2), $3) RETURNING id, name, email`,
      [clean(name), clean(email), await hashPassword(password)])).rows[0];
    return { admin: row, password };
  } catch (err) {
    if (err.code === '23505') throw new UserError(`There is already an admin with ${email}.`, 409);
    throw err;
  }
}

export async function findAdminByEmail(db, email) {
  return (await db.query('SELECT * FROM platform_admins WHERE email = lower($1)', [String(email || '').trim()])).rows[0] || null;
}

export async function getAdmin(db, id) {
  return (await db.query('SELECT * FROM platform_admins WHERE id = $1', [id])).rows[0] || null;
}

export async function checkAdminPassword(db, email, password) {
  const a = await findAdminByEmail(db, email);
  if (!a || !a.active || !(await verifyPassword(password, a.password_hash))) return null;
  await db.query('UPDATE platform_admins SET last_login_at = now() WHERE id = $1', [a.id]);
  return a;
}

export async function changeAdminPassword(db, id, { current, next }, { skipCurrent = false } = {}) {
  const a = await getAdmin(db, id);
  if (!a) throw new UserError('Admin not found.', 404);
  if (!skipCurrent && !(await verifyPassword(current || '', a.password_hash))) throw new UserError('Your current password is not right.');
  checkNewPassword(next);
  if (await verifyPassword(next, a.password_hash)) throw new UserError('Choose a new password, different from the current one.');
  await db.query(`UPDATE platform_admins SET password_hash = $2, must_change_password = false,
    session_version = session_version + 1 WHERE id = $1`, [id, await hashPassword(next)]);
  return getAdmin(db, id);
}

export async function logPlatform(db, admin, action, { customerId = null, siteId = null, detail = {} } = {}) {
  await db.query(`INSERT INTO platform_activity (admin_id, admin_name, action, customer_id, site_id, detail)
    VALUES ($1, $2, $3, $4, $5, $6)`, [admin?.id ?? null, admin?.name || 'Unknown', action, customerId, siteId, JSON.stringify(detail)]);
}

export async function listPlatformActivity(db, { limit = 200 } = {}) {
  return (await db.query(`SELECT * FROM platform_activity ORDER BY at DESC, id DESC LIMIT $1`, [Math.min(Number(limit) || 200, 1000)])).rows
    .map((r) => ({ id: Number(r.id), at: r.at, adminName: r.admin_name, action: r.action, customerId: r.customer_id, siteId: r.site_id, detail: r.detail }));
}

// ---------- customers ----------

const CUSTOMER_FIELDS = {
  name: 'name', registrationNo: 'registration_no', vatNo: 'vat_no', contactName: 'contact_name',
  contactEmail: 'contact_email', contactPhone: 'contact_phone', address: 'address', notes: 'notes', status: 'status',
};

const customerRow = (r) => ({
  id: r.id, name: r.name, registrationNo: r.registration_no, vatNo: r.vat_no, contactName: r.contact_name,
  contactEmail: r.contact_email, contactPhone: r.contact_phone, address: r.address, notes: r.notes,
  status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
});

function cleanCustomer(body, { partial = false } = {}) {
  const out = {};
  for (const k of Object.keys(CUSTOMER_FIELDS)) if (k in (body || {})) out[k] = clean(body[k]);
  if ((!partial || 'name' in out) && !out.name) throw new UserError('Enter the customer’s name.');
  if (out.status && !['active', 'inactive'].includes(out.status)) throw new UserError('Status is active or inactive.');
  if (out.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.contactEmail)) throw new UserError(`"${out.contactEmail}" is not an email address.`);
  return out;
}

export async function listCustomers(db) {
  const customers = (await db.query('SELECT * FROM customers ORDER BY status, lower(name)')).rows.map(customerRow);
  const sites = await listSites(db);
  return customers.map((c) => ({ ...c, sites: sites.filter((s) => s.customerId === c.id) }));
}

export async function getCustomer(db, id) {
  const r = (await db.query('SELECT * FROM customers WHERE id = $1', [id])).rows[0];
  return r ? customerRow(r) : null;
}

export async function createCustomer(db, body) {
  const c = cleanCustomer(body);
  const keys = Object.keys(c);
  const r = (await db.query(
    `INSERT INTO customers (${keys.map((k) => CUSTOMER_FIELDS[k]).join(', ')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING *`,
    keys.map((k) => c[k]))).rows[0];
  return customerRow(r);
}

export async function updateCustomer(db, id, body) {
  const c = cleanCustomer(body, { partial: true });
  const keys = Object.keys(c);
  if (!keys.length) return getCustomer(db, id);
  const r = (await db.query(
    `UPDATE customers SET ${keys.map((k, i) => `${CUSTOMER_FIELDS[k]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...keys.map((k) => c[k])])).rows[0];
  if (!r) throw new UserError('Customer not found.', 404);
  return customerRow(r);
}

// ---------- sites ----------

// Never includes the API key — only whether one is stored.
export const siteRow = (r) => ({
  id: r.id, customerId: r.customer_id, name: r.name, apiId: r.api_id, hasApiKey: !!r.api_key_enc,
  apiBaseUrl: r.api_base_url, companyGuid: r.unleashed_company_guid, companyName: r.company_name,
  baseCurrency: r.base_currency, defaultTaxRate: r.default_tax_rate, warehouses: r.warehouses || [],
  productGroupCount: r.product_group_count, productCounts: r.product_counts,
  trackingDetected: r.tracking_detected, trackingOverride: r.tracking_override,
  tracking: r.tracking_override || r.tracking_detected || null,
  importedAt: r.imported_at, importError: r.import_error, timeZone: r.time_zone,
  supportAccess: r.support_access, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
});

export async function listSites(db, { customerId } = {}) {
  const rows = customerId
    ? (await db.query('SELECT * FROM sites WHERE customer_id = $1 ORDER BY lower(name)', [customerId])).rows
    : (await db.query('SELECT * FROM sites ORDER BY lower(name)')).rows;
  return rows.map(siteRow);
}

export async function getSite(db, id) {
  const r = (await db.query('SELECT * FROM sites WHERE id = $1', [id])).rows[0];
  return r ? siteRow(r) : null;
}

function checkBaseUrl(url) {
  const u = clean(url) || DEFAULT_BASE_URL;
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(u)) throw new UserError('The API address must be an https:// address, e.g. ' + DEFAULT_BASE_URL);
  return u.replace(/\/$/, '');
}

export async function createSite(db, body, { masterKey }) {
  const customer = await getCustomer(db, Number(body?.customerId));
  if (!customer) throw new UserError('Pick the customer first.');
  const name = clean(body?.name);
  const apiId = clean(body?.apiId);
  const apiKey = clean(body?.apiKey);
  if (!name) throw new UserError('Give the site a name, e.g. the company or factory.');
  if (!apiId || !apiKey) throw new UserError('Enter the Unleashed API ID and API key (Unleashed → Integration → Unleashed API Access).');
  const r = (await db.query(
    `INSERT INTO sites (customer_id, name, api_id, api_key_enc, api_base_url) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [customer.id, name, apiId, encrypt(apiKey, masterKey), checkBaseUrl(body?.apiBaseUrl)])).rows[0];
  return siteRow(r);
}

// Name, keys (blank = keep), base URL, tracking override, time zone, status.
export async function updateSite(db, id, body, { masterKey }) {
  const sets = [];
  const params = [id];
  const set = (col, v) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if ('name' in body) { if (!clean(body.name)) throw new UserError('The site needs a name.'); set('name', clean(body.name)); }
  if (clean(body.apiId)) set('api_id', clean(body.apiId));
  if (clean(body.apiKey)) set('api_key_enc', encrypt(clean(body.apiKey), masterKey));
  if ('apiBaseUrl' in body) set('api_base_url', checkBaseUrl(body.apiBaseUrl));
  if ('trackingOverride' in body) {
    const t = clean(body.trackingOverride);
    if (t && !TRACKING.includes(t)) throw new UserError('Tracking is batch, serial, both or none.');
    set('tracking_override', t);
  }
  if ('timeZone' in body) {
    const tz = clean(body.timeZone) || 'Africa/Johannesburg';
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { throw new UserError(`Unknown time zone "${tz}".`); }
    set('time_zone', tz);
  }
  if ('status' in body) {
    if (!['active', 'inactive'].includes(body.status)) throw new UserError('Status is active or inactive.');
    set('status', body.status);
  }
  if (!sets.length) return getSite(db, id);
  const r = (await db.query(`UPDATE sites SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params)).rows[0];
  if (!r) throw new UserError('Site not found.', 404);
  return siteRow(r);
}

// The decrypted connection details — for the server's own use only.
export async function siteCredentials(db, id, { masterKey }) {
  const r = (await db.query('SELECT api_id, api_key_enc, api_base_url FROM sites WHERE id = $1', [id])).rows[0];
  if (!r) throw new UserError('Site not found.', 404);
  return { apiId: r.api_id, apiKey: decrypt(r.api_key_enc, masterKey), baseUrl: r.api_base_url };
}

// ---------- import from Unleashed ----------

export function detectTracking({ batchTracked, serialized }) {
  if (batchTracked && serialized) return 'both';
  if (batchTracked) return 'batch';
  if (serialized) return 'serial';
  return 'none';
}

// Reads everything from Unleashed first and only then saves, so a failed
// import leaves the site as it was (with the error noted).
export async function testAndImport(db, id, { masterKey, createClient }) {
  const site = await getSite(db, id);
  if (!site) throw new UserError('Site not found.', 404);
  let summary;
  try {
    const client = createClient(await siteCredentials(db, id, { masterKey }));
    const company = (await client.get('Companies')).Items?.[0];
    if (!company?.Guid) throw new Error('Unleashed did not return the company details.');
    // Not paged in Unleashed (checked against a live account).
    const warehouses = (await client.get('Warehouses')).Items || [];
    const groups = (await client.get('ProductGroups')).Items || [];
    const products = await client.getAll('Products', {}, 200);
    const live = products.filter((p) => !p.Obsolete);
    const counts = {
      total: live.length,
      batchTracked: live.filter((p) => p.IsBatchTracked).length,
      serialized: live.filter((p) => p.IsSerialized).length,
    };
    summary = {
      companyGuid: company.Guid,
      companyName: company.CompanyName || null,
      baseCurrency: company.BaseCurrencyCode || null,
      defaultTaxRate: company.DefaultTaxRate ?? null,
      warehouses: warehouses.map((w) => ({
        code: w.WarehouseCode, name: w.WarehouseName || '', city: w.City || '', isDefault: !!w.IsDefault, obsolete: !!w.Obsolete,
      })),
      productGroupCount: groups.length,
      productCounts: counts,
      trackingDetected: detectTracking(counts),
    };
  } catch (err) {
    const message = err.status === 401 || err.status === 403
      ? 'Unleashed refused the API ID / key — check them in Unleashed → Integration → Unleashed API Access.'
      : err.message;
    await db.query('UPDATE sites SET import_error = $2, updated_at = now() WHERE id = $1', [id, message]);
    throw new UserError(message, 502);
  }

  const other = (await db.query('SELECT id, name FROM sites WHERE unleashed_company_guid = $1 AND id <> $2', [summary.companyGuid, id])).rows[0];
  if (other) {
    const message = `This Unleashed account is already set up as site "${other.name}".`;
    await db.query('UPDATE sites SET import_error = $2, updated_at = now() WHERE id = $1', [id, message]);
    throw new UserError(message, 409);
  }

  await db.query(
    `UPDATE sites SET unleashed_company_guid = $2, company_name = $3, base_currency = $4, default_tax_rate = $5,
       warehouses = $6, product_group_count = $7, product_counts = $8, tracking_detected = $9,
       imported_at = now(), import_error = NULL, updated_at = now() WHERE id = $1`,
    [id, summary.companyGuid, summary.companyName, summary.baseCurrency, summary.defaultTaxRate,
      JSON.stringify(summary.warehouses), summary.productGroupCount, JSON.stringify(summary.productCounts), summary.trackingDetected]);
  return getSite(db, id);
}
