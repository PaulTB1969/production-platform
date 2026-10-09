// Sample Retention forms: fill in on screen, sign, sign off, and print
// (completed, or blank to fill in by hand) in the Doc No 128 layout.

import { api, busy, confirmClick, showError, escapeHtml, todayStr, fmtTimestamp, me } from '/common.js';

const state = { date: null, forms: [], tab: 'UWH', user: null };
const $ = (id) => document.getElementById(id);
const pads = {}; // 'taken' | 'signoff' -> { canvas, drawn }

const STATUS_LABEL = { new: '', started: 'started', signed: 'signed', signed_off: 'signed off' };
const slashDate = (d) => (d || '').replace(/-/g, '/');
const nowHHMM = () => new Date().toTimeString().slice(0, 5);
const current = () => state.forms.find((f) => f.form === state.tab) || state.forms[0];

async function load() {
  state.forms = await api('GET', '/samples/day?date=' + state.date);
  if (!state.forms.some((f) => f.form === state.tab) && state.forms[0]) state.tab = state.forms[0].form;
  render();
}

// ---------- on screen ----------

function renderTabs() {
  $('tabs').innerHTML = state.forms.map((f) =>
    '<button type="button" role="tab" data-tab="' + f.form + '" aria-selected="' + (f.form === state.tab) + '">' + f.form +
    (STATUS_LABEL[f.status] ? ' <span class="chip ' + f.status + '">' + STATUS_LABEL[f.status] + '</span>' : '') + '</button>').join('');
}

function render() {
  renderTabs();
  const f = current();
  if (!f) {
    $('sheet').innerHTML = '<div class="empty">Your lines have no sample forms.</div>';
    return;
  }
  const rows = f.sections.flatMap((s) => s.rows);
  const locked = f.status === 'signed' || f.status === 'signed_off';
  let html = '<div class="form-title">' + escapeHtml(f.title) + '<br>Sample Date: ' + escapeHtml(slashDate(f.date)) + '</div>';
  if (!rows.length) {
    html += '<div class="empty">No ' + f.form + ' products on the Production Schedule for this date. Print a blank form to fill in by hand.</div>';
    $('sheet').innerHTML = html;
    return;
  }
  html += '<div style="overflow-x:auto;" id="rowsArea">' + tableHtml(f, locked) + '</div>';
  html += '<div class="sign-grid">' + takenBox(f) + signOffBox(f) + '</div>';
  $('sheet').innerHTML = html;
  setupPad('taken');
  setupPad('signoff');
}

// Re-drawing just the table keeps a half-drawn signature intact.
function renderRows() {
  const f = current();
  if ($('rowsArea')) $('rowsArea').innerHTML = tableHtml(f, f.status === 'signed' || f.status === 'signed_off');
}

function tableHtml(f, locked) {
  let html = '<table class="samples">';
  for (const s of f.sections) {
    if (!s.rows.length) continue;
    html += '<tr class="section"><th>' + escapeHtml(s.heading) + '</th><th class="c">Test (Y/N)</th><th class="c">Time</th><th class="c">Pass (Y/N)</th></tr>';
    for (const r of s.rows) {
      html += '<tr data-sku="' + escapeHtml(r.sku) + '"><td class="sku">' + escapeHtml(r.sku) +
        (r.description ? '<small>' + escapeHtml(r.description) + '</small>' : '') +
        (r.onSchedule ? '' : '<span class="off">No longer on the schedule</span>') + '</td>';
      if (locked) {
        html += '<td class="c val-' + (r.test || '') + '">' + escapeHtml(r.test || '') + '</td><td class="c">' + escapeHtml(r.time || '') +
          '</td><td class="c val-' + (r.pass || '') + '">' + escapeHtml(r.pass || '') + '</td>';
      } else {
        html += '<td class="c">' + yn('test', r.test) + '</td>' +
          '<td class="c"><input type="time" data-f="time" value="' + escapeHtml(r.time || '') + '"></td>' +
          '<td class="c">' + yn('pass', r.pass) + '</td>';
      }
      html += '</tr>';
    }
  }
  return html + '</table>';
}

function yn(field, v) {
  return '<span class="yn">' + ['Y', 'N'].map((x) =>
    '<button type="button" data-f="' + field + '" data-v="' + x + '"' + (v === x ? ' class="on-' + x + '"' : '') + '>' + x + '</button>').join('') + '</span>';
}

function signedBlock(label, s) {
  return '<div class="signed-line">' + label + ': <b>' + escapeHtml(s.name) + '</b></div>' +
    '<img class="sig-img" src="' + s.signature + '" alt="Signature of ' + escapeHtml(s.name) + '">' +
    '<div class="signed-line">' + (s.date ? 'Date: ' + escapeHtml(slashDate(s.date)) + ' · ' : '') + 'signed ' + escapeHtml(fmtTimestamp(s.at)) + '</div>';
}

function padBlock(which) {
  return '<div class="pad-wrap"><canvas class="pad" id="pad-' + which + '" width="600" height="200"></canvas>' +
    '<span class="pad-hint">Sign here with your finger or mouse</span></div>';
}

function defaultName() {
  return state.user && !state.user.shared ? state.user.name : '';
}

function takenBox(f) {
  if (f.takenBy) {
    return '<div class="sign-box"><h3>Samples taken by</h3>' + signedBlock('Name', f.takenBy) +
      (f.signOff ? '' : '<div class="row-actions"><button type="button" class="btn-ghost btn-small" id="undoTakenBtn">Undo signature to make changes</button></div>') + '</div>';
  }
  return '<div class="sign-box"><h3>Samples taken by</h3>' +
    '<div class="field"><label for="takenName">Name</label><input id="takenName" value="' + escapeHtml(defaultName()) + '" autocomplete="name"></div>' +
    '<div class="field"><label>Signature</label>' + padBlock('taken') + '</div>' +
    '<div class="field"><label for="takenDate">Date</label><input id="takenDate" type="date" value="' + todayStr() + '"></div>' +
    '<div class="row-actions"><button type="button" class="btn-primary btn-small" id="signTakenBtn">Sign</button>' +
    '<button type="button" class="btn-ghost btn-small" data-clear="taken">Clear signature</button></div></div>';
}

function signOffBox(f) {
  const can = !!state.user?.actions?.samplesSignOff;
  if (f.signOff) {
    return '<div class="sign-box"><h3>Management sign-off</h3>' + signedBlock('Name', f.signOff) +
      (can ? '<div class="row-actions"><button type="button" class="btn-ghost btn-small" id="removeSignOffBtn">Remove sign-off</button></div>' : '') + '</div>';
  }
  if (!f.takenBy) {
    return '<div class="sign-box"><h3>Management sign-off</h3><div class="export-note" style="margin-top:0;">After the samples have been signed for.</div></div>';
  }
  if (!can) {
    return '<div class="sign-box"><h3>Management sign-off</h3><div class="export-note" style="margin-top:0;">Waiting for management sign-off.</div></div>';
  }
  return '<div class="sign-box"><h3>Management sign-off</h3>' +
    '<div class="field"><label for="signOffName">Name</label><input id="signOffName" value="' + escapeHtml(defaultName()) + '" autocomplete="name"></div>' +
    '<div class="field"><label>Signature</label>' + padBlock('signoff') + '</div>' +
    '<div class="row-actions"><button type="button" class="btn-primary btn-small" id="signOffBtn">Sign off</button>' +
    '<button type="button" class="btn-ghost btn-small" data-clear="signoff">Clear signature</button></div></div>';
}

// ---------- signature pad ----------

function setupPad(which) {
  const canvas = $('pad-' + which);
  if (!canvas) { delete pads[which]; return; }
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#111';
  const pad = { canvas, drawn: false };
  pads[which] = pad;
  let last = null;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height)];
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    last = pos(e);
    ctx.beginPath();
    ctx.arc(last[0], last[1], 1.2, 0, Math.PI * 2);
    ctx.fill();
    pad.drawn = true;
    canvas.nextElementSibling.hidden = true;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!last) return;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(last[0], last[1]);
    ctx.lineTo(p[0], p[1]);
    ctx.stroke();
    last = p;
  });
  const end = () => { last = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

function padImage(which) {
  const pad = pads[which];
  if (!pad || !pad.drawn) throw new Error('Sign in the box first.');
  return pad.canvas.toDataURL('image/png');
}

// ---------- events ----------

$('tabs').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]');
  if (t) { state.tab = t.dataset.tab; render(); }
});

async function saveRow(tr, changes) {
  const f = current();
  const sku = tr.dataset.sku;
  const row = f.sections.flatMap((s) => s.rows).find((r) => r.sku === sku);
  const next = { test: row.test || '', time: row.time || '', pass: row.pass || '', ...changes };
  if (changes.test === 'Y' && !next.time) next.time = nowHHMM();
  Object.assign(row, next);
  renderRows();
  try {
    await api('PUT', `/samples/${f.date}/${f.form}/results/${encodeURIComponent(sku)}`, next);
    if (f.status === 'new') { f.status = 'started'; renderTabs(); }
  } catch (err) {
    showError(err.message);
    await load();
  }
}

$('sheet').addEventListener('click', (e) => {
  const b = e.target.closest('.yn button');
  if (b) {
    const tr = b.closest('tr');
    const f = current();
    const row = f.sections.flatMap((s) => s.rows).find((r) => r.sku === tr.dataset.sku);
    // Tapping the chosen answer again clears it.
    saveRow(tr, { [b.dataset.f]: row[b.dataset.f] === b.dataset.v ? '' : b.dataset.v });
    return;
  }
  const clear = e.target.closest('[data-clear]');
  if (clear) {
    const pad = pads[clear.dataset.clear];
    if (pad) {
      pad.canvas.getContext('2d').clearRect(0, 0, pad.canvas.width, pad.canvas.height);
      pad.drawn = false;
      pad.canvas.nextElementSibling.hidden = false;
    }
    return;
  }
  const f = current();
  const base = `/samples/${f.date}/${f.form}`;
  const replace = (updated) => { state.forms = state.forms.map((x) => (x.form === updated.form ? updated : x)); render(); };
  if (e.target.id === 'signTakenBtn') {
    busy(e.target, 'Signing…', async () => replace(await api('POST', base + '/sign', {
      name: $('takenName').value, signature: padImage('taken'), signedDate: $('takenDate').value,
    })));
  } else if (e.target.id === 'undoTakenBtn') {
    confirmClick(e.target, () => busy(e.target, 'Undoing…', async () => replace(await api('DELETE', base + '/sign'))));
  } else if (e.target.id === 'signOffBtn') {
    busy(e.target, 'Signing…', async () => replace(await api('POST', base + '/signoff', {
      name: $('signOffName').value, signature: padImage('signoff'),
    })));
  } else if (e.target.id === 'removeSignOffBtn') {
    confirmClick(e.target, () => busy(e.target, 'Removing…', async () => replace(await api('DELETE', base + '/signoff'))));
  }
});

$('sheet').addEventListener('change', (e) => {
  if (e.target.dataset.f === 'time') saveRow(e.target.closest('tr'), { time: e.target.value });
});

$('sampleDate').addEventListener('change', () => {
  state.date = $('sampleDate').value || todayStr();
  history.replaceState(null, '', '?date=' + state.date);
  load().catch((err) => showError(err.message));
});

// ---------- print ----------

const HEADER = '<table class="pf-head"><colgroup><col style="width:16%"><col style="width:19%"><col style="width:26%"><col style="width:17%"><col style="width:22%"></colgroup>' +
  '<tr><td class="logo"><img src="/brand/mf-logo.png" alt=""></td><td class="center" colspan="2">FOOD SAFETY SYSTEM</td><td class="center" style="font-weight:normal;">Doc No: 128</td><td class="center" style="font-weight:normal;">Rev No: 01</td></tr>' +
  '<tr><td colspan="4"><b>Subject: SAMPLE RETENTION FORM</b></td><td class="center" style="font-weight:normal;">Page 1 of 1</td></tr>' +
  '<tr><td colspan="2">Created by:</td><td>Signature: A.Wright</td><td colspan="2" rowspan="2">Revision date: 25.08.2025</td></tr>' +
  '<tr><td colspan="2">Reviewed &amp; authorized by:</td><td>Signature:&nbsp; P.Beatham</td></tr></table>';

function printPage(f, filled) {
  let rowsHtml = '';
  const hasRows = f.sections.some((s) => s.rows.length);
  f.sections.forEach((s, i) => {
    // A blank form for a day with nothing scheduled gets empty lines to write on.
    const rows = s.rows.length ? s.rows : (!hasRows && !filled ? Array.from({ length: i === 0 ? 10 : 3 }, () => ({ sku: '' })) : []);
    if (!rows.length) return;
    rowsHtml += '<tr><th class="sku">' + escapeHtml(s.heading) + '</th><th class="c">Test (Y/N)</th><th class="c">Time</th><th class="c">Pass (Y/N)</th></tr>';
    for (const r of rows) {
      rowsHtml += '<tr><td class="sku">' + escapeHtml(r.sku) + '</td>' +
        (filled ? '<td class="c">' + escapeHtml(r.test || '') + '</td><td class="c">' + escapeHtml(r.time || '') + '</td><td class="c">' + escapeHtml(r.pass || '') + '</td>'
          : '<td class="c"></td><td class="c"></td><td class="c"></td>') + '</tr>';
    }
  });
  const t = filled ? f.takenBy : null;
  const so = filled ? f.signOff : null;
  return '<div class="pf-page">' + HEADER +
    '<div class="pf-title">' + escapeHtml(f.title) + '<br>Sample Date: ' + escapeHtml(slashDate(f.date)) + '</div>' +
    '<table class="pf-table">' + rowsHtml + '</table>' +
    '<div class="pf-sign">' +
      'Samples Taken By: <span class="line">' + escapeHtml(t?.name || '') + '</span><br>' +
      'Signature: <span class="line">' + (t ? '<img src="' + t.signature + '" alt="">' : '') + '</span><br>' +
      'Date: <span class="line">' + escapeHtml(t?.date ? slashDate(t.date) : '') + '</span>' +
    '</div>' +
    '<div class="pf-foot">Management sign off:' + (so ? ' <img src="' + so.signature + '" alt=""> ' + escapeHtml(so.name) + ' · ' + escapeHtml(fmtTimestamp(so.at)) : '') + '</div>' +
    '</div>';
}

async function printForms(forms, filled) {
  $('printArea').innerHTML = forms.map((f) => printPage(f, filled)).join('');
  // Let the logo and signatures load before the print dialog opens.
  await Promise.all([...$('printArea').querySelectorAll('img')].map((img) =>
    img.complete ? null : new Promise((res) => { img.onload = img.onerror = res; })));
  window.print();
}

$('printFilledBtn').addEventListener('click', () => current() && printForms([current()], true));
$('printBlankBtn').addEventListener('click', () => current() && printForms([current()], false));
$('printBlankAllBtn').addEventListener('click', () => printForms(state.forms, false));

// ---------- start ----------
state.date = new URLSearchParams(location.search).get('date') || todayStr();
$('sampleDate').value = state.date;
me.then((u) => {
  state.user = u;
  // LWH users land on the LWH form.
  if (u?.lines?.length && !u.lines.includes('PRD - UWH')) state.tab = 'LWH';
  return load();
}).catch((err) => showError(err.message));
