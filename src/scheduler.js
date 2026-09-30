/** ScaleMax IDE: runs enabled automations while this window is open. */
import { nextRunAt, buildSystemPrompt, requestTemperature, requestReasoning } from './domain.mjs';

const POLL_MS = 30000;
const MAX_HISTORY = 10;
const PREVIEW_CHARS = 200;

let started = null;

// Runs in flight, tracked outside the automation record so a concurrent check
// can never start the same schedule twice and a marker never reaches the
// persisted state file.
const inFlight = new WeakSet();

// A one-shot schedule is exhausted once it fires; every other schedule rolls
// forward to its next occurrence.
function advance(automation, afterMs) {
  if (automation.schedule === 'once') {
    automation.active = false;
    automation.nextRun = null;
    return;
  }
  try {
    automation.nextRun = nextRunAt(automation, afterMs);
  } catch (error) {
    // A schedule that cannot produce a future occurrence is paused, not retried forever.
    automation.active = false;
    automation.lastError = error instanceof Error ? error.message : 'No future occurrence is representable as a Date.';
  }
}

function record(automation, status, preview) {
  automation.history = Array.isArray(automation.history) ? automation.history : [];
  automation.history.unshift({
    time: Date.now(),
    status,
    preview: String(preview || '').slice(0, PREVIEW_CHARS),
  });
  automation.history = automation.history.slice(0, MAX_HISTORY);
}

function updateStatus(app) {
  if (typeof document === 'undefined') return;
  const node = document.querySelector('#scheduler-status');
  if (!node) return;
  const bridge = app.getProviderBridge?.();
  if (!app.provider?.configured || !bridge?.send) {
    node.textContent = 'Connect a provider in Assistant to run schedules.';
    return;
  }
  const next = (Array.isArray(app.automations) ? app.automations : [])
    .filter((automation) => automation.active && Number.isFinite(automation.nextRun))
    .reduce((soonest, automation) => (!soonest || automation.nextRun < soonest.nextRun ? automation : soonest), null);
  node.textContent = next
    ? `Next run: ${next.name} at ${new Date(next.nextRun).toLocaleString()}`
    : 'No schedules enabled.';
}

function syncAutomationViews(app) {
  if (typeof app.renderAutomations === 'function') app.renderAutomations();
  updateStatus(app);
}

function fail(app, automation, message) {
  automation.lastStatus = 'error';
  automation.lastError = message;
  automation.lastRun = Date.now();
  record(automation, 'error', message);
  void app.persist('automations');
  syncAutomationViews(app);
  app.showToast(`Automation failed: ${automation.name} — ${message}`);
}

// The automation's own task, found by its id (a title is shared by automations with the same
// name, and by any chat the user happens to call that). Older output tasks are adopted by title.
function outputTask(app, automation) {
  const title = `Automation · ${automation.name}`;
  let task = app.tasks.find((item) => item.automationId === automation.id)
    || app.tasks.find((item) => !item.automationId && item.title === title && item.messages.every((message) => message.role !== 'user' || message.text === automation.prompt));
  if (!task) {
    task = app.makeTask(title);
    app.tasks.unshift(task);
  }
  task.automationId = automation.id;
  // Listed under its project, like any task in that folder.
  if (automation.folder && !task.folder) task.folder = { ...automation.folder };
  return { task, title };
}

function appendOutput(app, automation, data) {
  const { task, title } = outputTask(app, automation);
  app.appendMessage('user', automation.prompt, task.id);
  // What the run did on the way and what it changed, like any reply (steps and the changes card).
  app.appendMessage('assistant', String(data?.text ?? ''), task.id, {
    tools: data?.toolCalls, steps: data?.steps, changes: data?.changes, metrics: data?.metrics,
  });
  // appendMessage renames a task on its first user message, so restore the stable automation title.
  task.title = title;
  return task;
}

// Sends one run. Never touches nextRun: scheduled runs are advanced by
// claimDue before sending, and a manual "Run now" leaves the schedule alone.
// Returns 'success' | 'error' | 'skipped' (already in flight).
async function runAutomation(app, automation, { manual = false } = {}) {
  if (inFlight.has(automation)) return 'skipped';
  const bridge = app.getProviderBridge?.();
  const start = Date.now();
  // Guard the whole run: the 30s poll, focus wake-up and Run now can overlap.
  inFlight.add(automation);
  try {
    if (!app.provider?.configured || !bridge?.send) {
      automation.lastStatus = 'error';
      automation.lastError = 'Provider not configured; scheduled run skipped.';
      automation.lastRun = start;
      record(automation, 'error', automation.lastError);
      void app.persist('automations');
      syncAutomationViews(app);
      if (manual) app.showToast('Connect a provider in Assistant first');
      return 'error';
    }
    // It works in the folder and mode it was made in, never in whatever is open when it fires;
    // made without a folder, it gets no file tools at all (`folder: null`). One made before
    // automations remembered their folder has none recorded and keeps the open folder.
    const settings = automation.mode ? { ...app.settings, mode: automation.mode } : app.settings;
    const payload = {
      requestId: `automation-${automation.id}-${start}`,
      ...('folder' in automation ? { folder: automation.folder?.path || null } : {}),
      messages: [{ role: 'user', content: automation.prompt }],
      // Same system prompt and temperature rules as interactive chat.
      mode: settings.mode,
      systemPrompt: typeof app.buildSystemPrompt === 'function'
        ? app.buildSystemPrompt(settings)
        : buildSystemPrompt(settings),
    };
    const temperature = requestTemperature(app.settings);
    if (temperature !== undefined) payload.temperature = temperature;
    payload.reasoning = requestReasoning(app.settings);

    let result;
    try {
      result = await bridge.send(payload);
    } catch (error) {
      fail(app, automation, error instanceof Error ? error.message : 'Provider request failed');
      return 'error';
    }
    if (!result?.ok) {
      fail(app, automation, result?.error?.message || 'Provider request failed');
      return 'error';
    }

    automation.lastStatus = 'success';
    automation.lastRun = Date.now();
    automation.lastError = '';
    const text = String(result.data?.text ?? '');
    record(automation, 'success', text);
    const task = appendOutput(app, automation, result.data);
    void app.persist('tasks');
    void app.persist('automations');
    syncAutomationViews(app);
    app.renderTasks();
    if (app.currentTaskId === task.id) app.renderChat();
    app.showToast(`Automation finished: ${automation.name}`);
    return 'success';
  } finally {
    inFlight.delete(automation);
  }
}

export function startScheduler(app) {
  if (started) return started;
  let running = false;
  let timer = null;
  const win = typeof window === 'undefined' ? null : window;
  const doc = typeof document === 'undefined' ? null : document;

  // Marks the automations that are due now and rolls their schedule forward
  // before any request is sent, so an overlapping check cannot fire them twice.
  function claimDue(now) {
    const claimed = [];
    for (const automation of Array.isArray(app.automations) ? app.automations : []) {
      if (!automation.active || inFlight.has(automation)) continue;
      if (!Number.isFinite(automation.nextRun) || automation.nextRun > now) continue;
      advance(automation, now);
      claimed.push(automation);
    }
    if (claimed.length) void app.persist('automations');
    return claimed;
  }

  async function check() {
    if (running) return;
    running = true;
    try {
      for (const automation of claimDue(Date.now())) {
        try {
          await runAutomation(app, automation);
        } catch (error) {
          console.warn('[scheduler] Automation run failed:', error);
        }
      }
    } finally {
      running = false;
      updateStatus(app);
    }
  }

  // Catch-up: a schedule that came due while the app was closed runs once at
  // startup (never once per missed occurrence).
  const start = Date.now();
  const missed = (Array.isArray(app.automations) ? app.automations : [])
    .filter((automation) => automation.active && automation.pendingCatchUp === true);
  for (const automation of missed) {
    automation.pendingCatchUp = false;
    // A missed one-time schedule is consumed by its catch-up run.
    if (automation.schedule === 'once') advance(automation, start);
  }
  let catchUpDone = Promise.resolve();
  if (missed.length) {
    void app.persist('automations');
    catchUpDone = (async () => {
      for (const automation of missed) {
        try {
          await runAutomation(app, automation);
        } catch (error) {
          console.warn('[scheduler] Catch-up run failed:', error);
        }
      }
    })();
  }
  // A slot that is due right now is left to the first check(): claimDue rolls
  // it forward and runs it exactly once. Advancing it here would skip the run.
  updateStatus(app);

  const onWake = () => {
    if (!doc || doc.visibilityState === 'visible') void check();
  };
  if (win) {
    timer = win.setInterval(() => { void check(); }, POLL_MS);
    win.addEventListener('focus', onWake);
  }
  if (doc) doc.addEventListener('visibilitychange', onWake);
  void check();

  started = {
    checkNow: check,
    async runNow(automationId) {
      const automation = (Array.isArray(app.automations) ? app.automations : [])
        .find((item) => item.id === automationId);
      if (!automation) throw new Error('Automation not found');
      return runAutomation(app, automation, { manual: true });
    },
    // Resolves when startup catch-up runs have finished (used by tests).
    ready: catchUpDone,
    stop() {
      if (timer !== null && win) win.clearInterval(timer);
      timer = null;
      if (win) win.removeEventListener('focus', onWake);
      if (doc) doc.removeEventListener('visibilitychange', onWake);
      started = null;
    },
  };
  return started;
}
