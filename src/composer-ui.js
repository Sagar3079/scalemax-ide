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
  // The context meter beside this button reads the model's published window.
  app.renderContextMeter?.();
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
  const name = model.displayName || model.id;
  text.append(element('span', 'picker-option-name', name));
  // Endpoints without display names would print the id twice.
  if (name !== model.id) text.append(element('span', 'picker-option-id', model.id));
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

// Why the last pick failed, said inside the menu: the menu is in the top layer, so a toast would
// print under it. Cleared when the menu opens and on the next pick.
let menuError = '';

// The two lines the menu builds itself (its markup is in src/index.html): the error of a pick,
// above the list, and "Open Assistant" under the empty text.
function menuExtras(app) {
  const list = $('#model-menu-list');
  const empty = $('#model-menu-empty');
  let error = $('#model-menu-error');
  if (!error && list?.before) {
    error = element('p', 'status-text model-menu-note model-menu-error');
    error.id = 'model-menu-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    list.before(error);
  }
  let open = $('#model-menu-assistant');
  if (!open && empty?.after) {
    open = element('button', 'button secondary compact model-menu-assistant', 'Open Assistant');
    open.id = 'model-menu-assistant';
    open.hidden = true;
    open.addEventListener('click', () => {
      $('#model-menu')?.hidePopover?.();
      // The sidebar's own Assistant item: the same way there, and the keyboard lands on it.
      const item = $('#sidebar-nav .sidebar-item[data-view="assistant"]');
      if (item) {
        item.click();
        item.focus();
      } else {
        app.switchView?.('assistant');
      }
    });
    empty.after(open);
  }
  return { error, open };
}

// A failed pick: main's message as it is, in the menu while it is open (else a toast).
function reportModelError(app, message) {
  if ($('#model-menu')?.matches?.(':popover-open')) {
    menuError = message;
    renderModelMenu(app);
  } else {
    app.showToast(message);
  }
}

// Where the keyboard starts in the model list: the selected model, else the first one.
function modelMenuStart(list) {
  return list?.querySelector('.model-menu-option[aria-checked="true"]:not(:disabled)')
    || list?.querySelector('.model-menu-option:not(:disabled)') || null;
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
  // The list is drawn again while open (the saved providers arrive, a model was picked): the
  // keyboard focus stays on the same model instead of falling back to the page.
  const active = document.activeElement;
  const focused = active && list.contains(active) ? active : null;
  const lost = !focused && (!active || active === document.body) && $('#model-menu')?.matches?.(':popover-open');
  list.replaceChildren(...nodes);
  if (focused || lost) {
    const same = focused && [...list.querySelectorAll('.model-menu-option')].find((option) => !option.disabled
      && option.dataset.modelId === focused.dataset.modelId && option.dataset.profileId === focused.dataset.profileId);
    (same || modelMenuStart(list))?.focus();
  }
  const empty = $('#model-menu-empty');
  const extras = menuExtras(app);
  if (empty) {
    empty.hidden = total > 0;
    empty.textContent = !app.provider?.configured ? 'Test and save a provider in Assistant first.'
      : `No ${menuTab} models are available with ${several ? 'these providers' : 'this key'}.`;
  }
  if (extras.open) extras.open.hidden = total > 0 || Boolean(app.provider?.configured);
  if (extras.error) {
    extras.error.hidden = !menuError;
    extras.error.textContent = menuError;
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
    // Main says why (an unsaved provider: 'Save "<name>" in Assistant first, …'): shown as it is.
    reportModelError(app, result?.error?.message || 'Could not switch provider');
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
  menuError = '';
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
      reportModelError(app, result?.error?.message || 'The model could not be changed');
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

// `start` picks the element the keyboard lands on when the menu opens (default: the checked
// option, else the first button). The chip's click, Enter and the slash commands (/model, /mode)
// all open it through here, so they behave the same.
function bindPopover(menuSelector, buttonSelector, align, onOpen, start = null) {
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
    (start?.(menu) || menu.querySelector('[aria-checked="true"]:not(:disabled)') || menu.querySelector('button:not(:disabled)'))?.focus();
  });
  // Escape closes the menu and gives the keyboard back to its chip, wherever the menu was
  // opened from (the chip or a slash command typed in the message box).
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !menu.matches(':popover-open')) return;
    event.preventDefault();
    event.stopPropagation();
    menu.hidePopover();
    button.focus();
  });
  let hadFocus = false;
  menu.addEventListener('beforetoggle', (event) => {
    if (event.newState === 'closed') hadFocus = menu.contains(document.activeElement);
  });
  menu.addEventListener('toggle', (event) => {
    const open = event.newState === 'open';
    button.setAttribute('aria-expanded', String(open));
    // Closed while the keyboard was in it: the focus goes back to the chip, not to the page. A
    // click elsewhere keeps the focus where the click put it.
    const active = document.activeElement;
    if (!open && (menu.contains(active) || (hadFocus && (!active || active === document.body)))) button.focus();
    hadFocus = false;
  });
  window.addEventListener('resize', () => { if (menu.matches(':popover-open')) placeAbove(menu, button, align); });
}

/**
 * The option a menu key moves to, from `index` (-1: none focused) among `count` options: arrows
 * wrap around, Home and End go to the first and last; -1 for any other key.
 */
export function menuKeyIndex(key, index, count) {
  if (!(count > 0)) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowUp') return index < 0 ? count - 1 : (index - 1 + count) % count;
  return -1;
}

// Arrow keys, Home and End move between the options of a menu.
function bindArrowKeys(menu, selector) {
  menu?.addEventListener('keydown', (event) => {
    const items = [...menu.querySelectorAll(selector)].filter((node) => !node.disabled);
    const next = menuKeyIndex(event.key, items.indexOf(document.activeElement), items.length);
    if (next < 0) return;
    event.preventDefault();
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

/**
 * The Bypass consent dialog; resolves true only when the user confirms. Also asked before an
 * automation may run with Bypass (src/app.js): `title` then names it for the time the dialog is open.
 */
export function askBypassConsent({ title = '' } = {}) {
  const dialog = $('#bypass-dialog');
  if (!dialog) return Promise.resolve(false);
  return new Promise((resolve) => {
    const confirm = $('#bypass-confirm');
    const cancel = $('#bypass-cancel');
    const heading = $('#bypass-title');
    const original = heading?.textContent || '';
    if (heading && title) heading.textContent = title;
    let answered = false;
    const finish = (yes) => {
      if (answered) return;
      answered = true;
      confirm?.removeEventListener('click', onYes);
      cancel?.removeEventListener('click', onNo);
      dialog.removeEventListener('close', onNo);
      if (dialog.open) dialog.close();
      if (heading && title) heading.textContent = original;
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

// Several tasks work at once, so a prompt can appear while the user is typing in another task.
// A keystroke must never answer one: a prompt of a task that is not on screen waits in a notice
// bar until the user chooses Review (or opens that task), the modal starts on its heading rather
// than on Allow, and Enter and Space do nothing for a moment after a prompt appears.
export const APPROVAL_KEY_GUARD_MS = 600;
const ACTIVATION_KEYS = new Set(['Enter', ' ', 'Spacebar']);

// `reviewing`: the user asked to see the prompts waiting in the background (Review), so the
// modal goes on through the queue until it is empty. `shownAt`: when the prompt on screen
// appeared; `held`: when each key now down was pressed (for the guard).
const approvals = { queue: [], showing: null, app: null, reviewing: false, shownAt: Number.NaN, held: new Map(), returnTo: null };
const approvalsBound = new WeakSet();

function approvalBridge() {
  return window.scalemaxAPI?.approvals || null;
}

function clock() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/**
 * Whether a key must not reach the approval prompt: Enter or Space within APPROVAL_KEY_GUARD_MS
 * of the prompt appearing, held down since before it (auto-repeat), or pressed before it
 * appeared (Space clicks a button on keyup). Other keys (Escape denies, Tab moves) always pass.
 */
export function blocksApprovalKey({ key, repeat = false, at, shownAt, downAt = null } = {}) {
  if (!ACTIVATION_KEYS.has(key)) return false;
  if (!Number.isFinite(shownAt) || repeat) return true;
  if (Number.isFinite(downAt) && downAt < shownAt) return true;
  return !(Number.isFinite(at) && at - shownAt >= APPROVAL_KEY_GUARD_MS);
}

function isAutomation(item) {
  return Boolean(item?.automation) || (typeof item?.requestId === 'string' && item.requestId.startsWith('automation-'));
}

/**
 * Where a prompt belongs: 'background' for an automation run or the reply of a task that is not
 * on screen, 'here' for the task on screen and for a request no task owns (it asks at once).
 */
export function approvalPlace(app, item) {
  if (isAutomation(item)) return 'background';
  const reply = app?.replyFor?.(item?.requestId);
  return reply && reply.taskId !== app.currentTaskId ? 'background' : 'here';
}

/** The prompt the modal shows next: one for the task on screen first; the rest only on Review. */
export function pickApproval(queue, placeOf, reviewing) {
  const list = Array.isArray(queue) ? queue : [];
  return list.find((item) => placeOf(item) === 'here') || (reviewing ? list[0] || null : null);
}

// ---- What the prompt says ----

const TITLE_VALUE_MAX = 80;
const TRUNCATION_MARK = '[truncated]';
const PREVIEW_FILE_LINES = 20;
const CUT_NOTE = 'The arguments are longer than 4 KB, so the end is not shown.';

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}
function cutText(value, max = TITLE_VALUE_MAX) {
  const text = oneLine(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
// A path keeps its end: the file name is what matters.
function cutPath(value, max = TITLE_VALUE_MAX) {
  const text = oneLine(value);
  return text.length > max ? `…${text.slice(text.length - (max - 1))}` : text;
}

// Arguments main cut at 4 KB end in "[truncated]" and no longer parse: their string fields are
// read up to where the text stops, escapes decoded, so the prompt can still show them.
export function looseString(text, key) {
  const source = String(text ?? '').replace(/\n?\[truncated\]\s*$/, '');
  const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(source);
  if (!match) return null;
  let index = match.index + match[0].length;
  let raw = '';
  while (index < source.length) {
    const char = source[index];
    if (char === '"') break;
    if (char === '\\') {
      const next = source[index + 1];
      // A dangling escape at the cut is dropped.
      if (next === undefined) break;
      if (next === 'u') {
        const hex = source.slice(index + 2, index + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        raw += source.slice(index, index + 6);
        index += 6;
        continue;
      }
      raw += char + next;
      index += 2;
      continue;
    }
    raw += char;
    index += 1;
  }
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return null;
  }
}
function looseLiteral(text, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*(true|false|-?\\d+(?:\\.\\d+)?)`).exec(String(text ?? ''));
  if (!match) return undefined;
  return match[1] === 'true' ? true : match[1] === 'false' ? false : Number(match[1]);
}

// The arguments of a prompt: parsed when they parse, read loosely when main cut them.
function argumentReader(request) {
  const raw = typeof request?.arguments === 'string' ? request.arguments : '';
  let value = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed;
  } catch { /* cut at 4 KB, or not JSON */ }
  return {
    raw,
    value,
    cut: raw.trimEnd().endsWith(TRUNCATION_MARK),
    string: (key) => (value ? (typeof value[key] === 'string' ? value[key] : null) : looseString(raw, key)),
    flag: (key) => (value ? value[key] : looseLiteral(raw, key)),
  };
}

/** The question the prompt asks, in words: "Edit src/app.js?", "Use echo on fake-tools?". */
export function approvalTitle(request) {
  if (request.reason === 'unsandboxed-input') return 'Type into this command outside the sandbox?';
  if (request.reason === 'unsandboxed') return 'Run this command outside the sandbox?';
  if (request.reason === 'egress') return request.host ? `Open an address on ${request.host}?` : 'Open an address?';
  if (request.kind === 'agents') return 'Hand this to a subagent?';
  const args = argumentReader(request);
  const path = cutPath(args.string('path') || '');
  const text = (key) => cutText(args.string(key) || '');
  const tool = request.toolName;
  if (request.kind === 'workspace') {
    switch (tool) {
      case 'edit_file': return path ? `Edit ${path}?` : 'Edit a file?';
      // It creates or replaces the file: "write" says both.
      case 'write_file': return path ? `Write ${path}?` : 'Write a file?';
      case 'run_command': return args.flag('background') === true ? 'Start a background command?' : 'Run a command?';
      case 'job_input': return 'Type into a background command?';
      case 'job_stop': return 'Stop a background command?';
      case 'read_file': return path ? `Read ${path}?` : 'Read a file?';
      case 'list_files': return `List the files in ${path || 'the folder'}?`;
      case 'search': return text('query') ? `Search the folder for "${text('query')}"?` : 'Search the folder?';
      default: return `Use ${cutText(tool)}?`;
    }
  }
  // The two resource tools of every MCP server: the server is named in the arguments.
  if (request.serverId === 'MCP' && (tool === 'read_resource' || tool === 'list_resources')) {
    const server = text('server') || 'an MCP server';
    return tool === 'read_resource' ? `Read a resource from ${server}?` : `List the resources of ${server}?`;
  }
  if (request.kind === 'computer') {
    switch (tool) {
      case 'read_clipboard': return 'Read your clipboard?';
      case 'write_clipboard': return 'Put text on your clipboard?';
      case 'open': {
        const target = args.string('path') ? path : text('url');
        return target ? `Open ${target}?` : 'Open something on your computer?';
      }
      case 'reveal': return path ? `Show ${path} in the Finder?` : 'Show a file in the Finder?';
      default: break;
    }
  }
  if (request.kind === 'web') {
    if (tool === 'search') return text('query') ? `Search the web for "${text('query')}"?` : 'Search the web?';
    if (tool === 'open_page') return text('url') ? `Open ${text('url')}?` : 'Open a page?';
  }
  return `Use ${cutText(tool)} on ${cutText(request.serverName)}?`;
}

/** The line above the title: whose call it is (another task, an automation, a subagent). */
export function approvalContext(request, taskTitle = '') {
  let text = 'Tool call';
  if (request.automation) text += ` · Automation: ${request.automation}`;
  else if (isAutomation(request)) text += ' · Automation';
  else if (taskTitle) text += ` · ${taskTitle}`;
  if (request.subagent) text += ` · Subagent: ${request.subagent}`;
  return text;
}

const DIFF_CONTEXT = 3;
const DIFF_MAX_CELLS = 40_000;
const DIFF_MAX_ROWS = 200;

function textLines(text) {
  const value = String(text ?? '');
  return value === '' ? [] : value.split(/\r?\n/);
}

/**
 * A small line diff of an edit (old_text → new_text): {type: 'same'|'del'|'add', text} rows, at
 * most DIFF_CONTEXT unchanged lines around each change, longer unchanged runs as one
 * {type: 'gap', count}, and at most DIFF_MAX_ROWS rows (then {type: 'gap', count, more: true}).
 */
export function lineDiff(before, after) {
  const old = textLines(before);
  const now = textLines(after);
  let start = 0;
  while (start < old.length && start < now.length && old[start] === now[start]) start += 1;
  let endOld = old.length;
  let endNew = now.length;
  while (endOld > start && endNew > start && old[endOld - 1] === now[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }
  if (start === endOld && start === endNew) return [];
  const removed = old.slice(start, endOld);
  const added = now.slice(start, endNew);
  const middle = [];
  if (removed.length * added.length <= DIFF_MAX_CELLS) {
    // Longest common subsequence of the lines in between; removals print before additions.
    const table = Array.from({ length: removed.length + 1 }, () => new Uint16Array(added.length + 1));
    for (let i = removed.length - 1; i >= 0; i -= 1) {
      for (let j = added.length - 1; j >= 0; j -= 1) {
        table[i][j] = removed[i] === added[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < removed.length && j < added.length) {
      if (removed[i] === added[j]) {
        middle.push({ type: 'same', text: removed[i] });
        i += 1;
        j += 1;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        middle.push({ type: 'del', text: removed[i] });
        i += 1;
      } else {
        middle.push({ type: 'add', text: added[j] });
        j += 1;
      }
    }
    for (; i < removed.length; i += 1) middle.push({ type: 'del', text: removed[i] });
    for (; j < added.length; j += 1) middle.push({ type: 'add', text: added[j] });
  } else {
    middle.push(...removed.map((text) => ({ type: 'del', text })), ...added.map((text) => ({ type: 'add', text })));
  }
  const rows = [
    ...old.slice(0, start).map((text) => ({ type: 'same', text })),
    ...middle,
    ...old.slice(endOld).map((text) => ({ type: 'same', text })),
  ];
  // Unchanged lines further than DIFF_CONTEXT from every change fold into a gap.
  const near = new Array(rows.length).fill(false);
  let last = -Infinity;
  rows.forEach((row, index) => {
    if (row.type !== 'same') last = index;
    if (index - last <= DIFF_CONTEXT) near[index] = true;
  });
  last = Infinity;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].type !== 'same') last = index;
    if (last - index <= DIFF_CONTEXT) near[index] = true;
  }
  const shown = [];
  rows.forEach((row, index) => {
    if (near[index]) shown.push(row);
    else if (shown.at(-1)?.type === 'gap') shown.at(-1).count += 1;
    else shown.push({ type: 'gap', count: 1 });
  });
  if (shown.length <= DIFF_MAX_ROWS) return shown;
  const rest = shown.slice(DIFF_MAX_ROWS - 1).reduce((total, row) => total + (row.type === 'gap' ? row.count : 1), 0);
  return [...shown.slice(0, DIFF_MAX_ROWS - 1), { type: 'gap', count: rest, more: true }];
}

const COMMAND_SANDBOX = { on: 'In the sandbox', offline: 'In the sandbox, without network', off: 'Without a sandbox' };

/**
 * What the prompt shows of the call, readable: an edit as a line diff, a new file's first
 * lines, a command as typed with where and how it runs; anything else as indented JSON (or the
 * text main sent, when it was cut and no longer parses).
 */
export function approvalPreview(request) {
  const args = argumentReader(request);
  const cutNote = args.cut ? CUT_NOTE : '';
  if (request.kind === 'workspace') {
    const path = args.string('path') || '';
    if (request.toolName === 'edit_file') {
      const before = args.string('old_text');
      const after = args.string('new_text');
      if (before !== null && after !== null) {
        const note = [args.flag('replace_all') === true ? 'Every occurrence is replaced.' : '', cutNote].filter(Boolean).join(' ');
        return { kind: 'diff', label: 'Change', path, lines: lineDiff(before, after), note };
      }
    }
    if (request.toolName === 'write_file') {
      const content = args.string('content');
      if (content !== null) {
        const lines = textLines(content);
        // A final line break ends the last line; it is no line of its own.
        if (lines.length && lines.at(-1) === '' && !args.cut) lines.pop();
        const note = [content === '' ? 'The file is empty.' : '', cutNote].filter(Boolean).join(' ');
        // Cut arguments hold only the start of the file: what is left is a lower bound.
        return { kind: 'file', label: 'Content', path, lines: lines.slice(0, PREVIEW_FILE_LINES), more: Math.max(0, lines.length - PREVIEW_FILE_LINES), atLeast: args.cut, note };
      }
    }
    if (request.toolName === 'run_command') {
      const command = args.string('command');
      if (command !== null) {
        const timeout = args.flag('timeout_seconds');
        const notes = [
          request.folderName ? `In the folder "${request.folderName}"` : '',
          request.reason === 'unsandboxed' ? 'Outside the sandbox' : COMMAND_SANDBOX[request.sandbox] || '',
          args.flag('background') === true ? 'Keeps running in the background' : '',
          args.flag('tty') === true ? 'In a terminal' : '',
          Number.isFinite(timeout) ? `Time limit ${timeout} s` : '',
        ].filter(Boolean);
        return { kind: 'command', label: 'Command', text: command, notes, note: cutNote };
      }
    }
    if (request.toolName === 'job_input') {
      const input = args.string('text');
      if (input !== null) {
        const job = args.string('job');
        const notes = [job ? `Background command ${job}` : '', args.flag('enter') === false ? '' : 'Then presses Enter'].filter(Boolean);
        return { kind: 'command', label: 'Input', text: input, notes, note: cutNote };
      }
    }
  }
  if (args.value) return { kind: 'json', label: 'Arguments', text: JSON.stringify(args.value, null, 2), note: '' };
  return { kind: 'text', label: 'Arguments', text: args.raw || '{}', note: cutNote };
}

/** The notice bar's sentence for the prompts waiting in the background. */
export function approvalNoticeText(items, whoOf) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '';
  const text = `${whoOf(list[0])} is waiting for your approval`;
  return list.length > 1 ? `${text} · ${list.length} tool calls waiting` : text;
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
export function approvalSummary(request) {
  // Handing work to a subagent (lib/subagents.cjs; it asks in Manual): its own calls ask too.
  if (request.kind === 'agents') {
    const args = approvalArguments(request);
    const where = request.folderName ? `the folder "${request.folderName}"` : 'your workspace folder';
    const what = typeof args.description === 'string' && args.description.trim() ? ` ("${args.description.trim().slice(0, 120)}")` : '';
    return `The model wants to hand part of this work to a subagent${what}. It works in ${where} with a fresh context of its own and reports back; ${args.kind === 'general'
      ? 'it may change files and run commands, and its own tool calls ask you as usual.' : 'it can only read and search.'}`;
  }
  if (request.kind === 'workspace') {
    const where = request.folderName ? `the folder "${request.folderName}"` : 'your workspace folder';
    if (request.reason === 'unsandboxed' || request.reason === 'unsandboxed-input') {
      const action = request.reason === 'unsandboxed-input' ? 'type into a command' : 'run a command';
      return `The model wants to ${action} in ${where} outside the sandbox. There it can change any of your files, read credential folders such as ~/.ssh and use the network. ScaleMax asks about this every time, whatever the permission mode.`;
    }
    // The hooks settings: commands that run on this Mac outside the sandbox (lib/hooks.cjs).
    if (request.reason === 'hooks-config') {
      return `The model wants to change .scalemax/settings.json in ${where}, where hooks are set up: commands ScaleMax runs on your Mac, outside the sandbox. ScaleMax asks about this every time, whatever the permission mode, and changed project hooks wait for your approval before they run.`;
    }
    const summary = WORKSPACE_SUMMARIES[request.toolName];
    if (!summary) return `The model wants to read files in ${where}.`;
    // Read loosely, so a command cut at 4 KB still says it keeps running.
    const background = argumentReader(request).flag('background') === true;
    return summary(where, { background }) + (request.toolName === 'run_command' ? SANDBOX_NOTES[request.sandbox] || '' : '');
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
  // A resource address the model filled in from a server's URI template (lib/mcp.cjs
  // readResourceReason): only a read, but the address itself reaches the server.
  if (request.serverId === 'MCP' && request.toolName === 'read_resource') {
    const args = approvalArguments(request);
    const server = typeof args.server === 'string' && args.server ? `"${args.server.slice(0, 80)}"` : 'an MCP server';
    return `The model wants to read a resource from ${server} at an address it filled in itself. It only reads, but the address could carry text from this conversation to that server. Check it below, or turn on "Trust its read-only labels" for the server to stop asking.`;
  }
  if (request.claimsReadOnly) {
    return `The model wants to run "${request.toolName}" on ${request.serverName}. The server says this tool only reads data, but ScaleMax cannot check that. If you trust this server, turn on "Trust its read-only labels" for it in Assistant → MCP servers.`;
  }
  return request.readOnly
    ? `The model wants to run "${request.toolName}" on ${request.serverName}. You trust this server's label that the tool only reads data.`
    : `The model wants to run "${request.toolName}" on ${request.serverName}. This tool can change data there.`;
}

// ---- The modal and the notice bar ----

function setText(selector, text) {
  const node = $(selector);
  if (node) node.textContent = text;
}

// The task a prompt comes from, when it is not the one on screen.
function backgroundTask(app, request) {
  const reply = app?.replyFor?.(request.requestId);
  return reply && reply.taskId !== app.currentTaskId ? app.tasks?.find?.((item) => item.id === reply.taskId) || null : null;
}

function diffRow(row) {
  const kind = { del: ' is-del', add: ' is-add', gap: ' is-meta' }[row.type] || '';
  const line = element('span', `diff-line${kind}`);
  line.append(element('span', 'approval-diff-sign', row.type === 'del' ? '-' : row.type === 'add' ? '+' : ' '));
  line.append(row.type === 'gap'
    ? `⋯ ${row.count} ${row.more ? 'more' : 'unchanged'} line${row.count === 1 ? '' : 's'}` : row.text);
  return line;
}

function renderApprovalPreview(preview) {
  const box = $('#approval-preview');
  if (!box) return;
  const nodes = [element('span', 'small-label', preview.label)];
  if ((preview.kind === 'diff' || preview.kind === 'file') && preview.path) nodes.push(element('p', 'approval-path', preview.path));
  if (preview.kind === 'diff') {
    const block = element('div', 'code-output approval-diff');
    block.setAttribute('role', 'group');
    block.setAttribute('aria-label', 'Changed lines');
    block.append(...preview.lines.map(diffRow));
    nodes.push(block);
  } else if (preview.kind === 'file') {
    if (preview.lines.length) nodes.push(element('pre', 'code-output approval-file', preview.lines.join('\n')));
    if (preview.more > 0) nodes.push(element('p', 'approval-more', `… ${preview.atLeast ? 'at least ' : ''}${preview.more} more line${preview.more === 1 ? '' : 's'}`));
  } else if (preview.kind === 'command') {
    nodes.push(element('pre', 'code-output approval-command', preview.text));
    if (preview.notes.length) nodes.push(element('p', 'approval-notes', preview.notes.join(' · ')));
  } else {
    nodes.push(element('pre', 'code-output approval-arguments', preview.text));
  }
  if (preview.note) nodes.push(element('p', 'approval-note', preview.note));
  box.replaceChildren(...nodes);
}

function renderApprovalCount() {
  const queue = $('#approval-queue');
  if (!queue) return;
  queue.hidden = approvals.queue.length < 2;
  queue.textContent = `${approvals.queue.length} waiting`;
}

// Fills the modal with one prompt and opens it. The focus starts on the heading, never on a
// button, and the guard clock starts again for every prompt.
function renderApproval(request) {
  const dialog = $('#tool-approval-dialog');
  approvals.showing = request;
  setText('#approval-eyebrow', approvalContext(request, backgroundTask(approvals.app, request)?.title || ''));
  // A call that always asks (a command outside the sandbox, the clipboard) is allowed one at a
  // time; an address the model made up can be allowed for its site, for the rest of this reply.
  const egress = request.reason === 'egress' && Boolean(request.host);
  const always = Boolean(request.reason) && !egress;
  const outside = request.reason === 'unsandboxed' || request.reason === 'unsandboxed-input';
  setText('#approval-title', approvalTitle(request));
  setText('#approval-summary', approvalSummary(request));
  const preview = approvalPreview(request);
  renderApprovalPreview(preview);
  // The raw arguments stay one click away, except when the preview already is them.
  const raw = $('#approval-raw');
  if (raw) {
    raw.open = false;
    raw.hidden = preview.kind === 'json' || preview.kind === 'text';
  }
  setText('#approval-arguments', request.arguments || '{}');
  const all = $('#approval-all');
  if (all) {
    all.hidden = always;
    all.textContent = egress ? `Allow ${request.host || 'this site'} in this reply` : 'Allow all in this reply';
  }
  dialog.classList.toggle('is-unsandboxed', outside);
  renderApprovalCount();
  if (!dialog.open) {
    approvals.returnTo = document.activeElement;
    dialog.showModal();
  }
  approvals.shownAt = clock();
  $('#approval-title')?.focus?.({ preventScroll: true });
  // Opened at its top: the first line of the summary is never scrolled away.
  const body = $('#approval-body');
  if (body) body.scrollTop = 0;
  for (const block of $('#approval-preview')?.querySelectorAll?.('.code-output') || []) block.scrollTop = 0;
}

// The bar over the views for prompts of tasks that are not on screen; it never takes the focus.
function renderApprovalNotice() {
  const notice = $('#approval-notice');
  if (!notice) return;
  const waiting = approvals.showing ? [] : approvals.queue;
  notice.hidden = !waiting.length;
  setText('#approval-notice-text', approvalNoticeText(waiting, (item) => {
    if (item.automation) return `Automation "${cutText(item.automation, 60)}"`;
    if (isAutomation(item)) return 'An automation';
    const reply = approvals.app?.replyFor?.(item.requestId);
    const task = reply ? approvals.app.tasks?.find?.((entry) => entry.id === reply.taskId) : null;
    return task?.title ? `"${cutText(task.title, 60)}"` : 'A task';
  }));
}

/**
 * Brings the prompts in line with what is on screen: the modal shows a prompt of the task on
 * screen (or, after Review, any waiting one) and keeps the one it shows; the others wait in the
 * notice bar. app.js calls it when another task is opened, so that task's prompts ask now.
 */
export function syncApprovalPrompt() {
  const app = approvals.app;
  const dialog = $('#tool-approval-dialog');
  if (!app || !dialog) return;
  if (!approvals.queue.length) approvals.reviewing = false;
  if (approvals.showing && dialog.open && approvals.queue.includes(approvals.showing)) {
    renderApprovalCount();
  } else {
    const next = pickApproval(approvals.queue, (item) => approvalPlace(app, item), approvals.reviewing);
    if (next) {
      renderApproval(next);
    } else {
      // `showing` is cleared first, so this close is not read as a denial.
      approvals.showing = null;
      if (dialog.open) {
        dialog.close();
        // The dialog gives the focus back to what had it; when that is gone (the notice's
        // Review button hides once it is used), the message box takes it.
        const active = document.activeElement;
        if (!active || active === document.body) {
          [approvals.returnTo, $('#chat-input')].find((node) => node?.isConnected && !node.disabled
            && node.checkVisibility?.() !== false)?.focus?.();
        }
      }
      approvals.returnTo = null;
    }
  }
  renderApprovalNotice();
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
  approvals.showing = null;
  syncApprovalPrompt();
  const bridge = approvalBridge();
  for (const item of [request, ...siblings]) {
    const result = await bridge?.respond({ approvalId: item.approvalId, decision: item === request ? decision : 'once' });
    if (!result?.ok || !result.data?.accepted) app.showToast?.('That tool request had already ended');
  }
}

export function bindApprovals(app) {
  const bridge = approvalBridge();
  const dialog = $('#tool-approval-dialog');
  if (!app || approvalsBound.has(app) || !bridge?.onRequest || !dialog) return;
  approvalsBound.add(app);
  approvals.app = app;
  bridge.onRequest((request) => {
    if (!request || typeof request.approvalId !== 'string') return;
    approvals.queue.push({
      approvalId: request.approvalId,
      requestId: String(request.requestId || ''),
      // 'MCP' for the resource tools of all servers; the summary and title depend on it.
      serverId: typeof request.serverId === 'string' ? request.serverId.slice(0, 120) : '',
      serverName: String(request.serverName || request.serverId || 'MCP server'),
      kind: ['workspace', 'web', 'computer', 'agents'].includes(request.kind) ? request.kind : 'mcp',
      // The subagent making this call (its description), when one does.
      subagent: typeof request.subagent === 'string' ? request.subagent.slice(0, 120) : '',
      // The automation whose run makes this call, when one does.
      automation: typeof request.automation === 'string' ? request.automation.trim().slice(0, 120) : '',
      toolName: String(request.toolName || 'tool'),
      readOnly: request.readOnly === true,
      arguments: String(request.arguments || '{}'),
      folderName: typeof request.folderName === 'string' ? request.folderName.slice(0, 255) : '',
      // Why it always asks ('unsandboxed', 'egress', or another reason main gives), and how a command runs.
      reason: typeof request.reason === 'string' && request.reason
        ? (['unsandboxed', 'unsandboxed-input', 'egress', 'private', 'hooks-config'].includes(request.reason) ? request.reason : 'required') : '',
      host: typeof request.host === 'string' ? request.host.slice(0, 255) : '',
      claimsReadOnly: request.claimsReadOnly === true,
      sandbox: ['on', 'offline', 'off'].includes(request.sandbox) ? request.sandbox : '',
    });
    // One prompt on screen keeps it (only the waiting count changes); one for a task in the
    // background waits in the notice bar.
    syncApprovalPrompt();
  });
  bridge.onClosed?.((info) => {
    approvals.queue = approvals.queue.filter((item) => item.approvalId !== info?.approvalId);
    if (approvals.showing?.approvalId === info?.approvalId) approvals.showing = null;
    syncApprovalPrompt();
  });
  $('#approval-once')?.addEventListener('click', () => void answerApproval(app, 'once'));
  $('#approval-all')?.addEventListener('click', () => void answerApproval(app, 'request'));
  $('#approval-deny')?.addEventListener('click', () => void answerApproval(app, 'deny'));
  $('#approval-notice-review')?.addEventListener('click', () => {
    approvals.reviewing = true;
    syncApprovalPrompt();
  });
  // Escape denies. Chromium closes a modal that opened without a user gesture straight away,
  // without a cancel event, so any close that did not come from an answer is a denial too (but
  // not a late close event of a dialog that is open again with the next prompt).
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    void answerApproval(app, 'deny');
  });
  dialog.addEventListener('close', () => {
    if (approvals.showing && !dialog.open) void answerApproval(app, 'deny');
  });
  // The key guard runs before anything else sees the key. A keyup counts from its keydown: one
  // pressed before the prompt appeared, or too soon after, clicks nothing when it is released.
  const guard = (event) => {
    const pressedAt = approvals.held.get(event.key);
    if (event.type === 'keydown') {
      if (!event.repeat) approvals.held.set(event.key, event.timeStamp);
    } else {
      approvals.held.delete(event.key);
    }
    if (!dialog.open || !approvals.showing) return;
    const keydown = event.type === 'keydown';
    const downAt = keydown && !event.repeat ? event.timeStamp : pressedAt;
    if (blocksApprovalKey({ key: event.key, repeat: keydown && event.repeat, at: keydown ? event.timeStamp : pressedAt, shownAt: approvals.shownAt, downAt })) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  window.addEventListener('keydown', guard, true);
  window.addEventListener('keyup', guard, true);
  window.addEventListener('blur', () => approvals.held.clear());
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
  // handleSend takes the text before its first await; as an internal message it leaves the
  // pictures waiting in the message box for the user's own next message.
  void app.handleSend({ internal: true });
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
    menuError = '';
    renderModelMenu(app);
    void refreshProfiles(app);
  }, () => {
    // No models yet: the keyboard starts on "Open Assistant", the one thing to do.
    const assistant = $('#model-menu-assistant');
    return modelMenuStart($('#model-menu-list')) || (assistant && !assistant.hidden ? assistant : null);
  });
  bindPopover('#permission-menu', '#permission-button', 'start', () => renderPermission(app));
  bindPopover('#mode-menu', '#mode-chip', 'start', () => renderModeMenu(app));
  bindArrowKeys($('#model-menu-list'), '.model-menu-option');
  bindArrowKeys($('#permission-menu'), '.composer-menu-option');
  bindArrowKeys($('#mode-menu'), '.composer-menu-option');
  bindFolderMenu(app);
  // The chat toolbar's Export menu: its two options keep their own handlers (src/sessions-ui.js,
  // src/catalog-ui.js); picking one closes the menu.
  const exportMenu = $('#export-menu');
  bindPopover('#export-menu', '#export-menu-btn', 'end', () => {});
  bindArrowKeys(exportMenu, '.composer-menu-option');
  exportMenu?.addEventListener('click', (event) => {
    if (event.target.closest('.composer-menu-option')) exportMenu.hidePopover?.();
  });

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
    // Down from the tabs goes into the list of models.
    if (event.key === 'ArrowDown') {
      const option = modelMenuStart($('#model-menu-list'));
      if (option) {
        event.preventDefault();
        option.focus();
      }
      return;
    }
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
