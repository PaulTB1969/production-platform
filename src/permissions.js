// What each API call needs. A role gives each area 'none' / 'view' / 'edit',
// plus three actions: unleashed (send to Unleashed / export CSVs), approve
// (truck sheets) and manageUsers. Reading needs 'view', changing needs 'edit'.

const RANK = { none: 0, view: 1, edit: 2 };

export function can(user, area, level = 'view') {
  return RANK[user?.areas?.[area] || 'none'] >= RANK[level];
}

export const hasAction = (user, action) => !!user?.actions?.[action];

// A user with lines only sees and changes those production lines.
export const lineAllowed = (user, line) => !user?.lines?.length || user.lines.includes(line);

// -> { area, level, action } (any may be missing) for /api<path>.
export function requiredFor(method, path) {
  const write = method !== 'GET' && method !== 'HEAD';
  const level = write ? 'edit' : 'view';

  if (/^\/(users|roles|settings|activity)(\/|$)/.test(path)) return { action: 'manageUsers' };

  if (/^\/exports\/(assemblies|wastage)$/.test(path) && write) return { area: 'schedule', level: 'edit', action: 'unleashed' };
  if (path === '/exports/transfers' && write) return { area: 'requisitions', level: 'edit', action: 'unleashed' };
  if (path === '/unleashed/send/assemblies') return { area: 'schedule', level: 'edit', action: 'unleashed' };
  if (path === '/unleashed/send/transfers') return { area: 'requisitions', level: 'edit', action: 'unleashed' };

  if (/^\/collections\/sheets\/[^/]+\/(send|csv|undo-csv)$/.test(path)) return { area: 'collections', level: 'edit', action: 'approve' };
  if (/^\/collections\/[^/]+\/arrival\/(send|csv)$/.test(path)) return { area: 'collections', level: 'edit', action: 'unleashed' };

  if (/^\/samples\/[^/]+\/[^/]+\/signoff$/.test(path)) return { area: 'samples', level: 'view', action: 'samplesSignOff' };
  if (/^\/samples(\/|$)/.test(path)) return { area: 'samples', level };
  if (/^\/schedule(\/|$)/.test(path)) return { area: 'schedule', level };
  if (/^\/requisitions(\/|$)/.test(path)) return { area: 'requisitions', level };
  if (/^\/collections(\/|$)/.test(path)) return { area: 'collections', level };
  if (path === '/stock/adjustments' && write) return { area: 'requisitions', level: 'edit' };

  // Reference data, sync, exports history, the workbook: anyone signed in.
  return {};
}

export function denialFor(user, rule) {
  if (rule.area && !can(user, rule.area, rule.level)) {
    return rule.level === 'edit' ? 'Your role can only view this — ask an admin if you need to change it.' : 'Your role does not have access to this.';
  }
  if (rule.action && !hasAction(user, rule.action)) {
    return {
      unleashed: 'Your role cannot send to Unleashed or export CSVs.',
      approve: 'Your role cannot approve truck sheets.',
      samplesSignOff: 'Your role cannot give management sign-off on sample forms.',
      manageUsers: 'Only admins can manage users and roles.',
    }[rule.action];
  }
  return null;
}

// Plain-English names for the activity log.
const LABELS = [
  [/^POST \/schedule\/upload$/, 'Uploaded the production schedule'],
  [/^POST \/schedule\/reorder$/, 'Reordered the production schedule'],
  [/^POST \/schedule\/[^/]+\/split$/, 'Split a job'],
  [/^POST \/schedule$/, 'Added a job'],
  [/^PATCH \/schedule\/[^/]+$/, 'Updated a job'],
  [/^DELETE \/schedule\/[^/]+$/, 'Deleted a job'],
  [/^POST \/requisitions\/generate$/, 'Generated requisitions'],
  [/^POST \/requisitions$/, 'Added a requisition'],
  [/^PATCH \/requisitions\/[^/]+$/, 'Updated a requisition'],
  [/^DELETE \/requisitions\/[^/]+$/, 'Deleted a requisition'],
  [/^POST \/exports\/assemblies$/, 'Exported the assemblies CSV'],
  [/^POST \/exports\/wastage$/, 'Exported the wastage CSV'],
  [/^POST \/exports\/transfers$/, 'Exported the transfers CSV'],
  [/^POST \/unleashed\/send\/assemblies$/, 'Sent assemblies to Unleashed'],
  [/^POST \/unleashed\/send\/transfers$/, 'Sent transfers to Unleashed'],
  [/^POST \/unleashed\/sync$/, 'Synced from Unleashed'],
  [/^POST \/collections\/upload$/, 'Uploaded a collection list'],
  [/^POST \/collections\/list$/, 'Added to the collection list'],
  [/^PUT \/collections\/lines\/[^/]+\/loads\/[^/]+$/, 'Set a truck load'],
  [/^POST \/collections\/sheets\/[^/]+\/loaded$/, 'Marked a truck loaded / back to loading'],
  [/^POST \/collections\/sheets\/[^/]+\/send$/, 'Approved a truck sheet (sent to Unleashed)'],
  [/^POST \/collections\/sheets\/[^/]+\/csv$/, 'Approved a truck sheet (CSV)'],
  [/^POST \/collections\/sheets\/[^/]+\/undo-csv$/, 'Undid a truck sheet CSV approval'],
  [/^POST \/collections\/[^/]+\/arrival\/send$/, 'Sent a second leg to Unleashed'],
  [/^POST \/collections\/[^/]+\/arrival\/csv$/, 'Exported a second leg CSV'],
  [/^(PATCH|DELETE) \/collections\/lines\/[^/]+$/, 'Changed the collection list'],
  [/^(PATCH|DELETE) \/collections\/[^/]+$/, 'Changed a collection'],
  [/^POST \/stock\/adjustments$/, 'Adjusted line stock'],
  [/^PUT \/samples\/[^/]+\/[^/]+\/results\/.+$/, 'Filled in a sample result'],
  [/^POST \/samples\/[^/]+\/[^/]+\/sign$/, 'Signed a sample form (samples taken)'],
  [/^DELETE \/samples\/[^/]+\/[^/]+\/sign$/, 'Undid a sample form signature'],
  [/^POST \/samples\/[^/]+\/[^/]+\/signoff$/, 'Signed off a sample form (management)'],
  [/^DELETE \/samples\/[^/]+\/[^/]+\/signoff$/, 'Removed a sample form sign-off'],
  [/^POST \/users$/, 'Added a user'],
  [/^PATCH \/users\/[^/]+$/, 'Changed a user'],
  [/^POST \/users\/[^/]+\/reset-password$/, 'Reset a user’s password'],
  [/^POST \/roles$/, 'Added a role'],
  [/^PATCH \/roles\/[^/]+$/, 'Changed a role'],
  [/^DELETE \/roles\/[^/]+$/, 'Deleted a role'],
  [/^PUT \/settings\/support-access$/, 'Switched platform support access on/off'],
];

export function activityLabel(method, path) {
  const key = `${method} ${path}`;
  for (const [re, label] of LABELS) if (re.test(key)) return label;
  return key;
}

// The parts of a request worth keeping in the log (never passwords).
export function activityDetail(path, body) {
  if (typeof body === 'string') return { path, rows: Math.max(0, body.split(/\r?\n/).filter((l) => l.trim()).length - 1) };
  const detail = { path };
  if (body && typeof body === 'object') {
    for (const [k, v] of Object.entries(body)) {
      if (/password|signature/i.test(k)) continue;
      detail[k] = v;
    }
  }
  const json = JSON.stringify(detail);
  return json.length > 2000 ? { path, note: 'details too long to keep' } : detail;
}
