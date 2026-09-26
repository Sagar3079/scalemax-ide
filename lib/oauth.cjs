'use strict';

// OAuth 2.0 authorization-code engine for ScaleMax connectors (main process only).
// Provider configuration comes from lib/oauth-catalog.cjs; callers never pass renderer-supplied URLs.
// Tokens, codes and client secrets are never logged and never appear in error messages.

const crypto = require('node:crypto');
const http = require('node:http');

const DEFAULT_PORT = 53682;
const DEFAULT_AUTHORIZE_TIMEOUT_MS = 300_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_TIMER_MS = 2_147_483_647;
const CLOSE_GRACE_MS = 500;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_ACCESS_TOKEN_CHARS = 4096;
const MAX_REFRESH_TOKEN_CHARS = 8192;
const MAX_CODE_CHARS = 4096;
const MAX_SCOPE_CHARS = 4096;
const MAX_IDENTITY_CHARS = 128;
const MAX_ERROR_CODE_CHARS = 64;
const CALLBACK_PATH = '/callback';
const SUCCESS_TEXT = 'ScaleMax received the authorization. You can close this tab.';
const FAILURE_TEXT = 'ScaleMax sign-in was not completed. Return to ScaleMax and try again.';
const SHOP_PATTERN = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
// C0/C1 controls plus bidi overrides, which could disguise an identity in the UI.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const REDIRECT_HOSTS = new Set(['127.0.0.1', 'localhost']);
// An IPv6 loopback that does not exist is not an error: 127.0.0.1 still serves the callback.
const IGNORED_IPV6_ERRORS = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);
// Core authorize parameters that provider extraParams can never override.
const RESERVED_PARAMS = new Set([
  'client_id', 'redirect_uri', 'response_type', 'state', 'scope', 'code_challenge', 'code_challenge_method',
]);

class OAuthError extends Error {
  constructor(message, code = 'OAUTH_ERROR') {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
  }
}

const verifier = () => crypto.randomBytes(32).toString('base64url');
const challenge = (value) => crypto.createHash('sha256').update(value, 'ascii').digest('base64url');

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isToken(value, maxChars) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars && PRINTABLE_ASCII.test(value);
}

function cancelledError() {
  return new OAuthError('OAuth sign-in was cancelled.', 'CANCELLED');
}

function timerDelay(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.min(value, MAX_TIMER_MS) : fallback;
}

// Provider error codes are reduced to [a-z0-9_] so nothing else from a response can leak into a message.
function sanitizeErrorCode(value) {
  const code = typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, MAX_ERROR_CODE_CHARS)
    : '';
  return code || 'unknown_error';
}

function failureCode(data, status) {
  if (isRecord(data) && typeof data.error === 'string') {
    const code = sanitizeErrorCode(data.error);
    if (code !== 'unknown_error') return code;
  }
  if (!(status >= 200 && status <= 299)) return `http_${status}`;
  return isRecord(data) ? 'unknown_error' : 'invalid_response';
}

function hasErrorField(data) {
  return data.error !== undefined && data.error !== null && data.error !== false && data.error !== '';
}

// Dot path lookup; numeric segments index arrays. Only own properties are followed.
function readPath(value, path) {
  if (typeof path !== 'string' || !path) return undefined;
  let current = value;
  for (const segment of path.split('.')) {
    if (Array.isArray(current) && /^(0|[1-9][0-9]*)$/.test(segment)) current = current[Number(segment)];
    else if (isRecord(current) && Object.hasOwn(current, segment)) current = current[segment];
    else return undefined;
  }
  return current;
}

// The object that holds the access token also holds its refresh_token / expires_in / scope
// (for example Slack's classic authed_user block); top-level values are the fallback.
function tokenHolder(data, path) {
  const segments = path.split('.');
  if (segments.length < 2) return data;
  const parent = readPath(data, segments.slice(0, -1).join('.'));
  return isRecord(parent) ? parent : data;
}

function positiveNumber(value) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : null;
}

function scopeText(value) {
  const text = Array.isArray(value) ? value.filter((item) => typeof item === 'string').join(' ') : value;
  return typeof text === 'string' ? text.replace(CONTROL_CHARACTERS, '').slice(0, MAX_SCOPE_CHARS) : '';
}

function cleanIdentity(value) {
  let text;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
  else return null;
  text = text.replace(CONTROL_CHARACTERS, '').trim();
  if (text.length > MAX_IDENTITY_CHARS) {
    text = text.slice(0, MAX_IDENTITY_CHARS);
    // Never leave half of a surrogate pair behind.
    if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
    text = text.trim();
  }
  return text || null;
}

// `{shop}` is substituted only after the store domain passed the strict myshopify.com check.
function resolveTemplate(template, shop, label) {
  if (typeof template !== 'string' || !template) throw new OAuthError(`The OAuth ${label} URL is not configured.`);
  if (!template.includes('{shop}')) return template;
  if (typeof shop !== 'string' || !SHOP_PATTERN.test(shop)) {
    throw new OAuthError('Enter the Shopify store domain as <store>.myshopify.com.', 'INVALID_SHOP');
  }
  return template.split('{shop}').join(shop);
}

function httpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError(`The OAuth ${label} URL is invalid.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new OAuthError(`Refusing to use a non-HTTPS OAuth ${label} URL.`);
  }
  return url;
}

function setHeader(headers, name, value) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
  headers[name] = value;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function discardBody(response) {
  try {
    const pending = response?.body?.cancel?.();
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch {
    // The body is being dropped anyway.
  }
}

// Runs `run(signal)` under a timeout and an optional caller signal. Racing the abort also covers
// injected fetch implementations that ignore their signal.
async function withDeadline({ timeoutMs, signal, timeoutMessage }, run) {
  const controller = new AbortController();
  let reason = null;
  const failure = () => (reason === 'timeout' ? new OAuthError(timeoutMessage, 'TIMEOUT') : cancelledError());
  const stopped = new Promise((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(failure()), { once: true });
  });
  stopped.catch(() => {});
  const abort = (why) => {
    if (reason) return;
    reason = why;
    controller.abort();
  };
  const timer = setTimeout(() => abort('timeout'), timerDelay(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS));
  timer.unref?.();
  const onAbort = () => abort('cancelled');
  if (signal?.aborted) onAbort();
  else signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    if (reason) throw failure();
    const running = Promise.resolve().then(() => run(controller.signal));
    running.catch(() => {});
    return await Promise.race([running, stopped]);
  } catch (error) {
    if (reason) throw failure();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

async function send(fetchImpl, url, init, signal) {
  const response = await fetchImpl(url, { ...init, signal, redirect: 'error', credentials: 'omit' });
  if (!response || typeof response.status !== 'number') {
    throw new OAuthError('The OAuth provider returned an invalid response.');
  }
  if (response.redirected) {
    discardBody(response);
    throw new OAuthError('OAuth provider redirects are not allowed.');
  }
  return response;
}

// Reads at most 256 KiB, rejecting both a large declared length and an oversized stream.
async function readLimited(response, signal) {
  const tooLarge = () => new OAuthError('OAuth provider response exceeds the 256 KB limit.', 'RESPONSE_TOO_LARGE');
  const declared = response.headers?.get?.('content-length');
  if (declared && Number(declared) > MAX_RESPONSE_BYTES) {
    discardBody(response);
    throw tooLarge();
  }
  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    const stop = () => { reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', stop, { once: true });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          stop();
          throw tooLarge();
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      signal?.removeEventListener('abort', stop);
      try { reader.releaseLock(); } catch { /* A cancelled reader may already be released. */ }
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (typeof text !== 'string') return '';
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw tooLarge();
    return text;
  }
  return '';
}

// JSON first; GitHub (without an Accept header) and some older providers answer form-encoded.
function parseBody(text) {
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    try {
      return Object.fromEntries(new URLSearchParams(text));
    } catch {
      return null;
    }
  }
}

/**
 * POSTs a token request (code exchange or refresh) and returns the normalized token set.
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number|null, scope: string}>}
 */
async function tokenRequest(config, fields, options = {}) {
  const {
    fetchImpl = fetch, clientId, clientSecret = '', shop = '', timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal,
  } = options;
  if (!isRecord(config)) throw new OAuthError('OAuth provider configuration is missing.');
  if (typeof fetchImpl !== 'function') throw new OAuthError('A fetch implementation is required.');
  if (typeof clientId !== 'string' || !clientId) throw new OAuthError('An OAuth client ID is required.');
  const target = httpsUrl(
    options.url === undefined ? resolveTemplate(config.tokenUrl, shop, 'token') : options.url,
    'token',
  );

  const payload = {};
  if (isRecord(fields)) {
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === 'string' && value) payload[key] = value;
    }
  }
  const secret = typeof clientSecret === 'string' ? clientSecret : '';
  // Public clients registered as secret 'none' must never send a secret, not even through Basic auth.
  const sendSecret = Boolean(secret) && config.secret !== 'none';
  const headers = { Accept: 'application/json' };
  if (config.tokenAuth === 'basic' && sendSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${secret}`, 'utf8').toString('base64')}`;
  } else {
    payload.client_id = clientId;
    if (sendSecret) payload.client_secret = secret;
  }
  let body;
  if (config.tokenFormat === 'json') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(payload);
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(payload).toString();
  }

  let result;
  try {
    result = await withDeadline(
      { timeoutMs, signal, timeoutMessage: 'OAuth token exchange timed out.' },
      async (requestSignal) => {
        const response = await send(fetchImpl, target.href, { method: 'POST', headers, body }, requestSignal);
        return { status: response.status, text: await readLimited(response, requestSignal) };
      },
    );
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError('Could not reach the OAuth token endpoint.', 'NETWORK_ERROR');
  }

  const { status } = result;
  const data = parseBody(result.text);
  // Slack answers 200 with ok: false, GitHub answers 200 with an error field.
  if (!(status >= 200 && status <= 299) || !data || data.ok === false || hasErrorField(data)) {
    throw new OAuthError(`OAuth token exchange failed (${failureCode(data, status)}).`, 'TOKEN_EXCHANGE_FAILED');
  }
  const tokenPath = typeof config.tokenPath === 'string' && config.tokenPath ? config.tokenPath : 'access_token';
  const accessToken = readPath(data, tokenPath);
  if (!isToken(accessToken, MAX_ACCESS_TOKEN_CHARS)) {
    throw new OAuthError('OAuth token exchange failed (missing_access_token).', 'TOKEN_EXCHANGE_FAILED');
  }
  const holder = tokenHolder(data, tokenPath);
  const pick = (key) => (holder[key] !== undefined ? holder[key] : data[key]);
  const refreshToken = pick('refresh_token');
  return {
    accessToken,
    refreshToken: isToken(refreshToken, MAX_REFRESH_TOKEN_CHARS) ? refreshToken : '',
    expiresIn: positiveNumber(pick('expires_in')),
    scope: scopeText(pick('scope')),
  };
}

/**
 * Exchanges a refresh token. When the provider returns no new refresh token (Figma), the old one is kept.
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number|null, scope: string}>}
 */
async function refresh(config, options = {}) {
  const {
    refreshToken, clientId, clientSecret = '', fetchImpl = fetch, shop = '', timeoutMs, signal,
  } = options;
  if (!isRecord(config)) throw new OAuthError('OAuth provider configuration is missing.');
  if (!isToken(refreshToken, MAX_REFRESH_TOKEN_CHARS)) {
    throw new OAuthError('No OAuth refresh token is available.', 'NO_REFRESH_TOKEN');
  }
  const template = typeof config.refreshUrl === 'string' && config.refreshUrl ? config.refreshUrl : config.tokenUrl;
  const result = await tokenRequest(
    config,
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    { fetchImpl, clientId, clientSecret, url: resolveTemplate(template, shop, 'token'), timeoutMs, signal },
  );
  return { ...result, refreshToken: result.refreshToken || refreshToken };
}

/**
 * Best-effort identity lookup for a token. Never throws.
 * @returns {Promise<{status: number|null, identity: string|null}>}
 */
async function fetchIdentity(config, accessToken, options = {}) {
  try {
    const { fetchImpl = fetch, shop = '', timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = isRecord(options) ? options : {};
    const spec = isRecord(config) && isRecord(config.identity) ? config.identity : null;
    if (!spec || typeof fetchImpl !== 'function' || !isToken(accessToken, MAX_ACCESS_TOKEN_CHARS)) {
      return { status: null, identity: null };
    }
    const url = httpsUrl(resolveTemplate(spec.url, shop, 'identity'), 'identity');
    const headers = { Accept: 'application/json' };
    let placeholderUsed = false;
    if (isRecord(spec.headers)) {
      for (const [name, value] of Object.entries(spec.headers)) {
        if (typeof value !== 'string') continue;
        if (value.includes('{access_token}')) placeholderUsed = true;
        setHeader(headers, name, value.split('{access_token}').join(accessToken));
      }
    }
    // Providers such as Shopify take the token in their own header instead of Bearer.
    if (!placeholderUsed) setHeader(headers, 'Authorization', `Bearer ${accessToken}`);
    const init = {
      method: typeof spec.method === 'string' && spec.method ? spec.method.toUpperCase() : 'GET',
      headers,
    };
    if (typeof spec.body === 'string') init.body = spec.body;
    return await withDeadline(
      { timeoutMs, timeoutMessage: 'OAuth identity request timed out.' },
      async (requestSignal) => {
        const response = await send(fetchImpl, url.href, init, requestSignal);
        const { status } = response;
        if (!(status >= 200 && status <= 299)) {
          discardBody(response);
          return { status, identity: null };
        }
        let data;
        try {
          data = JSON.parse(await readLimited(response, requestSignal));
        } catch {
          return { status, identity: null };
        }
        return { status, identity: cleanIdentity(readPath(data, spec.field)) };
      },
    );
  } catch {
    return { status: null, identity: null };
  }
}

function reply(response, status, text, extraHeaders = {}) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    Connection: 'close',
    ...extraHeaders,
  });
  response.end(text);
}

// Runs once the response was handed to the OS (or the client went away), so closing the
// server afterwards cannot cut off the page the browser is waiting for.
function afterResponse(response, callback) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    callback();
  };
  response.once('finish', run);
  response.once('close', run);
}

function stateMatches(value, expected) {
  if (typeof value !== 'string') return false;
  const actual = Buffer.from(value);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Host headers a browser sends for the loopback redirect; anything else (DNS rebinding) is ignored.
function loopbackHosts(port) {
  const hosts = new Set();
  for (const name of ['127.0.0.1', 'localhost', '[::1]']) {
    hosts.add(`${name}:${port}`);
    if (port === 80) hosts.add(name);
  }
  return hosts;
}

function listen(server, port, address) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      // Later socket errors must never crash the main process.
      server.on('error', () => {});
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, address);
  });
}

function listenFailure(error, port) {
  if (error?.code === 'EADDRINUSE') {
    return new OAuthError(
      `OAuth callback port ${port} is already in use. Close the other app using it and try again.`,
      'PORT_IN_USE',
    );
  }
  return new OAuthError(`Could not listen for the OAuth callback on port ${port}.`, 'LISTEN_FAILED');
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    // A stalled stray connection cannot hold the port for more than the grace period.
    const force = setTimeout(() => server.closeAllConnections?.(), CLOSE_GRACE_MS);
    force.unref?.();
    server.close(() => {
      clearTimeout(force);
      resolve();
    });
    server.closeIdleConnections?.();
  });
}

function closeAll(servers) {
  return Promise.all(servers.map(closeServer));
}

/**
 * Runs the loopback authorization-code flow: listens on the callback port, opens the provider's
 * https authorize page, waits for the first callback whose state matches, then exchanges the code.
 * Every listener is closed before the returned promise settles.
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number|null, scope: string}>}
 */
async function authorize(config, options = {}) {
  const {
    clientId, clientSecret = '', openExternal, fetchImpl = fetch, port = DEFAULT_PORT,
    timeoutMs = DEFAULT_AUTHORIZE_TIMEOUT_MS, shop = '', signal, onRedirect,
  } = options;
  if (!isRecord(config)) throw new OAuthError('OAuth provider configuration is missing.');
  if (typeof clientId !== 'string' || !clientId) throw new OAuthError('An OAuth client ID is required.');
  if (typeof openExternal !== 'function') throw new OAuthError('A browser opener is required for OAuth sign-in.');
  if (typeof fetchImpl !== 'function') throw new OAuthError('A fetch implementation is required.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new OAuthError('Invalid OAuth callback port.');
  const host = config.redirectHost === undefined ? '127.0.0.1' : config.redirectHost;
  if (!REDIRECT_HOSTS.has(host)) throw new OAuthError('The OAuth redirect host must be localhost or 127.0.0.1.');
  // Every provider URL is resolved and checked before anything listens or opens.
  const authorizeUrl = httpsUrl(resolveTemplate(config.authorizeUrl, shop, 'authorize'), 'authorize');
  const tokenUrl = httpsUrl(resolveTemplate(config.tokenUrl, shop, 'token'), 'token').href;
  if (signal?.aborted) throw cancelledError();

  const state = crypto.randomBytes(32).toString('base64url');
  const expectedState = Buffer.from(state);
  const codeVerifier = config.pkce ? verifier() : '';
  const outcome = deferred();
  outcome.promise.catch(() => {});
  let claimed = false; // a callback with the right state (or a failure) was accepted
  let settled = false;
  let allowedHosts = new Set();
  const succeed = (code) => {
    if (settled) return;
    settled = true;
    outcome.resolve(code);
  };
  const fail = (error) => {
    claimed = true;
    if (settled) return;
    settled = true;
    outcome.reject(error);
  };

  const onRequest = (request, response) => {
    let url;
    try {
      url = new URL(request.url || '/', 'http://127.0.0.1');
    } catch {
      reply(response, 400, 'Bad request.');
      return;
    }
    if (url.pathname !== CALLBACK_PATH) {
      reply(response, 404, 'Not found.');
      return;
    }
    if (request.method !== 'GET') {
      reply(response, 405, 'Method not allowed.', { Allow: 'GET' });
      return;
    }
    // Stray requests (wrong host or state) are answered and ignored; they never end the flow.
    if (!allowedHosts.has(String(request.headers.host || '').toLowerCase())) {
      reply(response, 400, 'Unexpected callback host.');
      return;
    }
    if (!stateMatches(url.searchParams.get('state'), expectedState)) {
      reply(response, 400, 'Invalid or expired OAuth state.');
      return;
    }
    if (claimed) {
      reply(response, 409, 'ScaleMax already handled this sign-in. You can close this tab.');
      return;
    }
    claimed = true;
    if (url.searchParams.has('error')) {
      const denied = new OAuthError(
        `Authorization was denied (${sanitizeErrorCode(url.searchParams.get('error'))}).`,
        'DENIED',
      );
      afterResponse(response, () => fail(denied));
      reply(response, 400, FAILURE_TEXT);
      return;
    }
    const code = url.searchParams.get('code');
    if (!isToken(code, MAX_CODE_CHARS)) {
      afterResponse(response, () => fail(new OAuthError('The provider did not return an authorization code.', 'NO_CODE')));
      reply(response, 400, FAILURE_TEXT);
      return;
    }
    afterResponse(response, () => succeed(code));
    reply(response, 200, SUCCESS_TEXT);
  };

  const servers = [];
  const onAbort = () => fail(cancelledError());
  signal?.addEventListener?.('abort', onAbort, { once: true });
  let timer = null;
  let redirectUri = '';
  let code;
  try {
    const primary = http.createServer(onRequest);
    servers.push(primary);
    let boundPort;
    try {
      boundPort = await listen(primary, port, '127.0.0.1');
    } catch (error) {
      throw listenFailure(error, port);
    }
    allowedHosts = loopbackHosts(boundPort);
    if (host === 'localhost') {
      // Browsers may resolve localhost to ::1 first, so the IPv6 loopback must answer too.
      const secondary = http.createServer(onRequest);
      try {
        await listen(secondary, boundPort, '::1');
        servers.push(secondary);
      } catch (error) {
        if (!IGNORED_IPV6_ERRORS.has(error?.code)) throw listenFailure(error, boundPort);
      }
    }

    if (!settled) {
      redirectUri = `http://${host}:${boundPort}${CALLBACK_PATH}`;
      const url = new URL(authorizeUrl.href);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('state', state);
      if (typeof config.scopes === 'string' && config.scopes) url.searchParams.set('scope', config.scopes);
      if (config.pkce) {
        url.searchParams.set('code_challenge', challenge(codeVerifier));
        url.searchParams.set('code_challenge_method', 'S256');
      }
      if (isRecord(config.extraParams)) {
        for (const [key, value] of Object.entries(config.extraParams)) {
          if (!RESERVED_PARAMS.has(key) && typeof value === 'string') url.searchParams.set(key, value);
        }
      }
      try {
        onRedirect?.(redirectUri);
      } catch {
        // Observers never break sign-in.
      }
      timer = setTimeout(
        () => fail(new OAuthError('OAuth sign-in timed out.', 'TIMEOUT')),
        timerDelay(timeoutMs, DEFAULT_AUTHORIZE_TIMEOUT_MS),
      );
      timer.unref?.();
      // Not awaited: the callback may arrive before the opener resolves, and a hung opener must not
      // outlive the timeout or a cancellation.
      Promise.resolve()
        .then(() => openExternal(url.href))
        .catch(() => fail(new OAuthError('Could not open the browser for sign-in.', 'BROWSER_FAILED')));
    }
    code = await outcome.promise;
  } catch (error) {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
    await closeAll(servers);
    throw error;
  }

  clearTimeout(timer);
  // Close the listeners while the code is exchanged; the port is free before authorize settles.
  const closing = closeAll(servers);
  try {
    const fields = { grant_type: 'authorization_code', code, redirect_uri: redirectUri };
    if (config.pkce) fields.code_verifier = codeVerifier;
    return await tokenRequest(config, fields, { fetchImpl, clientId, clientSecret, url: tokenUrl, signal });
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
    await closing;
  }
}

module.exports = { verifier, challenge, authorize, tokenRequest, refresh, fetchIdentity, OAuthError };
