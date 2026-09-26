/** ScaleMax IDE: local conversations, settings, and demo interactions. */
import { EXPERTS, SKILLS, CONNECTORS } from './data.js';
import { nextRunAt, normalizeAutomations, buildSystemPrompt, searchItems } from './domain.mjs';
import { bindTerminal } from './terminal.js';
import { bindCatalogUi, openResourceDetail } from './catalog-ui.js';
import { startScheduler } from './scheduler.js';

const DEFAULTS = {
  permission: 'ask', mode: 'working', systemPrompt: '', temperature: 0.7,
  temperatureEnabled: false, expertId: null, skillId: null,
};
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

const app = {
  tasks: [],
  currentTaskId: null,
  settings: { ...DEFAULTS },
  automations: [],
  skillStates: {},
  provider: null,
  providerKind: 'scalemax',
  providerBase: '',
  providerCatalog: [],
  enabledModels: new Set(),
  selectedModel: '',
  attachment: null,
  workspace: { root: '', files: [], openPath: '', revision: '', dirty: false },
  activeRequestId: null,
  eventsBound: false,

  toastTimer: null,
  saveQueue: Promise.resolve(),

  async init() {
    window.addEventListener('error', (event) => this.showGlobalError(event.message || 'Unexpected error'));
    window.addEventListener('unhandledrejection', (event) =>
      this.showGlobalError(event.reason?.message || 'Unexpected error'));
    await this.loadState();
    await this.loadProvider();
    this.bindEvents();
    this.renderAll();
    bindTerminal(this);
    bindCatalogUi(this);
    startScheduler(this);
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
    const keys = ['tasks', 'settings', 'automations', 'skillStates'];
    const [tasks, settings, automations, skills] = await Promise.all(
      keys.map((key) => this.readState(key)),
    );
    const now = Date.now();
    this.tasks = Array.isArray(tasks) ? tasks.filter((task) =>
      isRecord(task) && typeof task.id === 'string' && typeof task.title === 'string',
    ).map((task) => ({
      id: task.id, title: task.title,
      messages: Array.isArray(task.messages) ? task.messages.filter((message) =>
        isRecord(message) && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string',
      ).map((message) => ({
        role: message.role, text: message.text,
        time: Number.isFinite(message.time) ? message.time : now,
      })) : [],
      createdAt: Number.isFinite(task.createdAt) ? task.createdAt : now,
      updatedAt: Number.isFinite(task.updatedAt) ? task.updatedAt : now,
    })) : [];
    this.settings = { ...DEFAULTS, ...(isRecord(settings) ? settings : {}) };
    // Automations are normalised before use: legacy records stay paused and
    // every active schedule gets a future next run.
    this.automations = normalizeAutomations(Array.isArray(automations) ? automations : []);
    this.skillStates = isRecord(skills) ? skills : {};
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
      const enabled = Array.isArray(meta.enabledModels) ? meta.enabledModels.length : 0;
      $('#provider-status').textContent = configured
        ? `Connected via ${kindLabel} — ${model} at ${baseUrl}${enabled ? ` · ${enabled} model${enabled === 1 ? '' : 's'} enabled` : ''}.`
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
    // The local-first shell reuses the sidebar identity slot for provider state.
    if ($('#user-name')) $('#user-name').textContent = 'Local workspace';
    if ($('#user-email')) $('#user-email').textContent = configured ? model : 'Provider not configured';
    // The statusbar mirrors provider state at a glance.
    if ($('#statusbar-provider')) {
      $('#statusbar-provider').textContent = configured
        ? `${kindLabel} · ${baseUrl || 'endpoint not set'}`
        : 'Provider not configured';
    }
    this.renderModelPill();
  },

  // The active model is shown in the middle of the composer.
  renderModelPill() {
    const pill = $('#model-pill');
    const model = this.provider?.model || '';
    if ($('#statusbar-model')) $('#statusbar-model').textContent = model || 'No model';
    if (!pill) return;
    const configured = Boolean(this.provider?.configured);
    pill.textContent = model || (configured ? 'No model selected' : 'No provider connected');
    pill.title = model ? `Using ${model}` : 'No model selected';
    pill.classList.toggle('empty', !model);
  },

  renderProviderModels() {
    const list = $('#provider-models');
    const section = $('#provider-models-section');
    if (!list || !section) return;
    const catalog = this.providerCatalog || [];
    section.hidden = catalog.length === 0;
    if ($('#provider-models-count')) {
      const enabled = this.enabledModels?.size || 0;
      $('#provider-models-count').textContent = catalog.length ? `${enabled} of ${catalog.length} enabled` : '';
    }
    list.replaceChildren(...catalog.map((model) => {
      const row = element('div', 'model-row');
      const info = element('div', 'model-info');
      info.append(
        element('strong', 'model-name', model.displayName || model.id),
        element('span', 'model-id', model.id),
      );
      const enabled = Boolean(this.enabledModels?.has(model.id));
      const toggle = element('button', 'model-toggle', enabled ? 'Enabled' : 'Disabled');
      toggle.dataset.modelId = model.id;
      toggle.setAttribute('aria-pressed', String(enabled));
      if (model.available === false) {
        toggle.disabled = true;
        toggle.title = 'This model is currently unavailable.';
      }
      row.append(
        info,
        element('span', 'badge', model.available === false ? 'Unavailable' : 'Available'),
        toggle,
      );
      return row;
    }));
    this.renderModelSelect();
  },

  modelOptions() {
    const catalog = this.providerCatalog || [];
    const enabled = catalog.filter((model) => this.enabledModels?.has(model.id));
    return enabled.length ? enabled : catalog.filter((model) => model.available !== false);
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
      : (options.length ? 'Choose a model' : 'No models enabled');
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

  toggleModel(id) {
    if (!id) return;
    if (!this.enabledModels) this.enabledModels = new Set();
    if (this.enabledModels.has(id)) this.enabledModels.delete(id);
    else this.enabledModels.add(id);
    this.renderProviderModels();
  },

  async saveProvider() {
    const bridge = this.getProviderBridge();
    if (!bridge?.save) { this.showToast('Provider connections require the desktop app'); return; }
    const kind = this.providerKindValue();
    const input = {
      kind,
      model: kind === 'custom' ? ($('#provider-model')?.value.trim() || '') : (this.selectedModel || ''),
      enabledModels: [...(this.enabledModels || [])],
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
      const known = new Set(this.providerCatalog.map((model) => model.id));
      // Keep prior selections; otherwise enable the first available model.
      this.enabledModels = new Set([...(this.enabledModels || [])].filter((id) => known.has(id)));
      if (!this.enabledModels.size) {
        const first = this.providerCatalog.find((model) => model.available !== false);
        if (first) this.enabledModels.add(first.id);
      }
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
    $('#provider-models')?.addEventListener('click', (event) => {
      const button = event.target.closest('.model-toggle[data-model-id]');
      if (button && !button.disabled) this.toggleModel(button.dataset.modelId);
    });
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
    if (open && this.workspace.root) {
      const result = await this.workspaceBridge()?.read(open);
      if (result?.ok) {
        this.setAttachment({ path: open, name: open.split('/').pop(), content: result.data.content });
        return;
      }
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
    if (!picked.data?.path) return;
    const result = await this.workspaceBridge()?.select(picked.data.path);
    if (!result?.ok) { this.showToast(result?.error?.message || 'Could not open that folder'); return; }
    this.applyWorkspace(result.data);
    this.showToast('Folder opened');
  },

  async refreshWorkspace() {
    const bridge = this.workspaceBridge();
    if (!bridge || !this.workspace.root) return;
    const result = await bridge.list();
    if (result?.ok) {
      // Keep the open file; drop cached folder contents so the tree reloads.
      this.workspace.tree = {};
      if (this.workspace.expanded) this.workspace.expanded.clear();
      this.applyWorkspace(result.data);
    }
  },

  applyWorkspace(data) {
    const rootChanged = this.workspace.root !== (data?.root || '');
    this.workspace.root = data?.root || '';
    this.workspace.files = Array.isArray(data?.files) ? data.files : [];
    if (rootChanged) {
      // The open file belongs to the previous project; drop it before the
      // editor can save stale content into the new root.
      this.workspace.openPath = '';
      this.workspace.revision = '';
      this.workspace.dirty = false;
      this.workspace.tree = {};
      this.workspace.expanded = new Set();
      if ($('#editor-input')) $('#editor-input').value = '';
      if ($('#editor-title')) $('#editor-title').textContent = 'Editor';
      if ($('#editor-path')) $('#editor-path').textContent = 'No file selected';
      if ($('#editor-status')) $('#editor-status').textContent = 'Choose a file before editing or saving.';
      this.updateEditorGutter();
    }
    if ($('#workspace-path')) $('#workspace-path').textContent = this.workspace.root || 'No folder selected';
    if ($('#workspace-status')) {
      const count = this.workspace.files.length;
      $('#workspace-status').textContent = this.workspace.root
        ? `${count} entr${count === 1 ? 'y' : 'ies'}${count >= 1000 ? ' (list truncated)' : ''}`
        : 'Open a local folder to begin.';
    }
    this.renderFileTree();
  },

  renderFileTree() {
    const tree = $('#file-tree');
    if (!tree) return;
    const files = this.workspace.files || [];
    if (!files.length) {
      tree.replaceChildren(element('p', 'empty-state',
        this.workspace.root ? 'This folder is empty.' : 'No folder selected.'));
      return;
    }
    const rows = [];
    const walk = (entries, depth) => {
      for (const entry of entries) {
        const isDirectory = entry.type === 'directory';
        rows.push(this.makeTreeRow(entry, isDirectory, depth));
        if (isDirectory && this.workspace.expanded?.has(entry.path)) {
          const children = this.workspace.tree?.[entry.path];
          if (Array.isArray(children) && children.length) walk(children, depth + 1);
          else rows.push(element('p', 'empty-state nested-empty', 'Empty folder'));
        }
      }
    };
    walk(files, 0);
    tree.replaceChildren(...rows);
  },

  makeTreeRow(entry, isDirectory, depth) {
    const row = element('button', isDirectory ? 'file-tree-item directory-entry' : 'file-tree-item file-entry');
    row.dataset.filePath = entry.path;
    row.dataset.fileKind = isDirectory ? 'directory' : 'file';
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.append(
      element('span', isDirectory ? 'file-icon is-directory' : 'file-icon is-file'),
      element('span', 'file-name', entry.name),
    );
    if (entry.path === this.workspace.openPath) row.classList.add('active');
    return row;
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
    const input = $('#editor-input');
    const gutter = $('#editor-gutter');
    if (!input || !gutter) return;
    const lines = input.value.split('\n').length;
    const numbers = [];
    for (let line = 1; line <= lines; line += 1) numbers.push(line);
    gutter.textContent = numbers.join('\n');
    gutter.scrollTop = input.scrollTop;
  },

  async openFile(path) {
    const bridge = this.workspaceBridge();
    if (!bridge || !path) return;
    if (this.workspace.dirty
      && !window.confirm(`Discard unsaved changes to ${this.workspace.openPath || 'the current file'}?`)) return;
    const result = await bridge.read(path);
    if (!result?.ok) { this.showToast(result?.error?.message || 'Could not open that file'); return; }
    this.workspace.openPath = result.data.path;
    this.workspace.revision = result.data.revision;
    this.workspace.dirty = false;
    if ($('#editor-input')) $('#editor-input').value = result.data.content;
    if ($('#editor-path')) $('#editor-path').textContent = result.data.path;
    if ($('#editor-title')) $('#editor-title').textContent = result.data.path.split('/').pop();
    if ($('#editor-status')) $('#editor-status').textContent = 'Loaded.';
    this.updateEditorGutter();
    for (const row of $$('#file-tree .file-tree-item')) {
      row.classList.toggle('active', row.dataset.filePath === path);
    }
  },

  async saveFile() {
    const bridge = this.workspaceBridge();
    if (!bridge || !this.workspace.openPath) { this.showToast('Open a file first'); return; }
    const content = $('#editor-input')?.value ?? '';
    const result = await bridge.write({ path: this.workspace.openPath, content, revision: this.workspace.revision });
    if (!result?.ok) { this.showToast(result?.error?.message || 'Could not save that file'); return; }
    this.workspace.revision = result.data.revision;
    this.workspace.dirty = false;
    if ($('#editor-status')) $('#editor-status').textContent = 'Saved.';
    this.showToast('File saved');
  },

  async refreshGit() {
    const bridge = this.workspaceBridge();
    if (!bridge || !this.workspace.root) { this.showToast('Open a folder first'); return; }
    const status = await bridge.gitStatus();
    if (!status?.ok) {
      if ($('#git-status')) $('#git-status').textContent = status?.error?.message || 'Git is unavailable.';
      return;
    }
    const data = status.data || {};
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
    await this.showGitDiff('');
  },

  async showGitDiff(path) {
    const bridge = this.workspaceBridge();
    if (!bridge) return;
    const node = $('#git-diff');
    if (!node) return;
    const diff = await bridge.gitDiff(path || '');
    if (!diff?.ok) { node.replaceChildren(); return; }
    const text = diff.data.diff || '';
    if (!text) {
      node.replaceChildren(element('span', 'diff-line', 'No changes to show.'));
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
    $('#file-tree')?.addEventListener('click', (event) => {
      const row = event.target.closest('[data-file-path]');
      if (!row) return;
      if (row.dataset.fileKind === 'directory') void this.toggleFolder(row.dataset.filePath);
      else void this.openFile(row.dataset.filePath);
    });
    $('#editor-save')?.addEventListener('click', (event) => {
      event.preventDefault();
      void this.saveFile();
    });
    $('#editor-input')?.addEventListener('input', () => {
      this.workspace.dirty = true;
      if ($('#editor-status')) $('#editor-status').textContent = 'Unsaved changes.';
      this.updateEditorGutter();
    });
    $('#editor-input')?.addEventListener('scroll', () => {
      const gutter = $('#editor-gutter');
      if (gutter) gutter.scrollTop = $('#editor-input').scrollTop;
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
    if (!this.tasks.some((task) => task.id === id)) return;
    this.currentTaskId = id;
    this.switchView('chat');
    this.renderTasks();
    this.renderChat();
  },

  renderTasks() {
    const list = $('#tasks-list');
    const count = $('#task-count');
    if (count) count.textContent = String(this.tasks.length);
    if (list) list.replaceChildren(...this.tasks.map((task) => {
      const row = element('button', 'task-item');
      row.dataset.taskId = task.id;
      row.classList.toggle('active', task.id === this.currentTaskId);
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
      bubble.append(element('span', 'msg-text', message.text), element('span', 'msg-time', clock(message.time)));
      return bubble;
    }));
    container.scrollTop = container.scrollHeight;
    // The welcome hero and starter controls are a first-run surface: once the
    // task has messages the view becomes a plain transcript.
    $('.sm-home-page')?.classList.toggle('has-transcript', messages.length > 0);
  },

  updateTask(task, time = Date.now()) {
    task.updatedAt = time;
    void this.persist('tasks');
    this.renderTasks();
  },

  appendMessage(role, text, taskId = this.currentTaskId) {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) { this.showToast('That task no longer exists'); return; }
    if (role === 'user' && !task.messages.some((message) => message.role === 'user')) {
      task.title = text.length > 40 ? `${text.slice(0, 40)}…` : text;
    }
    const message = { role, text, time: Date.now() };
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
    const payload = { requestId, messages, systemPrompt: buildSystemPrompt(this.settings) };
    if (this.settings.temperatureEnabled) payload.temperature = Number(this.settings.temperature);

    this.setChatBusy(true, requestId);
    try {
      const result = await bridge.send(payload);
      if (!result?.ok) {
        const message = result?.error?.message || 'Provider request failed';
        if (result?.error?.code === 'CANCELLED') this.showToast('Response cancelled');
        else this.showToast(message);
        return;
      }
      this.appendMessage('assistant', result.data.text, taskId);
    } catch (error) {
      this.showToast(error?.message || 'Provider request failed');
    } finally {
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
    if ($('#temperature-value')) $('#temperature-value').textContent = String(this.settings.temperature);
    if ($('#temperature-enabled')) $('#temperature-enabled').checked = Boolean(this.settings.temperatureEnabled);
    if ($('#permission-select')) $('#permission-select').value = this.settings.permission;
  },

  renderExperts() {
    const grid = $('#experts-grid');
    if (!grid) return;
    grid.replaceChildren(...EXPERTS.map((expert) => {
      const card = element('div', 'expert-card');
      if (expert.id === this.settings.expertId) card.classList.add('selected');
      const button = element('button', 'expert-use', expert.id === this.settings.expertId ? 'Selected' : 'Use');
      button.dataset.expertId = expert.id;
      button.setAttribute('aria-pressed', String(expert.id === this.settings.expertId));
      card.append(element('div', 'expert-avatar', expert.initials || ''), element('div', 'expert-name', expert.name),
        element('div', 'expert-role', expert.role), element('p', 'expert-desc', expert.description), button);
      return card;
    }));
  },

  renderSkills() {
    this.renderCatalog('#skills-list', SKILLS, this.skillStates, 'skill', 'installed', 'Install', 'Installed');
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
      head.append(element('strong', `${kind}-name`, entry.name), element('span', 'badge', entry.category));
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
      } else {
        // Connector actions (connect, test, disconnect) are owned by the
        // credential store in catalog-ui.js, which decorates this slot.
        const actions = element('div', 'connector-actions');
        actions.dataset.connectorAction = entry.id;
        foot.append(actions);
      }
      card.append(head, element('p', `${kind}-desc`, entry.description), foot);
      return card;
    }));
  },

  bindCatalogs() {
    $('#experts-grid')?.addEventListener('click', (event) => {
      const button = event.target.closest('.expert-use');
      const expert = EXPERTS.find((entry) => entry.id === button?.dataset.expertId);
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
      const run = event.target.closest('.skill-run');
      if (run) {
        const skill = SKILLS.find((entry) => entry.id === run.dataset.skillRun);
        if (skill) void this.runSkill(skill);
        return;
      }
      const button = event.target.closest('.skill-toggle');
      const skill = SKILLS.find((entry) => entry.id === button?.dataset.id);
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
    const expert = EXPERTS.find((item) => item.id === this.settings.expertId);
    if (expert) chips.push(this.makeContextChip('expert', expert.id, expert.name));
    const skill = SKILLS.find((item) => item.id === this.settings.skillId);
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
      const next = Number.isFinite(automation.nextRun)
        ? new Date(automation.nextRun).toLocaleString() : 'not scheduled';
      const status = element('div', 'status-text', `${automation.lastStatus || 'idle'} · Next: ${next}`);
      status.style.fontSize = '11px';
      info.append(status);
      const schedule = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }[automation.schedule] || 'Daily';
      const dot = element('span', automation.active ? 'dot active' : 'dot');
      dot.style.backgroundColor = automation.active ? '#22c55e' : '#888';
      dot.setAttribute('aria-label', automation.active ? 'Active' : 'Paused');
      const toggle = element('button', 'automation-toggle', automation.active ? '⏸' : '▶');
      toggle.dataset.action = 'toggle';
      toggle.title = `${automation.active ? 'Pause' : 'Resume'} ${automation.name}`;
      toggle.setAttribute('aria-label', toggle.title);
      const remove = element('button', 'automation-delete', '🗑');
      remove.dataset.action = 'delete';
      remove.title = `Delete ${automation.name}`;
      remove.setAttribute('aria-label', remove.title);
      row.append(info, element('span', 'badge', `${schedule} ${automation.time}`), dot, toggle, remove);
      return row;
    }));
  },

  async createAutomation(event) {
    event.preventDefault();
    const name = $('#automation-name')?.value.trim();
    const prompt = $('#automation-prompt')?.value.trim();
    if (!name || !prompt) { this.showToast('Enter an automation name and prompt'); return; }
    const schedule = $('#automation-schedule')?.value || 'daily';
    const time = $('#automation-time')?.value || '09:00';
    if (!['daily', 'weekly', 'monthly'].includes(schedule) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      this.showToast('Choose a valid schedule and time');
      return;
    }
    const dayOfWeek = Number($('#automation-weekday')?.value ?? 1);
    const dayOfMonth = Number($('#automation-monthday')?.value ?? 1);
    const now = Date.now();
    const automation = {
      id: `auto-${now}-${Math.random().toString(36).slice(2, 8)}`, name, prompt, schedule, time, dayOfWeek, dayOfMonth,
      active: true, createdAt: now, schemaVersion: 2, nextRun: null,
      lastRun: null, lastStatus: 'idle', lastError: '',
    };
    try {
      automation.nextRun = nextRunAt(automation, now);
    } catch (error) {
      this.showToast(error?.message || 'Choose a valid schedule and time');
      return;
    }
    this.automations.push(automation);
    const saved = this.persist('automations');
    this.renderAutomations();
    $('#automation-form')?.reset();
    if ($('#automation-time') && !$('#automation-time').value) $('#automation-time').value = '09:00';
    await saved;
    this.showToast('Automation created');
  },

  changeAutomation(event) {
    const button = event.target.closest('button[data-action]');
    const row = button?.closest('.automation-item');
    const automation = this.automations.find((item) => item.id === row?.dataset.automationId);
    if (!automation) return;
    if (button.dataset.action === 'delete') {
      this.automations = this.automations.filter((item) => item.id !== automation.id);
      this.showToast('Automation deleted');
    } else if (button.dataset.action === 'toggle') {
      automation.active = !automation.active;
      if (automation.active) {
        // Recompute the next occurrence: a resumed schedule must never fire
        // for a timestamp that already passed while it was paused.
        try {
          automation.nextRun = nextRunAt(automation, Date.now());
        } catch (error) {
          automation.active = false;
          automation.lastError = error?.message || 'No future occurrence is representable as a Date.';
        }
      }
      this.showToast(automation.active ? 'Automation resumed' : 'Automation paused');
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
    });
    $('#temperature')?.addEventListener('input', (event) => {
      this.settings.temperature = Number(event.target.value);
      if ($('#temperature-value')) $('#temperature-value').textContent = event.target.value;
      persistSoon();
    });
    $('#temperature-enabled')?.addEventListener('change', (event) => {
      this.settings.temperatureEnabled = Boolean(event.target.checked);
      persistSoon();
    });
    $('#permission-select')?.addEventListener('change', (event) => {
      this.settings.permission = event.target.value;
      persistSoon();
    });
    // The save button is type="submit"; the form submit event covers both.
    $('#assistant-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.saveAssistant();
    });
  },

  async saveAssistant() {
    if ($('#system-prompt')) this.settings.systemPrompt = $('#system-prompt').value;
    if ($('#temperature')) this.settings.temperature = Number($('#temperature').value);
    if ($('#temperature-enabled')) this.settings.temperatureEnabled = Boolean($('#temperature-enabled').checked);
    await this.persist('settings');
    this.applySettingsToUI();
    this.showToast('Settings saved');
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
    const results = searchItems(query, this.tasks);
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
    this.renderProviderStatus();
    this.renderModelSelect();
    this.renderFileTree();
    this.setAttachment(this.attachment);
    this.updateSendEnabled();
  },
};

document.addEventListener('DOMContentLoaded', () => app.init(), { once: true });
export default app;
