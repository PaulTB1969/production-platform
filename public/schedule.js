// Production Schedule screen — ported from the artifact. Every change goes
// to the server, which applies the rules (status locks, non-batch usage)
// and returns the saved job.

import {
  api, todayStr, escapeHtml, fmtNum, fmtTimestamp, lineShortCode, numOrNull, showError,
  download, busy, confirmClick, setupFocus, renderSyncBanner, LINE_LABELS,
} from './common.js';
import { openBatchDialog } from './batchdialog.js';

const state = {
  recipes: {},              // sku -> recipe
  lineBatches: {},          // "<line>|<componentSku>" -> {batches}
  entries: {},              // id -> entry
  expanded: {},
  notice: null,    // {id, text} — message shown inside that job
  dateFilter: null,
  lineFilter: null,
  statusFilter: null,
};

const hasValue = (v) => v !== null && v !== undefined && v !== '';

// Device clock, HH:MM — the start/end times are the local time on the floor.
const nowHHMM = () => new Date().toTimeString().slice(0, 5);

function computeEntryStatus(entry) {
  if (entry.status === 'done') return 'done';
  if (hasValue(entry.startTime) || (entry.componentUsage || []).length > 0 || hasValue(entry.actualCases)) return 'in_progress';
  return 'scheduled';
}

function familySize(groupId) {
  return Object.values(state.entries).filter((e) => e.groupId === groupId).length;
}

// "20261007 UWH 1" — the finished-goods batch number.
const finishedBatch = (e) => String(e.date).replace(/-/g, '') + ' ' + lineShortCode(e.line) + ' ' + (e.seq || 1);

function fmtDuration(start, end) {
  if (!start || !end) return null;
  const toMin = (t) => { const p = t.split(':'); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); };
  let diff = toMin(end) - toMin(start);
  if (diff < 0) diff += 24 * 60;
  return Math.floor(diff / 60) + 'h ' + (diff % 60) + 'm';
}

// ---------- loading ----------

async function loadAll() {
  const [recipes, lineBatches, entries] = await Promise.all([
    api('GET', '/recipes'), api('GET', '/stock/lines'), api('GET', '/schedule'),
  ]);
  state.recipes = Object.fromEntries(recipes.map((r) => [r.sku, r]));
  state.lineBatches = lineBatches;
  state.entries = Object.fromEntries(entries.map((e) => [e.id, e]));
  document.getElementById('skuList').innerHTML = Object.keys(state.recipes).sort()
    .map((s) => '<option value="' + escapeHtml(s) + '">').join('');
  renderJobList();
}

async function refreshLineBatches() {
  state.lineBatches = await api('GET', '/stock/lines');
}

// ---------- rendering ----------

// Run order within a day: the order of the uploaded schedule file, changed by
// dragging. A split family (same groupId) shares one place and stays together,
// batch 1, 2, 3… in seq order.
function familyOrder() {
  const order = {};
  for (const e of Object.values(state.entries)) {
    const k = e.groupId;
    const v = e.runOrder ?? Number.MAX_SAFE_INTEGER;
    if (order[k] === undefined || v < order[k]) order[k] = v;
  }
  return order;
}

function sortedIds() {
  const order = familyOrder();
  return Object.keys(state.entries).sort((a, b) => {
    const ea = state.entries[a], eb = state.entries[b];
    if (ea.date !== eb.date) return ea.date < eb.date ? 1 : -1;
    const oa = order[ea.groupId], ob = order[eb.groupId];
    if (oa !== ob) return oa - ob;
    if (ea.groupId !== eb.groupId) return (ea.createdAt || '') < (eb.createdAt || '') ? -1 : 1;
    return (ea.seq || 1) - (eb.seq || 1);
  });
}

// Status filter. "Exported" = in Unleashed, by CSV or Send; "Done – not
// exported" = finished but still to go to Unleashed.
function matchesStatus(e, filter) {
  const status = computeEntryStatus(e);
  if (filter === 'exported') return !!e.exportedAt;
  if (filter === 'done_unexported') return status === 'done' && !e.exportedAt;
  return status === filter;
}

// Dragging is on when the list shows a single day.
const canReorder = () => !!state.dateFilter;

function renderJobList() {
  const list = document.getElementById('jobList');
  let ids = sortedIds();
  if (state.dateFilter) ids = ids.filter((id) => state.entries[id].date === state.dateFilter);
  if (state.lineFilter) ids = ids.filter((id) => state.entries[id].line === state.lineFilter);
  if (state.statusFilter) ids = ids.filter((id) => matchesStatus(state.entries[id], state.statusFilter));

  document.getElementById('reorderHint').textContent = ids.length > 1
    ? (canReorder() ? 'Drag ⋮⋮ to change the run order. Split batches move together.' : 'Pick a production date to change the run order.')
    : '';

  if (ids.length === 0) {
    list.innerHTML = '<div class="empty">No jobs ' + ((state.dateFilter || state.lineFilter || state.statusFilter) ? 'match this filter' : '') + ' yet. Add one above.</div>';
    return;
  }
  // One block per split family, so it moves as one when dragged.
  let html = '';
  for (let i = 0; i < ids.length;) {
    const g = state.entries[ids[i]].groupId;
    const members = [];
    while (i < ids.length && state.entries[ids[i]].groupId === g) members.push(ids[i++]);
    html += '<div class="job-family' + (members.length > 1 ? ' is-split' : '') + '" data-family="' + escapeHtml(g) + '" data-first="' + members[0] + '">' +
      members.map(renderJobCard).join('') + '</div>';
  }
  list.innerHTML = html;
}

function renderJobCard(id) {
  const entry = state.entries[id];
  const recipe = state.recipes[entry.sku];
  const status = computeEntryStatus(entry);
  const qtyLabel = hasValue(entry.actualCases)
    ? '<b>' + fmtNum(entry.actualCases) + '</b> / ' + fmtNum(entry.plannedCases)
    : fmtNum(entry.plannedCases) + ' planned';
  const seqPill = familySize(entry.groupId) > 1 ? '<span class="pill pill-seq">Batch ' + (entry.seq || 1) + '</span>' : '';
  const exportedPill = entry.exportedAt ? '<span class="pill pill-exported" title="Exported ' + escapeHtml(fmtTimestamp(entry.exportedAt)) + '">Exported</span>' : '';

  const head =
    '<div class="job-head" data-toggle="' + id + '">' +
      (canReorder() ? '<span class="drag-handle" data-drag title="Drag to change the run order" aria-label="Drag to change the run order">⋮⋮</span>' : '') +
      '<div class="job-title"><div class="job-sku">' + escapeHtml(entry.sku) + '</div></div>' +
      '<div class="job-meta">' +
        '<span class="pill pill-line">' + escapeHtml(lineShortCode(entry.line)) + '</span>' +
        seqPill +
        '<span class="pill pill-status-' + status + '">' + status.replace('_', ' ') + '</span>' +
        exportedPill +
        '<span class="job-qty">' + qtyLabel + '</span>' +
      '</div>' +
    '</div>';
  const body = state.expanded[id] ? '<div class="job-body">' + renderJobDetail(id, entry, recipe, status) + '</div>' : '';
  return '<div class="job-card" data-id="' + id + '">' + head + body + '</div>';
}

function renderJobDetail(id, entry, recipe, status) {
  let out = '';

  // Planned fields are editable only until production is recorded.
  if (status === 'scheduled') {
    out += '<div class="section-title">Edit schedule</div>' +
      '<div class="edit-schedule">' +
        '<div class="field"><label>Product Code</label>' +
          '<input type="text" list="skuList" autocomplete="off" data-edit="sku" data-id="' + id + '" value="' + escapeHtml(entry.sku || '') + '"></div>' +
        '<div class="field"><label>Line</label><select data-edit="line" data-id="' + id + '">' +
          ['PRD - UWH', 'PRD - LWH', 'PRD - AQB', 'Other'].map((l) =>
            '<option value="' + l + '"' + (entry.line === l ? ' selected' : '') + '>' + LINE_LABELS[l] + '</option>').join('') +
        '</select></div>' +
        '<div class="field"><label>Cases</label>' +
          '<input type="number" min="1" step="1" data-edit="plannedCases" data-num data-id="' + id + '" value="' + (hasValue(entry.plannedCases) ? entry.plannedCases : '') + '"></div>' +
        '<div class="field"><label>Production Date</label>' +
          '<input type="date" data-edit="date" data-id="' + id + '" value="' + escapeHtml(entry.date || '') + '"></div>' +
      '</div>';
  }

  out += '<div class="row2">' +
      '<div class="field"><label>Cases Produced</label>' +
        '<input type="number" min="0" step="1" data-edit="actualCases" data-num data-id="' + id + '" value="' + (hasValue(entry.actualCases) ? entry.actualCases : '') + '" placeholder="0"></div>' +
      '<div class="field"><label>Wastage (cases)</label>' +
        '<input type="number" min="0" step="1" data-edit="wastageCases" data-num data-id="' + id + '" value="' + (hasValue(entry.wastageCases) ? entry.wastageCases : '') + '" placeholder="0"></div>' +
    '</div>';

  out += '<div class="section-title">Component Parts</div>';
  if (recipe && recipe.lines && recipe.lines.some((l) => l.isBatchTracked !== false)) {
    out += '<div class="duration-note help" style="margin-top:-4px; margin-bottom:2px;">Batch choices below are what\'s been sent to ' + escapeHtml(entry.line || 'this line') + ' via completed Stock Requisitions, less what production has already used.</div>';
  }
  if (!recipe || !recipe.lines || recipe.lines.length === 0) {
    out += '<div class="no-recipe">No BOM found for this SKU in Unleashed — nothing to check here. You can still record actual cases above.</div>';
  } else {
    // Components that need a batch number first, then the rest (BOM order within each).
    const lines = recipe.lines.slice().sort((a, b) => (a.isBatchTracked === false) - (b.isBatchTracked === false));
    out += lines.map((line) => renderComponentBlock(id, entry, line)).join('');
  }
  // Split production item: with cases produced entered (e.g. 80 of 160 for an
  // interim transfer), the rest (80) is filled in to become a new item.
  const rest = hasValue(entry.actualCases) && entry.actualCases < entry.plannedCases ? entry.plannedCases - entry.actualCases : '';
  out += '<div class="add-usage">' +
      '<input type="number" min="1" step="1" placeholder="cases to move" value="' + rest + '" data-split-qty="' + id + '" title="Cases for the new production item">' +
      '<button type="button" class="btn-ghost btn-small" data-split="' + id + '">Split production item</button>' +
    '</div>';

  const duration = fmtDuration(entry.startTime, entry.endTime);
  out += '<div class="section-title">Production time</div>' +
    '<div class="row2">' +
      '<div class="field"><label>Start time</label><input type="time" data-edit="startTime" data-id="' + id + '" value="' + escapeHtml(entry.startTime || '') + '"></div>' +
      '<div class="field"><label>End time</label><input type="time" data-edit="endTime" data-id="' + id + '" value="' + escapeHtml(entry.endTime || '') + '"></div>' +
    '</div>' +
    '<div class="duration-note">Start sets the start time (so does first entering Cases Produced); Completed sets the end time. Reopening keeps both — correct them here if needed.</div>' +
    (duration ? '<div class="duration-note">Duration: ' + duration + '</div>' : '');

  out += '<div class="section-title">Notes</div>' +
    '<div class="field"><textarea rows="2" data-notes="' + id + '" placeholder="Anything worth flagging">' + escapeHtml(entry.notes || '') + '</textarea></div>';

  if (entry.unleashedGuid) {
    out += '<div class="export-note">Sent to Unleashed ' + escapeHtml(fmtTimestamp(entry.exportedAt)) + ' as <b>' + escapeHtml(entry.unleashedNumber || 'an assembly') + '</b> (Parked). When completing it in Unleashed, enter batch number <b>' + escapeHtml(finishedBatch(entry)) + '</b>.</div>';
    if (entry.trackingError) {
      out += '<div class="export-note" style="color:var(--warn);">Bottle/cap batch numbers not attached yet: ' + escapeHtml(entry.trackingError) + ' Usually the line’s requisition transfer is not completed in Unleashed yet — press Send to Unleashed again afterwards.</div>';
    }
  } else if (entry.exportedAt) {
    out += '<div class="export-note">Exported to Unleashed by CSV ' + escapeHtml(fmtTimestamp(entry.exportedAt)) + ' — left out of the next export unless cleared below.</div>';
  } else if (entry.sendError) {
    out += '<div class="export-note" style="color:var(--danger);">Last send to Unleashed failed: ' + escapeHtml(entry.sendError) + '</div>';
  }
  if (state.notice && state.notice.id === id) {
    out += '<div class="job-notice" id="notice-' + escapeHtml(id) + '">' + escapeHtml(state.notice.text) + '</div>';
  }
  const canStart = !entry.startTime && entry.status !== 'done';
  out += '<div class="filter-row">' +
      (canStart ? '<button type="button" class="btn-primary btn-small" data-start="' + id + '">Start</button>' : '') +
      '<button type="button" class="' + (canStart ? 'btn-ghost' : 'btn-primary') + ' btn-small" data-mark-done="' + id + '">' + (entry.status === 'done' ? 'Reopen job' : 'Completed') + '</button>' +
      (entry.exportedAt && !entry.unleashedGuid ? '<button type="button" class="btn-ghost btn-small" data-clear-exported="' + id + '">Clear exported flag</button>' : '') +
      '<button type="button" class="btn-danger-ghost btn-small" data-delete="' + id + '">Delete job</button>' +
    '</div>';
  return out;
}

function renderComponentBlock(id, entry, line) {
  const compBatches = state.lineBatches[entry.line + '|' + line.componentSku];
  const cases = hasValue(entry.actualCases) ? entry.actualCases : entry.plannedCases;
  const required = (line.qtyPerUnit || 0) * (cases || 0);
  const comp = escapeHtml(line.componentSku);

  // Not batch-tracked: used qty follows cases produced; only wastage is editable.
  if (line.isBatchTracked === false) {
    const u = (entry.componentUsage || []).find((x) => x.componentSku === line.componentSku && !x.batchNumber);
    const w = u ? (u.wastage || 0) : 0;
    return '<div class="comp-block">' +
      '<div class="comp-head">' +
        '<div><div class="comp-name">' + escapeHtml(line.componentDescription || line.componentSku) + '</div>' +
        '<div class="comp-code">' + comp + ' · ' + fmtNum(line.qtyPerUnit) + ' per case · not batch-tracked</div></div>' +
        '<div class="comp-req">need ' + fmtNum(required) + '</div>' +
      '</div>' +
      '<div class="usage-line"><span class="qty">' + fmtNum(required) + ' used · auto from cases produced</span></div>' +
      '<div class="add-usage"><input type="number" min="0" step="1" placeholder="wastage" value="' + (w || '') + '" data-nonbatch-wastage="' + id + '" data-comp="' + comp + '"></div>' +
    '</div>';
  }

  const usage = (entry.componentUsage || []).filter((u) => u.componentSku === line.componentSku);
  const used = usage.reduce((s, u) => s + (u.qtyUsed || 0), 0);
  const batchInfo = (bn) => (compBatches ? compBatches.batches.find((b) => b.batchNumber === bn) : null);

  let out = '<div class="comp-block">' +
    '<div class="comp-head">' +
      '<div><div class="comp-name">' + escapeHtml(line.componentDescription || line.componentSku) + '</div>' +
      '<div class="comp-code">' + comp + ' · ' + fmtNum(line.qtyPerUnit) + ' per case</div></div>' +
      '<div class="comp-req">need ' + fmtNum(required) + '</div>' +
    '</div>';

  // The server's line stock already has this job's usage taken off, so a
  // batch is over-drawn when what's left at the line has gone negative.
  const isOver = (bn) => { const b = batchInfo(bn); return !b || b.quantityRemaining < 0; };
  const pickable = compBatches ? compBatches.batches.filter((b) => b.quantityRemaining > 0) : [];
  out += usage.map((u) => {
    const over = isOver(u.batchNumber);
    return '<div class="usage-line" style="' + (over ? 'color:var(--danger)' : '') + '">' +
      '<span class="batch-no">' + escapeHtml(u.batchNumber) + '</span>' +
      (over ? '<span title="More than was sent to this line">⚠</span>' : '') +
      '<span class="qty">' + fmtNum(u.qtyUsed) + ' used' + (u.wastage ? ', ' + fmtNum(u.wastage) + ' wastage' : '') + '</span>' +
      '<button type="button" class="rm" data-rm-usage="' + id + '" data-comp="' + comp + '" data-batch="' + escapeHtml(u.batchNumber) + '">✕</button>' +
    '</div>';
  }).join('');

  let cls = 'ok', text = 'on track';
  if (used === 0 && required > 0) { cls = 'warn'; text = 'no batch selected yet'; }
  else if (used < required) { cls = 'warn'; text = fmtNum(required - used) + ' short of what\'s needed'; }
  else if (used > required) { cls = 'warn'; text = fmtNum(used - required) + ' more than needed'; }
  if (usage.some((u) => isOver(u.batchNumber))) { cls = 'bad'; text = 'exceeds what a selected batch had at this line'; }
  out += '<div class="status-strip"><span class="status-badge ' + cls + '">' + text + '</span></div>';

  if (pickable.length === 0 && usage.length === 0) {
    out += '<div class="no-batches" style="margin-top:8px;">No batches of ' + comp + ' left at ' + escapeHtml(entry.line || 'this line') + ' — complete a Stock Requisition for it first.</div>';
  } else {
    out += '<button type="button" class="' + (usage.length ? 'btn-ghost' : 'btn-primary') + ' btn-small pick-btn" data-pick-batches="' + id + '" data-comp="' + comp + '">' +
      (usage.length ? 'Change batches…' : 'Select batches…') + '</button>';
  }
  return out + '</div>';
}

// ---------- mutations ----------

async function save(id, patch) {
  try {
    state.entries[id] = await api('PATCH', '/schedule/' + encodeURIComponent(id), patch);
    if (state.notice?.id === id) state.notice = null;
    if ('componentUsage' in patch || 'actualCases' in patch || 'line' in patch) await refreshLineBatches();
  } catch (err) {
    // Shown in the job itself — the banner at the top is often off screen.
    state.expanded = { [id]: true };
    state.notice = { id, text: err.message };
  }
  renderJobList();
  showNotice();
}

// A message inside the open job, scrolled into view.
function showNotice() {
  if (!state.notice) return;
  const el = document.getElementById('notice-' + state.notice.id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// The batch pop-up for one component: what's at the line (plus what this
// job already has, which the line stock has taken off), used and wastage.
async function pickBatches(id, componentSku) {
  const entry = state.entries[id];
  const recipe = state.recipes[entry.sku];
  const line = recipe?.lines.find((l) => l.componentSku === componentSku);
  const cases = hasValue(entry.actualCases) ? entry.actualCases : entry.plannedCases;
  const mine = (entry.componentUsage || []).filter((u) => u.componentSku === componentSku);
  const atLine = state.lineBatches[entry.line + '|' + componentSku]?.batches || [];
  const batches = atLine.map((b) => {
    const u = mine.find((x) => x.batchNumber === b.batchNumber);
    return { batchNumber: b.batchNumber, expiryDate: b.expiryDate, available: b.quantityRemaining + (u ? (u.qtyUsed || 0) + (u.wastage || 0) : 0) };
  }).filter((b) => b.available > 0 || mine.some((u) => u.batchNumber === b.batchNumber));
  const picked = await openBatchDialog({
    title: componentSku,
    subtitle: (line?.componentDescription || '') + ' · ' + entry.sku + ' at ' + (entry.line || ''),
    required: (line?.qtyPerUnit || 0) * (cases || 0),
    batches,
    selected: mine.map((u) => ({ batchNumber: u.batchNumber, qty: u.qtyUsed, wastage: u.wastage })),
    wastage: true,
    qtyLabel: 'Qty used',
  });
  if (!picked) return;
  // Two or more batches: one production item per batch, automatically.
  if (picked.length > 1) {
    try {
      const family = await api('POST', '/schedule/' + encodeURIComponent(id) + '/split-by-batches', {
        componentSku, batches: picked.map((p) => ({ batchNumber: p.batchNumber, qty: p.qty, wastage: p.wastage })),
      });
      for (const e of family) state.entries[e.id] = e;
      await refreshLineBatches();
      state.expanded = { [id]: true };
      state.notice = { id, text: 'Split into ' + picked.length + ' production items, one per ' + componentSku + ' batch: ' +
        family.filter((e) => picked.some((p) => e.componentUsage.some((u) => u.componentSku === componentSku && u.batchNumber === p.batchNumber)))
          .map((e) => finishedBatch(e) + ' (' + fmtNum(hasValue(e.actualCases) ? e.actualCases : e.plannedCases) + ' cases)').join(', ') + '.' };
    } catch (err) {
      state.expanded = { [id]: true };
      state.notice = { id, text: err.message };
    }
    renderJobList();
    showNotice();
    return;
  }
  const others = (entry.componentUsage || []).filter((u) => u.componentSku !== componentSku);
  await save(id, { componentUsage: [...others, ...picked.map((p) => ({ componentSku, batchNumber: p.batchNumber, qtyUsed: p.qty, wastage: p.wastage }))] });
}

function removeUsage(id, componentSku, batchNumber) {
  const usage = state.entries[id].componentUsage.filter((u) => !(u.componentSku === componentSku && u.batchNumber === batchNumber));
  return save(id, { componentUsage: usage });
}

function updateNonBatchWastage(id, componentSku, wastage) {
  const usage = (state.entries[id].componentUsage || []).map((u) => ({ ...u }));
  const u = usage.find((x) => x.componentSku === componentSku && !x.batchNumber);
  if (u) u.wastage = wastage;
  else usage.push({ componentSku, batchNumber: null, qtyUsed: 0, wastage });
  return save(id, { componentUsage: usage });
}

// ---------- events ----------

const jobList = document.getElementById('jobList');

jobList.addEventListener('click', async (e) => {
  const toggle = e.target.closest('[data-toggle]');
  if (toggle && !e.target.closest('button, select, input, [data-drag]')) {
    const id = toggle.dataset.toggle;
    // One product open at a time.
    state.expanded = state.expanded[id] ? {} : { [id]: true };
    renderJobList();
    return;
  }

  const pickBtn = e.target.closest('[data-pick-batches]');
  if (pickBtn) { pickBatches(pickBtn.dataset.pickBatches, pickBtn.dataset.comp); return; }

  const rm = e.target.closest('[data-rm-usage]');
  if (rm) { removeUsage(rm.dataset.rmUsage, rm.dataset.comp, rm.dataset.batch); return; }

  const splitBtn = e.target.closest('[data-split]');
  if (splitBtn) {
    const id = splitBtn.dataset.split;
    const qty = numOrNull(splitBtn.parentElement.querySelector('[data-split-qty]').value);
    try {
      const { source, created } = await api('POST', '/schedule/' + encodeURIComponent(id) + '/split', { moveQty: qty });
      state.entries[source.id] = source;
      state.entries[created.id] = created;
      state.expanded = { [created.id]: true };
      renderJobList();
    } catch (err) { showError(err.message); }
    return;
  }

  const doneBtn = e.target.closest('[data-mark-done]');
  if (doneBtn) {
    const id = doneBtn.dataset.markDone;
    const entry = state.entries[id];
    if (entry.status === 'done') { save(id, { status: null }); return; }
    // Not without a start time.
    if (!entry.startTime) {
      state.notice = { id, text: 'No start time for ' + entry.sku + ' — press Start (or enter the start time under Production time) before completing.' };
      renderJobList();
      showNotice();
      return;
    }
    // Completed: end time = now unless one is already there (kept after a
    // reopen, which is for corrections), and the job closes.
    const patch = { status: 'done' };
    if (!entry.endTime) patch.endTime = nowHHMM();
    state.expanded = {};
    await save(id, patch);
    return;
  }

  const startBtn = e.target.closest('[data-start]');
  if (startBtn) { save(startBtn.dataset.start, { startTime: nowHHMM() }); return; }

  const clearBtn = e.target.closest('[data-clear-exported]');
  if (clearBtn) { save(clearBtn.dataset.clearExported, { exportedAt: null }); return; }

  const del = e.target.closest('[data-delete]');
  if (del) {
    confirmClick(del, async () => {
      const id = del.dataset.delete;
      try {
        await api('DELETE', '/schedule/' + encodeURIComponent(id));
        delete state.entries[id];
        await refreshLineBatches();
        renderJobList();
      } catch (err) { showError(err.message); }
    });
  }
});

jobList.addEventListener('change', (e) => {
  const field = e.target.closest('[data-edit]');
  if (field) {
    const value = 'num' in field.dataset ? numOrNull(field.value) : (field.value.trim() || null);
    const patch = { [field.dataset.edit]: value };
    // First cases produced = production has started.
    if (field.dataset.edit === 'actualCases' && value !== null && !state.entries[field.dataset.id].startTime) patch.startTime = nowHHMM();
    save(field.dataset.id, patch);
    return;
  }
  const nb = e.target.closest('[data-nonbatch-wastage]');
  if (nb) updateNonBatchWastage(nb.dataset.nonbatchWastage, nb.dataset.comp, numOrNull(nb.value) || 0);
});

jobList.addEventListener('blur', (e) => {
  const notes = e.target.closest('[data-notes]');
  if (notes && notes.value !== (state.entries[notes.dataset.notes].notes || '')) {
    save(notes.dataset.notes, { notes: notes.value });
  }
}, true);

document.getElementById('addJobForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { sku: f.sku.value.trim(), line: f.line.value, plannedCases: parseFloat(f.plannedCases.value), date: f.date.value };
  try {
    const entry = await api('POST', '/schedule', body);
    state.entries[entry.id] = entry;
    state.expanded = { [entry.id]: true };
    f.reset();
    f.date.value = body.date;
    renderJobList();
  } catch (err) { showError(err.message); }
});

document.getElementById('uploadScheduleBtn').addEventListener('click', (e) => {
  const input = document.getElementById('scheduleFileInput');
  const file = input.files && input.files[0];
  if (!file) { showError('Choose a CSV file first.'); return; }
  const status = document.getElementById('uploadStatus');
  status.hidden = true;
  busy(e.target, 'Uploading…', async () => {
    const summary = await api('POST', '/schedule/upload', await file.text());
    input.value = '';
    status.hidden = false;
    status.textContent = 'Uploaded: ' + summary.created + ' new job(s), ' + summary.updated + ' updated.';
    await loadAll();
  });
});

for (const [elId, key] of [['dateFilter', 'dateFilter'], ['lineFilter', 'lineFilter'], ['statusFilter', 'statusFilter']]) {
  document.getElementById(elId).addEventListener('change', (e) => { state[key] = e.target.value || null; renderJobList(); });
}
document.getElementById('showAllBtn').addEventListener('click', () => {
  state.dateFilter = null;
  document.getElementById('dateFilter').value = '';
  renderJobList();
});

// ---------- drag to reorder ----------

// Pointer events rather than HTML5 drag-and-drop, which iPhones don't support
// well. The dragged family block is moved through the list live; on release
// the new order is saved.
let drag = null;

jobList.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('[data-drag]');
  if (!handle || !canReorder()) return;
  e.preventDefault();
  const block = handle.closest('.job-family');
  handle.setPointerCapture(e.pointerId);
  block.classList.add('dragging');
  drag = { block, handle, before: familySequence(), lastY: e.clientY, scroll: null };
});

jobList.addEventListener('pointermove', (e) => {
  if (!drag) return;
  drag.lastY = e.clientY;
  moveDraggedTo(e.clientY);
  // Scroll the page when dragging near the top or bottom edge.
  const edge = 70;
  const speed = e.clientY < edge ? -12 : e.clientY > window.innerHeight - edge ? 12 : 0;
  if (speed && !drag.scroll) {
    drag.scroll = setInterval(() => { window.scrollBy(0, speed); if (drag) moveDraggedTo(drag.lastY); }, 16);
  } else if (!speed && drag.scroll) {
    clearInterval(drag.scroll); drag.scroll = null;
  }
});

function moveDraggedTo(y) {
  const blocks = [...jobList.querySelectorAll('.job-family')].filter((b) => b !== drag.block);
  const after = blocks.find((b) => { const r = b.getBoundingClientRect(); return y < r.top + r.height / 2; });
  if (after) { if (drag.block.nextElementSibling !== after) jobList.insertBefore(drag.block, after); }
  else if (jobList.lastElementChild !== drag.block) jobList.appendChild(drag.block);
}

const familySequence = () => [...jobList.querySelectorAll('.job-family')].map((b) => b.dataset.first);

async function endDrag() {
  if (!drag) return;
  const { block, before, scroll } = drag;
  drag = null;
  clearInterval(scroll);
  block.classList.remove('dragging');
  const visible = familySequence();
  if (visible.join() === before.join()) return;

  // The list may be filtered (one line, one status): put the moved families
  // into the slots the visible ones held, and leave the hidden ones in place.
  const dayIds = sortedIds().filter((id) => state.entries[id].date === state.dateFilter);
  const shownFamilies = new Set(visible.map((id) => state.entries[id].groupId));
  const firstOfFamily = [];
  for (const id of dayIds) {
    const g = state.entries[id].groupId;
    if (!firstOfFamily.some((x) => state.entries[x].groupId === g)) firstOfFamily.push(id);
  }
  let k = 0;
  const full = firstOfFamily.map((id) => (shownFamilies.has(state.entries[id].groupId) ? visible[k++] : id));

  try {
    const day = await api('POST', '/schedule/reorder', { date: state.dateFilter, ids: full });
    for (const e of day) state.entries[e.id] = e;
  } catch (err) {
    showError(err.message);
  }
  renderJobList();
}
jobList.addEventListener('pointerup', endDrag);
jobList.addEventListener('pointercancel', endDrag);

// ---------- exports ----------

async function runExport(btn, kind) {
  const date = document.getElementById('exportDate').value;
  if (!date) { showError('Pick a date to export first.'); return; }
  await busy(btn, 'Exporting…', async () => {
    const exp = await api('POST', '/exports/' + kind, { date });
    download(exp.url);
    if (kind === 'assemblies') await loadAll();
    renderExportHistory();
  });
}

// Every export is kept, so a download that didn't arrive can be fetched
// again — without new assembly numbers or a duplicate in Unleashed.
async function renderExportHistory() {
  const date = document.getElementById('exportDate').value;
  const el = document.getElementById('exportHistory');
  if (!date) { el.textContent = ''; return; }
  const list = (await api('GET', '/exports?date=' + date)).filter((x) => x.kind !== 'transfer');
  el.innerHTML = list.length
    ? 'Earlier exports for this date: ' + list.map((x) => '<a href="/api/exports/' + x.id + '" download>' + escapeHtml(x.kind) + ' · ' + escapeHtml(fmtTimestamp(x.created_at)) + '</a>').join(' · ')
    : '';
}

document.getElementById('exportCsvBtn').addEventListener('click', (e) => runExport(e.target, 'assemblies'));

document.getElementById('sendBtn').addEventListener('click', (e) => {
  const date = document.getElementById('exportDate').value;
  if (!date) { showError('Pick a date to send first.'); return; }
  busy(e.target, 'Sending…', async () => {
    try {
      const { results } = await api('POST', '/unleashed/send/assemblies', { date });
      const el = document.getElementById('sendResult');
      el.hidden = false;
      el.innerHTML = results.map((r) => {
        const what = escapeHtml(r.sku) + ' batch ' + (r.seq || 1);
        if (!r.ok) return '<span style="color:var(--danger);">✕ ' + what + ': ' + escapeHtml(r.error) + '</span>';
        const extra = r.already ? ' (already sent)' : r.recovered ? ' (found in Unleashed — not sent twice)' : ' (Parked)';
        const tracking = r.trackingOk === false ? ' — <span style="color:var(--warn);">batch numbers pending</span>' : '';
        return '✓ ' + what + ': ' + escapeHtml(r.number || 'sent') + extra + tracking;
      }).join('<br>');
    } finally {
      await loadAll();
    }
  });
});
document.getElementById('exportWastageBtn').addEventListener('click', (e) => runExport(e.target, 'wastage'));
document.getElementById('exportDate').addEventListener('change', renderExportHistory);

// ---------- boot ----------

const today = todayStr();
for (const id of ['jobDate', 'dateFilter', 'exportDate', 'sheetDate']) document.getElementById(id).value = today;
state.dateFilter = today;

setupFocus(
  {
    addJobSection: ['jobListSection', 'jobList', 'addJobSection'],
    uploadScheduleSection: ['uploadScheduleSection', 'jobListSection', 'jobList'],
    jobListSection: ['jobListSection', 'jobList', 'addJobSection'],
    exportSection: ['exportSection'],
  },
  {
    addJobSection: 'Add a product to the Production Schedule',
    uploadScheduleSection: 'Upload Production Schedule (CSV)',
    jobListSection: 'Update Production Schedule',
    exportSection: 'Export to Unleashed',
  },
  ['addJobSection', 'uploadScheduleSection', 'jobListSection', 'jobList', 'exportSection'],
);
renderSyncBanner();
loadAll().catch((err) => showError('Could not load the schedule: ' + err.message));
renderExportHistory().catch(() => {});

// ---------- printed line sheets ----------
// The paper forms: blank to complete by hand, or filled in from the app.

const slashDate = (d) => String(d || '').replace(/-/g, '/');
const SPARE_ROWS = 2; // empty rows per section for anything added on the day

function lineSheetHtml(sheet, filled) {
  const head = (title) => '<tr class="sec"><th class="prod">' + escapeHtml(title) + '</th><th>Prod Req</th>' +
    '<th class="grp">Qty Prod</th><th>Prod Date</th>' +
    '<th class="grp">Bottles</th><th>Batch No_1</th><th>Qty Used_1</th>' +
    '<th class="grp">Closures</th><th>Batch No_2</th><th>Qty Used_2</th></tr>';
  const cell = (v, cls = '') => '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + (filled && v !== null && v !== undefined ? escapeHtml(v) : '') + '</td>';
  let rows = '';
  for (const sec of sheet.sections) {
    rows += head(sec.heading);
    for (const r of sec.rows) {
      rows += '<tr><td class="prod">' + escapeHtml(r.sku) + '</td><td class="num">' + escapeHtml(fmtNum(r.planned)) + '</td>' +
        '<td class="num grp">' + (filled && r.produced !== null ? escapeHtml(fmtNum(r.produced)) : '') + '</td>' + cell(slashDate(r.prodDate), 'c') +
        cell(r.bottleSku, 'grp') + cell(r.bottleBatch) + cell(r.bottleQty, 'num') +
        cell(r.closureSku, 'grp') + cell(r.closureBatch) + cell(r.closureQty, 'num') + '</tr>';
    }
    for (let i = 0; i < SPARE_ROWS; i++) {
      rows += '<tr><td class="prod"></td><td></td><td class="grp"></td><td></td><td class="grp"></td><td></td><td></td><td class="grp"></td><td></td><td></td></tr>';
    }
  }
  let dest = '';
  for (const sec of sheet.sections) {
    const t = sec.destinationTable;
    if (!t) continue;
    dest += '<table class="ls-dest"><tr><th style="background:none; border-top:0; border-left:0;"></th>' +
      t.destinations.map((d) => '<th>' + escapeHtml(d) + '</th>').join('') + '</tr>' +
      t.rows.map((r) => '<tr><td>' + escapeHtml(r.sku) + '</td>' + r.qty.map((q) => '<td class="num">' + (q === null ? '' : escapeHtml(fmtNum(q))) + '</td>').join('') + '</tr>').join('') +
      '</table>';
  }
  return '<div class="ls-page"><div class="ls-date">Production Schedule - ' + escapeHtml(slashDate(sheet.date)) + '</div>' +
    '<table class="ls-table">' + rows + '</table>' + dest +
    '<div class="ls-foot">Completed by: <span class="line"></span> &nbsp; Signature: <span class="line"></span></div></div>';
}

async function printLineSheets(btn, filled) {
  const date = document.getElementById('sheetDate').value;
  if (!date) { showError('Pick a production date first.'); return; }
  await busy(btn, 'Preparing…', async () => {
    const sheets = (await api('GET', '/schedule/linesheets?date=' + date)).filter((s) => s.sections.some((x) => x.rows.length));
    if (!sheets.length) throw new Error('No jobs on the Production Schedule for ' + slashDate(date) + '.');
    document.getElementById('printArea').innerHTML = sheets.map((s) => lineSheetHtml(s, filled)).join('');
    window.print();
  });
}
document.getElementById('printBlankSheetsBtn').addEventListener('click', (e) => printLineSheets(e.target, false));
document.getElementById('printFilledSheetsBtn').addEventListener('click', (e) => printLineSheets(e.target, true));
