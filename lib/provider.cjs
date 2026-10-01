'use strict';

const { randomUUID } = require('node:crypto');
const { normalizePricing } = require('./metrics.cjs');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
// A streamed reply carries JSON around every piece of text, so the stream may be larger than
// the text it delivers; the text itself keeps the 4 MB limit.
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const MAX_STREAM_LINE_BYTES = 8 * 1024 * 1024;
// Chat replies of several tasks, their helpers and media requests can run at the same time.
const MAX_INFLIGHT = 8;
const MAX_ERROR_DETAIL_BYTES = 16 * 1024;
// A streamed reply fails after this long without a byte, and after 30 minutes in any case.
const STREAM_IDLE_MS = 120_000;
const STREAM_MAX_MS = 30 * 60_000;
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
const REASONING_EFFORTS = ['low', 'medium', 'high'];
const MODEL_OUTPUTS = ['image', 'video'];
const MEDIA_OPTION = /^[A-Za-z0-9:x._-]{1,32}$/;
const MAX_PROFILES = 12;
const MAX_PROFILE_NAME_CHARS = 60;
const PROFILE_ID = /^[a-z0-9-]{1,40}$/;

function cleanProfileName(value) {
  if (typeof value !== 'string') return '';
  const name = value.replace(/[\x00-\x1f\x7f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return name.length <= MAX_PROFILE_NAME_CHARS ? name : name.slice(0, MAX_PROFILE_NAME_CHARS).trim();
}
const MAX_REASONING_BYTES = 64 * 1024;

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

function optionalBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

// Short option values from the catalog: sizes (1024x1024, 16:9, auto), qualities, resolutions.
function optionList(value, max = 24) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string' && MEDIA_OPTION.test(item)))].slice(0, max);
}

function priceNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1000 ? value : null;
}

/**
 * Generation options and prices of an image or video model (null for chat models). Everything is
 * copied from the provider's /models capabilities; nothing is assumed.
 */
function normalizeMedia(value, output) {
  if (!output || !isRecord(value)) return null;
  const pricing = isRecord(value.pricing) ? value.pricing : {};
  if (output === 'image') {
    const max = Number.isSafeInteger(value.maxImages) && value.maxImages >= 1 && value.maxImages <= 10 ? value.maxImages : 1;
    return {
      kind: 'image',
      sizes: optionList(value.sizes),
      qualities: optionList(value.qualities),
      maxImages: max,
      edit: value.edit === true,
      pricing: { min: priceNumber(pricing.min), max: priceNumber(pricing.max) },
    };
  }
  const perSecond = {};
  if (isRecord(pricing.perSecond)) {
    for (const [resolution, price] of Object.entries(pricing.perSecond)) {
      if (MEDIA_OPTION.test(resolution) && priceNumber(price) !== null) perSecond[resolution] = price;
    }
  }
  const range = (item, fallback) => (Number.isSafeInteger(item) && item >= 1 && item <= 60 ? item : fallback);
  const durationMin = range(value.durationMin, 1);
  const durationMax = Math.max(durationMin, range(value.durationMax, 15));
  return {
    kind: 'video',
    aspectRatios: optionList(value.aspectRatios),
    resolutions: optionList(value.resolutions),
    textToVideo: value.textToVideo !== false,
    imageToVideo: value.imageToVideo === true,
    requiresImage: value.requiresImage === true,
    edit: value.edit === true,
    extend: value.extend === true,
    durationMin,
    durationMax,
    defaultDuration: Math.min(durationMax, Math.max(durationMin, range(value.defaultDuration, 6))),
    pricing: { perSecond, discountPercent: priceNumber(pricing.discountPercent) },
  };
}

// ScaleMax's image-edit route accepts only its own image models and Grok Imagine (checked
// against the live API on 2026-09-27: the other families answer "does not support image editing").
const SCALEMAX_IMAGE_EDIT = /^(gpt-image-|grok-imagine-image)/;

// The /models response for a media model → the `media` field above.
function mediaFromResponse(item, capabilities, output) {
  if (!output) return null;
  const pricing = isRecord(item.pricing) ? item.pricing : {};
  if (output === 'image') {
    return {
      sizes: capabilities.sizes,
      qualities: capabilities.quality,
      maxImages: capabilities.max_images_per_request,
      edit: capabilities.supports_edit === true || capabilities.edit === true || SCALEMAX_IMAGE_EDIT.test(item.id),
      pricing: { min: pricing.credit_usd_per_image_min, max: pricing.credit_usd_per_image_max },
    };
  }
  return {
    aspectRatios: capabilities.aspect_ratios,
    resolutions: capabilities.resolutions,
    textToVideo: capabilities.supports_t2v !== false,
    imageToVideo: capabilities.supports_i2v === true,
    requiresImage: capabilities.requires_image === true,
    edit: capabilities.supports_edit === true,
    extend: capabilities.supports_extend === true,
    durationMin: capabilities.min_duration,
    durationMax: capabilities.max_duration,
    defaultDuration: capabilities.default_duration ?? pricing.reference_duration_seconds,
    pricing: { perSecond: pricing.credit_usd_per_second, discountPercent: pricing.discount_percent },
  };
}

function normalizeEffortLevels(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((level) => REASONING_EFFORTS.includes(level)))];
}

// /models reports these as integers. Context needs a useful lower bound; an output cap may be
// as small as one token and must not be silently replaced by the 4k fallback.
function contextWindowLimit(value) {
  return Number.isSafeInteger(value) && value >= 256 && value <= 10_000_000 ? value : null;
}
function outputTokenLimit(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 10_000_000 ? value : null;
}

// Capability fields kept per model (null = the provider did not say). `chat` false marks
// image/video models, `reasoning` true means thinking and effort controls apply.
function capabilityFields(source) {
  const levels = normalizeEffortLevels(source.effortLevels);
  const contextWindow = contextWindowLimit(source.contextWindow);
  const maxOutputTokens = outputTokenLimit(source.maxOutputTokens);
  const pricing = normalizePricing(source.pricing);
  const fields = {
    chat: optionalBoolean(source.chat),
    tools: optionalBoolean(source.tools),
    reasoning: optionalBoolean(source.reasoning),
    effortLevels: levels,
    defaultEffort: REASONING_EFFORTS.includes(source.defaultEffort) ? source.defaultEffort : null,
    effortLocked: source.effortLocked === true,
    // What a non-chat model produces ('image' | 'video'), for the model menu's labels.
    output: MODEL_OUTPUTS.includes(source.output) ? source.output : null,
    media: normalizeMedia(source.media, MODEL_OUTPUTS.includes(source.output) ? source.output : null),
  };
  // Do not add empty metadata fields to older/custom catalogs; absence means unknown.
  if (contextWindow !== null) fields.contextWindow = contextWindow;
  if (maxOutputTokens !== null) fields.maxOutputTokens = maxOutputTokens;
  // The model wants its own thinking back with the tool calls of the same reply.
  if (source.reasoningReplay === true) fields.reasoningReplay = true;
  // Whether it reads pictures in messages; absent: the catalog does not say (the provider decides).
  if (typeof source.vision === 'boolean') fields.vision = source.vision;
  if (pricing.currency || pricing.inputPerMillion !== null || pricing.outputPerMillion !== null) fields.pricing = pricing;
  if (fields.defaultEffort && levels.length && !levels.includes(fields.defaultEffort)) fields.defaultEffort = null;
  return fields;
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
    models.push({ id: item.id, displayName, available: item.available !== false, ...capabilityFields(item) });
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
    const capabilities = isRecord(item.capabilities) ? item.capabilities : {};
    const family = typeof item.family === 'string' ? item.family : (typeof item.model_family === 'string' ? item.model_family : '');
    const generates = capabilities.image_generation === true || capabilities.video_generation === true
      || family === 'image' || family === 'video';
    const output = capabilities.video_generation === true || family === 'video' ? 'video'
      : (capabilities.image_generation === true || family === 'image' ? 'image' : null);
    models.push({
      id: item.id,
      displayName,
      available: item.availability !== 'unavailable',
      ...capabilityFields({
        chat: capabilities.chat === true ? true : (generates || capabilities.chat === false ? false : null),
        tools: capabilities.tools,
        reasoning: capabilities.reasoning === true ? true : (Object.keys(capabilities).length ? false : null),
        effortLevels: capabilities.effort_levels,
        defaultEffort: capabilities.default_effort,
        effortLocked: capabilities.effort_locked,
        reasoningReplay: capabilities.reasoning_replay,
        vision: capabilities.vision ?? capabilities.image_input ?? (Array.isArray(item.input_modalities) ? item.input_modalities.includes('image') : undefined),
        contextWindow: item.context_window,
        maxOutputTokens: item.max_output_tokens,
        pricing: item.pricing,
        output,
        media: mediaFromResponse(item, capabilities, output),
      }),
    });
    if (models.length >= MAX_MODELS) break;
  }
  if (!models.length) throw new ProviderError('Provider returned no usable models.');
  return models;
}

/**
 * Validates the optional per-request reasoning preference: { thinking: boolean, effort }.
 * @returns {{thinking: boolean, effort: string}|undefined}
 */
function normalizeReasoning(value) {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || typeof value.thinking !== 'boolean'
    || (value.effort !== undefined && !REASONING_EFFORTS.includes(value.effort))) {
    throw new ProviderError('Reasoning must be { thinking: boolean, effort: "low" | "medium" | "high" }.');
  }
  return { thinking: value.thinking, effort: value.effort || 'medium' };
}

// Request fields for the chosen model. Only models the provider marks as reasoning-capable get
// them, so providers without these parameters never see unknown fields. A model with a fixed
// set of effort levels gets the closest allowed one.
function reasoningFields(model, reasoning) {
  if (!reasoning || model?.reasoning !== true) return {};
  if (!reasoning.thinking) return { thinking: { type: 'disabled' } };
  let effort = reasoning.effort;
  const levels = model.effortLevels || [];
  if (model.effortLocked && model.defaultEffort) effort = model.defaultEffort;
  else if (levels.length && !levels.includes(effort)) {
    const wanted = REASONING_EFFORTS.indexOf(effort);
    effort = [...levels].sort((a, b) => Math.abs(REASONING_EFFORTS.indexOf(a) - wanted)
      - Math.abs(REASONING_EFFORTS.indexOf(b) - wanted))[0];
  }
  return { thinking: { type: 'enabled' }, reasoning_effort: effort };
}

// Thinking text some models return next to the answer (DeepSeek reasoning_content and similar).
function reasoningText(message) {
  const value = [message?.reasoning_content, message?.reasoning, message?.thinking]
    .find((item) => typeof item === 'string' && item.trim());
  if (!value) return '';
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= MAX_REASONING_BYTES) return value;
  let end = MAX_REASONING_BYTES;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return `${buffer.subarray(0, end).toString('utf8')}\n[truncated]`;
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

// A user message with pictures: OpenAI-style content parts, text and data-URL images only (the
// provider never fetches an address for us).
const MAX_IMAGE_PARTS = 16;
// One picture as a data URL; the whole request stays under MAX_REQUEST_BYTES (main keeps the
// pictures of a request to about 2.5 MB together, main.js withImages).
const MAX_IMAGE_URL_BYTES = 3 * 1024 * 1024;
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
function normalizeContentParts(parts) {
  if (!Array.isArray(parts) || !parts.length || parts.length > MAX_IMAGE_PARTS + 8) return null;
  const result = [];
  let images = 0;
  for (const part of parts) {
    if (isRecord(part) && part.type === 'text' && boundedText(part.text)) {
      result.push({ type: 'text', text: part.text });
    } else if (isRecord(part) && part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string'
      && Buffer.byteLength(part.image_url.url) <= MAX_IMAGE_URL_BYTES && IMAGE_DATA_URL.test(part.image_url.url)) {
      images += 1;
      if (images > MAX_IMAGE_PARTS) return null;
      result.push({ type: 'image_url', image_url: { url: part.image_url.url } });
    } else {
      return null;
    }
  }
  return result;
}
// A tool loop re-sends its whole conversation every round, so a long reply has many more
// messages than the history it started from (500): the request size is the real bound.
const MAX_COMPLETION_MESSAGES = 4000;

function normalizeCompletionMessages(messages, { reasoningReplay = false } = {}) {
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_COMPLETION_MESSAGES) {
    throw new ProviderError(`Messages must be a nonempty array of at most ${MAX_COMPLETION_MESSAGES} entries.`);
  }
  const invalid = () => new ProviderError(
    'Messages must use system, user, assistant, or tool roles with text of at most 1 MB each.',
  );
  const chat = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!isRecord(message)) throw invalid();
    const { role } = message;
    if (role === 'user' && Array.isArray(message.content)) {
      const parts = normalizeContentParts(message.content);
      if (!parts) throw new ProviderError('A message with pictures may hold text and PNG, JPEG, WebP or GIF images only.');
      chat.push({ role, content: parts });
    } else if (role === 'system' || role === 'user') {
      if (!boundedText(message.content)) throw invalid();
      chat.push({ role, content: message.content });
    } else if (role === 'assistant') {
      const content = message.content === undefined ? null : message.content;
      if (content !== null && !boundedText(content)) throw invalid();
      const toolCalls = message.tool_calls === undefined ? [] : normalizeToolCallMessages(message.tool_calls);
      if (content === null && !toolCalls.length) throw invalid();
      const entry = toolCalls.length ? { role, content, tool_calls: toolCalls } : { role, content };
      // The model's own thinking for this round, sent back only to models that ask for it (their
      // catalog says reasoning_replay); others would reject or ignore the field.
      if (reasoningReplay && toolCalls.length && typeof message.reasoning_content === 'string' && message.reasoning_content
        && Buffer.byteLength(message.reasoning_content) <= MAX_REASONING_BYTES) entry.reasoning_content = message.reasoning_content;
      chat.push(entry);
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
  // Prompt tokens the provider served from its cache (OpenAI: prompt_tokens_details.cached_tokens;
  // Anthropic-style gateways: cache_read_input_tokens). Part of prompt_tokens, often cheaper.
  const cached = [data.usage.prompt_tokens_details?.cached_tokens, data.usage.cache_read_input_tokens]
    .find((value) => Number.isSafeInteger(value) && value >= 0);
  if (cached !== undefined && (usage.prompt_tokens === undefined || cached <= usage.prompt_tokens)) usage.cached_tokens = cached;
  return Object.keys(usage).length ? usage : undefined;
}

/** Token counts of two attempts added up (either may be missing). */
function addUsage(first, second) {
  if (!first) return second;
  if (!second) return first;
  const sum = { ...first };
  for (const [key, value] of Object.entries(second)) sum[key] = (sum[key] || 0) + value;
  return sum;
}

const MAX_EMPTY_RETRIES = 1;
/**
 * A completion with neither assistant text nor tool calls that is worth asking for again: not
 * one that used up the output limit thinking or was filtered (the same request would only do
 * that again, billed twice).
 */
function emptyReply(data) {
  const choice = isRecord(data) && Array.isArray(data.choices) && isRecord(data.choices[0]) ? data.choices[0] : undefined;
  const message = choice ? choice.message : undefined;
  if (!isRecord(message)) return true;
  if (completionText(message).trim() || (Array.isArray(message.tool_calls) && message.tool_calls.length)) return false;
  return !['length', 'content_filter'].includes(choice.finish_reason);
}

/**
 * An HTTP 400 for a request that carried pictures, saying the model cannot take them
 * (ScaleMax: image_input_unsupported; others: "image_url is only supported by certain models",
 * "unknown variant `image_url`"). A picture that is too big or broken is a different refusal.
 */
function refusesPictures(error) {
  if (error?.status !== 400) return false;
  const text = `${error.providerCode || ''} ${error.detail || ''}`;
  if (/image_input_unsupported/i.test(text)) return true;
  return /image|vision|multimodal/i.test(text)
    && /support|can.?t|cannot|unable|not accept|not allowed|unknown variant|only/i.test(text)
    && !/too[ _]large|too[ _]big|exceed|size|dimension|format|decode|corrupt|invalid[ _]image/i.test(text);
}

// ---- Retrying a request that failed on the way ---------------------------------------------
// A rate limit, an overloaded or restarting server, a dropped connection or a stream that was cut
// off is usually gone a moment later; one of them should not end a reply 30 rounds into a task.
// Refusals (a bad key, a request the provider rejects, the size limits) are never retried.
const RETRY_DELAYS_MS = [1000, 3000, 8000];
const MAX_RETRY_AFTER_MS = 60_000;
const RETRY_STATUSES = new Set([408, 409, 425, 500, 502, 503, 504, 520, 522, 524, 529]);
function retryable(error) {
  if (!error || error.code === 'CANCELLED' || error.code === 'ENDED' || error.code === 'TOO_LONG') return false;
  if (['RATE_LIMITED', 'NETWORK', 'CUT_OFF', 'TIMEOUT'].includes(error.code)) return true;
  return RETRY_STATUSES.has(error.status);
}

/**
 * Collects the chunks of a streamed chat completion (chat.completion.chunk objects) into the
 * shape of a non-streamed response, so both paths share the same validation. `onDelta` hears the
 * reply as it is written: { type: 'text' | 'reasoning', text } and { type: 'tool', index, name }
 * when a tool call starts. Observer errors never stop the stream.
 */
function createChunkAccumulator(onDelta, { clean = oneLine } = {}) {
  let model = null;
  let content = '';
  let contentBytes = 0;
  let reasoning = '';
  let reasoningBytes = 0;
  let finish = null;
  let usage = null;
  const calls = [];
  const tell = (delta) => {
    if (typeof onDelta !== 'function') return;
    try { onDelta(delta); } catch { /* the reply goes on */ }
  };
  const addText = (text) => {
    if (!text) return;
    contentBytes += Buffer.byteLength(text);
    if (contentBytes > MAX_RESPONSE_BYTES) throw new ProviderError('Provider response exceeds the 4 MB limit.');
    content += text;
    tell({ type: 'text', text });
  };
  // Which call a tool-call piece belongs to. Servers are expected to send `index`; without it
  // a known id continues its call, and a new name after a named call starts the next one.
  const slotFor = (part) => {
    if (Number.isSafeInteger(part.index) && part.index >= 0) return part.index;
    if (typeof part.id === 'string' && part.id) {
      const known = calls.findIndex((call) => call && call.id === part.id);
      return known >= 0 ? known : calls.length;
    }
    const last = calls.length - 1;
    const named = isRecord(part.function) && typeof part.function.name === 'string' && part.function.name;
    if (last < 0 || (named && calls[last]?.function.name)) return calls.length;
    return last;
  };
  function push(chunk) {
    if (!isRecord(chunk)) return;
    if (isRecord(chunk.error)) {
      // Provider text: on one line and without the API key, like every provider error.
      const message = typeof chunk.error.message === 'string' ? clean(chunk.error.message) : '';
      throw new ProviderError(message ? `The provider stopped the reply: ${message}` : 'The provider stopped the reply.');
    }
    if (!model && typeof chunk.model === 'string' && chunk.model.trim() && Buffer.byteLength(chunk.model) <= 256
      && !/[\x00-\x1f\x7f]/.test(chunk.model)) model = chunk.model;
    if (isRecord(chunk.usage)) usage = chunk.usage;
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    if (!isRecord(choice)) return;
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) finish = choice.finish_reason;
    // Servers without real streaming may send the whole message in one chunk.
    const delta = isRecord(choice.delta) ? choice.delta : (isRecord(choice.message) ? choice.message : null);
    if (!delta) return;
    if (typeof delta.content === 'string') addText(delta.content);
    else if (Array.isArray(delta.content)) {
      for (const part of delta.content) if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') addText(part.text);
    }
    const thought = [delta.reasoning_content, delta.reasoning, delta.thinking].find((item) => typeof item === 'string' && item);
    if (thought) {
      reasoningBytes += Buffer.byteLength(thought);
      if (reasoningBytes <= MAX_REASONING_BYTES) reasoning += thought;
      tell({ type: 'reasoning', text: thought });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) {
        if (!isRecord(part)) continue;
        const index = slotFor(part);
        if (index >= MAX_TOOL_CALLS) continue;
        if (!calls[index]) calls[index] = { id: undefined, type: 'function', function: { name: '', arguments: '' } };
        const call = calls[index];
        if (typeof part.id === 'string' && part.id && !call.id) call.id = part.id;
        const fn = isRecord(part.function) ? part.function : {};
        if (typeof fn.name === 'string' && fn.name && !call.function.name) {
          call.function.name = fn.name;
          tell({ type: 'tool', index, name: fn.name });
        }
        if (typeof fn.arguments === 'string' && fn.arguments) {
          if (Buffer.byteLength(call.function.arguments) + Buffer.byteLength(fn.arguments) > MAX_MESSAGE_BYTES) {
            throw new ProviderError('Provider returned an invalid tool call.');
          }
          call.function.arguments += fn.arguments;
        } else if (isRecord(fn.arguments)) {
          call.function.arguments = JSON.stringify(fn.arguments);
        }
      }
    }
  }
  function result() {
    const message = { role: 'assistant', content: content || null };
    if (reasoning) message.reasoning_content = reasoning;
    const toolCalls = calls.filter(Boolean).filter((call) => call.function.name);
    if (toolCalls.length) message.tool_calls = toolCalls;
    return { model, choices: [{ message, finish_reason: finish }], ...(usage ? { usage } : {}) };
  }
  return { push, result, finished: () => finish !== null };
}

/** Provider text for a message: one line, no control or direction characters, at most 300 characters. */
function oneLine(text) {
  let value = String(text ?? '').replace(/[\x00-\x1f\x7f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (value.length > 300) value = `${value.slice(0, 299)}…`;
  return value;
}

/** Tells a listener a reply that came back whole (a server that ignored `stream`). */
function tellWhole(onDelta, data) {
  const choice = isRecord(data) && Array.isArray(data.choices) ? data.choices[0] : null;
  const message = isRecord(choice) ? choice.message : null;
  if (typeof onDelta !== 'function' || !isRecord(message)) return;
  const thought = reasoningText(message);
  const text = completionText(message);
  try {
    if (thought) onDelta({ type: 'reasoning', text: thought });
    if (text) onDelta({ type: 'text', text });
  } catch { /* the reply goes on */ }
}

/**
 * Parses a Server-Sent Events body, line by line, into JSON events for `onEvent` until
 * `data: [DONE]` or the end. `onBytes` hears every read (the idle timer is reset there).
 * Resolves to true when the stream said `[DONE]`. Whenever reading stops before the body ended
 * ([DONE], an error event, a limit), the body is cancelled, so the server stops generating.
 */
async function readEventStream(response, signal, { onEvent, onBytes }) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new ProviderError('Provider returned an empty or unreadable response.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let data = [];
  let total = 0;
  let finished = false;
  let ended = false;
  const stop = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  const dispatch = () => {
    if (!data.length) return;
    const payload = data.join('\n');
    data = [];
    if (payload.trim() === '[DONE]') {
      finished = true;
      return;
    }
    let event;
    try { event = JSON.parse(payload); } catch { throw new ProviderError('Provider sent an unreadable stream event.'); }
    onEvent(event);
  };
  const line = (text) => {
    if (text === '') { dispatch(); return; }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    if (field === 'data') data.push(colon < 0 ? '' : text.slice(colon + 1).replace(/^ /, ''));
  };
  try {
    if (signal.aborted) throw signal.reason;
    while (!finished) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) {
        ended = true;
        break;
      }
      onBytes?.();
      total += value.byteLength;
      if (total > MAX_STREAM_BYTES) throw new ProviderError('Provider stream exceeds the 32 MB limit.');
      buffer += decoder.decode(value, { stream: true });
      let start = 0;
      let newline;
      while (!finished && (newline = buffer.indexOf('\n', start)) >= 0) {
        line(buffer.slice(start, newline).replace(/\r$/, ''));
        start = newline + 1;
      }
      buffer = buffer.slice(start);
      if (buffer.length > MAX_STREAM_LINE_BYTES) throw new ProviderError('Provider sent a stream line over 8 MB.');
    }
    if (!finished) {
      buffer += decoder.decode();
      for (const rest of buffer.split('\n')) line(rest.replace(/\r$/, ''));
      dispatch();
    }
    return finished;
  } finally {
    signal.removeEventListener('abort', stop);
    if (!ended) stop();
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

function createProvider({ store, safeStorage, fetchImpl = fetch, approve = async () => false, retryDelays: defaultRetryDelays = RETRY_DELAYS_MS }) {
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
  const requestSnapshots = new WeakSet();
  // Session-only keys of inactive provider profiles (encryption unavailable), for this run only.
  const sessionKeys = new Map();

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
      // Switching between provider profiles keeps a session-only key for this run.
      const remembered = sessionKeys.get(activeProfileId());
      if (remembered) candidate.key = remembered;
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
    const profile = activeProfile();
    return { ...metadata(current()), profileId: profile.id, profileName: profile.name };
  }

  // ---- Provider profiles ------------------------------------------------------------
  // `provider` always holds the active configuration (every other part of the app reads it).
  // `providerProfiles` lists every saved provider: { activeId, profiles: [{ id, name, record }] };
  // the active profile's record there is a copy, the others are the only copy.

  function defaultProfileName(record) {
    if (!isRecord(record)) return 'ScaleMax';
    if (record.kind === 'scalemax') return 'ScaleMax';
    try { return new URL(record.baseUrl).host.slice(0, MAX_PROFILE_NAME_CHARS); } catch { return 'Custom provider'; }
  }

  function readProfiles() {
    let raw;
    let active;
    try {
      const all = store.readAll();
      raw = all.providerProfiles;
      active = all.provider;
    } catch {
      throw new ProviderError('Provider settings could not be read; repair the state file before continuing.');
    }
    const profiles = [];
    if (isRecord(raw) && Array.isArray(raw.profiles)) {
      for (const item of raw.profiles.slice(0, MAX_PROFILES)) {
        if (!isRecord(item) || typeof item.id !== 'string' || !PROFILE_ID.test(item.id)
          || profiles.some((profile) => profile.id === item.id)) continue;
        const name = cleanProfileName(item.name) || 'Provider';
        profiles.push({ id: item.id, name, record: isRecord(item.record) ? item.record : undefined });
      }
    }
    if (!profiles.length) profiles.push({ id: 'default', name: defaultProfileName(active), record: active });
    const activeId = isRecord(raw) && profiles.some((profile) => profile.id === raw.activeId) ? raw.activeId : profiles[0].id;
    return { activeId, profiles };
  }

  function activeProfileId() {
    try { return readProfiles().activeId; } catch { return 'default'; }
  }

  function activeProfile() {
    try {
      const state = readProfiles();
      return state.profiles.find((profile) => profile.id === state.activeId);
    } catch {
      return { id: 'default', name: 'ScaleMax' };
    }
  }

  // Writes the active record and the profile list together, so they never disagree.
  function writeProfiles(draft, state, activeRecord) {
    draft.providerProfiles = {
      activeId: state.activeId,
      profiles: state.profiles.map((profile) => {
        const record = profile.id === state.activeId ? activeRecord : profile.record;
        // A copy: the state store refuses one object stored twice (here and under `provider`).
        return record === undefined ? { id: profile.id, name: profile.name }
          : { id: profile.id, name: profile.name, record: structuredClone(record) };
      }),
    };
    if (activeRecord === undefined) delete draft.provider;
    else draft.provider = activeRecord;
  }

  function persist(record) {
    try {
      const state = readProfiles();
      store.update((draft) => writeProfiles(draft, state, record));
    } catch {
      throw new ProviderError('Provider settings could not be saved; no new configuration was applied.');
    }
  }

  // What the model menu needs from a profile, without decrypting inactive keys.
  function profileSummary(profile, active) {
    if (active) {
      const meta = metadata(current());
      return { id: profile.id, name: profile.name, active: true, kind: meta.kind, baseUrl: meta.baseUrl,
        model: meta.model, configured: meta.configured, hasKey: meta.hasKey, models: meta.models };
    }
    const record = isRecord(profile.record) ? profile.record : {};
    let baseUrl = '';
    try {
      baseUrl = record.kind === 'scalemax' ? normalizePresetBase(record.baseUrl) : normalizeBaseUrl(record.baseUrl);
    } catch { baseUrl = ''; }
    let model = '';
    try { model = normalizeModel(record.model); } catch { model = ''; }
    const hasKey = typeof record.encryptedKey === 'string' || sessionKeys.has(profile.id);
    return {
      id: profile.id, name: profile.name, active: false, kind: normalizeKind(record.kind), baseUrl, model,
      configured: Boolean(model && baseUrl && (hasKey || baseUrl.startsWith('http:'))), hasKey,
      models: normalizeCatalog(record.models),
    };
  }

  /** Every saved provider with its models; the active one is marked. */
  function profiles() {
    const state = readProfiles();
    return { activeId: state.activeId, profiles: state.profiles.map((profile) => profileSummary(profile, profile.id === state.activeId)) };
  }

  function queued(task) {
    const operation = saveQueue.then(task);
    saveQueue = operation.catch(() => {});
    return operation;
  }

  function switchTo(state, id) {
    const before = current();
    if (before.keyStorage === 'session' && before.key) sessionKeys.set(state.activeId, before.key);
    let activeRecord;
    try { activeRecord = store.readAll().provider; } catch { activeRecord = undefined; }
    const target = state.profiles.find((profile) => profile.id === id);
    const nextState = {
      activeId: id,
      profiles: state.profiles.map((profile) => (profile.id === state.activeId ? { ...profile, record: activeRecord } : profile)),
    };
    try {
      store.update((draft) => writeProfiles(draft, nextState, target.record));
    } catch {
      throw new ProviderError('Provider settings could not be saved; the provider was not switched.');
    }
    revision++;
    cancelAll();
    configuration = undefined;
  }

  /** Adds an empty provider and makes it active, so the Assistant form fills it in. */
  function addProfile(input = {}) {
    return queued(() => {
      const state = readProfiles();
      if (state.profiles.length >= MAX_PROFILES) throw new ProviderError(`At most ${MAX_PROFILES} providers can be saved.`);
      const name = cleanProfileName(isRecord(input) ? input.name : '') || `Provider ${state.profiles.length + 1}`;
      const id = `p-${randomUUID().slice(0, 8)}`;
      switchTo({ ...state, profiles: [...state.profiles, { id, name, record: undefined }] }, id);
      return profiles();
    });
  }

  /** Makes a saved provider active, optionally choosing one of its models. */
  function selectProfile(input) {
    return queued(async () => {
      if (!isRecord(input) || typeof input.id !== 'string') throw new ProviderError('Choose a saved provider.');
      const state = readProfiles();
      if (!state.profiles.some((profile) => profile.id === input.id)) throw new ProviderError('That provider no longer exists.');
      if (input.id !== state.activeId) switchTo(state, input.id);
      return profiles();
    }).then(async (result) => {
      if (isRecord(input) && typeof input.model === 'string' && input.model && input.model !== get().model) {
        await setModel({ model: input.model });
        return profiles();
      }
      return result;
    });
  }

  function renameProfile(input) {
    return queued(() => {
      const name = cleanProfileName(isRecord(input) ? input.name : '');
      if (!name) throw new ProviderError(`A provider name of 1-${MAX_PROFILE_NAME_CHARS} characters is required.`);
      const state = readProfiles();
      if (!state.profiles.some((profile) => profile.id === input.id)) throw new ProviderError('That provider no longer exists.');
      let activeRecord;
      try { activeRecord = store.readAll().provider; } catch { activeRecord = undefined; }
      const next = { ...state, profiles: state.profiles.map((profile) => (profile.id === input.id ? { ...profile, name } : profile)) };
      try { store.update((draft) => writeProfiles(draft, next, activeRecord)); } catch {
        throw new ProviderError('Provider settings could not be saved.');
      }
      return profiles();
    });
  }

  /** Deletes a saved provider and its key. The last provider cannot be deleted (clear it instead). */
  function removeProfile(input) {
    return queued(() => {
      const state = readProfiles();
      const id = isRecord(input) ? input.id : undefined;
      if (!state.profiles.some((profile) => profile.id === id)) throw new ProviderError('That provider no longer exists.');
      if (state.profiles.length === 1) throw new ProviderError('The last provider cannot be removed; clear it instead.');
      const remaining = state.profiles.filter((profile) => profile.id !== id);
      if (id === state.activeId) {
        // Drop the active record first, then load the next provider.
        const next = { activeId: remaining[0].id, profiles: remaining };
        try { store.update((draft) => writeProfiles(draft, next, remaining[0].record)); } catch {
          throw new ProviderError('Provider settings could not be saved.');
        }
        revision++;
        cancelAll();
        configuration = undefined;
      } else {
        let activeRecord;
        try { activeRecord = store.readAll().provider; } catch { activeRecord = undefined; }
        try { store.update((draft) => writeProfiles(draft, { ...state, profiles: remaining }, activeRecord)); } catch {
          throw new ProviderError('Provider settings could not be saved.');
        }
      }
      sessionKeys.delete(id);
      return profiles();
    });
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

  // Requests waiting to be retried, by id: Stop during the wait ends them too.
  const retryWaits = new Map();
  function waitForRetry(id, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        retryWaits.delete(id);
        resolve();
      }, ms);
      timer.unref?.();
      retryWaits.set(id, () => {
        clearTimeout(timer);
        retryWaits.delete(id);
        reject(new ProviderError('Provider request was cancelled.', 'CANCELLED'));
      });
    });
  }

  function cancel(id) {
    const waiting = retryWaits.get(id);
    if (waiting) {
      waiting();
      return true;
    }
    const request = inflight.get(id);
    if (!request || request.controller.signal.aborted) return false;
    request.controller.abort(new ProviderError('Provider request was cancelled.', 'CANCELLED'));
    return true;
  }

  function cancelAll() {
    let cancelled = 0;
    for (const id of [...inflight.keys(), ...retryWaits.keys()]) if (cancel(id)) cancelled++;
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

  // What the provider said about a refused request (its JSON `error.message`, or plain text),
  // read from at most 16 KB of the body, on one line, with the API key removed.
  async function errorDetail(response, signal) {
    if (!response.body || typeof response.body.getReader !== 'function') return { message: '', code: '' };
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    const stop = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', stop, { once: true });
    try {
      while (total < MAX_ERROR_DETAIL_BYTES) {
        const { done, value } = await reader.read();
        if (done || signal.aborted) break;
        chunks.push(Buffer.from(value));
        total += value.byteLength;
      }
    } catch {
      /* whatever arrived is enough */
    } finally {
      signal.removeEventListener('abort', stop);
      stop();
    }
    const raw = Buffer.concat(chunks, total).subarray(0, MAX_ERROR_DETAIL_BYTES).toString('utf8');
    let message = '';
    let code = '';
    try {
      const data = JSON.parse(raw);
      const error = isRecord(data?.error) ? data.error : data;
      if (typeof data?.error === 'string') message = data.error;
      else if (typeof error?.message === 'string') message = error.message;
      else if (typeof data?.detail === 'string') message = data.detail;
      const rawCode = [error?.code, error?.type].find((item) => typeof item === 'string' && item);
      if (rawCode && /^[A-Za-z0-9_.:-]{1,64}$/.test(rawCode)) code = rawCode;
    } catch {
      // Plain text or an HTML error page: only short plain text is worth showing.
      if (!/<[a-z!][\s\S]*>/i.test(raw)) message = raw;
    }
    return { message: oneLine(redact(message)), code };
  }
  // The error for an unsuccessful HTTP status. `status` and `providerCode` let callers react
  // (complete() retries a refused stream once without streaming).
  async function errorFor(response, signal) {
    const status = response.status;
    const redirect = response.redirected || (status >= 300 && status < 400);
    const detail = redirect ? { message: '', code: '' } : await errorDetail(response, signal);
    let error;
    if (status === 401 || status === 403) {
      error = new ProviderError('Provider unauthorized. Check your API key and access permissions.', 'UNAUTHORIZED');
    } else if (status === 429) {
      error = new ProviderError(`Provider rate limited the request. Try again later.${detail.message ? ` (${detail.message})` : ''}`, 'RATE_LIMITED');
      // How long the provider asked to wait (seconds, or an HTTP date), for the retry.
      const after = String(response.headers?.get?.('retry-after') || '').trim();
      const seconds = /^\d{1,6}$/.test(after) ? Number(after) : (after ? (Date.parse(after) - Date.now()) / 1000 : NaN);
      if (Number.isFinite(seconds) && seconds >= 0) error.retryAfterMs = Math.round(seconds * 1000);
    } else if (redirect) {
      error = new ProviderError('Provider redirects are not allowed.');
    } else if (detail.message) {
      error = new ProviderError(`The provider refused the request (HTTP ${status}): ${detail.message}`);
    } else {
      error = new ProviderError(`Provider request failed with an unsuccessful HTTP status (${status}).`);
    }
    error.status = status;
    if (detail.code) error.providerCode = detail.code;
    if (detail.message) error.detail = detail.message;
    return error;
  }
  /**
   * One provider request, tracked under `id` for cancellation. With `stream` ({ onDelta }) the
   * body asks for Server-Sent Events: the reply is read as it is written, `onDelta` hears every
   * piece, and the timeout counts silence (120 s without a byte) instead of the whole reply,
   * which may take many minutes. A server that answers with plain JSON anyway is read as JSON.
   */
  async function request(snapshot, route, { id, method, body, stream = null }) {
    // A request waiting to be tried again keeps its id: nothing else may take it (and Stop).
    if (inflight.has(id) || retryWaits.has(id)) throw new ProviderError('A request with this requestId is already in flight.');
    if (inflight.size >= MAX_INFLIGHT) throw new ProviderError(`At most ${MAX_INFLIGHT} provider requests may be in flight.`);
    const controller = new AbortController();
    const entry = { controller };
    inflight.set(id, entry);
    let onAbort;
    const aborted = new Promise((resolve, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    let timer = null;
    const arm = (ms, message) => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new ProviderError(message, 'TIMEOUT')), ms);
      timer.unref?.();
    };
    arm(REQUEST_TIMEOUT_MS, 'Provider request timed out after 120 seconds.');
    // A streamed reply may take long, but never longer than this.
    const ceiling = stream ? setTimeout(() => controller.abort(new ProviderError(
      'The reply took longer than 30 minutes and was stopped.', 'TOO_LONG')), STREAM_MAX_MS) : null;
    ceiling?.unref?.();
    const execute = async () => {
      const headers = { Accept: stream ? 'text/event-stream, application/json' : 'application/json' };
      if (snapshot.key) headers.Authorization = `Bearer ${snapshot.key}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetchImpl(`${snapshot.baseUrl}/${route}`, {
        method, headers, ...(body === undefined ? {} : { body }),
        signal: controller.signal, redirect: 'error', credentials: 'omit',
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!response || typeof response.status !== 'number') throw new ProviderError('Provider returned an invalid response.');
      if (response.redirected || response.status < 200 || response.status >= 300) {
        throw await errorFor(response, controller.signal);
      }
      if (!stream) return readResponse(response, controller.signal);
      const type = String(response.headers?.get?.('content-type') || '').toLowerCase();
      if (!type.includes('text/event-stream')) {
        // The server ignored `stream`: the whole reply at once, checked like any non-streamed
        // reply and told to the listener in one piece.
        const data = await readResponse(response, controller.signal);
        tellWhole(stream.onDelta, data);
        return data;
      }
      const collector = createChunkAccumulator(stream.onDelta, { clean: (text) => oneLine(redact(text)) });
      const idle = () => arm(STREAM_IDLE_MS, 'The provider stopped sending the reply for 120 seconds.');
      idle();
      const done = await readEventStream(response, controller.signal, { onEvent: collector.push, onBytes: idle });
      // Neither [DONE] nor a finish reason: the connection was cut, the answer is not complete.
      if (!done && !collector.finished()) throw new ProviderError('The reply was cut off before it finished. Try again.', 'CUT_OFF');
      return collector.result();
    };
    try {
      // Racing abort also handles injected fetch implementations that ignore their signal.
      return await Promise.race([execute(), aborted]);
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('Provider request failed. Check the connection and provider settings.', 'NETWORK');
    } finally {
      clearTimeout(timer);
      clearTimeout(ceiling);
      controller.signal.removeEventListener('abort', onAbort);
      // Whatever ended the request, the connection goes with it (a body left unread would keep
      // the server generating).
      if (!controller.signal.aborted) controller.abort(new ProviderError('Provider request ended.', 'ENDED'));
      if (inflight.get(id) === entry) inflight.delete(id);
    }
  }

  /**
   * Main-process only (lib/media.cjs): fetch for image/video routes and downloads. A relative
   * target resolves against the configured base URL (`images/generations` → …/v1/images/…).
   * The API key is attached only for the provider's own origin, redirects are never followed
   * automatically, and only https (or loopback http) is allowed.
   */
  function mediaFetch(target, init = {}) {
    const snapshot = requireConfigured();
    const base = new URL(`${snapshot.baseUrl}/`);
    let url;
    try { url = new URL(target, base); } catch { throw new ProviderError('The media URL is invalid.'); }
    const loopback = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
    if ((url.protocol !== 'https:' && !loopback) || url.username || url.password) {
      throw new ProviderError('Refusing a non-HTTPS media URL.');
    }
    const headers = { ...(isRecord(init.headers) ? init.headers : {}) };
    if (url.origin === base.origin && snapshot.key) headers.Authorization = `Bearer ${snapshot.key}`;
    return fetchImpl(url.href, { ...init, headers, redirect: 'manual', credentials: 'omit' });
  }

  /** Removes the API key from provider-supplied text before it is shown anywhere. */
  function redact(text) {
    const key = current().key;
    const value = String(text ?? '');
    return key && key.length >= 8 ? value.split(key).join('[redacted]') : value;
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

  /**
   * Reloads the model catalog (with capabilities) from the configured endpoint using the stored
   * key, and saves it. Enabled models that disappeared are dropped; the chat model is kept.
   */
  async function refreshModels() {
    const snapshot = requireConfigured();
    const data = await request(snapshot, 'models', { id: Symbol('refresh-models'), method: 'GET' });
    const models = catalogFromResponse(data);
    const operation = saveQueue.then(() => {
      const previous = current();
      if (previous.baseUrl !== snapshot.baseUrl || previous.key !== snapshot.key) {
        throw new ProviderError('Provider settings changed while the models were loading.');
      }
      const known = new Set(models.map((model) => model.id));
      const enabledModels = previous.enabledModels.filter((id) => known.has(id));
      let stored;
      try { stored = store.readAll().provider; } catch { stored = undefined; }
      if (!isRecord(stored)) throw new ProviderError('Provider settings could not be read.');
      persist({ ...stored, enabledModels, models });
      configuration = { ...previous, enabledModels, models };
      return get();
    });
    saveQueue = operation.catch(() => {});
    return operation;
  }

  function modelInfo(snapshot) {
    return snapshot.models.find((model) => model.id === snapshot.model) || null;
  }

  function snapshot() {
    const value = structuredClone(requireConfigured());
    requestSnapshots.add(value);
    return value;
  }
  // A reply carries the catalog snapshot used to price it later; model switches/refreshes do not
  // retroactively rewrite historical costs.
  function modelPricing(snapshot) {
    const pricing = normalizePricing(modelInfo(snapshot)?.pricing);
    return pricing.currency || pricing.inputPerMillion !== null || pricing.outputPerMillion !== null ? pricing : null;
  }

  /**
   * Switches the chat model without touching the endpoint or key (the composer's model menu).
   * For ScaleMax the model must be in the saved catalog, chat-capable and available; enabling it
   * is implied by choosing it.
   */
  function setModel(input) {
    let model;
    try {
      if (!isRecord(input)) throw new Error();
      model = normalizeModel(input.model);
      if (!model) throw new Error();
    } catch {
      return Promise.reject(new ProviderError('Choose a model to use for chat.'));
    }
    const startedAt = revision;
    const operation = saveQueue.then(() => {
      if (startedAt !== revision) throw new ProviderError('Model change was cancelled.');
      const previous = current();
      if (!metadata(previous).configured) throw new ProviderError('Configure a provider before choosing a model.');
      if (previous.model === model) return get();
      if (previous.kind === 'scalemax') {
        const entry = previous.models.find((item) => item.id === model);
        if (!entry) throw new ProviderError('That model is not in the ScaleMax model list. Test the connection again.');
        if (entry.available === false) throw new ProviderError('That model is currently unavailable.');
        if (entry.chat === false) throw new ProviderError('That model does not support chat.');
      }
      const enabledModels = previous.enabledModels.includes(model) || previous.kind !== 'scalemax'
        ? previous.enabledModels : [...previous.enabledModels, model].slice(0, MAX_MODELS);
      let stored;
      try { stored = store.readAll().provider; } catch { stored = undefined; }
      if (!isRecord(stored)) throw new ProviderError('Provider settings could not be read.');
      persist({ ...stored, model, enabledModels });
      configuration = { ...previous, model, enabledModels };
      // In-flight requests keep the model they started with.
      return get();
    });
    saveQueue = operation.catch(() => {});
    return operation;
  }

  async function send(input) {
    if (!isRecord(input)) throw new ProviderError('Chat request must be an object.');
    const { requestId, messages, systemPrompt = '', temperature } = input;
    const reasoning = normalizeReasoning(input.reasoning);
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
      ...(temperature === undefined ? {} : { temperature }),
      ...reasoningFields(modelInfo(snapshot), reasoning) });
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new ProviderError('Chat request exceeds the 4 MB limit.');
    let data;
    for (let attempt = 0, timeouts = 0; ; attempt += 1) {
      try {
        data = await request(snapshot, 'chat/completions', { id: requestId, method: 'POST', body });
        break;
      } catch (error) {
        if (error?.code === 'TIMEOUT') timeouts += 1;
        if (!retryable(error) || attempt >= defaultRetryDelays.length || timeouts > 1) throw error;
        const asked = Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0;
        await waitForRetry(requestId, Math.min(Math.max(defaultRetryDelays[attempt], asked), MAX_RETRY_AFTER_MS));
      }
    }
    const message = data?.choices?.[0]?.message;
    const text = message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new ProviderError('Provider response did not contain assistant text.');
    const responsePricing = modelPricing(snapshot);
    const result = { text, model: typeof data.model === 'string' && data.model.trim()
      && Buffer.byteLength(data.model) <= 256 && !/[\x00-\x1f\x7f]/.test(data.model) ? data.model : snapshot.model,
      ...(responsePricing ? { pricing: responsePricing } : {}) };
    const thought = reasoningText(message);
    if (thought) result.reasoning = thought;
    if (isRecord(data.usage)) {
      const usage = {};
      for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
        if (Number.isSafeInteger(data.usage[key]) && data.usage[key] >= 0) usage[key] = data.usage[key];
      }
      if (Object.keys(usage).length) result.usage = usage;
    }
    return result;
  }

  /**
   * Main-process only (used by the tool loop): one chat completion with optional function tools.
   * Shares request()'s in-flight tracking, cancellation, timeout and size limits with send().
   * With `onDelta` the reply is streamed and `onDelta` hears it as it is written
   * ({ type: 'text' | 'reasoning', text }, { type: 'tool', index, name }); a server that refuses
   * the streaming fields (HTTP 400 about streaming) is asked once more without them.
   */
  async function complete(input, { onDelta, snapshot: requestSnapshot = null, retryDelays = defaultRetryDelays } = {}) {
    if (!isRecord(input)) throw new ProviderError('Completion request must be an object.');
    const { requestId, messages, tools = [], temperature } = input;
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128
      || /[\x00-\x1f\x7f]/.test(requestId)) throw new ProviderError('A bounded, nonempty requestId is required.');
    const reasoning = normalizeReasoning(input.reasoning);
    const snapshot = requestSnapshot && requestSnapshots.has(requestSnapshot)
      ? requestSnapshot : requireConfigured();
    const chat = normalizeCompletionMessages(messages, { reasoningReplay: modelInfo(snapshot)?.reasoningReplay === true });
    const definitions = normalizeToolDefinitions(tools);
    if (temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature)
      || temperature < 0 || temperature > 2)) {
      throw new ProviderError('Temperature must be a finite number between 0 and 2.');
    }
    const streaming = typeof onDelta === 'function';
    // Whether the listener already heard part of this attempt: a retry then tells it to start
    // the round again ({ type: 'retry' }), so the text is not shown twice.
    let heard = false;
    const listener = streaming ? (delta) => {
      if (delta && ['text', 'reasoning', 'tool'].includes(delta.type)) heard = true;
      onDelta(delta);
    } : null;
    const payload = (stream) => JSON.stringify({
      model: snapshot.model,
      messages: chat,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(temperature === undefined ? {} : { temperature }),
      ...reasoningFields(modelInfo(snapshot), reasoning),
      ...(definitions.length ? { tools: definitions, tool_choice: 'auto' } : {}),
    });
    let body = payload(streaming);
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new ProviderError('Chat request exceeds the 4 MB limit.');
    const hasPictures = chat.some((item) => Array.isArray(item.content) && item.content.some((part) => part.type === 'image_url'));
    let data;
    let refusedStreaming = false;
    let timeouts = 0;
    // A reply with neither text nor tool calls (seen live: a model that only thought) is asked
    // for once more; what the empty one used is still counted.
    let emptyRetries = 0;
    let emptyUsage = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        data = await request(snapshot, 'chat/completions', {
          id: requestId, method: 'POST', body, stream: listener ? { onDelta: listener } : null,
        });
        if (emptyRetries >= MAX_EMPTY_RETRIES || !emptyReply(data)) break;
        emptyRetries += 1;
        emptyUsage = addUsage(emptyUsage, completionUsage(data));
        if (heard) {
          heard = false;
          try { onDelta({ type: 'retry', attempt: attempt + 1, reason: 'EMPTY' }); } catch { /* observers never break it */ }
        }
        await waitForRetry(requestId, Math.min(retryDelays[0] ?? 0, MAX_RETRY_AFTER_MS));
      } catch (error) {
        // Refused before anything streamed: some compatible servers reject `stream_options` or
        // streaming itself; that is asked again once, without them.
        const aboutStreaming = !error?.detail || /stream/i.test(error.detail);
        if (streaming && !refusedStreaming && !heard && error?.status === 400 && aboutStreaming) {
          refusedStreaming = true;
          body = payload(false);
          attempt -= 1;
          continue;
        }
        // A model that cannot take the pictures sent: the window then leaves them out for it.
        if (hasPictures && refusesPictures(error)) error.code = 'IMAGES_UNSUPPORTED';
        // A 120 s silence is retried once: a second one means the provider is not answering.
        if (error?.code === 'TIMEOUT') timeouts += 1;
        if (!retryable(error) || attempt >= retryDelays.length || timeouts > 1) throw error;
        const asked = Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0;
        const wait = Math.min(Math.max(retryDelays[attempt], asked), MAX_RETRY_AFTER_MS);
        if (heard) {
          heard = false;
          try { onDelta({ type: 'retry', attempt: attempt + 1, reason: error.code || String(error.status || '') }); } catch { /* observers never break it */ }
        }
        await waitForRetry(requestId, wait);
      }
    }
    const choice = isRecord(data) && Array.isArray(data.choices) ? data.choices[0] : undefined;
    const message = isRecord(choice) ? choice.message : undefined;
    if (!isRecord(message)) throw new ProviderError('Provider response did not contain assistant text or tool calls.');
    const text = completionText(message);
    const toolCalls = parseToolCalls(message.tool_calls);
    const hasText = Boolean(text.trim());
    if (!hasText && !toolCalls.length) {
      // Seen live: a model that wrote its whole answer into its thinking, twice in a row.
      const error = reasoningText(message)
        ? new ProviderError('The model finished without an answer: it wrote only its thinking. Send the message again, or pick another model.', 'EMPTY_REPLY')
        : new ProviderError('Provider response did not contain assistant text or tool calls.', 'EMPTY_REPLY');
      // What the empty attempts used is still billed: the tool loop counts it.
      const spent = addUsage(emptyUsage, completionUsage(data));
      if (spent) error.usage = spent;
      const pricing = modelPricing(snapshot);
      if (pricing) error.pricing = pricing;
      throw error;
    }
    const responsePricing = modelPricing(snapshot);
    const result = {
      content: hasText ? text : null,
      toolCalls,
      model: typeof data.model === 'string' && data.model.trim() && Buffer.byteLength(data.model) <= 256
        && !/[\x00-\x1f\x7f]/.test(data.model) ? data.model : snapshot.model,
      ...(responsePricing ? { pricing: responsePricing } : {}),
    };
    const thought = reasoningText(message);
    if (thought) result.reasoning = thought;
    const usage = addUsage(emptyUsage, completionUsage(data));
    if (usage) result.usage = usage;
    result.finishReason = typeof choice.finish_reason === 'string' && choice.finish_reason.length <= 64
      && !/[\x00-\x1f\x7f]/.test(choice.finish_reason) ? choice.finish_reason : null;
    return result;
  }

  return {
    get, save, setModel, refreshModels, test, discover, send, complete, snapshot, cancel, clear, cancelAll,
    profiles, addProfile, selectProfile, renameProfile, removeProfile, mediaFetch, redact,
  };
}

module.exports = { createProvider };
