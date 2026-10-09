// Platform admin console: customers, their sites (Unleashed accounts),
// Test & import, tracking mode, and the admin activity log.

const $ = (id) => document.getElementById(id);
const state = { customers: [], open: null, editing: null, addingSite: null, keysFor: null };

const TRACK_LABEL = { batch: 'Batch numbers', serial: 'Serial numbers', both: 'Batch + serial', none: 'No tracking' };

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const when = (t) => (t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

async function api(method, path, body) {
  const res = await fetch('/admin/api' + path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = '/admin/login'; throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let errTimer;
function showError(msg) {
  const el = $('errorBanner');
  el.textContent = msg;
  el.hidden = false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  clearTimeout(errTimer);
  errTimer = setTimeout(() => { el.hidden = true; }, 10000);
}

async function busy(btn, label, work) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { return await work(); } catch (err) { showError(err.message); } finally { btn.disabled = false; btn.textContent = orig; }
}

// ---------- customers ----------

const CUSTOMER_FIELDS = [
  ['name', 'Company name', 'wide'], ['registrationNo', 'Registration no.'], ['vatNo', 'VAT no.'],
  ['contactName', 'Contact person'], ['contactEmail', 'Contact email'], ['contactPhone', 'Contact phone'],
  ['address', 'Address', 'wide', 'textarea'], ['notes', 'Notes', 'wide', 'textarea'],
];

function customerForm(c, formId) {
  return '<form class="card card-pad" data-customer-form="' + (c?.id || 'new') + '" id="' + formId + '">' +
    '<div class="section-title">' + (c ? 'Customer details' : 'New customer') + '</div><div class="form-grid">' +
    CUSTOMER_FIELDS.map(([k, label, wide, type]) => '<div class="field' + (wide ? ' wide' : '') + '"><label>' + label + '</label>' +
      (type === 'textarea' ? '<textarea rows="2" name="' + k + '">' + esc(c?.[k]) + '</textarea>'
        : '<input name="' + k + '" value="' + esc(c?.[k]) + '"' + (k === 'contactEmail' ? ' type="email"' : '') + '>') + '</div>').join('') +
    (c ? '<div class="field"><label>Status</label><select name="status">' + ['active', 'inactive'].map((s) =>
      '<option value="' + s + '"' + (c.status === s ? ' selected' : '') + '>' + (s === 'active' ? 'Active' : 'Inactive') + '</option>').join('') + '</select></div>' : '') +
    '</div><div class="form-actions" style="margin-top:12px;"><button type="submit" class="btn-primary btn-small">' + (c ? 'Save' : 'Add customer') + '</button>' +
    '<button type="button" class="btn-ghost btn-small" data-cancel-customer>Cancel</button></div></form>';
}

function trackBadge(site) {
  if (!site.tracking) return '<span class="track track-unknown">Not imported</span>';
  return '<span class="track track-' + site.tracking + '">' + TRACK_LABEL[site.tracking] + '</span>';
}

function siteCard(s) {
  const counts = s.productCounts;
  let out = '<div class="site" data-site="' + s.id + '"><div class="site-head"><span class="name">' + esc(s.name) + '</span>' + trackBadge(s) +
    (s.status === 'inactive' ? '<span class="pill">inactive</span>' : '') + '</div>';
  if (s.importError) out += '<div class="warn-note">Last import failed: ' + esc(s.importError) + '</div>';
  out += '<dl class="facts">' +
    '<dt>Unleashed company</dt><dd>' + (esc(s.companyName) || '<i>not imported yet</i>') + '</dd>' +
    '<dt>API ID</dt><dd>' + esc(s.apiId) + ' · key stored ' + (s.hasApiKey ? '✓' : '✗') + '</dd>' +
    (s.baseCurrency ? '<dt>Currency / tax</dt><dd>' + esc(s.baseCurrency) + (s.defaultTaxRate !== null ? ' · ' + esc(s.defaultTaxRate * 100) + '% tax' : '') + '</dd>' : '') +
    (counts ? '<dt>Products</dt><dd>' + counts.total + ' active · ' + counts.batchTracked + ' batch-tracked · ' + counts.serialized + ' serialised</dd>' : '') +
    (s.productGroupCount !== null && s.productGroupCount !== undefined ? '<dt>Product groups</dt><dd>' + s.productGroupCount + '</dd>' : '') +
    '<dt>Warehouses</dt><dd>' + (s.warehouses.length ? s.warehouses.filter((w) => !w.obsolete).length + ' active' : '–') + '</dd>' +
    '<dt>Time zone</dt><dd>' + esc(s.timeZone) + '</dd>' +
    '<dt>Last import</dt><dd>' + (when(s.importedAt) || '–') + '</dd>' +
    '</dl>';
  if (s.warehouses.length) {
    out += '<details><summary class="export-note" style="cursor:pointer;">Warehouse list</summary><div class="wh-list">' +
      s.warehouses.filter((w) => !w.obsolete).map((w) => '<div><b>' + esc(w.code) + '</b> ' + esc(w.name) + (w.isDefault ? ' (default)' : '') + '</div>').join('') + '</div></details>';
  }
  out += '<div class="field" style="max-width:320px;"><label>Tracking mode</label><select data-tracking="' + s.id + '">' +
    '<option value="">' + (s.trackingDetected ? 'As detected: ' + TRACK_LABEL[s.trackingDetected] : 'As detected (import first)') + '</option>' +
    Object.entries(TRACK_LABEL).map(([k, v]) => '<option value="' + k + '"' + (s.trackingOverride === k ? ' selected' : '') + '>Always: ' + v + '</option>').join('') +
    '</select></div>';
  if (state.keysFor === s.id) {
    out += '<form class="form-grid" data-keys-form="' + s.id + '">' +
      '<div class="field"><label>New API ID (blank = keep)</label><input name="apiId" autocomplete="off"></div>' +
      '<div class="field"><label>New API key (blank = keep)</label><input name="apiKey" type="password" autocomplete="new-password"></div>' +
      '<div class="form-actions wide"><button type="submit" class="btn-primary btn-small">Save keys</button><button type="button" class="btn-ghost btn-small" data-keys-cancel>Cancel</button></div></form>';
  }
  out += '<div class="form-actions">' +
    '<button type="button" class="btn-primary btn-small" data-import="' + s.id + '">Test &amp; import from Unleashed</button>' +
    '<button type="button" class="btn-ghost btn-small" data-keys="' + s.id + '">Change API keys</button>' +
    '<button type="button" class="btn-ghost btn-small" data-site-status="' + s.id + '">' + (s.status === 'inactive' ? 'Make active' : 'Make inactive') + '</button>' +
    '</div></div>';
  return out;
}

function newSiteForm(customerId) {
  return '<form class="card card-pad" data-site-form="' + customerId + '">' +
    '<div class="section-title">Add a site (an Unleashed account)</div>' +
    '<div class="export-note" style="margin:-4px 0 12px;">In the customer’s Unleashed: <b>Integration → Unleashed API Access</b>. The key is stored encrypted and can’t be viewed again.</div>' +
    '<div class="form-grid">' +
      '<div class="field wide"><label>Site name</label><input name="name" placeholder="e.g. the company or factory name" required></div>' +
      '<div class="field"><label>API ID</label><input name="apiId" autocomplete="off" required></div>' +
      '<div class="field"><label>API key</label><input name="apiKey" type="password" autocomplete="new-password" required></div>' +
    '</div>' +
    '<details style="margin-top:8px;"><summary class="export-note" style="cursor:pointer;">Advanced</summary>' +
      '<div class="field" style="margin-top:8px;"><label>API address</label><input name="apiBaseUrl" value="https://api.unleashedsoftware.com"></div></details>' +
    '<div class="form-actions" style="margin-top:12px;"><button type="submit" class="btn-primary btn-small">Save and import</button>' +
    '<button type="button" class="btn-ghost btn-small" data-site-cancel>Cancel</button></div></form>';
}

function render() {
  const list = $('customerList');
  if (!state.customers.length) {
    list.innerHTML = '<div class="empty">No customers yet. Add the first one below.</div>';
  } else {
    list.innerHTML = state.customers.map((c) => {
      const open = state.open === c.id;
      const sitesSummary = c.sites.length ? c.sites.map((s) => esc(s.name) + ' ' + trackBadge(s)).join(' ') : '<span class="export-note">no sites yet</span>';
      let html = '<div class="cust' + (c.status === 'inactive' ? ' off' : '') + '" data-customer="' + c.id + '">' +
        '<div class="cust-head" data-open="' + c.id + '"><span class="name">' + esc(c.name) + '</span>' + sitesSummary + '</div>';
      if (open) {
        html += '<div class="cust-body">' +
          (state.editing === c.id ? customerForm(c, 'editCustomer')
            : '<dl class="facts">' + CUSTOMER_FIELDS.filter(([k]) => k !== 'name' && c[k]).map(([k, label]) =>
                '<dt>' + label + '</dt><dd>' + esc(c[k]) + '</dd>').join('') + '<dt>Status</dt><dd>' + esc(c.status) + '</dd></dl>' +
              '<div class="form-actions"><button type="button" class="btn-ghost btn-small" data-edit-customer="' + c.id + '">Edit details</button></div>') +
          '<div class="section-title" style="margin-bottom:0;">Sites</div>' +
          (c.sites.map(siteCard).join('') || '<div class="export-note">No sites yet.</div>') +
          (state.addingSite === c.id ? newSiteForm(c.id)
            : '<div class="form-actions"><button type="button" class="btn-ghost btn-small" data-add-site="' + c.id + '">Add a site</button></div>') +
          '</div>';
      }
      return html + '</div>';
    }).join('');
  }
}

async function load() {
  state.customers = await api('GET', '/customers');
  render();
  loadActivity();
}

async function loadActivity() {
  const rows = await api('GET', '/activity?limit=100');
  $('activityList').innerHTML = rows.length
    ? rows.map((r) => '<div><time>' + esc(when(r.at)) + '</time><span><b>' + esc(r.adminName) + '</b> — ' + esc(r.action) + '</span></div>').join('')
    : '<div>Nothing yet.</div>';
}

const formData = (form) => Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v)]));

// ---------- events ----------

$('addCustomerBtn').addEventListener('click', () => {
  $('newCustomer').innerHTML = customerForm(null, 'addCustomer');
  $('newCustomer').querySelector('input').focus();
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.id === 'pwForm') return;
  e.preventDefault();
  const btn = form.querySelector('button[type=submit]');
  if (form.dataset.customerForm) {
    const id = form.dataset.customerForm;
    await busy(btn, 'Saving…', async () => {
      const c = id === 'new' ? await api('POST', '/customers', formData(form)) : await api('PATCH', '/customers/' + id, formData(form));
      if (id === 'new') { $('newCustomer').innerHTML = ''; state.open = c.id; }
      state.editing = null;
      await load();
    });
  } else if (form.dataset.siteForm) {
    await busy(btn, 'Saving…', async () => {
      const s = await api('POST', '/sites', { ...formData(form), customerId: Number(form.dataset.siteForm) });
      state.addingSite = null;
      await load();
      btn.textContent = 'Importing…';
      try { await api('POST', '/sites/' + s.id + '/import'); } catch (err) { showError('Saved, but the import failed: ' + err.message); }
      await load();
    });
  } else if (form.dataset.keysForm) {
    await busy(btn, 'Saving…', async () => {
      await api('PATCH', '/sites/' + form.dataset.keysForm, formData(form));
      state.keysFor = null;
      await load();
    });
  }
});

document.addEventListener('click', async (e) => {
  const t = e.target;
  const head = t.closest('[data-open]');
  if (head && !t.closest('button, select, input')) {
    const id = Number(head.dataset.open);
    state.open = state.open === id ? null : id;
    state.editing = null; state.addingSite = null; state.keysFor = null;
    render();
    return;
  }
  if (t.matches('[data-cancel-customer]')) {
    if (t.closest('#newCustomer')) $('newCustomer').innerHTML = ''; else { state.editing = null; render(); }
  } else if (t.matches('[data-edit-customer]')) {
    state.editing = Number(t.dataset.editCustomer); render();
  } else if (t.matches('[data-add-site]')) {
    state.addingSite = Number(t.dataset.addSite); render();
  } else if (t.matches('[data-site-cancel]')) {
    state.addingSite = null; render();
  } else if (t.matches('[data-keys]')) {
    state.keysFor = Number(t.dataset.keys); render();
  } else if (t.matches('[data-keys-cancel]')) {
    state.keysFor = null; render();
  } else if (t.matches('[data-import]')) {
    await busy(t, 'Importing…', async () => { await api('POST', '/sites/' + t.dataset.import + '/import'); await load(); });
  } else if (t.matches('[data-site-status]')) {
    const site = state.customers.flatMap((c) => c.sites).find((s) => s.id === Number(t.dataset.siteStatus));
    await busy(t, 'Saving…', async () => {
      await api('PATCH', '/sites/' + site.id, { status: site.status === 'inactive' ? 'active' : 'inactive' });
      await load();
    });
  }
});

document.addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-tracking]');
  if (!sel) return;
  try {
    await api('PATCH', '/sites/' + sel.dataset.tracking, { trackingOverride: sel.value || null });
    await load();
  } catch (err) { showError(err.message); }
});

$('pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('pw1').value !== $('pw2').value) return showError('The two passwords are not the same.');
  await busy(e.target.querySelector('button'), 'Saving…', async () => {
    await api('POST', '/me/password', { next: $('pw1').value });
    location.reload();
  });
});

// ---------- start ----------
api('GET', '/me').then((me) => {
  $('who').textContent = me.name;
  if (me.mustChangePassword) { $('pwForm').hidden = false; return; }
  $('main').hidden = false;
  return load();
}).catch((err) => showError(err.message));
