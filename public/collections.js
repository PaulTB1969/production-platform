// Stock Collection screen, laid out like the paper sheets: the day's LIST
// (sections with SKU + Qty Req), and one SHEET per vehicle where the
// warehouse fills in Qty Trf and Batch. Trucks: Mark Loaded, then Approve
// (send or CSV) -> one transfer per section; the second leg HLD ->
// destination is one transfer per destination. Interim transfer: approved
// straight away, PRD -> destination; the stock is then shown on the truck
// that carries it, which doesn't transfer it again.
//
// Inputs save as you go without redrawing the table, so Tab moves straight
// from Qty Trf to Batch to the next row.

import { api, todayStr, escapeHtml, fmtNum, fmtTimestamp, showError, download, busy, confirmClick, setupFocus, renderSyncBanner } from './common.js';
import { openBatchDialog } from './batchdialog.js';

const DESTINATIONS = [
  ['CPT', 'Cape Town'], ['RML-JHB', 'RM Logistics JHB'], ['ZARMI-JHB', 'Johannesburg - Zarmi'],
  ['PE', 'Port Elizabeth'], ['DBN', 'Durban'], ['JBAY', "Jeffery's Bay"], ['HER', 'Hermanus Sales'], ['PND', 'Pending Warehouse Orders'],
];
const SHEET_TEXT = { open: 'Being loaded', loaded: 'Loaded — waiting for approval', approved: 'Approved' };

const state = { date: null, tab: 'list', day: null, stock: { products: [], batches: {} } };

const sheetStatus = (s) => (s?.approvedAt ? 'approved' : s?.loadedAt ? 'loaded' : 'open');
const sheetOf = (truck) => state.day.sheets.find((s) => s.truck === truck);
const loadOf = (line, truck) => line.loads.find((x) => x.truck === truck);
const loadedTotal = (line) => line.loads.reduce((s, x) => s + (Number(x.qty) || 0), 0);
const toFirst = (c, kind) => (kind !== 'interim' && c.viaHolding ? 'HLD' : c.warehouse);
// The day's vehicles: trucks in order, then the interim transfer.
const vehicles = () => state.day?.vehicles || [];
const vehicleOf = (code) => vehicles().find((v) => v.code === code);
const isInterim = (code) => vehicleOf(code)?.kind === 'interim';
const trucks = () => vehicles().filter((v) => v.kind === 'truck');
const interimCode = () => vehicles().find((v) => v.kind === 'interim')?.code;
const interimLoad = (line) => line.loads.find((x) => isInterim(x.truck) && Number(x.qty) > 0);

// ---------- loading ----------

async function loadDay() {
  if (!state.date) return;
  const [day, stock] = await Promise.all([
    api('GET', '/collections/day?date=' + state.date),
    api('GET', '/collections/stock?date=' + state.date),
  ]);
  state.day = day;
  state.stock = stock;
  document.getElementById('skuList').innerHTML = stock.products.map((p) =>
    '<option value="' + escapeHtml(p.sku) + '" label="' + escapeHtml(p.description + (p.onHand !== null ? ' · ' + fmtNum(p.onHand) + ' in PRD' : '')) + '">').join('');
  render();
}

// ---------- rendering ----------

function render() {
  renderTabs();
  const el = document.getElementById('sheet');
  el.innerHTML = state.tab === 'list' ? renderList() : renderTruck(state.tab);
}

function renderTabs() {
  const chip = (t) => {
    if (isInterim(t)) {
      const sent = state.day.collections.reduce((n, c) => n + c.dispatches.filter((d) => d.truck === t && d.exportedAt).length, 0);
      return sent ? '<span class="chip approved">' + sent + ' sent</span>' : '';
    }
    const s = sheetStatus(sheetOf(t));
    return s === 'open' ? '' : '<span class="chip ' + s + '">' + (s === 'approved' ? 'approved' : 'loaded') + '</span>';
  };
  if (state.tab !== 'list' && !vehicleOf(state.tab)) state.tab = 'list';
  document.getElementById('tabs').innerHTML =
    '<button type="button" role="tab" data-tab="list" aria-selected="' + (state.tab === 'list') + '">List</button>' +
    vehicles().map((v) => '<button type="button" role="tab" data-tab="' + escapeHtml(v.code) + '" aria-selected="' + (state.tab === v.code) + '">' +
      escapeHtml(v.kind === 'interim' ? v.name : v.name + ' sheet') + chip(v.code) + '</button>').join('');
}

function sectionTitle(c, kind) {
  return 'Stock Collection ' + escapeHtml(c.destination) +
    ' <span style="font-weight:400;color:var(--text-faint);">· ' + escapeHtml(c.label) + ' · to ' + escapeHtml(toFirst(c, kind)) + '</span>';
}

// The list: Qty Req per SKU, what each truck took, what's left.
function renderList() {
  const cs = state.day.collections;
  let out = cs.length ? '' : '<div class="empty">No collection list for this date yet — upload it below, or add a section.</div>';
  for (const c of cs) {
    out += '<div class="sheet-section"><table class="sheet"><thead><tr>' +
      '<th class="title">' + sectionTitle(c) + '</th><th class="num">Qty Req</th>' +
      vehicles().map((v) => '<th class="num">' + escapeHtml(v.kind === 'interim' ? 'Interim' : v.name) + '</th>').join('') + '<th class="num">Left</th><th></th></tr></thead><tbody>' +
      c.lines.map((l) => {
        const left = l.qty - loadedTotal(l);
        const locked = l.loads.some((x) => x.dispatchId);
        return '<tr data-line="' + l.id + '">' +
          '<td class="sku">' + escapeHtml(l.sku) + (l.description && l.description !== l.sku ? '<small>' + escapeHtml(l.description) + '</small>' : '') + '</td>' +
          '<td class="num"><input class="qty" type="number" min="1" step="1" data-req="' + l.id + '" value="' + l.qty + '"></td>' +
          vehicles().map((v) => { const x = loadOf(l, v.code); return '<td class="num">' + (x && x.qty ? fmtNum(x.qty) : '') + '</td>'; }).join('') +
          '<td class="num" style="' + (left > 0 ? 'color:var(--warn);' : left < 0 ? 'color:var(--danger);' : 'color:var(--good);') + '">' + (left === 0 ? '✓' : fmtNum(left)) + '</td>' +
          '<td>' + (locked ? '' : '<button type="button" class="rm" data-rm-line="' + l.id + '" title="Remove">✕</button>') + '</td></tr>';
      }).join('') +
      '</tbody></table>' +
      '<div class="add-row"><input type="text" list="skuList" placeholder="Add a SKU to ' + escapeHtml(c.destination) + ' — type its code" data-add-sku="' + c.destination + '" autocomplete="off">' +
      '<input type="number" min="1" step="1" placeholder="Qty Req" data-add-qty="' + c.destination + '"><button type="button" class="btn-ghost btn-small" data-add="' + c.destination + '">Add</button>' +
      (c.dispatches.length ? '' : '<button type="button" class="btn-danger-ghost btn-small" data-del-section="' + c.id + '">Remove ' + escapeHtml(c.destination) + ' section</button>') + '</div></div>';
  }
  // Adding a destination that isn't on the day's list yet. Destinations
  // already on it get their SKUs from the "Add a SKU to …" row under their table.
  const missing = DESTINATIONS.filter(([code]) => !cs.some((c) => c.destination === code));
  if (missing.length) {
    out += '<div class="section-title" style="margin-top:22px;">Add another destination to this day\'s list</div>' +
      '<div class="add-row" style="margin-top:0;"><select id="newSection" style="flex:0 1 240px;">' +
      missing.map(([code, label]) => '<option value="' + code + '">' + code + ' — ' + escapeHtml(label) + '</option>').join('') +
      '</select><input type="text" list="skuList" placeholder="its first SKU" id="newSectionSku" autocomplete="off"><input type="number" min="1" step="1" placeholder="Qty Req" id="newSectionQty">' +
      '<button type="button" class="btn-ghost btn-small" id="addSectionBtn">Add destination</button></div>' +
      (cs.length ? '<div class="export-note">Destinations already on the list (' + escapeHtml(cs.map((c) => c.destination).join(', ')) + ') aren\'t offered here — add their SKUs with the row under their table.</div>' : '');
  }
  return out;
}

// A truck sheet: the same list, with Qty Trf and Batch for this truck.
// ---------- batches on a line ----------
// Same format as the sheets: "20261007" or "20261007 (215) 20261005 (1)".
function parseBatches(text, qty) {
  const t = String(text || '').trim();
  if (!t) return [];
  const parts = [...t.matchAll(/(.+?)\s*\(\s*(\d+(?:\.\d+)?)\s*\)/g)];
  if (!parts.length) return [{ batch: t, qty: qty === undefined || qty === null ? null : Number(qty) }];
  return parts.map((m) => ({ batch: m[1].trim(), qty: Number(m[2]) }));
}
function formatBatches(entries) {
  const list = entries.filter((e) => String(e.batch || '').trim());
  if (list.length === 1) return list[0].batch.trim();
  return list.map((e) => e.batch.trim() + ' (' + Number(e.qty) + ')').join(' ');
}
const entriesOf = (x) => parseBatches(x?.batch, x?.qty);

// How much of a batch is already on today's sheets (every line and truck),
// leaving out one load — the one being edited.
function allocated(sku, batch, exceptLoadId) {
  let n = 0;
  for (const c of state.day.collections) {
    for (const l of c.lines) {
      if (l.sku !== sku) continue;
      for (const x of l.loads) {
        if (x.id === exceptLoadId) continue;
        for (const e of entriesOf(x)) if (e.batch === batch) n += Number(e.qty ?? x.qty) || 0;
      }
    }
  }
  return n;
}


// Interim stock on a truck sheet: already transferred; tick it if this
// truck carries it (another truck's tick shows its name).
function interimCell(l, truck, status) {
  const i = interimLoad(l);
  if (!i) return '<td class="interim"></td>';
  const text = fmtNum(i.qty) + (i.batch ? ' · ' + escapeHtml(i.batch) : '');
  if (i.carriedBy && i.carriedBy !== truck) return '<td class="interim">' + text + '<small>on ' + escapeHtml(vehicleOf(i.carriedBy)?.name || i.carriedBy) + '</small></td>';
  const box = status === 'approved' ? (i.carriedBy === truck ? ' ✓ on this truck' : '')
    : '<label class="carry no-print"><input type="checkbox" data-carry="' + l.id + '"' + (i.carriedBy === truck ? ' checked' : '') + '> on this truck</label>';
  return '<td class="interim' + (i.carriedBy === truck ? ' carried' : '') + '">' + text + box + '</td>';
}

function truckRow(c, l, truck, status) {
  const interim = isInterim(truck);
  const x = loadOf(l, truck);
  // "Other": the other trucks (on a truck sheet), or all trucks (on the interim sheet).
  const others = l.loads.filter((y) => y.truck !== truck && !isInterim(y.truck)).reduce((s, y) => s + (Number(y.qty) || 0), 0);
  const o = others ? { qty: others } : null;
  const locked = (!interim && status === 'approved') || !!x?.dispatchId;
  const entries = entriesOf(x);
  const multi = entries.length > 1;
  const diff = x && x.qty && loadedTotal(l) !== l.qty;
  const qtyCell = locked
    ? '<td class="num trf">' + (x?.qty ? fmtNum(x.qty) : '') + '</td>'
    : '<td class="num trf"><input class="qty" type="number" min="0" step="1" data-trf="' + l.id + '" value="' + (x?.qty ?? '') + '"' +
      (multi ? ' readonly title="The sum of the batch quantities"' : '') + '></td>';
  let batchCell;
  if (locked) {
    batchCell = '<td>' + escapeHtml(x?.batch || '') + '</td>';
  } else {
    const chips = entries.map((e, i) => '<span class="bchip">' + escapeHtml(e.batch) +
      (multi ? ' <b>' + fmtNum(e.qty) + '</b>' : '') +
      '<button type="button" class="rm" data-rm-batch="' + l.id + '" data-i="' + i + '" title="Remove this batch">✕</button></span>').join('');
    const needed = !entries.length && l.needsBatch && x?.qty;
    batchCell = '<td><div class="batches">' + chips +
      '<button type="button" class="' + (needed ? 'btn-primary' : 'btn-ghost') + ' btn-small no-print" data-pick-batches="' + l.id + '">' +
      (entries.length ? 'Batches…' : 'Select batch…') + '</button>' +
      (needed ? '<span class="bneed">batch needed</span>' : '') +
      '</div></td>';
  }
  return '<tr class="' + (locked ? 'locked' : '') + (diff ? ' diff' : '') + '" data-line="' + l.id + '" data-coll="' + c.id + '">' +
    '<td class="sku">' + escapeHtml(l.sku) + '</td><td class="num">' + fmtNum(l.qty) + '</td>' + qtyCell + batchCell +
    (interim || !interimCode() ? '' : interimCell(l, truck, status)) +
    '<td class="num other">' + (o?.qty ? fmtNum(o.qty) : '') + '</td></tr>';
}

// A truck sheet: the same list, with Qty Trf and Batch for this truck.
function renderTruck(truck) {
  const s = sheetOf(truck);
  const status = sheetStatus(s);
  const cs = state.day.collections;
  if (!cs.length) return '<div class="empty">No collection list for this date yet.</div>';
  const v = vehicleOf(truck);
  const interim = v.kind === 'interim';
  const otherHead = interim ? 'Trucks' : trucks().length > 2 ? 'Other trucks' : (trucks().find((t) => t.code !== truck)?.name || 'Other');
  let out = interim
    ? '<div class="export-note" style="margin:0 0 10px;">Moves stock in Unleashed straight from PRD to the destination, ahead of delivery, so the order team there can work with it. It still goes on a truck later: tick it on that truck\'s sheet (it isn\'t transferred again).</div>'
    : '';
  for (const c of cs) {
    out += '<div class="sheet-section"><table class="sheet"><thead><tr>' +
      '<th class="title">' + sectionTitle(c, v.kind) + '</th><th class="num">Qty Req</th><th class="num">Qty Trf</th><th>Batch</th>' +
      (interim || !interimCode() ? '' : '<th>Interim (already transferred)</th>') +
      '<th class="num">' + escapeHtml(otherHead) + '</th></tr></thead><tbody>' +
      c.lines.map((l) => truckRow(c, l, truck, status)).join('') + '</tbody></table>';
    const ds = c.dispatches.filter((d) => d.truck === truck);
    if (ds.length) {
      out += '<div class="export-note">' + ds.map((d) => d.exportedAt
        ? (d.guid ? 'Sent' : 'Exported by CSV') + ' as <b>' + escapeHtml(d.transferNumber || '') + '</b> (PRD → ' + escapeHtml(toFirst(c, v.kind)) + ') ' + escapeHtml(fmtTimestamp(d.exportedAt))
        : '<span style="color:var(--danger);">Not in Unleashed yet' + (d.sendError ? ': ' + escapeHtml(d.sendError) : '') + '</span>').join(' · ') + '</div>';
    }
    out += '</div>';
  }
  out += '<div class="sheet-foot"><div class="status" id="sheetStatus">' + statusLine(truck) + '</div><span class="sheet-buttons" id="sheetButtons">' + sheetButtons(truck, status) + '</span></div>';
  return out;
}

function statusLine(truck) {
  const s = sheetOf(truck);
  const status = sheetStatus(s);
  const lines = state.day.collections.flatMap((c) => c.lines.map((l) => ({ c, l, x: loadOf(l, truck) }))).filter((r) => r.x && r.x.qty > 0);
  const missing = lines.filter((r) => r.l.needsBatch && !String(r.x.batch || '').trim());
  if (isInterim(truck)) {
    const waiting = lines.filter((r) => !r.x.dispatchId);
    let t = '<b>' + fmtNum(lines.length - waiting.length) + ' line(s) transferred</b> · ' + fmtNum(waiting.length) + ' waiting to be approved';
    if (missing.length) t += '<br><span style="color:var(--warn);">Batch still needed: ' + escapeHtml(missing.map((r) => r.c.destination + ' ' + r.l.sku).join(', ')) + '</span>';
    return t;
  }
  const carried = state.day.collections.flatMap((c) => c.lines.map((l) => interimLoad(l))).filter((i) => i && i.carriedBy === truck);
  let t = '<b>' + SHEET_TEXT[status] + '</b> · ' + lines.length + ' SKU line(s), ' + fmtNum(lines.reduce((u, r) => u + Number(r.x.qty), 0)) + ' units on ' + escapeHtml(vehicleOf(truck)?.name || truck) +
    (carried.length ? ' · plus ' + carried.length + ' interim line(s), ' + fmtNum(carried.reduce((u, i) => u + Number(i.qty), 0)) + ' units (already transferred)' : '');
  if (status === 'loaded') t += ' · marked loaded ' + escapeHtml(fmtTimestamp(s.loadedAt));
  if (status === 'approved') t += ' · approved ' + escapeHtml(fmtTimestamp(s.approvedAt));
  if (missing.length && status === 'open') t += '<br><span style="color:var(--warn);">Batch still needed: ' + escapeHtml(missing.map((r) => r.c.destination + ' ' + r.l.sku).join(', ')) + '</span>';
  return t;
}

function sheetButtons(truck, status) {
  const csvApproved = state.day.collections.some((c) => c.dispatches.some((d) => d.truck === truck && d.exportedAt && !d.guid));
  const unsent = state.day.collections.some((c) => c.dispatches.some((d) => d.truck === truck && !d.exportedAt));
  if (isInterim(truck)) {
    const waiting = state.day.collections.some((c) => c.lines.some((l) => { const x = loadOf(l, truck); return x && Number(x.qty) > 0 && !x.dispatchId; }));
    return (waiting || unsent ? '<button type="button" class="btn-primary btn-small" data-approve="' + truck + '">Approve &amp; send to Unleashed</button>' +
      (unsent ? '' : '<button type="button" class="btn-ghost btn-small" data-approve-csv="' + truck + '">Approve by CSV</button>') : '') +
      (csvApproved ? '<button type="button" class="btn-ghost btn-small" data-undo-csv="' + truck + '" title="Only if the CSV was not uploaded to Unleashed">Undo CSV approval</button>' : '');
  }
  if (status === 'open') return '<button type="button" class="btn-primary btn-small" data-loaded="' + truck + '">Mark ' + escapeHtml(vehicleOf(truck)?.name || truck) + ' loaded</button>';
  if (status === 'loaded') {
    return '<button type="button" class="btn-ghost btn-small" data-unloaded="' + truck + '">Back to loading</button>' +
      '<button type="button" class="btn-primary btn-small" data-approve="' + truck + '">Approve &amp; send to Unleashed</button>' +
      (unsent ? '' : '<button type="button" class="btn-ghost btn-small" data-approve-csv="' + truck + '">Approve by CSV</button>');
  }
  return csvApproved ? '<button type="button" class="btn-ghost btn-small" data-undo-csv="' + truck + '" title="Only if the CSV was not uploaded to Unleashed">Undo CSV approval</button>' : '';
}

// ---------- saving as you type ----------

function replaceCollection(c) {
  const i = state.day.collections.findIndex((x) => x.id === c.id);
  if (i >= 0) state.day.collections[i] = c; else state.day.collections.push(c);
}

const sheetEl = document.getElementById('sheet');

const findLine = (lineId) => {
  for (const c of state.day.collections) { const l = c.lines.find((x) => x.id === Number(lineId)); if (l) return { c, l }; }
  return {};
};

// Saves Qty Trf + batches for a line on this truck, then redraws that row
// (and the status line) only, so the rest of the sheet keeps its place.
async function saveLoad(lineId, { qty, batch }, refocus) {
  const truck = state.tab;
  try {
    replaceCollection(await api('PUT', '/collections/lines/' + lineId + '/loads/' + truck, { qty, batch }));
  } catch (err) { showError(err.message); }
  const { c, l } = findLine(lineId);
  const row = sheetEl.querySelector('tr[data-line="' + lineId + '"]');
  if (c && row) row.outerHTML = truckRow(c, l, truck, sheetStatus(sheetOf(truck)));
  const st = document.getElementById('sheetStatus');
  if (st) st.innerHTML = statusLine(truck);
  const sb = document.getElementById('sheetButtons');
  if (sb) sb.innerHTML = sheetButtons(truck, sheetStatus(sheetOf(truck)));
  if (refocus) sheetEl.querySelector('tr[data-line="' + lineId + '"] ' + refocus)?.focus();
}

// Qty Trf typed: keep the batches (a single batch simply takes the new qty).
function saveQty(input) {
  const { l } = findLine(input.dataset.trf);
  const x = loadOf(l, state.tab);
  const qty = input.value === '' ? null : Number(input.value);
  saveLoad(input.dataset.trf, { qty, batch: x?.batch || '' });
}

// The batch pop-up for a line on this truck: finished-goods batches (PRD
// stock and the Production Schedule), less what's already on today's other
// loads. One batch takes Qty Trf; several set it to their total.
async function pickBatches(lineId) {
  const { l } = findLine(lineId);
  const truck = state.tab;
  const x = loadOf(l, truck);
  const elsewhere = loadedTotal(l) - (Number(x?.qty) || 0);
  const entries = entriesOf(x).map((e) => ({ batchNumber: e.batch, qty: e.qty ?? x?.qty ?? 0 }));
  const toRows = () => (state.stock.batches[l.sku] || []).map((b) => ({
    batchNumber: b.batchNumber,
    expiryDate: b.expiryDate || '',
    available: b.qty - allocated(l.sku, b.batchNumber, x?.id),
    note: b.source === 'unleashed' ? 'in PRD' : (b.note || 'Production Schedule'),
  }));
  const batches = toRows();
  const picked = await openBatchDialog({
    title: l.sku,
    subtitle: (l.description || '') + ' · ' + (vehicleOf(truck)?.name || truck),
    required: x?.qty || Math.max(0, l.qty - elsewhere),
    batches,
    selected: entries,
    allowOther: true,
    qtyLabel: 'Qty Trf',
    // Finished goods assembled since the last sync show up straight away
    // (a schedule batch now in PRD shows once, as "in PRD").
    refresh: async () => {
      const live = await api('GET', '/stock/live-batches?sku=' + encodeURIComponent(l.sku));
      const inPrd = live.batches.map((b) => ({ batchNumber: b.batchNumber, qty: b.quantityRemaining, expiryDate: b.expiryDate, source: 'unleashed' }));
      const planned = (state.stock.batches[l.sku] || []).filter((b) => b.source !== 'unleashed' && !inPrd.some((p) => p.batchNumber === b.batchNumber));
      state.stock.batches[l.sku] = [...inPrd, ...planned];
      return toRows();
    },
  });
  if (!picked) return;
  const list = picked.map((p) => ({ batch: p.batchNumber, qty: p.qty }));
  const total = list.reduce((t, e) => t + e.qty, 0);
  saveLoad(lineId, { qty: list.length ? total : (x?.qty ?? null), batch: formatBatches(list) });
}

function removeBatch(lineId, i) {
  const { l } = findLine(lineId);
  const x = loadOf(l, state.tab);
  const entries = entriesOf(x).map((e) => ({ ...e, qty: e.qty ?? x.qty }));
  entries.splice(i, 1);
  const total = entries.length > 1 ? entries.reduce((s, e) => s + Number(e.qty), 0) : (entries[0]?.qty ?? x?.qty ?? null);
  saveLoad(lineId, { qty: total, batch: formatBatches(entries) });
}

sheetEl.addEventListener('change', async (e) => {
  const carry = e.target.closest('[data-carry]');
  if (carry) {
    try { replaceCollection(await api('PUT', '/collections/lines/' + carry.dataset.carry + '/carried-by', { truck: carry.checked ? state.tab : null })); }
    catch (err) { showError(err.message); }
    render();
    return;
  }
  const trf = e.target.closest('[data-trf]');
  if (trf) { if (!trf.readOnly) saveQty(trf); return; }
  const pick = e.target.closest('.bpick');
  if (pick) {
    const row = pick.closest('tr');
    const other = row.querySelector('.bother');
    other.hidden = pick.value !== '__other';
    if (!other.hidden) other.focus();
    else row.querySelector('.bqty').focus();
    return;
  }
  const req = e.target.closest('[data-req]');
  if (req) {
    try { replaceCollection(await api('PATCH', '/collections/lines/' + req.dataset.req, { qty: Number(req.value) })); }
    catch (err) { showError(err.message); render(); }
  }
});

// Enter in a sheet cell moves down to the same column on the next row;
// Enter in an "Add a SKU" row adds it.
sheetEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.matches('input')) return;
  const addRow = e.target.closest('.add-row');
  if (addRow) {
    e.preventDefault();
    addRow.querySelector('[data-add], #addSectionBtn')?.click();
    return;
  }
  if (e.target.matches('.bqty, .bother')) {
    e.preventDefault();
    addBatch(e.target.closest('tr').dataset.line);
    return;
  }
  const attr = ['data-trf', 'data-req'].find((a) => e.target.hasAttribute(a));
  if (!attr) return;
  e.preventDefault();
  const inputs = [...sheetEl.querySelectorAll('input[' + attr + ']')];
  const next = inputs[inputs.indexOf(e.target) + 1];
  e.target.dispatchEvent(new Event('change', { bubbles: true }));
  if (next) next.focus();
});

sheetEl.addEventListener('click', async (e) => {
  const date = state.date;
  const pb = e.target.closest('[data-pick-batches]');
  if (pb) { pickBatches(pb.dataset.pickBatches); return; }
  const br = e.target.closest('[data-rm-batch]');
  if (br) { removeBatch(br.dataset.rmBatch, Number(br.dataset.i)); return; }
  const add = e.target.closest('[data-add]');
  if (add) {
    const dest = add.dataset.add;
    const sku = sheetEl.querySelector('[data-add-sku="' + dest + '"]').value.trim();
    const qty = Number(sheetEl.querySelector('[data-add-qty="' + dest + '"]').value);
    if (!sku || !(qty > 0)) { showError('Enter a SKU and a Qty Req.'); return; }
    try { replaceCollection(await api('POST', '/collections/list', { date, destination: dest, lines: [{ sku, qty }] })); await loadDay(); }
    catch (err) { showError(err.message); }
    return;
  }
  if (e.target.id === 'addSectionBtn') {
    const dest = document.getElementById('newSection').value;
    const sku = document.getElementById('newSectionSku').value.trim();
    const qty = Number(document.getElementById('newSectionQty').value);
    if (!dest || !sku || !(qty > 0)) { showError('Pick a destination and enter its first SKU and Qty Req.'); return; }
    try { await api('POST', '/collections/list', { date, destination: dest, lines: [{ sku, qty }] }); await loadDay(); }
    catch (err) { showError(err.message); }
    return;
  }
  const rm = e.target.closest('[data-rm-line]');
  if (rm) {
    try { replaceCollection(await api('DELETE', '/collections/lines/' + rm.dataset.rmLine)); render(); } catch (err) { showError(err.message); }
    return;
  }
  const del = e.target.closest('[data-del-section]');
  if (del) {
    confirmClick(del, async () => {
      try { await api('DELETE', '/collections/' + encodeURIComponent(del.dataset.delSection)); await loadDay(); } catch (err) { showError(err.message); }
    });
    return;
  }
  for (const [attr, run] of [
    ['data-loaded', (t) => api('POST', '/collections/sheets/' + t + '/loaded', { date, loaded: true })],
    ['data-unloaded', (t) => api('POST', '/collections/sheets/' + t + '/loaded', { date, loaded: false })],
  ]) {
    const b = e.target.closest('[' + attr + ']');
    if (b) { busy(b, 'Saving…', async () => { await run(b.getAttribute(attr)); await loadDay(); }); return; }
  }
  const ap = e.target.closest('[data-approve]');
  if (ap) {
    busy(ap, 'Sending…', async () => {
      try { showResults((await api('POST', '/collections/sheets/' + ap.dataset.approve + '/send', { date })).results); }
      finally { await loadDay(); await renderArrivals(); }
    });
    return;
  }
  const csv = e.target.closest('[data-approve-csv]');
  if (csv) {
    busy(csv, 'Exporting…', async () => {
      const exp = await api('POST', '/collections/sheets/' + csv.dataset.approveCsv + '/csv', { date });
      if (exp.url && exp.id) download(exp.url); // none when only interim stock was on it
      await loadDay(); await renderArrivals();
    });
    return;
  }
  const undo = e.target.closest('[data-undo-csv]');
  if (undo) {
    confirmClick(undo, async () => {
      try { await api('POST', '/collections/sheets/' + undo.dataset.undoCsv + '/undo-csv', { date }); } catch (err) { showError(err.message); }
      await loadDay(); await renderArrivals();
    });
  }
});

document.getElementById('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  state.tab = b.dataset.tab;
  render();
});

// ---------- second leg ----------

function showResults(results) {
  const el = document.getElementById('sendResult');
  el.hidden = false;
  el.innerHTML = results.map((r) => r.ok
    ? '✓ ' + escapeHtml(r.destination + (r.truck ? ' (' + r.truck + ')' : '')) + ' → ' + escapeHtml(r.to || '') + ': ' + escapeHtml(r.number || 'sent') + (r.recovered ? ' (found in Unleashed — not sent twice)' : ' (Parked)')
    : '<span style="color:var(--danger);">✕ ' + escapeHtml(r.destination) + ': ' + escapeHtml(r.error) + '</span>').join('<br>');
  el.scrollIntoView({ block: 'nearest' });
}

async function renderArrivals() {
  const list = await api('GET', '/collections/arrivals');
  document.getElementById('arrivalPanel').innerHTML = list.length
    ? list.map((a) => {
      const units = a.items.reduce((s, i) => s + Number(i.qty), 0);
      return '<div class="usage-line wrap"><span class="batch-no">' + escapeHtml(a.destination + ' — ' + a.label) + '</span>' +
        '<span>' + escapeHtml(a.date + ' · ' + a.trucks.join(' + ') + ' · ' + a.items.length + ' line(s), ' + fmtNum(units) + ' units') + '</span>' +
        '<span style="margin-left:auto;display:flex;gap:6px;">' +
          '<button type="button" class="btn-primary btn-small" data-arrival="' + a.collectionId + '">Arrived — send HLD → ' + escapeHtml(a.destination) + '</button>' +
          (a.unconfirmed ? '' : '<button type="button" class="btn-ghost btn-small" data-arrival-csv="' + a.collectionId + '">CSV</button>') +
        '</span></div>';
    }).join('')
    : '<div class="empty-lines">Nothing waiting at HLD.</div>';
}

document.getElementById('arrivalPanel').addEventListener('click', (e) => {
  const b = e.target.closest('[data-arrival]');
  if (b) {
    busy(b, 'Sending…', async () => {
      try { showResults([await api('POST', '/collections/' + encodeURIComponent(b.dataset.arrival) + '/arrival/send', {})]); }
      finally { await renderArrivals(); }
    });
    return;
  }
  const c = e.target.closest('[data-arrival-csv]');
  if (c) {
    busy(c, 'Exporting…', async () => {
      const exp = await api('POST', '/collections/' + encodeURIComponent(c.dataset.arrivalCsv) + '/arrival/csv', {});
      download(exp.url);
      await renderArrivals();
    });
  }
});

// ---------- upload, print, boot ----------

document.getElementById('uploadCollectionBtn').addEventListener('click', (e) => {
  const input = document.getElementById('collectionFileInput');
  const file = input.files && input.files[0];
  if (!file) { showError('Choose a CSV file first.'); return; }
  busy(e.target, 'Uploading…', async () => {
    const r = await api('POST', '/collections/upload', await file.text());
    input.value = '';
    const s = document.getElementById('uploadStatus');
    s.hidden = false;
    s.textContent = 'Uploaded: ' + r.lines + ' line(s) in ' + r.sections + ' section(s).';
    await loadDay();
  });
});

document.getElementById('printBtn').addEventListener('click', () => window.print());

document.getElementById('dayDate').addEventListener('change', (e) => {
  state.date = e.target.value || null;
  loadDay().catch((err) => showError(err.message));
});

state.date = todayStr();
document.getElementById('dayDate').value = state.date;
setupFocus({}, {}, []);
renderSyncBanner();
loadDay().catch((err) => showError('Could not load the collection: ' + err.message));
renderArrivals().catch(() => {});

// ---------- vehicles ----------
// Trucks can be added, renamed and switched off; the interim transfer is built in.

async function renderVehicles() {
  const el = document.getElementById('vehicleList');
  if (!el) return;
  const list = await api('GET', '/collections/vehicles');
  el.innerHTML = '<table class="sheet"><thead><tr><th>Code</th><th>Name</th><th>Type</th><th>In use</th></tr></thead><tbody>' +
    list.map((v) => '<tr data-vehicle="' + escapeHtml(v.code) + '"><td class="sku">' + escapeHtml(v.code) + '</td>' +
      '<td><input type="text" data-vname value="' + escapeHtml(v.name) + '"></td>' +
      '<td>' + (v.kind === 'interim' ? 'Interim transfer (PRD → destination)' : 'Truck') + '</td>' +
      '<td><label class="carry"><input type="checkbox" data-vactive' + (v.active ? ' checked' : '') + '> on</label></td></tr>').join('') +
    '</tbody></table>';
}

document.getElementById('vehicleList').addEventListener('change', async (e) => {
  const row = e.target.closest('[data-vehicle]');
  if (!row) return;
  const body = e.target.matches('[data-vname]') ? { name: e.target.value } : { active: e.target.checked };
  try { await api('PATCH', '/collections/vehicles/' + encodeURIComponent(row.dataset.vehicle), body); await loadDay(); }
  catch (err) { showError(err.message); }
  await renderVehicles();
});

document.getElementById('addVehicleBtn').addEventListener('click', (e) => busy(e.target, 'Adding…', async () => {
  await api('POST', '/collections/vehicles', { code: document.getElementById('newVehicleCode').value, name: document.getElementById('newVehicleName').value });
  document.getElementById('newVehicleCode').value = '';
  document.getElementById('newVehicleName').value = '';
  await renderVehicles();
  await loadDay();
}));

renderVehicles().catch(() => {});
