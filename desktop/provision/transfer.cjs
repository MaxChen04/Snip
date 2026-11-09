'use strict';
// The engine's only cloud-side credential and write surface: TRANSFER_TOKEN on
// /transfer/*, plus the owner-link loopback. Neither the token nor a session is
// ever logged.

const http = require('node:http');
const crypto = require('node:crypto');
const { StepError } = require('./engine.cjs');

// Capture files and the owner's uploaded images.
const KEY_RE = /^(refs|uploads)\/[a-z0-9]+\/[A-Za-z0-9._\/-]+$/;

function validKey(key) {
  return typeof key === 'string' && KEY_RE.test(key) && !key.includes('..');
}

function encodeKey(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

/**
 * Client for /transfer/*. `fetchImpl` and `bodyFor` are injectable so tests can
 * drive it without a socket.
 */
function createTransfer({ url, token, fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  const origin = String(url || '').replace(/\/+$/, '');
  const auth = { authorization: `Bearer ${token}` };

  async function request(pathname, options = {}) {
    let response;
    // Node's fetch requires duplex: 'half' for any streamed request body. A
    // Response body is a web ReadableStream (getReader), a file stream is a
    // Node stream (pipe); both need it, so test for either.
    const streamed = Boolean(options.body) && (
      typeof options.body.getReader === 'function'
      || typeof options.body.pipe === 'function'
      || typeof options.body[Symbol.asyncIterator] === 'function'
    );
    try {
      response = await fetchImpl(`${origin}${pathname}`, {
        method: options.method || 'GET',
        headers: { ...auth, ...(options.headers || {}) },
        body: options.body,
        ...(streamed ? { duplex: 'half' } : {}),
        signal: AbortSignal.timeout(options.timeoutMs || timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      throw new StepError('TRANSFER_UNREACHABLE', 'Could not reach the cloud library.', {
        hint: 'Check this Mac’s connection, then run the same command again. Completed steps are skipped.',
        data: { cause: error.message },
      });
    }
    if (options.raw) return response;
    const text = await response.text();
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch {} }
    return { response, status: response.status, ok: response.ok, body, text };
  }

  async function status() {
    const result = await request('/transfer/status');
    if (result.status === 404) return null;
    if (result.status === 401) throw new StepError('TRANSFER_TOKEN_INVALID', 'The cloud library rejected the transfer token.', { hint: 'Retry setup; the token is replaced on the next run.' });
    if (!result.ok) throw new StepError('TRANSFER_FAILED', `The cloud library returned HTTP ${result.status} while reading status.`);
    return result.body;
  }

  async function manifest() {
    const result = await request('/transfer/manifest');
    if (result.status === 404) throw new StepError('TRANSFER_DISABLED', 'The cloud library is not accepting a copy right now.', { hint: 'Deploy the latest Snip Worker, then retry.' });
    if (result.status === 401) throw new StepError('TRANSFER_TOKEN_INVALID', 'The cloud library rejected the transfer token.');
    if (!result.ok || !result.body) throw new StepError('TRANSFER_FAILED', `The cloud library returned HTTP ${result.status} while listing its files.`);
    return result.body;
  }

  async function head(key) {
    if (!validKey(key)) throw new StepError('TRANSFER_BAD_KEY', 'A file key in the manifest is not valid.', { data: { key } });
    const result = await request(`/transfer/file/${encodeKey(key)}`, { method: 'HEAD' });
    return result.status === 200 ? Number(result.response.headers.get('content-length') || 0) : null;
  }

  async function put(key, body, { size, overwrite = false, contentType = 'application/octet-stream' } = {}) {
    if (!validKey(key)) throw new StepError('TRANSFER_BAD_KEY', 'A file key in the manifest is not valid.', { data: { key } });
    const query = overwrite ? '?overwrite=1' : '';
    const result = await request(`/transfer/file/${encodeKey(key)}${query}`, {
      method: 'PUT',
      headers: { 'content-type': contentType || 'application/octet-stream', ...(size !== undefined ? { 'content-length': String(size) } : {}) },
      body,
    });
    if (result.status === 409) return { ok: true, skipped: true, status: result.status };
    if (result.status === 413) throw new StepError('TRANSFER_TOO_LARGE', 'A file is too large for the cloud import route.', { data: { key } });
    if (!result.ok) throw new StepError('TRANSFER_FAILED', `Uploading a file failed with HTTP ${result.status}.`, { data: { key } });
    return { ok: true, skipped: false, status: result.status, body: result.body };
  }

  /** Download one object. Streams; null when the cloud library does not have it. */
  async function get(key) {
    if (!validKey(key)) throw new StepError('TRANSFER_BAD_KEY', 'A file key is not valid.', { data: { key } });
    const response = await request(`/transfer/file/${encodeKey(key)}`, { raw: true, timeoutMs: 5 * 60_000 });
    if (response.status === 404) return null;
    if (response.status === 401) throw new StepError('TRANSFER_TOKEN_INVALID', 'The cloud library rejected the transfer token.');
    if (!response.ok) throw new StepError('TRANSFER_FAILED', `Downloading a file failed with HTTP ${response.status}.`, { data: { key } });
    return response;
  }

  /** Un-pause the jobs this Mac paused. `skipped` is success. */
  async function resume(ids) {
    const list = [...new Set(ids)].filter((id) => typeof id === 'string' && /^[a-z0-9]{16}$/.test(id));
    if (!list.length) return { resumed: 0, skipped: 0 };
    if (list.length > 100) throw new StepError('TRANSFER_BAD_IDS', 'Too many paused captures to resume at once.');
    const result = await request('/transfer/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: list }),
    });
    if (!result.ok) {
      throw new StepError('TRANSFER_RESUME_FAILED', `Resuming paused captures failed with HTTP ${result.status}.`, { data: { ids: list.length } });
    }
    return result.body || { resumed: 0, skipped: 0 };
  }

  return { get, head, manifest, origin, put, request, resume, status, token };
}

function ownerSecretHash(secret) {
  return crypto.createHash('sha256').update(`snip-owner-hash-v1|${secret}`).digest('base64url').slice(0, 16);
}

/** `snip-owner-v1|<ownerId>|<expSeconds>|<nonceHex32>|<port>` signed with OWNER_LINK_SECRET. */
function mintOwnerLink({ secret, url, ownerId, port = 0, now = Date.now(), ttlSeconds = 600, nonce = crypto.randomBytes(16).toString('hex') }) {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const payload = `snip-owner-v1|${ownerId}|${exp}|${nonce}|${port}`;
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const origin = String(url).replace(/\/+$/, '');
  return { link: `${origin}/auth/owner?t=${encodeURIComponent(`${payload}.${signature}`)}`, payload, nonce, exp, ownerId };
}

const DONE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Snip</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#f6f5f2;color:#222;display:grid;place-items:center;min-height:100vh;margin:0}
p{font-size:15px}</style></head><body><p id="s">Finishing sign-in…</p>
<script>
fetch('/store',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:location.hash.replace(/^#token=/,'')})})
 .then(function(r){return r.json()}).then(function(){history.replaceState(null,'','/done');document.getElementById('s').textContent='You can close this tab and return to Snip.'})
 .catch(function(){document.getElementById('s').textContent='Sign-in could not be completed. Return to Snip and try again.'});
</script></body></html>`;

/**
 * The loopback the owner link redirects to. Binds 127.0.0.1 only, accepts one
 * token, closes after it is read or after the timeout.
 */
function startLoopback({ host = '127.0.0.1', port = 0, timeoutMs = 10 * 60_000, serverFactory = http.createServer } = {}) {
  let token = null;
  let resolveToken;
  let closed = false;
  const tokenPromise = new Promise((resolve) => { resolveToken = resolve; });

  const server = serverFactory((req, res) => {
    const url = new URL(req.url || '/', `http://${host}`);
    if (req.method === 'GET' && (url.pathname === '/done' || url.pathname === '/')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
      });
      res.end(DONE_HTML);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/store') {
      let body = '';
      req.on('data', (chunk) => { if (body.length < 8192) body += chunk; });
      req.on('end', () => {
        let value = null;
        try { value = JSON.parse(body || '{}').token; } catch {}
        if (typeof value !== 'string' || !value || token) {
          res.writeHead(token ? 409 : 400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: false }));
          return;
        }
        token = value;
        resolveToken(value);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true }));
        // Give the browser the response before the port closes.
        setTimeout(() => close(), 250).unref?.();
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const timer = setTimeout(() => {
    if (!token) {
      const error = new StepError('OWNER_LINK_TIMEOUT', 'The sign-in link was not opened in time.', {
        hint: 'Run `owner link` to mint a fresh one, or run setup again.',
      });
      resolveToken(Promise.reject(error));
    }
  }, timeoutMs);
  timer.unref?.();

  const listening = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve(Number(address && address.port));
    });
  });

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    try {
      // fetch keeps sockets alive; close them so the process can exit promptly.
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close();
    } catch {}
  }

  return {
    listening,
    token: tokenPromise,
    close,
    get closed() { return closed; },
  };
}

module.exports = {
  DONE_HTML,
  createTransfer,
  encodeKey,
  mintOwnerLink,
  ownerSecretHash,
  startLoopback,
  validKey,
};
