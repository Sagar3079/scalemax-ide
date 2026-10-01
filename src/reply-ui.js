/**
 * Replies in progress, one per task. Several tasks can work at the same time: main gives every
 * request a folder session of its own (main.js openChatSession). A reply streams in from main
 * (lib/progress.cjs): the text and thinking as the model writes them, every tool call as a step,
 * and a command's output while it runs. The live bubble is built once and then patched, and the
 * Markdown of the text being written is redrawn at most once per frame.
 * Finished replies keep their steps, folded above the answer (renderMessageSteps).
 */
import { renderMarkdown } from './markdown.js';
import { toolActivity, normalizeSteps, stepSummary, normalizeChanges, normalizeTodos } from './domain.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
// A running command's output kept on screen (the end of it).
const MAX_LIVE_OUTPUT = 16 * 1024;
const MAX_LIVE_TEXT = 1024 * 1024;
// Closer than this to the bottom, the transcript follows the reply as it grows.
const FOLLOW_PX = 48;
const STATE_TEXT = { running: 'running', approval: 'waiting for approval', ok: 'done', error: 'failed', stopped: 'stopped' };
const ICON_PATHS = { ok: 'm5 12.5 4.5 4.5L19 7.5', error: 'M7 7l10 10M17 7 7 17', stopped: 'M8 8h8v8H8z' };

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tag === 'button') node.type = 'button';
  return node;
}
function elapsedText(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
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

/**
 * Applies one progress event from main to the reply. Returns what changed, for patchReply:
 * { kind: 'status' | 'text' | 'reasoning' | 'step' | 'output', item?, added? }, or null.
 */
export function applyProgress(reply, event) {
  if (!reply || !event || typeof event !== 'object') return null;
  switch (event.phase) {
    case 'thinking':
      // A new model round: its text is a new block, its thinking follows the earlier thinking.
      reply.phase = 'thinking';
      reply.activity = null;
      reply.current = null;
      reply.reasoningDone = replyReasoning(reply);
      reply.reasoningRound = '';
      return { kind: 'status' };
    case 'delta':
    case 'text-set': {
      if (typeof event.text !== 'string') return null;
      const replace = event.phase === 'text-set';
      if (event.kind === 'reasoning') {
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
      step.state = event.ok === true ? 'ok' : 'error';
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
      // The provider failed part way and the round is asked again (its text was reset already).
      reply.phase = 'retrying';
      reply.activity = null;
      return { kind: 'status' };
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
  const activity = reply.activity;
  switch (reply.phase) {
    case 'approval':
      if (!activity) return 'Waiting for your approval…';
      return activity.friendly ? `Waiting for your approval: ${activity.text.toLowerCase()}` : `Waiting for your approval · ${activity.text}`;
    case 'tool':
      if (!activity) return 'Working…';
      return activity.friendly ? `${activity.text}…` : `Running ${activity.text}…`;
    case 'preparing':
      return activity?.friendly ? `${activity.text}…` : 'Preparing a tool call…';
    case 'writing':
      return 'Writing…';
    case 'working':
      return 'Working…';
    case 'retrying':
      return 'The provider did not answer in full; trying again…';
    default:
      if (reply.thinking) return 'Thinking…';
      return reply.items.length ? 'Working…' : 'Writing…';
  }
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
function stepRow(step) {
  const row = element('div', 'reply-step-row');
  row.append(stepIcon(step.state), element('span', 'reply-step-title', step.title),
    element('span', 'sr-only', `, ${STATE_TEXT[step.state] || ''}`));
  return row;
}
/** A step of a reply in progress: its title with a spinner, then its output as it arrives. */
function liveStepNode(step) {
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
  const bubble = element('div', 'chat-bubble assistant live-reply');
  bubble.dataset.requestId = reply.requestId;
  const view = { bubble, nodes: new Map(), pending: new Set(), frame: 0 };
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
  bubble.append(status);
  reply.view = view;
  return bubble;
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
  follow(container, stick);
  return true;
}

/** Updates the elapsed time (and status) of a reply on screen; called once a second. */
export function tickReply(reply) {
  const view = reply?.view;
  if (!view || !view.bubble.isConnected) return;
  view.time.textContent = elapsedText(Date.now() - reply.startedAt);
  view.status.textContent = statusText(reply);
}

/**
 * What a stopped reply leaves behind: the text written so far as the answer, the rest as steps
 * (a call that was still running is marked stopped). Null when nothing was written or done.
 */
export function partialReply(reply) {
  if (!reply || reply.kind !== 'chat') return null;
  const items = reply.items;
  const last = items[items.length - 1];
  const text = last?.type === 'text' ? last.text.trim() : '';
  const earlier = last?.type === 'text' ? items.slice(0, -1) : items;
  const steps = normalizeSteps(earlier.map((item) => (item.type === 'text'
    ? { type: 'note', text: item.text }
    : {
      type: 'tool', title: item.title, ok: item.state === 'ok', server: item.server, tool: item.tool, output: item.output,
      ...(item.state === 'running' || item.state === 'approval' ? { stopped: true } : {}),
    })));
  const reasoning = replyReasoning(reply);
  const changes = reply.changes || null;
  const todos = normalizeTodos(reply.todos);
  if (!text && !steps.length && !reasoning && !changes && !todos.length) return null;
  return { text, steps, reasoning, changes, todos };
}

/** A finished reply's steps, folded above its answer ("4 steps · Read 3 files · Ran a command"). */
export function renderMessageSteps(value) {
  const steps = normalizeSteps(value);
  const details = element('details', 'msg-steps');
  const summary = element('summary', 'msg-steps-summary', stepSummary(steps));
  const failed = steps.filter((step) => step.type === 'tool' && !step.ok && !step.stopped).length;
  if (failed) summary.append(element('span', 'msg-steps-failed', ` · ${failed} failed`));
  const list = element('div', 'msg-steps-list');
  for (const step of steps) {
    if (step.type === 'note') {
      const note = element('div', 'reply-note md');
      note.append(renderMarkdown(step.text));
      list.append(note);
      continue;
    }
    const state = step.stopped ? 'stopped' : step.ok ? 'ok' : 'error';
    const node = element(step.output ? 'details' : 'div', 'reply-step');
    node.dataset.state = state;
    const row = stepRow({ ...step, state });
    if (step.output) {
      const head = element('summary', 'reply-step-summary');
      head.append(row);
      node.append(head, outputNode(step.output));
    } else {
      node.append(row);
      // A failed call says why.
      if (!step.ok && step.preview) node.append(element('div', 'reply-step-error', step.preview));
    }
    list.append(node);
  }
  details.append(summary, list);
  return details;
}
