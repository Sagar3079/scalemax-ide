'use strict';

const MAX_CONNECTORS = 100;
const MAX_TOKEN_CHARS = 4096;
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

function hintFor(token) {
  // Tokens of eight characters or fewer reveal nothing, not even a tail.
  return token.length <= 8 ? HINT_PREFIX : `${HINT_PREFIX}${token.slice(-4)}`;
}

function failureMessage(status) {
  if (status === 401 || status === 403) return 'Provider rejected the stored token.';
  if (status === 429) return 'Provider rate limited the validation request.';
  return `Provider validation failed with HTTP status ${status}.`;
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

function createConnectorStore({ store, safeStorage, fetchImpl = fetch, now = Date.now }) {
  if (!store || typeof store.readAll !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('An internal state store is required.');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  if (typeof now !== 'function') throw new TypeError('A clock function is required.');

  // Plaintext tokens live here for the current session only. Tokens that were
  // saved with encryption are decrypted lazily and cached here as well.
  const sessionTokens = new Map();

  function timestamp() {
    const value = now();
    return Number.isFinite(value) && value >= 0 ? value : Date.now();
  }

  function normalizeRecord(value) {
    if (!isRecord(value)) return null;
    const record = {
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
      throw new ConnectorError('Stored connector token could not be decrypted. Save the token again.');
    }
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
      lastStatus: record.lastStatus,
      lastError: record.lastError,
    };
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
      tokenHint: hintFor(token),
      connectedAt: timestamp(),
      lastStatus: 'never',
      lastError: null,
      schemaVersion: SCHEMA_VERSION,
    };
    if (safeStorage?.isEncryptionAvailable?.() === true) {
      try {
        if (typeof safeStorage.encryptString !== 'function') throw new Error();
        const encrypted = safeStorage.encryptString(token);
        if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_CIPHERTEXT_BYTES) {
          throw new Error();
        }
        record.encryptedToken = encrypted.toString('base64');
      } catch {
        throw new ConnectorError('Connector token encryption failed; the connection was not saved.');
      }
    }
    records.set(id, record);
    persist(records);
    sessionTokens.set(id, token);
    return entryFor(id, record);
  }

  function remove(input) {
    if (!isRecord(input)) throw new ConnectorError('Connector settings must be an object.');
    const id = normalizeId(input.id);
    const records = readRecords();
    const removed = records.delete(id);
    if (removed) persist(records);
    sessionTokens.delete(id);
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
    if (endpoint.body !== undefined) headers['Content-Type'] = 'application/json';
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

  async function test(input) {
    if (!isRecord(input)) throw new ConnectorError('Connector settings must be an object.');
    const id = normalizeId(input.id);
    const record = readRecords().get(id);
    if (!record) throw new ConnectorError('No stored token for this connector. Save a token before testing.');
    const token = tokenFor(id, record);
    if (!token) throw new ConnectorError('No stored token for this connector. Save a token before testing.');
    const endpoint = VALIDATION_ENDPOINTS[id];
    if (!endpoint) {
      let message = 'No validation endpoint is configured for this connector yet.';
      try {
        updateRecord(id, { lastStatus: 'unsupported', lastError: null });
      } catch {
        message += ' (status not saved)';
      }
      return { ok: false, supported: false, message };
    }
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
    try {
      updateRecord(id, {
        lastStatus: outcome.ok ? 'ok' : 'error',
        lastError: outcome.ok ? null : outcome.message.slice(0, MAX_ERROR_CHARS),
      });
    } catch {
      // The validation result still resolves; only the persisted status is lost.
      outcome = { ...outcome, message: `${outcome.message} (status not saved)` };
    }
    return outcome;
  }

  // Named fetchConnector, not fetch: a body-level declaration named `fetch`
  // would shadow the `fetchImpl = fetch` parameter default with a TDZ binding.
  async function fetchConnector(input) {
    if (!isRecord(input)) throw new ConnectorError('Connector fetch request must be an object.');
    const id = normalizeFetchName(input.id, 'id');
    const action = normalizeFetchName(input.action, 'action');
    const params = normalizeFetchParams(input.params);
    const record = readRecords().get(id);
    const token = record ? tokenFor(id, record) : '';
    if (!token) throw new ConnectorError('Connect this service first in Experts & resources.');
    if (id !== 'github' || action !== 'repo') {
      throw new ConnectorError('This connector has no fetch actions yet.');
    }
    const owner = githubSlug(params.owner, 'owner');
    const repo = githubSlug(params.repo, 'repo');
    const messages = {
      timeout: 'Connector fetch timed out after 15 seconds.',
      network: 'Could not reach the provider to fetch connector data.',
    };
    const headers = (bearer) => ({ Authorization: `Bearer ${bearer}`, Accept: 'application/vnd.github+json' });
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

  return { list, save, remove, test, fetch: fetchConnector };
}

module.exports = { createConnectorStore };
