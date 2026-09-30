/**
 * ScaleMax composer controls: the model menu (model, thinking on/off, reasoning effort), the
 * tool permissions menu (Manual / Basic / Bypass all, with a consent step), the mode chip and its
 * menu (Working / Coding, which decides the assistant's tools), the folder menu (the task's folder,
 * open another or a recent one, new tasks, project notes), and the prompt that asks the user to
 * approve a tool call. DOM is built with textContent and CSSOM only (CSP).
 */
import {
  MODE_IDS, PERMISSION_MODES, REASONING_EFFORTS, effectivePermission, folderName, isTaskLocked,
  modeInfo, modeSummary, normalizeMode,
} from './domain.mjs';

const $ = (selector) => document.querySelector(selector);
const PERMISSION_LABELS = { plan: 'Plan', manual: 'Manual', basic: 'Basic', bypass: 'Bypass all' };
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
  const options = catalog.filter((model) => model.chat !== false);
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
  button.disabled = chatBusy(app);
  const mode = app.settings.composerMode;
  if (mode === 'image' || mode === 'video') {
    const media = currentMediaModel(app, mode);
    const label = mode === 'image' ? 'Image' : 'Video';
    name.textContent = media?.displayName || `Choose a ${mode} model`;
    button.classList.toggle('empty', !media);
    if (reasoning) {
      reasoning.hidden = false;
      reasoning.textContent = label;
    }
    button.title = media ? `${label} model: ${media.id}. Click to change.` : `Choose a ${mode} model`;
    button.setAttribute('aria-label', `${label} model: ${media?.displayName || 'none'}. Change model`);
    if ($('#model-menu')?.matches(':popover-open')) renderModelMenu(app);
    return;
  }
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

/** Models of one kind ('image' | 'video') from a catalog. */
export function mediaModels(catalog, kind) {
  return (Array.isArray(catalog) ? catalog : []).filter((model) => model.output === kind && model.media);
}

/** The selected image or video model of the active provider, or null. */
export function currentMediaModel(app, kind) {
  const id = kind === 'image' ? app.settings.imageModel : app.settings.videoModel;
  return mediaModels(app.providerCatalog, kind).find((model) => model.id === id) || null;
}

// The menu's tab: which kind of model it lists. Opens on the composer's current mode.
let menuTab = 'chat';

// Saved providers, each with its models; the active one uses the live catalog.
function providerGroups(app) {
  const saved = Array.isArray(app.providerProfiles) ? app.providerProfiles : [];
  const activeId = app.provider?.profileId;
  const groups = saved.map((profile) => ({
    id: profile.id,
    name: profile.name,
    active: profile.id === activeId,
    configured: profile.id === activeId ? Boolean(app.provider?.configured) : profile.configured,
    models: profile.id === activeId ? (app.providerCatalog || []) : (profile.models || []),
  }));
  if (!groups.some((group) => group.active)) {
    groups.unshift({ id: activeId || 'default', name: app.provider?.profileName || 'Provider', active: true,
      configured: Boolean(app.provider?.configured), models: app.providerCatalog || [] });
  }
  return groups.sort((a, b) => Number(b.active) - Number(a.active));
}

function modelsForTab(app, group, tab) {
  if (tab !== 'chat') return mediaModels(group.models, tab);
  if (group.active) return chatModelOptions(app);
  return group.models.filter((model) => model.chat !== false);
}

function isChecked(app, group, model, tab) {
  if (!group.active || app.settings.composerMode !== tab) return false;
  if (tab === 'chat') return model.id === app.provider?.model;
  return model.id === (tab === 'image' ? app.settings.imageModel : app.settings.videoModel);
}

function modelOption(model, { checked, profileId, tab }) {
  const option = element('button', 'model-menu-option');
  option.dataset.modelId = model.id;
  option.dataset.profileId = profileId;
  option.dataset.tab = tab;
  option.setAttribute('role', 'radio');
  option.setAttribute('aria-checked', String(checked));
  const text = element('span', 'model-menu-option-text');
  text.append(element('span', 'picker-option-name', model.displayName || model.id),
    element('span', 'picker-option-id', model.id));
  option.append(text);
  if (model.available === false) {
    option.disabled = true;
    option.title = 'This model is currently unavailable.';
    option.append(element('span', 'badge', 'Unavailable'));
  } else if (tab === 'chat' && model.reasoning === true) {
    option.append(element('span', 'badge', 'Reasoning'));
  } else if (tab !== 'chat') {
    const price = priceLabel(model);
    if (price) option.append(element('span', 'badge', price));
  }
  return option;
}

/** A short list-price label for a media model ("$0.01–0.42", "$0.05/s"). */
export function priceLabel(model) {
  const pricing = model?.media?.pricing;
  if (!pricing) return '';
  const money = (value) => `$${value < 0.1 ? value.toFixed(3).replace(/0+$/, '') : value.toFixed(2)}`;
  if (model.media.kind === 'image') {
    if (pricing.min === null || pricing.max === null) return '';
    return pricing.min === pricing.max ? `${money(pricing.min)}/image` : `${money(pricing.min)}–${money(pricing.max).slice(1)}`;
  }
  const rates = Object.values(pricing.perSecond || {});
  return rates.length ? `from ${money(Math.min(...rates))}/s` : '';
}

function renderTabs(app) {
  for (const tab of document.querySelectorAll('#model-tabs [data-model-tab]')) {
    const kind = tab.dataset.modelTab;
    const count = providerGroups(app).reduce((total, group) => total + modelsForTab(app, group, kind).length, 0);
    tab.setAttribute('aria-selected', String(kind === menuTab));
    tab.textContent = `${kind[0].toUpperCase()}${kind.slice(1)}${count ? ` · ${count}` : ''}`;
  }
}

function renderModelMenu(app) {
  const list = $('#model-menu-list');
  if (!list) return;
  renderTabs(app);
  const groups = providerGroups(app);
  const several = groups.length > 1;
  const nodes = [];
  let total = 0;
  for (const group of groups) {
    const models = modelsForTab(app, group, menuTab);
    if (several) {
      const title = element('p', 'composer-menu-title model-menu-group', `${group.name}${group.active ? ' · active' : ''}`);
      nodes.push(title);
      if (!models.length) {
        nodes.push(element('p', 'status-text model-menu-note', group.configured
          ? `No ${menuTab} models on this provider.` : 'Not connected yet: add its key in Assistant.'));
      }
    }
    for (const model of models) {
      nodes.push(modelOption(model, { checked: isChecked(app, group, model, menuTab), profileId: group.id, tab: menuTab }));
    }
    total += models.length;
  }
  list.setAttribute('aria-label', `${menuTab[0].toUpperCase()}${menuTab.slice(1)} models`);
  list.replaceChildren(...nodes);
  const empty = $('#model-menu-empty');
  if (empty) {
    empty.hidden = total > 0;
    empty.textContent = !app.provider?.configured ? 'Connect a provider in Assistant first.'
      : `No ${menuTab} models are available with ${several ? 'these providers' : 'this key'}.`;
  }
  const reasoningSection = $('#model-menu-reasoning');
  if (reasoningSection) reasoningSection.hidden = menuTab !== 'chat';
  const mediaNote = $('#model-menu-media-note');
  if (mediaNote) {
    mediaNote.hidden = menuTab === 'chat' || total === 0;
    mediaNote.textContent = 'Pick a model to see its options above the message box. Nothing is generated (or billed) until you press Generate. Prices are the provider\'s list prices.';
  }
  if (menuTab !== 'chat') return;
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

function applyProviderMeta(app, meta) {
  app.provider = meta;
  app.providerCatalog = Array.isArray(meta.models) ? meta.models : app.providerCatalog;
  app.enabledModels = new Set(Array.isArray(meta.enabledModels) ? meta.enabledModels : []);
  app.selectedModel = meta.model;
  app.renderProviderStatus();
  app.renderProviderModels();
}

/** Reloads the saved providers (for the menu groups and the Assistant list). */
export async function refreshProfiles(app) {
  const bridge = providerBridge();
  if (!bridge?.profiles) return;
  const result = await bridge.profiles();
  if (!result?.ok) return;
  app.providerProfiles = result.data.profiles;
  window.dispatchEvent(new CustomEvent('scalemax:profiles-changed'));
  if ($('#model-menu')?.matches(':popover-open')) renderModelMenu(app);
}

// Switches to another saved provider when the model belongs to it; returns false on failure.
async function useProfile(app, profileId, chatModel) {
  const bridge = providerBridge();
  if (!profileId || profileId === app.provider?.profileId) return true;
  const result = await bridge?.selectProfile?.({ id: profileId, ...(chatModel ? { model: chatModel } : {}) });
  if (!result?.ok) {
    app.showToast(result?.error?.message || 'Could not switch provider');
    return false;
  }
  app.providerProfiles = result.data.profiles;
  const meta = await bridge.get();
  if (meta?.ok) applyProviderMeta(app, meta.data);
  window.dispatchEvent(new CustomEvent('scalemax:profiles-changed'));
  app.showToast(`Provider: ${app.provider?.profileName || 'switched'}`);
  return true;
}

async function chooseModel(app, id, profileId = app.provider?.profileId, tab = 'chat') {
  const bridge = providerBridge();
  if (!id || chatBusy(app)) return;
  if (tab !== 'chat') {
    if (!(await useProfile(app, profileId))) return;
    app.settings[tab === 'image' ? 'imageModel' : 'videoModel'] = id;
    app.settings.composerMode = tab;
    await app.persist('settings');
    renderModelButton(app);
    window.dispatchEvent(new CustomEvent('scalemax:composer-mode'));
    const model = currentMediaModel(app, tab);
    app.showToast(`${tab === 'image' ? 'Image' : 'Video'} model: ${model?.displayName || id}`);
    return;
  }
  const switching = profileId && profileId !== app.provider?.profileId;
  if (switching) {
    if (!(await useProfile(app, profileId, id))) return;
  } else if (id !== app.provider?.model) {
    if (!bridge?.setModel) return;
    const result = await bridge.setModel({ model: id });
    if (!result?.ok) {
      app.showToast(result?.error?.message || 'The model could not be changed');
      return;
    }
    applyProviderMeta(app, { ...result.data, profileId: app.provider?.profileId, profileName: app.provider?.profileName });
  }
  if (app.settings.composerMode !== 'chat') {
    app.settings.composerMode = 'chat';
    await app.persist('settings');
    window.dispatchEvent(new CustomEvent('scalemax:composer-mode'));
  }
  renderModelButton(app);
  const model = currentModel(app);
  app.showToast(`Model: ${model?.displayName || app.provider?.model}`);
}

async function updateReasoning(app, patch) {
  Object.assign(app.settings, patch);
  await app.persist('settings');
  renderModelButton(app);
  renderModelMenu(app);
}

// The provider's model list is reloaded once per start with the stored key, so new models (and
// capability data older saved lists lack) show up without testing the connection again.
export async function refreshCatalog(app) {
  const bridge = providerBridge();
  const catalog = Array.isArray(app.providerCatalog) ? app.providerCatalog : [];
  if (!bridge?.refreshModels || !app.provider?.configured || app.provider.kind === 'custom') return;
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
// Opens above the button when it fits (the composer usually sits at the bottom), otherwise on
// whichever side has more room; the menu never extends past the window and scrolls instead.
function placeAbove(menu, anchor, align) {
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const gap = 6;
  const spaceAbove = rect.top - gap - margin;
  const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
  menu.style.removeProperty('max-height');
  menu.style.removeProperty('top');
  menu.style.removeProperty('bottom');
  const cap = 520;
  const natural = Math.min(menu.scrollHeight, cap);
  const above = natural <= spaceAbove || spaceAbove >= spaceBelow;
  const room = Math.max(160, above ? spaceAbove : spaceBelow);
  menu.style.setProperty('max-height', `${Math.round(Math.min(room, cap))}px`);
  if (above) menu.style.setProperty('bottom', `${Math.round(window.innerHeight - rect.top + gap)}px`);
  else menu.style.setProperty('top', `${Math.round(rect.bottom + gap)}px`);
  const width = menu.offsetWidth;
  let left = align === 'end' ? rect.right - width : rect.left;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  menu.style.setProperty('left', `${Math.round(left)}px`);
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
    button.classList.toggle('is-plan', mode === 'plan');
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
  // Remembered so "Run this plan" can put the permission back where it was before planning.
  if (mode === 'plan' && current !== 'plan') app.settings.prePlanPermission = current;
  app.settings.permission = mode;
  app.settings.bypassConsent = mode === 'bypass';
  // Main reads the persisted settings for every chat request, so this must land first.
  await app.persist('settings');
  renderPermission(app);
  app.showToast(mode === 'bypass' ? 'Autonomous mode: all tool calls run without asking'
    : mode === 'plan' ? 'Plan: read-only until you run the plan'
      : mode === 'manual' ? 'Manual: every tool call asks first' : 'Basic: only changes ask first');
  return mode;
}

// ---- Mode (Working / Coding) -----------------------------------------------------

/**
 * Everything that shows the mode: the pills above the message box (only on an empty task), the chip
 * in the composer toolbar, the line under the pills, and the menu while it is open.
 */
export function renderMode(app) {
  const mode = normalizeMode(app.settings.mode);
  const info = modeInfo(mode);
  const busy = chatBusy(app);
  const chip = $('#mode-chip');
  const label = $('#mode-chip-label');
  if (chip && label) {
    label.textContent = info.label;
    // The chip's icon follows the mode (CSS picks one of the two in the markup).
    chip.dataset.mode = mode;
    chip.title = `${info.label}: ${info.note}`;
    chip.setAttribute('aria-label', `Mode: ${info.label}. ${info.note} Change mode`);
  }
  for (const button of document.querySelectorAll('#mode-switch .mode-btn[data-mode]')) {
    const pill = modeInfo(button.dataset.mode);
    const selected = pill.id === mode;
    button.classList.toggle('sm-scene-tabs__pill--active', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.title = pill.note;
    button.setAttribute('aria-label', `${pill.label} mode: ${pill.note}`);
    // The mode is read from the saved settings for the next request, so it waits for the reply.
    button.disabled = busy;
  }
  const note = $('#mode-note');
  if (note) note.textContent = info.note;
  if ($('#mode-menu')?.matches(':popover-open')) renderModeMenu(app);
}

/** The mode chip's menu: one option per mode, and a dim line with what the active mode can use. */
export function renderModeMenu(app) {
  const menu = $('#mode-menu');
  if (!menu) return;
  const mode = normalizeMode(app.settings.mode);
  const busy = chatBusy(app);
  const nodes = [element('p', 'composer-menu-title', 'Mode')];
  for (const id of MODE_IDS) {
    const info = modeInfo(id);
    const option = element('button', 'composer-menu-option');
    option.dataset.mode = id;
    option.setAttribute('role', 'menuitemradio');
    option.setAttribute('aria-checked', String(id === mode));
    option.disabled = busy;
    option.append(element('span', 'composer-menu-option-name', info.label),
      element('span', 'composer-menu-option-desc', info.desc),
      element('span', 'composer-menu-option-desc mode-option-detail', info.detail));
    nodes.push(option);
  }
  if (busy) nodes.push(element('p', 'mode-menu-reason', 'Wait for the reply to finish'));
  nodes.push(element('p', 'mode-menu-tools', `${modeInfo(mode).label} can use: ${modeSummary(mode)}`));
  const focused = menu.contains(document.activeElement);
  menu.replaceChildren(...nodes);
  // Rebuilt while open (a reply started or ended): keyboard focus stays in the menu.
  if (focused) menu.querySelector('button:not(:disabled)')?.focus();
}

/** Switches the mode. The pills and the chip both come through here, so they cannot disagree. */
export async function setMode(app, mode) {
  const next = normalizeMode(mode);
  const current = normalizeMode(app.settings.mode);
  // A reply already went out with the old mode; changing it now would only confuse.
  if (next === current || chatBusy(app)) {
    renderMode(app);
    return current;
  }
  app.settings.mode = next;
  // Main reads the persisted settings for every chat request, so this must land first.
  await app.persist('settings');
  renderMode(app);
  app.showToast(`${modeInfo(next).label} mode: ${modeInfo(next).note}`);
  return next;
}

// ---- Tool approval prompts -------------------------------------------------------

const approvals = { queue: [], showing: null };

function approvalBridge() {
  return window.scalemaxAPI?.approvals || null;
}

// Built-in workspace tools (lib/workspace-tools.cjs) act on the folder the user opened.
// `where` names the task's folder: with several tasks at once it may not be the one on screen.
const WORKSPACE_SUMMARIES = {
  write_file: (where) => `The model wants to create or replace a file in ${where}. A replaced file is backed up first.`,
  edit_file: (where) => `The model wants to change part of a file in ${where}. The previous version is backed up first.`,
  run_command: (where, args) => (args.background === true
    ? `The model wants to start a command in ${where} that keeps running in the background, like a dev server or a watcher. It runs until it ends, the model or you stop it, or ScaleMax quits.`
    : `The model wants to run a command in ${where}. It stops at its time limit (2 minutes unless the model asks for up to 10) or when you press Stop.`),
  job_input: (where) => `The model wants to type into a background command running in ${where}.`,
  job_stop: (where) => `The model wants to stop a background command in ${where}, and everything it started.`,
};
// How a command runs (main says, from Preferences > Commands).
const SANDBOX_NOTES = {
  on: ' It runs in the sandbox: it can change files only in this folder, temporary folders and package caches.',
  offline: ' It runs in the sandbox without network: it can change files only in this folder, temporary folders and package caches.',
};
// The arguments as the prompt shows them (JSON, cut at 4 KB), or {} when they do not parse.
function approvalArguments(request) {
  try {
    const value = JSON.parse(request.arguments);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
// Working-mode tools that reach past the folder (lib/computer-tools.cjs).
const COMPUTER_SUMMARIES = {
  read_clipboard: 'The model wants to read what is on your clipboard. It may hold a password or other private text, so ScaleMax always asks first.',
  write_clipboard: 'The model wants to put text on your clipboard, replacing what is on it now.',
  open: 'The model wants to open something in the app that owns it.',
  reveal: 'The model wants to show a file of your project in the Finder.',
};
function approvalSummary(request) {
  if (request.kind === 'workspace') {
    const where = request.folderName ? `the folder "${request.folderName}"` : 'your workspace folder';
    if (request.reason === 'unsandboxed' || request.reason === 'unsandboxed-input') {
      const action = request.reason === 'unsandboxed-input' ? 'type into a command' : 'run a command';
      return `The model wants to ${action} in ${where} outside the sandbox. There it can change any of your files, read credential folders such as ~/.ssh and use the network. ScaleMax asks about this every time, whatever the permission mode.`;
    }
    const summary = WORKSPACE_SUMMARIES[request.toolName];
    if (!summary) return `The model wants to read files in ${where}.`;
    return summary(where, approvalArguments(request)) + (request.toolName === 'run_command' ? SANDBOX_NOTES[request.sandbox] || '' : '');
  }
  // An address the model put together itself: it could carry what the reply read to that site.
  if (request.reason === 'egress') {
    const what = request.kind === 'computer' ? 'open an address in your browser' : 'open a page';
    if (!request.host) return `The model wants to ${what}, but its address could not be read. Check the arguments below before allowing it.`;
    return `The model wants to ${what} on ${request.host} with an address it wrote itself. Addresses from your messages, your files, search results and pages it read open without asking; one the model makes up could carry text from this conversation to that site. Check the address below.`;
  }
  if (request.kind === 'computer') {
    return COMPUTER_SUMMARIES[request.toolName] || 'The model wants to use your clipboard or open something on your computer.';
  }
  if (request.kind === 'web') return 'The model wants to search the web or read a page.';
  if (request.claimsReadOnly) {
    return `The model wants to run "${request.toolName}" on ${request.serverName}. The server says this tool only reads data, but ScaleMax cannot check that. If you trust this server, turn on "Trust its read-only labels" for it in Assistant → MCP servers.`;
  }
  return request.readOnly
    ? `The model wants to run "${request.toolName}" on ${request.serverName}. You trust this server's label that the tool only reads data.`
    : `The model wants to run "${request.toolName}" on ${request.serverName}. This tool can change data there.`;
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
  // Several tasks can work at once: a prompt from a task in the background names it.
  const reply = approvals.app?.replyFor?.(request.requestId);
  const task = reply && reply.taskId !== approvals.app.currentTaskId
    ? approvals.app.tasks.find((item) => item.id === reply.taskId) : null;
  $('#approval-eyebrow').textContent = automation ? 'Tool call · Automation' : task ? `Tool call · ${task.title}` : 'Tool call';
  // A call that always asks (a command outside the sandbox, the clipboard) is allowed one at a
  // time; an address the model made up can be allowed for its site, for the rest of this reply.
  const egress = request.reason === 'egress' && Boolean(request.host);
  const always = Boolean(request.reason) && !egress;
  const outside = request.reason === 'unsandboxed' || request.reason === 'unsandboxed-input';
  $('#approval-title').textContent = request.reason === 'unsandboxed-input'
    ? 'Type into this command outside the sandbox?'
    : outside ? 'Run this command outside the sandbox?'
      : egress ? `Open an address on ${request.host || 'this site'}?` : `Allow ${request.serverName} · ${request.toolName}?`;
  $('#approval-summary').textContent = approvalSummary(request);
  $('#approval-arguments').textContent = request.arguments || '{}';
  const all = $('#approval-all');
  if (all) {
    all.hidden = always;
    all.textContent = egress ? `Allow ${request.host || 'this site'} in this reply` : 'Allow all in this reply';
  }
  dialog.classList.toggle('is-unsandboxed', outside);
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
  // "Allow all in this reply" also answers the other prompts already waiting for this reply,
  // except those that must always ask.
  const siblings = decision === 'request' && !request.reason
    ? approvals.queue.filter((item) => item.requestId === request.requestId && !item.reason) : [];
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
  approvals.app = app;
  bridge.onRequest((request) => {
    if (!request || typeof request.approvalId !== 'string') return;
    approvals.queue.push({
      approvalId: request.approvalId,
      requestId: String(request.requestId || ''),
      serverName: String(request.serverName || request.serverId || 'MCP server'),
      kind: ['workspace', 'web', 'computer'].includes(request.kind) ? request.kind : 'mcp',
      toolName: String(request.toolName || 'tool'),
      readOnly: request.readOnly === true,
      arguments: String(request.arguments || '{}'),
      folderName: typeof request.folderName === 'string' ? request.folderName.slice(0, 255) : '',
      // Why it always asks ('unsandboxed', 'egress', or another reason main gives), and how a command runs.
      reason: typeof request.reason === 'string' && request.reason
        ? (['unsandboxed', 'unsandboxed-input', 'egress', 'private'].includes(request.reason) ? request.reason : 'required') : '',
      host: typeof request.host === 'string' ? request.host.slice(0, 255) : '',
      claimsReadOnly: request.claimsReadOnly === true,
      sandbox: ['on', 'offline', 'off'].includes(request.sandbox) ? request.sandbox : '',
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

// ---- Workspace folder --------------------------------------------------------------

// Recent folders listed besides the open one (main remembers up to eight).
const RECENT_FOLDERS_SHOWN = 5;

function chatBusy(app) {
  return Boolean(app.activeRequestId || app.demoBusy || app.compactingTasks?.has?.(app.currentTaskId));
}

function folderOption(action, name, desc) {
  const option = element('button', 'composer-menu-option');
  option.setAttribute('role', 'menuitem');
  option.dataset.folderAction = action;
  option.append(element('span', 'composer-menu-option-name', name));
  if (desc) option.append(element('span', 'composer-menu-option-desc', desc));
  return option;
}

function notesOption(app) {
  const notes = folderOption('init', 'Write project notes (/init)', 'ScaleMax reads the project and writes .scalemax/SCALEMAX.md');
  // It is a chat request, and only one runs at a time.
  notes.disabled = chatBusy(app);
  return notes;
}

/**
 * The folder chip's menu. Before the task's first message: its folder, open another one, project
 * notes, recent folders. Once the task is fixed to its folder: that folder and new tasks instead.
 */
export function renderFolderMenu(app) {
  const menu = $('#folder-menu');
  if (!menu) return;
  const root = app.workspace?.root || '';
  const task = typeof app.currentTask === 'function' ? app.currentTask() : null;
  const locked = isTaskLocked(task);
  const folder = task?.folder || (root ? { name: folderName(root), path: root } : null);
  const title = locked ? 'Task folder' : 'Folder for this task';
  menu.setAttribute('aria-label', title);
  const nodes = [element('p', 'composer-menu-title', title)];
  if (folder) {
    const current = element('div', 'folder-menu-current');
    current.append(element('span', 'composer-menu-option-name', folder.name), element('span', 'folder-menu-path', folder.path));
    if (locked) current.append(element('span', 'folder-menu-note', 'A task stays in the folder it started in.'));
    nodes.push(current);
  }
  if (locked) {
    nodes.push(folderOption('new-here', 'New task in this folder'),
      folderOption('new-other', 'New task in another folder…'),
      folderOption('show', 'Show in Workspace'),
      notesOption(app));
  } else {
    nodes.push(folderOption('open', 'Open folder…', 'Choose the folder this task works in'));
    if (root) nodes.push(folderOption('show', 'Show in Workspace'), notesOption(app));
  }
  const recent = locked ? [] : (Array.isArray(app.workspace?.recent) ? app.workspace.recent : [])
    .filter((item) => typeof item?.path === 'string' && item.path && item.path !== root && item.path !== folder?.path)
    .slice(0, RECENT_FOLDERS_SHOWN);
  if (recent.length) {
    const group = element('div', 'folder-menu-recent');
    const title = element('p', 'composer-menu-title model-menu-group', 'Recent');
    title.id = 'folder-menu-recent-title';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-labelledby', title.id);
    group.append(title);
    for (const item of recent) {
      const option = folderOption('recent', typeof item.name === 'string' && item.name ? item.name : folderName(item.path));
      option.dataset.folderPath = item.path;
      option.append(element('span', 'folder-menu-path', item.path));
      group.append(option);
    }
    nodes.push(group);
  }
  const focused = menu.contains(document.activeElement);
  menu.replaceChildren(...nodes);
  // Rebuilt while open (the folder changed underneath): keyboard focus stays in the menu.
  if (focused) menu.querySelector('button:not(:disabled)')?.focus();
}

// "/init" goes through the normal send path; main turns it into "read the project and rewrite
// .scalemax/SCALEMAX.md". A draft or attachment the user was preparing stays in the composer.
function writeProjectNotes(app) {
  const input = $('#chat-input');
  // handleSend opens the task's folder first (or says why it cannot).
  if (!input || chatBusy(app)) return;
  if (app.settings.composerMode !== 'chat') {
    // Project notes come from a chat request, never from an image or video prompt.
    app.settings.composerMode = 'chat';
    void app.persist('settings');
    renderModelButton(app);
    window.dispatchEvent(new CustomEvent('scalemax:composer-mode'));
  }
  const draft = input.value;
  const attachment = app.attachment;
  input.value = '/init';
  // Main only recognises a message that is exactly "/init", so no attachment rides along.
  app.attachment = null;
  // handleSend takes the text and the attachment before its first await.
  void app.handleSend();
  app.attachment = attachment;
  input.value = draft;
  app.updateSendEnabled();
}

function bindFolderMenu(app) {
  const menu = $('#folder-menu');
  bindPopover('#folder-menu', '#folder-chip', 'start', () => renderFolderMenu(app));
  bindArrowKeys(menu, '.composer-menu-option');
  menu?.addEventListener('click', (event) => {
    const option = event.target.closest('[data-folder-action]');
    if (!option || option.disabled) return;
    menu.hidePopover?.();
    const action = option.dataset.folderAction;
    if (action === 'open') void app.openWorkspace();
    else if (action === 'show') app.switchView('workspace');
    else if (action === 'init') writeProjectNotes(app);
    else if (action === 'recent') void app.openWorkspaceAt(option.dataset.folderPath);
    else if (action === 'new-here') app.newTask({ folder: app.currentTask()?.folder });
    else if (action === 'new-other') void app.newTaskInAnotherFolder();
  });
}

// ---- Wiring ----------------------------------------------------------------------

export function bindComposerUi(app) {
  if (!app || bound.has(app)) return;
  bound.add(app);
  bindPopover('#model-menu', '#model-button', 'end', () => {
    menuTab = ['image', 'video'].includes(app.settings.composerMode) ? app.settings.composerMode : 'chat';
    renderModelMenu(app);
    void refreshProfiles(app);
  });
  bindPopover('#permission-menu', '#permission-button', 'start', () => renderPermission(app));
  bindPopover('#mode-menu', '#mode-chip', 'start', () => renderModeMenu(app));
  bindArrowKeys($('#model-menu-list'), '.model-menu-option');
  bindArrowKeys($('#permission-menu'), '.composer-menu-option');
  bindArrowKeys($('#mode-menu'), '.composer-menu-option');
  bindFolderMenu(app);

  $('#model-tabs')?.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-model-tab]');
    if (!tab || tab.dataset.modelTab === menuTab) return;
    menuTab = tab.dataset.modelTab;
    renderModelMenu(app);
    const menu = $('#model-menu');
    const button = $('#model-button');
    if (menu && button && menu.matches(':popover-open')) placeAbove(menu, button, 'end');
  });
  $('#model-tabs')?.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const tabs = [...document.querySelectorAll('#model-tabs [data-model-tab]')];
    const index = tabs.findIndex((tab) => tab.dataset.modelTab === menuTab);
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    menuTab = next.dataset.modelTab;
    renderModelMenu(app);
    next.focus();
  });
  $('#model-menu-list')?.addEventListener('click', (event) => {
    const option = event.target.closest('.model-menu-option[data-model-id]');
    if (!option || option.disabled) return;
    void chooseModel(app, option.dataset.modelId, option.dataset.profileId, option.dataset.tab)
      .then(() => {
        renderModelMenu(app);
        // A media model is picked for its options, which appear above the message box.
        if (option.dataset.tab !== 'chat') $('#model-menu')?.hidePopover?.();
      });
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
  $('#mode-menu')?.addEventListener('click', (event) => {
    const option = event.target.closest('[data-mode]');
    if (!option || option.disabled) return;
    $('#mode-menu')?.hidePopover?.();
    void setMode(app, option.dataset.mode);
  });
  bindApprovals(app);
  renderPermission(app);
  renderMode(app);
  renderModelButton(app);
  void refreshCatalog(app);
  void refreshProfiles(app);
}
