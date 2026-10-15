'use strict';

// Automations run by the main process, so they fire on schedule while the window is closed too
// (the app keeps running on macOS without a window). The window edits them (src/app.js) and shows
// their runs (src/scheduler.js); this module owns everything that happens when one comes due:
// when it fires, running it through the chat path with its own folder and mode, its status and
// run history, and the messages its run adds to its output task.
//
// Both sides write the same two state keys, so neither may write over the other:
// - `automations`: the window owns what an automation is (name, prompt, schedule, folder) and
//   whether it is paused; main owns how its runs went (lastRun, lastStatus, history). When it
//   fires next (nextRun, active for a one-time schedule) belongs to whoever changed it last: the
//   window stamps `editedAt` on every edit, pause and resume, so an older snapshot of the window
//   never rolls a schedule back to a slot main already ran (which would run it twice).
// - `tasks`: main appends a run's messages, marked with the run's id (`run`), and tells the
//   window, which adds them to its copy. Until a write from the window shows them, main adds them
//   to whatever the window writes, so a snapshot it took before the run never drops them.

const POLL_MS = 30_000;
const MAX_HISTORY = 10;
const PREVIEW_CHARS = 200;
const MAX_ERROR_CHARS = 2000;
// Runs whose messages no write from the window has shown yet (oldest dropped first).
const MAX_PENDING_RUNS = 50;
// The instructions the window sends for runs (src/scheduler.js automationContext).
const CONTEXT_KEY = 'automationContext';
const MAX_SYSTEM_PROMPT_BYTES = 256 * 1024;
const MODES = ['working', 'coding'];
const EFFORTS = ['low', 'medium', 'high'];
const RUN_MARKER = /^[A-Za-z0-9._:-]{1,160}$/;

// ---- Schedule math -------------------------------------------------------------------------
// A port of nextRunAt in src/domain.mjs, which the window uses when an automation is made, edited
// or resumed. The main process cannot load the renderer's modules (ES modules beside .js files
// with ES syntax), so the math lives in both places; test/automations.test.cjs runs both on the
// same inputs and requires identical results. Change one, change the other.
const SCHEDULES = ['once', 'hourly', 'daily', 'weekly', 'monthly', 'interval'];
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 525600;

function isRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(record, key) {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function validId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)
    && !['__proto__', 'prototype', 'constructor'].includes(value);
}

function validTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value)
    && !Number.isNaN(new Date(value).getTime());
}

function integerIn(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

// `from`: the slot that just came due. An interval schedule steps from it rather than from when
// the due run was noticed, so a run found by the 30 s poll does not push every later run back;
// slots that passed meanwhile are skipped, never queued. Other schedules ignore it.
function nextRunAt(automation, afterMs = Date.now(), { from = null } = {}) {
  if (!isRecord(automation) || !SCHEDULES.includes(own(automation, 'schedule'))) {
    throw new RangeError(`Schedule must be one of ${SCHEDULES.join(', ')}.`);
  }
  if (!validTimestamp(afterMs)) throw new RangeError('afterMs must be a finite epoch timestamp.');
  const schedule = automation.schedule;

  // Interval and one-shot schedules are anchored to a timestamp, not wall-clock.
  if (schedule === 'interval') {
    if (!integerIn(own(automation, 'intervalMinutes'), MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES)) {
      throw new RangeError(`Interval schedules require intervalMinutes from ${MIN_INTERVAL_MINUTES} through ${MAX_INTERVAL_MINUTES}.`);
    }
    const step = automation.intervalMinutes * 60000;
    if (validTimestamp(from) && from <= afterMs) return from + (Math.floor((afterMs - from) / step) + 1) * step;
    return afterMs + step;
  }
  if (schedule === 'once') {
    const runAt = own(automation, 'runAt');
    if (validTimestamp(runAt) && runAt > afterMs) return runAt;
    // A one-shot whose moment has passed is exhausted; only an explicit HH:MM
    // keeps it representable, and then it behaves like the next daily slot.
    if (validTimestamp(runAt)) throw new RangeError('This one-time schedule has already run.');
    if (typeof own(automation, 'time') !== 'string' || !TIME_PATTERN.test(automation.time)) {
      throw new RangeError('A one-time schedule requires runAt or a time of day.');
    }
  }

  const time = own(automation, 'time');
  const needsTime = ['hourly', 'daily', 'weekly', 'monthly'].includes(schedule);
  if ((needsTime || schedule === 'once') && (typeof time !== 'string' || !TIME_PATTERN.test(time))) {
    throw new RangeError('Time must use HH:MM in the range 00:00 through 23:59.');
  }
  if (schedule === 'weekly' && !integerIn(own(automation, 'dayOfWeek'), 0, 6)) {
    throw new RangeError('Weekly schedules require dayOfWeek from 0 (Sunday) through 6.');
  }
  if (schedule === 'monthly' && !integerIn(own(automation, 'dayOfMonth'), 1, 31)) {
    throw new RangeError('Monthly schedules require dayOfMonth from 1 through 31.');
  }
  if (schedule === 'hourly') {
    // Every hour at the minute named by time (the hour part is ignored).
    const minute = Number(time.split(':')[1]);
    const candidate = new Date(afterMs);
    candidate.setMinutes(minute, 0, 0);
    if (candidate.getTime() <= afterMs) candidate.setHours(candidate.getHours() + 1);
    return candidate.getTime();
  }

  const after = new Date(afterMs);
  const [hour, minute] = time.split(':').map(Number);
  const year = after.getFullYear();
  const month = after.getMonth();
  const day = after.getDate();

  // Rebuild local wall-clock time on each calendar date, not by adding 24 hours.
  // Native Date moves gap times forward and chooses the first repeated time.
  function localDate(monthOffset, date) {
    const candidate = new Date(afterMs);
    candidate.setFullYear(year, month + monthOffset, date);
    candidate.setHours(hour, minute, 0, 0);
    return candidate;
  }

  if (schedule === 'monthly') {
    for (let offset = 0; offset < 24; offset += 1) {
      const candidate = localDate(offset, automation.dayOfMonth);
      // Date rolls February 31 into March; that is not a February occurrence.
      if (candidate.getDate() === automation.dayOfMonth && candidate.getTime() > afterMs) {
        return candidate.getTime();
      }
    }
  } else {
    const weekly = schedule === 'weekly';
    const offset = weekly ? (automation.dayOfWeek - after.getDay() + 7) % 7 : 0;
    const step = weekly ? 7 : 1;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidate = localDate(0, day + offset + attempt * step);
      if (candidate.getTime() > afterMs) return candidate.getTime();
    }
  }
  throw new RangeError('No future occurrence is representable as a Date.');
}

// ---- Records -------------------------------------------------------------------------------

/** True for a saved automation main may fire: current format, switched on, and complete. */
function runnable(record) {
  return isRecord(record) && validId(record.id) && record.schemaVersion === 2 && record.active === true
    // A run an older version left marked as running is reviewed by the user first (src/domain.mjs).
    && record.lastStatus !== 'running' && record.running !== true
    && typeof record.name === 'string' && Boolean(record.name.trim())
    && typeof record.prompt === 'string' && Boolean(record.prompt.trim())
    && SCHEDULES.includes(record.schedule);
}

function editedAt(record) {
  return isRecord(record) && validTimestamp(record.editedAt) ? record.editedAt : 0;
}

// A one-shot schedule is exhausted once it fires; every other schedule rolls forward to its next
// occurrence (an interval from the slot that came due, so it keeps its rhythm).
function advance(record, afterMs, { from = record.nextRun } = {}) {
  if (record.schedule === 'once') {
    record.active = false;
    record.nextRun = null;
    return;
  }
  try {
    record.nextRun = nextRunAt(record, afterMs, { from });
  } catch (error) {
    // A schedule that cannot produce a future occurrence is paused, not retried forever.
    record.active = false;
    record.nextRun = null;
    record.lastError = error instanceof Error ? error.message : 'No future occurrence is representable as a Date.';
  }
}

function addHistory(record, entry) {
  record.history = [entry, ...(Array.isArray(record.history) ? record.history : [])].slice(0, MAX_HISTORY);
}

// What the window owns and what main owns of a saved automation (see the top of this file).
const RUN_FIELDS = ['lastRun', 'lastStatus', 'history'];
const SCHEDULE_FIELDS = ['active', 'nextRun', 'pendingCatchUp', 'lastError'];

/**
 * The window's list of automations, as main stores it: the window's definitions, deletions and
 * new automations, with main's run results, and main's schedule state unless the window changed
 * that automation since (a newer `editedAt`).
 */
function mergeAutomations(stored, incoming) {
  if (!Array.isArray(incoming)) return incoming;
  const mine = new Map();
  for (const record of Array.isArray(stored) ? stored : []) if (isRecord(record) && validId(record.id)) mine.set(record.id, record);
  return incoming.map((record) => {
    const current = isRecord(record) ? mine.get(record.id) : undefined;
    // New in the window, or a record main never ran (from before schedules were versioned, or
    // left "running" by an older version): the window's normalized copy is the one to keep.
    if (!current || current.schemaVersion !== 2 || current.lastStatus === 'running' || current.running === true) return record;
    const merged = { ...record };
    const fields = editedAt(record) > editedAt(current) ? RUN_FIELDS : [...RUN_FIELDS, ...SCHEDULE_FIELDS];
    for (const key of fields) {
      if (Object.hasOwn(current, key)) merged[key] = current[key];
      else delete merged[key];
    }
    return merged;
  });
}

// ---- The messages of a run -----------------------------------------------------------------

function cut(value, max) {
  const text = String(value ?? '');
  return text.length > max ? text.slice(0, max) : text;
}

/** The reply's extras as the window keeps them under an answer (src/app.js appendMessage). */
function replyFields(data) {
  const fields = {};
  const tools = Array.isArray(data?.toolCalls) ? data.toolCalls.filter((item) => isRecord(item) && typeof item.tool === 'string').slice(0, 32)
    .map((item) => ({ server: typeof item.server === 'string' ? item.server.slice(0, 64) : '', tool: item.tool.slice(0, 128), ok: item.ok === true })) : [];
  if (tools.length) fields.tools = tools;
  if (Array.isArray(data?.steps) && data.steps.length) fields.steps = data.steps.filter(isRecord).slice(0, 200);
  if (isRecord(data?.changes)) fields.changes = data.changes;
  if (isRecord(data?.metrics)) fields.metrics = data.metrics;
  return fields;
}

/** What the reply says about calls nobody could approve (no window was open). */
function deniedNote(labels) {
  if (!labels.length) return '';
  const counts = new Map();
  for (const label of labels) counts.set(label, (counts.get(label) || 0) + 1);
  const list = [...counts].map(([label, count]) => (count > 1 ? `${label} (${count}×)` : label)).join(', ');
  const one = labels.length === 1;
  return `\n\n[Note from ScaleMax: ${one ? 'a tool call' : `${labels.length} tool calls`} needed your approval, but no ScaleMax window was open to ask in, so ${one ? 'it was' : 'they were'} denied: ${list}. Open ScaleMax and choose Run now to approve ${one ? 'it' : 'them'}.]`;
}

// ---- The instructions runs are sent with ---------------------------------------------------

/**
 * The window's instructions for runs: the system prompt for each mode (the window builds it with
 * the expert, skill and custom catalogs only it has), the temperature and the reasoning setting.
 * Null when the value is not usable.
 */
function normalizeContext(value) {
  if (!isRecord(value) || !isRecord(value.systemPrompts)) return null;
  const systemPrompts = {};
  for (const mode of MODES) {
    const text = value.systemPrompts[mode];
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_SYSTEM_PROMPT_BYTES) return null;
    systemPrompts[mode] = text;
  }
  const context = { systemPrompts };
  const temperature = value.temperature;
  if (typeof temperature === 'number' && Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) context.temperature = temperature;
  if (isRecord(value.reasoning)) {
    context.reasoning = {
      thinking: value.reasoning.thinking !== false,
      effort: EFFORTS.includes(value.reasoning.effort) ? value.reasoning.effort : 'medium',
    };
  }
  return context;
}

function automationError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * @param {object} options
 * @param {{readAll: () => object, update: (mutator: (draft: object) => void) => object}} options.store
 *   the app's state store (lib/state.cjs)
 * @param {(input: object) => Promise<object>} options.send runs one chat request exactly like the
 *   window's (main.js: provider:send) and resolves to the reply, or rejects with what went wrong
 * @param {() => boolean} options.configured whether a provider is set up
 * @param {() => boolean} options.windowOpen whether a ScaleMax window is open
 * @param {() => ({name: string, path: string}|null)} [options.openFolder] the folder open in the
 *   window (an automation made before automations remembered their folder runs there)
 * @param {(change: object) => void} [options.notify] tells an open window what changed:
 *   { automations, running, run?: { runId, task, messages }, finished?: { id, name, status, message?, manual } }
 */
function createAutomations({
  store, send, configured, windowOpen, openFolder = () => null, notify = () => {},
  now = Date.now, pollMs = POLL_MS, setTimer = setInterval, clearTimer = clearInterval,
} = {}) {
  if (!store || typeof store.readAll !== 'function' || typeof store.update !== 'function') throw new TypeError('A state store is required.');
  if (typeof send !== 'function') throw new TypeError('send is required.');
  if (typeof configured !== 'function' || typeof windowOpen !== 'function') throw new TypeError('configured and windowOpen are required.');

  // Automations running now, by id: the same automation never runs twice at a time.
  const inFlight = new Set();
  // Runs in progress by request id, with the calls nobody could approve (unattended()).
  const runs = new Map();
  // Runs appended to `tasks` that the window has not written back yet (withPendingRuns).
  const pending = new Map();
  // Every run in progress, for whenIdle().
  const working = new Set();
  let context;
  let timer = null;
  let caughtUp = false;
  let catchUpDone = Promise.resolve();

  function readAll() {
    try {
      const data = store.readAll();
      return isRecord(data) ? data : {};
    } catch {
      return {};
    }
  }

  function readList() {
    const list = readAll().automations;
    return Array.isArray(list) ? list : [];
  }

  function settings() {
    const value = readAll().settings;
    return isRecord(value) ? value : {};
  }

  /** Preferences > Automations: runs also fire while no window is open (on by default). */
  function background() {
    return settings().automationsInBackground !== false;
  }

  function readContext() {
    if (context === undefined) context = normalizeContext(readAll()[CONTEXT_KEY]);
    return context;
  }

  // Changes saved automations in one write; false when the state file could not be written.
  function editList(mutator) {
    try {
      store.update((draft) => {
        const list = Array.isArray(draft.automations) ? draft.automations : [];
        mutator(list);
        draft.automations = list;
      });
      return true;
    } catch (error) {
      console.error('[ScaleMax] Automations could not be saved:', error?.message);
      return false;
    }
  }

  function changed(extra = {}) {
    try {
      notify({ automations: readList(), running: [...inFlight], ...extra });
    } catch { /* a window that went away misses nothing it cannot read from the state file */ }
  }

  /**
   * The automations due now, rolled forward before any request is sent, so an overlapping check
   * cannot fire them twice. An active automation without a next run gets one.
   */
  function claimDue(time) {
    const due = (record) => runnable(record) && !inFlight.has(record.id)
      && (!Number.isFinite(record.nextRun) || record.nextRun <= time);
    if (!readList().some(due)) return [];
    const claimed = [];
    const saved = editList((list) => {
      for (const record of list) {
        if (!due(record)) continue;
        if (!Number.isFinite(record.nextRun)) {
          try {
            record.nextRun = nextRunAt(record, time);
          } catch (error) {
            record.active = false;
            record.lastError = error instanceof Error ? error.message : 'No future occurrence is representable as a Date.';
          }
          continue;
        }
        advance(record, time);
        claimed.push(record.id);
      }
    });
    // Unsaved, a claim would be made again on the next check: nothing runs until it sticks.
    return saved ? claimed : [];
  }

  /**
   * A schedule that came due while ScaleMax was not running (or was waiting for a window) runs
   * once, never once per missed slot; a missed one-time schedule is consumed by that run.
   */
  function claimMissed(time) {
    const missed = (record) => runnable(record) && !inFlight.has(record.id)
      && (record.pendingCatchUp === true || (Number.isFinite(record.nextRun) && record.nextRun <= time));
    if (!readList().some(missed)) return [];
    const claimed = [];
    const saved = editList((list) => {
      for (const record of list) {
        if (!missed(record)) continue;
        record.pendingCatchUp = false;
        if (record.schedule === 'once') advance(record, time);
        else if (!Number.isFinite(record.nextRun) || record.nextRun <= time) advance(record, time, { from: null });
        claimed.push(record.id);
      }
    });
    return saved ? claimed : [];
  }

  /** Records how a run went, and appends its messages to the automation's task when it worked. */
  function complete(snapshot, { status, message = '', data = null, runId, startedAt }) {
    const time = now();
    let entry = null;
    try {
      store.update((draft) => {
        const list = Array.isArray(draft.automations) ? draft.automations : [];
        // Deleted while it ran: its run is still kept in its task, only the record is gone.
        const record = list.find((item) => isRecord(item) && item.id === snapshot.id);
        if (record) {
          record.lastStatus = status;
          record.lastRun = time;
          record.lastError = status === 'error' ? cut(message, MAX_ERROR_CHARS) : '';
          addHistory(record, { time, status, preview: cut(status === 'error' ? message : data?.text, PREVIEW_CHARS) });
        }
        draft.automations = list;
        if (status !== 'success') return;
        entry = appendRun(draft, snapshot, { data, runId, startedAt, time });
      });
    } catch (error) {
      console.error('[ScaleMax] An automation run could not be saved:', error?.message);
      return null;
    }
    if (entry) {
      pending.set(runId, entry);
      while (pending.size > MAX_PENDING_RUNS) pending.delete(pending.keys().next().value);
    }
    return entry;
  }

  // The automation's own task, found by its id (a title is shared by automations with the same
  // name, and by any chat the user happens to call that); an older output task is adopted by
  // its title. It gets the run's prompt and reply, like a chat (steps and the changes card too).
  function appendRun(draft, snapshot, { data, runId, startedAt, time }) {
    const tasks = Array.isArray(draft.tasks) ? draft.tasks : [];
    const title = `Automation · ${snapshot.name}`;
    let task = tasks.find((item) => isRecord(item) && item.automationId === snapshot.id)
      || tasks.find((item) => isRecord(item) && !item.automationId && item.title === title && Array.isArray(item.messages)
        && item.messages.every((message) => !isRecord(message) || message.role !== 'user' || message.text === snapshot.prompt));
    if (!task) {
      task = { id: `task-${startedAt}-${Math.random().toString(36).slice(2, 8)}`, title, messages: [], createdAt: startedAt, updatedAt: startedAt };
      tasks.unshift(task);
    }
    if (!Array.isArray(task.messages)) task.messages = [];
    task.automationId = snapshot.id;
    // Listed under its project, like any task in that folder. Made without a folder, it ran with
    // no folder at all and is not tied to whichever folder happens to be open; made before
    // automations remembered their folder, it ran in the open one.
    if (isRecord(snapshot.folder) && !task.folder) task.folder = { name: snapshot.folder.name, path: snapshot.folder.path };
    else if (!Object.hasOwn(snapshot, 'folder') && !task.folder) {
      const open = openFolder();
      if (open && typeof open.path === 'string') task.folder = { name: open.name, path: open.path };
    }
    const messages = [
      { role: 'user', text: snapshot.prompt, time: startedAt, run: runId },
      { role: 'assistant', text: String(data?.text ?? ''), time, run: runId, ...replyFields(data) },
    ];
    task.messages.push(...messages);
    task.title = title;
    task.updatedAt = time;
    draft.tasks = tasks;
    const shell = { id: task.id, title, createdAt: task.createdAt, updatedAt: time, automationId: snapshot.id };
    if (isRecord(task.folder)) shell.folder = { name: task.folder.name, path: task.folder.path };
    return { runId, task: shell, messages: structuredClone(messages) };
  }

  /**
   * Runs one automation through the chat path. Scheduled runs were rolled forward when they were
   * claimed; Run now leaves the schedule alone. Resolves to { status: 'success' | 'error' |
   * 'skipped' (already running), message?, code? }.
   */
  async function run(id, { manual = false } = {}) {
    if (inFlight.has(id)) return { status: 'skipped' };
    const snapshot = readList().find((item) => isRecord(item) && item.id === id);
    if (!snapshot) throw automationError('NOT_FOUND', 'That automation no longer exists.');
    inFlight.add(id);
    const startedAt = now();
    const runId = `automation-${id}-${startedAt}`;
    let outcome = { status: 'error', message: 'The automation could not be run.' };
    let entry = null;
    const task = (async () => {
      changed();
      try {
        if (typeof snapshot.prompt !== 'string' || !snapshot.prompt.trim() || typeof snapshot.name !== 'string') {
          outcome = { status: 'error', message: 'This automation has no prompt to send.' };
        } else if (!configured()) {
          outcome = { status: 'error', code: 'PROVIDER_NOT_CONFIGURED', message: 'Provider not configured; scheduled run skipped.' };
        } else {
          outcome = await sendRun(snapshot, runId);
        }
      } catch (error) {
        outcome = { status: 'error', message: error instanceof Error && error.message ? error.message : 'Provider request failed' };
      }
      entry = complete(snapshot, { ...outcome, runId, startedAt });
    })();
    working.add(task);
    try {
      await task;
    } finally {
      working.delete(task);
      inFlight.delete(id);
      const finished = { id, name: typeof snapshot.name === 'string' ? snapshot.name : '', status: outcome.status, manual,
        ...(outcome.message && outcome.status === 'error' ? { message: outcome.message } : {}), ...(outcome.code ? { code: outcome.code } : {}) };
      changed({ finished, ...(entry ? { run: entry } : {}) });
    }
    const { data, ...result } = outcome;
    return result;
  }

  // The request the window used to send for a run (src/scheduler.js before automations moved here).
  async function sendRun(snapshot, runId) {
    const instructions = readContext();
    // Its own mode; one made before automations remembered their mode uses the window's.
    const mode = MODES.includes(snapshot.mode) ? snapshot.mode : (settings().mode === 'coding' ? 'coding' : 'working');
    const input = {
      requestId: runId,
      // The folder it was made in, whatever is open when it fires (`folder: null`: no file tools
      // at all); one made before automations remembered their folder leaves it out and works in
      // the open folder.
      ...(Object.hasOwn(snapshot, 'folder') ? { folder: isRecord(snapshot.folder) && typeof snapshot.folder.path === 'string' ? snapshot.folder.path : null } : {}),
      messages: [{ role: 'user', content: snapshot.prompt }],
      mode,
      systemPrompt: instructions?.systemPrompts[mode] || '',
      ...(instructions && instructions.temperature !== undefined ? { temperature: instructions.temperature } : {}),
      ...(instructions?.reasoning ? { reasoning: instructions.reasoning } : {}),
    };
    const denied = [];
    runs.set(runId, { denied });
    let data;
    try {
      data = await send(input);
    } finally {
      runs.delete(runId);
    }
    const text = `${String(data?.text ?? '')}${deniedNote(denied)}`;
    return { status: 'success', data: { ...data, text } };
  }

  async function runSafely(id, options) {
    try {
      return await run(id, options);
    } catch (error) {
      if (error?.code !== 'NOT_FOUND') console.warn('[ScaleMax] Automation run failed:', error?.message);
      return { status: 'error' };
    }
  }

  /**
   * Fires what is due. Nothing fires before the window has sent its instructions once (they are
   * kept for later starts), and, with Preferences > Automations off, nothing fires while no
   * window is open: due runs wait for one and then run once.
   */
  async function check() {
    if (!readContext() || (!windowOpen() && !background())) return;
    const time = now();
    let missed = [];
    if (!caughtUp) {
      caughtUp = true;
      missed = claimMissed(time);
      if (missed.length) {
        // One after another, in the background: a slow catch-up must not hold back what is due.
        catchUpDone = (async () => {
          for (const id of missed) {
            // Already run since (its next slot came due while an earlier catch-up worked, and a
            // check ran it): that was its run.
            const record = readList().find((item) => isRecord(item) && item.id === id);
            if (!record || (Number.isFinite(record.lastRun) && record.lastRun >= time)) continue;
            await runSafely(id);
          }
        })();
      }
    }
    const due = claimDue(time);
    if (missed.length || due.length) changed();
    // Every due automation starts at once, also while earlier runs still work: a slow run must
    // not hold back the others. One still in flight is never claimed again.
    await Promise.all(due.map((id) => runSafely(id)));
  }

  return {
    nextRunAt,
    /** Starts the 30 s check (also right away). */
    start() {
      if (timer) return;
      timer = setTimer(() => { void check(); }, pollMs);
      timer?.unref?.();
      void check();
    },
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
    },
    check,
    /** Run now: runs it at once (the schedule stays as it is). */
    runNow: (id) => {
      if (!validId(id)) throw automationError('INVALID_AUTOMATION', 'Choose an automation.');
      return run(id, { manual: true });
    },
    /** The window's instructions for runs (see normalizeContext); kept for later starts. */
    setContext(input) {
      const next = normalizeContext(input);
      if (!next) throw automationError('INVALID_CONTEXT', 'The instructions for automations are not valid.');
      if (JSON.stringify(next) !== JSON.stringify(readContext())) {
        store.update((draft) => { draft[CONTEXT_KEY] = next; });
      }
      context = next;
      // Due runs may have waited for these instructions (or for a window).
      void check();
      return { saved: true };
    },
    /**
     * What a window that just opened needs: the ids running now, whether runs fire without a
     * window, the saved automations, and the runs it has not written back yet (it may have read
     * the state file just before one was saved, and subscribed just after it was announced).
     */
    state: () => ({
      running: [...inFlight], background: background(), automations: readList(), runs: [...pending.values()].map((entry) => structuredClone(entry)),
    }),
    /** True for a request that belongs to an automation run in progress. */
    owns: (requestId) => runs.has(requestId),
    /**
     * A call of an automation run that needs approval while no window is open: it is denied (never
     * left waiting) and named in a note under the reply. False for requests of other replies.
     */
    unattended(requestId, label) {
      const entry = runs.get(requestId);
      if (!entry) return false;
      entry.denied.push(cut(label, 200));
      return true;
    },
    /** The two state keys both sides write: what the window writes is merged, never written over main's. */
    merges: (key) => key === 'tasks' || key === 'automations',
    /** Saves what the window wrote under `tasks` or `automations` (see the top of this file). */
    fromWindow(key, value) {
      let before = null;
      let after = null;
      store.update((draft) => {
        if (key === 'automations') {
          after = mergeAutomations(draft.automations, value);
          before = JSON.stringify(value);
          draft.automations = after;
        } else {
          draft.tasks = withPendingRuns(value);
        }
      });
      // The window's copy missed something of main's (a run finished meanwhile): send the list.
      if (key === 'automations' && JSON.stringify(after) !== before) changed();
    },
    /** Resolves once no run is in progress and the start-up catch-up finished (tests). */
    async whenIdle() {
      await catchUpDone;
      while (working.size) await Promise.all([...working]);
    },
  };

  // Runs whose messages the window has not written back yet are added to what it writes (at the
  // end of their task, or with their task when the window has not got it), so a snapshot taken
  // before a run never drops it. A write that shows a run's messages means the window has them.
  function withPendingRuns(tasks) {
    if (!Array.isArray(tasks) || !pending.size) return tasks;
    const shown = new Set();
    for (const task of tasks) {
      if (!isRecord(task) || !Array.isArray(task.messages)) continue;
      for (const message of task.messages) if (isRecord(message) && typeof message.run === 'string' && RUN_MARKER.test(message.run)) shown.add(message.run);
    }
    let result = tasks;
    for (const [runId, entry] of pending) {
      if (shown.has(runId)) {
        pending.delete(runId);
        continue;
      }
      if (result === tasks) result = [...tasks];
      const messages = structuredClone(entry.messages);
      const index = result.findIndex((task) => isRecord(task) && task.id === entry.task.id);
      if (index === -1) {
        result.unshift({ ...structuredClone(entry.task), messages });
      } else {
        const task = result[index];
        const updatedAt = Math.max(Number.isFinite(task.updatedAt) ? task.updatedAt : 0, entry.task.updatedAt);
        result[index] = { ...task, messages: [...(Array.isArray(task.messages) ? task.messages : []), ...messages], updatedAt };
      }
    }
    return result;
  }
}

module.exports = { createAutomations, nextRunAt, mergeAutomations, normalizeContext, POLL_MS };
