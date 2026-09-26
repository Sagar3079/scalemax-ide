'use strict';

const { randomUUID } = require('node:crypto');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_MODELS = 500;
const MAX_MODEL_ID_BYTES = 256;
// Limits for complete(), the main-process tool-calling request.
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_TOOLS = 128;
const MAX_TOOL_CALLS = 16;
const MAX_TOOL_DESCRIPTION_CHARS = 1024;
const MAX_TOOL_CALL_ID_CHARS = 256;
const MAX_TOOL_CALL_NAME_BYTES = 256;
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

// Preconfigured providers. Candidates are tried in order; the first endpoint
// that authenticates the supplied key wins.
const PRESET_PROVIDERS = {
  scalemax: {
    label: 'ScaleMax',
    candidates: ['https://api.scalemax.pro/v1', 'https://api.scalemax.pro/token/v1'],
    defaultBaseUrl: 'https://api.scalemax.pro/token/v1',
  },
};

class ProviderError extends Error {
  constructor(message, code = 'PROVIDER_ERROR') {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048
    || /[\s\\?#]/.test(value)) {
    throw new ProviderError('Use an HTTPS base URL without credentials, query, or fragment.');
  }
  let url;
  try { url = new URL(value); } catch {
    throw new ProviderError('Provider base URL is invalid.');
  }
  const authority = /^(https?):\/\/(\[[^\]]+\]|[^/:@]+)(?::[0-9]+)?(?:\/|$)/.exec(value);
  if (!authority || !url.hostname || url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(authority[2])))) {
    throw new ProviderError('Only HTTPS or exact loopback HTTP URLs are allowed; credentials are forbidden in URLs.');
  }
  return url.href.replace(/\/+$/, '');
}

function normalizeModel(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 256
    || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ProviderError('A model name of at most 256 bytes is required.');
  }
  return value.trim();
}

function normalizeKey(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[^\x20-\x7e]/.test(value)) {
    throw new ProviderError('API key must be a string of at most 4096 printable ASCII characters.');
  }
  return value.trim();
}

function normalizeKind(value) {
  return value === 'scalemax' ? 'scalemax' : 'custom';
}

function normalizeEnabledModels(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MODELS) {
    throw new ProviderError(`Enabled models must be an array of at most ${MAX_MODELS} model IDs.`);
  }
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== 'string' || !id.trim() || Buffer.byteLength(id) > MAX_MODEL_ID_BYTES
      || /[\x00-\x1f\x7f]/.test(id)) {
      throw new ProviderError('Enabled models must be valid model IDs.');
    }
    seen.add(id);
  }
  return [...seen];
}

function normalizeCatalog(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MODELS) return [];
  const models = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id.trim()
      || Buffer.byteLength(item.id) > MAX_MODEL_ID_BYTES || /[\x00-\x1f\x7f]/.test(item.id)) continue;
    const displayName = typeof item.displayName === 'string' && item.displayName.trim()
      && Buffer.byteLength(item.displayName) <= MAX_MODEL_ID_BYTES ? item.displayName.trim() : item.id;
    models.push({ id: item.id, displayName, available: item.available !== false });
  }
  return models;
}

/** Maps an OpenAI-style /models payload to the bounded catalog the UI renders. */
function catalogFromResponse(data) {
  if (!isRecord(data) || !Array.isArray(data.data)) {
    throw new ProviderError('Provider returned an invalid models response.');
  }
  const models = [];
  for (const item of data.data) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id.trim()
      || Buffer.byteLength(item.id) > MAX_MODEL_ID_BYTES || /[\x00-\x1f\x7f]/.test(item.id)) continue;
    const displayName = typeof item.display_name === 'string' && item.display_name.trim()
      && Buffer.byteLength(item.display_name) <= MAX_MODEL_ID_BYTES ? item.display_name.trim() : item.id;
    models.push({ id: item.id, displayName, available: item.availability !== 'unavailable' });
    if (models.length >= MAX_MODELS) break;
  }
  if (!models.length) throw new ProviderError('Provider returned no usable models.');
  return models;
}

function normalizePresetBase(value) {
  const preset = PRESET_PROVIDERS.scalemax;
  if (value === undefined) return preset.defaultBaseUrl;
  const base = normalizeBaseUrl(value);
  if (!preset.candidates.includes(base)) {
    throw new ProviderError('The ScaleMax endpoint must be one of its official API URLs.');
  }
  return base;
}

function metadata(configuration) {
  return {
    kind: configuration.kind,
    baseUrl: configuration.baseUrl,
    model: configuration.model,
    hasKey: Boolean(configuration.key),
    // A session key that did not survive a restart still reports 'session'
    // so the reason the key is gone can surface to the renderer.
    keyStorage: configuration.key || configuration.keyStorage === 'session'
      ? configuration.keyStorage
      : 'none',
    enabledModels: configuration.enabledModels,
    models: configuration.models,
    configured: Boolean(configuration.model && (configuration.key || configuration.baseUrl.startsWith('http:'))),
  };
}

function boundedText(value) {
  return typeof value === 'string' && Buffer.byteLength(value) <= MAX_MESSAGE_BYTES;
}

function validToolCallId(value) {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= MAX_TOOL_CALL_ID_CHARS
    && !/[\x00-\x1f\x7f]/.test(value);
}

// Names echoed back in tool_calls are only bounded, not pattern-checked, so a
// model that invents a malformed name gets an "unknown tool" result instead
// of failing the whole conversation.
function validToolCallName(value) {
  return typeof value === 'string' && Boolean(value) && Buffer.byteLength(value) <= MAX_TOOL_CALL_NAME_BYTES
    && !/[\x00-\x1f\x7f]/.test(value);
}

function normalizeToolCallMessages(value) {
  const invalid = () => new ProviderError(
    `Assistant tool_calls must be an array of at most ${MAX_TOOL_CALLS} function calls with ids, names and string arguments.`,
  );
  if (!Array.isArray(value) || value.length > MAX_TOOL_CALLS) throw invalid();
  const calls = [];
  for (let index = 0; index < value.length; index += 1) {
    const call = value[index];
    const fn = isRecord(call) ? call.function : undefined;
    if (!isRecord(call) || call.type !== 'function' || !validToolCallId(call.id) || !isRecord(fn)
      || !validToolCallName(fn.name) || !boundedText(fn.arguments)) throw invalid();
    calls.push({ id: call.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } });
  }
  return calls;
}

function normalizeCompletionMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 500) {
    throw new ProviderError('Messages must be a nonempty array of at most 500 entries.');
  }
  const invalid = () => new ProviderError(
    'Messages must use system, user, assistant, or tool roles with text of at most 1 MB each.',
  );
  const chat = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!isRecord(message)) throw invalid();
    const { role } = message;
    if (role === 'system' || role === 'user') {
      if (!boundedText(message.content)) throw invalid();
      chat.push({ role, content: message.content });
    } else if (role === 'assistant') {
      const content = message.content === undefined ? null : message.content;
      if (content !== null && !boundedText(content)) throw invalid();
      const toolCalls = message.tool_calls === undefined ? [] : normalizeToolCallMessages(message.tool_calls);
      if (content === null && !toolCalls.length) throw invalid();
      chat.push(toolCalls.length ? { role, content, tool_calls: toolCalls } : { role, content });
    } else if (role === 'tool') {
      if (!validToolCallId(message.tool_call_id) || !boundedText(message.content)) throw invalid();
      chat.push({ role, tool_call_id: message.tool_call_id, content: message.content });
    } else {
      throw invalid();
    }
  }
  return chat;
}

function normalizeToolDefinitions(tools) {
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS) {
    throw new ProviderError(`Tools must be an array of at most ${MAX_TOOLS} function definitions.`);
  }
  const names = new Set();
  const definitions = [];
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index];
    const fn = isRecord(tool) ? tool.function : undefined;
    if (!isRecord(tool) || tool.type !== 'function' || !isRecord(fn) || typeof fn.name !== 'string'
      || !TOOL_NAME_PATTERN.test(fn.name) || !isRecord(fn.parameters)
      || (fn.description !== undefined && (typeof fn.description !== 'string'
        || fn.description.length > MAX_TOOL_DESCRIPTION_CHARS))) {
      throw new ProviderError('Each tool must be a function with a name matching ^[a-zA-Z0-9_-]{1,64}$, '
        + 'a description of at most 1024 characters, and object parameters.');
    }
    if (names.has(fn.name)) throw new ProviderError('Tool names must be unique.');
    names.add(fn.name);
    const definition = { name: fn.name };
    if (fn.description !== undefined) definition.description = fn.description;
    definition.parameters = fn.parameters;
    definitions.push({ type: 'function', function: definition });
  }
  return definitions;
}

// Validates the tool calls of a completion. Missing or duplicate ids are
// replaced (some compatible servers omit them) and object arguments
// are serialized, so callers always get { id, name, arguments: string }.
function parseToolCalls(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ProviderError('Provider returned invalid tool calls.');
  const calls = [];
  const ids = new Set();
  for (const call of value.slice(0, MAX_TOOL_CALLS)) {
    const fn = isRecord(call) ? call.function : undefined;
    if (!isRecord(fn) || !validToolCallName(fn.name) || (call.type !== undefined && call.type !== 'function')) {
      throw new ProviderError('Provider returned an invalid tool call.');
    }
    let args = fn.arguments;
    if (args === undefined || args === null) args = '{}';
    else if (isRecord(args)) args = JSON.stringify(args);
    if (!boundedText(args)) throw new ProviderError('Provider returned an invalid tool call.');
    const id = validToolCallId(call.id) && !ids.has(call.id) ? call.id : `call_${randomUUID().replace(/-/g, '')}`;
    ids.add(id);
    calls.push({ id, name: fn.name, arguments: args });
  }
  return calls;
}

function completionText(message) {
  if (typeof message.content === 'string') return message.content;
  // Some compatible servers return content as an array of text parts.
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  }
  return '';
}

function completionUsage(data) {
  if (!isRecord(data.usage)) return undefined;
  const usage = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (Number.isSafeInteger(data.usage[key]) && data.usage[key] >= 0) usage[key] = data.usage[key];
  }
  return Object.keys(usage).length ? usage : undefined;
}

function createProvider({ store, safeStorage, fetchImpl = fetch, approve = async () => false }) {
  if (!store || typeof store.readAll !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('An internal state store is required.');
  }
  if (typeof fetchImpl !== 'function' || typeof approve !== 'function') {
    throw new TypeError('Provider fetch and approval handlers must be functions.');
  }
  let configuration;
  let revision = 0;
  let saveQueue = Promise.resolve();
  const inflight = new Map();

  function current() {
    if (configuration) return configuration;
    let record;
    try { record = store.readAll().provider; } catch {
      throw new ProviderError('Provider settings could not be read; repair the state file before continuing.');
    }
    if (record === undefined) {
      configuration = {
        kind: 'scalemax',
        baseUrl: PRESET_PROVIDERS.scalemax.defaultBaseUrl,
        model: '', key: '', keyStorage: 'none', enabledModels: [], models: [],
      };
      return configuration;
    }
    if (!isRecord(record) || Object.keys(record).some((key) =>
      !['kind', 'baseUrl', 'model', 'keyStorage', 'encryptedKey', 'enabledModels', 'models'].includes(key))) {
      throw new ProviderError('Stored provider settings are invalid. Clear them before continuing.');
    }
    const kind = normalizeKind(record.kind);
    const candidate = {
      kind,
      baseUrl: kind === 'scalemax' ? normalizePresetBase(record.baseUrl) : normalizeBaseUrl(record.baseUrl),
      model: normalizeModel(record.model),
      key: '',
      keyStorage: 'none',
      enabledModels: normalizeEnabledModels(record.enabledModels),
      models: normalizeCatalog(record.models),
    };
    if (record.keyStorage !== undefined && !['encrypted', 'session', 'none'].includes(record.keyStorage)) {
      throw new ProviderError('Stored provider credential metadata is invalid.');
    }
    // A session key cannot survive a restart; the storage reason is kept so
    // metadata() can explain why the key is missing.
    if (record.keyStorage === 'session' && record.encryptedKey === undefined) {
      candidate.keyStorage = 'session';
    }
    if (record.encryptedKey !== undefined || record.keyStorage === 'encrypted') {
      try {
        if (typeof record.encryptedKey !== 'string' || !record.encryptedKey
          || record.encryptedKey.length > 32_768 || record.encryptedKey.length % 4 !== 0
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(record.encryptedKey)
          || typeof safeStorage?.decryptString !== 'function'
          || safeStorage.isEncryptionAvailable?.() !== true) throw new Error();
        const encrypted = Buffer.from(record.encryptedKey, 'base64');
        if (encrypted.toString('base64') !== record.encryptedKey) throw new Error();
        candidate.key = normalizeKey(safeStorage.decryptString(encrypted));
        if (!candidate.key) throw new Error();
        candidate.keyStorage = 'encrypted';
      } catch {
        throw new ProviderError('Stored API key could not be decrypted. Clear provider settings and enter the key again.');
      }
    }
    configuration = candidate;
    return configuration;
  }

  function get() {
    return metadata(current());
  }

  function persist(record) {
    try {
      store.update((draft) => {
        if (record === undefined) delete draft.provider;
        else draft.provider = record;
      });
    } catch {
      throw new ProviderError('Provider settings could not be saved; no new configuration was applied.');
    }
  }

  function save(input) {
    // Snapshot input before waiting for consent or another save operation.
    let requested;
    try {
      if (!isRecord(input)) throw new ProviderError('Provider settings must be an object.');
      const kind = normalizeKind(input.kind);
      const enabledModels = normalizeEnabledModels(input.enabledModels);
      let model;
      if (typeof input.model === 'string' && input.model.trim()) model = normalizeModel(input.model);
      else if (kind === 'scalemax' && enabledModels.length) model = enabledModels[0];
      else throw new ProviderError('Choose a model to use for chat.');
      requested = {
        kind,
        baseUrl: kind === 'scalemax' ? normalizePresetBase(input.baseUrl) : normalizeBaseUrl(input.baseUrl),
        model,
        enabledModels,
        models: normalizeCatalog(input.models),
        keyProvided: Object.hasOwn(input, 'apiKey'),
        key: Object.hasOwn(input, 'apiKey') ? normalizeKey(input.apiKey) : '',
      };
    } catch (error) {
      return Promise.reject(error instanceof ProviderError ? error : new ProviderError('Provider settings are invalid.'));
    }
    const startedAt = revision;
    const operation = saveQueue.then(async () => {
      if (startedAt !== revision) throw new ProviderError('Provider save was cancelled.');
      const previous = current();
      const endpointChanged = requested.baseUrl !== previous.baseUrl;
      const key = requested.keyProvided ? requested.key : (endpointChanged ? '' : previous.key);
      if (!key && requested.baseUrl.startsWith('https:')) {
        throw new ProviderError(endpointChanged
          ? 'A new API key must be supplied when changing to an HTTPS endpoint.'
          : 'An API key is required for HTTPS endpoints.');
      }
      if (endpointChanged || key !== previous.key) {
        let allowed;
        try {
          allowed = await approve('Approve provider connection',
            `Allow requests to ${requested.baseUrl}${key ? ' using the supplied API key' : ' without an API key'}? Endpoint changes never inherit an existing key.`);
        } catch {
          throw new ProviderError('Provider approval failed; settings were not changed.');
        }
        if (allowed !== true) throw new ProviderError('Provider change was not approved.');
      }
      if (startedAt !== revision) throw new ProviderError('Provider save was cancelled.');
      const record = {
        kind: requested.kind,
        baseUrl: requested.baseUrl,
        model: requested.model,
        keyStorage: key ? 'session' : 'none',
        enabledModels: requested.enabledModels,
      };
      if (requested.models.length) record.models = requested.models;
      if (key) {
        try {
          if (safeStorage?.isEncryptionAvailable?.() === true) {
            if (typeof safeStorage.encryptString !== 'function') throw new Error();
            const encrypted = safeStorage.encryptString(key);
            if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > 24_576) throw new Error();
            record.encryptedKey = encrypted.toString('base64');
            record.keyStorage = 'encrypted';
          }
        } catch {
          throw new ProviderError('API key encryption failed; settings were not changed.');
        }
      }
      persist(record);
      configuration = {
        kind: record.kind, baseUrl: record.baseUrl, model: record.model, key,
        keyStorage: record.keyStorage, enabledModels: record.enabledModels,
        models: record.models || [],
      };
      if (endpointChanged || key !== previous.key || requested.model !== previous.model) cancelAll();
      return get();
    });
    saveQueue = operation.catch(() => {});
    return operation;
  }

  function cancel(id) {
    const request = inflight.get(id);
    if (!request || request.controller.signal.aborted) return false;
    request.controller.abort(new ProviderError('Provider request was cancelled.', 'CANCELLED'));
    return true;
  }

  function cancelAll() {
    let cancelled = 0;
    for (const id of inflight.keys()) if (cancel(id)) cancelled++;
    return cancelled;
  }

  function clear() {
    revision++;
    cancelAll();
    persist(undefined);
    configuration = {
      kind: 'scalemax',
      baseUrl: PRESET_PROVIDERS.scalemax.defaultBaseUrl,
      model: '', key: '', keyStorage: 'none', enabledModels: [], models: [],
    };
    return get();
  }

  function requireConfigured() {
    const snapshot = current();
    if (!metadata(snapshot).configured) throw new ProviderError('Configure a provider model and API key before making requests.');
    return snapshot;
  }

  async function readResponse(response, signal) {
    const declaredSize = response.headers?.get?.('content-length');
    if (declaredSize && Number(declaredSize) > MAX_RESPONSE_BYTES) {
      if (response.body?.cancel) void response.body.cancel().catch(() => {});
      throw new ProviderError('Provider response exceeds the 4 MB limit.');
    }
    if (!response.body || typeof response.body.getReader !== 'function') {
      throw new ProviderError('Provider returned an empty or unreadable response.');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    const stop = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', stop, { once: true });
    try {
      if (signal.aborted) throw signal.reason;
      while (true) {
        const { done, value } = await reader.read();
        if (signal.aborted) throw signal.reason;
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          stop();
          throw new ProviderError('Provider response exceeds the 4 MB limit.');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      signal.removeEventListener('abort', stop);
      reader.releaseLock();
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
      return JSON.parse(text);
    } catch {
      throw new ProviderError('Provider returned invalid JSON.');
    }
  }

  async function request(snapshot, route, { id, method, body }) {
    if (inflight.has(id)) throw new ProviderError('A request with this requestId is already in flight.');
    if (inflight.size >= 4) throw new ProviderError('At most four provider requests may be in flight.');
    const controller = new AbortController();
    const entry = { controller };
    inflight.set(id, entry);
    let onAbort;
    const aborted = new Promise((resolve, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const timer = setTimeout(() => {
      controller.abort(new ProviderError('Provider request timed out after 120 seconds.', 'TIMEOUT'));
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    const execute = async () => {
      const headers = { Accept: 'application/json' };
      if (snapshot.key) headers.Authorization = `Bearer ${snapshot.key}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetchImpl(`${snapshot.baseUrl}/${route}`, {
        method, headers, ...(body === undefined ? {} : { body }),
        signal: controller.signal, redirect: 'error', credentials: 'omit',
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!response || typeof response.status !== 'number') throw new ProviderError('Provider returned an invalid response.');
      if (response.redirected || response.status < 200 || response.status >= 300) {
        if (response.body?.cancel) void response.body.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403) {
          throw new ProviderError('Provider unauthorized. Check your API key and access permissions.', 'UNAUTHORIZED');
        }
        if (response.status === 429) {
          throw new ProviderError('Provider rate limited the request. Try again later.', 'RATE_LIMITED');
        }
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          throw new ProviderError('Provider redirects are not allowed.');
        }
        throw new ProviderError('Provider request failed with an unsuccessful HTTP status.');
      }
      return readResponse(response, controller.signal);
    };
    try {
      // Racing abort also handles injected fetch implementations that ignore their signal.
      return await Promise.race([execute(), aborted]);
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('Provider request failed. Check the connection and provider settings.');
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      if (inflight.get(id) === entry) inflight.delete(id);
    }
  }

  async function test() {
    const data = await request(requireConfigured(), 'models', { id: Symbol('provider-test'), method: 'GET' });
    if (!isRecord(data) || !Array.isArray(data.data) || data.data.some((item) =>
      !isRecord(item) || typeof item.id !== 'string' || !item.id.trim()
      || Buffer.byteLength(item.id) > 1024 || /[\x00-\x1f\x7f]/.test(item.id))) {
      throw new ProviderError('Provider returned an invalid models response.');
    }
    return { ok: true, message: 'Provider connection succeeded.', models: data.data.map((item) => item.id) };
  }

  // Verifies a key and loads the model catalog without persisting anything.
  // For the ScaleMax preset the official endpoints are tried in order and the
  // first that authenticates the key becomes the base URL for that key.
  async function discover(input) {
    if (!isRecord(input)) throw new ProviderError('Provider settings must be an object.');
    const kind = normalizeKind(input.kind);
    const key = Object.hasOwn(input, 'apiKey') ? normalizeKey(input.apiKey) : '';
    if (kind === 'scalemax') {
      let lastError;
      for (const baseUrl of PRESET_PROVIDERS.scalemax.candidates) {
        try {
          const data = await request({ baseUrl, key }, 'models', { id: Symbol('discover'), method: 'GET' });
          return { kind, baseUrl, models: catalogFromResponse(data) };
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError instanceof ProviderError && lastError.code === 'UNAUTHORIZED') {
        throw new ProviderError('ScaleMax rejected this API key. Check the key and try again.', 'UNAUTHORIZED');
      }
      throw new ProviderError('Could not reach ScaleMax to verify the API key.', lastError?.code || 'PROVIDER_ERROR');
    }
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    if (!key && baseUrl.startsWith('https:')) {
      throw new ProviderError('An API key is required for HTTPS endpoints.');
    }
    const data = await request({ baseUrl, key }, 'models', { id: Symbol('discover'), method: 'GET' });
    return { kind, baseUrl, models: catalogFromResponse(data) };
  }

  async function send(input) {
    if (!isRecord(input)) throw new ProviderError('Chat request must be an object.');
    const { requestId, messages, systemPrompt = '', temperature } = input;
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128
      || /[\x00-\x1f\x7f]/.test(requestId)) throw new ProviderError('A bounded, nonempty requestId is required.');
    if (!Array.isArray(messages) || !messages.length || messages.length > 500) {
      throw new ProviderError('Messages must be a nonempty array of at most 500 entries.');
    }
    if (typeof systemPrompt !== 'string' || Buffer.byteLength(systemPrompt) > 1024 * 1024) {
      throw new ProviderError('System prompt must be text of at most 1 MB.');
    }
    const chat = systemPrompt.trim() ? [{ role: 'system', content: systemPrompt }] : [];
    for (const message of messages) {
      if (!isRecord(message) || !['user', 'assistant'].includes(message.role)
        || typeof message.content !== 'string' || Buffer.byteLength(message.content) > 1024 * 1024) {
        throw new ProviderError('Messages must contain user or assistant roles with text of at most 1 MB each.');
      }
      chat.push({ role: message.role, content: message.content });
    }
    if (temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature)
      || temperature < 0 || temperature > 2)) {
      throw new ProviderError('Temperature must be a finite number between 0 and 2.');
    }
    const snapshot = requireConfigured();
    const body = JSON.stringify({ model: snapshot.model, messages: chat, stream: false,
      ...(temperature === undefined ? {} : { temperature }) });
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new ProviderError('Chat request exceeds the 4 MB limit.');
    const data = await request(snapshot, 'chat/completions', { id: requestId, method: 'POST', body });
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new ProviderError('Provider response did not contain assistant text.');
    const result = { text, model: typeof data.model === 'string' && data.model.trim()
      && Buffer.byteLength(data.model) <= 256 && !/[\x00-\x1f\x7f]/.test(data.model) ? data.model : snapshot.model };
    if (isRecord(data.usage)) {
      const usage = {};
      for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
        if (Number.isSafeInteger(data.usage[key]) && data.usage[key] >= 0) usage[key] = data.usage[key];
      }
      if (Object.keys(usage).length) result.usage = usage;
    }
    return result;
  }

  // Main-process only (used by the tool loop): one non-streaming chat
  // completion with optional function tools. Shares request()'s in-flight
  // tracking, cancellation, timeout and size limits with send().
  async function complete(input) {
    if (!isRecord(input)) throw new ProviderError('Completion request must be an object.');
    const { requestId, messages, tools = [], temperature } = input;
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128
      || /[\x00-\x1f\x7f]/.test(requestId)) throw new ProviderError('A bounded, nonempty requestId is required.');
    const chat = normalizeCompletionMessages(messages);
    const definitions = normalizeToolDefinitions(tools);
    if (temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature)
      || temperature < 0 || temperature > 2)) {
      throw new ProviderError('Temperature must be a finite number between 0 and 2.');
    }
    const snapshot = requireConfigured();
    const body = JSON.stringify({
      model: snapshot.model,
      messages: chat,
      stream: false,
      ...(temperature === undefined ? {} : { temperature }),
      ...(definitions.length ? { tools: definitions, tool_choice: 'auto' } : {}),
    });
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new ProviderError('Chat request exceeds the 4 MB limit.');
    const data = await request(snapshot, 'chat/completions', { id: requestId, method: 'POST', body });
    const choice = isRecord(data) && Array.isArray(data.choices) ? data.choices[0] : undefined;
    const message = isRecord(choice) ? choice.message : undefined;
    if (!isRecord(message)) throw new ProviderError('Provider response did not contain assistant text or tool calls.');
    const text = completionText(message);
    const toolCalls = parseToolCalls(message.tool_calls);
    const hasText = Boolean(text.trim());
    if (!hasText && !toolCalls.length) {
      throw new ProviderError('Provider response did not contain assistant text or tool calls.');
    }
    const result = {
      content: hasText ? text : null,
      toolCalls,
      model: typeof data.model === 'string' && data.model.trim() && Buffer.byteLength(data.model) <= 256
        && !/[\x00-\x1f\x7f]/.test(data.model) ? data.model : snapshot.model,
    };
    const usage = completionUsage(data);
    if (usage) result.usage = usage;
    result.finishReason = typeof choice.finish_reason === 'string' && choice.finish_reason.length <= 64
      && !/[\x00-\x1f\x7f]/.test(choice.finish_reason) ? choice.finish_reason : null;
    return result;
  }

  return { get, save, test, discover, send, complete, cancel, clear, cancelAll };
}

module.exports = { createProvider };
