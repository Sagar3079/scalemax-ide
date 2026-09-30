/**
 * Feature specs (lib/specs.cjs): requirements, design and a task list per feature, as Markdown
 * files in .scalemax/specs of the open folder. The assistant writes them with its spec tools; this
 * dialog shows them, ticks tasks off (the user's own edit of their file) and starts a new spec by
 * seeding the message box. The card under a reply in Plan permission lives here too, because both
 * are "what we agreed to build before building it".
 * DOM is built with createElement and textContent only (no HTML); Markdown goes through
 * src/markdown.js, which also builds elements.
 */
import { renderMarkdown } from './markdown.js';
import { effectivePermission } from './domain.mjs';

const $ = (selector) => document.querySelector(selector);
const DOCS = ['requirements', 'design', 'tasks'];
const DOC_LABELS = { requirements: 'Requirements', design: 'Design', tasks: 'Tasks' };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tag === 'button') node.type = 'button';
  return node;
}
function bridge() {
  return window.scalemaxAPI?.specs || null;
}

// Which spec and document the dialog shows, and the control that opened it.
// `token` drops a document read overtaken by a newer one, `listToken` does the same for the list.
const view = {
  app: null, specs: [], folder: null, slug: '', doc: 'requirements', spec: null, opener: null,
  token: 0, listToken: 0, busy: false, pending: null,
};

function progressText(progress) {
  if (!progress?.total) return 'No tasks yet';
  return `${progress.done}/${progress.total} tasks done`;
}

function renderList() {
  const host = $('#specs-list');
  if (!host) return;
  if (!view.specs.length) {
    host.replaceChildren(element('p', 'specs-empty', 'No specs in this folder yet.'));
    return;
  }
  const hadFocus = host.contains(document.activeElement);
  host.replaceChildren(...view.specs.map((spec) => {
    const item = element('button', 'specs-item');
    item.dataset.slug = spec.slug;
    const selected = spec.slug === view.slug;
    item.classList.toggle('is-selected', selected);
    if (selected) item.setAttribute('aria-current', 'true');
    item.append(element('span', 'specs-item-name', spec.slug), element('span', 'specs-item-meta', progressText(spec.progress)));
    item.addEventListener('click', () => void showSpec(spec.slug));
    return item;
  }));
  if (hadFocus) host.querySelector('.specs-item.is-selected')?.focus();
}

function renderTabs() {
  const host = $('#specs-tabs');
  if (!host) return;
  host.replaceChildren(...DOCS.map((doc) => {
    const written = typeof view.spec?.docs?.[doc] === 'string';
    const tab = element('button', 'specs-tab', DOC_LABELS[doc]);
    tab.dataset.doc = doc;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(doc === view.doc));
    tab.classList.toggle('is-selected', doc === view.doc);
    tab.classList.toggle('is-missing', !written);
    if (!written) tab.title = `${DOC_LABELS[doc]} has not been written yet`;
    tab.addEventListener('click', () => {
      view.doc = doc;
      renderTabs();
      renderDoc();
    });
    return tab;
  }));
}

// The task list is shown as real checkboxes so the user can tick one off; every other document is
// read as Markdown.
function renderTasks() {
  const tasks = Array.isArray(view.spec?.tasks) ? view.spec.tasks : [];
  const list = element('ul', 'specs-tasks');
  list.setAttribute('aria-label', 'Tasks of this spec');
  for (const task of tasks) {
    const row = element('li', 'specs-task');
    row.style.setProperty('--specs-task-depth', String(Math.min(task.depth, 4)));
    const box = element('input');
    box.type = 'checkbox';
    // While the write is in flight the box keeps what the user just clicked, so it does not flick
    // back to the old state and then forward again.
    box.checked = view.pending?.number === task.number ? view.pending.done : task.done === true;
    box.disabled = view.busy;
    box.id = `specs-task-${task.number}`;
    box.addEventListener('change', () => void setTask(task.number, box.checked));
    const label = element('label', 'specs-task-text', task.text);
    label.setAttribute('for', box.id);
    row.append(box, label);
    list.append(row);
  }
  return list;
}

function renderDoc() {
  const host = $('#specs-doc');
  if (!host) return;
  const text = view.spec?.docs?.[view.doc];
  if (typeof text !== 'string') {
    host.replaceChildren(element('p', 'specs-empty',
      `${DOC_LABELS[view.doc]} has not been written yet. Ask ScaleMax to write it: "write the ${view.doc} for ${view.slug}".`));
    return;
  }
  const nodes = [];
  const body = element('div', 'specs-markdown md');
  body.append(renderMarkdown(text));
  nodes.push(body);
  if (view.doc === 'tasks' && view.spec.tasks?.length) nodes.unshift(renderTasks());
  host.replaceChildren(...nodes);
  host.scrollTop = 0;
}

function renderHead() {
  const title = $('#specs-name');
  if (title) title.textContent = view.slug || 'No spec selected';
  const progress = $('#specs-progress');
  if (progress) progress.textContent = view.spec ? progressText(view.specs.find((item) => item.slug === view.slug)?.progress) : '';
  const work = $('#specs-work');
  if (work) work.disabled = !view.spec || view.busy;
}

async function showSpec(slug, { focusTask = 0 } = {}) {
  view.slug = slug;
  view.spec = null;
  const token = (view.token += 1);
  renderList();
  renderHead();
  const host = $('#specs-doc');
  if (host) host.replaceChildren(element('p', 'specs-empty', 'Loading…'));
  let result;
  try {
    result = await bridge()?.read({ spec: slug });
  } catch (error) {
    result = { ok: false, error: { message: error?.message } };
  }
  if (token !== view.token) return;
  if (!result?.ok) {
    if (host) host.replaceChildren(element('p', 'specs-empty', result?.error?.message || 'That spec could not be read.'));
    renderTabs();
    renderHead();
    return;
  }
  view.spec = result.data;
  // Open the first document that exists, so a half-written spec shows something useful.
  if (typeof view.spec.docs[view.doc] !== 'string') view.doc = DOCS.find((doc) => typeof view.spec.docs[doc] === 'string') || 'requirements';
  renderTabs();
  renderDoc();
  renderHead();
  // The checkbox the user just clicked keeps the keyboard, even though the list was rebuilt.
  if (focusTask) document.getElementById(`specs-task-${focusTask}`)?.focus();
}

async function setTask(number, done) {
  const api = bridge();
  if (!api?.setTask || !view.slug || view.busy) return;
  view.busy = true;
  view.pending = { number, done };
  renderDoc();
  let result;
  try {
    // The revision the numbers were read from: a task list that changed since is refused rather
    // than having a different line ticked.
    result = await api.setTask({ spec: view.slug, task: number, done, revision: view.spec?.tasksRevision || undefined });
  } catch (error) {
    result = { ok: false, error: { message: error?.message } };
  }
  view.busy = false;
  view.pending = null;
  if (!result?.ok) {
    view.app?.showToast?.(result?.error?.message || 'That task could not be changed');
    await showSpec(view.slug, { focusTask: number });
    return;
  }
  await refresh();
  await showSpec(view.slug, { focusTask: number });
  // The file changed on disk, so the Workspace tree and Git status follow.
  if (typeof view.app?.refreshWorkspace === 'function') void view.app.refreshWorkspace();
}

async function refresh() {
  const token = (view.listToken += 1);
  let result;
  try {
    result = await bridge()?.list();
  } catch {
    result = null;
  }
  // An older list that arrives late must not replace a newer one.
  if (token !== view.listToken) return;
  view.specs = result?.ok && Array.isArray(result.data?.specs) ? result.data.specs : [];
  // The folder these specs really came from, which is the one the window has open.
  view.folder = result?.ok && result.data?.folder ? result.data.folder : null;
  renderList();
  renderHead();
}

/** Opens the specs dialog on `slug`, or the first spec of the folder. */
export async function openSpecs(app = view.app, { slug = '', opener = null } = {}) {
  const dialog = $('#specs-dialog');
  if (!dialog || !bridge()) return;
  view.app = app;
  view.opener = opener || document.activeElement;
  await refresh();
  // Named after the folder the specs were actually read from, which is the one the window has
  // open: it can differ from the folder the task on screen is fixed to.
  const subtitle = $('#specs-subtitle');
  if (subtitle) {
    subtitle.textContent = view.folder
      ? `Requirements, design and tasks in ${view.folder.name}/.scalemax/specs`
      : 'Open a project folder to keep specs in it.';
  }
  if (!dialog.open) dialog.showModal();
  const pick = view.specs.find((spec) => spec.slug === slug) || view.specs.find((spec) => spec.slug === view.slug) || view.specs[0];
  if (pick) await showSpec(pick.slug);
  else {
    view.slug = '';
    view.spec = null;
    renderTabs();
    renderDoc();
    renderHead();
  }
  (dialog.querySelector('.specs-item.is-selected') || $('#specs-new') || $('#specs-close'))?.focus();
}

// Both buttons hand the work to the assistant instead of writing files behind its back: the
// message box is seeded and the user can read and change it before sending.
function seedComposer(app, text) {
  const input = $('#chat-input');
  if (!input) return false;
  // Never overwrite something the user is in the middle of typing.
  if (input.value.trim()) {
    $('#specs-dialog')?.close();
    app.switchView?.('chat');
    input.focus();
    app.showToast('Send or clear what you have typed first');
    return false;
  }
  $('#specs-dialog')?.close();
  app.switchView?.('chat');
  input.value = text;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  app.updateSendEnabled?.();
  return true;
}

export function bindSpecsUi(app) {
  view.app = app;
  const dialog = $('#specs-dialog');
  if (!dialog) return;
  $('#specs-open')?.addEventListener('click', (event) => void openSpecs(app, { opener: event.currentTarget }));
  $('#specs-close')?.addEventListener('click', () => dialog.close());
  $('#specs-new')?.addEventListener('click', () => {
    if (seedComposer(app, 'Write a spec for this feature: ')) {
      app.showToast('Describe the feature, then send: ScaleMax writes the requirements first');
    }
  });
  $('#specs-work')?.addEventListener('click', () => {
    if (!view.slug) return;
    seedComposer(app, `Work through the open tasks of the "${view.slug}" spec, one at a time. Read the spec first, and tick each task off when it is done and verified.`);
  });
  dialog.addEventListener('close', () => {
    // The close event is queued, so the dialog can already be open again (closed and reopened in
    // one go). Only a dialog that is still closed drops the read that was on its way.
    if (!dialog.open) view.token += 1;
    const opener = view.opener;
    if (dialog.open) return;
    view.opener = null;
    if (opener?.isConnected && !opener.closest('[hidden]')) opener.focus();
    else $('#chat-input')?.focus();
  });
}

// One list at a time: renderFolder runs on every message, and a second request would only race
// the first for the same answer.
let chipPending = null;

/** The chip in the composer: how many specs the folder the window has open holds. */
export async function renderSpecsChip(app = view.app) {
  const chip = $('#specs-open');
  if (!chip) return;
  const api = bridge();
  chip.hidden = !api || !app?.workspace?.root;
  if (chip.hidden) return;
  let result;
  try {
    chipPending = chipPending || api.list();
    result = await chipPending;
  } catch {
    result = null;
  } finally {
    chipPending = null;
  }
  const specs = result?.ok && Array.isArray(result.data?.specs) ? result.data.specs : [];
  // Only the chip's own numbers: the dialog owns view.specs while it is open.
  if (!$('#specs-dialog')?.open) view.specs = specs;
  const label = $('#specs-open-label');
  const open = specs.reduce((total, spec) => total + Math.max(0, (spec.progress?.total || 0) - (spec.progress?.done || 0)), 0);
  if (label) label.textContent = specs.length ? `Specs · ${specs.length}${open ? ` · ${open} open` : ''}` : 'Specs';
  chip.title = specs.length
    ? `${specs.length} spec${specs.length === 1 ? '' : 's'} in this folder${open ? `, ${open} task${open === 1 ? '' : 's'} still open` : ''}`
    : 'Write down a feature before building it: requirements, design, tasks';
}

/**
 * The card under a reply that could only plan (Plan permission). "Run this plan" puts the
 * permission back where it was before planning and asks the assistant to carry the plan out; the
 * plan itself stays in the conversation, so the model works from what the user just read.
 */
export function renderPlanCard(app, message, taskId) {
  if (!message?.plan || message.role !== 'assistant' || !message.text?.trim()) return null;
  const card = element('section', 'plan-card');
  card.setAttribute('aria-label', 'This reply only planned');
  const head = element('div', 'plan-head');
  head.append(element('span', 'plan-title', 'Plan only · this reply changed nothing'));
  card.append(head);
  card.append(element('p', 'plan-note', 'Plan permission refuses every tool that changes anything, so this reply could only look and propose. Run it when you agree, or keep planning.'));
  const actions = element('div', 'plan-actions');
  const run = element('button', 'button primary compact', 'Run this plan');
  run.addEventListener('click', () => void runPlan(app, taskId));
  const keep = element('button', 'button secondary compact', 'Keep planning');
  keep.addEventListener('click', () => {
    $('#chat-input')?.focus();
    // The permission may have been changed by hand since this reply was written.
    app.showToast(effectivePermission(app.settings) === 'plan'
      ? 'Still in Plan: say what to change about the plan'
      : 'Say what to change about the plan (the permission is no longer Plan)');
  });
  actions.append(run, keep);
  card.append(actions);
  return card;
}

const RUN_PLAN = 'Run the plan you just proposed. Follow it step by step, verify each step, and tell me if anything turns out differently than planned.';

async function runPlan(app, taskId) {
  if (app.currentTaskId !== taskId) app.selectTask?.(taskId);
  // Nothing is changed until the request can actually go out: a click while another reply is
  // running must not drop the user out of Plan or throw their draft away.
  if (app.activeRequestId || app.demoBusy || app.compactingTasks?.has(app.currentTaskId)) {
    app.showToast('Wait for the running reply to finish, then run the plan');
    return;
  }
  const { setPermission } = await import('./composer-ui.js');
  const back = app.settings.prePlanPermission === 'manual' ? 'manual' : 'basic';
  const mode = await setPermission(app, back);
  if (mode === 'plan') {
    app.showToast('The permission could not be changed, so the plan was not run');
    return;
  }
  const input = $('#chat-input');
  const draft = input ? input.value : '';
  if (input) input.value = RUN_PLAN;
  app.updateSendEnabled?.();
  await app.handleSend?.();
  // Refused after all (a folder that is not open, for example): give the draft back.
  if (input && input.value === RUN_PLAN) {
    input.value = draft;
    app.updateSendEnabled?.();
  }
}
