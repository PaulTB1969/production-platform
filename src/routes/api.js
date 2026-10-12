import express from 'express';
import { UserError } from '../services/rows.js';
import * as schedule from '../services/schedule.js';
import * as reqs from '../services/requisitions.js';
import * as stock from '../services/stock.js';
import * as exportsSvc from '../services/exports.js';
import { parseScheduleCsv, SCHEDULE_TEMPLATE_CSV } from '../domain/schedule.js';
import { parseFlexibleDate } from '../domain/csv.js';
import { syncFromUnleashed, getSyncStatus, mapBatchNumbers } from '../unleashed/sync.js';
import { buildWorkbook } from '../services/workbook.js';
import { buildPickList } from '../services/picklist.js';
import { sendTransfersForDate, sendAssembliesForDate, sendTruck, sendArrival } from '../services/unleashedSend.js';
import * as coll from '../services/collections.js';
import { parseCollectionCsv, COLLECTION_TEMPLATE_CSV } from '../domain/collections.js';
import * as users from '../services/users.js';
import * as platform from '../services/platform.js';
import { currentSite } from '../tenancy.js';
import * as samples from '../services/samples.js';
import { lineSheets } from '../services/linesheets.js';
import { LINES, BULK_STORE } from '../domain/lines.js';
import { requiredFor, denialFor, lineAllowed, activityLabel, activityDetail } from '../permissions.js';

const requireDate = (v) => {
  const d = parseFlexibleDate(String(v || ''));
  if (!d) throw new UserError('Pick a date (YYYY-MM-DD) first.');
  return d;
};

const sendCsv = (res, { filename, csv }) =>
  res.type('text/csv').attachment(filename).send(csv);

// db = the current site's database (tenancy.js siteDb); platformDb = the
// platform's own tables (users, sites); unleashed() = the current site's
// Unleashed client, or null.
export function apiRouter({ db, platformDb, config, unleashed }) {
  const r = express.Router();
  r.use(express.json({ limit: '1mb' }));
  r.use(express.text({ type: 'text/csv', limit: '2mb' }));

  // Who may do what (see permissions.js). req.user is set by the sign-in guard.
  r.use((req, res, next) => {
    const why = denialFor(req.user, requiredFor(req.method, req.path));
    if (why) return res.status(403).json({ error: why });
    next();
  });

  // Every successful change goes in the activity log, with who did it.
  r.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    // 'finish' fires outside the request's site context: keep the site's db.
    const sdb = currentSite().db;
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      users.logActivity(sdb, req.user, activityLabel(req.method, req.path), activityDetail(req.path, req.body))
        .catch((err) => console.error('activity log:', err.message));
    });
    next();
  });

  // Users linked to production lines only see and change those lines.
  const mine = (req, rows) => rows.filter((x) => lineAllowed(req.user, x.line));
  const checkLine = (req, line) => {
    if (line && !lineAllowed(req.user, line)) throw new UserError(`You are not linked to ${line} — ask an admin if you need it.`, 403);
  };
  const checkRowLine = async (req, table, id) => {
    if (!req.user?.lines?.length) return;
    const row = (await db.query(`SELECT line FROM ${table} WHERE id = $1`, [id])).rows[0];
    if (row) checkLine(req, row.line);
  };
  const sentBy = (req) => ({ sentBy: req.user?.name || null });

  // ---------- reference data ----------
  r.get('/recipes', async (req, res) => res.json(await stock.listRecipes(db)));
  r.get('/stock/bulk', async (req, res) => res.json(await stock.listComponentBatches(db)));
  // One product's PRD batches straight from Unleashed (a few seconds) — so
  // stock receipted or assembled since the hourly sync shows up at once.
  r.get('/stock/live-batches', async (req, res) => {
    const sku = String(req.query.sku || '').trim();
    if (!sku) throw new UserError('Which product?');
    const client = unleashed();
    if (!client) throw new UserError('This site is not connected to Unleashed yet.', 503);
    const items = await client.getAll('BatchNumbers', { productCode: sku, warehouseCode: BULK_STORE }, 200);
    const batches = mapBatchNumbers(items).filter((b) => b.componentSku === sku);
    res.json({ sku, checkedAt: new Date().toISOString(), batches: await stock.replaceBatchesForSku(db, sku, batches) });
  });
  r.get('/stock/lines', async (req, res) => res.json(await stock.listLineBatches(db)));
  r.get('/stock/balances', async (req, res) => res.json(await stock.listBalances(db)));
  r.get('/stock/materials', async (req, res) => res.json(await stock.listMaterials(db)));
  r.post('/stock/adjustments', async (req, res) => {
    const { line, sku, batchNumber, description, qty, reason } = req.body || {};
    if (!line || !sku || !Number.isFinite(Number(qty)) || !reason) throw new UserError('line, sku, qty and reason are required.');
    await stock.addAdjustment(db, { line, sku, batchNumber, description, qty: Number(qty), reason });
    res.status(201).json({ ok: true });
  });

  // ---------- schedule ----------
  r.get('/schedule', async (req, res) => res.json(mine(req, await schedule.listEntries(db, { date: req.query.date, line: req.query.line }))));
  r.post('/schedule', async (req, res) => {
    checkLine(req, req.body?.line);
    res.status(201).json(await schedule.createEntry(db, req.body || {}));
  });
  r.patch('/schedule/:id', async (req, res) => {
    await checkRowLine(req, 'schedule_entries', req.params.id);
    checkLine(req, req.body?.line);
    res.json(await schedule.updateEntry(db, req.params.id, req.body || {}));
  });
  r.post('/schedule/reorder', async (req, res) => {
    for (const id of Array.isArray(req.body?.ids) ? req.body.ids : []) await checkRowLine(req, 'schedule_entries', id);
    res.json(await schedule.reorderEntries(db, req.body?.date, req.body?.ids));
  });
  r.post('/schedule/:id/split', async (req, res) => {
    await checkRowLine(req, 'schedule_entries', req.params.id);
    res.status(201).json(await schedule.splitEntry(db, req.params.id, req.body?.moveQty));
  });
  r.delete('/schedule/:id', async (req, res) => {
    await checkRowLine(req, 'schedule_entries', req.params.id);
    await schedule.deleteEntry(db, req.params.id);
    res.status(204).end();
  });
  // Printable line sheets (the paper forms), blank or filled in.
  r.get('/schedule/linesheets', async (req, res) =>
    res.json(await lineSheets(db, requireDate(req.query.date), { lineFilter: (line) => lineAllowed(req.user, line) })));
  r.get('/schedule/template.csv', (req, res) => sendCsv(res, { filename: 'batch-sheet-schedule-template.csv', csv: SCHEDULE_TEMPLATE_CSV }));
  r.post('/schedule/upload', async (req, res) => {
    const parsed = parseScheduleCsv(typeof req.body === 'string' ? req.body : '');
    if (parsed.errors.length) throw new UserError('Upload cancelled — fix these rows and try again: ' + parsed.errors.join(' '));
    for (const row of parsed.rows) checkLine(req, row.line);
    res.json(await schedule.applyScheduleRows(db, parsed.rows));
  });

  // ---------- requisitions ----------
  // Pick list for checking against the floor before the app is updated.
  r.get('/requisitions/picklist.xlsx', async (req, res) => {
    const date = requireDate(req.query.date);
    let line = req.query.line || undefined;
    if (!line && req.user?.lines?.length === 1) line = req.user.lines[0];
    if (!line && req.user?.lines?.length) throw new UserError('Pick your line first.');
    checkLine(req, line);
    // ?group= limits it to one Unleashed product group ('' = materials with none).
    const group = req.query.group === undefined ? undefined : String(req.query.group);
    const out = await buildPickList(db, { date, line, group });
    if (!out) {
      throw new UserError(group !== undefined
        ? `No raw materials in product group "${group || 'none'}" on the requisitions for ${date}${line ? ' on ' + line : ''}.`
        : `No requisitions for ${date}${line ? ' on ' + line : ''} — generate them first.`, 404);
    }
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment(out.filename).send(out.buffer);
  });
  r.get('/requisitions', async (req, res) => res.json(mine(req, await reqs.listRequisitions(db, { date: req.query.date, line: req.query.line }))));
  r.post('/requisitions', async (req, res) => {
    checkLine(req, req.body?.line);
    res.status(201).json(await reqs.createRequisition(db, { date: requireDate(req.body?.date), line: req.body?.line }));
  });
  r.post('/requisitions/generate', async (req, res) => res.json(await reqs.generateRequisitions(db, requireDate(req.body?.date))));
  r.patch('/requisitions/:id', async (req, res) => {
    await checkRowLine(req, 'requisitions', req.params.id);
    res.json(await reqs.updateRequisition(db, req.params.id, req.body || {}));
  });
  r.delete('/requisitions/:id', async (req, res) => {
    await checkRowLine(req, 'requisitions', req.params.id);
    await reqs.deleteRequisition(db, req.params.id);
    res.status(204).end();
  });

  // ---------- stock collections ----------
  const todaySA = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
  r.get('/collections/day', async (req, res) => res.json(await coll.collectionDay(db, requireDate(req.query.date))));
  r.get('/collections/stock', async (req, res) => res.json(await coll.finishedGoodsStock(db, req.query.date || null)));
  r.get('/collections/arrivals', async (req, res) => res.json((await coll.pendingArrivals(db)).map((p) => ({
    collectionId: p.collection.id, date: p.collection.date, destination: p.collection.destination, label: p.collection.label,
    trucks: p.trucks, items: p.items, unconfirmed: !!p.unconfirmed,
  }))));
  r.get('/collections/template.csv', (req, res) => sendCsv(res, { filename: 'stock-collection-template.csv', csv: COLLECTION_TEMPLATE_CSV }));
  r.post('/collections/upload', async (req, res) => {
    const parsed = parseCollectionCsv(typeof req.body === 'string' ? req.body : '');
    if (parsed.errors.length) throw new UserError('Upload cancelled — fix these rows and try again: ' + parsed.errors.join(' '));
    res.json(await coll.uploadList(db, parsed.groups));
  });
  r.post('/collections/list', async (req, res) => res.status(201).json(await coll.addToList(db, { ...(req.body || {}), date: requireDate(req.body?.date) })));
  r.patch('/collections/:id', async (req, res) => res.json(await coll.updateCollection(db, req.params.id, req.body || {})));
  r.delete('/collections/:id', async (req, res) => { await coll.deleteCollection(db, req.params.id); res.status(204).end(); });
  r.patch('/collections/lines/:lineId', async (req, res) => res.json(await coll.updateLine(db, Number(req.params.lineId), req.body || {})));
  r.delete('/collections/lines/:lineId', async (req, res) => res.json(await coll.deleteLine(db, Number(req.params.lineId))));
  // Truck sheets: Qty Trf + Batch per line, Loaded, Approve (send or CSV).
  r.put('/collections/lines/:lineId/loads/:truck', async (req, res) =>
    res.json(await coll.setLoad(db, Number(req.params.lineId), req.params.truck, req.body || {})));
  r.post('/collections/sheets/:truck/loaded', async (req, res) =>
    res.json(await coll.setLoaded(db, requireDate(req.body?.date), req.params.truck, req.body?.loaded !== false)));
  r.post('/collections/sheets/:truck/send', async (req, res) =>
    res.json({ results: await sendTruck(db, unleashed(), requireDate(req.body?.date), req.params.truck, sentBy(req)) }));
  r.post('/collections/sheets/:truck/csv', async (req, res) => {
    const e = await coll.approveTruckCsv(db, requireDate(req.body?.date), req.params.truck);
    if (!e) return res.json({ approved: true }); // only interim stock on it: nothing to transfer
    res.status(201).json({ ...e, url: `/api/exports/${e.id}` });
  });
  // Vehicles: trucks can be added, renamed and switched off; Interim is built in.
  r.get('/collections/vehicles', async (req, res) => res.json(await coll.listVehicles(db)));
  r.post('/collections/vehicles', async (req, res) => res.status(201).json(await coll.createVehicle(db, req.body || {})));
  r.patch('/collections/vehicles/:code', async (req, res) => res.json(await coll.updateVehicle(db, req.params.code, req.body || {})));
  // Which truck physically carries a line's interim stock.
  r.put('/collections/lines/:lineId/carried-by', async (req, res) =>
    res.json(await coll.setCarriedBy(db, Number(req.params.lineId), req.body?.truck || null)));
  r.post('/collections/sheets/:truck/undo-csv', async (req, res) => res.json(await coll.undoTruckCsv(db, requireDate(req.body?.date), req.params.truck)));
  // Second leg, per destination.
  r.post('/collections/:id/arrival/send', async (req, res) => res.json(await sendArrival(db, unleashed(), req.params.id, sentBy(req))));
  r.post('/collections/:id/arrival/csv', async (req, res) => {
    const e = await coll.arrivalCsv(db, req.params.id, todaySA());
    res.status(201).json({ ...e, url: `/api/exports/${e.id}` });
  });

  // ---------- sample retention forms ----------
  const formFor = (req) => {
    const form = String(req.params.form || '').toUpperCase();
    if (samples.FORMS[form] && !samples.formAllowed(req.user, form)) throw new UserError(`You are not linked to the ${form} lines.`, 403);
    return form;
  };
  r.get('/samples/day', async (req, res) => res.json(await samples.sampleDay(db, requireDate(req.query.date), req.user)));
  r.put('/samples/:date/:form/results/:sku', async (req, res) =>
    res.json(await samples.setResult(db, requireDate(req.params.date), formFor(req), req.params.sku, req.body || {})));
  r.post('/samples/:date/:form/sign', async (req, res) => {
    const date = requireDate(req.params.date), form = formFor(req);
    await samples.signTaken(db, date, form, req.body || {}, req.user);
    res.json(await samples.getForm(db, date, form, req.user));
  });
  r.delete('/samples/:date/:form/sign', async (req, res) => {
    const date = requireDate(req.params.date), form = formFor(req);
    await samples.undoTaken(db, date, form);
    res.json(await samples.getForm(db, date, form, req.user));
  });
  r.post('/samples/:date/:form/signoff', async (req, res) => {
    const date = requireDate(req.params.date), form = formFor(req);
    await samples.signOff(db, date, form, req.body || {}, req.user);
    res.json(await samples.getForm(db, date, form, req.user));
  });
  r.delete('/samples/:date/:form/signoff', async (req, res) => {
    const date = requireDate(req.params.date), form = formFor(req);
    await samples.removeSignOff(db, date, form);
    res.json(await samples.getForm(db, date, form, req.user));
  });

  // ---------- exports ----------
  // POST creates the export (numbers + exported flags) and returns its id;
  // the browser then downloads GET /exports/:id, which can be repeated.
  const exportMeta = ({ id, kind, date, filename }) => ({ id, kind, date, filename, url: `/api/exports/${id}` });
  r.post('/exports/assemblies', async (req, res) =>
    res.status(201).json(exportMeta(await exportsSvc.exportAssemblies(db, requireDate(req.body?.date), config))));
  r.post('/exports/wastage', async (req, res) =>
    res.status(201).json(exportMeta(await exportsSvc.exportWastage(db, requireDate(req.body?.date), config))));
  r.post('/exports/transfers', async (req, res) =>
    res.status(201).json(exportMeta(await exportsSvc.exportTransfers(db, requireDate(req.body?.date)))));
  r.get('/exports', async (req, res) => res.json(await exportsSvc.listExports(db, { date: req.query.date })));
  r.get('/exports/:id', async (req, res) => {
    const exp = await exportsSvc.getExport(db, Number(req.params.id));
    if (!exp) throw new UserError('Export not found.', 404);
    sendCsv(res, exp);
  });

  // Excel copy of a date range (defaults: the last 30 days to 30 days ahead).
  r.get('/workbook.xlsx', async (req, res) => {
    const shift = (days) => new Date(Date.now() + days * 86400e3).toISOString().slice(0, 10);
    const from = req.query.from ? requireDate(req.query.from) : shift(-30);
    const to = req.query.to ? requireDate(req.query.to) : shift(30);
    if (from > to) throw new UserError('The start date must be before the end date.');
    const { filename, buffer } = await buildWorkbook(db, { from, to });
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment(filename).send(buffer);
  });

  // ---------- Unleashed ----------
  // Send straight to Unleashed (Parked), instead of the CSV import.
  r.post('/unleashed/send/transfers', async (req, res) =>
    res.json({ results: await sendTransfersForDate(db, unleashed(), requireDate(req.body?.date), sentBy(req)) }));
  r.post('/unleashed/send/assemblies', async (req, res) =>
    res.json({ results: await sendAssembliesForDate(db, unleashed(), requireDate(req.body?.date), { productionEmail: config.productionEmail, ...sentBy(req) }) }));
  r.get('/unleashed/status', async (req, res) => res.json({ configured: !!unleashed(), ...(await getSyncStatus(db)) }));
  r.post('/unleashed/sync', async (req, res) => res.json(await syncFromUnleashed(db, unleashed())));

  // ---------- users & roles (admins) ----------
  // Users are the customer's; access (role + lines) is per site — this one.
  const scope = (req) => ({ customerId: req.site.customerId, siteId: req.site.id });
  r.get('/users', async (req, res) => {
    const site = await platform.getSite(platformDb, req.site.id);
    res.json({
      users: await users.listUsers(platformDb, db, scope(req)), roles: await users.listRoles(db, req.site.id), lines: LINES,
      site: { id: site.id, name: site.name, supportAccess: site.supportAccess },
      supportSessions: await platform.listSupportSessions(platformDb, req.site.id),
    });
  });
  r.post('/users', async (req, res) => {
    const { id, password } = await users.createUser(platformDb, db, scope(req), req.body || {});
    const list = await users.listUsers(platformDb, db, scope(req));
    res.status(201).json({ user: list.find((u) => u.id === id), password });
  });
  r.patch('/users/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id && (req.body?.active === false || req.body?.hasAccess === false)) {
      throw new UserError('You cannot switch off your own login or remove your own access.');
    }
    await users.updateUser(platformDb, db, scope(req), id, req.body || {});
    res.json((await users.listUsers(platformDb, db, scope(req))).find((u) => u.id === id));
  });
  r.post('/users/:id/reset-password', async (req, res) => res.json(await users.resetPassword(platformDb, req.site.customerId, Number(req.params.id))));
  r.get('/roles', async (req, res) => res.json(await users.listRoles(db, req.site.id)));
  r.post('/roles', async (req, res) => res.status(201).json(await users.createRole(db, req.body || {})));
  r.patch('/roles/:id', async (req, res) => res.json(await users.updateRole(platformDb, db, req.site.id, Number(req.params.id), req.body || {})));
  r.delete('/roles/:id', async (req, res) => { await users.deleteRole(platformDb, db, req.site.id, Number(req.params.id)); res.status(204).end(); });
  // Whether platform support may open this site.
  r.put('/settings/support-access', async (req, res) => {
    if (req.user.support) throw new UserError('Support can’t change this setting — the customer decides.', 403);
    await platform.setSupportAccess(platformDb, req.site.id, req.body?.allowed !== false);
    res.json({ supportAccess: req.body?.allowed !== false });
  });
  r.get('/activity', async (req, res) => res.json(await users.listActivity(db, { limit: req.query.limit, userId: req.query.userId })));

  r.use((req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, next) => {
    if (err instanceof UserError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server — try again, and tell the developer if it keeps happening.' });
  });
  return r;
}
