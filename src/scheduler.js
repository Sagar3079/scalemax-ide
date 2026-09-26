/** ScaleMax IDE: runs enabled automations while this window is open. */
import { nextRunAt } from './domain.mjs';

const POLL_MS = 30000;

let started = null;

function advance(automation, afterMs) {
  try {
    automation.nextRun = nextRunAt(automation, afterMs);
  } catch (error) {
    // A schedule that cannot produce a future occurrence is paused, not retried forever.
    automation.active = false;
    automation.lastError = error instanceof Error ? error.message : 'No future occurrence is representable as a Date.';
  }
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
  advance(automation, Date.now());
  void app.persist('automations');
  syncAutomationViews(app);
  app.showToast(`Automation failed: ${automation.name} — ${message}`);
}

async function runAutomation(app, automation) {
  const bridge = app.getProviderBridge?.();
  const start = Date.now();
  if (!app.provider?.configured || !bridge?.send) {
    automation.lastStatus = 'error';
    automation.lastError = 'Provider not configured; scheduled run skipped.';
    advance(automation, start);
    void app.persist('automations');
    syncAutomationViews(app);
    return;
  }
  const payload = {
    requestId: `automation-${automation.id}-${start}`,
    messages: [{ role: 'user', content: automation.prompt }],
  };
  const systemPrompt = (app.settings?.systemPrompt || '').trim();
  if (systemPrompt) payload.systemPrompt = systemPrompt;
  if (app.settings?.temperatureEnabled) payload.temperature = Number(app.settings.temperature);

  let result;
  try {
    result = await bridge.send(payload);
  } catch (error) {
    fail(app, automation, error instanceof Error ? error.message : 'Provider request failed');
    return;
  }
  if (!result?.ok) {
    fail(app, automation, result?.error?.message || 'Provider request failed');
    return;
  }

  automation.lastStatus = 'success';
  automation.lastRun = Date.now();
  automation.lastError = '';
  advance(automation, Date.now());
  const title = `Automation · ${automation.name}`;
  let task = app.tasks.find((item) => item.title === title);
  if (!task) {
    task = app.makeTask(title);
    app.tasks.unshift(task);
  }
  app.appendMessage('user', automation.prompt, task.id);
  app.appendMessage('assistant', result.data.text, task.id);
  // appendMessage renames a task on its first user message, so restore the stable automation title.
  task.title = title;
  void app.persist('tasks');
  void app.persist('automations');
  syncAutomationViews(app);
  app.renderTasks();
  if (app.currentTaskId === task.id) app.renderChat();
  app.showToast(`Automation finished: ${automation.name}`);
}

export function startScheduler(app) {
  if (started) return started;
  let running = false;
  let timer = null;
  const win = typeof window === 'undefined' ? null : window;
  const doc = typeof document === 'undefined' ? null : document;

  async function check() {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      const due = (Array.isArray(app.automations) ? app.automations : [])
        .filter((automation) => automation.active && Number.isFinite(automation.nextRun) && automation.nextRun <= now);
      for (const automation of due) {
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

  const now = Date.now();
  let changed = false;
  for (const automation of Array.isArray(app.automations) ? app.automations : []) {
    if (!automation.active || (Number.isFinite(automation.nextRun) && automation.nextRun > now)) continue;
    changed = true;
    try {
      automation.nextRun = nextRunAt(automation, now);
    } catch (error) {
      automation.active = false;
      automation.lastError = error instanceof Error ? error.message : 'No future occurrence is representable as a Date.';
    }
  }
  if (changed) {
    void app.persist('automations');
    app.renderAutomations?.();
  }
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
