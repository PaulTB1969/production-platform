// Helpers shared by the screens. Ported from the artifacts; the db/downloads
// capabilities are replaced by plain calls to this app's /api.

export const LINE_LABELS = {
  'PRD - UWH': 'PRD - UWH — Upper Warehouse',
  'PRD - LWH': 'PRD - LWH — Lower Warehouse',
  'PRD - AQB': 'PRD - AQB — AcquaBoxe',
  Other: 'Other',
};
export const LINES = ['PRD - UWH', 'PRD - LWH', 'PRD - AQB'];

export async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (typeof body === 'string') {
      opts.headers['Content-Type'] = 'text/csv';
      opts.body = body;
    } else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch('/api' + path, opts);
  if (res.status === 401) {
    // Signed out (cookie expired or password changed): back to the login page.
    location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash);
    throw new Error('Signed out — please log in again.');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function fmtNum(n) {
  if (n === null || n === undefined || isNaN(n)) return '–';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function fmtTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// "1 Oct 2026" — fixed format so the requisition name shown on screen is
// exactly the Comments text the server puts in the transfer CSV.
export function fmtDateLabel(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function lineShortCode(line) {
  const s = String(line || 'Other');
  return s.startsWith('PRD - ') ? s.slice(6) : s;
}

export function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

let errorTimer = null;
export function showError(msg) {
  const el = document.getElementById('errorBanner');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { el.hidden = true; }, 8000);
}

// Starts a browser download of a stored export (or any same-origin URL).
export function download(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Disables a button while `work` runs and reports failures.
export async function busy(btn, label, work) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await work();
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

// "Click again to confirm" for destructive buttons.
export function confirmClick(btn, action) {
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.dataset.origText = btn.textContent;
    btn.textContent = 'Confirm?';
    setTimeout(() => {
      if (btn.classList.contains('armed')) {
        btn.classList.remove('armed');
        btn.textContent = btn.dataset.origText;
      }
    }, 4000);
    return;
  }
  // Disarm before acting, so the button doesn't stay on "Confirm?".
  btn.classList.remove('armed');
  btn.textContent = btn.dataset.origText;
  action();
}

// Deep links from the hub (#section) show only that function, as before.
export function setupFocus(groups, labels, allIds) {
  function apply(hash) {
    const group = groups[hash];
    const bar = document.getElementById('focusBar');
    for (const id of allIds) {
      const el = document.getElementById(id);
      if (el) el.hidden = !!group && !group.includes(id);
    }
    bar.hidden = !group;
    if (group) document.getElementById('focusLabel').textContent = labels[hash] || '';
  }
  function onHash() {
    const hash = location.hash.replace(/^#/, '');
    apply(hash);
    const el = groups[hash] && document.getElementById(hash);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.add('deep-link-flash');
      setTimeout(() => el.classList.remove('deep-link-flash'), 1900);
    }
  }
  document.getElementById('showFullBtn').addEventListener('click', () => {
    history.replaceState(null, '', location.pathname + location.search);
    apply('');
  });
  window.addEventListener('hashchange', onHash);
  onHash();
}

export async function renderSyncBanner(extra = '') {
  const banner = document.getElementById('syncBanner');
  const text = document.getElementById('syncText');
  try {
    const s = await api('GET', '/unleashed/status');
    if (!s.configured) {
      text.textContent = 'Unleashed API not connected yet — BOMs and batch stock are as last loaded.' + extra;
      banner.classList.add('stale');
      return;
    }
    const stale = !s.syncedAt || Date.now() - new Date(s.syncedAt).getTime() > 4 * 3600e3 || s.ok === false;
    banner.classList.toggle('stale', stale);
    text.textContent = s.syncedAt
      ? `Unleashed synced ${fmtTimestamp(s.syncedAt)} · ${s.ok ? s.message : 'last sync failed: ' + s.message}` + extra
      : 'Waiting for the first Unleashed sync…' + extra;
  } catch (err) {
    text.textContent = 'Could not check the Unleashed sync status.';
  }
}

// ---------- who is signed in ----------
// The server enforces every permission; this only tidies the screens to
// match: areas the role can't see leave the menu, a view-only area hides its
// upload/add/export cards and disables inputs, and line choices shrink to
// the user's own lines.
const PAGE_AREA = { '/schedule': 'schedule', '/requisitions': 'requisitions', '/collections': 'collections', '/samples': 'samples' };
export const me = fetch('/api/me').then((r) => (r.ok ? r.json() : null)).catch(() => null);

export const canEdit = (user, area) => user?.areas?.[area] === 'edit';
export const allowedLines = (user) => (user?.lines?.length ? user.lines : LINES);

me.then((user) => {
  if (!user) return;
  const area = PAGE_AREA[location.pathname.replace(/\.html$/, '')];
  const level = area ? user.areas?.[area] : 'edit';
  document.body.classList.toggle('view-only', level === 'view');
  document.body.classList.toggle('no-unleashed', !user.actions?.unleashed);
  document.body.classList.toggle('no-approve', !user.actions?.approve);
  // Anything marked data-requires="<action>" is only for roles with that action.
  for (const el of document.querySelectorAll('[data-requires]')) {
    if (!user.actions?.[el.dataset.requires]) el.hidden = true;
  }

  // Menu: only what the role can open, plus Users & Roles and the account links.
  const list = document.getElementById('menuList');
  if (list) {
    for (const a of list.querySelectorAll('a')) {
      const linkArea = PAGE_AREA[new URL(a.href).pathname];
      if (linkArea && (user.areas?.[linkArea] || 'none') === 'none') a.remove();
    }
    if (user.actions?.manageUsers) {
      list.insertAdjacentHTML('beforeend', '<a href="/users"' + (location.pathname.startsWith('/users') ? ' aria-current="page"' : '') + '>Users &amp; Roles</a>');
    }
    // Site: name, and a switcher when the user works on more than one.
    const sites = user.sites || [];
    list.insertAdjacentHTML('beforeend',
      '<div class="menu-who">Site: <b>' + escapeHtml(user.site?.name || '') + '</b></div>' +
      (sites.length > 1 && !user.support
        ? sites.filter((s) => s.id !== user.site?.id).map((s) =>
          '<button type="button" class="menu-signout" data-switch-site="' + s.id + '">Switch to ' + escapeHtml(s.name) + '</button>').join('')
        : '') +
      '<div class="menu-who">Signed in as <b>' + escapeHtml(user.name) + '</b>' +
      (user.roleName && !user.support ? ' · ' + escapeHtml(user.roleName) : '') + '</div>' +
      (user.support ? '' : '<a href="/account">My password</a>') +
      '<form method="post" action="/logout"><button type="submit" class="menu-signout">Sign out</button></form>');
    list.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-switch-site]');
      if (!b) return;
      await api('POST', '/me/site', { siteId: Number(b.dataset.switchSite) });
      location.href = '/';
    });
  }

  // Platform support: always visible, with the way out.
  if (user.support) {
    const until = new Date(user.support.expiresAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    document.body.insertAdjacentHTML('afterbegin',
      '<div class="support-banner">Platform support session — <b>' + escapeHtml(user.name.replace(/ \(support\)$/, '')) + '</b> · ' +
      (user.support.mode === 'edit' ? '<b>can make changes</b>' : 'view only') + ' · until ' + escapeHtml(until) +
      ' · <button type="button" id="endSupportBtn">End session</button></div>');
    document.getElementById('endSupportBtn').addEventListener('click', async () => {
      await api('POST', '/support/end');
      location.href = '/login';
    });
  }

  // Line pickers: only the user's lines.
  if (user.lines?.length) {
    for (const sel of document.querySelectorAll('select')) {
      const opts = [...sel.options];
      if (!opts.some((o) => LINES.includes(o.value))) continue;
      for (const o of opts) if (o.value && !user.lines.includes(o.value)) o.remove();
      if (sel.id === 'lineFilter' && user.lines.length === 1) {
        sel.value = user.lines[0];
        sel.dispatchEvent(new Event('change'));
      }
    }
  }

  // View only: disable everything except filters, tabs and the menu.
  if (level === 'view') {
    const wrap = document.querySelector('.wrap');
    const lock = () => {
      for (const el of wrap.querySelectorAll('input, select, textarea, button')) {
        if (el.closest('[data-view-ok], .focus-bar, .tabs')) continue;
        el.disabled = true;
      }
      for (const el of wrap.querySelectorAll('[draggable="true"]')) el.draggable = false;
    };
    lock();
    new MutationObserver(lock).observe(wrap, { childList: true, subtree: true });
  }
});

// ---------- ⋮ menu ----------
// Opens below the button; closes on a choice, a click elsewhere, or Escape.
(function setupMenu() {
  const toggle = document.querySelector('.menu-toggle');
  const list = document.getElementById('menuList');
  if (!toggle || !list) return;
  const set = (open) => { list.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); };
  toggle.addEventListener('click', (e) => { e.stopPropagation(); set(list.hidden); });
  document.addEventListener('click', (e) => { if (!list.hidden && !list.contains(e.target)) set(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !list.hidden) { set(false); toggle.focus(); } });
})();
