'use strict';
// Subagents, like the task tool of other coding agents: the model hands a self-contained piece of
// work to a helper (a broad search across many files, or one of several independent parts of a
// job) and gets back one final answer instead of the helper's whole working. Each subagent runs a
// tool loop of its own (lib/tool-loop.cjs) with a fresh conversation: a short system prompt and
// the brief the model wrote, never the reply's history. Everything else is the reply's own (what
// the tool loop passes as `parent`, delegateContext):
//   - the provider snapshot and model the reply started with (or another model of the same
//     catalog when the settings name one for the kind), its reasoning and temperature settings;
//   - the reply's tools, through the reply's folder session: its permission mode and approvals
//     (the prompt says "Subagent: <description>"), the egress rule, the sandbox, and the changes
//     card all apply as they do to the reply. "explore" gets the read-only tools only, and no
//     subagent gets agent_task (one level deep);
//   - the reply's usage, which every model call of the subagent is added to as it is billed, so
//     the reply's tokens and cost include its subagents, also after a Stop;
//   - the reply's Stop, which ends every subagent it started.
// Several agent_task calls of one round run side by side (lib/tool-loop.cjs runCalls: the tool is
// read-only in the permission sense), at most three at a time per reply.
const { randomUUID } = require('crypto');
const { createToolLoop } = require('./tool-loop.cjs');
const { createProgressForwarder } = require('./progress.cjs');
const { createMetrics } = require('./metrics.cjs');

const SERVER_ID = 'Agents';
const KINDS = ['explore', 'general'];
// Model calls one subagent may make; the last one answers without tools (lib/tool-loop.cjs).
const MAX_ROUNDS = 20;
// The answer handed back to the reply; the rest is cut with a note.
const MAX_ANSWER_BYTES = 16 * 1024;
const ANSWER_CUT = '\n[ScaleMax cut the subagent\'s answer here, at 16 KB.]';
// Wall-clock time for one subagent, its approvals and commands included (an unanswered prompt is
// denied after 15 minutes, a command ends after 10).
const TIMEOUT_MS = 20 * 60_000;
// Subagents of one reply running at the same time, and started in all.
const MAX_RUNNING = 3;
const MAX_PER_REPLY = 16;
const MAX_DESCRIPTION_CHARS = 80;
const MAX_BRIEF_BYTES = 32 * 1024;
const MAX_ERROR_CHARS = 300;
// What is kept of a subagent's work with its step: calls for the reply's summary, steps for the window.
const MAX_CALLS = 64;
const MAX_KEPT_STEPS = 50;
const MAX_KEPT_NOTE_CHARS = 2000;
const USAGE_KEYS = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens'];

const TOOL = {
  name: 'agent_task',
  toolName: 'agent_task',
  description: 'Hand a self-contained piece of work to a subagent: a helper with a fresh context of its own that works through it with tools and reports back with one final answer. Use kind "explore" (read-only: list, read and search files, search the web, read pages) for broad searches across many files or folders and for research, and kind "general" (your tools) for independent parts of a larger job. Several agent_task calls in one round run at the same time. The subagent sees only your brief, not this conversation: give it the goal, what you already know, where to look and exactly what to report. Do it yourself when you know which file to read or it is one quick step.',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'What the subagent does, in 3 to 7 words ("Find where tokens are refreshed"). The user sees it.' },
      prompt: { type: 'string', description: 'The full brief: the goal, the context it needs, where to look, any constraints, and what its answer must contain.' },
      kind: { type: 'string', enum: KINDS, description: '"explore": read-only, for searching and research. "general": may also change files and run commands (the user may be asked first).' },
    },
    required: ['description', 'prompt', 'kind'],
    additionalProperties: false,
  },
};

const INSTRUCTIONS = [
  'You are a subagent of ScaleMax\'s assistant. It handed you one piece of a larger task, and the brief below is all you know about it: you cannot see its conversation, and nobody will answer a question, so find things out with your tools.',
  'How to work:',
  '- Do what the brief asks, and nothing more. Start at once.',
  '- Search broadly first, then read what matters; several searches or reads in one round run side by side. Check what you are about to report.',
  '- Your final answer goes back to the assistant, not to the user. Make it complete and specific, so it can act on it without repeating your work: file paths with line numbers, exact names, the commands you ran and their results, the addresses of the pages you used. Say what you could not find or do. No greeting, and no repeat of the brief.',
].join('\n');
const KIND_INSTRUCTIONS = {
  explore: 'Kind: explore. Your tools only read: list, read and search files, search the web and read pages. Nothing can be changed, so do not try.',
  general: 'Kind: general. You have the assistant\'s tools: you may change files and run commands where the brief asks for it (the user may be asked to approve them). Change only what the brief asks for, verify it, and list every file you changed and every command you ran with its result. Never claim a change you did not make.',
};
const PLAN_NOTE = 'This reply is in Plan permission: nothing may be changed, and every changing tool is refused before it runs. Investigate and report.';

class SubagentError extends Error {
  constructor(message, code = 'INVALID_AGENT_TASK') {
    super(message);
    this.name = 'SubagentError';
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clean(text, max) {
  const value = String(text ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…` : value;
}

function messageOf(error) {
  const message = typeof error?.message === 'string' ? clean(error.message, MAX_ERROR_CHARS) : '';
  return message || 'it failed';
}

// The first `maxBytes` of the answer, cut at a character boundary, with a note.
function capAnswer(text) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= MAX_ANSWER_BYTES) return text;
  let end = MAX_ANSWER_BYTES - Buffer.byteLength(ANSWER_CUT);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return `${buffer.subarray(0, end).toString('utf8')}${ANSWER_CUT}`;
}

function duration(ms) {
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.round(ms / 60_000);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function addTokens(total, usage) {
  if (!isRecord(usage)) return;
  for (const key of USAGE_KEYS) {
    if (Number.isSafeInteger(usage[key]) && usage[key] >= 0) total[key] = (total[key] || 0) + usage[key];
  }
}

function tokensOf(usage) {
  if (Number.isSafeInteger(usage.total_tokens)) return usage.total_tokens;
  if (Number.isSafeInteger(usage.prompt_tokens) && Number.isSafeInteger(usage.completion_tokens)) return usage.prompt_tokens + usage.completion_tokens;
  return null;
}

/** The arguments of one agent_task call, checked: { description, prompt, kind }. */
function taskOf(args) {
  const source = isRecord(args) ? args : {};
  const description = typeof source.description === 'string' ? clean(source.description, MAX_DESCRIPTION_CHARS) : '';
  const prompt = typeof source.prompt === 'string' ? source.prompt.trim() : '';
  if (!description) throw new SubagentError('"description" must say in a few words what the subagent does.');
  if (!prompt) throw new SubagentError('"prompt" must be the full brief for the subagent.');
  if (Buffer.byteLength(prompt) > MAX_BRIEF_BYTES) throw new SubagentError('Keep the brief under 32 KB: name the files to read instead of pasting them.');
  if (source.kind !== undefined && !KINDS.includes(source.kind)) throw new SubagentError('"kind" must be "explore" or "general".');
  // Without a kind it only reads: the safe choice.
  return { description, prompt, kind: source.kind || 'explore' };
}

function toolSource(value) {
  return isRecord(value) && typeof value.chatTools === 'function' && typeof value.callTool === 'function' ? value : null;
}

/**
 * The reply's tools as a subagent of `kind` sees them: never agent_task (subagents do not start
 * subagents), and for explore only what reads (no writes, commands, clipboard or to-do list). A
 * tool left out is unknown to the subagent's loop as well, so it cannot be called by name either.
 */
function scopedSource(source, kind) {
  const keep = (target) => isRecord(target) && typeof target.delegate !== 'function' && target.serverId !== SERVER_ID
    && (kind !== 'explore' || (target.readOnly === true && target.private !== true && target.exclusive !== true));
  return {
    async chatTools(options) {
      const catalog = await source.chatTools(options);
      const resolveAll = typeof catalog?.resolve === 'function' ? catalog.resolve : () => null;
      const resolve = (name) => {
        let target = null;
        try { target = resolveAll(name); } catch { return null; }
        return keep(target) ? target : null;
      };
      return {
        tools: (Array.isArray(catalog?.tools) ? catalog.tools : []).filter((definition) => resolve(definition?.function?.name)),
        resolve,
        errors: Array.isArray(catalog?.errors) ? catalog.errors : [],
      };
    },
    callTool: (input, context) => source.callTool(input, context),
    describeCall: (target, args) => (typeof source.describeCall === 'function' ? source.describeCall(target, args) : ''),
  };
}

/** The subagent's instructions: how to work, its kind, the folder, and Plan when it applies. */
function instructionsFor({ kind, folderName, permission }) {
  return [
    INSTRUCTIONS,
    KIND_INSTRUCTIONS[kind],
    folderName ? `The project folder is "${folderName}": the file tools work in it, with paths relative to it.` : '',
    permission === 'plan' ? PLAN_NOTE : '',
  ].filter(Boolean).join('\n\n');
}

// What is kept of a subagent's steps with its step: small (no command output), at most 50.
function keptSteps(steps) {
  if (!Array.isArray(steps)) return [];
  const kept = [];
  for (const step of steps) {
    if (kept.length >= MAX_KEPT_STEPS) break;
    if (!isRecord(step)) continue;
    if (step.type === 'note' && typeof step.text === 'string' && step.text.trim()) {
      kept.push({ type: 'note', text: step.text.trim().slice(0, MAX_KEPT_NOTE_CHARS) });
    } else if (step.type === 'tool' && typeof step.title === 'string') {
      const entry = { type: 'tool', title: step.title, ok: step.ok === true };
      for (const key of ['server', 'tool', 'preview']) if (typeof step[key] === 'string' && step[key]) entry[key] = step[key];
      if (step.stopped === true) entry.stopped = true;
      kept.push(entry);
    }
  }
  return kept;
}

/**
 * @param {object} options
 * @param {object} options.provider lib/provider.cjs (send, complete, cancel; snapshotFor for a
 *   model of its own per kind)
 * @param {Function} [options.approve] asks the user about one tool call (main's prompt); a
 *   subagent's request carries the reply's requestId and `subagent: <description>`
 * @param {Function} [options.restorer] repairs reply text (lib/tool-loop.cjs `restorer`)
 * @param {(sources: string[], folderName: string) => ((text: string) => string) | null} [options.restoreStream]
 *   the same repair for text while it streams in (lib/progress.cjs)
 * @param {(kind: string) => string} [options.modelFor] another model of the reply's provider for a
 *   kind ('' or unknown: the reply's own model)
 */
function createSubagents({
  provider, approve = null, restorer = null, restoreStream = null, modelFor = null,
  maxRounds = MAX_ROUNDS, timeoutMs = TIMEOUT_MS, maxRunning = MAX_RUNNING, maxPerReply = MAX_PER_REPLY,
} = {}) {
  if (!provider || typeof provider.send !== 'function' || typeof provider.complete !== 'function'
    || typeof provider.cancel !== 'function') {
    throw new TypeError('A provider with send, complete and cancel is required.');
  }
  // Per reply (the `scope` every subagent of one reply shares): how many started, how many run
  // now, and the ones waiting for a free place.
  const replies = new WeakMap();
  function placesOf(scope) {
    const key = isRecord(scope) ? scope : {};
    if (!replies.has(key)) replies.set(key, { started: 0, running: 0, waiting: [] });
    return replies.get(key);
  }
  // Waits for one of the reply's places; Stop on the reply gives up waiting.
  function takePlace(places, signal) {
    if (places.running < maxRunning) {
      places.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = {
        start: () => {
          signal?.removeEventListener?.('abort', onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        places.waiting = places.waiting.filter((item) => item !== entry);
        reject(new SubagentError('The reply was stopped.', 'CANCELLED'));
      };
      places.waiting.push(entry);
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }
  // A place that frees up goes straight to the next one waiting.
  function leavePlace(places) {
    const next = places.waiting.shift();
    if (next) next.start();
    else places.running -= 1;
  }

  // The reply's own snapshot, or one for the kind's model when the settings name another chat
  // model of the same provider (provider.snapshotFor checks it; anything unusable keeps the reply's).
  function snapshotFor(parent, kind) {
    const base = parent.snapshot || null;
    let wanted = '';
    try { wanted = typeof modelFor === 'function' ? String(modelFor(kind) || '') : ''; } catch { wanted = ''; }
    if (!base || !wanted || wanted === base.model || typeof provider.snapshotFor !== 'function') return base;
    try { return provider.snapshotFor(base, wanted) || base; } catch { return base; }
  }

  // The user's prompt for the subagent's calls: the reply's prompt, labelled with the subagent.
  // An "Allow all" (or "Allow <site>") given in this reply covers the subagent, and one given to
  // the subagent covers the rest of the reply; calls that always ask still always ask.
  function approverFor(parent, description) {
    if (typeof approve !== 'function') return null;
    const grants = isRecord(parent.grants) ? parent.grants : null;
    return async (request, context) => {
      const host = typeof request?.host === 'string' ? request.host : '';
      if (!request?.reason && grants?.allowsAll?.()) return 'once';
      if (request?.reason === 'egress' && host && grants?.allowedHosts?.has?.(host)) return 'once';
      const decision = await approve({ ...request, requestId: parent.requestId, subagent: description }, context);
      if (decision === 'request' && !request?.reason) grants?.allowAll?.();
      else if (decision === 'request' && request?.reason === 'egress' && host) grants?.allowedHosts?.add?.(host);
      return decision;
    };
  }

  async function work({ description, prompt, kind }, parent, tell) {
    if (parent.signal?.aborted) throw new SubagentError('The reply was stopped.', 'CANCELLED');
    const requestId = `agent-${randomUUID()}`;
    const snapshot = snapshotFor(parent, kind);
    // Its own totals (its status and the footer); every call also goes to the reply's totals.
    const usage = {};
    const rounds = [];
    let calls = 0;
    let model = '';
    let pricing = null;
    const count = (reply) => {
      if (!isRecord(reply)) return;
      try { parent.addUsage?.(reply); } catch { /* the reply's totals are best effort */ }
      addTokens(usage, reply.usage);
      rounds.push({ model: reply.model, usage: reply.usage, pricing: reply.pricing });
      if (typeof reply.model === 'string' && reply.model) model = reply.model;
      if (isRecord(reply.pricing)) pricing = reply.pricing;
    };
    const metricsOf = (incomplete) => createMetrics({ model, usage, pricing, usageRounds: rounds, incomplete });
    // The reply's provider, held on the reply's snapshot, counting every call.
    const scoped = {
      async send(input) {
        calls += 1;
        const reply = await provider.send(input);
        count(reply);
        return reply;
      },
      async complete(request, options) {
        calls += 1;
        try {
          const reply = await provider.complete(request, options);
          count(reply);
          return reply;
        } catch (error) {
          // An answer that came back empty was billed too (lib/provider.cjs EMPTY_REPLY).
          if (error?.code === 'EMPTY_REPLY' && isRecord(error.usage)) count({ usage: error.usage, pricing: error.pricing });
          throw error;
        }
      },
      cancel: (id) => provider.cancel(id),
      snapshot: () => snapshot,
    };
    const source = scopedSource(parent.source, kind);
    const systemPrompt = instructionsFor({ kind, folderName: parent.folderName, permission: parent.permission });
    // Its steps as they happen, kept for a subagent that does not finish (a finished one returns its own).
    const live = [];
    const byCall = new Map();
    const track = (event) => {
      if ((event.phase === 'approval' || event.phase === 'tool') && typeof event.callId === 'string' && !byCall.has(event.callId)) {
        const step = {
          type: 'tool', title: typeof event.title === 'string' && event.title ? event.title : String(event.toolName || 'Tool call'),
          server: String(event.serverId || ''), tool: String(event.toolName || ''), ok: false, stopped: true,
        };
        byCall.set(event.callId, step);
        if (live.length < MAX_KEPT_STEPS) live.push(step);
      } else if (event.phase === 'tool-done' && byCall.has(event.callId)) {
        const step = byCall.get(event.callId);
        step.ok = event.ok === true;
        delete step.stopped;
      }
    };
    // What it does reaches the window nested under its step, gathered like the reply's own
    // progress (lib/progress.cjs). Its thinking stays out: the step shows what it does and says.
    let repair = null;
    try { repair = typeof restoreStream === 'function' ? restoreStream([systemPrompt, prompt], parent.folderName || '') : null; } catch { repair = null; }
    const forward = parent.streaming ? createProgressForwarder({
      send: (event) => {
        if (!isRecord(event)) return;
        const nested = { ...event };
        delete nested.requestId;
        parent.report({ event: nested });
      },
      restore: typeof repair === 'function' ? repair : null,
    }) : null;
    const onProgress = forward ? (event) => {
      if (!isRecord(event)) return;
      track(event);
      if (event.phase === 'delta' && event.kind === 'reasoning') return;
      forward.push(event);
    } : undefined;
    const loop = createToolLoop({ provider: scoped, mcp: source, maxRounds, approve: approverFor(parent, description), restorer });
    // Stop on the reply, or the time running out, ends it like Stop ends a reply.
    let ended = '';
    const stop = (why) => {
      if (!ended) ended = why;
      loop.cancel(requestId);
    };
    const onAbort = () => stop('stopped');
    parent.signal?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    timer.unref?.();
    tell('running');
    try {
      const result = await loop.send({
        requestId,
        systemPrompt,
        messages: [{ role: 'user', content: prompt }],
        ...(typeof parent.temperature === 'number' ? { temperature: parent.temperature } : {}),
        ...(parent.reasoning !== undefined ? { reasoning: parent.reasoning } : {}),
      }, {
        permission: parent.permission,
        mode: parent.mode,
        maxRounds,
        source,
        folderName: parent.folderName || '',
        onProgress,
        // The brief is the model's own writing: an address in it that the reply was not given
        // counts as made up (it asks before opening), so a brief cannot launder one.
        modelWritten: [(typeof parent.madeUp === 'function' ? parent.madeUp(prompt) : []).join('\n')],
      });
      forward?.close();
      const metrics = metricsOf(false);
      tell('done', { rounds: calls, ...(metrics ? { metrics } : {}) });
      const answer = typeof result?.text === 'string' ? result.text.trim() : '';
      const tokens = tokensOf(usage);
      const footer = `[Subagent finished: ${calls} round${calls === 1 ? '' : 's'}${tokens === null ? '' : ` · ${tokens.toLocaleString('en-US')} tokens`}]`;
      return {
        text: `${capAnswer(answer || 'The subagent finished without an answer.')}\n\n${footer}`,
        calls: Array.isArray(result?.toolCalls) ? result.toolCalls.slice(0, MAX_CALLS) : [],
        agent: { kind, status: 'done', steps: keptSteps(result?.steps), rounds: calls, ...(metrics ? { metrics } : {}) },
      };
    } catch (error) {
      forward?.close();
      const stopped = ended === 'stopped' || parent.signal?.aborted === true;
      const reason = ended === 'timeout' ? `it ran out of time after ${duration(timeoutMs)}` : messageOf(error).replace(/[.\s]+$/, '');
      const metrics = metricsOf(true);
      tell(stopped ? 'stopped' : 'failed', { rounds: calls, error: reason, ...(metrics ? { metrics } : {}) });
      // Stopped with the reply: nothing goes back, the reply ends here as well.
      if (stopped) throw error;
      return {
        isError: true,
        text: `The subagent "${description}" did not finish: ${reason}. Its answer is lost; do this part yourself, or start a subagent with a smaller brief.`,
        agent: { kind, status: 'failed', steps: keptSteps(live), rounds: calls, ...(metrics ? { metrics } : {}) },
      };
    } finally {
      clearTimeout(timer);
      parent.signal?.removeEventListener?.('abort', onAbort);
    }
  }

  /** Runs one agent_task call inside its reply (`parent`, from lib/tool-loop.cjs delegateContext). */
  async function run(args, parent) {
    const task = taskOf(args);
    if (!isRecord(parent) || typeof parent.report !== 'function' || !toolSource(parent.source)) {
      throw new SubagentError('A subagent can only run inside a chat reply.', 'NO_REPLY');
    }
    const places = placesOf(parent.scope);
    if (places.started >= maxPerReply) {
      return { isError: true, text: `This reply already started ${maxPerReply} subagents, the most one reply may. Do the rest yourself.` };
    }
    places.started += 1;
    const tell = (status, extra = {}) => parent.report({ status, description: task.description, kind: task.kind, ...extra });
    if (places.running >= maxRunning) tell('queued');
    await takePlace(places, parent.signal);
    try {
      return await work(task, parent, tell);
    } finally {
      leavePlace(places);
    }
  }

  return {
    SERVER_ID,
    family: 'agents',
    definitions() {
      return [{ type: 'function', function: { name: TOOL.name, description: TOOL.description, parameters: structuredClone(TOOL.parameters) } }];
    },
    resolve(name) {
      // Read-only in the permission sense: it changes nothing itself, and each tool call of the
      // subagent is asked about (or refused in Plan) on its own. So it runs in Plan as well, and
      // several of one round run side by side. `delegate` makes the tool loop run it in the reply.
      return name === TOOL.name ? { serverId: SERVER_ID, toolName: TOOL.toolName, readOnly: true, delegate: run } : null;
    },
    // Only reached without a reply around it: lib/tool-loop.cjs runs `delegate` instead.
    async call(toolName) {
      if (toolName !== TOOL.toolName) throw new SubagentError(`Unknown subagent tool: ${toolName}`);
      throw new SubagentError('A subagent can only run inside a chat reply.', 'NO_REPLY');
    },
    describeCall(toolName, args) {
      const description = isRecord(args) && typeof args.description === 'string' ? clean(args.description, MAX_DESCRIPTION_CHARS) : '';
      return description ? `Subagent: ${description}` : 'Started a subagent';
    },
  };
}

module.exports = {
  createSubagents, scopedSource, taskOf, SERVER_ID, TOOL, KINDS, SubagentError,
  MAX_ROUNDS, MAX_ANSWER_BYTES, TIMEOUT_MS, MAX_RUNNING, MAX_PER_REPLY,
};
