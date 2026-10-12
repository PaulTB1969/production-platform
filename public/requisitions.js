// Stock Requisition screen — ported from the artifact. "Generate" and
// completing a requisition now take effect immediately: no queue, and the
// Production Schedule's batch picker reads the same database.

import {
  api, todayStr, escapeHtml, fmtNum, fmtTimestamp, fmtDateLabel, showError,
  download, busy, confirmClick, setupFocus, renderSyncBanner, LINE_LABELS, LINES,
} from './common.js';
import { openBatchDialog } from './batchdialog.js';

const state = {
  bulk: {},        // componentSku -> {batches} (bulk store, from Unleashed)
  materials: {},   // sku -> {description, batchTracked, onHand} — what can be added
  entries: {},     // id -> requisition
  balances: [],
  expanded: {},
  dateFilter: null,
  lineFilter: null,
  statusFilter: null,
  groupFilter: null,   // Unleashed product group, or NO_GROUP
};

// Raw materials are listed by Unleashed product group; NO_GROUP collects the rest.
const NO_GROUP = '(no product group)';
const groupOf = (l) => l.group || state.materials[l.sku]?.group || NO_GROUP;
const groupOrder = (a, b) => (a === NO_GROUP) - (b === NO_GROUP) || a.localeCompare(b);
const inGroupFilter = (l) => !state.groupFilter || groupOf(l) === state.groupFilter;

const lineNeedsBatch = (l) => l.needsBatch !== false;
const requisitionName = (r) => (LINE_LABELS[r.line] || r.line || '') + ' — ' + fmtDateLabel(r.date) + (r.seq > 1 ? ' (' + r.seq + ')' : '');

function requisitionIssues(r) {
  const lines = r.lines || [];
  if (lines.length === 0) return ['add at least one raw material'];
  if (lines.some((l) => lineNeedsBatch(l) && !l.batchNumber)) return ['assign a batch to every raw material that needs one'];
  return [];
}

// ---------- loading ----------

async function loadAll() {
  const [bulk, reqs, balances, materials] = await Promise.all([
    api('GET', '/stock/bulk'), api('GET', '/requisitions'), api('GET', '/stock/balances'), api('GET', '/stock/materials'),
  ]);
  state.bulk = bulk;
  state.entries = Object.fromEntries(reqs.map((r) => [r.id, r]));
  state.balances = balances;
  state.materials = Object.fromEntries(materials.map((m) => [m.sku, m]));
  document.getElementById('skuList').innerHTML = materials.map((m) =>
    '<option value="' + escapeHtml(m.sku) + '" label="' + escapeHtml(
      (m.description || '') + (m.onHand !== null ? ' · ' + fmtNum(m.onHand) + ' in PRD' : '') + (m.batchTracked ? ' · batch-tracked' : ''),
    ) + '">').join('');
  renderGroupFilter();
  renderJobList();
  renderBalanceList();
}

// Product groups that appear on the requisitions loaded.
function renderGroupFilter() {
  const groups = new Set(Object.values(state.entries).flatMap((r) => (r.lines || []).map(groupOf)));
  const sel = document.getElementById('groupFilter');
  const current = state.groupFilter;
  sel.innerHTML = '<option value="">All</option>' + [...groups].sort(groupOrder).map((g) =>
    '<option value="' + escapeHtml(g) + '">' + escapeHtml(g) + '</option>').join('');
  if (current && !groups.has(current)) state.groupFilter = null;
  sel.value = state.groupFilter || '';
}

// ---------- rendering ----------


function renderJobList() {
  const list = document.getElementById('jobList');
  let ids = Object.keys(state.entries).sort((a, b) => {
    const ea = state.entries[a], eb = state.entries[b];
    if (ea.date !== eb.date) return ea.date < eb.date ? 1 : -1;
    return ea.line < eb.line ? -1 : 1;
  });
  if (state.dateFilter) ids = ids.filter((id) => state.entries[id].date === state.dateFilter);
  if (state.lineFilter) ids = ids.filter((id) => state.entries[id].line === state.lineFilter);
  if (state.groupFilter) ids = ids.filter((id) => (state.entries[id].lines || []).some(inGroupFilter));
  if (state.statusFilter) ids = ids.filter((id) => (state.entries[id].status === 'done' ? 'done' : 'scheduled') === state.statusFilter);
  if (ids.length === 0) {
    list.innerHTML = '<div class="empty">No requisitions ' + ((state.dateFilter || state.lineFilter || state.statusFilter) ? 'match this filter' : 'yet — generate them from the Production Schedule above') + '.</div>';
    return;
  }
  list.innerHTML = ids.map(renderJobCard).join('');
}

function renderJobCard(id) {
  const r = state.entries[id];
  const status = r.status === 'done' ? 'done' : 'scheduled';
  const n = (r.lines || []).length;
  const head =
    '<div class="job-head" data-toggle="' + id + '">' +
      '<div class="job-title"><div class="job-sku">' + escapeHtml(requisitionName(r)) + '</div></div>' +
      '<div class="job-meta">' +
        '<span class="pill pill-line">' + escapeHtml(r.line) + '</span>' +
        '<span class="pill pill-status-' + status + '">' + (status === 'done' ? 'completed' : 'scheduled') + '</span>' +
        (r.exportedAt ? '<span class="pill pill-exported">' + escapeHtml(r.transferNumber || 'Exported') + '</span>' : '') +
        '<span class="job-qty">' + n + (n === 1 ? ' item' : ' items') + '</span>' +
      '</div>' +
    '</div>';
  const body = state.expanded[id] ? '<div class="job-body">' + renderJobDetail(id, r, status) + '</div>' : '';
  return '<div class="job-card" data-id="' + id + '">' + head + body + '</div>';
}

function renderJobDetail(id, r, status) {
  const locked = status === 'done';
  let out = '<div class="section-title">Requisition</div>' +
    '<div class="export-note" style="margin-top:-4px;">' + escapeHtml(LINE_LABELS[r.line] || r.line) + ' · ' + escapeHtml(fmtDateLabel(r.date)) +
      (r.generatedAt ? ' · generated ' + escapeHtml(fmtTimestamp(r.generatedAt)) + ' from the Production Schedule' : '') + '</div>' +
    '<div class="section-title">Comments sent to Unleashed</div>' +
    '<div class="export-note" style="margin-top:-4px;">' + escapeHtml(requisitionName(r)) + '</div>' +
    '<div class="section-title">Raw materials</div>' +
    renderLinesBlock(id, r, locked);

  if (r.unleashedGuid) {
    out += '<div class="export-note">Sent to Unleashed ' + escapeHtml(fmtTimestamp(r.exportedAt)) + ' as <b>' + escapeHtml(r.transferNumber || 'a transfer') + '</b> (Parked) — complete it in Unleashed once the stock has moved.</div>';
  } else if (r.exportedAt) {
    out += '<div class="export-note">Exported to Unleashed by CSV ' + escapeHtml(fmtTimestamp(r.exportedAt)) + (r.transferNumber ? ' as ' + escapeHtml(r.transferNumber) : '') + '.</div>';
  } else if (r.sendError) {
    out += '<div class="export-note" style="color:var(--danger);">Last send to Unleashed failed: ' + escapeHtml(r.sendError) + '</div>';
  }
  const issues = locked ? [] : requisitionIssues(r);
  out += '<div class="filter-row">' +
      '<button type="button" class="btn-ghost btn-small" data-pick-list="' + id + '">Pick list (Excel)</button>' +
      (r.exportedAt ? '' :
        '<button type="button" class="btn-primary btn-small" data-mark-done="' + id + '" ' + (issues.length ? 'disabled title="Still need: ' + escapeHtml(issues.join(', ')) + '"' : '') + '>' + (locked ? 'Reopen requisition' : 'Completed') + '</button>' +
        '<button type="button" class="btn-danger-ghost btn-small" data-delete="' + id + '">Delete requisition</button>') +
    '</div>';
  if (issues.length) out += '<div class="export-note" style="color:var(--warn);">Still need: ' + escapeHtml(issues.join(', ')) + '.</div>';
  if (locked) out += '<div class="export-note">The batch numbers and quantities above are now available for ' + escapeHtml(LINE_LABELS[r.line] || r.line) + ' in the Production Schedule.</div>';
  return out;
}

function renderLinesBlock(id, r, locked) {
  const lines = r.lines || [];
  let out = '<div class="lines-block">';
  if (lines.length === 0) out += '<div class="empty-lines">No raw materials added yet.</div>';
  // By product group (keeping the requisition's order within a group); idx
  // stays the line's position in r.lines, which the edit buttons use.
  const shown = lines.map((l, idx) => ({ l, idx, g: groupOf(l) }))
    .filter((x) => inGroupFilter(x.l))
    .sort((a, b) => groupOrder(a.g, b.g) || a.idx - b.idx);
  if (lines.length && !shown.length) out += '<div class="empty-lines">No raw materials in this product group.</div>';
  let lastGroup = null;
  out += shown.map(({ l, idx, g }) => {
    const heading = g === lastGroup ? '' : '<div class="group-head">' + escapeHtml(g) + '</div>';
    lastGroup = g;
    return heading + renderLine(id, l, idx, locked);
  }).join('');
  if (!locked) {
    out += '<div class="add-usage">' +
      '<input type="text" list="skuList" placeholder="Add a component — type its code or name" autocomplete="off" data-line-sku="' + id + '">' +
      '<input type="number" min="0" step="1" placeholder="qty" data-line-qty="' + id + '">' +
      '<button type="button" class="btn-ghost btn-small" data-add-line="' + id + '">Add</button>' +
    '</div>';
  }
  return out + '</div>';
}

function renderLine(id, l, idx, locked) {
  {
    const rmBtn = locked ? '' : '<button type="button" class="rm" data-rm-line="' + id + '" data-idx="' + idx + '">✕</button>';
    if (!lineNeedsBatch(l)) {
      // Not batch-tracked: quantity stays editable — pack sizes often mean
      // more is sent than the recipe strictly needs.
      return '<div class="usage-line wrap">' +
        '<span class="batch-no">' + escapeHtml(l.sku) + ' · no batch required</span>' +
        (locked ? '<span class="qty">' + fmtNum(l.qtyUsed) + '</span>'
          : '<input type="number" class="qty-input" min="0" step="1" value="' + (l.qtyUsed ?? '') + '" data-edit-qty="' + id + '" data-idx="' + idx + '" title="Quantity actually sent to the line">') +
        rmBtn + '</div>';
    }
    const hasBatches = state.bulk[l.sku] && state.bulk[l.sku].batches.length > 0;
    // One batch button per material, on its first line.
    const firstOfSku = (state.entries[id].lines || []).findIndex((x) => x.sku === l.sku) === idx;
    const pickBtn = (primary) => (locked || !firstOfSku ? '' :
      '<button type="button" class="' + (primary ? 'btn-primary' : 'btn-ghost') + ' btn-small" data-pick-batches="' + id + '" data-sku="' + escapeHtml(l.sku) + '">' +
      (primary ? 'Select batches…' : 'Change batches…') + '</button>');
    if (!l.batchNumber) {
      const assign = locked ? '' : hasBatches
        ? pickBtn(true)
        : '<div class="no-batches">No available batches for ' + escapeHtml(l.sku) + ' as of the last Unleashed sync.</div>';
      return '<div class="usage-line wrap" style="color:var(--warn);">' +
        '<span class="batch-no">' + escapeHtml(l.sku) + ' · needs a batch</span>' +
        '<span class="qty">' + fmtNum(l.qtyUsed) + '</span>' + assign + rmBtn + '</div>';
    }
    const b = state.bulk[l.sku] ? state.bulk[l.sku].batches.find((x) => x.batchNumber === l.batchNumber) : null;
    const over = b && l.qtyUsed > b.quantityRemaining;
    const split = (locked || !hasBatches) ? '' : pickBtn(false);
    return '<div class="usage-line wrap" style="' + (over ? 'color:var(--danger)' : '') + '">' +
      '<span class="batch-no">' + escapeHtml(l.sku) + ' · ' + escapeHtml(l.batchNumber) + '</span>' +
      (over ? '<span title="More than was in the bulk store at the last sync">⚠</span>' : '') +
      '<span class="qty">' + fmtNum(l.qtyUsed) + '</span>' + rmBtn + split + '</div>';
  }
}

function renderBalanceList() {
  const el = document.getElementById('balanceList');
  if (state.balances.length === 0) {
    el.innerHTML = '<div class="empty-lines">No balances yet — they appear once a requisition with non-batch-tracked materials is completed.</div>';
    return;
  }
  const byLine = {};
  for (const b of state.balances) (byLine[b.line] ||= []).push(b);
  const order = LINES.filter((l) => byLine[l]).concat(Object.keys(byLine).filter((l) => !LINES.includes(l)));
  el.innerHTML = order.map((line) =>
    '<div class="balance-group">' +
      '<div class="balance-group-title">' + escapeHtml(LINE_LABELS[line] || line) + '</div>' +
      '<div class="balance-head-row"><span class="bsku">Raw material</span><span class="bnum">Sent</span><span class="bnum">Used</span><span class="bnum">Balance</span></div>' +
      byLine[line].map((r) =>
        '<div class="balance-row">' +
          '<span class="bsku" title="' + escapeHtml(r.sku) + '">' + escapeHtml(r.description ? r.sku + ' — ' + r.description : r.sku) + '</span>' +
          '<span class="bnum">' + fmtNum(r.sentTotal) + '</span>' +
          '<span class="bnum">' + fmtNum(r.usedTotal) + '</span>' +
          '<span class="bbal' + (r.balance < 0 ? ' neg' : '') + '">' + fmtNum(r.balance) + '</span>' +
        '</div>').join('') +
    '</div>').join('');
}

// ---------- mutations ----------

async function save(id, patch) {
  try {
    state.entries[id] = await api('PATCH', '/requisitions/' + encodeURIComponent(id), patch);
    if ('status' in patch) state.balances = await api('GET', '/stock/balances');
  } catch (err) {
    showError(err.message);
  }
  renderGroupFilter();
  renderJobList();
  renderBalanceList();
}


const linesOf = (id) => state.entries[id].lines.map((l) => ({ ...l }));

// Exact code first (any case), then a unique match on the description.
function findMaterial(typed) {
  const t = typed.toLowerCase();
  const all = Object.values(state.materials);
  const exact = all.find((m) => m.sku.toLowerCase() === t);
  if (exact) return exact;
  const byName = all.filter((m) => (m.description || '').toLowerCase() === t);
  return byName.length === 1 ? byName[0] : null;
}

// Adds a material to the requisition. If it's already there without a batch
// (and not split across batches), the quantity is added to that line.
function addComponent(lines, m, qty) {
  const existing = lines.find((l) => l.sku === m.sku && !l.batchNumber);
  if (existing) {
    existing.qtyUsed = (Number(existing.qtyUsed) || 0) + qty;
    return lines;
  }
  return [...lines, { sku: m.sku, description: m.description || '', batchNumber: null, qtyUsed: qty, needsBatch: m.batchTracked }];
}

// Assigns a batch; a smaller qty splits off onto that batch (merging into a
// line already on it), so one material can span several batches.
// The batch pop-up for one material: bulk-store (PRD) batches, oldest first.
// The material's lines become one per batch chosen, plus a "needs a batch"
// line for any quantity not yet given a batch.
async function pickBatches(id, sku) {
  const lines = linesOf(id);
  const mine = lines.filter((l) => l.sku === sku);
  const required = mine.reduce((t, l) => t + (Number(l.qtyUsed) || 0), 0);
  const picked = await openBatchDialog({
    title: sku,
    subtitle: (mine[0]?.description || state.materials[sku]?.description || '') + ' · from the bulk store (PRD)',
    required,
    batches: (state.bulk[sku]?.batches || []).map((b) => ({ batchNumber: b.batchNumber, expiryDate: b.expiryDate, available: b.quantityRemaining })),
    selected: mine.filter((l) => l.batchNumber).map((l) => ({ batchNumber: l.batchNumber, qty: l.qtyUsed })),
  });
  if (!picked) return;
  const description = mine[0]?.description || '';
  const next = picked.map((p) => ({ sku, description, batchNumber: p.batchNumber, qtyUsed: p.qty, needsBatch: true }));
  const chosen = picked.reduce((t, p) => t + p.qty, 0);
  if (chosen < required) next.push({ sku, description, batchNumber: null, qtyUsed: required - chosen, needsBatch: true });
  // Same place in the list as before.
  const at = lines.findIndex((l) => l.sku === sku);
  const rest = lines.filter((l) => l.sku !== sku);
  rest.splice(at, 0, ...next);
  await save(id, { lines: rest });
}


// ---------- events ----------

const jobList = document.getElementById('jobList');

jobList.addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-toggle]');
  if (toggle && !e.target.closest('button, select, input, details')) {
    state.expanded[toggle.dataset.toggle] = !state.expanded[toggle.dataset.toggle];
    renderJobList();
    return;
  }

  const addBtn = e.target.closest('[data-add-line]');
  if (addBtn) {
    const id = addBtn.dataset.addLine;
    const block = addBtn.closest('.add-usage');
    const typed = block.querySelector('[data-line-sku]').value.trim();
    const qty = parseFloat(block.querySelector('[data-line-qty]').value);
    if (!typed || !(qty > 0)) { showError('Pick a component and enter a quantity greater than zero first.'); return; }
    const m = findMaterial(typed);
    if (!m) { showError('"' + typed + '" is not a known raw material — pick one from the list.'); return; }
    save(id, { lines: addComponent(linesOf(id), m, qty) });
    return;
  }

  const pickBtn = e.target.closest('[data-pick-batches]');
  if (pickBtn) { pickBatches(pickBtn.dataset.pickBatches, pickBtn.dataset.sku); return; }

  const rm = e.target.closest('[data-rm-line]');
  if (rm) {
    const lines = linesOf(rm.dataset.rmLine);
    lines.splice(Number(rm.dataset.idx), 1);
    save(rm.dataset.rmLine, { lines });
    return;
  }

  const doneBtn = e.target.closest('[data-mark-done]');
  if (doneBtn) {
    const id = doneBtn.dataset.markDone;
    const next = state.entries[id].status === 'done' ? null : 'done';
    if (next === 'done') state.expanded[id] = false;
    save(id, { status: next });
    return;
  }

  const pick = e.target.closest('[data-pick-list]');
  if (pick) {
    const r = state.entries[pick.dataset.pickList];
    busy(pick, 'Preparing…', () => downloadPickList(r.date, r.line));
    return;
  }

  const del = e.target.closest('[data-delete]');
  if (del) {
    confirmClick(del, async () => {
      try {
        await api('DELETE', '/requisitions/' + encodeURIComponent(del.dataset.delete));
        delete state.entries[del.dataset.delete];
        renderJobList();
      } catch (err) { showError(err.message); }
    });
  }
});

jobList.addEventListener('change', (e) => {
  const q = e.target.closest('[data-edit-qty]');
  if (!q) return;
  const lines = linesOf(q.dataset.editQty);
  const v = parseFloat(q.value);
  lines[Number(q.dataset.idx)].qtyUsed = isNaN(v) || v < 0 ? 0 : v;
  save(q.dataset.editQty, { lines });
});

document.getElementById('genRequestBtn').addEventListener('click', (e) => {
  const date = document.getElementById('genDate').value;
  if (!date) { showError('Pick a date to generate for first.'); return; }
  const note = document.getElementById('genStatusNote');
  busy(e.target, 'Generating…', async () => {
    const res = await api('POST', '/requisitions/generate', { date });
    const parts = [];
    parts.push(res.created.length ? 'Created ' + res.created.length + ' requisition(s).' : 'No new requisitions.');
    for (const s of res.skipped) parts.push(s.line + ': ' + s.reason + '.');
    if (res.missingRecipes.length) parts.push('No BOM for: ' + res.missingRecipes.join(', ') + ' — those jobs were left out.');
    note.textContent = parts.join(' ');
    state.dateFilter = date;
    document.getElementById('dateFilter').value = date;
    await loadAll();
  });
});

document.getElementById('createReqBtn').addEventListener('click', (e) => {
  const date = document.getElementById('createDate').value;
  const line = document.getElementById('createLine').value;
  if (!date) { showError('Pick a date for the requisition first.'); return; }
  busy(e.target, 'Creating…', async () => {
    const r = await api('POST', '/requisitions', { date, line });
    state.dateFilter = date;
    document.getElementById('dateFilter').value = date;
    state.expanded = { [r.id]: true };
    await loadAll();
    document.querySelector('.job-card[data-id="' + r.id + '"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

for (const key of ['dateFilter', 'lineFilter', 'statusFilter', 'groupFilter']) {
  document.getElementById(key).addEventListener('change', (e) => { state[key] = e.target.value || null; renderJobList(); });
}
// Fetched rather than linked, so "no requisitions for that date" shows in
// the error banner instead of replacing the page.
async function downloadPickList(date, line, group) {
  const q = new URLSearchParams({ date });
  if (line) q.set('line', line);
  if (group) q.set('group', group === NO_GROUP ? '' : group);
  const res = await fetch('/api/requisitions/picklist.xlsx?' + q);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not make the pick list.');
  const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'pick-list.xlsx';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

document.getElementById('pickListBtn').addEventListener('click', (e) => {
  const date = document.getElementById('dateFilter').value;
  if (!date) { showError('Pick a requisition date first.'); return; }
  busy(e.target, 'Preparing…', () => downloadPickList(date, state.lineFilter, state.groupFilter));
});

document.getElementById('showAllBtn').addEventListener('click', () => {
  state.dateFilter = null;
  document.getElementById('dateFilter').value = '';
  renderJobList();
});

async function renderExportHistory() {
  const date = document.getElementById('exportDate').value;
  const el = document.getElementById('exportHistory');
  if (!date) { el.textContent = ''; return; }
  const list = (await api('GET', '/exports?date=' + date)).filter((x) => x.kind === 'transfer');
  el.innerHTML = list.length
    ? 'Earlier exports for this date: ' + list.map((x) => '<a href="/api/exports/' + x.id + '" download>' + escapeHtml(fmtTimestamp(x.created_at)) + '</a>').join(' · ')
    : '';
}

document.getElementById('exportCsvBtn').addEventListener('click', (e) => {
  const date = document.getElementById('exportDate').value;
  if (!date) { showError('Pick a date to export first.'); return; }
  busy(e.target, 'Exporting…', async () => {
    const exp = await api('POST', '/exports/transfers', { date });
    download(exp.url);
    await loadAll();
    await renderExportHistory();
  });
});
document.getElementById('exportDate').addEventListener('change', renderExportHistory);

// Results of a send, one line per requisition.
function showSendResults(results) {
  const el = document.getElementById('sendResult');
  el.hidden = false;
  el.innerHTML = results.map((r) => r.ok
    ? '✓ ' + escapeHtml(r.line) + ': ' + escapeHtml(r.number || 'sent') + (r.already ? ' (already sent)' : r.recovered ? ' (found in Unleashed — not sent twice)' : ' (Parked)')
    : '<span style="color:var(--danger);">✕ ' + escapeHtml(r.line) + ': ' + escapeHtml(r.error) + '</span>').join('<br>');
}

document.getElementById('sendBtn').addEventListener('click', (e) => {
  const date = document.getElementById('exportDate').value;
  if (!date) { showError('Pick a date to send first.'); return; }
  busy(e.target, 'Sending…', async () => {
    try {
      const { results } = await api('POST', '/unleashed/send/transfers', { date });
      showSendResults(results);
    } finally {
      await loadAll();
    }
  });
});

// ---------- boot ----------

const today = todayStr();
for (const id of ['dateFilter', 'exportDate', 'genDate', 'createDate']) document.getElementById(id).value = today;
state.dateFilter = today;

setupFocus(
  {
    generateSection: ['generateSection'],
    reqListSection: ['reqListSection', 'jobList'],
    exportSection: ['exportSection'],
    balanceSection: ['balanceSection'],
  },
  {
    generateSection: 'Generate requisitions',
    reqListSection: 'Update a requisition',
    exportSection: 'Export to Unleashed',
    balanceSection: 'Raw material balance',
  },
  ['generateSection', 'reqListSection', 'jobList', 'exportSection', 'balanceSection'],
);
renderSyncBanner();
loadAll().catch((err) => showError('Could not load requisitions: ' + err.message));
renderExportHistory().catch(() => {});
