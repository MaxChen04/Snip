'use strict';
// Local library facts that are not storage: the origin it serves, its wrangler
// config, and the HTTP API of a running local Worker.
//
// Storage is deliberately absent here. The engine never parses Miniflare's
// on-disk layout (a wrong guess reads as an empty library and makes an empty
// copy look verified); all object access goes through library.cjs.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { StepError } = require('./engine.cjs');

const localStatePath = (dataRoot) => path.join(dataRoot, 'web/.wrangler/state');

function localOriginFromDevVars(text) {
  const match = String(text || '').match(/^PUBLIC_URL=(.*)$/m);
  const value = match && match[1] ? match[1].trim().replace(/^["']|["']$/g, '') : null;
  if (!value) return null;
  try { return new URL(value).origin; } catch { return null; }
}

/** The origin this library's Worker serves, from its .dev.vars. */
function localOrigin(dataRoot) {
  try {
    return localOriginFromDevVars(fs.readFileSync(path.join(dataRoot, 'web/.dev.vars'), 'utf8'));
  } catch {
    return null;
  }
}

/** The local wrangler config: the local override if it exists, else the tracked one. */
function localConfig(dataRoot) {
  const local = path.join(dataRoot, 'web/wrangler.local.jsonc');
  if (fs.existsSync(local)) return local;
  const tracked = path.join(dataRoot, 'web/wrangler.jsonc');
  return fs.existsSync(tracked) ? tracked : null;
}

function devVarsValue(dataRoot, key) {
  try {
    const text = fs.readFileSync(path.join(dataRoot, 'web/.dev.vars'), 'utf8');
    const match = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/** True when something accepts TCP connections at the origin. */
async function reachable(origin, timeoutMs = 1500) {
  if (!origin) return false;
  let url;
  try { url = new URL(origin); } catch { return false; }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return new Promise((resolve) => {
    const socket = net.connect({ host: url.hostname, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** A local Worker API client. Local requests authenticate with DEV_LOGIN, so no cookie. */
function createLocalApi(origin, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  async function call(pathname, options = {}) {
    const headers = { 'sec-fetch-site': 'same-origin', ...(options.headers || {}) };
    let body;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      headers.origin = origin;
      body = JSON.stringify(options.body);
    }
    let response;
    try {
      response = await fetchImpl(new URL(pathname, origin), {
        method: options.method || 'GET',
        headers,
        body,
        signal: AbortSignal.timeout(options.timeoutMs || timeoutMs),
      });
    } catch (error) {
      throw new StepError('LOCAL_API_UNREACHABLE', 'Could not reach the local Snip server.', {
        hint: 'Start Snip, then try again.',
        data: { cause: error.message },
      });
    }
    const text = await response.text();
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch {} }
    return { status: response.status, ok: response.ok, body: json, text };
  }

  async function listReferences(status) {
    const items = [];
    let cursor = null;
    for (let page = 0; page < 200; page++) {
      const query = new URLSearchParams({ limit: '100' });
      if (status) query.set('status', status);
      if (cursor) query.set('cursor', cursor);
      const result = await call(`/api/references?${query}`);
      if (!result.ok) {
        throw new StepError('LOCAL_API_FAILED', `The local server refused a reference list (HTTP ${result.status}).`, {
          hint: 'Quit and reopen Snip, then try again.',
        });
      }
      for (const item of (result.body && result.body.items) || []) items.push(item);
      cursor = result.body && result.body.nextCursor;
      if (!cursor) break;
    }
    return items;
  }

  async function pauseReference(id) {
    const result = await call(`/api/references/${encodeURIComponent(id)}/pause`, { method: 'POST', body: {} });
    // 409 means it cannot be paused right now (already finished); not an error.
    return { ok: result.ok, status: result.status, reference: result.body };
  }

  async function resumeReference(id) {
    const result = await call(`/api/references/${encodeURIComponent(id)}/resume`, { method: 'POST', body: {} });
    return { ok: result.ok, status: result.status };
  }

  async function agent() {
    const result = await call('/api/agent');
    return result.ok ? result.body : null;
  }

  return { agent, call, listReferences, origin, pauseReference, resumeReference };
}

module.exports = {
  createLocalApi,
  devVarsValue,
  localConfig,
  localOrigin,
  localOriginFromDevVars,
  localStatePath,
  reachable,
};
