'use strict';

const MAX_CONNECTORS = 100;
const MAX_TOKEN_CHARS = 4096;
const MAX_REFRESH_TOKEN_CHARS = 8192;
const MAX_LABEL_CHARS = 64;
const MAX_ERROR_CHARS = 256;
const MAX_CIPHERTEXT_CHARS = 65_536;
const MAX_CIPHERTEXT_BYTES = 32_768;
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const SCHEMA_VERSION = 2;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const HINT_PREFIX = '\u2022\u2022\u2022\u2022';
const LAST_STATUSES = new Set(['never', 'ok', 'error', 'unsupported']);
const MAX_FETCH_PARAM_CHARS = 200;
const MAX_FETCH_TEXT_CHARS = 200;
const MAX_FETCH_ISSUES = 10;
const FETCH_NAME_PATTERN = /^[a-z0-9-]{1,32}$/;
const FETCH_PARAM_KEY_PATTERN = /^[a-z0-9]{1,16}$/;
const GITHUB_SLUG_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

// OAuth client registrations live under their own top-level state key. It is not one of the
// public state keys, so the renderer's store bridge can never read it.
const OAUTH_CLIENTS_KEY = 'connectorOAuthClients';
const OAUTH_CALLBACK_PORT = 53682;
const OAUTH_REFRESH_WINDOW_MS = 60_000;
const MAX_CLIENT_ID_CHARS = 512;
const MAX_CLIENT_SECRET_CHARS = 1024;
const MAX_IDENTITY_CHARS = 128;
const SHOP_PATTERN = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;
const SECRET_MODES = new Set(['required', 'optional', 'none']);
const SECRET_STORAGES = new Set(['encrypted', 'session', 'none']);
// C0/C1 controls plus bidi overrides, which could disguise an identity in the UI.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const OAUTH_UNSUPPORTED_MESSAGE = 'This connector does not support OAuth sign-in.';
const OAUTH_NO_LOOPBACK_MESSAGE = 'This provider only accepts HTTPS redirects, so desktop sign-in is unavailable. '
  + 'Connect with an access token instead.';
const OAUTH_CANCELLED_MESSAGE = 'OAuth sign-in was cancelled.';
const OAUTH_EXPIRED_MESSAGE = 'The OAuth session expired and could not be refreshed. Connect again.';
const NO_VALIDATION_MESSAGE = 'No validation endpoint is configured for this connector yet.';

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

function statusOk(_body, status) {
  return status === 200;
}

// Provider endpoints that expose a cheap identity check for a stored token.
// `ok` receives the parsed JSON body (undefined when the body is not JSON)
// and the HTTP status; it must never inspect or echo the token.
const VALIDATION_ENDPOINTS = {
  github: {
    method: 'GET',
    url: 'https://api.github.com/user',
    headers: (token) => ({ Authorization: `Bearer ${token}` }),
    ok: (body, status) => status === 200 && isRecord(body)
      && typeof body.login === 'string' && Boolean(body.login.trim()),
  },
  sentry: {
    method: 'GET',
    url: 'https://sentry.io/api/0/organizations/',
    headers: (token) => ({ Authorization: `Bearer ${token}` }),
    ok: (_body, status) => status === 200,
  },
  notion: {
    method: 'GET',
    url: 'https://api.notion.com/v1/users/me',
    headers: (token) => ({ Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' }),
    ok: (_body, status) => status === 200,
  },
  slack: {
    method: 'POST',
    url: 'https://slack.com/api/auth.test',
    headers: (token) => ({ Authorization: `Bearer ${token}` }),
    ok: (body) => isRecord(body) && body.ok === true,
  },
  linear: {
    method: 'POST',
    url: 'https://api.linear.app/graphql',
    headers: (token) => ({ Authorization: token }),
    body: JSON.stringify({ query: '{ viewer { id } }' }),
    // Linear answers 200 even for auth failures, so the viewer payload is required.
    ok: (body, status) => status === 200 && Boolean(body?.data?.viewer),
  },
  airtable: { method: 'GET', url: 'https://api.airtable.com/v0/meta/whoami', headers: bearer, ok: statusOk },
  asana: { method: 'GET', url: 'https://app.asana.com/api/1.0/users/me', headers: bearer, ok: statusOk },
  cloudflare: {
    method: 'GET',
    url: 'https://api.cloudflare.com/client/v4/user/tokens/verify',
    headers: bearer,
    ok: (body) => isRecord(body) && body.success === true,
  },
  vercel: { method: 'GET', url: 'https://api.vercel.com/v2/user', headers: bearer, ok: statusOk },
  netlify: { method: 'GET', url: 'https://api.netlify.com/api/v1/user', headers: bearer, ok: statusOk },
  figma: {
    method: 'GET',
    url: 'https://api.figma.com/v1/me',
    // Personal access tokens use Figma's own header, not Bearer.
    headers: (token) => ({ 'X-Figma-Token': token }),
    ok: statusOk,
  },
  intercom: { method: 'GET', url: 'https://api.intercom.io/me', headers: bearer, ok: statusOk },
  hubspot: { method: 'GET', url: 'https://api.hubapi.com/account-info/2026-09/details', headers: bearer, ok: statusOk },
  sendgrid: { method: 'GET', url: 'https://api.sendgrid.com/v3/user/profile', headers: bearer, ok: statusOk },
  stripe: { method: 'GET', url: 'https://api.stripe.com/v1/balance', headers: bearer, ok: statusOk },
  discord: {
    method: 'GET',
    url: 'https://discord.com/api/v10/users/@me',
    // Token-path Discord connections are bot tokens.
    headers: (token) => ({ Authorization: `Bot ${token}` }),
    ok: statusOk,
  },
  dropbox: {
    method: 'POST',
    url: 'https://api.dropboxapi.com/2/users/get_current_account',
    headers: (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }),
    // The RPC endpoint takes no arguments, which Dropbox spells as a JSON null body.
    body: 'null',
    ok: statusOk,
  },
  zoom: { method: 'GET', url: 'https://api.zoom.us/v2/users/me', headers: bearer, ok: statusOk },
  'google-drive': { method: 'GET', url: 'https://www.googleapis.com/drive/v3/about?fields=user', headers: bearer, ok: statusOk },
  'google-calendar': {
    method: 'GET', url: 'https://www.googleapis.com/calendar/v3/calendars/primary', headers: bearer, ok: statusOk,
  },
  gmail: { method: 'GET', url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile', headers: bearer, ok: statusOk },
  onedrive: { method: 'GET', url: 'https://graph.microsoft.com/v1.0/me', headers: bearer, ok: statusOk },
  'microsoft-teams': { method: 'GET', url: 'https://graph.microsoft.com/v1.0/me', headers: bearer, ok: statusOk },
  supabase: { method: 'GET', url: 'https://api.supabase.com/v1/projects', headers: bearer, ok: statusOk },
};

class ConnectorError extends Error {
  constructor(message, code = 'CONNECTOR_ERROR') {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isBase64(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CIPHERTEXT_CHARS
    && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function isToken(value, maxChars) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars && PRINTABLE_ASCII.test(value);
}

function normalizeId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new ConnectorError('Connector id must be 1-64 lowercase letters, digits, or dashes.');
  }
  return value;
}

function normalizeToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token || token.length > MAX_TOKEN_CHARS || !PRINTABLE_ASCII.test(token)) {
    throw new ConnectorError('Connector token must be a string of at most 4096 printable ASCII characters.');
  }
  return token;
}

function normalizeLabel(value) {
  if (value === undefined) return '';
  const label = typeof value === 'string' ? value.trim() : null;
  if (label === null || label.length > MAX_LABEL_CHARS || (label && !PRINTABLE_ASCII.test(label))) {
    throw new ConnectorError('Connector label must be at most 64 printable characters.');
  }
  return label;
}

function normalizeClientId(value) {
  const clientId = typeof value === 'string' ? value.trim() : '';
  if (!clientId || clientId.length > MAX_CLIENT_ID_CHARS || !PRINTABLE_ASCII.test(clientId)) {
    throw new ConnectorError('OAuth client ID is required and must be at most 512 printable ASCII characters.');
  }
  return clientId;
}

// undefined keeps the stored secret, '' clears it, anything else must be a valid secret.
function normalizeClientSecret(value) {
  if (value === undefined) return undefined;
  const secret = typeof value === 'string' ? value.trim() : null;
  if (secret === null || secret.length > MAX_CLIENT_SECRET_CHARS || (secret && !PRINTABLE_ASCII.test(secret))) {
    throw new ConnectorError('OAuth client secret must be at most 1024 printable ASCII characters.');
  }
  return secret;
}

function normalizeShop(value) {
  const shop = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!SHOP_PATTERN.test(shop)) {
    throw new ConnectorError('Enter the Shopify store domain as <store>.myshopify.com.');
  }
  return shop;
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function cleanIdentity(value) {
  let text;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
  else return null;
  text = text.replace(CONTROL_CHARACTERS, '').trim();
  if (text.length > MAX_IDENTITY_CHARS) {
    text = text.slice(0, MAX_IDENTITY_CHARS);
    if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
    text = text.trim();
  }
  return text || null;
}

function hintFor(token) {
  // Tokens of eight characters or fewer reveal nothing, not even a tail.
  return token.length <= 8 ? HINT_PREFIX : `${HINT_PREFIX}${token.slice(-4)}`;
}

function failureMessage(status) {
  if (status === 401 || status === 403) return 'Provider rejected the stored token.';
  if (status === 429) return 'Provider rate limited the validation request.';
  return `Provider validation failed with HTTP status ${status}.`;
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

// Only messages the OAuth engine composed itself (fixed templates that never carry tokens,
// codes or secrets) are passed through; anything else becomes a generic failure.
function oauthFailure(error) {
  if (error instanceof ConnectorError) return error;
  if (error?.name === 'OAuthError' && typeof error.message === 'string' && error.message) {
    const code = typeof error.code === 'string' && /^[A-Z][A-Z_]{0,31}$/.test(error.code) ? error.code : 'OAUTH_ERROR';
    return new ConnectorError(error.message.slice(0, MAX_ERROR_CHARS), code);
  }
  return new ConnectorError('OAuth sign-in failed.', 'OAUTH_ERROR');
}

function normalizeFetchName(value, field) {
  if (typeof value !== 'string' || !FETCH_NAME_PATTERN.test(value)) {
    throw new ConnectorError(`Connector fetch ${field} must be 1-32 lowercase letters, digits, or dashes.`);
  }
  return value;
}

function normalizeFetchParams(value) {
  if (!isRecord(value)) throw new ConnectorError('Connector fetch params must be an object.');
  const params = {};
  for (const key of Object.keys(value)) {
    if (!FETCH_PARAM_KEY_PATTERN.test(key)) {
      throw new ConnectorError('Connector fetch param keys must be 1-16 lowercase letters or digits.');
    }
    const param = value[key];
    if (typeof param !== 'string' || param.length > MAX_FETCH_PARAM_CHARS || !PRINTABLE_ASCII.test(param)) {
      throw new ConnectorError(`Connector fetch param values must be at most ${MAX_FETCH_PARAM_CHARS} printable characters.`);
    }
    params[key] = param;
  }
  return params;
}

function githubSlug(value, field) {
  // Owner/repo are interpolated into the URL path, so anything that could
  // alter it (slashes, ?, #, %) is rejected outright.
  if (typeof value !== 'string' || !GITHUB_SLUG_PATTERN.test(value)) {
    throw new ConnectorError(`The github repo action requires a valid ${field} param.`);
  }
  return value;
}

function repoStatusError(status) {
  if (status === 404) return new ConnectorError('Repository not found.');
  if (status === 401 || status === 403) return new ConnectorError('Provider rejected the stored token.');
  return new ConnectorError(`Provider fetch failed with HTTP status ${status}.`);
}

function fetchText(value) {
  return typeof value === 'string' ? value.slice(0, MAX_FETCH_TEXT_CHARS) : '';
}

function fetchCount(value) {
  return Number.isInteger(value) ? value : 0;
}

// Reduces the two GitHub payloads to a fixed, bounded shape; raw provider
// bodies never leave this module and the token is never part of the summary.
function summarizeGithubRepo(repoBody, issuesBody) {
  const repo = isRecord(repoBody) ? repoBody : {};
  const rawIssues = Array.isArray(issuesBody) ? issuesBody.slice(0, MAX_FETCH_ISSUES) : [];
  return {
    repo: {
      fullName: fetchText(repo.full_name),
      description: fetchText(repo.description),
      language: fetchText(repo.language),
      stars: fetchCount(repo.stargazers_count),
      openIssues: fetchCount(repo.open_issues_count),
      pushedAt: fetchText(repo.pushed_at),
      url: fetchText(repo.html_url),
    },
    issues: rawIssues.map((issue) => {
      const item = isRecord(issue) ? issue : {};
      return { number: fetchCount(item.number), title: fetchText(item.title), state: fetchText(item.state) };
    }),
  };
}

function createConnectorStore({ store, safeStorage, fetchImpl = fetch, now = Date.now, oauth = null, oauthConfigs = {} }) {
  if (!store || typeof store.readAll !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('An internal state store is required.');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  if (typeof now !== 'function') throw new TypeError('A clock function is required.');
  if (oauth !== null && (typeof oauth !== 'object' || Array.isArray(oauth))) {
    throw new TypeError('The OAuth module must be an object with authorize, refresh and fetchIdentity.');
  }
  if (!isRecord(oauthConfigs)) throw new TypeError('OAuth provider configurations must be an object.');

  // Plaintext tokens live here for the current session only. Tokens that were
  // saved with encryption are decrypted lazily and cached here as well.
  const sessionTokens = new Map();
  // Same for OAuth refresh tokens.
  const sessionRefreshTokens = new Map();
  // OAuth client secrets saved while encryption is unavailable; never persisted.
  const sessionSecrets = new Map();
  // Per-connector sign-in state for oauthStatus: { flow, pending, lastError }.
  const flowStates = new Map();
  // In-flight token refreshes, shared so rotating refresh tokens are only spent once.
  const refreshing = new Map();
  // Bumped whenever a connection is replaced or removed, so a refresh that finishes late never
  // overwrites (or marks as failed) a newer connection.
  const generations = new Map();
  // The callback port is fixed, so at most one sign-in listens at a time.
  let activeFlow = null;

  function timestamp() {
    const value = now();
    return Number.isFinite(value) && value >= 0 ? value : Date.now();
  }

  function encryptionAvailable() {
    return safeStorage?.isEncryptionAvailable?.() === true;
  }

  // Returns base64 ciphertext, or null when encryption is unavailable (session-only storage).
  function encryptValue(value, message) {
    if (!encryptionAvailable()) return null;
    try {
      if (typeof safeStorage.encryptString !== 'function') throw new Error();
      const encrypted = safeStorage.encryptString(value);
      if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_CIPHERTEXT_BYTES) {
        throw new Error();
      }
      return encrypted.toString('base64');
    } catch {
      throw new ConnectorError(message);
    }
  }

  function decryptValue(ciphertext) {
    if (typeof safeStorage?.decryptString !== 'function' || !encryptionAvailable()) throw new Error();
    return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
  }

  function oauthConfigFor(id) {
    return Object.hasOwn(oauthConfigs, id) && isRecord(oauthConfigs[id]) ? oauthConfigs[id] : null;
  }

  function requireOAuthConfig(id) {
    const config = oauthConfigFor(id);
    if (!config) throw new ConnectorError(OAUTH_UNSUPPORTED_MESSAGE);
    return config;
  }

  function secretModeFor(config) {
    return SECRET_MODES.has(config.secret) ? config.secret : 'optional';
  }

  function redirectHostFor(config) {
    return config.redirectHost === 'localhost' ? 'localhost' : '127.0.0.1';
  }

  function normalizeRecord(value) {
    if (!isRecord(value)) return null;
    const record = {
      authType: value.authType === 'oauth' ? 'oauth' : 'token',
      tokenHint: typeof value.tokenHint === 'string' && value.tokenHint.length <= 16
        ? value.tokenHint : '',
      connectedAt: Number.isFinite(value.connectedAt) && value.connectedAt >= 0
        ? value.connectedAt : 0,
      lastStatus: LAST_STATUSES.has(value.lastStatus) ? value.lastStatus : 'never',
      lastError: typeof value.lastError === 'string' && value.lastError
        ? value.lastError.slice(0, MAX_ERROR_CHARS) : null,
      schemaVersion: SCHEMA_VERSION,
    };
    if (isBase64(value.encryptedToken)) record.encryptedToken = value.encryptedToken;
    if (isBase64(value.encryptedOAuth)) record.encryptedOAuth = value.encryptedOAuth;
    if (Number.isFinite(value.oauthExpiresAt)) record.oauthExpiresAt = value.oauthExpiresAt;
    if (typeof value.identity === 'string' && value.identity.length <= MAX_IDENTITY_CHARS) {
      record.identity = value.identity.slice(0, MAX_IDENTITY_CHARS);
    }
    return record;
  }

  function readRecords() {
    let container;
    try { container = store.readAll().connectors; } catch {
      throw new ConnectorError('Connector settings could not be read; repair the state file before continuing.');
    }
    if (container === undefined) return new Map();
    if (!isRecord(container)) {
      throw new ConnectorError('Stored connector settings are invalid; remove the connectors entry before continuing.');
    }
    const records = new Map();
    for (const id of Object.keys(container)) {
      if (!ID_PATTERN.test(id)) continue;
      const record = normalizeRecord(container[id]);
      if (record) records.set(id, record);
    }
    return records;
  }

  function persist(records) {
    const output = {};
    for (const [id, record] of records) output[id] = record;
    try {
      store.update((draft) => {
        if (records.size === 0) delete draft.connectors;
        else draft.connectors = output;
      });
    } catch {
      throw new ConnectorError('Connector settings could not be saved.');
    }
  }

  function updateRecord(id, patch) {
    const records = readRecords();
    if (!records.has(id)) return;
    records.set(id, { ...records.get(id), ...patch });
    persist(records);
  }

  function normalizeClient(value) {
    if (!isRecord(value) || !isToken(value.clientId, MAX_CLIENT_ID_CHARS)) return null;
    const client = {
      clientId: value.clientId,
      secretStorage: SECRET_STORAGES.has(value.secretStorage) ? value.secretStorage : 'none',
      shop: typeof value.shop === 'string' && SHOP_PATTERN.test(value.shop) ? value.shop : null,
      updatedAt: Number.isFinite(value.updatedAt) && value.updatedAt >= 0 ? value.updatedAt : 0,
    };
    if (isBase64(value.encryptedSecret)) client.encryptedSecret = value.encryptedSecret;
    return client;
  }

  function readClients() {
    let container;
    try { container = store.readAll()[OAUTH_CLIENTS_KEY]; } catch {
      throw new ConnectorError('Connector settings could not be read; repair the state file before continuing.');
    }
    if (container === undefined) return new Map();
    if (!isRecord(container)) {
      throw new ConnectorError(
        `Stored OAuth client settings are invalid; remove the ${OAUTH_CLIENTS_KEY} entry before continuing.`,
      );
    }
    const clients = new Map();
    for (const id of Object.keys(container)) {
      if (!ID_PATTERN.test(id)) continue;
      const client = normalizeClient(container[id]);
      if (client) clients.set(id, client);
    }
    return clients;
  }

  function persistClients(clients) {
    const output = {};
    for (const [id, client] of clients) output[id] = client;
    try {
      store.update((draft) => {
        if (clients.size === 0) delete draft[OAUTH_CLIENTS_KEY];
        else draft[OAUTH_CLIENTS_KEY] = output;
      });
    } catch {
      throw new ConnectorError('OAuth client settings could not be saved.');
    }
  }

  // The effective storage: a 'session' secret from an earlier run is gone after a restart.
  function secretStorageFor(id, client) {
    if (client?.encryptedSecret) return 'encrypted';
    return client && sessionSecrets.has(id) ? 'session' : 'none';
  }

  function clientSecretFor(id, client) {
    if (sessionSecrets.has(id)) return sessionSecrets.get(id);
    if (!client?.encryptedSecret) return '';
    try {
      const secret = decryptValue(client.encryptedSecret);
      if (!isToken(secret, MAX_CLIENT_SECRET_CHARS)) throw new Error();
      return secret;
    } catch {
      throw new ConnectorError('Stored OAuth client secret could not be decrypted. Save it again.');
    }
  }

  function tokenFor(id, record) {
    if (sessionTokens.has(id)) return sessionTokens.get(id);
    if (!record.encryptedToken) return '';
    try {
      if (typeof safeStorage?.decryptString !== 'function'
        || safeStorage.isEncryptionAvailable?.() !== true) throw new Error();
      const token = normalizeToken(safeStorage.decryptString(Buffer.from(record.encryptedToken, 'base64')));
      sessionTokens.set(id, token);
      return token;
    } catch {
      throw new ConnectorError(record.authType === 'oauth'
        ? 'Stored OAuth token could not be decrypted. Connect again.'
        : 'Stored connector token could not be decrypted. Save the token again.');
    }
  }

  function refreshTokenFor(id, record) {
    if (sessionRefreshTokens.has(id)) return sessionRefreshTokens.get(id);
    if (!record.encryptedOAuth) return '';
    const token = decryptValue(record.encryptedOAuth);
    if (!isToken(token, MAX_REFRESH_TOKEN_CHARS)) throw new Error();
    sessionRefreshTokens.set(id, token);
    return token;
  }

  function hasRefreshToken(id, record) {
    return Boolean(record.encryptedOAuth) || sessionRefreshTokens.has(id);
  }

  function entryFor(id, record) {
    const hasSessionToken = sessionTokens.has(id);
    const hasToken = Boolean(record.encryptedToken) || hasSessionToken;
    return {
      connected: hasToken,
      hasToken,
      keyStorage: record.encryptedToken ? 'encrypted' : (hasSessionToken ? 'session' : 'none'),
      hint: record.tokenHint,
      connectedAt: record.connectedAt,
      lastStatus: LAST_STATUSES.has(record.lastStatus) ? record.lastStatus : 'never',
      lastError: record.lastError,
      oauth: record.authType === 'oauth',
      oauthExpiresAt: Number.isFinite(record.oauthExpiresAt) ? record.oauthExpiresAt : null,
      identity: typeof record.identity === 'string' ? record.identity : null,
    };
  }

  function generationOf(id) {
    return generations.get(id) || 0;
  }

  function bumpGeneration(id) {
    generations.set(id, generationOf(id) + 1);
    // A refresh for the replaced connection must not be joined by requests for the new one.
    refreshing.delete(id);
  }

  // Cancels a sign-in for this connector; its late result must never overwrite what follows.
  function abortFlowFor(id) {
    if (activeFlow && activeFlow.id === id) activeFlow.controller.abort();
    flowStates.delete(id);
  }

  function list() {
    const entries = {};
    for (const [id, record] of readRecords()) entries[id] = entryFor(id, record);
    return entries;
  }

  function save(input) {
    if (!isRecord(input)) throw new ConnectorError('Connector settings must be an object.');
    const id = normalizeId(input.id);
    const token = normalizeToken(input.token);
    // The optional label is validated for callers but is not part of the
    // stored record shape, so it is intentionally not persisted.
    normalizeLabel(input.label);
    const records = readRecords();
    if (!records.has(id) && records.size >= MAX_CONNECTORS) {
      throw new ConnectorError(`At most ${MAX_CONNECTORS} connectors can be stored.`);
    }
    const record = {
      authType: 'token',
      tokenHint: hintFor(token),
      connectedAt: timestamp(),
      lastStatus: 'never',
      lastError: null,
      schemaVersion: SCHEMA_VERSION,
    };
    const encryptedToken = encryptValue(token, 'Connector token encryption failed; the connection was not saved.');
    if (encryptedToken) record.encryptedToken = encryptedToken;
    records.set(id, record);
    persist(records);
    abortFlowFor(id);
    bumpGeneration(id);
    sessionTokens.set(id, token);
    sessionRefreshTokens.delete(id);
    return entryFor(id, record);
  }

  function remove(input) {
    if (!isRecord(input)) throw new ConnectorError('Connector settings must be an object.');
    const id = normalizeId(input.id);
    const records = readRecords();
    const removed = records.delete(id);
    if (removed) persist(records);
    abortFlowFor(id);
    bumpGeneration(id);
    sessionTokens.delete(id);
    sessionRefreshTokens.delete(id);
    return { removed };
  }

  async function requestEndpoint(endpoint, token, {
    timeout = 'Connector validation timed out after 15 seconds.',
    network = 'Could not reach the provider to validate the token.',
  } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new ConnectorError(timeout, 'TIMEOUT'));
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    const aborted = new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    const headers = { Accept: 'application/json', ...endpoint.headers(token) };
    // Endpoints with a body default to JSON unless they declare their own Content-Type.
    if (endpoint.body !== undefined && !hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json';
    const execute = async () => {
      const response = await fetchImpl(endpoint.url, {
        method: endpoint.method,
        headers,
        ...(endpoint.body === undefined ? {} : { body: endpoint.body }),
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!response || typeof response.status !== 'number') {
        throw new ConnectorError('Provider returned an invalid response.');
      }
      if (response.redirected) {
        if (response.body?.cancel) void response.body.cancel().catch(() => {});
        throw new ConnectorError('Provider redirects are not allowed.');
      }
      const declaredSize = response.headers?.get?.('content-length');
      if (declaredSize && Number(declaredSize) > MAX_RESPONSE_BYTES) {
        if (response.body?.cancel) void response.body.cancel().catch(() => {});
        throw new ConnectorError('Provider response exceeds the 256 KB limit.');
      }
      let body;
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        const stop = () => { void reader.cancel().catch(() => {}); };
        controller.signal.addEventListener('abort', stop, { once: true });
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (controller.signal.aborted) throw controller.signal.reason;
            if (done) break;
            total += value.byteLength;
            if (total > MAX_RESPONSE_BYTES) {
              stop();
              throw new ConnectorError('Provider response exceeds the 256 KB limit.');
            }
            chunks.push(Buffer.from(value));
          }
        } finally {
          controller.signal.removeEventListener('abort', stop);
          reader.releaseLock();
        }
        try { body = JSON.parse(Buffer.concat(chunks, total).toString('utf8')); } catch { body = undefined; }
      }
      return { status: response.status, body };
    };
    try {
      // Racing abort also handles injected fetch implementations that ignore their signal.
      return await Promise.race([execute(), aborted]);
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(network);
    } finally {
      clearTimeout(timer);
    }
  }

  // Refreshes an OAuth access token and persists the new token set. Any failure becomes the
  // single "expired" message; provider details never reach the caller.
  async function refreshOAuth(id, record) {
    const generation = generationOf(id);
    try {
      const config = oauthConfigFor(id);
      const client = readClients().get(id);
      if (!config || !client || typeof oauth?.refresh !== 'function') throw new Error();
      const refreshToken = refreshTokenFor(id, record);
      if (!refreshToken) throw new Error();
      const result = await oauth.refresh(config, {
        refreshToken,
        clientId: client.clientId,
        clientSecret: secretModeFor(config) === 'none' ? '' : clientSecretFor(id, client),
        fetchImpl,
        shop: client.shop || '',
      });
      const accessToken = typeof result?.accessToken === 'string' ? result.accessToken.trim() : '';
      if (!isToken(accessToken, MAX_TOKEN_CHARS)) throw new Error();
      const nextRefreshToken = isToken(result.refreshToken, MAX_REFRESH_TOKEN_CHARS) ? result.refreshToken : refreshToken;
      const expiresIn = positiveNumber(result.expiresIn);
      const records = readRecords();
      const current = records.get(id);
      // A disconnect or a new connection while the refresh ran wins.
      if (!current || current.authType !== 'oauth' || generationOf(id) !== generation) throw new Error();
      const next = { ...current, tokenHint: hintFor(accessToken) };
      delete next.encryptedToken;
      delete next.encryptedOAuth;
      delete next.oauthExpiresAt;
      const message = 'Connector token encryption failed; the refreshed token was not saved.';
      const encryptedToken = encryptValue(accessToken, message);
      const encryptedRefresh = encryptValue(nextRefreshToken, message);
      if (encryptedToken) next.encryptedToken = encryptedToken;
      if (encryptedRefresh) next.encryptedOAuth = encryptedRefresh;
      if (expiresIn !== null) next.oauthExpiresAt = timestamp() + expiresIn * 1000;
      records.set(id, next);
      persist(records);
      sessionTokens.set(id, accessToken);
      sessionRefreshTokens.set(id, nextRefreshToken);
      return accessToken;
    } catch {
      try {
        if (generationOf(id) === generation) updateRecord(id, { lastStatus: 'error', lastError: OAUTH_EXPIRED_MESSAGE });
      } catch {
        // The refresh failure is still reported; only the persisted status is lost.
      }
      throw new ConnectorError(OAUTH_EXPIRED_MESSAGE, 'OAUTH_EXPIRED');
    }
  }

  // Returns the token to send. OAuth tokens that expire within 60 seconds (or already have)
  // are refreshed first when a refresh token is stored.
  async function accessTokenFor(id, record) {
    const token = tokenFor(id, record);
    if (!token || record.authType !== 'oauth') return token;
    if (!Number.isFinite(record.oauthExpiresAt) || record.oauthExpiresAt - timestamp() > OAUTH_REFRESH_WINDOW_MS) {
      return token;
    }
    if (!hasRefreshToken(id, record)) return token;
    if (!refreshing.has(id)) {
      const job = refreshOAuth(id, record).finally(() => {
        if (refreshing.get(id) === job) refreshing.delete(id);
      });
      refreshing.set(id, job);
    }
    return refreshing.get(id);
  }

  function recordOutcome(id, outcome, patch = {}) {
    try {
      updateRecord(id, {
        ...patch,
        lastStatus: outcome.ok ? 'ok' : 'error',
        lastError: outcome.ok ? null : outcome.message.slice(0, MAX_ERROR_CHARS),
      });
      return outcome;
    } catch {
      // The validation result still resolves; only the persisted status is lost.
      return { ...outcome, message: `${outcome.message} (status not saved)` };
    }
  }

  function unsupportedOutcome(id) {
    let message = NO_VALIDATION_MESSAGE;
    try {
      updateRecord(id, { lastStatus: 'unsupported', lastError: null });
    } catch {
      message += ' (status not saved)';
    }
    return { ok: false, supported: false, message };
  }

  // OAuth connections are validated through the provider's identity endpoint from the catalog.
  async function testOAuth(id, record) {
    const config = oauthConfigFor(id);
    if (!config || !isRecord(config.identity) || typeof oauth?.fetchIdentity !== 'function') {
      return unsupportedOutcome(id);
    }
    const token = await accessTokenFor(id, record);
    let shop = '';
    try { shop = readClients().get(id)?.shop || ''; } catch { shop = ''; }
    let result = null;
    try {
      result = await oauth.fetchIdentity(config, token, { fetchImpl, shop });
    } catch {
      result = null;
    }
    const status = Number.isInteger(result?.status) ? result.status : null;
    if (status === null) {
      return recordOutcome(id, {
        ok: false, supported: true, message: 'Could not reach the provider to validate the token.',
      });
    }
    if (status < 200 || status > 299) {
      return recordOutcome(id, { ok: false, supported: true, status, message: failureMessage(status) });
    }
    const identity = cleanIdentity(result.identity);
    // Slack, Linear and GraphQL APIs answer 200 for a bad token; only the identity proves it works.
    if (config.identity.requireField === true && !identity) {
      return recordOutcome(id, { ok: false, supported: true, status, message: failureMessage(401) });
    }
    return recordOutcome(
      id,
      { ok: true, supported: true, status, message: 'Connector token verified.' },
      identity ? { identity } : {},
    );
  }

  async function test(input) {
    if (!isRecord(input)) throw new ConnectorError('Connector settings must be an object.');
    const id = normalizeId(input.id);
    const record = readRecords().get(id);
    if (!record) throw new ConnectorError('No stored token for this connector. Save a token before testing.');
    const token = tokenFor(id, record);
    if (!token) throw new ConnectorError('No stored token for this connector. Save a token before testing.');
    if (record.authType === 'oauth') return testOAuth(id, record);
    const endpoint = VALIDATION_ENDPOINTS[id];
    if (!endpoint) return unsupportedOutcome(id);
    let outcome;
    try {
      const { status, body } = await requestEndpoint(endpoint, token);
      outcome = endpoint.ok(body, status) === true
        ? { ok: true, supported: true, status, message: 'Connector token verified.' }
        : { ok: false, supported: true, status, message: failureMessage(status) };
    } catch (error) {
      const message = error instanceof ConnectorError && error.message
        ? error.message
        : 'Could not reach the provider to validate the token.';
      outcome = { ok: false, supported: true, message };
    }
    return recordOutcome(id, outcome);
  }

  // Named fetchConnector, not fetch: a body-level declaration named `fetch`
  // would shadow the `fetchImpl = fetch` parameter default with a TDZ binding.
  async function fetchConnector(input) {
    if (!isRecord(input)) throw new ConnectorError('Connector fetch request must be an object.');
    const id = normalizeFetchName(input.id, 'id');
    const action = normalizeFetchName(input.action, 'action');
    const params = normalizeFetchParams(input.params);
    const record = readRecords().get(id);
    const storedToken = record ? tokenFor(id, record) : '';
    if (!storedToken) throw new ConnectorError('Connect this service first in Experts & resources.');
    if (id !== 'github' || action !== 'repo') {
      throw new ConnectorError('This connector has no fetch actions yet.');
    }
    const owner = githubSlug(params.owner, 'owner');
    const repo = githubSlug(params.repo, 'repo');
    const token = await accessTokenFor(id, record);
    const messages = {
      timeout: 'Connector fetch timed out after 15 seconds.',
      network: 'Could not reach the provider to fetch connector data.',
    };
    const headers = (value) => ({ Authorization: `Bearer ${value}`, Accept: 'application/vnd.github+json' });
    const repoResponse = await requestEndpoint({
      method: 'GET',
      url: `https://api.github.com/repos/${owner}/${repo}`,
      headers,
    }, token, messages);
    if (repoResponse.status < 200 || repoResponse.status > 299) throw repoStatusError(repoResponse.status);
    const issuesResponse = await requestEndpoint({
      method: 'GET',
      url: `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=10`,
      headers,
    }, token, messages);
    if (issuesResponse.status < 200 || issuesResponse.status > 299) throw repoStatusError(issuesResponse.status);
    return summarizeGithubRepo(repoResponse.body, issuesResponse.body);
  }

  function describeOAuth(id, config, client) {
    const storage = secretStorageFor(id, client);
    return {
      id,
      supported: true,
      configured: Boolean(client?.clientId),
      clientId: client?.clientId || '',
      hasSecret: storage !== 'none',
      secretStorage: storage,
      shop: client?.shop || null,
      secret: secretModeFor(config),
      needsShop: Boolean(config.needsShop),
      redirectUri: `http://${redirectHostFor(config)}:${OAUTH_CALLBACK_PORT}/callback`,
      loopback: typeof config.loopback === 'string' ? config.loopback : 'unknown',
      redirectNote: typeof config.redirectNote === 'string' ? config.redirectNote : '',
      registerUrl: typeof config.registerUrl === 'string' ? config.registerUrl : '',
      docsUrl: typeof config.docsUrl === 'string' ? config.docsUrl : '',
      scopes: typeof config.scopes === 'string' ? config.scopes : '',
    };
  }

  function getOAuthConfig(input) {
    if (!isRecord(input)) throw new ConnectorError('Connector settings must be an object.');
    const id = normalizeId(input.id);
    const config = oauthConfigFor(id);
    if (!config) return { id, supported: false };
    return describeOAuth(id, config, readClients().get(id) || null);
  }

  function saveOAuthConfig(input) {
    if (!isRecord(input)) throw new ConnectorError('OAuth client settings must be an object.');
    const id = normalizeId(input.id);
    const config = requireOAuthConfig(id);
    const clientId = normalizeClientId(input.clientId);
    const clientSecret = normalizeClientSecret(input.clientSecret);
    const secretMode = secretModeFor(config);
    if (clientSecret && secretMode === 'none') {
      const name = typeof config.name === 'string' && config.name.trim() ? config.name.trim() : id;
      throw new ConnectorError(`${name} desktop sign-in must not use a client secret; leave it blank.`);
    }
    const clients = readClients();
    const existing = clients.get(id) || null;
    let shop = null;
    if (config.needsShop) {
      // An omitted shop keeps the stored one; otherwise it must be a valid myshopify.com domain.
      shop = input.shop === undefined && existing?.shop ? existing.shop : normalizeShop(input.shop);
    }
    const next = { clientId, secretStorage: 'none', shop, updatedAt: timestamp() };
    let sessionSecret = null; // null: drop any session secret, undefined: keep it, string: set it
    if (clientSecret === undefined && secretMode !== 'none') {
      if (existing?.encryptedSecret) {
        next.encryptedSecret = existing.encryptedSecret;
        next.secretStorage = 'encrypted';
      } else if (sessionSecrets.has(id)) {
        next.secretStorage = 'session';
      }
      sessionSecret = undefined;
    } else if (clientSecret) {
      const encrypted = encryptValue(
        clientSecret,
        'OAuth client secret encryption failed; the settings were not saved.',
      );
      if (encrypted) {
        next.encryptedSecret = encrypted;
        next.secretStorage = 'encrypted';
      } else {
        next.secretStorage = 'session';
        sessionSecret = clientSecret;
      }
    }
    clients.set(id, next);
    persistClients(clients);
    if (sessionSecret === null) sessionSecrets.delete(id);
    else if (typeof sessionSecret === 'string') sessionSecrets.set(id, sessionSecret);
    return getOAuthConfig({ id });
  }

  function storeOAuthTokens(id, { accessToken, refreshToken, expiresIn, identity }) {
    const records = readRecords();
    if (!records.has(id) && records.size >= MAX_CONNECTORS) {
      throw new ConnectorError(`At most ${MAX_CONNECTORS} connectors can be stored.`);
    }
    const connectedAt = timestamp();
    const record = {
      authType: 'oauth',
      tokenHint: hintFor(accessToken),
      connectedAt,
      lastStatus: 'ok',
      lastError: null,
      schemaVersion: SCHEMA_VERSION,
    };
    const message = 'Connector token encryption failed; the connection was not saved.';
    const encryptedToken = encryptValue(accessToken, message);
    const encryptedRefresh = refreshToken ? encryptValue(refreshToken, message) : null;
    if (encryptedToken) record.encryptedToken = encryptedToken;
    if (encryptedRefresh) record.encryptedOAuth = encryptedRefresh;
    if (expiresIn !== null) record.oauthExpiresAt = connectedAt + expiresIn * 1000;
    if (identity) record.identity = identity;
    records.set(id, record);
    persist(records);
    bumpGeneration(id);
    sessionTokens.set(id, accessToken);
    if (refreshToken) sessionRefreshTokens.set(id, refreshToken);
    else sessionRefreshTokens.delete(id);
    return entryFor(id, record);
  }

  async function lookupIdentity(config, accessToken, shop) {
    if (typeof oauth?.fetchIdentity !== 'function') return null;
    try {
      const result = await oauth.fetchIdentity(config, accessToken, { fetchImpl, shop });
      const status = Number.isInteger(result?.status) ? result.status : null;
      return status !== null && status >= 200 && status <= 299 ? cleanIdentity(result.identity) : null;
    } catch {
      return null;
    }
  }

  function finishFlow(flow, lastError) {
    const state = flowStates.get(flow.id);
    if (state && state.flow === flow) flowStates.set(flow.id, { flow, pending: false, lastError });
  }

  async function startOAuth(input, options = {}) {
    if (!isRecord(input)) throw new ConnectorError('Connector settings must be an object.');
    const id = normalizeId(input.id);
    const config = requireOAuthConfig(id);
    if (typeof oauth?.authorize !== 'function') throw new ConnectorError('OAuth sign-in is not available.');
    if (config.loopback === 'no') throw new ConnectorError(OAUTH_NO_LOOPBACK_MESSAGE);
    const client = readClients().get(id);
    if (!client) throw new ConnectorError('Save an OAuth client ID for this connector before signing in.');
    const secretMode = secretModeFor(config);
    const clientSecret = secretMode === 'none' ? '' : clientSecretFor(id, client);
    if (secretMode === 'required' && !clientSecret) {
      throw new ConnectorError('This provider requires a client secret. Save it with the client ID before signing in.');
    }
    if (config.needsShop && !client.shop) {
      throw new ConnectorError('Save the Shopify store domain (<store>.myshopify.com) before signing in.');
    }
    const openExternal = isRecord(options) ? options.openExternal : undefined;
    if (typeof openExternal !== 'function') throw new ConnectorError('A browser opener is required for OAuth sign-in.');
    const records = readRecords();
    if (!records.has(id) && records.size >= MAX_CONNECTORS) {
      throw new ConnectorError(`At most ${MAX_CONNECTORS} connectors can be stored.`);
    }
    // Only https pages ever reach the system browser, whatever the engine builds.
    const openHttps = async (url) => {
      let parsed = null;
      try { parsed = new URL(url); } catch { parsed = null; }
      if (!parsed || parsed.protocol !== 'https:') throw new ConnectorError('Only HTTPS sign-in pages can be opened.');
      await openExternal(parsed.href);
    };

    const previous = activeFlow;
    const controller = new AbortController();
    let release;
    const flow = { id, controller, released: new Promise((resolve) => { release = resolve; }) };
    activeFlow = flow;
    flowStates.set(id, { flow, pending: true, lastError: null });
    try {
      if (previous) {
        previous.controller.abort();
        // The callback port is fixed: wait until the previous flow has closed its listener.
        await previous.released;
      }
      if (controller.signal.aborted) throw new ConnectorError(OAUTH_CANCELLED_MESSAGE, 'CANCELLED');
      let tokens;
      try {
        tokens = await oauth.authorize(config, {
          clientId: client.clientId,
          clientSecret,
          openExternal: openHttps,
          fetchImpl,
          port: OAUTH_CALLBACK_PORT,
          shop: client.shop || '',
          signal: controller.signal,
        });
      } finally {
        release();
      }
      if (controller.signal.aborted) throw new ConnectorError(OAUTH_CANCELLED_MESSAGE, 'CANCELLED');
      const accessToken = typeof tokens?.accessToken === 'string' ? tokens.accessToken.trim() : '';
      if (!isToken(accessToken, MAX_TOKEN_CHARS)) {
        throw new ConnectorError('The provider returned an unusable access token.', 'OAUTH_ERROR');
      }
      const refreshToken = isToken(tokens.refreshToken, MAX_REFRESH_TOKEN_CHARS) ? tokens.refreshToken : '';
      const expiresIn = positiveNumber(tokens.expiresIn);
      const identity = await lookupIdentity(config, accessToken, client.shop || '');
      // A disconnect or a newer sign-in during the identity lookup wins over this result.
      if (controller.signal.aborted) throw new ConnectorError(OAUTH_CANCELLED_MESSAGE, 'CANCELLED');
      const entry = storeOAuthTokens(id, { accessToken, refreshToken, expiresIn, identity });
      finishFlow(flow, null);
      return entry;
    } catch (error) {
      release();
      const failure = oauthFailure(error);
      finishFlow(flow, failure.message);
      throw failure;
    } finally {
      if (activeFlow === flow) activeFlow = null;
    }
  }

  function oauthStatus(input) {
    if (!isRecord(input)) throw new ConnectorError('Connector settings must be an object.');
    const id = normalizeId(input.id);
    const record = readRecords().get(id) || null;
    const state = flowStates.get(id);
    const expiresAt = record && Number.isFinite(record.oauthExpiresAt) ? record.oauthExpiresAt : null;
    return {
      id,
      pending: state?.pending === true,
      connected: record ? entryFor(id, record).connected : false,
      oauth: record?.authType === 'oauth',
      identity: typeof record?.identity === 'string' ? record.identity : null,
      expiresAt,
      expired: expiresAt !== null && expiresAt <= timestamp(),
      hasRefreshToken: record ? hasRefreshToken(id, record) : false,
      lastError: state?.lastError || record?.lastError || null,
    };
  }

  function disconnectOAuth(input) {
    if (!isRecord(input)) throw new ConnectorError('Connector settings must be an object.');
    const id = normalizeId(input.id);
    if (input.forgetClient !== undefined && typeof input.forgetClient !== 'boolean') {
      throw new ConnectorError('forgetClient must be true or false.');
    }
    if (input.pendingOnly !== undefined && typeof input.pendingOnly !== 'boolean') {
      throw new ConnectorError('pendingOnly must be true or false.');
    }
    if (input.pendingOnly === true) {
      // Cancels a sign-in in progress and keeps any existing connection.
      const cancelled = flowStates.get(id)?.pending === true;
      abortFlowFor(id);
      return { removed: false, clientForgotten: false, cancelled };
    }
    abortFlowFor(id);
    const records = readRecords();
    const removed = records.delete(id);
    if (removed) persist(records);
    bumpGeneration(id);
    sessionTokens.delete(id);
    sessionRefreshTokens.delete(id);
    let clientForgotten = false;
    if (input.forgetClient === true) {
      const clients = readClients();
      const deleted = clients.delete(id);
      if (deleted) persistClients(clients);
      const hadSessionSecret = sessionSecrets.delete(id);
      clientForgotten = deleted || hadSessionSecret;
    }
    return { removed, clientForgotten };
  }

  return {
    list,
    save,
    remove,
    test,
    fetch: fetchConnector,
    saveOAuthConfig,
    getOAuthConfig,
    startOAuth,
    oauthStatus,
    disconnectOAuth,
  };
}

module.exports = { createConnectorStore };
