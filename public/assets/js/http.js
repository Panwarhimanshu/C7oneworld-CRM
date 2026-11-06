// Minimal JSON client shared by public and staff pages.

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || 'Request failed.');
    this.status = status;
    this.code = body?.code || 'ERROR';
    this.fields = body?.fields || {};
    this.data = body || {};
  }
}

let csrfToken = null;
let onAuthLost = null;
export function setCsrfToken(token) { csrfToken = token; }
export function setAuthLostHandler(fn) { onAuthLost = fn; }

export async function request(method, url, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrfToken && method !== 'GET') headers['X-CSRF-Token'] = csrfToken;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, { code: 'NETWORK', message: 'Unable to reach the server. Check your connection and try again.' });
  }

  if (res.status === 204 || res.status === 201 && res.headers.get('content-length') === '0') return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error);
    if (onAuthLost && (res.status === 401 || err.code === 'PASSWORD_CHANGE_REQUIRED' || err.code === 'CSRF_FAILED')) onAuthLost(err);
    throw err;
  }
  return data;
}

export const http = {
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  patch: (url, body = {}) => request('PATCH', url, body),
  put: (url, body = {}) => request('PUT', url, body),
  del: (url) => request('DELETE', url),
};
