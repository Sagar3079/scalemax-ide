'use strict';

const MAX_ROUNDS_LIMIT = 64;
const MAX_CALLS_PER_ROUND = 8;
const MAX_TOOL_RESULT_BYTES = 64 * 1024;
const MAX_PREVIEW_CHARS = 200;
const MAX_ERROR_CHARS = 500;
const MAX_TEXT_BYTES = 1024 * 1024;
const TRUNCATION_MARKER = '\n[truncated]';
const FALLBACK_TEXT = 'The tool-use limit was reached before the model produced a final answer.';
const USAGE_KEYS = ['prompt_tokens', 'completion_tokens', 'total_tokens'];

// Mirrors the provider's error shape (name 'ProviderError' plus a code) so
// callers can handle loop failures and provider failures the same way.
class ToolLoopError extends Error {
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

function truncateChars(value, max) {
  if (value.length <= max) return value;
  let end = max;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

function capBytes(value, maxBytes) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes - Buffer.byteLength(TRUNCATION_MARKER);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return `${buffer.subarray(0, end).toString('utf8')}${TRUNCATION_MARKER}`;
}

function preview(text) {
  return truncateChars(text.replace(/\s+/g, ' ').trim(), MAX_PREVIEW_CHARS);
}

function messageOf(error) {
  const message = typeof error?.message === 'string' ? error.message.replace(/\s+/g, ' ').trim() : '';
  return message ? truncateChars(message, MAX_ERROR_CHARS) : 'Tool call failed.';
}

function normalizeToolErrors(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.filter(isRecord).map((error) => ({
    serverId: typeof error.serverId === 'string' ? error.serverId : null,
    message: messageOf(error),
  }));
}

function addUsage(total, usage) {
  if (!isRecord(usage)) return;
  for (const key of USAGE_KEYS) {
    if (Number.isSafeInteger(usage[key]) && usage[key] >= 0) total[key] = (total[key] || 0) + usage[key];
  }
}

// Parses tool-call arguments. Some models (seen live with DeepSeek on tools that
// take no parameters) append junk after a valid object, e.g. `{}""`; the leading
// JSON object is used when the rest is only quotes or whitespace.
function parseArguments(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return {};
  try { return JSON.parse(text); } catch { /* try the leading object below */ }
  if (text[0] !== '{') return undefined;
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        if (!/^["'\s]*$/.test(text.slice(index + 1))) return undefined;
        try { return JSON.parse(text.slice(0, index + 1)); } catch { return undefined; }
      }
    }
  }
  return undefined;
}

function toolResultText(result) {
  if (typeof result?.text === 'string' && result.text) return result.text;
  // Servers may answer with structured content only; the model still needs text.
  if (isRecord(result?.structured)) {
    try { return JSON.stringify(result.structured); } catch { return ''; }
  }
  return '';
}

// Only user and assistant turns come from the renderer; system and tool
// messages are built here.
function validateInput(input) {
  if (!isRecord(input)) throw new ToolLoopError('Chat request must be an object.');
  const { requestId, messages, systemPrompt = '' } = input;
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128
    || /[\x00-\x1f\x7f]/.test(requestId)) throw new ToolLoopError('A bounded, nonempty requestId is required.');
  if (!Array.isArray(messages) || !messages.length || messages.length > 500) {
    throw new ToolLoopError('Messages must be a nonempty array of at most 500 entries.');
  }
  for (const message of messages) {
    if (!isRecord(message) || !['user', 'assistant'].includes(message.role)
      || typeof message.content !== 'string' || Buffer.byteLength(message.content) > MAX_TEXT_BYTES) {
      throw new ToolLoopError('Messages must contain user or assistant roles with text of at most 1 MB each.');
    }
  }
  if (typeof systemPrompt !== 'string' || Buffer.byteLength(systemPrompt) > MAX_TEXT_BYTES) {
    throw new ToolLoopError('System prompt must be text of at most 1 MB.');
  }
  return { requestId, messages, systemPrompt, temperature: input.temperature };
}

function createToolLoop({ provider, mcp, maxRounds = 8 } = {}) {
  if (!provider || typeof provider.send !== 'function' || typeof provider.complete !== 'function'
    || typeof provider.cancel !== 'function') {
    throw new TypeError('A provider with send, complete and cancel is required.');
  }
  if (!mcp || typeof mcp.chatTools !== 'function' || typeof mcp.callTool !== 'function') {
    throw new TypeError('An MCP manager with chatTools and callTool is required.');
  }
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_ROUNDS_LIMIT) {
    throw new TypeError(`maxRounds must be an integer between 1 and ${MAX_ROUNDS_LIMIT}.`);
  }
  // requestId -> { cancelled, cancelPromise, reject } for loops in progress.
  const active = new Map();

  function cancelledError() {
    return new ToolLoopError('Provider request was cancelled.', 'CANCELLED');
  }

  function begin(requestId) {
    if (active.has(requestId)) throw new ToolLoopError('A request with this requestId is already in flight.');
    const state = { cancelled: false, cancelPromise: null, reject: null };
    state.cancelPromise = new Promise((resolve, reject) => { state.reject = reject; });
    state.cancelPromise.catch(() => {});
    active.set(requestId, state);
    return state;
  }

  function checkpoint(state) {
    if (state.cancelled) throw cancelledError();
  }

  // Runs one step (chatTools, complete, callTool). Cancellation wins the race
  // immediately; a step that is still running finishes in the background and
  // its result is ignored.
  async function run(state, task) {
    checkpoint(state);
    const result = await Promise.race([Promise.resolve().then(task), state.cancelPromise]);
    checkpoint(state);
    return result;
  }

  function cancel(requestId) {
    let cancelled = false;
    const state = typeof requestId === 'string' ? active.get(requestId) : undefined;
    if (state && !state.cancelled) {
      state.cancelled = true;
      state.reject(cancelledError());
      cancelled = true;
    }
    // Also aborts a provider request in flight under this id (plan mode,
    // plain sends, or the current complete() round).
    try {
      if (provider.cancel(requestId) === true) cancelled = true;
    } catch { /* cancellation is best effort */ }
    return cancelled;
  }

  function resolveTool(resolve, name) {
    try {
      const target = resolve(name);
      return isRecord(target) && typeof target.serverId === 'string' && typeof target.toolName === 'string'
        ? target : null;
    } catch {
      return null;
    }
  }

  // Records the call in the summary and returns the bounded tool message content.
  function settleCall(context, call, target, ok, content) {
    const capped = capBytes(content, MAX_TOOL_RESULT_BYTES);
    context.summary.push({
      server: target ? target.serverId : null,
      tool: target ? target.toolName : truncateChars(String(call.name), 128),
      ok,
      preview: preview(capped),
    });
    return capped;
  }

  function skipCall(call, context) {
    const target = resolveTool(context.resolve, call.name);
    return settleCall(context, call, target, false, `Error: skipped; at most ${MAX_CALLS_PER_ROUND} tool calls run per round.`);
  }

  // Executes one model tool call and returns the tool message content. Every
  // failure becomes an 'Error: ...' result so the model can recover.
  async function executeCall(state, call, context) {
    const target = resolveTool(context.resolve, call.name);
    const settle = (ok, content) => settleCall(context, call, target, ok, content);
    const args = parseArguments(call.arguments);
    if (!isRecord(args)) return settle(false, 'Error: invalid JSON arguments');
    if (!target) return settle(false, 'Error: unknown tool');
    if (context.readOnlyOnly && target.readOnly !== true) {
      return settle(false, 'Error: this tool is not available in read-only mode');
    }
    let result;
    try {
      result = await run(state, () => mcp.callTool({ id: target.serverId, name: target.toolName, arguments: args }));
    } catch (error) {
      if (state.cancelled) throw cancelledError();
      return settle(false, `Error: ${messageOf(error)}`);
    }
    const text = toolResultText(result);
    return result?.isError === true ? settle(false, `Error: ${text}`) : settle(true, text);
  }

  async function loadCatalog(state, readOnlyOnly) {
    try {
      const catalog = await run(state, () => mcp.chatTools({ readOnlyOnly }));
      return {
        tools: Array.isArray(catalog?.tools) ? catalog.tools : [],
        resolve: typeof catalog?.resolve === 'function' ? catalog.resolve : () => null,
        errors: normalizeToolErrors(catalog?.errors),
      };
    } catch (error) {
      if (state.cancelled) throw cancelledError();
      // A broken MCP configuration must not break plain chat.
      return { tools: [], resolve: () => null, errors: [{ serverId: null, message: messageOf(error) }] };
    }
  }

  async function send(input, options = {}) {
    const permission = isRecord(options) ? options.permission : undefined;
    if (permission === 'plan') return provider.send(input);
    const { requestId, messages, systemPrompt, temperature } = validateInput(input);
    const readOnlyOnly = permission === 'readonly';
    const state = begin(requestId);
    try {
      const catalog = await loadCatalog(state, readOnlyOnly);
      if (!catalog.tools.length) {
        const result = await run(state, () => provider.send(input));
        return catalog.errors.length ? { ...result, toolErrors: catalog.errors } : result;
      }
      const chat = systemPrompt.trim() ? [{ role: 'system', content: systemPrompt }] : [];
      for (const message of messages) chat.push({ role: message.role, content: message.content });
      const context = { resolve: catalog.resolve, readOnlyOnly, summary: [] };
      const usage = {};
      const finish = (reply, text) => {
        const result = { text, model: reply.model };
        if (Object.keys(usage).length) result.usage = { ...usage };
        result.toolCalls = context.summary;
        result.toolErrors = catalog.errors;
        return result;
      };
      for (let round = 0; round < maxRounds; round += 1) {
        const reply = await run(state, () => provider.complete({ requestId, messages: chat, tools: catalog.tools, temperature }));
        addUsage(usage, reply.usage);
        const calls = Array.isArray(reply.toolCalls) ? reply.toolCalls : [];
        if (!calls.length) return finish(reply, typeof reply.content === 'string' ? reply.content : '');
        chat.push({
          role: 'assistant',
          content: typeof reply.content === 'string' ? reply.content : null,
          tool_calls: calls.map((call) => ({
            id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments },
          })),
        });
        // Every tool_call id gets a tool message, including calls over the per-round limit.
        for (const [index, call] of calls.entries()) {
          checkpoint(state);
          const content = index < MAX_CALLS_PER_ROUND
            ? await executeCall(state, call, context)
            : skipCall(call, context);
          chat.push({ role: 'tool', tool_call_id: call.id, content });
        }
      }
      // Round limit reached: one last answer without tools.
      const final = await run(state, () => provider.complete({ requestId, messages: chat, tools: [], temperature }));
      addUsage(usage, final.usage);
      return finish(final, typeof final.content === 'string' && final.content.trim() ? final.content : FALLBACK_TEXT);
    } finally {
      if (active.get(requestId) === state) active.delete(requestId);
    }
  }

  return { send, cancel };
}

module.exports = { createToolLoop };
