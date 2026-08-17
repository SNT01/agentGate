'use strict';
/**
 * Thin fetch wrapper for the admin API.
 *
 * The admin token is never written to localStorage/sessionStorage — it is
 * held only in React state (see App.jsx) and passed into every call here.
 * That means an XSS cannot exfiltrate it via storage APIs, and closing the
 * tab ends the session, matching the plan's "in memory only" requirement.
 */

class UnauthorizedError extends Error {}

async function call(token, path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    throw new UnauthorizedError('Unauthorized — the admin token was rejected.');
  }

  let json = null;
  try {
    json = await res.json();
  } catch (_e) {
    // Non-JSON response; leave json null and let the caller decide.
  }

  if (!res.ok) {
    const message = (json && (json.error || json.reason)) || `Request failed (HTTP ${res.status})`;
    throw new Error(message);
  }
  return json;
}

export const api = {
  health: () => call(null, '/health'),
  auditEntries: (token, limit) => call(token, `/audit${limit ? `?limit=${limit}` : ''}`),
  auditVerify: (token) => call(token, '/audit/verify'),
  identities: (token) => call(token, '/admin/identities'),
  sessions: (token) => call(token, '/admin/sessions'),
  revoke: (token, id, reason) => call(token, '/admin/revoke', { method: 'POST', body: { id, reason } }),
};

export { UnauthorizedError };
