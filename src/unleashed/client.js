// Minimal Unleashed API client.
//
// Auth (per Unleashed's API docs): every request carries
//   api-auth-id         the API ID
//   api-auth-signature  base64(HMAC-SHA256(<query string without '?'>, API key))
// Lists are paged: GET /<Resource>/<page>?pageSize=N returns
//   { Pagination: { NumberOfPages, ... }, Items: [...] }
//
// Credentials come from the environment only (UNLEASHED_API_ID /
// UNLEASHED_API_KEY) and are never logged.

import { createHmac } from 'node:crypto';

export function sign(queryString, apiKey) {
  return createHmac('sha256', apiKey).update(queryString, 'utf8').digest('base64');
}

// Unleashed returns dates as "/Date(1822176000000)/" (epoch ms). Batch
// expiry dates come as UTC midnight; the calendar date is read in the
// account's time zone so a timestamp entered as local midnight (22:00 UTC
// the day before) would still land on the right day.
const ACCOUNT_TIMEZONE = 'Africa/Johannesburg';
const toLocalDate = new Intl.DateTimeFormat('en-CA', { timeZone: ACCOUNT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

export function parseUnleashedDate(v) {
  if (!v) return null;
  const m = String(v).match(/\/Date\((-?\d+)/);
  const d = m ? new Date(Number(m[1])) : new Date(v);
  return isNaN(d.getTime()) ? null : toLocalDate.format(d); // YYYY-MM-DD
}

// Unleashed signs the query string *before* URL-encoding: a product code
// with a space ("BOX 500ST Black") is sent as %20 but signed with the space.
// Signing the encoded form gives 403 Forbidden (checked against the live API).
export function buildQuery(params) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  return {
    query: entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'),
    signed: entries.map(([k, v]) => `${k}=${v}`).join('&'),
  };
}

// Unleashed errors come back as JSON with a description, or as a list of
// field errors; keep the human-readable part for the screen.
export function unleashedMessage(text) {
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j)) return j.map((e) => e.Description || e.description || e.Message || JSON.stringify(e)).join('; ').slice(0, 400);
    return String(j.description || j.Description || j.Message || j.message || text).slice(0, 400);
  } catch {
    return String(text).slice(0, 400);
  }
}

export function createUnleashedClient({ apiId, apiKey, baseUrl, clientType }, { fetchImpl = fetch, retryDelaysMs = [2000, 6000] } = {}) {
  if (!apiId || !apiKey) return null;

  // Reads are retried on Unleashed's occasional 502/503s and dropped
  // connections (seen in the hourly sync). Writes are never retried here:
  // a retried create could duplicate; unleashedSend.js recovers those by tag.
  async function request(method, path, params = {}, body) {
    const delays = method === 'GET' ? retryDelaysMs : [];
    for (let attempt = 0; ; attempt++) {
      try {
        return await requestOnce(method, path, params, body);
      } catch (err) {
        const transient = !err.status || err.status >= 500 || err.status === 429;
        if (!transient || attempt >= delays.length) throw err;
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  }

  async function requestOnce(method, path, params, body) {
    const { query, signed } = buildQuery(params);
    const url = `${baseUrl}/${path}${query ? '?' + query : ''}`;
    const res = await fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'api-auth-id': apiId,
        'api-auth-signature': sign(signed, apiKey),
        'client-type': clientType,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const err = new Error(`Unleashed ${method} ${path} failed: HTTP ${res.status} ${unleashedMessage(text)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }

  const get = (path, params) => request('GET', path, params);
  const post = (path, body, params) => request('POST', path, params, body);
  const put = (path, body, params) => request('PUT', path, params, body);
  const del = (path) => request('DELETE', path);

  // Fetches every page of a list resource.
  async function getAll(resource, params = {}, pageSize = 200) {
    const items = [];
    for (let page = 1; ; page++) {
      const data = await get(`${resource}/${page}`, { ...params, pageSize });
      items.push(...(data.Items || []));
      const pages = data.Pagination?.NumberOfPages ?? 1;
      if (page >= pages) break;
    }
    return items;
  }

  return { get, getAll, post, put, del };
}
