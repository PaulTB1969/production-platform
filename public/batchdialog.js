// Batch picker pop-up, like Unleashed's "Select batch numbers": the batches
// available, a quantity box for each, Select oldest / Select none, a filter,
// and a running "84 / 84" count. Used for component batches on the
// Production Schedule, raw-material batches on requisitions, and finished-
// goods batches on the truck sheets.
//
// openBatchDialog({
//   title: 'P330SP_MFSIG_PN', subtitle: '330ml Pet sparkling…',
//   required: 84,                    // target total (null = no target)
//   batches: [{ batchNumber, expiryDate, available, note }],   // oldest first
//   selected: [{ batchNumber, qty, wastage }],
//   wastage: false,                  // also ask for wastage per batch
//   allowOther: false,               // a batch typed in that isn't listed
//   qtyLabel: 'Quantity',
//   refresh: async () => batches,    // optional: fetch the latest list (e.g.
//                                    // live from Unleashed) while it's open
// }) -> Promise<[{ batchNumber, qty, wastage }] | null>   (null = cancelled)

import { escapeHtml, fmtNum } from './common.js';

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function openBatchDialog(opts) {
  const { title, subtitle = '', required = null, batches = [], selected = [], wastage = false, allowOther = false, qtyLabel = 'Quantity', refresh = null } = opts;
  // Listed batches, plus any already selected that are no longer listed.
  const rows = batches.map((b) => ({ ...b }));
  for (const s of selected) {
    if (!rows.some((r) => r.batchNumber === s.batchNumber)) rows.push({ batchNumber: s.batchNumber, expiryDate: null, available: null, note: 'not in the list' });
  }
  const pick = new Map(selected.map((s) => [s.batchNumber, { qty: num(s.qty), wastage: num(s.wastage) }]));

  const dlg = document.createElement('dialog');
  dlg.className = 'bdialog';
  dlg.innerHTML =
    '<form method="dialog" class="bd-form">' +
      '<button type="button" class="bd-x" aria-label="Close" data-cancel>×</button>' +
      '<div class="bd-title">Select batch numbers for <b>' + escapeHtml(title) + '</b>' + (subtitle ? ' — ' + escapeHtml(subtitle) : '') + '</div>' +
      '<div class="bd-tools">' +
        '<label>Filter batch number <input type="text" class="bd-filter" autocomplete="off"></label>' +
        '<span class="bd-links"><button type="button" class="bd-link" data-oldest>Select oldest</button> | <button type="button" class="bd-link" data-none>Select none</button></span>' +
      '</div>' +
      (refresh ? '<div class="bd-live">Checking Unleashed for new batches…</div>' : '') +
      '<div class="bd-scroll"><table class="bd-table"><thead><tr><th>Batch number</th><th>Expiry</th><th class="num">Available</th>' +
        '<th class="num">' + escapeHtml(qtyLabel) + '</th>' + (wastage ? '<th class="num">Wastage</th>' : '') + '</tr></thead><tbody></tbody></table></div>' +
      (allowOther ? '<div class="bd-other"><span>Another batch:</span><input type="text" class="bd-other-batch" placeholder="batch number" autocomplete="off">' +
        '<input type="number" min="0" step="1" class="bd-other-qty" placeholder="qty"><button type="button" class="btn-ghost btn-small" data-other>Add</button></div>' : '') +
      '<div class="bd-foot"><span class="bd-count"></span><span class="bd-spacer"></span>' +
        '<button type="button" class="btn-ghost btn-small" data-cancel>Cancel</button>' +
        '<button type="submit" class="btn-primary btn-small" value="save">Save</button></div>' +
    '</form>';
  document.body.appendChild(dlg);
  const tbody = dlg.querySelector('tbody');

  function draw() {
    const f = dlg.querySelector('.bd-filter').value.trim().toLowerCase();
    tbody.innerHTML = rows.filter((r) => !f || r.batchNumber.toLowerCase().includes(f) || pick.has(r.batchNumber)).map((r) => {
      const p = pick.get(r.batchNumber) || { qty: 0, wastage: 0 };
      const over = r.available !== null && r.available !== undefined && p.qty + p.wastage > r.available;
      return '<tr data-b="' + escapeHtml(r.batchNumber) + '"' + (over ? ' class="over"' : '') + '>' +
        '<td>' + escapeHtml(r.batchNumber) + (r.note ? '<small>' + escapeHtml(r.note) + '</small>' : '') + '</td>' +
        '<td>' + escapeHtml(r.expiryDate || '') + '</td>' +
        '<td class="num">' + (r.available === null || r.available === undefined ? '' : '<button type="button" class="bd-link" data-fill title="Take what is still needed from this batch">' + fmtNum(r.available) + '</button>') + '</td>' +
        '<td class="num"><input type="number" min="0" step="any" data-f="qty" value="' + (p.qty || '') + '" placeholder="0"></td>' +
        (wastage ? '<td class="num"><input type="number" min="0" step="any" data-f="wastage" value="' + (p.wastage || '') + '" placeholder="0"></td>' : '') +
      '</tr>';
    }).join('') || '<tr><td colspan="5" class="bd-empty">No batches available.</td></tr>';
    count();
  }

  const total = () => [...pick.values()].reduce((s, p) => s + p.qty, 0);
  function count() {
    const t = total();
    const el = dlg.querySelector('.bd-count');
    if (required === null || required === undefined) { el.innerHTML = 'Selected <b>' + fmtNum(t) + '</b>'; el.className = 'bd-count'; return; }
    el.innerHTML = 'Selected <b>' + fmtNum(t) + ' / ' + fmtNum(required) + '</b>' +
      (t < required ? ' · ' + fmtNum(required - t) + ' still to choose' : t > required ? ' · ' + fmtNum(t - required) + ' more than needed' : '');
    el.className = 'bd-count ' + (t === required ? 'ok' : 'warn');
  }

  const set = (b, field, v) => {
    const p = pick.get(b) || { qty: 0, wastage: 0 };
    p[field] = num(v);
    if (!p.qty && !p.wastage) pick.delete(b); else pick.set(b, p);
  };

  dlg.addEventListener('input', (e) => {
    if (e.target.classList.contains('bd-filter')) { draw(); return; }
    const tr = e.target.closest('tr[data-b]');
    if (tr && e.target.dataset.f) {
      set(tr.dataset.b, e.target.dataset.f, e.target.value);
      const r = rows.find((x) => x.batchNumber === tr.dataset.b);
      const p = pick.get(tr.dataset.b) || { qty: 0, wastage: 0 };
      tr.classList.toggle('over', r.available !== null && r.available !== undefined && p.qty + p.wastage > r.available);
      count();
    }
  });

  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-oldest]')) {
      // Oldest first, as far as each batch goes, until the target is met.
      pick.clear();
      let left = required ?? 0;
      for (const r of rows) {
        if (left <= 0) break;
        if (!(r.available > 0)) continue;
        const take = Math.min(left, r.available);
        pick.set(r.batchNumber, { qty: take, wastage: 0 });
        left -= take;
      }
      draw();
    } else if (e.target.closest('[data-none]')) {
      pick.clear();
      draw();
    } else if (e.target.closest('[data-fill]')) {
      const b = e.target.closest('tr').dataset.b;
      const r = rows.find((x) => x.batchNumber === b);
      const others = total() - (pick.get(b)?.qty || 0);
      const want = required === null || required === undefined ? r.available : Math.max(0, Math.min(r.available, required - others));
      set(b, 'qty', want);
      draw();
    } else if (e.target.closest('[data-other]')) {
      const b = dlg.querySelector('.bd-other-batch').value.trim();
      const q = num(dlg.querySelector('.bd-other-qty').value);
      if (!b) return;
      if (!rows.some((r) => r.batchNumber === b)) rows.push({ batchNumber: b, expiryDate: null, available: null, note: 'typed in' });
      set(b, 'qty', q || Math.max(0, (required ?? 0) - total()));
      dlg.querySelector('.bd-other-batch').value = '';
      dlg.querySelector('.bd-other-qty').value = '';
      draw();
    } else if (e.target.closest('[data-cancel]')) {
      finish(false);
    }
  });
  // Enter in a box doesn't save by accident (only the Save button does).
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      if (e.target.classList.contains('bd-other-batch') || e.target.classList.contains('bd-other-qty')) dlg.querySelector('[data-other]').click();
    }
  });
  // Click on the dimmed background closes it, like Cancel.
  dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) finish(false); });
  // Save, and Escape (= Cancel). Handled here rather than by the dialog's
  // own "close" event, which some browsers are slow or unreliable to send.
  dlg.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); finish(true); });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); });

  let done = null;
  function finish(saved) {
    if (!done) return;
    const resolve = done;
    done = null;
    if (dlg.open) dlg.close();
    dlg.remove();
    // In the order of the list (oldest first).
    resolve(saved ? rows.filter((r) => pick.has(r.batchNumber)).map((r) => ({ batchNumber: r.batchNumber, ...pick.get(r.batchNumber) })) : null);
  }

  draw();

  // The latest list (new receipts / assemblies since the last sync): replaces
  // the listed batches, keeping what's selected and anything typed in.
  if (refresh) {
    const live = dlg.querySelector('.bd-live');
    refresh().then((fresh) => {
      if (!done) return;
      const before = new Set(rows.map((r) => r.batchNumber));
      const added = fresh.filter((b) => !before.has(b.batchNumber)).length;
      const keep = rows.filter((r) => !fresh.some((b) => b.batchNumber === r.batchNumber) && (pick.has(r.batchNumber) || r.note === 'typed in'));
      rows.splice(0, rows.length, ...fresh.map((b) => ({ ...b })), ...keep.map((r) => (r.note === 'typed in' ? r : { ...r, available: null, note: 'not in Unleashed now' })));
      draw();
      live.textContent = 'Up to date with Unleashed' + (added ? ' · ' + added + ' new batch' + (added === 1 ? '' : 'es') + ' found' : '');
      live.classList.add(added ? 'new' : 'ok');
    }).catch(() => {
      if (!done) return;
      live.textContent = 'Couldn’t check Unleashed just now — showing batches as of the last sync.';
      live.classList.add('warn');
    });
  }

  return new Promise((resolve) => {
    done = resolve;
    dlg.showModal();
    dlg.querySelector('.bd-filter').focus();
  });
}
