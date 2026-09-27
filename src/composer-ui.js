/**
 * ScaleMax composer controls: the model menu (model, thinking on/off, reasoning effort), the
 * tool permissions menu (Manual / Basic / Bypass all, with a consent step), and the prompt that
 * asks the user to approve a tool call. DOM is built with textContent and CSSOM only (CSP).
 */
import { PERMISSION_MODES, REASONING_EFFORTS, effectivePermission } from './domain.mjs';

const $ = (selector) => document.querySelector(selector);
const PERMISSION_LABELS = { manual: 'Manual', basic: 'Basic', bypass: 'Bypass all' };
const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High' };
const bound = new WeakSet();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tag === 'button') node.type = 'button';
  return node;
}

function providerBridge() {
  return window.scalemaxAPI?.provider || null;
}

// ---- Model and reasoning ---------------------------------------------------

/** Chat models the menu offers: available, not image/video-only. */
export function chatModelOptions(app) {
  const catalog = Array.isArray(app.providerCatalog) ? app.providerCatalog : [];
  const options = catalog.filter((model) => model.available !== false && model.chat !== false);
  const current = app.provider?.model;
  // A custom provider has no catalog: its one configured model is the only choice.
  if (current && !options.some((model) => model.id === current)) {
    options.unshift({ id: current, displayName: current, chat: null, reasoning: null });
  }
  return options;
}

function currentModel(app) {
  const id = app.provider?.model || '';
  return chatModelOptions(app).find((model) => model.id === id) || null;
}

/**
 * What the reasoning controls can do for a model.
 * @returns {{supported: boolean, known: boolean, levels: string[], locked: string|null}}
 */
export function reasoningSupport(model) {
  if (!model) return { supported: false, known: false, levels: [], locked: null };
  const supported = model.reasoning === true;
  const levels = supported && Array.isArray(model.effortLevels) && model.effortLevels.length
    ? REASONING_EFFORTS.filter((level) => model.effortLevels.includes(level)) : [...REASONING_EFFORTS];
  const locked = supported && model.effortLocked && model.defaultEffort ? model.defaultEffort : null;
  return { supported, known: model.reasoning === true || model.reasoning === false, levels, locked };
}

/** The effort that is actually sent for this model (a locked or restricted model adjusts it). */
export function effectiveEffort(model, wanted) {
  const support = reasoningSupport(model);
  if (support.locked) return support.locked;
  if (support.levels.includes(wanted)) return wanted;
  const index = REASONING_EFFORTS.indexOf(wanted);
  return [...support.levels].sort((a, b) => Math.abs(REASONING_EFFORTS.indexOf(a) - index)
    - Math.abs(REASONING_EFFORTS.indexOf(b) - index))[0] || 'medium';
}

export function renderModelButton(app) {
  const name = $('#model-button-name');
  const reasoning = $('#model-button-reasoning');
  const button = $('#model-button');
  if (!name || !button) return;
  const model = currentModel(app);
  const configured = Boolean(app.provider?.configured);
  const id = app.provider?.model || '';
  name.textContent = model?.displayName || id || (configured ? 'No model selected' : 'No provider connected');
  button.classList.toggle('empty', !id);
  const support = reasoningSupport(model);
  let suffix = '';
  if (support.supported) {
    suffix = app.settings.thinking === false
      ? 'Thinking off'
      : `Thinking · ${EFFORT_LABELS[effectiveEffort(model, app.settings.reasoningEffort)]}`;
  }
  if (reasoning) {
    reasoning.hidden = !suffix;
    reasoning.textContent = suffix;
  }
  button.title = id ? `Model: ${id}${suffix ? ` (${suffix})` : ''}. Click to change.` : 'Choose a model';
  button.setAttribute('aria-label', `Model: ${model?.displayName || id || 'none'}${suffix ? `, ${suffix}` : ''}. Change model and reasoning`);
  if ($('#model-menu')?.matches(':popover-open')) renderModelMenu(app);
}

function renderModelMenu(app) {
  const list = $('#model-menu-list');
  if (!list) return;
  const options = chatModelOptions(app);
  const active = app.provider?.model || '';
  const custom = app.provider?.kind === 'custom';
  list.replaceChildren(...options.map((model) => {
    const option = element('button', 'model-menu-option');
    option.dataset.modelId = model.id;
    option.setAttribute('role', 'radio');
    option.setAttribute('aria-checked', String(model.id === active));
    const text = element('span', 'model-menu-option-text');
    text.append(element('span', 'picker-option-name', model.displayName || model.id),
      element('span', 'picker-option-id', model.id));
    option.append(text);
    if (model.reasoning === true) option.append(element('span', 'badge', 'Reasoning'));
    if (custom && model.id === active && options.length === 1) option.title = 'Change the custom model in Assistant.';
    return option;
  }));
  const empty = $('#model-menu-empty');
  if (empty) {
    empty.hidden = options.length > 0;
    empty.textContent = app.provider?.configured ? 'No chat models are available.' : 'Connect a provider in Assistant first.';
  }
  const model = currentModel(app);
  const support = reasoningSupport(model);
  const thinkingOn = app.settings.thinking !== false;
  const toggle = $('#thinking-toggle');
  if (toggle) {
    toggle.setAttribute('aria-checked', String(support.supported && thinkingOn));
    toggle.disabled = !support.supported;
  }
  const effort = effectiveEffort(model, app.settings.reasoningEffort);
  for (const option of document.querySelectorAll('#effort-options [data-effort]')) {
    const level = option.dataset.effort;
    option.setAttribute('aria-checked', String(support.supported && thinkingOn && level === effort));
    option.disabled = !support.supported || !thinkingOn || !support.levels.includes(level)
      || Boolean(support.locked && level !== support.locked);
  }
  const note = $('#reasoning-note');
  if (note) {
    let text = '';
    if (!model) text = '';
    else if (!support.known) text = 'This provider does not report reasoning support for this model, so no reasoning settings are sent.';
    else if (!support.supported) text = `${model.displayName || model.id} has no reasoning controls.`;
    else if (!thinkingOn) text = 'Thinking is off: the model answers directly.';
    else if (support.locked) text = `Reasoning effort is fixed at ${EFFORT_LABELS[support.locked]} for this model.`;
    else if (support.levels.length < REASONING_EFFORTS.length) text = `This model supports ${support.levels.map((level) => EFFORT_LABELS[level]).join(', ')}.`;
    note.textContent = text;
    note.hidden = !text;
  }
}

async function chooseModel(app, id) {
  const bridge = providerBridge();
  if (!bridge?.setModel || !id || id === app.provider?.model) return;
  const result = await bridge.setModel({ model: id });
  if (!result?.ok) {
    app.showToast(result?.error?.message || 'The model could not be changed');
    return;
  }
  app.provider = result.data;
  app.providerCatalog = Array.isArray(result.data.models) ? result.data.models : app.providerCatalog;
  app.enabledModels = new Set(Array.isArray(result.data.enabledModels) ? result.data.enabledModels : []);
  app.selectedModel = result.data.model;
  app.renderProviderStatus();
  app.renderProviderModels();
  const model = currentModel(app);
  app.showToast(`Model: ${model?.displayName || result.data.model}`);
}

async function updateReasoning(app, patch) {
  Object.assign(app.settings, patch);
  await app.persist('settings');
  renderModelButton(app);
  renderModelMenu(app);
}

// Older saved catalogs have no capability data; refresh them once with the stored key.
async function refreshCatalogIfNeeded(app) {
  const bridge = providerBridge();
  const catalog = Array.isArray(app.providerCatalog) ? app.providerCatalog : [];
  if (!bridge?.refreshModels || !app.provider?.configured || app.provider.kind === 'custom') return;
  if (catalog.length && catalog.some((model) => model.chat === true || model.chat === false)) return;
  const result = await bridge.refreshModels();
  if (!result?.ok) return;
  app.provider = result.data;
  app.providerCatalog = Array.isArray(result.data.models) ? result.data.models : catalog;
  app.enabledModels = new Set(Array.isArray(result.data.enabledModels) ? result.data.enabledModels : []);
  app.renderProviderStatus();
  app.renderProviderModels();
}

// Popovers render in the top layer; they are placed above their button (the composer sits at
// the bottom of the window) and kept inside the viewport.
function placeAbove(menu, anchor, align) {
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const margin = 8;
  let left = align === 'end' ? rect.right - width : rect.left;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  menu.style.setProperty('left', `${Math.round(left)}px`);
  menu.style.setProperty('bottom', `${Math.round(window.innerHeight - rect.top + 6)}px`);
}

function bindPopover(menuSelector, buttonSelector, align, onOpen) {
  const menu = $(menuSelector);
  const button = $(buttonSelector);
  if (!menu || !button || typeof menu.showPopover !== 'function') return;
  button.addEventListener('click', () => {
    if (menu.matches(':popover-open')) {
      menu.hidePopover();
      return;
    }
    onOpen();
    menu.showPopover();
    placeAbove(menu, button, align);
    (menu.querySelector('[aria-checked="true"]:not(:disabled)') || menu.querySelector('button:not(:disabled)'))?.focus();
  });
  menu.addEventListener('toggle', (event) => {
    const open = event.newState === 'open';
    button.setAttribute('aria-expanded', String(open));
    if (!open && menu.contains(document.activeElement)) button.focus();
  });
  window.addEventListener('resize', () => { if (menu.matches(':popover-open')) placeAbove(menu, button, align); });
}

// Arrow keys move between the options of a menu.
function bindArrowKeys(menu, selector) {
  menu?.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...menu.querySelectorAll(selector)].filter((node) => !node.disabled);
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next].focus();
  });
}

// ---- Permissions ---------------------------------------------------------------

export function renderPermission(app) {
  const mode = effectivePermission(app.settings);
  const label = $('#permission-label');
  if (label) label.textContent = PERMISSION_LABELS[mode];
  const button = $('#permission-button');
  if (button) {
    button.classList.toggle('is-bypass', mode === 'bypass');
    button.setAttribute('aria-label', `Tool permissions: ${PERMISSION_LABELS[mode]}. Change permissions`);
  }
  for (const option of document.querySelectorAll('#permission-menu [data-permission]')) {
    option.setAttribute('aria-checked', String(option.dataset.permission === mode));
  }
  const select = $('#permission-select');
  if (select) select.value = mode;
}

function askBypassConsent() {
  const dialog = $('#bypass-dialog');
  if (!dialog) return Promise.resolve(false);
  return new Promise((resolve) => {
    const confirm = $('#bypass-confirm');
    const cancel = $('#bypass-cancel');
    let answered = false;
    const finish = (yes) => {
      if (answered) return;
      answered = true;
      confirm?.removeEventListener('click', onYes);
      cancel?.removeEventListener('click', onNo);
      dialog.removeEventListener('close', onNo);
      if (dialog.open) dialog.close();
      resolve(yes);
    };
    const onYes = () => finish(true);
    const onNo = () => finish(false);
    confirm?.addEventListener('click', onYes);
    cancel?.addEventListener('click', onNo);
    dialog.addEventListener('close', onNo);
    dialog.showModal();
    // Focus starts on Cancel: the safe choice.
    cancel?.focus();
  });
}

/** Switches the permission mode. Bypass asks for consent first; returns the mode now in effect. */
export async function setPermission(app, mode) {
  if (!PERMISSION_MODES.includes(mode)) return effectivePermission(app.settings);
  const current = effectivePermission(app.settings);
  if (mode === current) { renderPermission(app); return current; }
  if (mode === 'bypass' && !(await askBypassConsent())) {
    renderPermission(app);
    app.showToast('Permissions unchanged');
    return current;
  }
  app.settings.permission = mode;
  app.settings.bypassConsent = mode === 'bypass';
  // Main reads the persisted settings for every chat request, so this must land first.
  await app.persist('settings');
  renderPermission(app);
  app.showToast(mode === 'bypass' ? 'Autonomous mode: all tool calls run without asking'
    : mode === 'manual' ? 'Manual: every tool call asks first' : 'Basic: only changes ask first');
  return mode;
}

// ---- Tool approval prompts -------------------------------------------------------

const approvals = { queue: [], showing: null };

function approvalBridge() {
  return window.scalemaxAPI?.approvals || null;
}

function showNextApproval() {
  const dialog = $('#tool-approval-dialog');
  if (!dialog) return;
  const request = approvals.queue[0] || null;
  approvals.showing = request;
  if (!request) {
    // `showing` is cleared first, so this close is not read as a denial.
    if (dialog.open) dialog.close();
    return;
  }
  const automation = typeof request.requestId === 'string' && request.requestId.startsWith('automation-');
  $('#approval-eyebrow').textContent = automation ? 'Tool call · Automation' : 'Tool call';
  $('#approval-title').textContent = `Allow ${request.serverName} · ${request.toolName}?`;
  $('#approval-summary').textContent = request.readOnly
    ? `The model wants to run "${request.toolName}" on ${request.serverName}. The server says this tool only reads data.`
    : `The model wants to run "${request.toolName}" on ${request.serverName}. This tool can change data there.`;
  $('#approval-arguments').textContent = request.arguments || '{}';
  const queue = $('#approval-queue');
  if (queue) {
    queue.hidden = approvals.queue.length < 2;
    queue.textContent = `${approvals.queue.length} waiting`;
  }
  if (!dialog.open) dialog.showModal();
  $('#approval-once')?.focus();
}

async function answerApproval(app, decision) {
  const request = approvals.showing;
  if (!request) return;
  approvals.queue = approvals.queue.filter((item) => item.approvalId !== request.approvalId);
  // "Allow all in this reply" also answers the other prompts already waiting for this reply.
  const siblings = decision === 'request'
    ? approvals.queue.filter((item) => item.requestId === request.requestId) : [];
  approvals.queue = approvals.queue.filter((item) => !siblings.includes(item));
  showNextApproval();
  const bridge = approvalBridge();
  for (const item of [request, ...siblings]) {
    const result = await bridge?.respond({ approvalId: item.approvalId, decision: item === request ? decision : 'once' });
    if (!result?.ok || !result.data?.accepted) app.showToast('That tool request had already ended');
  }
}

function bindApprovals(app) {
  const bridge = approvalBridge();
  const dialog = $('#tool-approval-dialog');
  if (!bridge?.onRequest || !dialog) return;
  bridge.onRequest((request) => {
    if (!request || typeof request.approvalId !== 'string') return;
    approvals.queue.push({
      approvalId: request.approvalId,
      requestId: String(request.requestId || ''),
      serverName: String(request.serverName || request.serverId || 'MCP server'),
      toolName: String(request.toolName || 'tool'),
      readOnly: request.readOnly === true,
      arguments: String(request.arguments || '{}'),
    });
    if (!approvals.showing) {
      showNextApproval();
      return;
    }
    // One prompt is on screen; only the waiting count changes.
    const queue = $('#approval-queue');
    if (queue) {
      queue.hidden = false;
      queue.textContent = `${approvals.queue.length} waiting`;
    }
  });
  bridge.onClosed?.((info) => {
    approvals.queue = approvals.queue.filter((item) => item.approvalId !== info?.approvalId);
    if (approvals.showing?.approvalId === info?.approvalId) showNextApproval();
  });
  $('#approval-once')?.addEventListener('click', () => void answerApproval(app, 'once'));
  $('#approval-all')?.addEventListener('click', () => void answerApproval(app, 'request'));
  $('#approval-deny')?.addEventListener('click', () => void answerApproval(app, 'deny'));
  // Escape denies. Chromium closes a modal that opened without a user gesture straight away,
  // without a cancel event, so any close that did not come from an answer is a denial too.
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    void answerApproval(app, 'deny');
  });
  dialog.addEventListener('close', () => {
    if (approvals.showing) void answerApproval(app, 'deny');
  });
}

// ---- Wiring ----------------------------------------------------------------------

export function bindComposerUi(app) {
  if (!app || bound.has(app)) return;
  bound.add(app);
  bindPopover('#model-menu', '#model-button', 'end', () => renderModelMenu(app));
  bindPopover('#permission-menu', '#permission-button', 'start', () => renderPermission(app));
  bindArrowKeys($('#model-menu-list'), '.model-menu-option');
  bindArrowKeys($('#permission-menu'), '.composer-menu-option');

  $('#model-menu-list')?.addEventListener('click', (event) => {
    const option = event.target.closest('.model-menu-option[data-model-id]');
    if (!option) return;
    void chooseModel(app, option.dataset.modelId).then(() => renderModelMenu(app));
  });
  $('#thinking-toggle')?.addEventListener('click', () => {
    void updateReasoning(app, { thinking: app.settings.thinking === false });
  });
  $('#effort-options')?.addEventListener('click', (event) => {
    const option = event.target.closest('[data-effort]');
    if (!option || option.disabled) return;
    void updateReasoning(app, { reasoningEffort: option.dataset.effort });
  });
  $('#permission-menu')?.addEventListener('click', (event) => {
    const option = event.target.closest('[data-permission]');
    if (!option) return;
    $('#permission-menu')?.hidePopover?.();
    void setPermission(app, option.dataset.permission);
  });
  bindApprovals(app);
  renderPermission(app);
  renderModelButton(app);
  void refreshCatalogIfNeeded(app);
}
