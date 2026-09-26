'use strict';

// Zero-setup sign-in for remote MCP servers (MCP authorization, spec 2025-06-18 and later).
//
//   1. POST initialize without credentials; the server answers 401 with a Bearer challenge.
//   2. Protected resource metadata (RFC 9728) names the authorization server and the resource.
//   3. Authorization server metadata (RFC 8414, else OpenID discovery).
//   4. Dynamic client registration (RFC 7591) registers ScaleMax as a public loopback client,
//      so nobody has to create an OAuth app or copy a callback URL.
//   5. Authorization code + PKCE S256 through lib/oauth.cjs, with the RFC 8707 `resource`
//      parameter on the authorize, token and refresh requests.
//
// Main process only. Tokens, codes and client secrets never appear in errors or logs.

const oauth = require('./oauth.cjs');

const { OAuthError } = oauth;
const DEFAULT_PORT = 53682;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_URL_CHARS = 2048;
const MAX_CLIENT_ID_CHARS = 512;
const MAX_CLIENT_SECRET_CHARS = 4096;
const MAX_SCOPE_CHARS = 2048;
const MAX_SCOPES = 64;
const CLIENT_NAME = 'ScaleMax';
const PROTOCOL_VERSION = '2025-06-18';
const TOKEN_AUTH_METHODS = new Set(['none', 'client_secret_post', 'client_secret_basic']);
const PRINTABLE = /^[\x21-\x7e]+$/;
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message, code = 'MCP_OAUTH_FAILED') {
  return new OAuthError(message, code);
}

/** Returns the parsed https URL, or null. Credentials and fragments are refused. */
function httpsUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_CHARS) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
  return url;
}

function sameUrl(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && left.replace(/\/+$/, '') === right.replace(/\/+$/, '');
}

/**
 * Reads the Bearer challenge parameters this flow needs. Quoted and token values are accepted.
 * @returns {{resourceMetadata: string|null, scope: string|null}}
 */
function parseChallenge(header) {
  const text = typeof header === 'string' ? header : '';
  const read = (name) => {
    const match = new RegExp(`(?:^|[\\s,])${name}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^\\s,]+))`, 'i').exec(text);
    if (!match) return null;
    return (match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2]) || null;
  };
  return { resourceMetadata: read('resource_metadata'), scope: read('scope') };
}

function cleanScope(value) {
  const list = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/\s+/) : []);
  const scopes = [];
  for (const item of list) {
    if (typeof item === 'string' && item && SCOPE_TOKEN.test(item) && !scopes.includes(item)) scopes.push(item);
    if (scopes.length >= MAX_SCOPES) break;
  }
  const joined = scopes.join(' ');
  return joined.length <= MAX_SCOPE_CHARS ? joined : '';
}

function discard(response) {
  try {
    const pending = response?.body?.cancel?.();
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch { /* the body is dropped anyway */ }
}

async function readJson(response) {
  const declared = response.headers?.get?.('content-length');
  if (declared && Number(declared) > MAX_METADATA_BYTES) {
    discard(response);
    return null;
  }
  let text;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_METADATA_BYTES) return null;
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function linkSignals(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(fail('The MCP sign-in request timed out.', 'TIMEOUT')), timeoutMs);
  timer.unref?.();
  const forward = () => controller.abort(fail('MCP sign-in was cancelled.', 'CANCELLED'));
  if (signal?.aborted) forward();
  else signal?.addEventListener?.('abort', forward, { once: true });
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', forward);
    },
  };
}

/**
 * One bounded request. Redirects are refused, cookies are never sent, and the caller's
 * signal cancels it. Resolves to { status, headers, json } (json is null for non-JSON bodies).
 */
async function request(fetchImpl, url, { readBody = true, ...init }, signal) {
  const linked = linkSignals(signal, REQUEST_TIMEOUT_MS);
  try {
    const running = (async () => {
      const response = await fetchImpl(url, { ...init, signal: linked.signal, redirect: 'manual', credentials: 'omit' });
      if (!response || typeof response.status !== 'number') throw fail('The server returned an invalid response.');
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        discard(response);
        return { status: response.status, headers: response.headers, json: null, redirected: true };
      }
      let json = null;
      if (readBody) json = await readJson(response);
      else discard(response);
      return { status: response.status, headers: response.headers, json };
    })();
    running.catch(() => {});
    const aborted = new Promise((_resolve, reject) => {
      if (linked.signal.aborted) reject(linked.signal.reason);
      linked.signal.addEventListener('abort', () => reject(linked.signal.reason), { once: true });
    });
    aborted.catch(() => {});
    return await Promise.race([running, aborted]);
  } catch (error) {
    if (linked.signal.aborted && linked.signal.reason instanceof OAuthError) throw linked.signal.reason;
    if (error instanceof OAuthError) throw error;
    throw fail('Could not reach the server for sign-in.', 'NETWORK_ERROR');
  } finally {
    linked.done();
  }
}

function getJson(fetchImpl, url, signal) {
  return request(fetchImpl, url, { method: 'GET', headers: { Accept: 'application/json' } }, signal);
}

/**
 * Sends an unauthenticated initialize to learn whether the server needs sign-in.
 * @returns {Promise<{required: boolean, challenge: {resourceMetadata: string|null, scope: string|null}}>}
 */
async function probe(fetchImpl, serverUrl, signal) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: CLIENT_NAME, version: '1.0.0' } },
  });
  const result = await request(fetchImpl, serverUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body,
    readBody: false,
  }, signal);
  if (result.redirected) throw fail('The MCP server redirected the sign-in request, which is not allowed.');
  if (result.status === 401 || result.status === 403) {
    return { required: true, challenge: parseChallenge(result.headers?.get?.('www-authenticate')) };
  }
  if (result.status >= 200 && result.status < 300) return { required: false, challenge: parseChallenge('') };
  throw fail(`The MCP server returned HTTP ${result.status} before sign-in.`);
}

function wellKnownUrls(base, suffix) {
  const url = new URL(base);
  const pathPart = url.pathname.replace(/\/+$/, '');
  const urls = [];
  if (pathPart) urls.push(`${url.origin}/.well-known/${suffix}${pathPart}`);
  urls.push(`${url.origin}/.well-known/${suffix}`);
  return urls;
}

/**
 * RFC 9728 protected resource metadata. Servers from before 2025-06-18 publish none; their
 * own origin is then the authorization server.
 * @returns {Promise<{issuer: string, resource: string, scopes: string}>}
 */
async function discoverResource(fetchImpl, serverUrl, challenge, signal) {
  const server = new URL(serverUrl);
  const candidates = [];
  const advertised = httpsUrl(challenge.resourceMetadata);
  if (advertised) candidates.push(advertised.href);
  for (const candidate of wellKnownUrls(serverUrl, 'oauth-protected-resource')) {
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  for (const candidate of candidates) {
    let result;
    try {
      result = await getJson(fetchImpl, candidate, signal);
    } catch (error) {
      if (error?.code === 'CANCELLED' || error?.code === 'TIMEOUT') throw error;
      continue;
    }
    const meta = result.status === 200 ? result.json : null;
    if (!meta || !Array.isArray(meta.authorization_servers)) continue;
    const issuer = meta.authorization_servers.map(httpsUrl).find(Boolean);
    if (!issuer) continue;
    // The resource must belong to the server that is being signed in to.
    const resource = httpsUrl(meta.resource);
    const resourceValue = resource && resource.origin === server.origin ? meta.resource : serverUrl;
    return { issuer: issuer.href, resource: resourceValue, scopes: cleanScope(meta.scopes_supported) };
  }
  return { issuer: server.origin, resource: serverUrl, scopes: '' };
}

function authServerUrls(issuer) {
  const url = new URL(issuer);
  const pathPart = url.pathname.replace(/\/+$/, '');
  const urls = [];
  if (pathPart) {
    urls.push(`${url.origin}/.well-known/oauth-authorization-server${pathPart}`);
    urls.push(`${url.origin}/.well-known/openid-configuration${pathPart}`);
    urls.push(`${url.origin}${pathPart}/.well-known/openid-configuration`);
  } else {
    urls.push(`${url.origin}/.well-known/oauth-authorization-server`);
    urls.push(`${url.origin}/.well-known/openid-configuration`);
  }
  return urls;
}

/**
 * RFC 8414 / OpenID discovery. Only metadata with https endpoints, a registration endpoint and
 * PKCE S256 qualifies for a zero-setup sign-in.
 */
async function discoverAuthorizationServer(fetchImpl, issuer, signal) {
  let found = null;
  for (const candidate of authServerUrls(issuer)) {
    let result;
    try {
      result = await getJson(fetchImpl, candidate, signal);
    } catch (error) {
      if (error?.code === 'CANCELLED' || error?.code === 'TIMEOUT') throw error;
      continue;
    }
    const meta = result.status === 200 ? result.json : null;
    if (!meta || !httpsUrl(meta.authorization_endpoint) || !httpsUrl(meta.token_endpoint)) continue;
    // RFC 8414 section 3.3: the metadata must describe the issuer it was fetched for.
    if (meta.issuer !== undefined && !sameUrl(meta.issuer, issuer)) continue;
    found = meta;
    break;
  }
  if (!found) throw fail('The sign-in server for this MCP server could not be discovered.', 'DISCOVERY_FAILED');
  const methods = Array.isArray(found.code_challenge_methods_supported) ? found.code_challenge_methods_supported : [];
  if (!methods.includes('S256')) {
    throw fail('The sign-in server does not support PKCE, so ScaleMax cannot sign in securely.', 'PKCE_UNSUPPORTED');
  }
  if (!httpsUrl(found.registration_endpoint)) {
    throw fail('This MCP server does not allow automatic app registration, so one-click sign-in is unavailable.',
      'REGISTRATION_UNSUPPORTED');
  }
  const supported = Array.isArray(found.token_endpoint_auth_methods_supported)
    ? found.token_endpoint_auth_methods_supported.filter((method) => TOKEN_AUTH_METHODS.has(method))
    // RFC 8414 default when the field is omitted.
    : ['client_secret_basic'];
  return {
    issuer,
    authorizationEndpoint: found.authorization_endpoint,
    tokenEndpoint: found.token_endpoint,
    registrationEndpoint: found.registration_endpoint,
    authMethods: supported,
    scopes: cleanScope(found.scopes_supported),
  };
}

function preferredAuthMethod(methods) {
  for (const method of ['none', 'client_secret_post', 'client_secret_basic']) {
    if (methods.includes(method)) return method;
  }
  throw fail('The sign-in server offers no client authentication method ScaleMax supports.', 'REGISTRATION_UNSUPPORTED');
}

/**
 * RFC 7591 dynamic client registration of ScaleMax as a loopback client.
 * @returns {Promise<{clientId: string, clientSecret: string, tokenAuth: string}>}
 */
async function register(fetchImpl, server, { redirectUri, scope, signal }) {
  const method = preferredAuthMethod(server.authMethods);
  const metadata = {
    client_name: CLIENT_NAME,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: method,
  };
  if (scope) metadata.scope = scope;
  const result = await request(fetchImpl, server.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(metadata),
  }, signal);
  const data = result.json;
  if (!(result.status >= 200 && result.status < 300) || !data) {
    const code = data && typeof data.error === 'string' && /^[a-z0-9_]{1,64}$/.test(data.error) ? data.error : `http_${result.status}`;
    throw fail(`The sign-in server refused to register ScaleMax (${code}).`, 'REGISTRATION_FAILED');
  }
  const clientId = data.client_id;
  if (typeof clientId !== 'string' || !clientId || clientId.length > MAX_CLIENT_ID_CHARS || !PRINTABLE.test(clientId)) {
    throw fail('The sign-in server returned an invalid client registration.', 'REGISTRATION_FAILED');
  }
  const secret = typeof data.client_secret === 'string' && data.client_secret.length <= MAX_CLIENT_SECRET_CHARS
    && PRINTABLE.test(data.client_secret) ? data.client_secret : '';
  const granted = TOKEN_AUTH_METHODS.has(data.token_endpoint_auth_method) ? data.token_endpoint_auth_method : method;
  // Without an issued secret the client can only authenticate as a public client.
  return { clientId, clientSecret: secret, tokenAuth: secret ? granted : 'none' };
}

/** lib/oauth.cjs provider config for a stored MCP sign-in. */
function oauthConfig(auth) {
  const extras = auth.resource ? { resource: auth.resource } : {};
  return {
    authorizeUrl: auth.authorizationEndpoint,
    tokenUrl: auth.tokenEndpoint,
    tokenAuth: auth.tokenAuth === 'client_secret_basic' ? 'basic' : 'post',
    tokenFormat: 'form',
    scopes: auth.scope || '',
    pkce: true,
    secret: auth.tokenAuth === 'none' ? 'none' : 'optional',
    redirectHost: '127.0.0.1',
    extraParams: extras,
    tokenExtraFields: extras,
  };
}

function createMcpOAuth({ fetchImpl = fetch, port = DEFAULT_PORT, now = Date.now, oauthImpl = oauth } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  function expiresAt(expiresIn) {
    return Number.isFinite(expiresIn) && expiresIn > 0 ? now() + Math.round(expiresIn * 1000) : null;
  }

  /**
   * Discovers the server's sign-in requirements without registering anything.
   * @returns {Promise<{required: false} | {required: true, issuer: string, resource: string, scope: string,
   *   authorizationEndpoint: string, tokenEndpoint: string, registrationEndpoint: string, authMethods: string[]}>}
   */
  async function discover(serverUrl, { signal } = {}) {
    if (!httpsUrl(serverUrl)) throw fail('One-click sign-in needs an https:// MCP server URL.', 'INVALID_URL');
    const probed = await probe(fetchImpl, serverUrl, signal);
    if (!probed.required) return { required: false };
    const resource = await discoverResource(fetchImpl, serverUrl, probed.challenge, signal);
    const server = await discoverAuthorizationServer(fetchImpl, resource.issuer, signal);
    // Scope precedence (MCP 2025-11-25): the challenge, then the resource's advertised scopes.
    const scope = cleanScope(probed.challenge.scope) || resource.scopes;
    return { required: true, ...server, resource: resource.resource, scope };
  }

  /**
   * Full zero-setup sign-in: discover, register, open the browser consent page, exchange the code.
   * @returns {Promise<{required: false} | {required: true, auth: object, secrets: {clientSecret: string,
   *   accessToken: string, refreshToken: string}}>}
   */
  async function signIn({ serverUrl, openExternal, signal, timeoutMs } = {}) {
    if (typeof openExternal !== 'function') throw fail('A browser opener is required for sign-in.');
    const found = await discover(serverUrl, { signal });
    if (!found.required) return { required: false };
    const client = await register(fetchImpl, found, { redirectUri, scope: found.scope, signal });
    const auth = {
      type: 'oauth',
      issuer: found.issuer,
      resource: found.resource,
      authorizationEndpoint: found.authorizationEndpoint,
      tokenEndpoint: found.tokenEndpoint,
      clientId: client.clientId,
      tokenAuth: client.tokenAuth,
      scope: found.scope,
    };
    const tokens = await oauthImpl.authorize(oauthConfig(auth), {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      openExternal,
      fetchImpl,
      port,
      signal,
      timeoutMs,
    });
    return {
      required: true,
      auth: { ...auth, expiresAt: expiresAt(tokens.expiresIn), hasRefreshToken: Boolean(tokens.refreshToken) },
      secrets: { clientSecret: client.clientSecret, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
    };
  }

  /** Exchanges the stored refresh token. Rotating refresh tokens replace the old one. */
  async function refresh(auth, secrets, { signal } = {}) {
    const tokens = await oauthImpl.refresh(oauthConfig(auth), {
      refreshToken: secrets.refreshToken,
      clientId: auth.clientId,
      clientSecret: secrets.clientSecret,
      fetchImpl,
      signal,
    });
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || secrets.refreshToken,
      expiresAt: expiresAt(tokens.expiresIn),
    };
  }

  return { discover, signIn, refresh, redirectUri };
}

module.exports = { createMcpOAuth, parseChallenge, oauthConfig, TOKEN_AUTH_METHODS };
