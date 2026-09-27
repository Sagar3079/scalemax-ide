/** ScaleMax IDE: local conversations, settings, and demo interactions. */
import { EXPERTS, SKILLS, CONNECTORS } from './data.js';
import {
  nextRunAt, normalizeAutomations, normalizeSettings, buildSystemPrompt, requestTemperature, requestReasoning,
  toTemperature, searchItems, folderName, normalizeTaskFolder, DEFAULT_SETTINGS,
} from './domain.mjs';
import { bindTerminal } from './terminal.js';
import { bindCatalogUi, openResourceDetail } from './catalog-ui.js';
import { startScheduler } from './scheduler.js';
import { renderAvatar } from './avatars.js';
import { validateCustomExpert, validateCustomSkill, normalizeCustomList } from './custom-catalog.js';
import { bindCustomCatalogUi, openCustomDialog, deleteCustom } from './custom-ui.js';
import { bindMcpUi } from './mcp-ui.js';
import {
  bindComposerUi, renderModelButton, renderPermission, setPermission, refreshProfiles, renderFolderMenu,
} from './composer-ui.js';
import { bindMediaUi, mediaMode, generateFromComposer, cancelGeneration, renderMediaItems, renderMediaBar } from './media-ui.js';
import {
  bindWorkspaceUi, renderTree, renderCrumb, resetCrawl, openFileInTab, saveActiveTab, resetTabs,
  activeTabContent, updateGutter, showPanel, setGitDecorations,
} from './workspace-ui.js';

const DEFAULTS = { ...DEFAULT_SETTINGS };
const FALLBACK_KEY = 'scalemax-fallback';
const TAG_PROMPTS = {
  daily: 'Plan my development work for today. ',
  web: 'I want to build a website. ',
  apps: 'I want to build an agent app. ',
  skills: 'Write a reusable skill prompt for ',
};
// Selecting an expert seeds the composer with the work that expert is for.
const EXPERT_STARTERS = {
  'full-stack-developer': 'Build me a full-stack feature. Here is what I need: ',
  'ui-ux-designer': 'Critique and improve this interface. Here is the context: ',
  'data-analyst': 'Analyze this dataset. The question I need answered: ',
  'growth-marketer': 'Plan a growth experiment for this product: ',
  'devops-engineer': 'Review this deployment or pipeline setup: ',
  copywriter: 'Write copy for this page or campaign: ',
  'security-auditor': 'Audit this code or configuration for vulnerabilities: ',
  'product-manager': 'Turn this idea into a spec with milestones: ',
};
const GITHUB_REPO_PATTERN = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/;
const VIEW_NAMES = {
  chat: 'Chat', workspace: 'Workspace', assistant: 'Assistant', experts: 'Experts',
  automation: 'Automation', more: 'More',
};
const MAX_ATTACHMENT_BYTES = 1024 * 1024;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// All dynamic content is inserted as text, never interpreted as HTML.
function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tag === 'button') node.type = 'button';
  return node;
}

function clock(time) {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function relativeTime(time) {
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  return minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes}m ago` : clock(time);
}

// Porcelain v1 status codes mapped to a single-letter badge for the Git panel.
function gitStatusLetter(state) {
  if (!state) return '·';
  if (state === '??') return 'U';
  return state.trim().charAt(0) || '·';
}

function gitStatusClass(state) {
  if (state === '??') return 'is-untracked';
  const letter = state.trim().charAt(0);
  if (letter === 'M') return 'is-modified';
  if (letter === 'A') return 'is-added';
  if (letter === 'D') return 'is-deleted';
  return '';
}

// Tool calls the model made through MCP, kept small and text-only.
function elapsedText(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function pendingText(pending) {
  if (pending.phase === 'media') {
    const what = pending.kind === 'video' ? 'video' : 'image';
    if (pending.mediaPhase === 'queued') return `Video queued at the provider…`;
    if (pending.mediaPhase === 'downloading') return `Downloading the ${what}…`;
    const progress = Number.isFinite(pending.progress) && pending.progress > 0 ? ` ${pending.progress}%` : '';
    return `Generating ${what}${progress}…`;
  }
  if (pending.phase === 'approval') return `Waiting for your approval · ${pending.tool}`;
  if (pending.phase === 'tool') return `Running ${pending.tool}…`;
  return pending.thinking ? 'Thinking…' : 'Writing…';
}

/** "Thought for 4s" for replies from a thinking model, otherwise ''. */
function thoughtLabel(message) {
  if (message.role !== 'assistant' || !Number.isSafeInteger(message.thinkingMs)) return '';
  return `Thought for ${elapsedText(Math.max(1000, message.thinkingMs))}`;
}

function normalizeMediaItems(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => isRecord(item) && /^m-[a-f0-9]{16}$/.test(item.id) && ['image', 'video'].includes(item.kind))
    .slice(0, 10).map((item) => ({ id: item.id, kind: item.kind, mime: typeof item.mime === 'string' ? item.mime.slice(0, 40) : '' }));
}

// The folder a chat was started in, as { folder } (or nothing when the stored value is unusable).
// Selecting the task opens that folder again.
function taskFolderField(value) {
  const folder = normalizeTaskFolder(value);
  return folder ? { folder } : {};
}

function normalizeToolSummaries(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => isRecord(item) && typeof item.tool === 'string').slice(0, 32).map((item) => ({
    server: typeof item.server === 'string' ? item.server.slice(0, 64) : '',
    tool: item.tool.slice(0, 128),
    ok: item.ok === true,
  }));
}

const app = {
  tasks: [],
  currentTaskId: null,
  settings: { ...DEFAULTS },
  automations: [],
  skillStates: {},
  customExperts: [],
  customSkills: [],
  provider: null,
  providerKind: 'scalemax',
  providerBase: '',
  providerCatalog: [],
  enabledModels: new Set(),
  selectedModel: '',
  attachment: null,
  // recent: folders main remembers, newest first ({ name, path }; the open one included).
  workspace: { root: '', files: [], recent: [], openPath: '', revision: '', dirty: false },
  // Folder switches run one after another (runFolderJob); a newer selection or pick wins.
  folderSequence: 0,
  folderQueue: Promise.resolve(),
  activeRequestId: null,
  eventsBound: false,

  toastTimer: null,
  saveQueue: Promise.resolve(),

  // scheduler.js calls app.buildSystemPrompt(settings); custom catalogs ride along.
  buildSystemPrompt(settings = this.settings) {
    return buildSystemPrompt(settings, { experts: this.customExperts, skills: this.customSkills });
  },

  async init() {
    window.addEventListener('error', (event) => this.showGlobalError(event.message || 'Unexpected error'));
    window.addEventListener('unhandledrejection', (event) =>
      this.showGlobalError(event.reason?.message || 'Unexpected error'));
    await this.loadState();
    await this.loadProvider();
    this.bindEvents();
    this.bindReplyProgress();
    this.renderAll();
    bindTerminal(this);
    bindWorkspaceUi(this);
    bindCatalogUi(this);
    bindCustomCatalogUi(this);
    bindMcpUi(this);
    bindComposerUi(this);
    bindMediaUi(this);
    this.bindProfiles();
    await this.restoreWorkspace();
    window.scalemaxScheduler = startScheduler(this);
    this.updateSendEnabled();
    await this.loadVersion();
    document.body.dataset.appReady = 'true';
  },

  // The fallback is one JSON object containing the same five store keys.
  readFallback() {
    try {
      const state = JSON.parse(window.localStorage.getItem(FALLBACK_KEY) || '{}');
      return isRecord(state) ? state : {};
    } catch {
      return {};
    }
  },

  async readState(key) {
    const bridge = window.scalemaxAPI;
    try {
      if (bridge?.store?.get) {
        const value = await bridge.store.get(key);
        if (value !== undefined && value !== null) {
          // Accept JSON strings written by the previous application as well.
          return typeof value === 'string' ? JSON.parse(value) : value;
        }
      }
    } catch (error) {
      console.warn(`[app] Could not read ${key}:`, error);
    }
    return this.readFallback()[key];
  },

  persist(key) {
    const snapshot = JSON.parse(JSON.stringify(this[key]));
    // Queue snapshots so rapid edits cannot finish writing out of order.
    this.saveQueue = this.saveQueue.then(async () => {
      const bridge = window.scalemaxAPI;
      try {
        if (bridge?.store?.set) {
          // main reports false when the disk write failed; fall back to
          // localStorage instead of silently losing the change.
          const saved = await bridge.store.set(key, snapshot);
          if (saved !== false) return;
        }
      } catch (error) {
        console.warn(`[app] Could not save ${key} through the bridge:`, error);
      }
      try {
        const state = this.readFallback();
        state[key] = snapshot;
        window.localStorage.setItem(FALLBACK_KEY, JSON.stringify(state));
      } catch (error) {
        console.warn('[app] Local storage unavailable:', error);
        this.showToast('Changes could not be saved; they remain in this session');
      }
    });
    return this.saveQueue;
  },

  async loadState() {
    const keys = ['tasks', 'settings', 'automations', 'skillStates', 'customExperts', 'customSkills'];
    const [tasks, settings, automations, skills, customExperts, customSkills] = await Promise.all(
      keys.map((key) => this.readState(key)),
    );
    const now = Date.now();
    this.tasks = Array.isArray(tasks) ? tasks.filter((task) =>
      isRecord(task) && typeof task.id === 'string' && typeof task.title === 'string',
    ).map((task) => ({
      id: task.id, title: task.title,
      messages: Array.isArray(task.messages) ? task.messages.filter((message) =>
        isRecord(message) && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string',
      ).map((message) => {
        const normalized = {
          role: message.role, text: message.text,
          time: Number.isFinite(message.time) ? message.time : now,
        };
        const tools = normalizeToolSummaries(message.tools);
        if (tools.length) normalized.tools = tools;
        // "Thought for Ns" and any thinking text stay with the answer across restarts.
        if (message.role === 'assistant' && Number.isSafeInteger(message.thinkingMs) && message.thinkingMs >= 0) {
          normalized.thinkingMs = message.thinkingMs;
        }
        if (message.role === 'assistant' && typeof message.reasoning === 'string' && message.reasoning.trim()) {
          normalized.reasoning = message.reasoning.slice(0, 65536);
        }
        // Generated images and videos (files stay in the app's media folder).
        const media = normalizeMediaItems(message.media);
        if (media.length) normalized.media = media;
        if (typeof message.mediaRequest === 'string' && message.mediaRequest) normalized.mediaRequest = message.mediaRequest.slice(0, 300);
        // A note from ScaleMax under a reply (for example that project notes were created).
        if (typeof message.notice === 'string' && message.notice.trim()) normalized.notice = message.notice.trim().slice(0, 300);
        return normalized;
      }) : [],
      createdAt: Number.isFinite(task.createdAt) ? task.createdAt : now,
      updatedAt: Number.isFinite(task.updatedAt) ? task.updatedAt : now,
      ...taskFolderField(task.folder),
    })) : [];
    const rawSettings = isRecord(settings) ? settings : {};
    this.settings = normalizeSettings(rawSettings);
    // normalizeSettings only knows built-in catalog ids; keep custom expert and
    // skill selections (resolved later by buildSystemPrompt) across reloads.
    for (const key of ['expertId', 'skillId']) {
      if (this.settings[key] === null && typeof rawSettings[key] === 'string'
        && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(rawSettings[key])) this.settings[key] = rawSettings[key];
    }
    // Automations are normalised before use: legacy records stay paused and
    // every active schedule gets a future next run.
    this.automations = normalizeAutomations(Array.isArray(automations) ? automations : []);
    this.skillStates = isRecord(skills) ? skills : {};
    this.customExperts = normalizeCustomList(customExperts, validateCustomExpert);
    this.customSkills = normalizeCustomList(customSkills, validateCustomSkill);
    if (!this.tasks.length) {
      this.tasks.push(this.makeTask('Welcome'));
      await this.persist('tasks');
    }
    this.currentTaskId = this.tasks[0].id;
  },

  async loadVersion() {
    const bridge = window.scalemaxAPI;
    let version = '1.0.0';
    try {
      if (bridge?.app?.getVersion) version = (await bridge.app.getVersion()) || version;
    } catch (error) {
      console.warn('[app] Could not read app version:', error);
    }
    $$('#about-version').forEach((node) => { node.textContent = version; });
  },

  // Provider metadata entry point. The API key itself never reaches the
  // renderer; only a hasKey flag crosses the bridge (see lib/provider.cjs).
  getProviderBridge() {
    return window.scalemaxAPI?.provider || null;
  },

  async loadProvider() {
    const bridge = this.getProviderBridge();
    if (!bridge?.get) { this.provider = null; this.renderProviderStatus(); return; }
    try {
      const result = await bridge.get();
      this.provider = result?.ok ? result.data : null;
    } catch (error) {
      console.warn('[app] Could not read provider settings:', error);
      this.provider = null;
    }
    const meta = this.provider || {};
    this.providerKind = meta.kind === 'custom' ? 'custom' : 'scalemax';
    this.providerCatalog = Array.isArray(meta.models) ? meta.models : [];
    this.enabledModels = new Set(Array.isArray(meta.enabledModels) ? meta.enabledModels : []);
    // Only surface an endpoint once it has actually been verified and saved.
    this.providerBase = meta.configured ? (meta.baseUrl || '') : '';
    if ($('#provider-kind')) $('#provider-kind').value = this.providerKind;
    this.renderProviderStatus();
    this.applyProviderKind();
    this.renderProviderModels();
  },

  providerKindValue() {
    return $('#provider-kind')?.value === 'custom' ? 'custom' : 'scalemax';
  },

  applyProviderKind() {
    const kind = this.providerKindValue();
    this.providerKind = kind;
    const custom = kind === 'custom';
    if ($('#provider-base-url-group')) $('#provider-base-url-group').hidden = !custom;
    if ($('#provider-model-text-group')) $('#provider-model-text-group').hidden = !custom;
    if ($('#provider-model-select-group')) $('#provider-model-select-group').hidden = custom;
    if ($('#provider-detected-group')) $('#provider-detected-group').hidden = custom;
    if ($('#provider-api-key')) {
      $('#provider-api-key').placeholder = this.provider?.hasKey
        ? 'Key stored — leave blank to keep it'
        : custom ? 'Your provider API key' : 'sm_live_…';
    }
    this.renderProviderStatus();
  },

  renderProviderStatus() {
    const meta = this.provider || {};
    const configured = Boolean(meta.configured);
    const model = meta.model || '';
    const baseUrl = meta.baseUrl || '';
    const kindLabel = meta.kind === 'custom' ? 'Custom provider' : 'ScaleMax';
    if ($('#app-status')) {
      $('#app-status').textContent = configured ? `${kindLabel}: ${model}` : 'Provider not configured';
    }
    if ($('#provider-status')) {
      const count = Array.isArray(meta.models) ? meta.models.length : 0;
      $('#provider-status').textContent = configured
        ? `Connected via ${kindLabel} — ${model} at ${baseUrl}${count ? ` · ${count} model${count === 1 ? '' : 's'} available` : ''}.`
        : meta.keyStorage === 'session'
          ? 'The API key was session-only and expired after restart. Enter it again and save.'
          : 'Provider not configured. Choose a provider, add your API key, and test the connection.';
    }
    if ($('#provider-detected-base')) {
      $('#provider-detected-base').textContent = this.providerBase || baseUrl || 'Not connected';
    }
    if ($('#provider-base-url') && meta.kind === 'custom' && baseUrl) $('#provider-base-url').value = baseUrl;
    if ($('#provider-model') && meta.kind === 'custom' && model) $('#provider-model').value = model;
    if ($('#provider-api-key')) {
      $('#provider-api-key').placeholder = meta.hasKey
        ? 'Key stored — leave blank to keep it'
        : meta.kind === 'custom' ? 'Your provider API key' : 'sm_live_…';
    }
    if (meta.kind === 'custom' || configured) this.selectedModel = model || this.selectedModel;
    // The local-first shell reuses the sidebar identity slot for the open folder and provider state.
    this.renderSidebarFolder();
    if ($('#user-email')) $('#user-email').textContent = configured ? model : 'Provider not configured';
    // The statusbar mirrors provider state at a glance.
    if ($('#statusbar-provider')) {
      $('#statusbar-provider').textContent = configured
        ? `${kindLabel} · ${baseUrl || 'endpoint not set'}`
        : 'Provider not configured';
    }
    this.renderModelPill();
  },

  // The active model is the button next to Send (src/composer-ui.js) and the statusbar.
  renderModelPill() {
    const model = this.provider?.model || '';
    if ($('#statusbar-model')) $('#statusbar-model').textContent = model || 'No model';
    renderModelButton(this);
  },

  // Every model the provider offers is available; there is no per-model enable step any more.
  // The composer's model menu (src/composer-ui.js) is the main place to switch.
  renderProviderModels() {
    this.renderModelSelect();
    renderModelButton(this);
    renderMediaBar(this);
  },

  // ---- Saved providers (Assistant) -----------------------------------------------
  renderProfiles() {
    const select = $('#profile-select');
    if (!select) return;
    const profiles = Array.isArray(this.providerProfiles) ? this.providerProfiles : [];
    const activeId = this.provider?.profileId;
    select.replaceChildren(...profiles.map((profile) => {
      const option = document.createElement('option');
      option.value = profile.id;
      const status = profile.id === activeId ? (this.provider?.configured ? 'active' : 'active · not connected')
        : (profile.configured ? profile.model || 'connected' : 'not connected');
      option.textContent = `${profile.name} — ${status}`;
      return option;
    }));
    if (activeId) select.value = activeId;
    const name = $('#profile-name');
    const active = profiles.find((profile) => profile.id === activeId);
    if (name && document.activeElement !== name) name.value = active?.name || this.provider?.profileName || '';
    const remove = $('#profile-remove');
    if (remove) remove.disabled = profiles.length < 2;
  },

  async afterProfileChange(result, message) {
    if (!result?.ok) { this.showToast(result?.error?.message || 'Provider settings could not be changed'); return; }
    this.providerProfiles = result.data.profiles;
    await this.loadProvider();
    this.renderProfiles();
    if (message) this.showToast(message);
  },

  bindProfiles() {
    const bridge = this.getProviderBridge();
    window.addEventListener('scalemax:profiles-changed', () => this.renderProfiles());
    $('#profile-select')?.addEventListener('change', async (event) => {
      const result = await bridge?.selectProfile?.({ id: event.target.value });
      await this.afterProfileChange(result, `Provider: ${this.providerProfiles?.find((item) => item.id === event.target.value)?.name || 'switched'}`);
    });
    $('#profile-add')?.addEventListener('click', async () => {
      const result = await bridge?.addProfile?.({});
      await this.afterProfileChange(result, 'New provider added. Choose its type, add the key, then Test and Save.');
      $('#provider-api-key')?.focus();
    });
    $('#profile-remove')?.addEventListener('click', async () => {
      const active = this.providerProfiles?.find((item) => item.id === this.provider?.profileId);
      if (!active || !window.confirm(`Remove the provider "${active.name}" and its stored key?`)) return;
      const result = await bridge?.removeProfile?.({ id: active.id });
      await this.afterProfileChange(result, `Removed ${active.name}`);
    });
    const rename = async () => {
      const input = $('#profile-name');
      const id = this.provider?.profileId;
      const name = input?.value.trim();
      const current = this.providerProfiles?.find((item) => item.id === id);
      if (!id || !name || name === current?.name) { if (input && current) input.value = current.name; return; }
      const result = await bridge?.renameProfile?.({ id, name });
      if (!result?.ok) { this.showToast(result?.error?.message || 'Could not rename'); return; }
      this.providerProfiles = result.data.profiles;
      this.provider = { ...this.provider, profileName: name };
      this.renderProfiles();
      this.showToast('Provider renamed');
    };
    $('#profile-name')?.addEventListener('change', () => void rename());
    $('#profile-name')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void rename(); } });
    void refreshProfiles(this).then(() => this.renderProfiles());
  },

  // The open folder shows on the composer chip, in the chat header and in the sidebar footer.
  renderFolder() {
    this.renderFolderChip();
    this.renderChatCrumb();
    this.renderSidebarFolder();
    if ($('#folder-menu')?.matches(':popover-open')) renderFolderMenu(this);
  },

  // The folder chip in the composer: the workspace the assistant's local tools work in. It opens
  // the folder menu (src/composer-ui.js).
  renderFolderChip() {
    const chip = $('#folder-chip');
    const label = $('#folder-chip-label');
    if (!chip || !label) return;
    const root = this.workspace?.root || '';
    const name = folderName(root);
    label.textContent = name || 'No folder';
    chip.classList.toggle('empty', !root);
    chip.title = root ? `Workspace folder: ${root}` : 'No folder open. Choose one for chat and the Workspace view.';
    chip.setAttribute('aria-label', root ? `Workspace folder: ${name}. Folder options` : 'No workspace folder. Folder options');
  },

  // "<folder> / Chat" above the conversation, "Workspace / Chat" without a folder.
  renderChatCrumb() {
    const crumb = $('#chat-crumb');
    if (!crumb) return;
    const root = this.workspace?.root || '';
    const separator = element('span', 'chat-crumb-separator', '/');
    separator.setAttribute('aria-hidden', 'true');
    crumb.replaceChildren(element('span', root ? 'chat-crumb-folder' : '', folderName(root) || 'Workspace'), ' ', separator, ' Chat');
    if (root) crumb.title = root;
    else crumb.removeAttribute('title');
  },

  renderSidebarFolder() {
    const node = $('#user-name');
    if (!node) return;
    const root = this.workspace?.root || '';
    node.textContent = folderName(root) || 'Local workspace';
    if (root) node.title = root;
    else node.removeAttribute('title');
  },

  // Chat-capable, available models for the Assistant's "Model for chat" picker.
  modelOptions() {
    const catalog = this.providerCatalog || [];
    return catalog.filter((model) => model.available !== false && model.chat !== false);
  },

  renderModelSelect() {
    const button = $('#model-picker-button');
    const list = $('#model-picker-list');
    if (!button || !list) return;
    const options = this.modelOptions();
    if (this.selectedModel && !options.some((model) => model.id === this.selectedModel)) {
      this.selectedModel = '';
    }
    const active = this.selectedModel || this.provider?.model || '';
    const chosen = options.find((model) => model.id === active);
    if (chosen) this.selectedModel = chosen.id;
    button.textContent = chosen
      ? (chosen.displayName && chosen.displayName !== chosen.id
        ? `${chosen.displayName} — ${chosen.id}` : chosen.id)
      : (options.length ? 'Choose a model' : 'Test the connection to load models');
    button.disabled = options.length === 0;
    list.replaceChildren(...options.map((model) => {
      const option = element('button', 'picker-option');
      option.dataset.modelId = model.id;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(model.id === chosen?.id));
      option.append(
        element('span', 'picker-option-name', model.displayName || model.id),
        element('span', 'picker-option-id', model.id),
      );
      return option;
    }));
  },

  toggleModelPicker(open) {
    const list = $('#model-picker-list');
    const button = $('#model-picker-button');
    if (!list || !button) return;
    const next = open ?? list.hidden;
    list.hidden = !next;
    button.setAttribute('aria-expanded', String(next));
  },

  async saveProvider() {
    const bridge = this.getProviderBridge();
    if (!bridge?.save) { this.showToast('Provider connections require the desktop app'); return; }
    const kind = this.providerKindValue();
    const model = kind === 'custom' ? ($('#provider-model')?.value.trim() || '') : (this.selectedModel || '');
    const input = {
      kind,
      model,
      // Kept for the stored record's shape: the chat model is the only "enabled" one.
      enabledModels: kind === 'custom' || !model ? [] : [model],
      models: this.providerCatalog || [],
    };
    if (kind === 'custom') input.baseUrl = $('#provider-base-url')?.value.trim() || '';
    else if (this.providerBase) input.baseUrl = this.providerBase;
    const apiKey = $('#provider-api-key')?.value ?? '';
    // Omit the key when the field is blank so the stored key is retained.
    if (apiKey.trim()) input.apiKey = apiKey.trim();
    const result = await bridge.save(input);
    if (!result?.ok) {
      const message = result?.error?.message || 'Provider settings could not be saved';
      this.showToast(message);
      if ($('#provider-status')) $('#provider-status').textContent = message;
      return;
    }
    this.provider = result.data;
    this.providerCatalog = Array.isArray(result.data.models) ? result.data.models : this.providerCatalog;
    this.enabledModels = new Set(Array.isArray(result.data.enabledModels) ? result.data.enabledModels : []);
    this.providerBase = result.data.baseUrl || this.providerBase;
    if ($('#provider-api-key')) $('#provider-api-key').value = '';
    this.renderProviderStatus();
    this.renderProviderModels();
    this.showToast('Provider settings saved');
    void refreshProfiles(this).then(() => this.renderProfiles());
  },

  // Green on success, red on failure or when the check takes too long.
  setTestDot(state) {
    const dot = $('#provider-test-dot');
    if (!dot) return;
    dot.classList.toggle('pending', state === 'pending');
    dot.classList.toggle('ok', state === 'ok');
    dot.classList.toggle('fail', state === 'fail');
    dot.setAttribute('aria-label', state === 'pending' ? 'Testing connection'
      : state === 'ok' ? 'Connection succeeded'
        : state === 'fail' ? 'Connection failed' : 'Connection status');
  },

  async testProvider() {
    const bridge = this.getProviderBridge();
    if (!bridge?.discover) { this.showToast('Provider connections require the desktop app'); return; }
    const button = $('#provider-test');
    if (button) button.disabled = true;
    this.setTestDot('pending');
    if ($('#provider-status')) $('#provider-status').textContent = 'Testing connection and loading models…';
    try {
      const input = { kind: this.providerKindValue() };
      const apiKey = $('#provider-api-key')?.value ?? '';
      if (apiKey.trim()) input.apiKey = apiKey.trim();
      if (input.kind === 'custom') input.baseUrl = $('#provider-base-url')?.value.trim() || '';
      let slowTimer;
      const result = await Promise.race([
        bridge.discover(input),
        new Promise((resolve) => {
          slowTimer = setTimeout(() => resolve({ ok: false, error: { message: 'The provider did not respond in time.' } }), 20000);
        }),
      ]).finally(() => clearTimeout(slowTimer));
      if (!result?.ok) {
        const message = result?.error?.message || 'Provider connection failed';
        this.setTestDot('fail');
        if ($('#provider-status')) $('#provider-status').textContent = message;
        this.showToast(message);
        return;
      }
      this.providerBase = result.data.baseUrl;
      this.providerCatalog = Array.isArray(result.data.models) ? result.data.models : [];
      // Keep the chosen model if the provider still offers it; otherwise pick the first chat model.
      const options = this.modelOptions();
      const keep = options.find((model) => model.id === (this.selectedModel || this.provider?.model));
      const first = keep || options[0];
      this.selectedModel = first ? first.id : '';
      this.enabledModels = new Set(first ? [first.id] : []);
      this.provider = {
        ...(this.provider || {}),
        kind: result.data.kind,
        baseUrl: result.data.baseUrl,
        models: this.providerCatalog,
        enabledModels: [...this.enabledModels],
      };
      this.renderProviderModels();
      this.renderProviderStatus();
      const count = this.providerCatalog.length;
      if ($('#provider-status')) {
        $('#provider-status').textContent = `Connection succeeded — ${count} model${count === 1 ? '' : 's'} found at ${result.data.baseUrl}.`;
      }
      this.setTestDot('ok');
      this.showToast('Provider connection succeeded');
    } finally {
      if (button) button.disabled = false;
    }
  },

  async clearProvider() {
    const bridge = this.getProviderBridge();
    if (!bridge?.clear) { this.showToast('Provider connections require the desktop app'); return; }
    if (!window.confirm('Clear the saved provider settings and API key?')) return;
    const result = await bridge.clear();
    if (!result?.ok) { this.showToast(result?.error?.message || 'Provider could not be cleared'); return; }
    this.provider = result.data;
    this.providerCatalog = [];
    this.enabledModels = new Set();
    this.providerBase = '';
    if ($('#provider-api-key')) $('#provider-api-key').value = '';
    this.renderProviderStatus();
    this.renderProviderModels();
    this.showToast('Provider cleared');
    void refreshProfiles(this).then(() => this.renderProfiles());
  },

  bindProvider() {
    $('#provider-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.saveProvider();
    });
    $('#provider-test')?.addEventListener('click', (event) => {
      event.preventDefault();
      void this.testProvider();
    });
    $('#provider-clear')?.addEventListener('click', (event) => {
      event.preventDefault();
      void this.clearProvider();
    });
    $('#provider-kind')?.addEventListener('change', () => this.applyProviderKind());
    $('#model-picker-button')?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.toggleModelPicker();
    });
    $('#model-picker-list')?.addEventListener('click', (event) => {
      const option = event.target.closest('.picker-option[data-model-id]');
      if (!option) return;
      this.selectedModel = option.dataset.modelId;
      this.toggleModelPicker(false);
      this.renderModelSelect();
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('#model-picker')) this.toggleModelPicker(false);
    });
    $('#cancel-btn')?.addEventListener('click', () => this.cancelResponse());
  },

  // ---- Attachments ---------------------------------------------------------
  setAttachment(attachment) {
    this.attachment = attachment;
    if ($('#attachment-row')) $('#attachment-row').hidden = !attachment;
    if ($('#attachment-status')) $('#attachment-status').textContent = attachment ? attachment.name : '';
    if ($('#remove-attachment-btn')) $('#remove-attachment-btn').hidden = !attachment;
  },

  clearAttachment() {
    this.setAttachment(null);
  },

  // Attaches the file open in the editor, otherwise asks for one.
  async attachFile() {
    const open = this.workspace.openPath;
    const content = open && this.workspace.root ? activeTabContent() : null;
    if (typeof content === 'string') {
      // The editor copy includes unsaved edits, which is what the user sees.
      this.setAttachment({ path: open, name: open.split('/').pop(), content });
      return;
    }
    const bridge = window.scalemaxAPI?.dialog;
    if (!bridge?.openFile) { this.showToast('Attachments require the desktop app'); return; }
    const picked = await bridge.openFile();
    if (!picked?.ok) { this.showToast(picked?.error?.message || 'Could not attach that file'); return; }
    if (!picked.data) return;
    if (picked.data.content.length > MAX_ATTACHMENT_BYTES) {
      this.showToast('That file is too large to attach');
      return;
    }
    this.setAttachment({ path: picked.data.path, name: picked.data.name, content: picked.data.content });
  },

  // ---- Workspace -----------------------------------------------------------
  workspaceBridge() {
    return window.scalemaxAPI?.workspace || null;
  },

  async openWorkspace() {
    const dialog = window.scalemaxAPI?.dialog;
    if (!dialog?.openFolder) { this.showToast('Opening folders requires the desktop app'); return; }
    const picked = await dialog.openFolder();
    if (!picked?.ok) { this.showToast(picked?.error?.message || 'Could not open that folder'); return; }
    if (!picked.data?.path || !this.workspaceBridge()?.select) return;
    // The folder the user picked wins over a task's folder that is still waiting to open.
    this.folderSequence += 1;
    const result = await this.runFolderJob(() => this.selectFolderNow(picked.data.path));
    if (!result?.ok) { this.showToast(result?.error?.message || 'Could not open that folder'); return; }
    this.showToast('Folder opened');
  },

  // A remembered folder from the folder menu's Recent list.
  async openWorkspaceAt(path) {
    if (!this.workspaceBridge()?.select) { this.showToast('Opening folders requires the desktop app'); return; }
    if (typeof path !== 'string' || !path) return;
    this.folderSequence += 1;
    const result = await this.runFolderJob(() => this.selectFolderNow(path));
    if (!result?.ok) { this.showToast(result?.error?.message || 'Could not open that folder'); return; }
    this.showToast(`Opened ${folderName(result.data.root)}`);
  },

  // Folder switches run one at a time: main keeps only the newest selection, and the folder it
  // has open must be the one on screen.
  runFolderJob(job) {
    const run = this.folderQueue.then(job);
    // A failed switch must not stop the ones queued behind it; callers still see the failure.
    this.folderQueue = run.catch(() => {});
    return run;
  },

  // Only from inside runFolderJob. main closes the open folder before it checks the new one
  // (lib/workspace.cjs), so after a refusal the previous folder is opened again; otherwise chat
  // would run without a folder while the screen still showed one.
  async selectFolderNow(path) {
    const bridge = this.workspaceBridge();
    const previous = this.workspace.root;
    let result;
    try {
      result = await bridge.select(path);
    } catch (error) {
      result = { ok: false, error };
    }
    if (result?.ok) {
      this.applyWorkspace(result.data);
      return result;
    }
    if (!previous) return result;
    let reopened = null;
    try {
      reopened = await bridge.select(previous);
      // The previous folder is gone too: show what main has open now (nothing).
      if (!reopened?.ok) reopened = await bridge.current?.();
    } catch (error) {
      console.warn('[app] Could not reopen the previous folder:', error);
    }
    if (reopened?.ok) this.applyWorkspace(reopened.data);
    return result;
  },

  // Main reopens the folder from the last run on the first call, so chat and the Workspace
  // view start where the user left off. The recent folders come along for the folder menu.
  async restoreWorkspace() {
    let result = null;
    try {
      result = await this.workspaceBridge()?.current?.();
    } catch (error) {
      console.warn('[app] Could not read the open folder:', error);
    }
    if (result?.ok && Array.isArray(result.data?.recent)) this.workspace.recent = result.data.recent;
    if (result?.ok && result.data?.root) this.applyWorkspace(result.data);
    else this.renderFolder();
  },

  async refreshWorkspace() {
    const bridge = this.workspaceBridge();
    if (!bridge || !this.workspace.root) return;
    const result = await bridge.list();
    if (result?.ok) {
      // Keep the open tabs; drop cached folder contents so the tree reloads.
      this.workspace.tree = {};
      if (this.workspace.expanded) this.workspace.expanded.clear();
      resetCrawl();
      this.applyWorkspace(result.data);
      void this.refreshGit({ quiet: true });
    }
  },

  applyWorkspace(data) {
    const rootChanged = this.workspace.root !== (data?.root || '');
    this.workspace.root = data?.root || '';
    this.workspace.files = Array.isArray(data?.files) ? data.files : [];
    // select() and current() report the remembered folders; list() does not.
    if (Array.isArray(data?.recent)) this.workspace.recent = data.recent;
    if (rootChanged) {
      // Open tabs belong to the previous project; close them before the
      // editor can save stale content into the new root.
      this.workspace.tree = {};
      this.workspace.expanded = new Set();
      resetTabs(this);
      this.workspace.diffPath = '';
      const git = $('#git-files');
      if (git) git.replaceChildren();
      const diff = $('#git-diff');
      if (diff) diff.replaceChildren();
      if ($('#git-status')) $('#git-status').textContent = 'Open a repository to review its changes.';
    }
    renderCrumb(this.workspace.root);
    this.renderFolder();
    if ($('#workspace-status')) {
      const count = this.workspace.files.length;
      $('#workspace-status').textContent = this.workspace.root
        ? `${count} entr${count === 1 ? 'y' : 'ies'}${count >= 1000 ? ' (list truncated)' : ''}`
        : 'Open a local folder to begin.';
    }
    this.renderFileTree();
    // A Git repository gets its branch and changed files straight away.
    if (rootChanged && this.workspace.root) void this.refreshGit({ quiet: true });
  },

  // Tree, tabs and editor chrome live in workspace-ui.js.
  renderFileTree() {
    renderTree(this);
  },

  async toggleFolder(path) {
    if (!path) return;
    if (!this.workspace.expanded) this.workspace.expanded = new Set();
    if (this.workspace.expanded.has(path)) {
      this.workspace.expanded.delete(path);
      this.renderFileTree();
      return;
    }
    if (!this.workspace.tree[path]) {
      const bridge = this.workspaceBridge();
      if (!bridge?.list) { this.showToast('Folders require the desktop app'); return; }
      const result = await bridge.list(path);
      if (!result?.ok) { this.showToast(result?.error?.message || 'Could not open that folder'); return; }
      this.workspace.tree[path] = Array.isArray(result.data?.files) ? result.data.files : [];
    }
    this.workspace.expanded.add(path);
    this.renderFileTree();
  },

  updateEditorGutter() {
    updateGutter();
  },

  // Opens the file in a tab (or focuses its tab); unsaved edits in other tabs are kept.
  openFile(path) {
    return openFileInTab(this, path);
  },

  saveFile() {
    return saveActiveTab(this);
  },

  async refreshGit({ quiet = false } = {}) {
    const bridge = this.workspaceBridge();
    if (!bridge || !this.workspace.root) { if (!quiet) this.showToast('Open a folder first'); return; }
    const root = this.workspace.root;
    const status = await bridge.gitStatus();
    if (this.workspace.root !== root) return;
    if (!status?.ok) {
      if ($('#git-status')) $('#git-status').textContent = status?.error?.message || 'Git is unavailable.';
      setGitDecorations(this, [], null, false);
      return;
    }
    const data = status.data || {};
    setGitDecorations(this, data.files, data.branch, data.isRepo);
    if ($('#git-status')) {
      const count = Array.isArray(data.files) ? data.files.length : 0;
      $('#git-status').textContent = data.isRepo
        ? `On ${data.branch || 'HEAD'} · ${count} changed file${count === 1 ? '' : 's'}`
        : 'Not a git repository.';
    }
    const files = Array.isArray(data.files) ? data.files : [];
    if ($('#git-files')) {
      $('#git-files').replaceChildren(...files.map((file) => {
        const path = typeof file === 'string' ? file : (file.path || '');
        const state = typeof file === 'string' ? '' : (file.status || '');
        const row = element('button', 'git-row');
        row.dataset.gitPath = path;
        row.append(
          element('span', `git-status-code ${gitStatusClass(state)}`, gitStatusLetter(state)),
          element('span', 'file-name', path),
        );
        return row;
      }));
    }
    // Keep showing the file the user picked, if any.
    await this.showGitDiff(this.workspace.diffPath || '', { reveal: false });
  },

  async showGitDiff(path, { reveal = true } = {}) {
    const bridge = this.workspaceBridge();
    if (!bridge) return;
    const node = $('#git-diff');
    if (!node) return;
    this.workspace.diffPath = path || '';
    for (const row of $$('#git-files .git-row')) row.classList.toggle('active', row.dataset.gitPath === path);
    // Choosing a changed file shows its diff in the Diff tab.
    if (path && reveal) showPanel('diff');
    // Only the latest request may paint; a slower full diff never replaces a file diff.
    const sequence = (this.diffSequence = (this.diffSequence || 0) + 1);
    const diff = await bridge.gitDiff(path || '');
    if (sequence !== this.diffSequence) return;
    if (!diff?.ok) { node.replaceChildren(); return; }
    const text = diff.data.diff || '';
    if (!text) {
      node.replaceChildren(element('span', 'diff-line', path ? `No unstaged changes in ${path}.` : 'No changes to show.'));
      return;
    }
    node.replaceChildren(...text.split('\n').map((line) => {
      let className = 'diff-line';
      if (/^(diff |index |--- |\+\+\+ |@@ )/.test(line)) className += ' is-meta';
      else if (line.startsWith('+')) className += ' is-add';
      else if (line.startsWith('-')) className += ' is-del';
      return element('span', className, line);
    }));
  },

  bindEvents() {
    if (this.eventsBound) return;
    this.eventsBound = true;
    $('#sidebar-nav')?.addEventListener('click', (event) => {
      const item = event.target.closest('.sidebar-item[data-view]');
      if (item) this.switchView(item.dataset.view);
    });
    $('#panel-toggle-btn')?.addEventListener('click', () => {
      const sidebar = $('#sidebar');
      if (!sidebar) return;
      sidebar.classList.toggle('collapsed');
      $('#panel-toggle-btn')?.setAttribute('aria-expanded', String(!sidebar.classList.contains('collapsed')));
    });
    $('#tasks-list')?.addEventListener('click', (event) => {
      const row = event.target.closest('.task-item[data-task-id]');
      if (row) this.selectTask(row.dataset.taskId);
    });
    $('#new-task-btn')?.addEventListener('click', () => this.newTask());
    $('#chat-input')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.handleSend();
      }
    });
    $('#chat-input')?.addEventListener('input', () => this.updateSendEnabled());
    $('#send-btn')?.addEventListener('click', (event) => {
      event.preventDefault();
      this.handleSend();
    });
    $('#mode-switch')?.addEventListener('click', (event) => {
      const button = event.target.closest('.mode-btn[data-mode]');
      if (!button) return;
      this.settings.mode = button.dataset.mode;
      $$('#mode-switch .mode-btn[data-mode]').forEach((node) => {
        const selected = node.dataset.mode === this.settings.mode;
        node.classList.toggle('sm-scene-tabs__pill--active', selected);
        node.setAttribute('aria-pressed', String(selected));
      });
      void this.persist('settings');
    });
    $('#tag-row')?.addEventListener('click', (event) => {
      const chip = event.target.closest('.tag-chip[data-tag]');
      if (!chip) return;
      const prompt = TAG_PROMPTS[chip.dataset.tag];
      if (!prompt) return;
      const input = $('#chat-input');
      if (!input) return;
      input.value = prompt;
      input.focus();
      this.updateSendEnabled();
    });
    // Preferences > Projects. Main reads the saved setting before the next chat request.
    $('#project-notes-toggle')?.addEventListener('click', async () => {
      this.settings.projectNotes = this.settings.projectNotes === false;
      this.renderProjectNotesToggle();
      await this.persist('settings');
    });
    $('#attach-btn')?.addEventListener('click', (event) => {
      event.preventDefault();
      void this.attachFile();
    });
    $('#remove-attachment-btn')?.addEventListener('click', (event) => {
      event.preventDefault();
      this.clearAttachment();
    });
    $('#workspace-open')?.addEventListener('click', (event) => {
      event.preventDefault();
      void this.openWorkspace();
    });
    $('#workspace-refresh')?.addEventListener('click', (event) => {
      event.preventDefault();
      void this.refreshWorkspace();
    });
    $('#editor-save')?.addEventListener('click', (event) => {
      event.preventDefault();
      void this.saveFile();
    });
    $('#git-refresh')?.addEventListener('click', (event) => {
      event.preventDefault();
      void this.refreshGit();
    });
    $('#git-files')?.addEventListener('click', (event) => {
      const row = event.target.closest('[data-git-path]');
      if (row) void this.showGitDiff(row.dataset.gitPath);
    });
    this.bindCatalogs();
    this.bindAssistant();
    this.bindProvider();
    $('#automation-form')?.addEventListener('submit', (event) => this.createAutomation(event));
    $('#automation-list')?.addEventListener('click', (event) => this.changeAutomation(event));
    this.bindAutomationForm();
    $('#search-btn')?.addEventListener('click', () => this.toggleSearch(true));
    $('#search-close')?.addEventListener('click', () => this.toggleSearch(false));
    $('#search-input')?.addEventListener('input', () => this.renderSearch());
    $('#search-results')?.addEventListener('click', (event) => {
      const task = event.target.closest('.search-result[data-task-id]');
      if (task) {
        this.selectTask(task.dataset.taskId);
        this.toggleSearch(false);
        return;
      }
      const resource = event.target.closest('.search-result[data-resource-kind]');
      if (!resource) return;
      this.toggleSearch(false);
      openResourceDetail(this, resource.dataset.resourceKind, resource.dataset.resourceId);
    });
    $('#context-chips')?.addEventListener('click', (event) => {
      const chip = event.target.closest('.context-chip[data-context-kind]');
      if (!chip) return;
      const kind = chip.dataset.contextKind;
      if (kind === 'expert') this.settings.expertId = null;
      if (kind === 'skill') {
        this.settings.skillId = null;
        if (chip.dataset.contextId) this.skillStates[chip.dataset.contextId] = 'available';
      }
      void this.persist('settings');
      void this.persist('skillStates');
      this.renderExperts();
      this.renderSkills();
      this.renderContextChips();
      this.showToast(kind === 'expert' ? 'Expert cleared' : 'Skill removed');
    });
  },

  switchView(view) {
    if (!Object.hasOwn(VIEW_NAMES, view)) return;
    $$('#sidebar-nav .sidebar-item[data-view]').forEach((item) => {
      const selected = item.dataset.view === view;
      item.classList.toggle('active', selected);
      if (selected) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
    $$('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));
  },

  makeTask(title) {
    const now = Date.now();
    const suffix = Math.random().toString(36).slice(2, 8);
    return { id: `task-${now}-${suffix}`, title, messages: [], createdAt: now, updatedAt: now };
  },

  newTask() {
    const task = this.makeTask('New Task');
    this.tasks.unshift(task);
    void this.persist('tasks');
    this.selectTask(task.id);
    // A typed-but-unsent draft is kept: it belongs to the composer, not the task.
    $('#chat-input')?.focus();
    this.updateSendEnabled();
  },

  selectTask(id) {
    const task = this.tasks.find((item) => item.id === id);
    if (!task) return;
    this.currentTaskId = id;
    this.switchView('chat');
    this.renderTasks();
    this.renderChat();
    // A chat opens the folder it was started in. The switch waits for one still in flight, so
    // its check sees the folder that switch left open; the newest selection wins.
    const sequence = (this.folderSequence += 1);
    if (task.folder && this.workspaceBridge()?.select) {
      this.runFolderJob(() => this.switchToTaskFolder(task, sequence))
        .catch((error) => this.showGlobalError(error?.message || 'The task folder could not be opened'));
    }
  },

  // Runs inside runFolderJob (see selectTask).
  async switchToTaskFolder(task, sequence) {
    const folder = task?.folder;
    if (!folder || sequence !== this.folderSequence || folder.path === this.workspace.root) return;
    if (this.workspace.dirty || this.workspace.tabs?.some((tab) => tab.dirty)) {
      this.showToast(`This task belongs to "${folder.name}". Save your edits first, then open it from the folder menu.`);
      return;
    }
    // selectFolderNow applies the result even if the user moved on meanwhile: main has that
    // folder open now. Only the newest selection reports anything.
    const result = await this.selectFolderNow(folder.path);
    if (sequence !== this.folderSequence) return;
    this.showToast(result?.ok ? `Switched to folder ${folder.name}` : `This task's folder "${folder.name}" is not available any more.`);
  },

  renderTasks() {
    const list = $('#tasks-list');
    const count = $('#task-count');
    if (count) count.textContent = String(this.tasks.length);
    if (list) list.replaceChildren(...this.tasks.map((task) => {
      const row = element('button', 'task-item');
      row.dataset.taskId = task.id;
      row.classList.toggle('active', task.id === this.currentTaskId);
      if (task.folder) row.title = `Folder: ${task.folder.name}`;
      row.append(element('span', 'task-title', task.title), element('span', 'task-time', relativeTime(task.updatedAt)));
      return row;
    }));
    this.renderSearch();
  },

  renderChat() {
    const container = $('#chat-messages');
    if (!container) return;
    const task = this.tasks.find((item) => item.id === this.currentTaskId);
    const messages = task?.messages || [];
    container.replaceChildren(...messages.map((message) => {
      const bubble = element('div', `chat-bubble ${message.role}`);
      bubble.style.whiteSpace = 'pre-wrap';
      if (message.tools?.length) {
        const tools = element('div', 'msg-tools');
        tools.setAttribute('aria-label', 'Tools used for this reply');
        tools.append(element('span', 'msg-tools-label', 'Tools used'));
        for (const call of message.tools) {
          const chip = element('span', `msg-tool ${call.ok ? 'is-ok' : 'is-error'}`,
            `${call.server ? `${call.server} · ` : ''}${call.tool}${call.ok ? '' : ' (failed)'}`);
          tools.append(chip);
        }
        bubble.append(tools);
      }
      // "Thought for Ns" above answers from a thinking model; it unfolds to the thinking text
      // when the provider returned one.
      const thought = thoughtLabel(message);
      if (message.reasoning) {
        const thinking = element('details', 'msg-reasoning');
        thinking.append(element('summary', 'msg-reasoning-label', thought || 'Thinking'), element('div', 'msg-reasoning-text', message.reasoning));
        bubble.append(thinking);
      } else if (thought) {
        bubble.append(element('span', 'msg-reasoning-label msg-thought', thought));
      }
      bubble.append(element('span', 'msg-text', message.text));
      if (message.mediaRequest) bubble.append(element('span', 'msg-media-request', message.mediaRequest));
      if (message.media?.length) bubble.append(renderMediaItems(this, message.media));
      if (message.notice) {
        const notice = element('span', 'msg-notice', message.notice);
        notice.setAttribute('role', 'note');
        bubble.append(notice);
      }
      bubble.append(element('span', 'msg-time', clock(message.time)));
      return bubble;
    }));
    const pending = this.pendingReply?.taskId === this.currentTaskId ? this.pendingReply : null;
    if (pending) container.append(this.renderPendingReply(pending));
    container.scrollTop = container.scrollHeight;
    // The welcome hero and starter controls are a first-run surface: once the
    // task has messages the view becomes a plain transcript.
    $('.sm-home-page')?.classList.toggle('has-transcript', messages.length > 0 || Boolean(pending));
  },

  // The bubble shown while a reply is in progress: thinking, running a tool, or waiting for approval.
  renderPendingReply(pending) {
    const bubble = element('div', 'chat-bubble assistant pending-reply');
    bubble.setAttribute('role', 'status');
    const row = element('span', 'pending-reply-row');
    const dots = element('span', 'thinking-dots');
    dots.setAttribute('aria-hidden', 'true');
    dots.append(element('span', 'thinking-dot'), element('span', 'thinking-dot'), element('span', 'thinking-dot'));
    row.append(dots, element('span', 'pending-reply-text', pendingText(pending)),
      element('span', 'pending-reply-time', elapsedText(Date.now() - pending.startedAt)));
    bubble.append(row);
    return bubble;
  },

  updatePendingReply() {
    const pending = this.pendingReply;
    const node = $('#chat-messages .pending-reply');
    if (!pending || !node) return;
    node.querySelector('.pending-reply-text').textContent = pendingText(pending);
    node.querySelector('.pending-reply-time').textContent = elapsedText(Date.now() - pending.startedAt);
  },

  startPendingReply(taskId, requestId, extra = {}) {
    const model = (this.providerCatalog || []).find((item) => item.id === this.provider?.model);
    // "Thinking" only for models that reason with thinking on; others are "Writing".
    const thinking = model?.reasoning === true && this.settings.thinking !== false;
    this.pendingReply = { taskId, requestId, phase: 'thinking', thinking, tool: '', startedAt: Date.now(), ...extra };
    window.clearInterval(this.pendingTimer);
    this.pendingTimer = window.setInterval(() => this.updatePendingReply(), 1000);
    this.renderChat();
  },

  stopPendingReply() {
    window.clearInterval(this.pendingTimer);
    const had = Boolean(this.pendingReply);
    this.pendingReply = null;
    if (had) this.renderChat();
  },

  bindReplyProgress() {
    this.getProviderBridge()?.onProgress?.((progress) => {
      const pending = this.pendingReply;
      if (!pending || !progress || progress.requestId !== pending.requestId) return;
      if (!['thinking', 'tool', 'approval'].includes(progress.phase)) return;
      pending.phase = progress.phase;
      pending.tool = progress.toolName ? `${progress.serverId ? `${progress.serverId} · ` : ''}${progress.toolName}` : '';
      this.updatePendingReply();
    });
  },

  updateTask(task, time = Date.now()) {
    task.updatedAt = time;
    void this.persist('tasks');
    this.renderTasks();
  },

  appendMessage(role, text, taskId = this.currentTaskId, extra = {}) {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) { this.showToast('That task no longer exists'); return; }
    if (role === 'user' && !task.messages.some((message) => message.role === 'user')) {
      task.title = text.length > 40 ? `${text.slice(0, 40)}…` : text;
      // The chat belongs to the folder it starts in; selecting the task later opens it again.
      if (this.workspace.root) task.folder = { name: folderName(this.workspace.root), path: this.workspace.root };
    }
    const message = { role, text, time: Date.now() };
    const tools = normalizeToolSummaries(extra.tools);
    if (tools.length) message.tools = tools;
    if (typeof extra.reasoning === 'string' && extra.reasoning.trim()) message.reasoning = extra.reasoning.slice(0, 65536);
    if (Number.isSafeInteger(extra.thinkingMs) && extra.thinkingMs >= 0) message.thinkingMs = extra.thinkingMs;
    const media = normalizeMediaItems(extra.media);
    if (media.length) message.media = media;
    if (typeof extra.mediaRequest === 'string' && extra.mediaRequest) message.mediaRequest = extra.mediaRequest.slice(0, 300);
    if (typeof extra.notice === 'string' && extra.notice.trim()) message.notice = extra.notice.trim().slice(0, 300);
    task.messages.push(message);
    this.updateTask(task, message.time);
    if (this.currentTaskId === taskId) this.renderChat();
  },

  async handleSend() {
    const input = $('#chat-input');
    const text = input?.value.trim();
    if (!text || this.activeRequestId) return;
    const taskId = this.currentTaskId;
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) return;
    // Image / video mode: the text is the prompt for the selected generation model.
    if (mediaMode(this)) {
      input.value = '';
      this.updateSendEnabled();
      const sent = await generateFromComposer(this, text, taskId);
      if (!sent) input.value = text;
      this.updateSendEnabled();
      return;
    }
    this.appendMessage('user', text, taskId);
    input.value = '';
    this.updateSendEnabled();

    const bridge = this.getProviderBridge();
    if (!bridge?.send || !this.provider?.configured) {
      // No provider yet — keep the workspace demoable with a labelled reply.
      if (this.demoBusy) return;
      this.demoBusy = true;
      this.updateSendEnabled();
      window.setTimeout(() => {
        this.appendMessage('assistant', this.localDemoReply(text), taskId);
        this.demoBusy = false;
        this.updateSendEnabled();
      }, 400);
      return;
    }

    // Build the conversation from the persisted task so the reply always matches
    // the message that was sent, even if the user switches tasks meanwhile.
    const attachment = this.attachment;
    const messages = task.messages.map((message) => ({ role: message.role, content: message.text }));
    if (attachment) {
      const last = messages[messages.length - 1];
      const block = `Attached file: ${attachment.path}\n\n\`\`\`\n${attachment.content}\n\`\`\``;
      if (last && last.role === 'user') last.content = `${last.content}\n\n${block}`;
      else messages.push({ role: 'user', content: block });
      // The attachment is now part of the sent message; it must not ride
      // along with every later message.
      this.clearAttachment();
    }
    // A connected GitHub connector feeds live repo data into the request.
    const repoMatch = GITHUB_REPO_PATTERN.exec(text);
    if (repoMatch) {
      const context = await this.fetchGithubContext(repoMatch[1], repoMatch[2].replace(/\.git$/, ''));
      if (context) {
        const last = messages[messages.length - 1];
        if (last && last.role === 'user') last.content = `${last.content}\n\nLive GitHub data:\n${context}`;
        else messages.push({ role: 'user', content: `Live GitHub data:\n${context}` });
      }
    }
    const requestId = `chat-${taskId}-${Date.now()}`;
    const payload = { requestId, messages, systemPrompt: this.buildSystemPrompt(this.settings) };
    const temperature = requestTemperature(this.settings);
    if (temperature !== undefined) payload.temperature = temperature;
    // Thinking on/off and effort from the model menu; the provider only sends them to models
    // that report reasoning support.
    payload.reasoning = requestReasoning(this.settings);

    this.setChatBusy(true, requestId);
    this.startPendingReply(taskId, requestId);
    const thinking = Boolean(this.pendingReply?.thinking);
    const startedAt = Date.now();
    try {
      const result = await bridge.send(payload);
      this.stopPendingReply();
      if (!result?.ok) {
        const message = result?.error?.message || 'Provider request failed';
        if (result?.error?.code === 'CANCELLED') this.showToast('Response cancelled');
        else this.showToast(message);
        return;
      }
      // Model time only (tool runs and approvals excluded); plain sends report the whole wait.
      const thinkingMs = Number.isSafeInteger(result.data.thinkingMs) ? result.data.thinkingMs : Date.now() - startedAt;
      // Main wrote the project notes for this folder during the request: say so under the reply.
      const notes = result.data.projectNotes?.created === true ? result.data.projectNotes : null;
      const notesPath = typeof notes?.path === 'string' && notes.path ? notes.path : '.scalemax/SCALEMAX.md';
      this.appendMessage('assistant', result.data.text, taskId, {
        tools: result.data.toolCalls,
        reasoning: result.data.reasoning,
        ...(thinking ? { thinkingMs } : {}),
        ...(notes ? {
          notice: `Created ${notesPath}: project notes ScaleMax reads in every chat in this folder. Edit them any time, or type /init to have ScaleMax rewrite them.`,
        } : {}),
      });
      // The model changed files or ran a command in the workspace (or main created the notes):
      // reload the tree and Git status.
      const calls = Array.isArray(result.data.toolCalls) ? result.data.toolCalls : [];
      if (notes || calls.some((call) => call?.server === 'Workspace' && call.ok
        && ['write_file', 'edit_file', 'run_command'].includes(call.tool))) {
        void this.refreshWorkspace();
      }
      // A broken MCP server never blocks the reply, but the user should know.
      const toolError = Array.isArray(result.data.toolErrors) ? result.data.toolErrors[0] : null;
      if (toolError?.message) {
        this.showToast(`MCP${toolError.serverId ? ` ${toolError.serverId}` : ''}: ${toolError.message}`);
      }
    } catch (error) {
      this.showToast(error?.message || 'Provider request failed');
    } finally {
      this.stopPendingReply();
      this.setChatBusy(false);
    }
  },

  setChatBusy(busy, requestId = null) {
    this.activeRequestId = busy ? requestId : null;
    const cancel = $('#cancel-btn');
    if (cancel) { cancel.hidden = !busy; cancel.disabled = false; }
    this.updateSendEnabled();
  },

  cancelResponse() {
    if (cancelGeneration(this)) {
      const cancel = $('#cancel-btn');
      if (cancel) cancel.disabled = true;
      return;
    }
    const bridge = this.getProviderBridge();
    if (!this.activeRequestId || !bridge?.cancel) return;
    void bridge.cancel(this.activeRequestId);
    const cancel = $('#cancel-btn');
    if (cancel) cancel.disabled = true;
  },

  // Pulls live repo data through a connected GitHub connector. Returns a
  // context block, or null when the connector is not usable.
  async fetchGithubContext(owner, repo) {
    const bridge = window.scalemaxAPI?.connectors;
    if (!bridge?.fetch) return null;
    let result;
    try {
      result = await bridge.fetch({ id: 'github', action: 'repo', params: { owner, repo } });
    } catch {
      return null;
    }
    if (!result?.ok) {
      const message = result?.error?.message || 'GitHub context unavailable';
      if (/connect this service first/i.test(message)) this.showToast('Connect GitHub in Experts & resources to pull live repo data');
      else this.showToast(message);
      return null;
    }
    const data = result.data || {};
    const record = data.repo || {};
    const lines = [
      `${record.fullName || `${owner}/${repo}`}`,
      `${record.description || 'No description'}`,
      `Language: ${record.language || 'unknown'} · Stars: ${record.stars ?? 0} · Open issues: ${record.openIssues ?? 0} · Last push: ${record.pushedAt || 'unknown'}`,
    ];
    if (Array.isArray(data.issues) && data.issues.length) {
      lines.push('Open issues:');
      for (const issue of data.issues) lines.push(`  #${issue.number} ${issue.title} (${issue.state})`);
    }
    return lines.join('\n');
  },

  updateSendEnabled() {
    const input = $('#chat-input');
    const send = $('#send-btn');
    const busy = Boolean(this.activeRequestId || this.demoBusy);
    if (input) input.disabled = false;
    if (send) send.disabled = busy || !input?.value.trim();
  },

  localDemoReply(text) {
    return `Local demo response — configure a provider in Assistant for real AI replies.\n\n${this.simulateResponse(text)}`;
  },

  simulateResponse(text) {
    if (/\b(hello|hi|hey)\b/i.test(text)) {
      return "Hi there! I'm ScaleMax. What would you like to work on today?";
    }
    if (/\b(build|create)\b/i.test(text)) return 'Tell me what you want to build, who it is for, and which features matter most.';
    if (/\bcode\b/i.test(text)) return 'Which programming language or framework are you using? Share the code or describe the problem.';
    if (/\b(tasks?|todos?|to-do)\b/i.test(text)) return 'I can help break this into clear subtasks. What is the goal and what needs to be done first?';
    if (/\bautomations?\b/i.test(text)) return 'Open the Automation view to save a daily, weekly, or monthly automation.';
    return 'I can help plan your next steps or draft code. Share a little more detail about the result you want.';
  },

  applySettingsToUI() {
    $$('#mode-switch .mode-btn[data-mode]').forEach((button) => {
      const selected = button.dataset.mode === this.settings.mode;
      button.classList.toggle('sm-scene-tabs__pill--active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    if ($('#system-prompt')) $('#system-prompt').value = this.settings.systemPrompt;
    if ($('#temperature')) $('#temperature').value = this.settings.temperature;
    if ($('#temperature-enabled')) $('#temperature-enabled').checked = Boolean(this.settings.temperatureEnabled);
    this.renderTemperatureValue();
    this.renderProjectNotesToggle();
    renderPermission(this);
    renderModelButton(this);
  },

  // Preferences > Projects: main creates .scalemax/SCALEMAX.md unless this is off.
  renderProjectNotesToggle() {
    $('#project-notes-toggle')?.setAttribute('aria-checked', String(this.settings.projectNotes !== false));
  },

  renderExperts() {
    const grid = $('#experts-grid');
    if (!grid) return;
    const experts = this.allExperts();
    const heading = $('#experts-title');
    if (heading) {
      const custom = this.customExperts.length;
      heading.textContent = `${experts.length} roles${custom ? ` · ${custom} custom` : ''}`;
    }
    grid.replaceChildren(...experts.map((expert) => {
      const card = element('div', 'expert-card');
      card.dataset.expertId = expert.id;
      const selected = expert.id === this.settings.expertId;
      if (selected) card.classList.add('selected');
      const button = element('button', 'expert-use', selected ? 'Selected' : 'Use');
      button.dataset.expertId = expert.id;
      button.setAttribute('aria-pressed', String(selected));
      button.setAttribute('aria-label', `${selected ? 'Stop using' : 'Use'} ${expert.name}`);
      const avatar = element('div', 'expert-avatar');
      avatar.append(renderAvatar(expert.custom
        ? { seed: expert.id, base: expert.avatarColor, accessory: expert.avatarAccessory }
        : expert.id, { size: 48 }));
      const top = element('div', 'expert-card-top');
      top.append(avatar);
      if (expert.custom) top.append(element('span', 'custom-tag', 'Custom'));
      const actions = element('div', 'expert-actions');
      actions.append(button);
      if (expert.custom) actions.append(...this.customActions('expert', expert));
      card.append(top, element('div', 'expert-name', expert.name), element('div', 'expert-role', expert.role),
        element('p', 'expert-desc', expert.description || 'Custom expert'),
        element('span', 'badge', expert.category || 'Custom'), actions);
      return card;
    }));
  },

  // Edit and delete buttons for user-created catalog entries.
  customActions(kind, entry) {
    const edit = element('button', 'custom-edit', 'Edit');
    edit.dataset.customKind = kind;
    edit.dataset.customId = entry.id;
    edit.setAttribute('aria-label', `Edit ${entry.name}`);
    const remove = element('button', 'custom-delete', 'Delete');
    remove.dataset.customKind = kind;
    remove.dataset.customId = entry.id;
    remove.setAttribute('aria-label', `Delete ${entry.name}`);
    return [edit, remove];
  },

  // Re-renders everything that lists custom experts or skills.
  renderCustomCatalogs() {
    this.renderExperts();
    this.renderSkills();
    this.renderContextChips();
    this.renderSearch();
  },

  allExperts() { return [...EXPERTS, ...this.customExperts]; },
  allSkills() { return [...SKILLS, ...this.customSkills]; },

  renderSkills() {
    const skills = this.allSkills();
    const heading = $('#skills-title');
    if (heading) {
      const custom = this.customSkills.length;
      heading.textContent = `${skills.length} templates${custom ? ` · ${custom} custom` : ''}`;
    }
    this.renderCatalog('#skills-list', skills, this.skillStates, 'skill', 'installed', 'Install', 'Installed');
  },

  renderConnectors() {
    this.renderCatalog('#connectors-list', CONNECTORS, {}, 'connector', 'connected', 'Connect', 'Connected');
  },

  renderCatalog(selector, entries, states, kind, enabledState, offLabel, onLabel) {
    const list = $(selector);
    if (!list) return;
    list.replaceChildren(...entries.map((entry) => {
      const card = element('div', `${kind}-card`);
      const head = element('div', `${kind}-card-head`);
      const name = element('strong', `${kind}-name`, entry.name);
      if (entry.custom) name.append(element('span', 'custom-tag', 'Custom'));
      head.append(name, element('span', 'badge', entry.category));
      const foot = element('div', `${kind}-card-foot`);
      if (kind === 'skill') {
        const installed = states[entry.id] === enabledState;
        if (installed) {
          const run = element('button', 'skill-run', 'Run');
          run.dataset.skillRun = entry.id;
          run.title = 'Run this skill on the file open in the editor';
          foot.append(run);
        }
        const button = element('button', `${kind}-toggle`, installed ? onLabel : offLabel);
        button.dataset.id = entry.id;
        button.setAttribute('aria-pressed', String(installed));
        foot.append(button);
        if (entry.custom) foot.append(...this.customActions('skill', entry));
      } else {
        // Connector actions (connect, test, disconnect) are owned by the
        // credential store in catalog-ui.js, which decorates this slot.
        const actions = element('div', 'connector-actions');
        actions.dataset.connectorAction = entry.id;
        foot.append(actions);
      }
      card.append(head, element('p', `${kind}-desc`, entry.description || 'Custom prompt template'), foot);
      return card;
    }));
  },

  // Edit/Delete on custom cards; returns true when the click was handled.
  handleCustomAction(event) {
    const button = event.target.closest('.custom-edit, .custom-delete');
    if (!button) return false;
    const { customKind, customId } = button.dataset;
    if (button.classList.contains('custom-edit')) openCustomDialog(this, customKind, customId);
    else deleteCustom(this, customKind, customId);
    return true;
  },

  bindCatalogs() {
    $('#experts-grid')?.addEventListener('click', (event) => {
      if (this.handleCustomAction(event)) return;
      const button = event.target.closest('.expert-use');
      const expert = this.allExperts().find((entry) => entry.id === button?.dataset.expertId);
      if (!expert) return;
      const selecting = this.settings.expertId !== expert.id;
      this.settings.expertId = selecting ? expert.id : null;
      void this.persist('settings');
      this.renderExperts();
      this.renderContextChips();
      this.switchView('chat');
      if (selecting) {
        const input = $('#chat-input');
        if (input) input.value = EXPERT_STARTERS[expert.id] || 'What do you need from me? ';
        this.updateSendEnabled();
      }
      this.showToast(selecting ? `${expert.name} guides your next messages` : `${expert.name} cleared`);
      $('#chat-input')?.focus();
    });
    $('#skills-list')?.addEventListener('click', (event) => {
      if (this.handleCustomAction(event)) return;
      const run = event.target.closest('.skill-run');
      if (run) {
        const skill = this.allSkills().find((entry) => entry.id === run.dataset.skillRun);
        if (skill) void this.runSkill(skill);
        return;
      }
      const button = event.target.closest('.skill-toggle');
      const skill = this.allSkills().find((entry) => entry.id === button?.dataset.id);
      if (!skill) return;
      const turningOn = this.skillStates[skill.id] !== 'installed';
      this.skillStates[skill.id] = turningOn ? 'installed' : 'available';
      // The installed skill is the one applied to chat requests.
      this.settings.skillId = turningOn ? skill.id : (this.settings.skillId === skill.id ? null : this.settings.skillId);
      void this.persist('settings');
      void this.persist('skillStates');
      this.renderSkills();
      this.renderContextChips();
      this.showToast(`${skill.name}: ${turningOn ? 'applied to your chat requests' : 'removed from your chat requests'}`);
    });
  },

  // The active expert and skill show as removable chips in the composer.
  renderContextChips() {
    const host = $('#context-chips');
    if (!host) return;
    const chips = [];
    const expert = this.allExperts().find((item) => item.id === this.settings.expertId);
    if (expert) chips.push(this.makeContextChip('expert', expert.id, expert.name));
    const skill = this.allSkills().find((item) => item.id === this.settings.skillId);
    if (skill) chips.push(this.makeContextChip('skill', skill.id, skill.name));
    host.replaceChildren(...chips);
  },

  makeContextChip(kind, id, label) {
    const chip = element('button', 'context-chip');
    chip.dataset.contextKind = kind;
    chip.dataset.contextId = id;
    chip.title = `Stop applying this ${kind}`;
    chip.append(element('span', 'context-chip-label', label), element('span', 'context-chip-x', '×'));
    return chip;
  },

  // Runs a skill on real material: the file open in the editor, or one the
  // user picks. The skill template is already applied to every request.
  async runSkill(skill) {
    if (this.activeRequestId || this.demoBusy) return;
    this.switchView('chat');
    if (!this.attachment) await this.attachFile();
    if (!this.attachment) return;
    const input = $('#chat-input');
    if (input) input.value = `Run the ${skill.name} skill on the attached file.`;
    this.updateSendEnabled();
    await this.handleSend();
  },

  renderAutomations() {
    const list = $('#automation-list');
    if (!list) return;
    list.replaceChildren(...this.automations.map((automation) => {
      const row = element('div', 'automation-item');
      row.dataset.automationId = automation.id;
      const info = element('div', 'automation-info');
      info.style.minWidth = '0';
      info.style.flex = '1';
      const prompt = element('div', 'automation-prompt', automation.prompt);
      Object.assign(prompt.style, { fontSize: '12px', color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
      prompt.title = automation.prompt;
      info.append(element('strong', 'automation-name', automation.name), prompt);
      const next = automation.active && Number.isFinite(automation.nextRun)
        ? new Date(automation.nextRun).toLocaleString() : (automation.active ? 'not scheduled' : 'paused');
      const last = Number.isFinite(automation.lastRun) ? ` · Last: ${new Date(automation.lastRun).toLocaleString()}` : '';
      const status = element('div', 'status-text', `${automation.lastStatus || 'idle'}${last} · Next: ${next}`);
      status.style.fontSize = '11px';
      info.append(status);
      if (automation.lastStatus === 'error' || automation.lastStatus === 'interrupted') {
        if (automation.lastError) {
          const error = element('div', 'status-text automation-error', automation.lastError);
          Object.assign(error.style, { fontSize: '11px', color: '#dc2626' });
          error.setAttribute('role', 'alert');
          info.append(error);
        }
      }
      const history = Array.isArray(automation.history) ? automation.history : [];
      if (history.length) {
        const details = element('details', 'automation-history');
        details.style.fontSize = '11px';
        details.append(element('summary', '', `Run history (${history.length})`));
        const items = element('ol', 'automation-history-list');
        items.style.margin = '4px 0 0 16px';
        for (const entry of history) {
          const item = element('li', `automation-history-${entry.status}`,
            `${new Date(entry.time).toLocaleString()} · ${entry.status}${entry.preview ? ` — ${entry.preview}` : ''}`);
          items.append(item);
        }
        details.append(items);
        info.append(details);
      }
      const schedule = this.describeSchedule(automation);
      const dot = element('span', automation.active ? 'dot active' : 'dot');
      dot.style.backgroundColor = automation.active ? '#22c55e' : '#888';
      dot.setAttribute('aria-label', automation.active ? 'Active' : 'Paused');
      const runNow = element('button', 'automation-run-now', '▶ Run now');
      runNow.dataset.action = 'run-now';
      runNow.title = `Run ${automation.name} immediately`;
      runNow.setAttribute('aria-label', runNow.title);
      const toggle = element('button', 'automation-toggle', automation.active ? '⏸' : '▶');
      toggle.dataset.action = 'toggle';
      toggle.title = `${automation.active ? 'Pause' : 'Resume'} ${automation.name}`;
      toggle.setAttribute('aria-label', toggle.title);
      const edit = element('button', 'automation-edit', '✎');
      edit.dataset.action = 'edit';
      edit.title = `Edit ${automation.name}`;
      edit.setAttribute('aria-label', edit.title);
      const remove = element('button', 'automation-delete', '🗑');
      remove.dataset.action = 'delete';
      remove.title = `Delete ${automation.name}`;
      remove.setAttribute('aria-label', remove.title);
      row.append(info, element('span', 'badge', schedule), dot, runNow, toggle, edit, remove);
      return row;
    }));
  },

  describeSchedule(automation) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    switch (automation.schedule) {
      case 'once':
        return Number.isFinite(automation.runAt) ? `Once ${new Date(automation.runAt).toLocaleString()}` : `Once ${automation.time}`;
      case 'hourly': return `Hourly at :${String(automation.time || '00:00').slice(3)}`;
      case 'weekly': return `Weekly ${days[automation.dayOfWeek] || ''} ${automation.time}`;
      case 'monthly': return `Monthly day ${automation.dayOfMonth} ${automation.time}`;
      case 'interval': return `Every ${automation.intervalMinutes} min`;
      default: return `Daily ${automation.time}`;
    }
  },

  // Shows only the inputs the chosen schedule type uses.
  syncAutomationFields() {
    const schedule = $('#automation-schedule')?.value || 'daily';
    const show = {
      time: schedule !== 'interval',
      date: schedule === 'once',
      interval: schedule === 'interval',
      weekday: schedule === 'weekly',
      monthday: schedule === 'monthly',
    };
    $$('#automation-form [data-automation-field]').forEach((node) => {
      node.hidden = !show[node.dataset.automationField];
    });
    const hint = $('#automation-time-hint');
    if (hint) hint.textContent = schedule === 'hourly' ? '(minute past each hour)' : '';
  },

  bindAutomationForm() {
    $('#automation-schedule')?.addEventListener('change', () => this.syncAutomationFields());
    $('#automation-cancel-edit')?.addEventListener('click', () => this.resetAutomationForm());
    this.syncAutomationFields();
  },

  resetAutomationForm() {
    $('#automation-form')?.reset();
    if ($('#automation-time') && !$('#automation-time').value) $('#automation-time').value = '09:00';
    if ($('#automation-edit-id')) $('#automation-edit-id').value = '';
    if ($('#automation-submit')) $('#automation-submit').textContent = 'Consent & create schedule';
    if ($('#automation-cancel-edit')) $('#automation-cancel-edit').hidden = true;
    if ($('#automation-form-title')) $('#automation-form-title').textContent = 'New schedule';
    this.syncAutomationFields();
  },

  // Reads the form into schedule fields; returns an error string on bad input.
  readAutomationForm() {
    const name = $('#automation-name')?.value.trim();
    const prompt = $('#automation-prompt')?.value.trim();
    if (!name || !prompt) return { error: 'Enter an automation name and prompt' };
    const schedule = $('#automation-schedule')?.value || 'daily';
    if (!['once', 'hourly', 'daily', 'weekly', 'monthly', 'interval'].includes(schedule)) {
      return { error: 'Choose a valid schedule' };
    }
    const time = $('#automation-time')?.value || '09:00';
    if (schedule !== 'interval' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { error: 'Choose a valid time' };
    const fields = {
      name, prompt, schedule, time,
      dayOfWeek: Number.parseInt($('#automation-weekday')?.value ?? '1', 10),
      dayOfMonth: Number.parseInt($('#automation-monthday')?.value ?? '1', 10),
      intervalMinutes: null,
      runAt: null,
    };
    if (schedule === 'interval') {
      fields.intervalMinutes = Number.parseInt($('#automation-interval')?.value ?? '', 10);
      if (!Number.isInteger(fields.intervalMinutes) || fields.intervalMinutes < 1 || fields.intervalMinutes > 525600) {
        return { error: 'Interval must be 1 to 525600 minutes' };
      }
    }
    if (schedule === 'once') {
      const date = $('#automation-date')?.value;
      if (date) {
        const [y, m, d] = date.split('-').map(Number);
        const [hh, mm] = time.split(':').map(Number);
        // Local wall-clock time on the chosen date.
        fields.runAt = new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
        if (!(fields.runAt > Date.now())) return { error: 'Choose a date and time in the future' };
      }
    }
    return { fields };
  },

  async createAutomation(event) {
    event.preventDefault();
    const { fields, error } = this.readAutomationForm();
    if (error) { this.showToast(error); return; }
    const now = Date.now();
    const editId = $('#automation-edit-id')?.value || '';
    const existing = editId ? this.automations.find((item) => item.id === editId) : null;
    const automation = existing ? { ...existing, ...fields } : {
      id: `auto-${now}-${Math.random().toString(36).slice(2, 8)}`, ...fields,
      active: true, createdAt: now, schemaVersion: 2, nextRun: null, pendingCatchUp: false,
      lastRun: null, lastStatus: 'idle', lastError: '', history: [],
    };
    try {
      automation.nextRun = nextRunAt(automation, now);
    } catch (problem) {
      this.showToast(problem?.message || 'Choose a valid schedule and time');
      return;
    }
    if (existing) {
      // Mutate in place so an in-flight run keeps pointing at the same record.
      Object.assign(existing, automation, { active: true });
    } else {
      this.automations.push(automation);
    }
    const saved = this.persist('automations');
    this.renderAutomations();
    this.resetAutomationForm();
    await saved;
    this.showToast(existing ? 'Automation updated' : 'Automation created');
  },

  editAutomation(automation) {
    const set = (selector, value) => { if ($(selector)) $(selector).value = value; };
    set('#automation-name', automation.name);
    set('#automation-prompt', automation.prompt);
    set('#automation-schedule', automation.schedule);
    set('#automation-time', automation.time || '09:00');
    set('#automation-weekday', String(automation.dayOfWeek ?? 1));
    set('#automation-monthday', String(automation.dayOfMonth ?? 1));
    set('#automation-interval', String(automation.intervalMinutes ?? 60));
    if (Number.isFinite(automation.runAt)) {
      const date = new Date(automation.runAt);
      set('#automation-date', `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`);
    } else set('#automation-date', '');
    set('#automation-edit-id', automation.id);
    if ($('#automation-submit')) $('#automation-submit').textContent = 'Save changes';
    if ($('#automation-cancel-edit')) $('#automation-cancel-edit').hidden = false;
    if ($('#automation-form-title')) $('#automation-form-title').textContent = `Edit ${automation.name}`;
    this.syncAutomationFields();
    $('#automation-name')?.focus();
  },

  async changeAutomation(event) {
    const button = event.target.closest('button[data-action]');
    const row = button?.closest('.automation-item');
    const automation = this.automations.find((item) => item.id === row?.dataset.automationId);
    if (!automation) return;
    const action = button.dataset.action;
    if (action === 'delete') {
      if (!window.confirm(`Delete the automation "${automation.name}"?`)) return;
      this.automations = this.automations.filter((item) => item.id !== automation.id);
      if ($('#automation-edit-id')?.value === automation.id) this.resetAutomationForm();
      this.showToast('Automation deleted');
    } else if (action === 'toggle') {
      automation.active = !automation.active;
      if (automation.active) {
        // Recompute the next occurrence: a resumed schedule must never fire
        // for a timestamp that already passed while it was paused.
        try {
          automation.nextRun = nextRunAt(automation, Date.now());
          automation.lastError = '';
        } catch (error) {
          automation.active = false;
          automation.lastError = error?.message || 'No future occurrence is representable as a Date.';
        }
      }
      automation.pendingCatchUp = false;
      this.showToast(automation.active ? 'Automation resumed' : (automation.lastError || 'Automation paused'));
    } else if (action === 'edit') {
      this.editAutomation(automation);
      return;
    } else if (action === 'run-now') {
      const scheduler = window.scalemaxScheduler;
      if (!scheduler?.runNow) { this.showToast('Scheduler not ready'); return; }
      button.disabled = true;
      this.showToast(`Running ${automation.name}…`);
      try {
        const outcome = await scheduler.runNow(automation.id);
        if (outcome === 'skipped') this.showToast(`${automation.name} is already running`);
      } finally {
        this.renderAutomations();
      }
      return;
    } else return;
    void this.persist('automations');
    this.renderAutomations();
  },

  bindAssistant() {
    // Assistant settings auto-save shortly after edits; the Save button stays
    // as explicit confirmation but is no longer the only path to persistence.
    let persistTimer;
    const persistSoon = () => {
      window.clearTimeout(persistTimer);
      persistTimer = window.setTimeout(() => void this.persist('settings'), 500);
    };
    $('#system-prompt')?.addEventListener('input', (event) => {
      this.settings.systemPrompt = event.target.value;
      persistSoon();
      this.updateActiveSettingsIndicator();
    });
    $('#temperature')?.addEventListener('input', (event) => {
      // Range inputs yield strings; store a number so the provider accepts it.
      const value = toTemperature(event.target.value);
      if (value !== undefined) this.settings.temperature = value;
      // Moving the slider means the user wants that value sent.
      if (!this.settings.temperatureEnabled) {
        this.settings.temperatureEnabled = true;
        if ($('#temperature-enabled')) $('#temperature-enabled').checked = true;
      }
      this.renderTemperatureValue();
      persistSoon();
      this.updateActiveSettingsIndicator();
    });
    $('#temperature-enabled')?.addEventListener('change', (event) => {
      this.settings.temperatureEnabled = Boolean(event.target.checked);
      this.renderTemperatureValue();
      persistSoon();
      this.updateActiveSettingsIndicator();
    });
    // Same path as the composer menu, so Bypass all always asks for consent.
    $('#permission-select')?.addEventListener('change', (event) => {
      void setPermission(this, event.target.value);
    });
    // The save button is type="submit"; the form submit event covers both.
    $('#assistant-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.saveAssistant();
    });
  },

  async saveAssistant() {
    if ($('#system-prompt')) this.settings.systemPrompt = $('#system-prompt').value;
    const value = toTemperature($('#temperature')?.value);
    if (value !== undefined) this.settings.temperature = value;
    if ($('#temperature-enabled')) this.settings.temperatureEnabled = Boolean($('#temperature-enabled').checked);
    // The permission is saved when it changes (setPermission), never read back from the form.
    await this.persist('settings');
    this.applySettingsToUI();
    this.updateActiveSettingsIndicator();
    const saved = $('#assistant-saved');
    if (saved) {
      saved.textContent = `Saved ✓ ${clock(Date.now())}`;
      window.clearTimeout(this.assistantSavedTimer);
      this.assistantSavedTimer = window.setTimeout(() => { saved.textContent = ''; }, 4000);
    }
    this.showToast('Settings saved');
  },

  // The output shows what is actually sent: a number, or the provider default.
  renderTemperatureValue() {
    const output = $('#temperature-value');
    if (!output) return;
    output.textContent = this.settings.temperatureEnabled
      ? String(this.settings.temperature) : 'Default (provider)';
  },

  updateActiveSettingsIndicator() {
    const indicator = $('#active-settings-indicator');
    if (!indicator) return;
    const parts = [];
    if (String(this.settings.systemPrompt || '').trim()) parts.push('custom prompt');
    const temperature = requestTemperature(this.settings);
    if (temperature !== undefined) parts.push(`temp ${temperature}`);
    if (parts.length) {
      indicator.textContent = `Active: ${parts.join(' · ')}`;
      indicator.hidden = false;
    } else {
      indicator.hidden = true;
    }
  },

  toggleSearch(open) {
    const dialog = $('#search-dialog');
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
      this.renderSearch();
      $('#search-input')?.focus();
    } else if (dialog.open) {
      dialog.close();
    }
  },

  renderSearch() {
    const list = $('#search-results');
    if (!list) return;
    const query = ($('#search-input')?.value || '').trim();
    const results = searchItems(query, this.tasks, { experts: this.customExperts, skills: this.customSkills });
    list.replaceChildren(...results.map((result) => {
      const row = element('button', 'search-result');
      if (result.kind === 'task') row.dataset.taskId = result.id;
      else {
        row.dataset.resourceKind = result.kind;
        row.dataset.resourceId = result.id;
      }
      const text = element('span', 'search-result-text');
      text.append(element('span', 'task-title', result.title));
      if (result.description) text.append(element('span', 'search-result-desc', result.description));
      row.append(text, element('span', 'badge', result.kind));
      return row;
    }));
  },

  showToast(message) {
    const toast = $('#toast');
    if (!toast) return;
    window.clearTimeout(this.toastTimer);
    toast.textContent = message;
    // Native dialogs paint in the top layer above every z-index; host the
    // toast inside any open dialog so modal flows still get feedback.
    const host = document.querySelector('dialog[open]');
    if (host && toast.parentElement !== host) host.append(toast);
    if (!host && toast.parentElement !== document.body) document.body.append(toast);
    toast.classList.add('show');
    this.toastTimer = window.setTimeout(() => {
      toast.classList.remove('show');
      if (toast.parentElement !== document.body) document.body.append(toast);
    }, 2200);
  },

  // Surfaces unexpected renderer failures in the alert banner at the top of the
  // view. Auto-clears so a single transient error is not permanent.
  showGlobalError(message) {
    const node = $('#global-error');
    if (!node) return;
    node.textContent = `Something went wrong: ${message}`;
    node.hidden = false;
    node.onclick = () => { node.hidden = true; };
    window.clearTimeout(this.errorTimer);
    this.errorTimer = window.setTimeout(() => { node.hidden = true; }, 8000);
  },

  renderAll() {
    this.renderTasks();
    this.renderChat();
    this.renderExperts();
    this.renderSkills();
    this.renderContextChips();
    this.renderConnectors();
    this.renderAutomations();
    this.applySettingsToUI();
    this.updateActiveSettingsIndicator();
    this.renderProviderStatus();
    this.renderModelSelect();
    this.renderFileTree();
    this.renderFolder();
    this.setAttachment(this.attachment);
    this.updateSendEnabled();
  },
};

document.addEventListener('DOMContentLoaded', () => app.init(), { once: true });
export default app;
