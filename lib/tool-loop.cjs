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
// Steps the reply reports (what the model did on the way to its answer).
const MAX_STEPS = 200;
const MAX_TITLE_CHARS = 160;
const MAX_NOTE_BYTES = 8 * 1024;
// A command's output: the end is kept (errors and test summaries are printed last).
const MAX_STEP_OUTPUT_BYTES = 4 * 1024;
const MAX_LIVE_OUTPUT_BYTES = 64 * 1024;

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

// The last `maxBytes` of a text, cut at a character boundary.
function tailBytes(value, maxBytes) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
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

// Every provider completion in a tool loop is kept as a small ledger entry. The finished reply
// still has its aggregate `usage`, but the ledger makes tool-heavy costs understandable later.
function usageRound(reply) {
  if (!isRecord(reply)) return null;
  const result = {};
  if (typeof reply.model === 'string' && reply.model.trim() && reply.model.length <= 256) result.model = reply.model;
  if (isRecord(reply.usage)) {
    const usage = {};
    for (const key of USAGE_KEYS) if (Number.isSafeInteger(reply.usage[key]) && reply.usage[key] >= 0) usage[key] = reply.usage[key];
    if (Object.keys(usage).length) result.usage = usage;
  }
  if (isRecord(reply.pricing)) result.pricing = reply.pricing;
  // A model name alone has no usage/cost value; avoid creating noise for providers that report neither.
  return result.usage || result.pricing ? result : null;
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
  return { requestId, messages, systemPrompt, temperature: input.temperature, reasoning: input.reasoning };
}

// Permission modes for tool calls the model makes:
//   manual  every call waits for the user's approval
//   basic   read-only tools (MCP readOnlyHint) run automatically, everything else waits
//   bypass  everything runs (autonomous; the user consented to this in the app)
// Unknown values are treated as manual.
//   plan    read-only: tools that change something are refused, not asked (the reply plans instead)
const PERMISSIONS = new Set(['plan', 'manual', 'basic', 'bypass']);

function normalizePermission(value) {
  return PERMISSIONS.has(value) ? value : 'manual';
}

function needsApproval(permission, target) {
  if (permission === 'bypass') return false;
  if (permission === 'basic' || permission === 'plan') return target.readOnly !== true;
  return true;
}

/** Plan permission answers a changing tool call with this instead of running or asking. */
function refusesChanges(permission) {
  return permission === 'plan';
}
const PLAN_REFUSAL = 'Error: this reply is in Plan permission, so nothing may be changed and no approval can be given. Do not try this or any other changing tool again in this reply. Finish investigating with the read-only tools and answer with the plan; the user presses "Run this plan" to let it be carried out.';

function argumentPreview(args) {
  let text;
  try { text = JSON.stringify(args, null, 2); } catch { text = '{}'; }
  return capBytes(text, 4096);
}

/**
 * @param {object} options
 * @param {(request: {requestId: string, serverId: string, toolName: string, readOnly: boolean,
 *   arguments: string}, context: {signal: AbortSignal}) => Promise<'once'|'request'|'deny'|boolean>} [options.approve]
 *   Asks the user about one tool call. Without it, calls that need approval are refused.
 * @param {(text: string, sources: string[], context: {model?: string}) => string} [options.restoreText]
 *   Repairs the final reply and reasoning text; `sources` are the texts the model was given in
 *   this request (instructions, messages, tool results, its own tool arguments).
 */
function createToolLoop({ provider, mcp, maxRounds = 8, approve = null, restoreText = null } = {}) {
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
    // `controller` aborts a pending approval prompt; `allowAll` is "Allow all in this reply".
    const state = { cancelled: false, cancelPromise: null, reject: null, controller: new AbortController(), allowAll: false };
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
      state.controller.abort();
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

  // Records the call in the summary and the steps, and returns the bounded tool message content.
  function settleCall(context, call, target, ok, content, step = null) {
    const capped = capBytes(content, MAX_TOOL_RESULT_BYTES);
    context.summary.push({
      server: target ? target.serverId : null,
      tool: target ? target.toolName : truncateChars(String(call.name), 128),
      ok,
      preview: preview(capped),
    });
    const entry = step || { callId: context.nextCallId(), title: stepTitle(context, target, call, null), output: '', started: false };
    const record = {
      type: 'tool', title: entry.title, server: target ? target.serverId : null,
      tool: target ? target.toolName : truncateChars(String(call.name), 128), ok, preview: preview(capped),
    };
    if (entry.output) record.output = tailBytes(entry.output, MAX_STEP_OUTPUT_BYTES);
    context.steps.push(record);
    if (entry.started) context.report?.({ phase: 'tool-done', callId: entry.callId, ok });
    return capped;
  }

  function skipCall(call, context) {
    const target = resolveTool(context.resolve, call.name);
    return settleCall(context, call, target, false, `Error: skipped; at most ${MAX_CALLS_PER_ROUND} tool calls run per round.`);
  }

  // "Read src/app.js", "Ran npm test": from the tool source when it knows the tool, else server · tool.
  function stepTitle(context, target, call, args) {
    if (target && typeof context.describeCall === 'function') {
      try {
        const title = context.describeCall(target, args || {});
        if (typeof title === 'string' && title.trim()) return truncateChars(title.replace(/\s+/g, ' ').trim(), MAX_TITLE_CHARS);
      } catch { /* the generic title below */ }
    }
    if (target) return truncateChars(`${target.serverId} · ${target.toolName}`, MAX_TITLE_CHARS);
    return truncateChars(String(call.name || 'tool'), MAX_TITLE_CHARS);
  }

  // Executes one model tool call and returns the tool message content. Every
  // failure becomes an 'Error: ...' result so the model can recover.
  async function executeCall(state, call, context) {
    const target = resolveTool(context.resolve, call.name);
    const args = parseArguments(call.arguments);
    const step = { callId: context.nextCallId(), title: stepTitle(context, target, call, isRecord(args) ? args : null), output: '', started: false };
    const settle = (ok, content) => settleCall(context, call, target, ok, content, step);
    if (!isRecord(args)) return settle(false, 'Error: invalid JSON arguments');
    if (!target) return settle(false, 'Error: unknown tool');
    const announce = (phase) => {
      step.started = true;
      context.report?.({ phase, callId: step.callId, title: step.title, serverId: target.serverId, toolName: target.toolName });
    };
    // Some calls always need the user's OK, in every mode and whatever was allowed before in this
    // reply (a command outside the sandbox): the target names the reason.
    let reason = '';
    try {
      reason = typeof target.alwaysAsk === 'function' ? String(target.alwaysAsk(args) || '') : '';
    } catch {
      reason = 'required';
    }
    // Plan permission never reaches the approval prompt: a changing tool is refused outright, so
    // the reply cannot touch the project even if the user is at the keyboard to allow it.
    if (refusesChanges(context.permission) && target.readOnly !== true) {
      announce('tool');
      return settle(false, PLAN_REFUSAL);
    }
    if (reason || (needsApproval(context.permission, target) && !state.allowAll)) {
      if (typeof approve !== 'function') {
        return settle(false, 'Error: this tool call needs the user\'s approval, which is not available here.');
      }
      let decision;
      announce('approval');
      try {
        decision = await run(state, () => approve({
          requestId: context.requestId,
          serverId: target.serverId,
          toolName: target.toolName,
          readOnly: target.readOnly === true,
          arguments: argumentPreview(args),
          ...(reason ? { reason } : {}),
        }, { signal: state.controller.signal }));
      } catch (error) {
        if (state.cancelled) throw cancelledError();
        decision = 'deny';
      }
      // "Allow all in this reply" never covers a call that must always ask.
      if (decision === 'request' && !reason) state.allowAll = true;
      else if (decision !== 'once' && decision !== true && decision !== 'request') {
        return settle(false, 'Error: the user denied this tool call. Do not retry it; continue without it or ask the user.');
      }
    }
    let result;
    announce('tool');
    // Built-in tools stream what they print (commands) and stop when the reply is cancelled.
    const onOutput = (text) => {
      if (typeof text !== 'string' || !text || state.cancelled) return;
      step.output = tailBytes(step.output + text, MAX_LIVE_OUTPUT_BYTES);
      context.report?.({ phase: 'tool-output', callId: step.callId, text });
    };
    try {
      result = await run(state, () => context.source.callTool(
        { id: target.serverId, name: target.toolName, arguments: args },
        { signal: state.controller.signal, onOutput },
      ));
    } catch (error) {
      if (state.cancelled) throw cancelledError();
      return settle(false, `Error: ${messageOf(error)}`);
    }
    const text = toolResultText(result);
    return result?.isError === true ? settle(false, `Error: ${text}`) : settle(true, text);
  }

  function repaired(result, sources, folderName = '') {
    if (typeof restoreText !== 'function' || !isRecord(result)) return result;
    const fix = (value) => {
      if (typeof value !== 'string' || !value) return value;
      try {
        const fixed = restoreText(value, sources, { model: result.model, folderName });
        return typeof fixed === 'string' ? fixed : value;
      } catch {
        return value;
      }
    };
    const next = { ...result, text: fix(result.text) };
    if (typeof result.reasoning === 'string') next.reasoning = fix(result.reasoning);
    if (Array.isArray(result.steps)) {
      next.steps = result.steps.map((step) => (step.type === 'note'
        ? { ...step, text: fix(step.text) }
        : { ...step, title: fix(step.title) }));
    }
    return next;
  }

  function chatSources(chat) {
    const sources = [];
    for (const message of chat) {
      if (typeof message.content === 'string') sources.push(message.content);
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (typeof call?.function?.arguments === 'string') sources.push(call.function.arguments);
      }
    }
    return sources;
  }

  async function loadCatalog(state, source, mode) {
    try {
      // `mode` decides which built-in tools the source offers (lib/modes.cjs); without one the
      // source keeps its own default, and the option is left out entirely.
      const catalog = await run(state, () => source.chatTools(mode === undefined ? {} : { mode }));
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

  function toolSource(value) {
    return value && typeof value === 'object' && typeof value.chatTools === 'function'
      && typeof value.callTool === 'function' ? value : null;
  }

  /**
   * @param {object} [options]
   * @param {string} [options.permission] manual | basic | bypass
   * @param {string} [options.mode] which built-in tools the source offers (lib/modes.cjs)
   * @param {number} [options.maxRounds] tool rounds for this reply, at most the configured limit
   * @param {object} [options.source] the tools for this reply ({ chatTools, callTool, describeCall? });
   *   main binds one to the task's folder for every request. Default: the loop's own `mcp`.
   * @param {string} [options.folderName] the task folder's name, for repairing reply text
   * @param {(event: object) => void} [options.onProgress] what the reply is doing right now:
   *   { phase: 'thinking', round } a model call starts;
   *   { phase: 'delta', kind: 'text' | 'reasoning', text } the model wrote more (streamed);
   *   { phase: 'preparing', serverId, toolName } the model is writing a tool call;
   *   { phase: 'approval' | 'tool', callId, title, serverId, toolName } a call waits for approval / runs;
   *   { phase: 'tool-output', callId, text } a command printed something;
   *   { phase: 'tool-done', callId, ok } the call finished.
   *   With a listener the model's reply is streamed.
   * @returns {Promise<object>} the reply; `thinkingMs` is the time spent waiting for the model and
   *   `steps` what it did on the way ({ type: 'note', text } and { type: 'tool', title, ok, ... }).
   */
  async function send(input, options = {}) {
    const permission = normalizePermission(isRecord(options) ? options.permission : undefined);
    const mode = isRecord(options) && typeof options.mode === 'string' ? options.mode : undefined;
    // A mode may ask for more rounds than the default, never more than the hard limit.
    const rounds = isRecord(options) && Number.isSafeInteger(options.maxRounds) && options.maxRounds >= 1
      ? Math.min(options.maxRounds, MAX_ROUNDS_LIMIT) : maxRounds;
    const onProgress = isRecord(options) && typeof options.onProgress === 'function' ? options.onProgress : null;
    const source = (isRecord(options) && toolSource(options.source)) || mcp;
    const folderName = isRecord(options) && typeof options.folderName === 'string' ? options.folderName : '';
    const { requestId, messages, systemPrompt, temperature, reasoning } = validateInput(input);
    const state = begin(requestId);
    const report = (event) => {
      if (!onProgress || state.cancelled) return;
      try { onProgress({ requestId, ...event }); } catch { /* observers never break the reply */ }
    };
    let thinkingMs = 0;
    let round = 0;
    // One reply may contain several model completions around tools. Keep their individual
    // usage/pricing records and a safe partial snapshot if a later round fails or is cancelled.
    const usage = {};
    const usageRounds = [];
    let lastPricing = null;
    let lastModel = '';
    const recordUsage = (reply) => {
      addUsage(usage, reply?.usage);
      const entry = usageRound(reply);
      if (entry) usageRounds.push(entry);
      if (isRecord(reply?.pricing)) lastPricing = reply.pricing;
      if (typeof reply?.model === 'string' && reply.model.trim()) lastModel = reply.model;
    };
    const usageSnapshot = () => {
      if (!Object.keys(usage).length && !usageRounds.length) return null;
      return {
        ...(lastModel ? { model: lastModel } : {}),
        ...(Object.keys(usage).length ? { usage: { ...usage } } : {}),
        ...(usageRounds.length ? { usageRounds: usageRounds.slice() } : {}),
        ...(lastPricing ? { pricing: lastPricing } : {}),
      };
    };
    // Times one model call; the renderer shows the total as "Thought for Ns".
    const timed = async (task) => {
      report({ phase: 'thinking', round });
      round += 1;
      const started = Date.now();
      try {
        return await run(state, task);
      } finally {
        thinkingMs += Date.now() - started;
      }
    };
    try {
      const catalog = await loadCatalog(state, source, mode);
      // Streamed pieces of the reply, for a listener; the model's tool calls in the making too.
      const onDelta = onProgress ? (delta) => {
        if (!isRecord(delta)) return;
        if ((delta.type === 'text' || delta.type === 'reasoning') && typeof delta.text === 'string' && delta.text) {
          report({ phase: 'delta', kind: delta.type, text: delta.text });
        } else if (delta.type === 'tool' && typeof delta.name === 'string') {
          const target = resolveTool(catalog.resolve, delta.name);
          if (target) report({ phase: 'preparing', serverId: target.serverId, toolName: target.toolName });
        }
      } : null;
      const chat = systemPrompt.trim() ? [{ role: 'system', content: systemPrompt }] : [];
      for (const message of messages) chat.push({ role: message.role, content: message.content });
      const providerSnapshot = typeof provider.snapshot === 'function' ? provider.snapshot() : null;
      const ask = (tools) => {
        const request = { requestId, messages: chat, tools, temperature, ...(reasoning === undefined ? {} : { reasoning }) };
        // A tool loop owns one frozen provider snapshot: another task can switch the active model
        // without repricing or rerouting this reply's later rounds.
        return onDelta ? provider.complete(request, { onDelta, snapshot: providerSnapshot }) : provider.complete(request, { snapshot: providerSnapshot });
      };
      if (!catalog.tools.length) {
        const sources = [systemPrompt, ...messages.map((message) => message.content)];
        let reply;
        if (onDelta) {
          // Streamed like a tool round, only without tools.
          const answer = await timed(() => ask([]));
          reply = { text: typeof answer.content === 'string' ? answer.content : '', model: answer.model, pricing: answer.pricing };
          if (typeof answer.reasoning === 'string' && answer.reasoning.trim()) reply.reasoning = answer.reasoning;
          if (isRecord(answer.usage)) reply.usage = answer.usage;
        } else {
          reply = await timed(() => provider.send(input));
        }
        recordUsage(reply);
        const result = repaired({
          ...reply, thinkingMs,
          ...(usageSnapshot() ? { usageRounds: usageSnapshot().usageRounds } : {}),
        }, sources, folderName);
        return catalog.errors.length ? { ...result, toolErrors: catalog.errors } : result;
      }
      let calls = 0;
      const context = {
        resolve: catalog.resolve, permission, requestId, summary: [], steps: [], report, source,
        describeCall: typeof source.describeCall === 'function' ? (target, args) => source.describeCall(target, args) : null,
        nextCallId: () => `step-${(calls += 1)}`,
      };
      const thoughts = [];
      const finish = (reply, text) => {
        const result = { text, model: reply.model, thinkingMs };
        if (isRecord(reply.pricing)) result.pricing = reply.pricing;
        else if (lastPricing) result.pricing = lastPricing;
        if (thoughts.length) result.reasoning = capBytes(thoughts.join('\n\n'), 64 * 1024);
        if (Object.keys(usage).length) result.usage = { ...usage };
        if (usageRounds.length) result.usageRounds = usageRounds.slice();
        result.toolCalls = context.summary;
        result.toolErrors = catalog.errors;
        if (context.steps.length) result.steps = context.steps.slice(0, MAX_STEPS);
        return repaired(result, chatSources(chat), folderName);
      };
      for (let index = 0; index < rounds; index += 1) {
        const reply = await timed(() => ask(catalog.tools));
        if (typeof reply.reasoning === 'string' && reply.reasoning.trim()) thoughts.push(reply.reasoning.trim());
        recordUsage(reply);
        const replyCalls = Array.isArray(reply.toolCalls) ? reply.toolCalls : [];
        if (!replyCalls.length) return finish(reply, typeof reply.content === 'string' ? reply.content : '');
        // What the model said on the way ("First I'll read the tests") stays with the steps.
        if (typeof reply.content === 'string' && reply.content.trim()) {
          context.steps.push({ type: 'note', text: capBytes(reply.content.trim(), MAX_NOTE_BYTES) });
        }
        chat.push({
          role: 'assistant',
          content: typeof reply.content === 'string' ? reply.content : null,
          tool_calls: replyCalls.map((call) => ({
            id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments },
          })),
        });
        // Every tool_call id gets a tool message, including calls over the per-round limit.
        for (const [position, call] of replyCalls.entries()) {
          checkpoint(state);
          const content = position < MAX_CALLS_PER_ROUND
            ? await executeCall(state, call, context)
            : skipCall(call, context);
          chat.push({ role: 'tool', tool_call_id: call.id, content });
        }
      }
      // Round limit reached: one last answer without tools.
      const final = await timed(() => ask([]));
      if (typeof final.reasoning === 'string' && final.reasoning.trim()) thoughts.push(final.reasoning.trim());
      recordUsage(final);
      return finish(final, typeof final.content === 'string' && final.content.trim() ? final.content : FALLBACK_TEXT);
    } catch (error) {
      const partialUsage = usageSnapshot();
      if (partialUsage && error && typeof error === 'object') error.usageSnapshot = { ...partialUsage, incomplete: true };
      throw error;
    } finally {
      if (active.get(requestId) === state) active.delete(requestId);
    }
  }

  return { send, cancel };
}

module.exports = { createToolLoop, normalizePermission, needsApproval, refusesChanges, PLAN_REFUSAL };
