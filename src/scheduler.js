/**
 * ScaleMax IDE: the window's side of automations. The main process fires them
 * (lib/automations.cjs), also while no window is open; this window edits them (src/app.js),
 * asks for Run now, sends the instructions runs use, and takes in what main tells it after every
 * run: the automations' status and history, and the run's messages for its task.
 */
import {
  isRecord, normalizeAutomations, buildSystemPrompt, requestTemperature, requestReasoning,
  normalizeSteps, normalizeChanges, normalizeMetrics, normalizeTaskFolder,
} from './domain.mjs';

const RUN_MARKER = /^[A-Za-z0-9._:-]{1,160}$/;
const MAX_TEXT = 100000;

let started = null;

function bridge() {
  return globalThis.window?.scalemaxAPI?.automations || null;
}

/**
 * What runs are sent with: the system prompt for each mode (built here, where the expert, skill
 * and custom catalogs are), the temperature and the reasoning setting, the same as chat uses.
 */
export function automationContext(app) {
  const settings = app.settings;
  const prompt = (mode) => (typeof app.buildSystemPrompt === 'function'
    ? app.buildSystemPrompt({ ...settings, mode })
    : buildSystemPrompt({ ...settings, mode }));
  const context = { systemPrompts: { working: prompt('working'), coding: prompt('coding') }, reasoning: requestReasoning(settings) };
  const temperature = requestTemperature(settings);
  if (temperature !== undefined) context.temperature = temperature;
  return context;
}

/**
 * Main's automations taken into the window's list: a record main has is replaced by main's copy
 * unless the window changed it since (a newer `editedAt`, its save still on the way); one only
 * the window has was just made here, and one only main has was just deleted here.
 */
export function mergeAutomations(own, incoming) {
  const fresh = new Map(normalizeAutomations(incoming).map((record) => [record.id, record]));
  return (Array.isArray(own) ? own : []).map((record) => {
    const main = fresh.get(record.id);
    if (!main) return record;
    return (main.editedAt || 0) >= (record.editedAt || 0) ? main : record;
  });
}

// ---- What the Automation view shows (src/app.js renderAutomations and the form) --------------

/** The permission an automation's runs work under, as the row and the form name it. */
export const AUTOMATION_PERMISSION_LABELS = Object.freeze({ plan: 'Plan', manual: 'Manual', basic: 'Basic', bypass: 'Bypass all' });

const PERMISSION_HINTS = Object.freeze({
  plan: 'Plan: the run can only read. Nothing in the folder is changed.',
  manual: 'Manual: every tool call asks in the ScaleMax window first. While no window is open, those calls are denied and the run says so.',
  basic: 'Basic: reading runs on its own; edits, commands and other changes ask in the ScaleMax window first. While no window is open, they are denied and the run says so.',
  bypass: 'Bypass all permissions: every tool call runs without asking, also while no window is open.',
});

/** The line under the form's Permission field: what the chosen permission means for a run. */
export function automationPermissionHint(permission) {
  return PERMISSION_HINTS[permission] || PERMISSION_HINTS.basic;
}

/** How a run went, as the row and its history say it ('denied' runs need approval). */
export function automationStatusLabel(status) {
  return status === 'denied' ? 'Needs approval' : (typeof status === 'string' && status ? status : 'idle');
}

/** One line of Run history: "<time> · success — <preview>", "<time> · needs approval (<note>) — …". */
export function automationHistoryLine(entry, formatTime = (time) => new Date(time).toLocaleString()) {
  const status = entry?.status === 'denied' ? `needs approval${entry.note ? ` (${entry.note})` : ''}` : entry?.status;
  return `${formatTime(entry?.time)} · ${status}${entry?.preview ? ` — ${entry.preview}` : ''}`;
}

/**
 * The folders the form offers, each once ({ name, path }): the current task's folder first, then
 * the recent folders main remembers, then folders other automations work in.
 */
export function automationFolderChoices({ current = null, recent = [], automations = [] } = {}) {
  const seen = new Set();
  const choices = [];
  const add = (folder) => {
    if (!isRecord(folder) || typeof folder.path !== 'string' || !folder.path || seen.has(folder.path)) return;
    seen.add(folder.path);
    const name = typeof folder.name === 'string' && folder.name ? folder.name : folder.path.split('/').filter(Boolean).pop() || folder.path;
    choices.push({ name, path: folder.path });
  };
  add(current);
  for (const folder of Array.isArray(recent) ? recent : []) add(folder);
  for (const automation of Array.isArray(automations) ? automations : []) add(automation?.folder);
  return choices;
}

function toolSummaries(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => isRecord(item) && typeof item.tool === 'string').slice(0, 32).map((item) => ({
    server: typeof item.server === 'string' ? item.server.slice(0, 64) : '',
    tool: item.tool.slice(0, 128),
    ok: item.ok === true,
  }));
}

// One message of a run as the window keeps it (the same checks src/app.js loadState makes).
function runMessage(value) {
  if (!isRecord(value) || !['user', 'assistant'].includes(value.role) || typeof value.text !== 'string'
    || typeof value.run !== 'string' || !RUN_MARKER.test(value.run)) return null;
  const message = { role: value.role, text: value.text.slice(0, MAX_TEXT), time: Number.isFinite(value.time) ? value.time : Date.now(), run: value.run };
  if (value.role !== 'assistant') return message;
  const tools = toolSummaries(value.tools);
  if (tools.length) message.tools = tools;
  const steps = normalizeSteps(value.steps);
  if (steps.length) message.steps = steps;
  const changes = normalizeChanges(value.changes);
  if (changes) message.changes = changes;
  const metrics = normalizeMetrics(value.metrics);
  if (metrics) message.metrics = metrics;
  return message;
}

/**
 * Adds the messages of a run main appended to its task (`run`: { task, messages }) to the
 * window's tasks, creating the task when the window does not have it. A message the window
 * already has (same run, same role) is never added twice. Returns the task, or null.
 */
export function mergeRun(tasks, run) {
  const shell = isRecord(run) && isRecord(run.task) ? run.task : null;
  if (!Array.isArray(tasks) || !shell || typeof shell.id !== 'string' || typeof shell.title !== 'string') return null;
  const messages = (Array.isArray(run.messages) ? run.messages : []).map(runMessage).filter(Boolean);
  let task = tasks.find((item) => item.id === shell.id);
  if (!task) {
    task = { id: shell.id, title: shell.title, messages: [], createdAt: Number.isFinite(shell.createdAt) ? shell.createdAt : Date.now(), updatedAt: Date.now() };
    tasks.unshift(task);
  }
  for (const message of messages) {
    if (task.messages.some((item) => item.run === message.run && item.role === message.role)) continue;
    task.messages.push(message);
  }
  task.title = shell.title;
  if (typeof shell.automationId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(shell.automationId)) task.automationId = shell.automationId;
  const folder = normalizeTaskFolder(shell.folder);
  if (folder && !task.folder) task.folder = folder;
  task.updatedAt = Math.max(Number.isFinite(task.updatedAt) ? task.updatedAt : 0, Number.isFinite(shell.updatedAt) ? shell.updatedAt : 0);
  return task;
}

function updateStatus(app, state) {
  if (typeof document === 'undefined') return;
  const node = document.querySelector('#scheduler-status');
  if (!node) return;
  if (!app.provider?.configured) {
    node.textContent = 'Connect a provider in Assistant to run schedules.';
    return;
  }
  const automations = Array.isArray(app.automations) ? app.automations : [];
  const running = automations.filter((automation) => state.running.has(automation.id));
  const next = automations
    .filter((automation) => automation.active && Number.isFinite(automation.nextRun))
    .reduce((soonest, automation) => (!soonest || automation.nextRun < soonest.nextRun ? automation : soonest), null);
  const parts = [];
  if (running.length) parts.push(`Running: ${running.map((automation) => automation.name).join(', ')}…`);
  parts.push(next ? `Next run: ${next.name} at ${new Date(next.nextRun).toLocaleString()}` : 'No schedules enabled.');
  // Preferences > Automations off: nothing fires while the window is closed.
  if (next && app.settings?.automationsInBackground === false) parts.push('Runs only while ScaleMax has a window open.');
  node.textContent = parts.join(' · ');
}

// Preferences > Automations: whether main fires automations while no window is open.
function renderBackgroundToggle(app) {
  if (typeof document === 'undefined') return;
  document.querySelector('#automations-background-toggle')
    ?.setAttribute('aria-checked', String(app.settings?.automationsInBackground !== false));
}

export function startScheduler(app) {
  if (started) return started;
  const api = bridge();
  const state = { running: new Set(), pushed: '' };
  const sync = () => {
    if (typeof app.renderAutomations === 'function') app.renderAutomations();
    updateStatus(app, state);
  };

  // Main gets the instructions again only when they changed (a setting, an expert, a skill).
  function pushContext() {
    if (!api?.setContext) return;
    let context;
    try {
      context = automationContext(app);
    } catch (error) {
      console.warn('[scheduler] The instructions for automations could not be built:', error);
      return;
    }
    const text = JSON.stringify(context);
    if (text === state.pushed) return;
    state.pushed = text;
    void Promise.resolve(api.setContext(context)).then((result) => {
      if (result?.ok === false && state.pushed === text) state.pushed = '';
    }, () => {
      if (state.pushed === text) state.pushed = '';
    });
  }

  // What main says after every change: the automations as it stored them, which run now, and
  // after a run how it went and the messages it added to its task.
  function applyChange(change) {
    if (!isRecord(change)) return;
    if (Array.isArray(change.automations)) app.automations = mergeAutomations(app.automations, change.automations);
    if (Array.isArray(change.running)) state.running = new Set(change.running.filter((id) => typeof id === 'string'));
    if (isRecord(change.run)) {
      const task = mergeRun(app.tasks, change.run);
      if (task) {
        void app.persist('tasks');
        if (typeof app.renderTasks === 'function') app.renderTasks();
        if (app.currentTaskId === task.id) app.renderChat?.();
        else app.unreadTasks?.add?.(task.id);
      }
    }
    const finished = isRecord(change.finished) ? change.finished : null;
    if (finished?.status === 'success') app.showToast(`Automation finished: ${finished.name}`);
    else if (finished?.status === 'denied') {
      app.showToast(`Automation needs approval: ${finished.name}${typeof finished.note === 'string' && finished.note ? ` — ${finished.note}` : ''}`);
    // CANCELLED: the window deleted it while it ran, and said so itself.
    } else if (finished?.status === 'error' && finished.code !== 'PROVIDER_NOT_CONFIGURED' && finished.code !== 'CANCELLED') {
      app.showToast(`Automation failed: ${finished.name} — ${finished.message || 'Provider request failed'}`);
    }
    sync();
  }

  const unsubscribe = api?.onChanged ? api.onChanged(applyChange) : () => {};
  const doc = typeof document === 'undefined' ? null : document;
  const onToggle = async () => {
    app.settings.automationsInBackground = app.settings.automationsInBackground === false;
    renderBackgroundToggle(app);
    updateStatus(app, state);
    await app.persist('settings');
  };
  doc?.querySelector('#automations-background-toggle')?.addEventListener('click', onToggle);
  renderBackgroundToggle(app);
  pushContext();
  // What happened before this window listened: runs in progress, and runs saved after it read
  // the state file (each is taken in once, like an announced run, without a toast).
  const ready = api?.state
    ? Promise.resolve(api.state()).then((result) => {
      if (!result?.ok || !isRecord(result.data)) return;
      const { running, automations, runs } = result.data;
      applyChange({ running: Array.isArray(running) ? running : [], ...(Array.isArray(automations) ? { automations } : {}) });
      for (const run of Array.isArray(runs) ? runs : []) applyChange({ run });
    }).catch(() => {}).finally(sync)
    : Promise.resolve(sync());

  started = {
    applyChange,
    pushContext,
    async runNow(automationId) {
      if (!api?.runNow) {
        app.showToast('Automations need the desktop app');
        return 'error';
      }
      // A schedule made or edited a moment ago reaches main first: its save is queued before this.
      await app.saveQueue;
      const result = await api.runNow({ id: automationId });
      if (!result?.ok) {
        app.showToast(result?.error?.message || 'The automation could not be run');
        return 'error';
      }
      if (result.data?.code === 'PROVIDER_NOT_CONFIGURED') app.showToast('Connect a provider in Assistant first');
      return result.data?.status || 'error';
    },
    // Resolves once the window knows which runs are in progress (used by tests).
    ready,
    /**
     * Redraws the status line ("Next run: …", the provider hint) after the window changed
     * something itself: a pause, resume, edit or delete, or a provider connected in Assistant.
     * It never redraws the list (src/app.js renderAutomations calls this).
     */
    refreshStatus() {
      updateStatus(app, state);
    },
    /** True while a run of this automation is in progress (main said so). */
    isRunning(automationId) {
      return state.running.has(automationId);
    },
    stop() {
      unsubscribe?.();
      doc?.querySelector('#automations-background-toggle')?.removeEventListener('click', onToggle);
      started = null;
    },
  };
  return started;
}
