/**
 * Replies in progress, one per task. Several tasks can work at the same time: main gives every
 * request a folder session of its own (main.js openChatSession). A reply streams in from main
 * (lib/progress.cjs): the text and thinking as the model writes them, every tool call as a step,
 * and a command's output while it runs. The live bubble is built once and then patched, and the
 * Markdown of the text being written is redrawn at most once per frame.
 * Finished replies keep their steps, folded above the answer (renderMessageSteps).
 * A subagent (agent_task, lib/subagents.cjs) is a group in the steps: its own steps nest under the
 * step of its call, live and after the reply is finished.
 * Every step shows how long it ran. The window measures it from the progress events (main sends
 * no durations): a call runs from its 'tool' event (after any approval) to its 'tool-done'.
 * Finished replies keep those times with their steps (timedSteps, partialReply), so they show
 * again after a reload.
 * The companion (src/mascot.js) sits beside the status line and shows what the reply is doing;
 * each subagent's group has a teammate.
 */
import { renderMarkdown } from './markdown.js';
import {
  toolActivity, normalizeSteps, stepSummary, normalizeChanges, normalizeTodos, normalizeMetrics, metricsLabel, durationText, AGENT_KINDS,
  STEP_OUTCOMES, stepOutcomeLabel, stepTitleForm,
} from './domain.mjs';
import { renderMascot, mascotSpec, setMascotState, companionStateFor, mascotCaption } from './mascot.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
// A running command's output kept on screen (the end of it).
const MAX_LIVE_OUTPUT = 16 * 1024;
const MAX_LIVE_TEXT = 1024 * 1024;
// Closer than this to the bottom, the transcript follows the reply as it grows.
const FOLLOW_PX = 48;
const STATE_TEXT = { running: 'running', approval: 'waiting for approval', ok: 'done', error: 'failed', stopped: 'stopped', declined: 'not run' };
// 'declined': a call that was not run on purpose (denied, Plan, a hook): a neutral dash, not a cross.
const ICON_PATHS = { ok: 'm5 12.5 4.5 4.5L19 7.5', error: 'M7 7l10 10M17 7 7 17', stopped: 'M8 8h8v8H8z', declined: 'M7 12h10' };
// The tense a step's title takes in each state: what it will do while it waits for approval (or
// never ran), what it is doing while it runs, what it did once done (domain.mjs stepTitleForm).
const TITLE_FORMS = { approval: 'intent', running: 'progressive', stopped: 'intent', declined: 'intent' };
const AGENT_STATUS_TEXT = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed', stopped: 'Stopped' };
const MAX_AGENT_DESCRIPTION = 80;
const MAX_AGENT_ERROR = 300;

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tag === 'button') node.type = 'button';
  return node;
}
function elapsedText(ms) {
  return durationText(Math.max(0, ms), { live: true });
}
// How long a step ran: measured when it finished, or until `now` for one still running or waiting
// (a stopped reply keeps the time it had run). Null when it never ran (an approval was refused).
function stepDuration(step, now) {
  if (Number.isSafeInteger(step.durationMs) && step.durationMs >= 0) return step.durationMs;
  return step.state === 'running' && Number.isFinite(step.startedAt) ? Math.max(0, Math.round(now - step.startedAt)) : null;
}
function stepIcon(state) {
  const holder = element('span', 'reply-step-icon');
  holder.setAttribute('aria-hidden', 'true');
  const path = ICON_PATHS[state];
  if (!path) return holder;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('focusable', 'false');
  const line = document.createElementNS(SVG_NS, 'path');
  line.setAttribute('d', path);
  svg.append(line);
  holder.append(svg);
  return holder;
}

/** A new reply for `taskId`; `kind` is 'chat' or 'media' (image and video generation). */
export function createReply({ taskId, requestId, kind = 'chat', thinking = false, mediaKind = '' }) {
  return {
    taskId, requestId, kind, mediaKind, thinking, startedAt: Date.now(),
    phase: kind === 'media' ? 'media' : 'thinking',
    activity: null, mediaPhase: '', progress: 0,
    // In order: { type: 'text', text } blocks and { type: 'tool', callId, title, state, output } steps.
    items: [],
    // The text block of the round being written (null until the model writes).
    current: null,
    // Thinking of earlier rounds, and of this one.
    reasoningDone: '', reasoningRound: '',
    view: null,
  };
}
export function replyReasoning(reply) {
  return [reply.reasoningDone, reply.reasoningRound].filter(Boolean).join('\n\n');
}
function stepFor(reply, callId) {
  return reply.items.find((item) => item.type === 'tool' && item.callId === callId) || null;
}
/** A subagent while it works: shaped like a reply, so its own progress events apply to it the same way. */
function createAgent() {
  return {
    description: '', kind: 'general', status: 'running', metrics: null, rounds: 0, error: '',
    phase: 'thinking', activity: null, items: [], current: null, reasoningDone: '', reasoningRound: '',
  };
}
// Subagents of the reply that are still at work (queued or running).
function workingAgents(reply) {
  return reply.items.filter((item) => item.type === 'tool' && item.agent && item.state !== 'ok' && item.state !== 'error'
    && (item.agent.status === 'queued' || item.agent.status === 'running'));
}

/**
 * Applies one progress event from main to the reply. Returns what changed, for patchReply:
 * { kind: 'status' | 'text' | 'reasoning' | 'step' | 'output', item?, added? }, or null.
 */
export function applyProgress(reply, event, now = Date.now()) {
  if (!reply || !event || typeof event !== 'object') return null;
  const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  switch (event.phase) {
    case 'thinking':
      // A new model round: its text is a new block, its thinking follows the earlier thinking.
      reply.phase = 'thinking';
      reply.activity = null;
      reply.current = null;
      reply.reasoningDone = replyReasoning(reply);
      reply.reasoningRound = '';
      reply.reasoningKept = '';
      return { kind: 'status' };
    case 'delta':
    case 'text-set': {
      if (typeof event.text !== 'string') return null;
      const replace = event.phase === 'text-set';
      if (event.kind === 'reasoning') {
        if (replace && !event.text && reply.reasoningRound) reply.reasoningKept = reply.reasoningRound;
        reply.reasoningRound = (replace ? event.text : reply.reasoningRound + event.text).slice(0, MAX_LIVE_TEXT);
        return { kind: 'reasoning' };
      }
      if (event.kind !== 'text') return null;
      let added = false;
      if (!reply.current) {
        reply.current = { type: 'text', text: '' };
        reply.items.push(reply.current);
        added = true;
      }
      // A retry starts the round again with nothing (text-set ''): what was written so far is kept
      // apart, so a reply that then fails still has it (partialReply).
      if (replace && !event.text && reply.current.text) reply.current.kept = reply.current.text;
      reply.current.text = (replace ? event.text : reply.current.text + event.text).slice(0, MAX_LIVE_TEXT);
      reply.phase = 'writing';
      reply.activity = null;
      return { kind: 'text', item: reply.current, added };
    }
    case 'preparing':
      reply.phase = 'preparing';
      reply.activity = toolActivity(event.serverId, event.toolName);
      return { kind: 'status' };
    case 'approval':
    case 'tool': {
      if (typeof event.callId !== 'string') return null;
      let step = stepFor(reply, event.callId);
      const added = !step;
      if (!step) {
        step = { type: 'tool', callId: event.callId, title: '', state: '', output: '', server: '', tool: '' };
        reply.items.push(step);
      }
      if (typeof event.title === 'string' && event.title) step.title = event.title;
      if (!step.title) step.title = typeof event.toolName === 'string' ? event.toolName : 'Tool call';
      if (typeof event.serverId === 'string') step.server = event.serverId;
      if (typeof event.toolName === 'string') step.tool = event.toolName;
      // It runs from now: waiting for the user's approval does not count as running time.
      if (event.phase === 'tool' && step.state !== 'running') step.startedAt = at;
      step.state = event.phase === 'approval' ? 'approval' : 'running';
      reply.phase = event.phase;
      reply.activity = toolActivity(event.serverId, event.toolName);
      // Text written after a tool call is the next block.
      reply.current = null;
      return { kind: 'step', item: step, added };
    }
    case 'tool-output': {
      const step = stepFor(reply, event.callId);
      if (!step || typeof event.text !== 'string') return null;
      step.output = (step.output + event.text).slice(-MAX_LIVE_OUTPUT);
      return { kind: 'output', item: step };
    }
    case 'tool-done': {
      const step = stepFor(reply, event.callId);
      if (!step) return null;
      const duration = stepDuration(step, at);
      if (duration !== null) step.durationMs = duration;
      // Not run on purpose (lib/tool-loop.cjs `outcome`): denied, refused in Plan, blocked by a hook.
      const outcome = event.ok !== true && STEP_OUTCOMES.includes(event.outcome) ? event.outcome : '';
      step.state = event.ok === true ? 'ok' : outcome ? 'declined' : 'error';
      if (outcome) step.outcome = outcome;
      if (outcome === 'hook' && typeof event.hook === 'string') step.hook = event.hook.slice(0, 60);
      reply.phase = 'working';
      reply.activity = null;
      return { kind: 'step', item: step };
    }
    case 'todos': {
      // The model's to-do list (todo_write), shown above the reply while it works.
      reply.todos = normalizeTodos(event.items);
      return { kind: 'todos' };
    }
    case 'retry':
      // The provider failed and the round is asked again (any text it showed was reset already):
      // `attempt` of `of` retries, when main says.
      reply.phase = 'retrying';
      reply.activity = null;
      reply.retry = {
        attempt: Number.isSafeInteger(event.attempt) && event.attempt > 0 ? event.attempt : 1,
        of: Number.isSafeInteger(event.of) && event.of > 0 ? event.of : 0,
      };
      return { kind: 'status' };
    case 'subagent': {
      // The subagent of the agent_task step `callId`: how it is doing, or one of its own progress
      // events (its callIds are its own). Subagents never nest, and changes are the reply's.
      const step = stepFor(reply, event.callId);
      if (!step) return null;
      const nested = event.event && typeof event.event === 'object' && !Array.isArray(event.event) ? event.event : null;
      if (nested) {
        if (nested.phase === 'subagent' || nested.phase === 'changes') return null;
        const agent = step.agent || createAgent();
        if (!applyProgress(agent, nested, at)) return null;
        step.agent = agent;
        return { kind: 'agent', item: step };
      }
      if (!Object.hasOwn(AGENT_STATUS_TEXT, String(event.status))) return null;
      if (!step.agent) step.agent = createAgent();
      const agent = step.agent;
      agent.status = event.status;
      if (typeof event.description === 'string' && event.description.trim()) agent.description = event.description.trim().slice(0, MAX_AGENT_DESCRIPTION);
      if (AGENT_KINDS.includes(event.kind)) agent.kind = event.kind;
      const metrics = normalizeMetrics(event.metrics);
      if (metrics) agent.metrics = metrics;
      if (Number.isSafeInteger(event.rounds) && event.rounds >= 0) agent.rounds = event.rounds;
      if (typeof event.error === 'string') agent.error = event.error.slice(0, MAX_AGENT_ERROR);
      return { kind: 'agent', item: step };
    }
    case 'changes': {
      // The files the reply changed so far (kept for review and undo, also when it is stopped);
      // null when it changed every one of them back.
      if (event.changes === null) {
        reply.changes = null;
        return { kind: 'changes' };
      }
      const changes = normalizeChanges(event.changes);
      if (!changes) return null;
      reply.changes = changes;
      return { kind: 'changes' };
    }
    default:
      return null;
  }
}

/** One line on what the reply is doing now ("Thinking…", "Running a command…"). */
export function statusText(reply) {
  if (reply.kind === 'media') {
    const what = reply.mediaKind === 'video' ? 'video' : 'image';
    if (reply.mediaPhase === 'queued') return 'Video queued at the provider…';
    if (reply.mediaPhase === 'downloading') return `Downloading the ${what}…`;
    const progress = Number.isFinite(reply.progress) && reply.progress > 0 ? ` ${reply.progress}%` : '';
    return `Generating ${what}${progress}…`;
  }
  // Subagents at work: a call of theirs waiting for approval first, then how many run.
  const agents = reply.phase === 'tool' || reply.phase === 'working' ? workingAgents(reply) : [];
  const asking = agents.find((item) => item.agent.phase === 'approval');
  if (asking) return `Waiting for your approval · Subagent: ${asking.agent.description || asking.title}`;
  if (agents.length) return agents.length === 1 ? 'Running a subagent…' : `Running ${agents.length} subagents…`;
  const activity = reply.activity;
  switch (reply.phase) {
    case 'approval':
      if (!activity) return 'Waiting for your approval…';
      // What it will do once allowed ("…to run a command"), not what it is doing.
      return activity.friendly ? `Waiting for your approval to ${lowerFirst(stepTitleForm(activity.text, 'intent'))}` : `Waiting for your approval · ${activity.text}`;
    case 'tool':
      if (!activity) return 'Working…';
      return activity.friendly ? `${activity.text}…` : `Running ${activity.text}…`;
    case 'preparing':
      return activity?.friendly ? `${activity.text}…` : 'Preparing a tool call…';
    case 'writing':
      return 'Writing…';
    case 'working':
      return 'Working…';
    case 'retrying': {
      const retry = reply.retry;
      if (retry?.of) return `Retrying (${Math.min(retry.attempt, retry.of)} of ${retry.of})…`;
      return 'The provider did not answer in full; trying again…';
    }
    default:
      if (reply.thinking) return 'Thinking…';
      return reply.items.length ? 'Working…' : 'Writing…';
  }
}

function lowerFirst(text) {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}
function textNode(item) {
  const node = element('div', 'msg-text md live-text');
  node.append(renderMarkdown(item.text));
  return node;
}
// Output without the blank lines many tools print first (npm does).
function shownOutput(text) {
  return String(text || '').replace(/^(?:[ \t]*\r?\n)+/, '');
}
function outputNode(text) {
  const pre = element('pre', 'reply-step-output');
  pre.textContent = shownOutput(text);
  pre.tabIndex = 0;
  pre.setAttribute('aria-label', 'Command output');
  return pre;
}
// "0.4s" after a step's title; a running step's clock ticks (tickReply).
function stepTime(step) {
  if (step.state === 'running' && Number.isFinite(step.startedAt)) {
    const node = element('span', 'reply-step-time is-running', elapsedText(Date.now() - step.startedAt));
    node.dataset.startedAt = String(step.startedAt);
    return node;
  }
  const text = Number.isSafeInteger(step.durationMs) ? durationText(step.durationMs) : '';
  return text ? element('span', 'reply-step-time', text) : null;
}
/**
 * "Edit src/a.js — waiting for your approval", "Running npm test", "Edited src/a.js",
 * "Edit src/a.js — Denied by you": the title in the tense of its state, and what kept a call
 * from running in place of a failure.
 */
function stepRow(step) {
  const row = element('div', 'reply-step-row');
  const title = element('span', 'reply-step-title', stepTitleForm(step.title, TITLE_FORMS[step.state] || 'past'));
  const why = step.state === 'approval' ? 'waiting for your approval'
    : step.state === 'declined' ? stepOutcomeLabel(step.outcome, step.hook) : '';
  // A hook that blocked a call says so in its own title already ("… (blocked, 0.2s)").
  const shown = Boolean(why) && step.outcome !== 'blocked';
  if (shown) title.append(element('span', 'reply-step-why', ` — ${why}`));
  row.append(stepIcon(step.state), title);
  if (!shown) row.append(element('span', 'sr-only', `, ${why ? why.toLowerCase() : STATE_TEXT[step.state] || ''}`));
  const time = stepTime(step);
  if (time) row.append(time);
  return row;
}
// How a finished step shows: done, failed, stopped, or not run on purpose.
function finishedState(step) {
  if (step.stopped) return 'stopped';
  if (step.ok) return 'ok';
  return step.outcome ? 'declined' : 'error';
}
// A subagent's teammate: a small head printed like the companion, in the subagent's state.
// `settled`: drawn again in a state it already had, so no entrance motion.
function teammate(agent, settled = true) {
  const holder = element('span', 'reply-agent-mate');
  holder.setAttribute('aria-hidden', 'true');
  holder.append(renderMascot(mascotSpec({ state: companionStateFor(agent), variant: 'teammate', settled })));
  return holder;
}
// "Done · explore · 3.5k in · 109 out · $0.00072"
function agentMeta(agent) {
  return [AGENT_STATUS_TEXT[agent.status] || '', AGENT_KINDS.includes(agent.kind) ? agent.kind : '', metricsLabel(agent.metrics)]
    .filter(Boolean).join(' · ');
}
/** What a subagent did so far, in order: what it said as notes, its tool calls as steps. */
function agentItems(agent) {
  const list = element('div', 'reply-agent-items');
  for (const item of agent.items) {
    if (item.type !== 'text') {
      list.append(liveStepNode(item));
    } else if (item.text.trim()) {
      const note = element('div', 'reply-note md');
      note.append(renderMarkdown(item.text));
      list.append(note);
    }
  }
  if (!list.childElementCount && (agent.status === 'queued' || agent.status === 'running')) {
    list.append(element('div', 'reply-agent-empty', agent.status === 'queued' ? 'Waiting for a free slot…' : 'Starting…'));
  }
  if (agent.error && (agent.status === 'failed' || agent.status === 'stopped')) list.append(element('div', 'reply-step-error', agent.error));
  return list;
}
/**
 * A subagent at work: a group titled with its call, open unless the user folded it, with its
 * status and its own steps under it.
 */
function liveAgentNode(step) {
  const node = element('div', 'reply-step reply-agent');
  node.dataset.state = step.state;
  const group = element('details', 'reply-agent-group');
  group.open = step.agentOpen !== false;
  group.addEventListener('toggle', () => { step.agentOpen = group.open; });
  const summary = element('summary', 'reply-agent-summary');
  summary.append(teammate(step.agent), stepRow(step), element('span', 'reply-agent-meta', agentMeta(step.agent)));
  group.append(summary, agentItems(step.agent));
  node.append(group);
  return node;
}
/** A step of a reply in progress: its title with a spinner, then its output as it arrives. */
function liveStepNode(step) {
  if (step.agent) return liveAgentNode(step);
  const node = element('div', 'reply-step');
  node.dataset.state = step.state;
  node.append(stepRow(step));
  if (step.output) node.append(outputNode(step.output));
  return node;
}
function itemNode(view, item) {
  const node = item.type === 'text' ? textNode(item) : liveStepNode(item);
  view.nodes.set(item, node);
  return node;
}

const TODO_MARKS = { completed: 'Done', in_progress: 'Now', pending: 'To do' };
/**
 * The model's to-do list (todo_write) as a checklist: done items struck through, the current one
 * marked. Used live and under finished replies.
 */
export function renderTodoList(todos) {
  const items = normalizeTodos(todos);
  const done = items.filter((item) => item.status === 'completed').length;
  const box = element('section', 'reply-todos');
  box.setAttribute('aria-label', `To-do list, ${done} of ${items.length} done`);
  box.append(element('div', 'reply-todos-head', `To-do · ${done}/${items.length} done`));
  const list = element('ol', 'reply-todos-list');
  for (const item of items) {
    const row = element('li', `reply-todo is-${item.status.replace('_', '-')}`);
    row.append(element('span', 'reply-todo-mark', TODO_MARKS[item.status]), element('span', 'reply-todo-text', item.content));
    list.append(row);
  }
  box.append(list);
  return box;
}

/** The bubble of a reply in progress; patchReply keeps it current. */
export function renderLiveReply(reply) {
  // The bubble it replaces never draws again.
  if (reply.view?.frame) window.cancelAnimationFrame(reply.view.frame);
  if (reply.view?.agentFrame) window.cancelAnimationFrame(reply.view.agentFrame);
  const bubble = element('div', 'chat-bubble assistant live-reply');
  bubble.dataset.requestId = reply.requestId;
  // `agents`: subagent groups to redraw in the next frame (agentFrame).
  const view = { bubble, nodes: new Map(), pending: new Set(), frame: 0, agents: new Set(), agentFrame: 0 };
  if (reply.kind === 'chat') {
    view.reasoning = element('details', 'msg-reasoning live-reasoning');
    view.reasoning.append(element('summary', 'msg-reasoning-label', 'Thinking'));
    view.reasoningText = element('div', 'msg-reasoning-text', replyReasoning(reply));
    view.reasoning.append(view.reasoningText);
    view.reasoning.hidden = !replyReasoning(reply);
    view.items = element('div', 'live-items');
    view.items.setAttribute('aria-busy', 'true');
    for (const item of reply.items) view.items.append(itemNode(view, item));
    view.todos = element('div', 'live-todos');
    if (reply.todos?.length) view.todos.append(renderTodoList(reply.todos));
    bubble.append(view.todos, view.reasoning, view.items);
  }
  const status = element('div', 'pending-reply-row live-status');
  status.setAttribute('role', 'status');
  const dots = element('span', 'thinking-dots');
  dots.setAttribute('aria-hidden', 'true');
  dots.append(element('span', 'thinking-dot'), element('span', 'thinking-dot'), element('span', 'thinking-dot'));
  view.status = element('span', 'pending-reply-text', statusText(reply));
  view.time = element('span', 'pending-reply-time', elapsedText(Date.now() - reply.startedAt));
  status.append(dots, view.status, view.time);
  // The companion beside the status line, with "working · 1m 12s" under the status. With the
  // companion off (body.companion-off, mascot.css) the status line shows its dots and time again.
  view.mood = companionStateFor(reply);
  view.mascot = renderMascot(mascotSpec({ state: view.mood, variant: 'companion', settled: true }));
  const figure = element('span', 'reply-companion-figure');
  figure.setAttribute('aria-hidden', 'true');
  figure.append(view.mascot);
  view.caption = element('span', 'reply-companion-caption', mascotCaption(view.mood, elapsedText(Date.now() - reply.startedAt)));
  const body = element('div', 'reply-companion-body');
  body.append(status, view.caption);
  view.companion = element('div', 'reply-companion');
  view.companion.dataset.state = view.mood;
  view.companion.append(figure, body);
  bubble.append(view.companion);
  reply.view = view;
  return bubble;
}

// The companion follows the reply: its state when that changed, and the time in its caption.
function updateCompanion(reply, now = Date.now()) {
  const view = reply.view;
  if (!view?.mascot) return;
  const mood = companionStateFor(reply);
  if (mood !== view.mood) {
    setMascotState(view.mascot, mood);
    view.mood = mood;
    view.companion.dataset.state = mood;
  }
  view.caption.textContent = mascotCaption(mood, elapsedText(now - reply.startedAt));
}

/**
 * The companion under a finished reply (src/app.js puts it under the newest one): `state` is how
 * it looks ('done' or 'error' for a moment after the reply ended, then 'idle'), `outcome` and
 * `caption` say how the reply ended ("done · 1m 12s").
 */
export function renderReplyCompanion({ state = 'idle', outcome = 'done', caption = '', settled = true } = {}) {
  const row = element('div', 'reply-companion is-finished');
  row.dataset.state = state;
  row.dataset.outcome = outcome;
  const figure = element('span', 'reply-companion-figure');
  figure.setAttribute('aria-hidden', 'true');
  figure.append(renderMascot(mascotSpec({ state, variant: 'companion', settled })));
  row.append(figure);
  if (caption) row.append(element('span', 'reply-companion-caption', caption));
  return row;
}

function nearBottom(container) {
  return !container || container.scrollHeight - container.scrollTop - container.clientHeight < FOLLOW_PX;
}
function follow(container, stick) {
  if (container && stick) container.scrollTop = container.scrollHeight;
}
// Markdown of the blocks that changed, redrawn once per frame, in the bubble that asked for it.
function drawPending(view, container) {
  view.frame = 0;
  if (!view.bubble.isConnected) return;
  const stick = nearBottom(container);
  for (const item of view.pending) {
    const node = view.nodes.get(item);
    if (node) node.replaceChildren(renderMarkdown(item.text));
  }
  view.pending.clear();
  follow(container, stick);
}

// Subagent groups that changed, redrawn once per frame: their status line and their steps.
function drawAgents(view, container) {
  view.agentFrame = 0;
  if (!view.bubble.isConnected) return;
  const stick = nearBottom(container);
  for (const step of view.agents) {
    const node = view.nodes.get(step);
    if (!node || !step.agent) continue;
    const meta = node.querySelector('.reply-agent-meta');
    if (meta) meta.textContent = agentMeta(step.agent);
    const mate = node.querySelector('.reply-agent-mate .mascot');
    if (mate) setMascotState(mate, companionStateFor(step.agent));
    node.querySelector('.reply-agent-items')?.replaceWith(agentItems(step.agent));
  }
  view.agents.clear();
  follow(container, stick);
}

/**
 * Brings the live bubble up to date after applyProgress. Returns false when the bubble is not on
 * screen (the caller renders the chat again, or not at all for a task in the background).
 */
export function patchReply(reply, change, container) {
  const view = reply?.view;
  if (!view || !view.bubble.isConnected || !change) return false;
  const stick = nearBottom(container);
  if (change.kind === 'todos' && view.todos) {
    view.todos.replaceChildren(...(reply.todos?.length ? [renderTodoList(reply.todos)] : []));
  } else if (change.kind === 'reasoning' && view.reasoning) {
    const text = replyReasoning(reply);
    view.reasoningText.textContent = text;
    view.reasoning.hidden = !text;
  } else if ((change.kind === 'text' || change.kind === 'step') && change.added && view.items) {
    view.items.append(itemNode(view, change.item));
  } else if (change.kind === 'text') {
    view.pending.add(change.item);
    if (!view.frame) view.frame = window.requestAnimationFrame(() => drawPending(view, container));
  } else if (change.kind === 'step') {
    const node = view.nodes.get(change.item);
    if (node) {
      node.dataset.state = change.item.state;
      node.querySelector('.reply-step-row')?.replaceWith(stepRow(change.item));
    }
  } else if (change.kind === 'agent') {
    // The step became a subagent's group: drawn as one now; after that its insides once per frame.
    const node = view.nodes.get(change.item);
    if (node && !node.classList.contains('reply-agent')) {
      const group = liveAgentNode(change.item);
      view.nodes.set(change.item, group);
      node.replaceWith(group);
    } else if (node) {
      view.agents.add(change.item);
      if (!view.agentFrame) view.agentFrame = window.requestAnimationFrame(() => drawAgents(view, container));
    }
  } else if (change.kind === 'output') {
    const node = view.nodes.get(change.item);
    if (node) {
      let pre = node.querySelector('.reply-step-output');
      if (!pre) {
        pre = outputNode('');
        node.append(pre);
      }
      const following = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
      pre.textContent = shownOutput(change.item.output);
      if (following) pre.scrollTop = pre.scrollHeight;
    }
  }
  view.status.textContent = statusText(reply);
  updateCompanion(reply);
  follow(container, stick);
  return true;
}

/** Updates the elapsed time (and status) of a reply on screen; called once a second. */
export function tickReply(reply) {
  const view = reply?.view;
  if (!view || !view.bubble.isConnected) return;
  const now = Date.now();
  view.time.textContent = elapsedText(now - reply.startedAt);
  view.status.textContent = statusText(reply);
  updateCompanion(reply, now);
  // The clocks of the steps that are running, the subagents' own included.
  for (const node of view.bubble.querySelectorAll('.reply-step-time.is-running')) {
    const started = Number(node.dataset.startedAt);
    if (Number.isFinite(started)) node.textContent = elapsedText(now - started);
  }
}

// Why a call was not run (denied, Plan, a hook), as fields to spread into a kept step.
function outcomeFields(item) {
  if (item.state !== 'declined' || !item.outcome) return {};
  return { outcome: item.outcome, ...(item.hook ? { hook: item.hook } : {}) };
}
// The running time a stopped step keeps, as a field to spread into it.
function durationField(item, now) {
  const duration = stepDuration(item, now);
  return duration === null ? {} : { durationMs: duration };
}

// A subagent of a stopped reply, as kept with its step: one still at work was stopped with it.
function stoppedAgent(agent, now) {
  const steps = agent.items.map((item) => (item.type === 'text'
    ? { type: 'note', text: item.text }
    : {
      type: 'tool', title: item.title, ok: item.state === 'ok', server: item.server, tool: item.tool,
      ...(item.state === 'running' || item.state === 'approval' ? { stopped: true } : {}),
      ...outcomeFields(item),
      ...durationField(item, now),
    }));
  const status = agent.status === 'queued' || agent.status === 'running' ? 'stopped' : agent.status;
  return { kind: agent.kind, status, steps, ...(agent.metrics ? { metrics: agent.metrics } : {}), ...(agent.rounds ? { rounds: agent.rounds } : {}) };
}

/**
 * What a stopped reply leaves behind: the text written so far as the answer, the rest as steps
 * (a call that was still running is marked stopped). Null when nothing was written or done.
 */
export function partialReply(reply, now = Date.now()) {
  if (!reply || reply.kind !== 'chat') return null;
  const items = reply.items;
  const last = items[items.length - 1];
  // A retry that started the round again keeps what was written before it (applyProgress).
  const text = last?.type === 'text' ? (last.text.trim() || String(last.kept || '').trim()) : '';
  const earlier = last?.type === 'text' ? items.slice(0, -1) : items;
  const steps = normalizeSteps(earlier.map((item) => (item.type === 'text'
    ? { type: 'note', text: item.text }
    : {
      type: 'tool', title: item.title, ok: item.state === 'ok', server: item.server, tool: item.tool, output: item.output,
      ...(item.state === 'running' || item.state === 'approval' ? { stopped: true } : {}),
      ...outcomeFields(item),
      ...durationField(item, now),
      ...(item.agent ? { agent: stoppedAgent(item.agent, now) } : {}),
    })));
  const reasoning = [reply.reasoningDone, reply.reasoningRound || reply.reasoningKept || ''].filter(Boolean).join('\n\n');
  const changes = reply.changes || null;
  const todos = normalizeTodos(reply.todos);
  if (!text && !steps.length && !reasoning && !changes && !todos.length) return null;
  return { text, steps, reasoning, changes, todos };
}

const sameTitle = (a, b) => typeof a === 'string' && typeof b === 'string'
  && a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/**
 * Main's steps of a finished reply (they carry no times) with the running time the window measured
 * for each call. Main's steps and the live ones are in the same order, but main also lists calls
 * that never started (skipped, refused before running), so each of main's calls takes the next live
 * step with the same title. A subagent's own steps are matched the same way.
 */
export function timedSteps(steps, reply, now = Date.now()) {
  if (!Array.isArray(steps) || !reply || !Array.isArray(reply.items)) return steps;
  const live = reply.items.filter((item) => item && item.type === 'tool');
  let next = 0;
  return steps.map((step) => {
    if (!step || typeof step !== 'object' || step.type !== 'tool') return step;
    let index = next;
    while (index < live.length && !sameTitle(live[index].title, step.title)) index += 1;
    if (index >= live.length) return step;
    next = index + 1;
    const item = live[index];
    const timed = { ...step, ...durationField(item, now) };
    if (item.agent && step.agent && typeof step.agent === 'object' && Array.isArray(step.agent.steps)) {
      timed.agent = { ...step.agent, steps: timedSteps(step.agent.steps, item.agent, now) };
    }
    return timed;
  });
}

/**
 * A finished subagent's step: folded, with how it ended and what it used, and its own steps drawn
 * like the reply's (they never hold another subagent: normalizeSteps drops those).
 */
function finishedAgentNode(step) {
  const agent = step.agent;
  const state = agent.status === 'stopped' ? 'stopped' : finishedState(step);
  const node = element('details', 'reply-step reply-agent');
  node.dataset.state = state;
  const head = element('summary', 'reply-step-summary');
  head.append(teammate({ status: state === 'stopped' ? 'stopped' : agent.status }), stepRow({ ...step, state }),
    element('span', 'reply-agent-meta', agentMeta(agent)));
  const list = renderMessageSteps(agent.steps).querySelector('.msg-steps-list') || element('div', 'msg-steps-list');
  list.classList.add('reply-agent-items');
  if (state === 'error' && step.preview) list.append(element('div', 'reply-step-error', step.preview));
  node.append(head, list);
  return node;
}

/** A finished reply's steps, folded above its answer ("4 steps · Read 3 files · Ran a command"). */
export function renderMessageSteps(value) {
  const steps = normalizeSteps(value);
  const details = element('details', 'msg-steps');
  const summary = element('summary', 'msg-steps-summary', stepSummary(steps));
  // Calls nobody let run (denied, Plan, a hook) are not failures.
  const failed = steps.filter((step) => step.type === 'tool' && finishedState(step) === 'error').length;
  if (failed) summary.append(element('span', 'msg-steps-failed', ` · ${failed} failed`));
  const list = element('div', 'msg-steps-list');
  for (const step of steps) {
    if (step.type === 'note') {
      const note = element('div', 'reply-note md');
      note.append(renderMarkdown(step.text));
      list.append(note);
      continue;
    }
    if (step.agent) {
      list.append(finishedAgentNode(step));
      continue;
    }
    const state = finishedState(step);
    const node = element(step.output ? 'details' : 'div', 'reply-step');
    node.dataset.state = state;
    const row = stepRow({ ...step, state });
    if (step.output) {
      const head = element('summary', 'reply-step-summary');
      head.append(row);
      node.append(head, outputNode(step.output));
    } else {
      node.append(row);
      // A failed call says why; a hook that blocked one says what it said, without alarm.
      if (state === 'error' && step.preview) node.append(element('div', 'reply-step-error', step.preview));
      else if (step.outcome === 'blocked' && step.preview) node.append(element('div', 'reply-step-why-detail', step.preview));
    }
    list.append(node);
  }
  details.append(summary, list);
  return details;
}
