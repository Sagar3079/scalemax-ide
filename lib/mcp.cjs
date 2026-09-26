'use strict';

const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createMcpOAuth } = require('./mcp-oauth.cjs');
const directory = require('./mcp-directory.cjs');
const { OAuthError } = require('./oauth.cjs');

const SCHEMA_VERSION = 1;
const MAX_SERVERS = 20;
const MAX_NAME_CHARS = 64;
const MAX_COMMAND_CHARS = 1024;
const MAX_ARGS = 64;
const MAX_ARG_CHARS = 4096;
const MAX_CWD_CHARS = 1024;
const MAX_ENV_ENTRIES = 64;
const MAX_ENV_VALUE_CHARS = 8192;
const MAX_URL_CHARS = 2048;
const MAX_HEADERS = 32;
const MAX_HEADER_VALUE_CHARS = 8192;
const MAX_SECRETS_BYTES = 64 * 1024;
const MAX_CIPHERTEXT_BYTES = 96 * 1024;
const MAX_CIPHERTEXT_CHARS = 131_072;
const MAX_ERROR_CHARS = 512;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 4096;
const MAX_STDERR_EXCERPT_CHARS = 240;
const MAX_REMOTE_TEXT_CHARS = 300;
const MAX_TOOL_PAGES = 10;
const MAX_TOOLS_PER_SERVER = 500;
const MAX_TOOL_NAME_CHARS = 128;
const MAX_TOOL_TITLE_CHARS = 128;
const MAX_SUMMARY_DESCRIPTION_CHARS = 500;
const MAX_CHAT_DESCRIPTION_CHARS = 1024;
const MAX_CHAT_TOOLS = 128;
const MAX_SCHEMA_BYTES = 32 * 1024;
const MAX_CHAT_TOOLS_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_ARGUMENT_BYTES = 1024 * 1024;
const MAX_CURSOR_CHARS = 4096;
const INITIALIZE_TIMEOUT_MS = 60_000;
const LIST_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;
const NOTIFY_TIMEOUT_MS = 30_000;
const DELETE_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 2_000;
const EXIT_WAIT_MS = 1_000;
const EXIT_DRAIN_MS = 250;
const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Ids become keys of the persisted state object; the state store rejects these.
const RESERVED_IDS = new Set(['constructor', 'prototype']);
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const HEADER_VALUE_PATTERN = /^[\x20-\x7e]*$/;
const SESSION_ID_PATTERN = /^[\x21-\x7e]{1,1024}$/;
const MIME_PATTERN = /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/;
const CONTENT_TYPE_PATTERN = /^[a-z_]{1,32}$/;
const FORBIDDEN_HEADERS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding', 'mcp-session-id', 'mcp-protocol-version',
  'accept', 'content-type',
  // Node's fetch rejects these outright, so they could never work.
  'keep-alive', 'upgrade', 'expect',
]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const LAST_STATUSES = new Set(['never', 'ok', 'error']);
const SECRET_STORAGES = new Set(['encrypted', 'session', 'none']);
const AUTH_STORAGES = new Set(['encrypted', 'session']);
const TOKEN_AUTH_METHODS = new Set(['none', 'client_secret_post', 'client_secret_basic']);
const MAX_CLIENT_ID_CHARS = 512;
const MAX_AUTH_SCOPE_CHARS = 2048;
const MAX_CLIENT_SECRET_CHARS = 4096;
const MAX_AUTH_TOKEN_CHARS = 8192;
// Access tokens are refreshed this long before they expire.
const REFRESH_MARGIN_MS = 60_000;
const AUTH_TEXT_PATTERN = /^[\x20-\x7e]*$/;
const DARWIN_EXTRA_PATHS = ['/opt/homebrew/bin', '/usr/local/bin'];
const DARWIN_DEFAULT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
// Control characters, line/paragraph separators and bidi overrides never
// belong in names or in text that is echoed into error messages.
const UNPRINTABLE = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const UNPRINTABLE_ALL = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;
const ANSI_ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

class McpError extends Error {
  constructor(message, code = 'MCP_ERROR') {
    super(message);
    this.name = 'McpError';
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

function toMcpError(error) {
  return error instanceof McpError ? error : new McpError('MCP request failed.');
}

/** Truncates to at most `max` UTF-16 units without splitting a surrogate pair. */
function truncateChars(value, max) {
  if (value.length <= max) return value;
  let end = max;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/** Keeps the last `max` UTF-16 units without starting on a lone low surrogate. */
function tailChars(value, max) {
  if (value.length <= max) return value;
  let start = value.length - max;
  const code = value.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return value.slice(start);
}

/** Truncates to at most `maxBytes` of UTF-8 without splitting a code point. */
function truncateBytes(value, maxBytes) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

function capText(value, maxBytes, marker = '\n[truncated]') {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  return `${truncateBytes(value, maxBytes - Buffer.byteLength(marker))}${marker}`;
}

/** Single-line, escape-free rendering of text received from a server. */
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.replace(ANSI_ESCAPES, ' ').replace(UNPRINTABLE_ALL, ' ').replace(/\s+/g, ' ').trim();
  return Number.isFinite(max) ? truncateChars(text, max) : text;
}

/** Keeps newlines and tabs (tool descriptions are often multi-line) but drops other controls. */
function stripControls(value) {
  return value.replace(UNPRINTABLE_ALL, (char) => {
    if (char === '\n' || char === '\t') return char;
    return char === '\r' ? '' : ' ';
  });
}

// Error text can embed server output (stderr, JSON-RPC error messages). Any
// configured env/header value that shows up there is replaced before the text
// leaves this module, including the token part of values like "Bearer <token>".
// `extra` returns the current OAuth tokens, which change when they are refreshed.
function createRedactor(secrets, extra = () => []) {
  const needles = new Set();
  for (const group of [secrets.env, secrets.headers]) {
    for (const value of Object.values(group || {})) {
      if (typeof value !== 'string') continue;
      if (value.length >= 4) needles.add(value);
      for (const part of value.split(/[\s,;]+/)) if (part.length >= 8) needles.add(part);
    }
  }
  return (text) => {
    const all = new Set(needles);
    for (const value of extra()) if (typeof value === 'string' && value.length >= 8) all.add(value);
    let output = String(text);
    for (const needle of [...all].sort((a, b) => b.length - a.length)) output = output.split(needle).join('[redacted]');
    return output;
  };
}

function authExpiredError() {
  return new McpError('The sign-in for this MCP server has expired. Sign in again to reconnect it.', 'MCP_AUTH_REQUIRED');
}

function normalizeId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value) || RESERVED_IDS.has(value)) {
    throw new McpError('MCP server id must be 1-64 lowercase letters, digits, or dashes.');
  }
  return value;
}

function normalizeName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || [...name].length > MAX_NAME_CHARS || UNPRINTABLE.test(name)) {
    throw new McpError('MCP server name must be 1-64 printable characters.');
  }
  return name;
}

function normalizeTransport(value) {
  if (value !== 'stdio' && value !== 'http') {
    throw new McpError("MCP server transport must be 'stdio' or 'http'.");
  }
  return value;
}

function normalizeCommand(value) {
  const command = typeof value === 'string' ? value.trim() : '';
  if (!command || command.length > MAX_COMMAND_CHARS || /[\0\r\n]/.test(command)) {
    throw new McpError('MCP server command must be 1-1024 characters without line breaks or NUL.');
  }
  return command;
}

function normalizeArgs(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ARGS) {
    throw new McpError(`MCP server args must be an array of at most ${MAX_ARGS} strings.`);
  }
  const args = [];
  // Index loop so holes in sparse arrays are rejected instead of skipped.
  for (let index = 0; index < value.length; index += 1) {
    const arg = value[index];
    if (typeof arg !== 'string' || arg.length > MAX_ARG_CHARS || arg.includes('\0')) {
      throw new McpError('Each MCP server arg must be a string of at most 4096 characters without NUL.');
    }
    args.push(arg);
  }
  return args;
}

function normalizeCwd(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_CWD_CHARS || value.includes('\0') || !path.isAbsolute(value)) {
    throw new McpError('MCP server working directory must be an absolute path of at most 1024 characters.');
  }
  return value;
}

function normalizeUrl(value) {
  const invalid = () => new McpError('MCP server URL must be an https:// URL (or http:// on 127.0.0.1, '
    + 'localhost, or [::1]) of at most 2048 characters without credentials or a fragment.');
  if (typeof value !== 'string') throw invalid();
  const raw = value.trim();
  if (!raw || raw.length > MAX_URL_CHARS || /[^\x21-\x7e]/.test(raw) || /[\\#]/.test(raw)) throw invalid();
  // The authority is matched on the raw text because URL parsing normalizes
  // hosts (127.1 becomes 127.0.0.1), and loopback must be matched exactly.
  const authority = /^(https?):\/\/(\[[0-9A-Fa-f:.]+\]|[^/?#@:[\]]+)(?::[0-9]{1,5})?(?=[/?]|$)/.exec(raw);
  let url;
  try { url = new URL(raw); } catch { throw invalid(); }
  if (!authority || !url.hostname || url.username || url.password || url.hash) throw invalid();
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(authority[2].toLowerCase())) {
    throw new McpError('Plain http:// MCP server URLs are allowed only for 127.0.0.1, localhost, or [::1]; '
      + 'use https:// otherwise.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalid();
  return url.href;
}

function normalizeEnv(value) {
  if (!isRecord(value)) throw new McpError('MCP server environment variables must be an object.');
  const keys = Object.keys(value);
  if (keys.length > MAX_ENV_ENTRIES) {
    throw new McpError(`At most ${MAX_ENV_ENTRIES} MCP server environment variables are allowed.`);
  }
  const output = {};
  for (const key of keys) {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new McpError('Environment variable names must start with a letter or underscore and use only '
        + 'letters, digits, or underscores (at most 128).');
    }
    const entry = value[key];
    if (typeof entry !== 'string' || entry.length > MAX_ENV_VALUE_CHARS || /[\0\r\n]/.test(entry)) {
      throw new McpError('Environment variable values must be at most 8192 characters without line breaks or NUL.');
    }
    output[key] = entry;
  }
  return output;
}

function normalizeHeaders(value) {
  if (!isRecord(value)) throw new McpError('MCP server headers must be an object.');
  const names = Object.keys(value);
  if (names.length > MAX_HEADERS) throw new McpError(`At most ${MAX_HEADERS} MCP server headers are allowed.`);
  const seen = new Set();
  const output = {};
  for (const name of names) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new McpError('Header names must be 1-128 letters, digits, or dashes.');
    }
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower)) throw new McpError(`The ${name} header is managed by ScaleMax and cannot be configured.`);
    if (seen.has(lower)) throw new McpError('Header names must be unique (case-insensitive).');
    seen.add(lower);
    const entry = value[name];
    if (typeof entry !== 'string' || entry.length > MAX_HEADER_VALUE_CHARS || !HEADER_VALUE_PATTERN.test(entry)) {
      throw new McpError('Header values must be at most 8192 printable ASCII characters.');
    }
    output[name] = entry;
  }
  return output;
}

function normalizeSecretKeys(value) {
  const source = isRecord(value) ? value : {};
  const pick = (list, pattern, max) => (Array.isArray(list)
    ? [...new Set(list.filter((key) => typeof key === 'string' && pattern.test(key)))].slice(0, max)
    : []);
  return {
    env: pick(source.env, ENV_KEY_PATTERN, MAX_ENV_ENTRIES),
    headers: pick(source.headers, HEADER_NAME_PATTERN, MAX_HEADERS),
  };
}

function normalizeToolName(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_TOOL_NAME_CHARS || UNPRINTABLE.test(value)) {
    throw new McpError('MCP tool name must be 1-128 printable characters.');
  }
  return value;
}

function normalizeArguments(value) {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new McpError('MCP tool arguments must be an object.');
  let serialized;
  try { serialized = JSON.stringify(value); } catch {
    throw new McpError('MCP tool arguments must be JSON-serializable.');
  }
  if (Buffer.byteLength(serialized) > MAX_ARGUMENT_BYTES) throw new McpError('MCP tool arguments exceed the 1 MB limit.');
  return value;
}

function slugify(name) {
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 64).replace(/-+$/, '');
  return slug || 'server';
}

function sha1Hex(value) {
  return createHash('sha1').update(value).digest('hex');
}

// Function names exposed to the model: mcp_<serverId>_<toolName>, restricted
// to ^[a-zA-Z0-9_-]{1,64}$. Long names keep a 55-character prefix plus a hash
// of the raw name; collisions after sanitization get a distinct hash suffix.
function functionName(serverId, toolName, used) {
  const raw = `mcp_${serverId}_${toolName}`;
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  let name = sanitized.length <= 64 ? sanitized : `${sanitized.slice(0, 55)}_${sha1Hex(raw).slice(0, 8)}`;
  for (let attempt = 1; used.has(name); attempt += 1) {
    name = `${sanitized.slice(0, 55)}_${sha1Hex(`${raw}\0${attempt}`).slice(0, 8)}`;
  }
  return name;
}

function timestampOf(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function authUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_CHARS) throw new Error();
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
  return value;
}

function authText(value, max) {
  if (typeof value !== 'string' || value.length > max || !AUTH_TEXT_PATTERN.test(value)) throw new Error();
  return value;
}

/**
 * Non-secret metadata of an OAuth sign-in (stored in plaintext). The client secret and the
 * tokens live in the separately encrypted `encryptedAuth` blob. Throws on anything invalid.
 */
function normalizeAuth(value) {
  if (!isRecord(value) || value.type !== 'oauth') throw new Error();
  if (!TOKEN_AUTH_METHODS.has(value.tokenAuth)) throw new Error();
  const clientId = authText(value.clientId, MAX_CLIENT_ID_CHARS);
  if (!clientId) throw new Error();
  const directoryId = typeof value.directoryId === 'string' && directory.byId(value.directoryId) ? value.directoryId : null;
  return {
    type: 'oauth',
    issuer: authUrl(value.issuer),
    resource: value.resource ? authUrl(value.resource) : '',
    authorizationEndpoint: authUrl(value.authorizationEndpoint),
    tokenEndpoint: authUrl(value.tokenEndpoint),
    clientId,
    tokenAuth: value.tokenAuth,
    scope: value.scope ? authText(value.scope, MAX_AUTH_SCOPE_CHARS) : '',
    directoryId,
    expiresAt: Number.isFinite(value.expiresAt) && value.expiresAt > 0 ? value.expiresAt : null,
    hasRefreshToken: value.hasRefreshToken === true,
    signedInAt: timestampOf(value.signedInAt),
    storage: AUTH_STORAGES.has(value.storage) ? value.storage : 'session',
  };
}

function normalizeAuthSecrets(value) {
  if (!isRecord(value)) throw new Error();
  const read = (key, max, required) => {
    const entry = value[key] === undefined ? '' : value[key];
    if (typeof entry !== 'string' || entry.length > max || /[^\x21-\x7e]/.test(entry) || (required && !entry)) {
      throw new Error();
    }
    return entry;
  };
  return {
    clientSecret: read('clientSecret', MAX_CLIENT_SECRET_CHARS, false),
    accessToken: read('accessToken', MAX_AUTH_TOKEN_CHARS, true),
    refreshToken: read('refreshToken', MAX_AUTH_TOKEN_CHARS, false),
  };
}

/** Builds a persisted record with a stable key order. */
function buildRecord(fields) {
  const record = {
    name: fields.name,
    transport: fields.transport,
    command: fields.command,
    args: [...fields.args],
    cwd: fields.cwd,
    url: fields.url,
    enabled: fields.enabled,
  };
  if (fields.encryptedSecrets) record.encryptedSecrets = fields.encryptedSecrets;
  if (fields.auth) {
    record.auth = { ...fields.auth };
    if (fields.encryptedAuth) record.encryptedAuth = fields.encryptedAuth;
  }
  record.secretKeys = { env: [...fields.secretKeys.env], headers: [...fields.secretKeys.headers] };
  record.secretStorage = fields.secretStorage;
  record.createdAt = fields.createdAt;
  record.updatedAt = fields.updatedAt;
  record.lastStatus = fields.lastStatus;
  record.lastError = fields.lastError;
  record.toolCount = fields.toolCount;
  record.schemaVersion = SCHEMA_VERSION;
  return record;
}

function normalizeStoredRecord(value) {
  if (!isRecord(value)) return null;
  try {
    const transport = normalizeTransport(value.transport);
    const stdio = transport === 'stdio';
    const encryptedSecrets = isBase64(value.encryptedSecrets) ? value.encryptedSecrets : undefined;
    let secretStorage = SECRET_STORAGES.has(value.secretStorage) ? value.secretStorage : 'none';
    if (encryptedSecrets) secretStorage = 'encrypted';
    // A damaged sign-in only drops the sign-in, never the server entry.
    let auth = null;
    let encryptedAuth;
    if (!stdio && value.auth !== undefined) {
      try {
        auth = normalizeAuth(value.auth);
        encryptedAuth = isBase64(value.encryptedAuth) ? value.encryptedAuth : undefined;
        auth.storage = encryptedAuth ? 'encrypted' : 'session';
      } catch {
        auth = null;
      }
    }
    return buildRecord({
      auth,
      encryptedAuth,
      name: normalizeName(value.name),
      transport,
      command: stdio ? normalizeCommand(value.command) : null,
      args: stdio ? normalizeArgs(value.args) : [],
      cwd: stdio ? normalizeCwd(value.cwd) : null,
      url: stdio ? null : normalizeUrl(value.url),
      enabled: value.enabled !== false,
      encryptedSecrets,
      secretKeys: normalizeSecretKeys(value.secretKeys),
      secretStorage,
      createdAt: timestampOf(value.createdAt),
      updatedAt: timestampOf(value.updatedAt),
      lastStatus: LAST_STATUSES.has(value.lastStatus) ? value.lastStatus : 'never',
      lastError: typeof value.lastError === 'string' && value.lastError
        ? truncateChars(value.lastError, MAX_ERROR_CHARS) : null,
      toolCount: Number.isSafeInteger(value.toolCount) && value.toolCount >= 0
        ? Math.min(value.toolCount, MAX_TOOLS_PER_SERVER) : 0,
    });
  } catch {
    return null;
  }
}

function normalizeServerInfo(value) {
  const info = isRecord(value) ? value : {};
  return { name: cleanText(info.name, 128), version: cleanText(info.version, 64) };
}

function normalizeTool(value) {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  const { name } = value;
  if (!name || name.length > MAX_TOOL_NAME_CHARS || UNPRINTABLE.test(name)) return null;
  const annotations = isRecord(value.annotations) ? value.annotations : {};
  let inputSchema = isRecord(value.inputSchema) ? value.inputSchema : null;
  if (inputSchema) {
    try {
      if (Buffer.byteLength(JSON.stringify(inputSchema)) > MAX_SCHEMA_BYTES) inputSchema = null;
    } catch {
      inputSchema = null;
    }
  }
  return {
    name,
    title: cleanText(value.title, MAX_TOOL_TITLE_CHARS) || cleanText(annotations.title, MAX_TOOL_TITLE_CHARS) || name,
    description: typeof value.description === 'string'
      ? truncateChars(stripControls(value.description).trim(), MAX_CHAT_DESCRIPTION_CHARS) : '',
    inputSchema,
    readOnly: annotations.readOnlyHint === true,
  };
}

function summarizeTool(tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: truncateChars(tool.description, MAX_SUMMARY_DESCRIPTION_CHARS),
    readOnly: tool.readOnly,
  };
}

function placeholderUri(value) {
  return cleanText(value, 256) || 'unknown';
}

function normalizeCallResult(result) {
  const parts = [];
  const contentTypes = [];
  let bytes = 0;
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    const type = typeof item.type === 'string' && CONTENT_TYPE_PATTERN.test(item.type) ? item.type : 'unknown';
    if (!contentTypes.includes(type) && contentTypes.length < 16) contentTypes.push(type);
    let part;
    if (type === 'text') part = typeof item.text === 'string' ? item.text : '';
    else if (type === 'image' || type === 'audio') {
      part = `[${type}: ${typeof item.mimeType === 'string' && MIME_PATTERN.test(item.mimeType) ? item.mimeType : 'unknown'}]`;
    } else if (type === 'resource') part = `[resource: ${placeholderUri(isRecord(item.resource) ? item.resource.uri : '')}]`;
    else if (type === 'resource_link') part = `[resource: ${placeholderUri(item.uri)}]`;
    else part = `[${type}]`;
    parts.push(part);
    bytes += Buffer.byteLength(part) + 1;
    if (bytes > MAX_RESULT_BYTES) break;
  }
  const output = { isError: result.isError === true, text: capText(parts.join('\n'), MAX_RESULT_BYTES) };
  if (isRecord(result.structuredContent)) {
    try {
      if (Buffer.byteLength(JSON.stringify(result.structuredContent)) <= MAX_RESULT_BYTES) {
        output.structured = result.structuredContent;
      }
    } catch { /* unserializable structured content is dropped */ }
  }
  output.contentTypes = contentTypes;
  return output;
}

function rpcError(error, redact) {
  const detail = isRecord(error) && typeof error.message === 'string'
    ? cleanText(redact(error.message), MAX_REMOTE_TEXT_CHARS) : '';
  const code = isRecord(error) && Number.isSafeInteger(error.code) ? ` (${error.code})` : '';
  return new McpError(redact(detail ? `MCP server error: ${detail}${code}` : `MCP server returned an error${code}.`));
}

function containsResponse(payload, id) {
  if (Array.isArray(payload)) return payload.some((item) => containsResponse(item, id));
  return isRecord(payload) && payload.id === id && typeof payload.method !== 'string'
    && (Object.hasOwn(payload, 'result') || Object.hasOwn(payload, 'error'));
}

function abortPromise(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function cancelBody(response) {
  if (response?.body?.cancel) void response.body.cancel().catch(() => {});
}

function tooLarge() {
  return new McpError('MCP server response exceeds the 4 MB limit.');
}

async function readBody(response, signal, limit) {
  const declared = response.headers?.get?.('content-length');
  if (declared && Number(declared) > limit) {
    cancelBody(response);
    throw tooLarge();
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new McpError('MCP server returned an empty or unreadable response.');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const stop = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        stop();
        throw tooLarge();
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    signal.removeEventListener('abort', stop);
    try { reader.releaseLock(); } catch { /* the lock is already gone */ }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
  } catch {
    throw new McpError('MCP server returned text that is not valid UTF-8.', 'MCP_PROTOCOL');
  }
}

// Incremental text/event-stream parser: CRLF, LF and CR line endings, `data:`
// lines joined by '\n', blank lines dispatch. Only `message` events (the
// default type) carry JSON-RPC payloads.
function createSseParser(onData) {
  let buffer = '';
  let scanFrom = 0;
  let data = [];
  let eventType = '';
  function dispatch() {
    const type = eventType || 'message';
    const payload = data.join('\n');
    const hasData = data.length > 0;
    data = [];
    eventType = '';
    if (hasData && type === 'message') onData(payload);
  }
  function processLine(line) {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') eventType = value;
  }
  return {
    feed(text, final) {
      buffer += text;
      let start = 0;
      let index = scanFrom;
      for (; index < buffer.length; index += 1) {
        const code = buffer.charCodeAt(index);
        if (code !== 10 && code !== 13) continue;
        // A trailing CR may be the first half of a CRLF split across chunks.
        if (code === 13 && index + 1 === buffer.length && !final) break;
        processLine(buffer.slice(start, index));
        if (code === 13 && buffer.charCodeAt(index + 1) === 10) index += 1;
        start = index + 1;
      }
      buffer = buffer.slice(start);
      scanFrom = Math.max(0, index - start);
      if (final) {
        if (buffer) processLine(buffer);
        buffer = '';
        scanFrom = 0;
        // Be lenient with servers that close the stream without a final blank line.
        dispatch();
      }
    },
  };
}

function spawnError(error, command) {
  const shown = cleanText(command, 200);
  if (error?.code === 'ENOENT') return new McpError(`Command not found: ${shown}`);
  if (error?.code === 'EACCES') return new McpError(`Command is not executable: ${shown}`);
  const code = typeof error?.code === 'string' ? ` (${cleanText(error.code, 32)})` : '';
  return new McpError(`Could not start the MCP server command: ${shown}${code}`);
}

// Newline-delimited JSON-RPC over a child process. Handlers are
// { onMessage(message), onClose(error) }; onClose fires once when the process
// fails or exits on its own, never for an explicit close().
function createStdioTransport({ command, args, cwd, env, spawnImpl, platform, redact }) {
  let child = null;
  let handlers = null;
  let failed = false;
  let closing = false;
  let exited = false;
  let exitInfo = null;
  let drainTimer = null;
  let closePromise = null;
  let stderrTail = Buffer.alloc(0);
  let lineChunks = [];
  let lineBytes = 0;
  let resolveExit;
  const exitPromise = new Promise((resolve) => { resolveExit = resolve; });

  function excerpt() {
    if (!stderrTail.length) return '';
    let start = 0;
    while (start < stderrTail.length && (stderrTail[start] & 0xc0) === 0x80) start += 1;
    const text = redact(cleanText(redact(stderrTail.subarray(start).toString('utf8')), Infinity));
    return text.length > MAX_STDERR_EXCERPT_CHARS ? `...${tailChars(text, MAX_STDERR_EXCERPT_CHARS)}` : text;
  }

  function fail(reason) {
    if (failed || closing) return;
    failed = true;
    const base = reason instanceof McpError ? reason.message : reason;
    const output = excerpt();
    handlers?.onClose(new McpError(redact(output ? `${base} Server output: ${output}` : base)));
  }

  function reportExit() {
    const { code, signal } = exitInfo || {};
    fail(signal ? `MCP server process was terminated by ${signal}.` : `MCP server process exited with code ${code}.`);
  }

  function noteExit(code, signal) {
    if (exited) return;
    exited = true;
    exitInfo = { code, signal };
    resolveExit();
  }

  function handleLine(buffer) {
    const text = buffer.toString('utf8').trim();
    // Servers (and package-runner wrappers) sometimes print banners on stdout.
    if (!text || (text[0] !== '{' && text[0] !== '[')) return;
    let message;
    try { message = JSON.parse(text); } catch { return; }
    handlers?.onMessage(message);
  }

  function onStdout(data) {
    if (failed || closing) return;
    const chunk = typeof data === 'string' ? Buffer.from(data) : data;
    let start = 0;
    let newline = chunk.indexOf(10, start);
    while (newline !== -1) {
      const size = lineBytes + (newline - start);
      if (size > MAX_MESSAGE_BYTES) {
        fail('MCP server sent a message larger than the 4 MB limit.');
        return;
      }
      const piece = chunk.subarray(start, newline);
      const line = lineChunks.length ? Buffer.concat([...lineChunks, piece], size) : piece;
      lineChunks = [];
      lineBytes = 0;
      handleLine(line);
      if (failed || closing) return;
      start = newline + 1;
      newline = chunk.indexOf(10, start);
    }
    if (start < chunk.length) {
      lineBytes += chunk.length - start;
      if (lineBytes > MAX_MESSAGE_BYTES) {
        lineChunks = [];
        lineBytes = 0;
        fail('MCP server sent a message larger than the 4 MB limit.');
        return;
      }
      lineChunks.push(chunk.subarray(start));
    }
  }

  function onStderr(data) {
    const chunk = typeof data === 'string' ? Buffer.from(data) : data;
    const combined = stderrTail.length ? Buffer.concat([stderrTail, chunk]) : Buffer.from(chunk);
    stderrTail = combined.length > MAX_STDERR_BYTES ? combined.subarray(combined.length - MAX_STDERR_BYTES) : combined;
  }

  function start(nextHandlers) {
    handlers = nextHandlers;
    if (cwd) {
      let directory = false;
      try { directory = fs.statSync(cwd).isDirectory(); } catch { directory = false; }
      // Checked up front: spawn reports a missing cwd as ENOENT, which would
      // otherwise surface as a misleading "Command not found".
      if (!directory) return Promise.reject(new McpError(`Working directory not found: ${cleanText(cwd, 200)}`));
    }
    try {
      child = spawnImpl(command, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      return Promise.reject(spawnError(error, command));
    }
    if (!child || !child.stdin || !child.stdout) {
      return Promise.reject(new McpError('MCP server process could not be started.'));
    }
    child.on('error', (error) => fail(spawnError(error, command)));
    child.on('exit', (code, signal) => {
      noteExit(code, signal);
      // Give the pipes a moment to deliver the last stderr bytes for the excerpt.
      if (!closing && !failed) drainTimer = setTimeout(reportExit, EXIT_DRAIN_MS);
    });
    child.on('close', (code, signal) => {
      noteExit(code, signal);
      clearTimeout(drainTimer);
      reportExit();
    });
    child.stdout.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    // EPIPE and friends surface through 'exit'/'close'; these only prevent crashes.
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.stderr?.on('error', () => {});
    return Promise.resolve();
  }

  function send(message) {
    if (failed || closing || !child) return Promise.reject(new McpError('MCP server connection was closed.'));
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      return Promise.reject(new McpError('Could not write to the MCP server process.'));
    }
    return Promise.resolve();
  }

  function signalGroup(signal) {
    if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return;
    if (platform !== 'win32') {
      // The child leads its own process group (detached), so launcher
      // wrappers take their grandchildren down with them.
      try {
        process.kill(-child.pid, signal);
        return;
      } catch { /* the group is gone or not ours; fall back to the direct child */ }
    }
    if (!exited) {
      try { child.kill(signal); } catch { /* already exited */ }
    }
  }

  // Ends stdin, SIGTERMs the process group, SIGKILLs after 2 s, and resolves
  // once the child has exited (or after a final grace period). Never rejects.
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    clearTimeout(drainTimer);
    closePromise = new Promise((resolve) => {
      if (!child) {
        resolve();
        return;
      }
      try { child.stdin.end(); } catch { /* stdin already closed */ }
      signalGroup('SIGTERM');
      if (exited) {
        resolve();
        return;
      }
      let killTimer = null;
      let giveUpTimer = null;
      const finish = () => {
        clearTimeout(killTimer);
        clearTimeout(giveUpTimer);
        resolve();
      };
      void exitPromise.then(finish);
      killTimer = setTimeout(() => {
        if (!exited) signalGroup('SIGKILL');
        giveUpTimer = setTimeout(finish, EXIT_WAIT_MS);
      }, KILL_GRACE_MS);
    });
    return closePromise;
  }

  return { start, send, close, excerpt, setProtocolVersion() {} };
}

function httpStatusError(status, initializing) {
  if (status === 401 || status === 403) return new McpError(`MCP server rejected the credentials (HTTP ${status}).`);
  if (status === 429) return new McpError('MCP server rate limited the request (HTTP 429).');
  if (initializing && (status === 404 || status === 405)) {
    return new McpError(`MCP server returned HTTP ${status}. Check that the URL points to a Streamable HTTP MCP endpoint.`);
  }
  return new McpError(`MCP server returned HTTP ${status}.`);
}

function mediaType(response) {
  const value = response.headers?.get?.('content-type');
  return typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
}

// Streamable HTTP (MCP 2025-03-26+): every client message is POSTed; replies
// come back as JSON or as an SSE stream on the same response.
// `auth` (OAuth sign-ins only) is { header(): Promise<string>, refresh(): Promise<void> }.
function createHttpTransport({ url, headers, fetchImpl, auth = null }) {
  let handlers = null;
  let sessionId = null;
  let protocolVersion = null;
  let closed = false;
  let expired = false;
  let closePromise = null;
  let authorization = null;
  const active = new Set();

  function requestHeaders(extra) {
    const result = { ...headers };
    // The sign-in's token replaces any configured Authorization header.
    if (authorization) {
      for (const name of Object.keys(result)) if (name.toLowerCase() === 'authorization') delete result[name];
      result.Authorization = authorization;
    }
    if (sessionId) result['Mcp-Session-Id'] = sessionId;
    if (protocolVersion) result['MCP-Protocol-Version'] = protocolVersion;
    return Object.assign(result, extra);
  }

  async function post(message, signal) {
    if (auth) authorization = await auth.header();
    return fetchImpl(url, {
      method: 'POST',
      headers: requestHeaders({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }),
      body: JSON.stringify(message),
      signal,
      redirect: 'error',
      credentials: 'omit',
    });
  }

  async function readEventStream(response, signal, requestId) {
    if (!response.body || typeof response.body.getReader !== 'function') {
      throw new McpError('MCP server returned an unreadable event stream.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let matched = false;
    let total = 0;
    const parser = createSseParser((data) => {
      let payload;
      try { payload = JSON.parse(data); } catch { return; }
      if (containsResponse(payload, requestId)) matched = true;
      handlers?.onMessage(payload);
    });
    const stop = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', stop, { once: true });
    try {
      while (!matched) {
        if (signal.aborted) throw signal.reason;
        const { done, value } = await reader.read();
        if (signal.aborted) throw signal.reason;
        if (done) {
          parser.feed(decoder.decode(), true);
          break;
        }
        total += value.byteLength;
        if (total > MAX_MESSAGE_BYTES) throw tooLarge();
        parser.feed(decoder.decode(value, { stream: true }), false);
      }
    } finally {
      signal.removeEventListener('abort', stop);
      // Once the matching response arrived the rest of the stream is not needed.
      stop();
      try { reader.releaseLock(); } catch { /* the lock is already gone */ }
    }
    if (!matched) throw new McpError('MCP server closed the event stream before responding.', 'MCP_PROTOCOL');
  }

  async function exchange(message, signal) {
    const isRequest = typeof message.method === 'string' && message.id !== undefined;
    const initializing = message.method === 'initialize';
    let response = await post(message, signal);
    if (signal.aborted) {
      cancelBody(response);
      throw signal.reason;
    }
    if (!response || typeof response.status !== 'number') throw new McpError('MCP server returned an invalid HTTP response.');
    // An expired or revoked access token: refresh once and resend the same message.
    if (response.status === 401 && auth) {
      cancelBody(response);
      await auth.refresh();
      if (signal.aborted) throw signal.reason;
      response = await post(message, signal);
      if (signal.aborted) {
        cancelBody(response);
        throw signal.reason;
      }
      if (!response || typeof response.status !== 'number') throw new McpError('MCP server returned an invalid HTTP response.');
      if (response.status === 401) {
        cancelBody(response);
        throw authExpiredError();
      }
    }
    if (response.status === 401 && !auth && /\bbearer\b/i.test(String(response.headers?.get?.('www-authenticate') || ''))
      && Object.keys(headers).every((name) => name.toLowerCase() !== 'authorization')) {
      cancelBody(response);
      throw new McpError('This MCP server requires sign-in. Choose Sign in to connect it.', 'MCP_AUTH_REQUIRED');
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      cancelBody(response);
      throw new McpError('MCP server redirects are not allowed.');
    }
    if (response.status === 404 && sessionId) {
      cancelBody(response);
      expired = true;
      const error = new McpError('MCP session expired; retry.');
      handlers?.onClose(error);
      throw error;
    }
    if (response.status < 200 || response.status >= 300) {
      cancelBody(response);
      throw httpStatusError(response.status, initializing);
    }
    if (initializing) {
      const value = response.headers?.get?.('mcp-session-id');
      if (value) {
        if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
          cancelBody(response);
          throw new McpError('MCP server returned an invalid session id.', 'MCP_PROTOCOL');
        }
        sessionId = value;
      }
    }
    // Notifications and client responses are acknowledged with 202 Accepted.
    if (!isRequest) {
      cancelBody(response);
      return;
    }
    if (response.status === 202 || response.status === 204) {
      cancelBody(response);
      throw new McpError('MCP server did not return a response.', 'MCP_PROTOCOL');
    }
    const type = mediaType(response);
    if (type === 'text/event-stream') {
      await readEventStream(response, signal, message.id);
      return;
    }
    if (type !== 'application/json' && !type.endsWith('+json')) {
      cancelBody(response);
      throw new McpError('MCP server returned an unsupported content type.', 'MCP_PROTOCOL');
    }
    const text = await readBody(response, signal, MAX_MESSAGE_BYTES);
    let payload;
    try { payload = JSON.parse(text); } catch {
      throw new McpError('MCP server returned invalid JSON.', 'MCP_PROTOCOL');
    }
    handlers?.onMessage(payload);
    if (!containsResponse(payload, message.id)) {
      throw new McpError('MCP server response did not match the request.', 'MCP_PROTOCOL');
    }
  }

  async function send(message, { signal, timeoutMs = NOTIFY_TIMEOUT_MS } = {}) {
    if (closed) throw new McpError('MCP server connection was closed.');
    const controller = new AbortController();
    const forward = () => controller.abort(new McpError('MCP request was cancelled.'));
    if (signal?.aborted) forward();
    else signal?.addEventListener('abort', forward, { once: true });
    const timer = setTimeout(() => {
      controller.abort(new McpError(`MCP server did not respond within ${Math.round(timeoutMs / 1000)} seconds.`, 'MCP_TIMEOUT'));
    }, timeoutMs);
    active.add(controller);
    try {
      // Racing abort also handles injected fetch implementations that ignore their signal.
      return await Promise.race([exchange(message, controller.signal), abortPromise(controller.signal)]);
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof McpError ? reason : new McpError('MCP request was cancelled.');
      }
      if (error instanceof McpError) throw error;
      // Node's fetch reports `redirect: 'error'` as a generic network failure.
      if (/redirect/i.test(String(error?.cause?.message ?? ''))) throw new McpError('MCP server redirects are not allowed.');
      throw new McpError('Could not reach the MCP server.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
      active.delete(controller);
    }
  }

  // Aborts in-flight requests and ends the session with a best-effort DELETE.
  function close() {
    if (closePromise) return closePromise;
    closed = true;
    for (const controller of active) controller.abort(new McpError('MCP server connection was closed.'));
    active.clear();
    if (!sessionId || expired) {
      closePromise = Promise.resolve();
      return closePromise;
    }
    closePromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new McpError('MCP session close timed out.')), DELETE_TIMEOUT_MS);
      try {
        const response = await Promise.race([
          fetchImpl(url, {
            method: 'DELETE', headers: requestHeaders({}), signal: controller.signal, redirect: 'error', credentials: 'omit',
          }),
          abortPromise(controller.signal),
        ]);
        cancelBody(response);
      } catch { /* best effort: the server may already be gone */ } finally {
        clearTimeout(timer);
      }
    })();
    return closePromise;
  }

  return {
    start(nextHandlers) { handlers = nextHandlers; return Promise.resolve(); },
    send,
    close,
    excerpt: () => '',
    setProtocolVersion(version) { protocolVersion = version; },
  };
}

// JSON-RPC 2.0 client shared by both transports. States: idle -> connecting
// -> ready -> closed. `onClose` fires once when the connection ends for any
// reason so the manager can evict the cached client.
function createRpcClient({ transport, clientInfo, redact, onClose }) {
  const pending = new Map();
  let nextId = 1;
  let state = 'idle';
  let closeError = null;
  let closePromise = null;
  let toolsCache = null;
  let toolsPromise = null;
  let toolsEpoch = 0;

  const client = {
    serverInfo: null,
    protocolVersion: null,
    capabilities: {},
    get ready() { return state === 'ready'; },
    get closed() { return state === 'closed'; },
    connect,
    listTools,
    callTool,
    close,
  };

  function closedError() {
    return closeError || new McpError('MCP server connection was closed.');
  }

  function shutdown(error) {
    if (state !== 'closed') {
      state = 'closed';
      closeError = error;
      for (const entry of [...pending.values()]) entry.reject(error);
      try { onClose?.(error); } catch { /* eviction hooks never break shutdown */ }
    }
    if (!closePromise) {
      try {
        closePromise = Promise.resolve(transport.close()).then(() => {}, () => {});
      } catch {
        closePromise = Promise.resolve();
      }
    }
    return closePromise;
  }

  function close() {
    return shutdown(closedError());
  }

  function transmit(message, options) {
    try {
      return Promise.resolve(transport.send(message, options));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function notify(method, params) {
    if (state === 'closed') return Promise.reject(closedError());
    const message = { jsonrpc: '2.0', method };
    if (params !== undefined) message.params = params;
    return transmit(message, { timeoutMs: NOTIFY_TIMEOUT_MS });
  }

  function request(method, params, timeoutMs) {
    if (state === 'closed') return Promise.reject(closedError());
    const id = nextId;
    nextId += 1;
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      let done = false;
      let timer = null;
      const settle = (error, result) => {
        if (done) return;
        done = true;
        pending.delete(id);
        clearTimeout(timer);
        // Releases an HTTP response stream that is still open for this request.
        controller.abort();
        if (error) reject(error);
        else resolve(result);
      };
      timer = setTimeout(() => {
        settle(new McpError(`MCP server did not answer ${method} within ${timeoutMs / 1000} seconds.`, 'MCP_TIMEOUT'));
        // initialize must never be cancelled; everything else gets a courtesy notice.
        if (method !== 'initialize' && state !== 'closed') {
          notify('notifications/cancelled', { requestId: id, reason: 'Request timed out.' }).catch(() => {});
        }
      }, timeoutMs);
      pending.set(id, { resolve: (result) => settle(null, result), reject: (error) => settle(error) });
      const message = { jsonrpc: '2.0', id, method };
      if (params !== undefined) message.params = params;
      transmit(message, { signal: controller.signal, timeoutMs }).catch((error) => settle(toMcpError(error)));
    });
  }

  function respond(id, payload) {
    if (state === 'closed') return;
    transmit({ jsonrpc: '2.0', id, ...payload }, { timeoutMs: NOTIFY_TIMEOUT_MS }).catch(() => {});
  }

  function handleMessage(message) {
    if (Array.isArray(message)) {
      for (const item of message) if (!Array.isArray(item)) handleMessage(item);
      return;
    }
    if (!isRecord(message) || state === 'closed') return;
    if (typeof message.method === 'string') {
      const isRequest = typeof message.id === 'number' || typeof message.id === 'string';
      if (isRequest) {
        // No client capabilities are declared, so ping is the only server
        // request this client serves.
        if (message.method === 'ping') respond(message.id, { result: {} });
        else respond(message.id, { error: { code: -32601, message: 'Method not found' } });
      } else if (message.method === 'notifications/tools/list_changed') {
        toolsCache = null;
        toolsPromise = null;
        toolsEpoch += 1;
      }
      return;
    }
    if (typeof message.id !== 'number') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    if (Object.hasOwn(message, 'error')) entry.reject(rpcError(message.error, redact));
    else if (Object.hasOwn(message, 'result')) entry.resolve(message.result);
  }

  async function connect() {
    if (state !== 'idle') throw new McpError('MCP client was already started.');
    state = 'connecting';
    try {
      await transport.start({ onMessage: handleMessage, onClose: shutdown });
      const result = await request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo,
      }, INITIALIZE_TIMEOUT_MS);
      if (!isRecord(result)) throw new McpError('MCP server returned an invalid initialize result.', 'MCP_PROTOCOL');
      const version = result.protocolVersion;
      if (typeof version !== 'string' || !SUPPORTED_PROTOCOL_VERSIONS.has(version)) {
        const shown = cleanText(redact(typeof version === 'string' ? version : ''), 32);
        throw new McpError(`Unsupported MCP protocol version${shown ? ` "${shown}"` : ''}.`, 'MCP_PROTOCOL');
      }
      client.protocolVersion = version;
      client.serverInfo = normalizeServerInfo(result.serverInfo);
      client.capabilities = isRecord(result.capabilities) ? result.capabilities : {};
      transport.setProtocolVersion(version);
      await notify('notifications/initialized');
      if (state === 'closed') throw closedError();
      state = 'ready';
      return client;
    } catch (error) {
      let failure = toMcpError(error);
      const output = failure.code === 'MCP_TIMEOUT' ? transport.excerpt() : '';
      if (output) failure = new McpError(redact(`${failure.message} Server output: ${output}`), 'MCP_TIMEOUT');
      void shutdown(failure);
      throw state === 'closed' && closeError ? closeError : failure;
    }
  }

  async function fetchTools() {
    const declared = client.capabilities.tools;
    if (declared === undefined || declared === null || declared === false) return [];
    const tools = [];
    const names = new Set();
    let cursor;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await request('tools/list', cursor === undefined ? {} : { cursor }, LIST_TIMEOUT_MS);
      if (!isRecord(result) || !Array.isArray(result.tools)) {
        throw new McpError('MCP server returned an invalid tools/list result.', 'MCP_PROTOCOL');
      }
      for (const raw of result.tools) {
        const tool = normalizeTool(raw);
        if (!tool || names.has(tool.name)) continue;
        names.add(tool.name);
        tools.push(tool);
        if (tools.length >= MAX_TOOLS_PER_SERVER) return tools;
      }
      const next = result.nextCursor;
      if (typeof next !== 'string' || !next || next.length > MAX_CURSOR_CHARS || next === cursor) break;
      cursor = next;
    }
    return tools;
  }

  function listTools() {
    if (state !== 'ready') return Promise.reject(state === 'closed' ? closedError() : new McpError('MCP server is not connected.'));
    if (toolsCache) return Promise.resolve(toolsCache);
    if (!toolsPromise) {
      const epoch = toolsEpoch;
      const promise = fetchTools().then((tools) => {
        // A list_changed notification during the fetch makes this result stale.
        if (epoch === toolsEpoch) toolsCache = tools;
        return tools;
      });
      toolsPromise = promise;
      const clear = () => { if (toolsPromise === promise) toolsPromise = null; };
      promise.then(clear, clear);
    }
    return toolsPromise;
  }

  async function callTool(name, args) {
    if (state !== 'ready') throw state === 'closed' ? closedError() : new McpError('MCP server is not connected.');
    const result = await request('tools/call', { name, arguments: args }, CALL_TIMEOUT_MS);
    if (!isRecord(result)) throw new McpError('MCP server returned an invalid tools/call result.', 'MCP_PROTOCOL');
    return normalizeCallResult(result);
  }

  return client;
}

function createMcpManager({
  store,
  safeStorage,
  spawnImpl = spawn,
  fetchImpl = fetch,
  now = Date.now,
  clientInfo = { name: 'ScaleMax', version: '1.0.0' },
  env = process.env,
  platform = process.platform,
  oauthClient = null,
} = {}) {
  if (!store || typeof store.readAll !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('An internal state store is required.');
  }
  if (typeof spawnImpl !== 'function') throw new TypeError('A spawn implementation is required.');
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  if (typeof now !== 'function') throw new TypeError('A clock function is required.');
  if (!isRecord(clientInfo) || typeof clientInfo.name !== 'string' || !clientInfo.name
    || typeof clientInfo.version !== 'string' || !clientInfo.version) {
    throw new TypeError('Client info must include a name and a version.');
  }
  if (env === null || typeof env !== 'object') throw new TypeError('A base environment object is required.');
  const info = { name: clientInfo.name.slice(0, 128), version: clientInfo.version.slice(0, 64) };

  // Plaintext secrets live here for the current session only: either because
  // encryption is unavailable, or decrypted lazily from the persisted blob.
  const sessionSecrets = new Map();
  // id -> { client, ready, revision }; entries are registered synchronously
  // so closeAll() also reaches connections that are still initializing.
  const clients = new Map();
  // Bumped on save/remove so late results of an old configuration are ignored.
  const revisions = new Map();
  // OAuth sign-ins: decrypted { clientSecret, accessToken, refreshToken } per server id, and one
  // token provider per id so concurrent connections share a single (rotating) refresh token.
  const sessionAuth = new Map();
  const authProviders = new Map();
  const signIn = oauthClient || createMcpOAuth({ fetchImpl, now });
  // Only one browser sign-in runs at a time: they share the loopback callback port.
  let pendingOAuth = null;

  function timestamp() {
    const value = now();
    return Number.isFinite(value) && value >= 0 ? value : Date.now();
  }

  function revisionOf(id) {
    return revisions.get(id) || 0;
  }

  function encryptionAvailable() {
    try {
      return safeStorage?.isEncryptionAvailable?.() === true;
    } catch {
      return false;
    }
  }

  function readRecords() {
    let container;
    try { container = store.readAll().mcpServers; } catch {
      throw new McpError('MCP server settings could not be read; repair the state file before continuing.');
    }
    if (container === undefined) return new Map();
    if (!isRecord(container)) {
      throw new McpError('Stored MCP server settings are invalid; remove the mcpServers entry before continuing.');
    }
    const records = new Map();
    for (const id of Object.keys(container)) {
      if (!ID_PATTERN.test(id) || RESERVED_IDS.has(id)) continue;
      const record = normalizeStoredRecord(container[id]);
      if (record) records.set(id, record);
      if (records.size >= MAX_SERVERS) break;
    }
    return records;
  }

  function persist(records) {
    const output = {};
    for (const [id, record] of records) output[id] = record;
    try {
      store.update((draft) => {
        if (records.size === 0) delete draft.mcpServers;
        else draft.mcpServers = output;
      });
    } catch {
      throw new McpError('MCP server settings could not be saved.');
    }
  }

  function requireRecord(id) {
    const record = readRecords().get(id);
    if (!record) throw new McpError('MCP server not found.', 'MCP_NOT_FOUND');
    return record;
  }

  // Best effort: status bookkeeping never turns a result into a failure, and
  // it is skipped when nothing changed or the configuration was replaced.
  function recordStatus(id, revision, patch) {
    if (revisionOf(id) !== revision) return;
    try {
      const records = readRecords();
      const record = records.get(id);
      if (!record) return;
      const next = { ...record, ...patch };
      if (typeof next.lastError === 'string') next.lastError = truncateChars(next.lastError, MAX_ERROR_CHARS);
      if (next.lastStatus === record.lastStatus && next.lastError === record.lastError
        && next.toolCount === record.toolCount) return;
      records.set(id, buildRecord(next));
      persist(records);
    } catch { /* the in-memory result still stands */ }
  }

  function decryptSecrets(record) {
    try {
      if (!record.encryptedSecrets || !encryptionAvailable() || typeof safeStorage.decryptString !== 'function') {
        throw new Error();
      }
      const encrypted = Buffer.from(record.encryptedSecrets, 'base64');
      if (!encrypted.length || encrypted.toString('base64') !== record.encryptedSecrets) throw new Error();
      const parsed = JSON.parse(safeStorage.decryptString(encrypted));
      if (!isRecord(parsed)) throw new Error();
      return {
        env: parsed.env === undefined ? {} : normalizeEnv(parsed.env),
        headers: parsed.headers === undefined ? {} : normalizeHeaders(parsed.headers),
      };
    } catch {
      throw new McpError('Stored MCP server secrets could not be decrypted. Enter them again and save the server.');
    }
  }

  function secretsFor(id, record) {
    const cached = sessionSecrets.get(id);
    if (cached) return cached;
    if (record.encryptedSecrets || record.secretStorage === 'encrypted') {
      const secrets = decryptSecrets(record);
      sessionSecrets.set(id, secrets);
      return secrets;
    }
    if (record.secretStorage === 'session' && (record.secretKeys.env.length || record.secretKeys.headers.length)) {
      throw new McpError("This MCP server's secrets were kept only for a previous session. "
        + 'Enter them again and save the server.');
    }
    return { env: {}, headers: {} };
  }

  function encryptAuth(secrets) {
    try {
      if (typeof safeStorage.encryptString !== 'function') throw new Error();
      const encrypted = safeStorage.encryptString(JSON.stringify(secrets));
      if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_CIPHERTEXT_BYTES) throw new Error();
      return encrypted.toString('base64');
    } catch {
      throw new McpError('The sign-in could not be encrypted, so it was not saved.');
    }
  }

  function authSecretsFor(id, record) {
    const cached = sessionAuth.get(id);
    if (cached) return cached;
    if (!record.encryptedAuth || !encryptionAvailable() || typeof safeStorage.decryptString !== 'function') {
      throw authExpiredError();
    }
    let secrets;
    try {
      const encrypted = Buffer.from(record.encryptedAuth, 'base64');
      secrets = normalizeAuthSecrets(JSON.parse(safeStorage.decryptString(encrypted)));
    } catch {
      throw authExpiredError();
    }
    sessionAuth.set(id, secrets);
    return secrets;
  }

  // Stores refreshed tokens, unless the sign-in was replaced or removed meanwhile.
  function storeRefreshedAuth(id, signedInAt, secrets, patch) {
    sessionAuth.set(id, secrets);
    try {
      const records = readRecords();
      const record = records.get(id);
      if (!record?.auth || record.auth.signedInAt !== signedInAt) return;
      const auth = { ...record.auth, ...patch };
      let encryptedAuth;
      if (auth.storage === 'encrypted' && encryptionAvailable()) encryptedAuth = encryptAuth(secrets);
      else auth.storage = 'session';
      records.set(id, buildRecord({ ...record, auth, encryptedAuth }));
      persist(records);
    } catch { /* the refreshed tokens still serve this session */ }
  }

  // Supplies the Bearer header for an OAuth sign-in: refreshes shortly before expiry, and on
  // demand after a 401. One refresh runs at a time; a failed refresh means signing in again.
  function authProviderFor(id, record) {
    if (!record.auth) return null;
    const existing = authProviders.get(id);
    if (existing && existing.signedInAt === record.auth.signedInAt) return existing;
    let secrets = authSecretsFor(id, record);
    let expiresAt = record.auth.expiresAt;
    let refreshing = null;
    const { signedInAt } = record.auth;
    const refresh = () => {
      if (!refreshing) {
        refreshing = (async () => {
          if (!secrets.refreshToken) throw authExpiredError();
          let tokens;
          try {
            tokens = await signIn.refresh(record.auth, secrets);
          } catch {
            throw authExpiredError();
          }
          secrets = { ...secrets, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
          ({ expiresAt } = tokens);
          storeRefreshedAuth(id, signedInAt, secrets, { expiresAt, hasRefreshToken: Boolean(secrets.refreshToken) });
        })().finally(() => { refreshing = null; });
      }
      return refreshing;
    };
    const provider = {
      signedInAt,
      async header() {
        if (expiresAt && timestamp() >= expiresAt - REFRESH_MARGIN_MS && secrets.refreshToken) {
          // A failed early refresh still tries the current token; a 401 then decides.
          try { await refresh(); } catch { /* handled by the 401 path */ }
        }
        return `Bearer ${secrets.accessToken}`;
      },
      refresh,
      tokens: () => [secrets.accessToken, secrets.refreshToken, secrets.clientSecret],
    };
    authProviders.set(id, provider);
    return provider;
  }

  function forgetAuth(id) {
    sessionAuth.delete(id);
    authProviders.delete(id);
  }

  function buildEnv(configured) {
    const merged = {};
    for (const [key, value] of Object.entries(env)) if (typeof value === 'string') merged[key] = value;
    Object.assign(merged, configured);
    if (platform === 'darwin') {
      // GUI-launched apps get a minimal PATH without the usual package bin directories.
      const current = typeof merged.PATH === 'string' && merged.PATH ? merged.PATH : DARWIN_DEFAULT_PATH;
      const parts = current.split(':');
      const missing = DARWIN_EXTRA_PATHS.filter((entry) => !parts.includes(entry));
      merged.PATH = missing.length ? `${current.replace(/:+$/, '')}:${missing.join(':')}` : current;
    }
    return merged;
  }

  function uniqueId(name, records) {
    const base = slugify(name);
    const taken = (candidate) => records.has(candidate) || RESERVED_IDS.has(candidate);
    if (!taken(base)) return base;
    for (let counter = 2; ; counter += 1) {
      const suffix = `-${counter}`;
      const candidate = `${base.slice(0, 64 - suffix.length).replace(/-+$/, '')}${suffix}`;
      if (!taken(candidate)) return candidate;
    }
  }

  function liveClient(id) {
    const entry = clients.get(id);
    return entry && entry.client.ready ? entry.client : null;
  }

  // The renderer-facing shape: key names only, never env/header values.
  function entryFor(id, record) {
    const live = liveClient(id);
    return {
      id,
      name: record.name,
      transport: record.transport,
      command: record.command,
      args: [...record.args],
      cwd: record.cwd,
      url: record.url,
      enabled: record.enabled,
      envKeys: [...record.secretKeys.env],
      headerKeys: [...record.secretKeys.headers],
      secretStorage: record.secretStorage,
      lastStatus: record.lastStatus,
      lastError: record.lastError,
      toolCount: record.toolCount,
      connected: Boolean(live),
      serverInfo: live ? { ...live.serverInfo } : null,
      updatedAt: record.updatedAt,
      // Sign-in metadata only; the client secret and tokens never leave this module.
      auth: record.auth ? {
        type: 'oauth',
        issuer: new URL(record.auth.issuer).host,
        directoryId: record.auth.directoryId,
        expiresAt: record.auth.expiresAt,
        hasRefreshToken: record.auth.hasRefreshToken,
        signedInAt: record.auth.signedInAt,
        storage: record.auth.storage,
      } : null,
      signInPending: pendingOAuth?.id === id,
    };
  }

  function sortedRecords() {
    return [...readRecords()].sort(([leftId, left], [rightId, right]) => (left.createdAt - right.createdAt)
      || (leftId < rightId ? -1 : (leftId > rightId ? 1 : 0)));
  }

  function list() {
    return sortedRecords().map(([id, record]) => entryFor(id, record));
  }

  function evictClient(id) {
    const entry = clients.get(id);
    if (!entry) return Promise.resolve();
    clients.delete(id);
    return entry.client.close();
  }

  function idFrom(input) {
    if (!isRecord(input)) throw new McpError('MCP server request must be an object.');
    return normalizeId(input.id);
  }

  function connectEntry(id, record) {
    const secrets = secretsFor(id, record);
    const auth = record.transport === 'http' ? authProviderFor(id, record) : null;
    const redact = createRedactor(secrets, () => (auth ? auth.tokens() : []));
    const transport = record.transport === 'stdio'
      ? createStdioTransport({
        command: record.command,
        args: record.args,
        cwd: record.cwd,
        env: buildEnv(secrets.env),
        spawnImpl,
        platform,
        redact,
      })
      : createHttpTransport({ url: record.url, headers: { ...secrets.headers }, fetchImpl, auth });
    const entry = { client: null, ready: null, revision: revisionOf(id) };
    entry.client = createRpcClient({
      transport,
      clientInfo: info,
      redact,
      // A dead process or expired session evicts the entry; the next call reconnects.
      onClose: () => { if (clients.get(id) === entry) clients.delete(id); },
    });
    clients.set(id, entry);
    entry.ready = entry.client.connect();
    // Callers observe failures through `ready`; this only avoids unhandled rejections.
    entry.ready.catch(() => {});
    return entry;
  }

  async function acquire(id, record) {
    let entry = clients.get(id);
    if (entry?.client.closed) {
      clients.delete(id);
      entry = undefined;
    }
    try {
      if (!entry) entry = connectEntry(id, record);
      await entry.ready;
    } catch (error) {
      const failure = toMcpError(error);
      recordStatus(id, entry ? entry.revision : revisionOf(id), { lastStatus: 'error', lastError: failure.message });
      throw failure;
    }
    return entry;
  }

  function encryptSecrets(serialized) {
    try {
      if (typeof safeStorage.encryptString !== 'function') throw new Error();
      const encrypted = safeStorage.encryptString(serialized);
      if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_CIPHERTEXT_BYTES) throw new Error();
      return encrypted.toString('base64');
    } catch {
      throw new McpError('MCP server secret encryption failed; the server was not saved.');
    }
  }

  function save(input) {
    if (!isRecord(input)) throw new McpError('MCP server settings must be an object.');
    const name = normalizeName(input.name);
    const transport = normalizeTransport(input.transport);
    const stdio = transport === 'stdio';
    const command = stdio ? normalizeCommand(input.command) : null;
    const args = stdio ? normalizeArgs(input.args) : [];
    const cwd = stdio ? normalizeCwd(input.cwd) : null;
    const url = stdio ? null : normalizeUrl(input.url);
    // Env applies to stdio servers and headers to HTTP servers; the other
    // field is ignored. Omitted means "keep what is stored".
    const secretField = stdio ? 'env' : 'headers';
    const provided = input[secretField] !== undefined;
    let incoming = null;
    if (provided) incoming = stdio ? normalizeEnv(input.env) : normalizeHeaders(input.headers);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
      throw new McpError('MCP server enabled flag must be a boolean.');
    }
    const records = readRecords();
    const id = input.id === undefined ? uniqueId(name, records) : normalizeId(input.id);
    const existing = records.get(id);
    if (!existing && records.size >= MAX_SERVERS) {
      throw new McpError(`At most ${MAX_SERVERS} MCP servers can be configured.`);
    }
    const keepExisting = !provided && existing?.transport === transport;
    let secretKeys = { env: [], headers: [] };
    let secretStorage = 'none';
    let encryptedSecrets;
    let sessionValue = null;
    if (keepExisting) {
      ({ secretKeys, secretStorage, encryptedSecrets } = existing);
    } else if (incoming && Object.keys(incoming).length) {
      const secrets = stdio ? { env: incoming, headers: {} } : { env: {}, headers: incoming };
      const serialized = JSON.stringify(secrets);
      if (Buffer.byteLength(serialized) > MAX_SECRETS_BYTES) {
        throw new McpError('MCP server secrets exceed the 64 KB limit.');
      }
      secretKeys = { env: Object.keys(secrets.env), headers: Object.keys(secrets.headers) };
      if (encryptionAvailable()) {
        encryptedSecrets = encryptSecrets(serialized);
        secretStorage = 'encrypted';
      } else {
        // Never persisted in plaintext: the values last for this session only.
        secretStorage = 'session';
      }
      sessionValue = secrets;
    }
    // A sign-in belongs to one server URL; changing the URL (or transport) drops it.
    const keepAuth = Boolean(existing?.auth) && !stdio && existing.url === url;
    const at = timestamp();
    const record = buildRecord({
      name,
      transport,
      command,
      args,
      cwd,
      url,
      auth: keepAuth ? existing.auth : null,
      encryptedAuth: keepAuth ? existing.encryptedAuth : undefined,
      enabled: input.enabled ?? existing?.enabled ?? true,
      encryptedSecrets,
      secretKeys,
      secretStorage,
      createdAt: existing ? existing.createdAt : at,
      updatedAt: at,
      lastStatus: 'never',
      lastError: null,
      toolCount: 0,
    });
    records.set(id, record);
    persist(records);
    revisions.set(id, revisionOf(id) + 1);
    if (!keepExisting) {
      if (sessionValue) sessionSecrets.set(id, sessionValue);
      else sessionSecrets.delete(id);
    }
    if (!keepAuth) forgetAuth(id);
    void evictClient(id);
    return entryFor(id, record);
  }

  function remove(input) {
    const id = idFrom(input);
    const records = readRecords();
    const removed = records.delete(id);
    if (removed) persist(records);
    revisions.set(id, revisionOf(id) + 1);
    sessionSecrets.delete(id);
    forgetAuth(id);
    if (pendingOAuth?.id === id) cancelOAuth();
    void evictClient(id);
    return { removed };
  }

  function oauthFailure(error) {
    if (error instanceof McpError) return error;
    if (error instanceof OAuthError) return new McpError(error.message, error.code);
    return new McpError('MCP sign-in failed.', 'MCP_OAUTH_FAILED');
  }

  // The server a sign-in is for: a directory listing (by connector id) or a saved HTTP server.
  function signInTarget(input) {
    if (!isRecord(input)) throw new McpError('MCP sign-in request must be an object.');
    if (input.connectorId !== undefined) {
      const listing = directory.forConnector(input.connectorId);
      if (!listing) throw new McpError('This connector has no one-click sign-in.', 'MCP_NOT_FOUND');
      const url = normalizeUrl(listing.url);
      const records = readRecords();
      // Signing in again reuses the server entry; a user's own server with the same id is left alone.
      for (const [id, record] of records) {
        if (record.transport === 'http' && (record.auth?.directoryId === listing.id || record.url === url)) {
          return { id, name: listing.name, url, directoryId: listing.id };
        }
      }
      const id = records.has(listing.id) ? uniqueId(listing.id, records) : listing.id;
      return { id, name: listing.name, url, directoryId: listing.id };
    }
    const id = normalizeId(input.id);
    const record = requireRecord(id);
    // lib/mcp-oauth.cjs refuses anything but an https:// server URL.
    if (record.transport !== 'http') throw new McpError('Only remote (HTTP) MCP servers support sign-in.');
    return { id, name: record.name, url: record.url, directoryId: record.auth?.directoryId ?? directory.byId(id)?.id ?? null };
  }

  /**
   * Zero-setup browser sign-in (MCP authorization with dynamic client registration). Saves or
   * updates the server, then connects it and lists its tools. Starting another sign-in cancels
   * the one in progress. Resolves to the sanitized list entry.
   */
  async function startOAuth(input, { openExternal } = {}) {
    const target = signInTarget(input);
    if (typeof openExternal !== 'function') throw new McpError('A browser opener is required for sign-in.');
    if (pendingOAuth) pendingOAuth.controller.abort();
    const mine = { id: target.id, controller: new AbortController() };
    pendingOAuth = mine;
    try {
      const result = await signIn.signIn({
        serverUrl: target.url,
        signal: mine.controller.signal,
        // Only https consent pages ever reach the browser (lib/oauth.cjs checks the URL too).
        openExternal: (address) => {
          if (typeof address !== 'string' || !address.startsWith('https://')) throw new Error('Refusing a non-HTTPS page.');
          return openExternal(address);
        },
      });
      if (pendingOAuth !== mine) throw new McpError('MCP sign-in was cancelled.', 'CANCELLED');
      const records = readRecords();
      const existing = records.get(target.id);
      if (!existing && records.size >= MAX_SERVERS) {
        throw new McpError(`At most ${MAX_SERVERS} MCP servers can be configured.`);
      }
      const sameServer = existing?.transport === 'http' && existing.url === target.url;
      let auth = null;
      let encryptedAuth;
      if (result.required) {
        auth = { ...result.auth, directoryId: target.directoryId, signedInAt: timestamp() };
        if (encryptionAvailable()) {
          encryptedAuth = encryptAuth(result.secrets);
          auth.storage = 'encrypted';
        } else {
          // Never persisted in plaintext: the sign-in lasts for this session only.
          auth.storage = 'session';
        }
        auth = normalizeAuth(auth);
      }
      const at = timestamp();
      records.set(target.id, buildRecord({
        name: existing?.name || target.name,
        transport: 'http',
        command: null,
        args: [],
        cwd: null,
        url: target.url,
        auth,
        encryptedAuth,
        enabled: true,
        encryptedSecrets: sameServer ? existing.encryptedSecrets : undefined,
        secretKeys: sameServer ? existing.secretKeys : { env: [], headers: [] },
        secretStorage: sameServer ? existing.secretStorage : 'none',
        createdAt: existing ? existing.createdAt : at,
        updatedAt: at,
        lastStatus: 'never',
        lastError: null,
        toolCount: 0,
      }));
      persist(records);
      revisions.set(target.id, revisionOf(target.id) + 1);
      if (!sameServer) sessionSecrets.delete(target.id);
      forgetAuth(target.id);
      if (result.required) sessionAuth.set(target.id, result.secrets);
      await evictClient(target.id);
    } catch (error) {
      throw oauthFailure(error);
    } finally {
      if (pendingOAuth === mine) pendingOAuth = null;
    }
    // Signed in: connect once so the entry carries the server info and tool count.
    try {
      await test({ id: target.id });
    } catch { /* the entry's lastError explains what went wrong */ }
    return entryFor(target.id, requireRecord(target.id));
  }

  /** Cancels the browser sign-in in progress, if any. */
  function cancelOAuth() {
    if (!pendingOAuth) return { cancelled: false };
    pendingOAuth.controller.abort();
    pendingOAuth = null;
    return { cancelled: true };
  }

  // Always a fresh connection: any cached client is closed first. A healthy
  // client of an enabled server stays cached for later calls.
  async function test(input) {
    const id = idFrom(input);
    const record = requireRecord(id);
    const revision = revisionOf(id);
    void evictClient(id);
    let entry = null;
    try {
      entry = connectEntry(id, record);
      await entry.ready;
      const tools = await entry.client.listTools();
      recordStatus(id, revision, { lastStatus: 'ok', lastError: null, toolCount: tools.length });
      const result = {
        ok: true,
        serverInfo: { ...entry.client.serverInfo },
        protocolVersion: entry.client.protocolVersion,
        tools: tools.map(summarizeTool),
      };
      if (!record.enabled && clients.get(id) === entry) void evictClient(id);
      return result;
    } catch (error) {
      const failure = toMcpError(error);
      recordStatus(id, revision, { lastStatus: 'error', lastError: failure.message });
      if (entry && clients.get(id) === entry) void evictClient(id);
      else if (entry) void entry.client.close();
      throw failure;
    }
  }

  async function listTools(input) {
    const id = idFrom(input);
    const record = requireRecord(id);
    const entry = await acquire(id, record);
    let tools;
    try {
      tools = await entry.client.listTools();
    } catch (error) {
      const failure = toMcpError(error);
      recordStatus(id, entry.revision, { lastStatus: 'error', lastError: failure.message });
      throw failure;
    }
    recordStatus(id, entry.revision, { lastStatus: 'ok', lastError: null, toolCount: tools.length });
    return tools.map(summarizeTool);
  }

  async function callTool(input) {
    if (!isRecord(input)) throw new McpError('MCP tool call must be an object.');
    const id = normalizeId(input.id);
    const name = normalizeToolName(input.name);
    const args = normalizeArguments(input.arguments);
    const record = requireRecord(id);
    if (!record.enabled) throw new McpError('This MCP server is disabled.');
    const entry = await acquire(id, record);
    return entry.client.callTool(name, args);
  }

  async function loadServerTools(id, record) {
    try {
      const entry = await acquire(id, record);
      const tools = await entry.client.listTools();
      recordStatus(id, entry.revision, { lastStatus: 'ok', lastError: null, toolCount: tools.length });
      return { id, record, tools };
    } catch (error) {
      return { id, record, error: toMcpError(error) };
    }
  }

  // Chat-completions function definitions for every enabled server. Servers are
  // connected in parallel and a failing server only adds an `errors` entry.
  async function chatTools(options = {}) {
    if (!isRecord(options)) throw new McpError('MCP chat tool options must be an object.');
    const readOnlyOnly = options.readOnlyOnly === true;
    const servers = sortedRecords().filter(([, record]) => record.enabled);
    const loaded = await Promise.all(servers.map(([id, record]) => loadServerTools(id, record)));
    const tools = [];
    const routes = new Map();
    const used = new Set();
    const errors = [];
    let bytes = 0;
    for (const server of loaded) {
      if (server.error) {
        errors.push({ serverId: server.id, message: server.error.message });
        continue;
      }
      let omitted = false;
      for (const tool of server.tools) {
        if (readOnlyOnly && !tool.readOnly) continue;
        if (tools.length >= MAX_CHAT_TOOLS) {
          omitted = true;
          break;
        }
        const name = functionName(server.id, tool.name, used);
        const schema = tool.inputSchema;
        const definition = {
          type: 'function',
          function: {
            name,
            description: truncateChars(`[${server.record.name}] ${tool.description || tool.title}`, MAX_CHAT_DESCRIPTION_CHARS),
            parameters: isRecord(schema) && schema.type === 'object' ? schema : { type: 'object', properties: {} },
          },
        };
        const size = Buffer.byteLength(JSON.stringify(definition));
        if (bytes + size > MAX_CHAT_TOOLS_BYTES) {
          omitted = true;
          continue;
        }
        bytes += size;
        used.add(name);
        tools.push(definition);
        routes.set(name, { serverId: server.id, toolName: tool.name, readOnly: tool.readOnly });
      }
      if (omitted) {
        errors.push({ serverId: server.id, message: 'Some tools were omitted because the chat tool limit was reached.' });
      }
    }
    return {
      tools,
      resolve(name) {
        const route = typeof name === 'string' ? routes.get(name) : undefined;
        return route ? { ...route } : null;
      },
      errors,
    };
  }

  async function closeAll() {
    const entries = [...clients.values()];
    clients.clear();
    await Promise.all(entries.map((entry) => entry.client.close()));
  }

  async function closeAllAndCancel() {
    cancelOAuth();
    await closeAll();
  }

  return {
    list, save, remove, test, listTools, callTool, chatTools, startOAuth, cancelOAuth, closeAll: closeAllAndCancel,
  };
}

module.exports = { createMcpManager, McpError };
