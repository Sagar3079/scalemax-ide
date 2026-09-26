import { EXPERTS, SKILLS, COMMUNITY_SKILLS, CONNECTORS } from './data.js';

const CATALOGS = [
  { selector: '#experts-grid', trigger: '.expert-use', idKey: 'expertId', entries: EXPERTS },
  { selector: '#skills-list', trigger: '.skill-toggle', idKey: 'id', entries: SKILLS },
  { selector: '#connectors-list', trigger: '.connector-toggle', idKey: 'id', entries: CONNECTORS },
  { selector: '#community-list', trigger: '[data-detail-id]', idKey: 'detailId', entries: COMMUNITY_SKILLS },
];
const THEMES = ['light', 'dark', 'system'];
const boundApps = new WeakSet();

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tag === 'button') node.type = 'button';
  return node;
}

function option(value, label) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

function preferredDark() {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme(theme) {
  const choice = THEMES.includes(theme) ? theme : 'light';
  const resolved = choice === 'system' ? (preferredDark() ? 'dark' : 'light') : choice;
  document.documentElement.dataset.theme = resolved;
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function populateCategories() {
  const select = document.getElementById('catalog-category');
  if (!select) return;
  const previous = select.value;
  const categories = [...new Set(
    [...EXPERTS, ...SKILLS, ...CONNECTORS].map((entry) => entry.category).filter(Boolean),
  )].sort((a, b) => a.localeCompare(b));
  select.replaceChildren(option('all', 'All'), ...categories.map((category) => option(category, category)));
  select.value = categories.includes(previous) ? previous : 'all';
}

function bindFilter() {
  const search = document.getElementById('catalog-search');
  const category = document.getElementById('catalog-category');
  const count = document.getElementById('catalog-count');

  const apply = () => {
    const query = (search?.value || '').trim().toLowerCase();
    const chosen = category?.value || 'all';
    const active = Boolean(query) || chosen !== 'all';
    let visibleCount = 0;
    for (const catalog of CATALOGS) {
      const list = document.querySelector(catalog.selector);
      if (!list) continue;
      for (const node of list.children) {
        // Community cards stamp data-detail-id on the card itself, so a row can be its own trigger.
        const trigger = node.matches(catalog.trigger) ? node : node.querySelector(catalog.trigger);
        const entry = catalog.entries.find((item) => item.id === trigger?.dataset[catalog.idKey]);
        const text = entry ? `${entry.name} ${entry.description}`.toLowerCase() : node.textContent.toLowerCase();
        const entryCategory = entry?.category || node.querySelector('.badge')?.textContent || '';
        const visible = (!query || text.includes(query)) && (chosen === 'all' || entryCategory === chosen);
        node.style.display = visible ? '' : 'none';
        if (visible) visibleCount += 1;
      }
    }
    if (count) count.textContent = active ? `${visibleCount} results` : '';
  };

  search?.addEventListener('input', apply);
  category?.addEventListener('change', apply);
  // app.js re-renders the catalogs with replaceChildren, so re-apply after each swap.
  for (const catalog of CATALOGS) {
    const list = document.querySelector(catalog.selector);
    if (list) new MutationObserver(apply).observe(list, { childList: true });
  }
  apply();
}

function renderCommunity(app) {
  const list = document.getElementById('community-list');
  if (!list) return;
  list.replaceChildren(...COMMUNITY_SKILLS.map((entry) => {
    const card = element('div', 'expert-card');
    card.dataset.detailId = entry.id;
    card.append(
      element('div', 'expert-name', entry.name),
      element('p', 'expert-desc', entry.description),
      element('span', 'badge', entry.category),
    );
    // Reference repos publish the link as sourceUrl; accept url as well.
    const url = entry.url || entry.sourceUrl || '';
    const copy = element('button', 'button secondary', 'Copy link');
    copy.style.alignSelf = 'flex-start';
    if (url) {
      copy.addEventListener('click', () => {
        if (!navigator.clipboard?.writeText) { app.showToast('Clipboard is unavailable'); return; }
        navigator.clipboard.writeText(url)
          .then(() => app.showToast('Link copied'))
          .catch(() => app.showToast('Could not copy link'));
      });
    } else {
      copy.hidden = true;
      copy.style.display = 'none';
    }
    card.append(copy);
    return card;
  }));
}

function bindTheme(app) {
  const select = document.getElementById('theme-select');
  const darkQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const stored = THEMES.includes(app.settings?.theme) ? app.settings.theme : 'light';
  applyTheme(stored);
  if (select) {
    select.value = stored;
    select.addEventListener('change', () => {
      const choice = THEMES.includes(select.value) ? select.value : 'light';
      select.value = choice;
      app.settings.theme = choice;
      applyTheme(choice);
      void app.persist('settings');
    });
  }
  darkQuery?.addEventListener?.('change', () => {
    if (app.settings?.theme === 'system') applyTheme('system');
  });
}

function bindTaskActions(app) {
  document.getElementById('export-task-btn')?.addEventListener('click', () => {
    const task = app.tasks.find((item) => item.id === app.currentTaskId);
    if (!task) { app.showToast('No task selected'); return; }
    downloadJson(`scalemax-task-${task.id}.json`, task);
    app.showToast('Task exported');
  });
  document.getElementById('delete-task-btn')?.addEventListener('click', () => {
    const task = app.tasks.find((item) => item.id === app.currentTaskId);
    if (!task) { app.showToast('No task selected'); return; }
    if (!window.confirm('Delete this task?')) return;
    app.tasks = app.tasks.filter((item) => item.id !== task.id);
    if (!app.tasks.length) app.tasks.push(app.makeTask('New Task'));
    void app.persist('tasks');
    app.selectTask(app.tasks[0].id);
    app.showToast('Task deleted');
  });
}

function bindDataExport(app) {
  document.getElementById('export-data-btn')?.addEventListener('click', () => {
    const date = new Date().toISOString().slice(0, 10);
    downloadJson(`scalemax-data-${date}.json`, {
      tasks: app.tasks,
      settings: app.settings,
      automations: app.automations,
      skillStates: app.skillStates,
      connectorStates: app.connectorStates,
    });
    app.showToast('Data exported');
  });
}

// Catalog entries carry full records — prompt templates for skills, setup
// guides for connectors, prompt context for experts — that the list rows only
// summarise. Clicking a row opens the full record.
const DETAIL_SOURCES = [
  { selector: '#experts-grid', row: '.expert-card', kind: 'Expert role', entries: EXPERTS, idFrom: (node) => node.querySelector('.expert-use')?.dataset.expertId },
  { selector: '#skills-list', row: '.skill-card', kind: 'Prompt template', entries: SKILLS, idFrom: (node) => node.querySelector('.skill-toggle')?.dataset.id },
  { selector: '#connectors-list', row: '.connector-card', kind: 'Setup guide', entries: CONNECTORS, idFrom: (node) => node.querySelector('[data-connector-action]')?.dataset.connectorAction },
];

const RESOURCE_KINDS = {
  expert: { label: 'Expert role', entries: EXPERTS },
  skill: { label: 'Prompt template', entries: SKILLS },
  community: { label: 'Community', entries: COMMUNITY_SKILLS },
  connector: { label: 'Setup guide', entries: CONNECTORS },
};

function detailSection(label, value, asCode = false) {
  const section = element('div', 'detail-section');
  section.append(element('span', 'small-label', label));
  section.append(asCode ? element('pre', 'code-output', value) : element('p', 'detail-value', value));
  return section;
}

function detailList(label, values) {
  const section = element('div', 'detail-section');
  section.append(element('span', 'small-label', label));
  const list = element('ol', 'detail-steps');
  for (const value of values) list.append(element('li', 'detail-step', value));
  section.append(list);
  return section;
}

function copyButton(app, value, label) {
  const button = element('button', 'button secondary', label);
  button.style.alignSelf = 'flex-start';
  button.addEventListener('click', () => {
    if (!navigator.clipboard?.writeText) { app.showToast('Clipboard is unavailable'); return; }
    navigator.clipboard.writeText(value)
      .then(() => app.showToast(`${label.replace('Copy ', '')} copied`))
      .catch(() => app.showToast('Could not copy'));
  });
  return button;
}

function openDetailDialog(app, kind, entry) {
  const dialog = document.getElementById('detail-dialog');
  const kindNode = document.getElementById('detail-kind');
  const titleNode = document.getElementById('detail-title');
  const descriptionNode = document.getElementById('detail-description');
  const content = document.getElementById('detail-content');
  if (!dialog || !kindNode || !titleNode || !descriptionNode || !content) return;

  kindNode.textContent = kind;
  titleNode.textContent = entry.name;
  descriptionNode.textContent = entry.description || '';
  const parts = [];
  if (kind === 'Expert role') {
    if (entry.role) parts.push(detailSection('Role', entry.role));
    if (entry.prompt) parts.push(detailSection('Prompt context applied to chat', entry.prompt, true));
  } else if (kind === 'Prompt template') {
    if (entry.inputs?.length) parts.push(detailSection('Inputs', entry.inputs.join(' · ')));
    if (entry.prompt) parts.push(detailSection('Template', entry.prompt, true));
  } else if (kind === 'Community') {
    if (entry.publisher) parts.push(detailSection('Publisher', entry.publisher));
    if (entry.licenseNote) parts.push(detailSection('License', entry.licenseNote));
    if (entry.sourceUrl) {
      const section = detailSection('Source', entry.sourceUrl);
      section.append(copyButton(app, entry.sourceUrl, 'Copy link'));
      parts.push(section);
    }
  } else if (kind === 'Setup guide') {
    if (entry.auth) parts.push(detailSection('Authentication', entry.auth));
    if (entry.capabilities?.length) parts.push(detailSection('Capabilities', entry.capabilities.join(' · ')));
    if (entry.setupSteps?.length) parts.push(detailList('Setup steps', entry.setupSteps));
    if (entry.docsUrl) {
      const section = detailSection('Documentation', entry.docsUrl);
      section.append(copyButton(app, entry.docsUrl, 'Copy link'));
      parts.push(section);
    }
  }
  content.replaceChildren(...parts);
  if (!dialog.open) dialog.showModal();
}

function bindDetails(app) {
  for (const source of DETAIL_SOURCES) {
    document.querySelector(source.selector)?.addEventListener('click', (event) => {
      if (event.target.closest('.skill-toggle, .skill-run, .connector-actions, .expert-use')) return;
      const row = event.target.closest(source.row);
      if (!row) return;
      const id = source.idFrom(row);
      const entry = source.entries.find((item) => item.id === id);
      if (entry) openDetailDialog(app, source.kind, entry);
    });
  }

  document.getElementById('detail-close')?.addEventListener('click', () => {
    const dialog = document.getElementById('detail-dialog');
    if (dialog?.open) dialog.close();
  });
}

// ---- Connectors ----------------------------------------------------------
// Credentials live in the main process (encrypted with safeStorage); the
// renderer only ever sees sanitized metadata, never the token.

let connectorCredentials = {};
let activeConnector = null;

function connectorBridge() {
  return window.scalemaxAPI?.connectors || null;
}

function setConnectorStatus(message) {
  const node = document.getElementById('connector-status');
  if (node) node.textContent = message;
}

function connectorDotClass(status) {
  if (status === 'ok') return 'ok';
  if (status === 'error') return 'fail';
  if (status === 'unsupported') return 'pending';
  return '';
}

function decorateConnectors(app) {
  for (const slot of document.querySelectorAll('[data-connector-action]')) {
    const entry = CONNECTORS.find((item) => item.id === slot.dataset.connectorAction);
    if (!entry) continue;
    const record = connectorCredentials[entry.id];
    slot.replaceChildren();
    if (!record?.connected) {
      const connect = element('button', 'button secondary', 'Connect');
      connect.addEventListener('click', () => openConnectorDialog(app, entry));
      slot.append(connect);
      continue;
    }
    const chip = element('span', 'connector-chip');
    chip.title = record.lastStatus === 'ok' ? 'Token verified'
      : record.lastStatus === 'error' ? 'Token stored, provider check failed'
        : record.lastStatus === 'unsupported' ? 'Token stored, no validation endpoint yet'
          : 'Token stored';
    chip.append(
      element('span', `status-dot ${connectorDotClass(record.lastStatus)}`),
      element('span', 'connector-chip-text', record.hint || 'token stored'),
    );
    const test = element('button', 'button secondary', 'Test');
    test.addEventListener('click', () => void testConnector(app, entry));
    const remove = element('button', 'button danger', 'Disconnect');
    remove.addEventListener('click', () => void disconnectConnector(app, entry));
    slot.append(chip, test, remove);
  }
}

async function refreshConnectors(app) {
  const bridge = connectorBridge();
  if (bridge?.list) {
    const result = await bridge.list();
    connectorCredentials = result?.ok && result.data ? result.data : {};
  }
  decorateConnectors(app);
}

function openConnectorDialog(app, entry) {
  if (!connectorBridge()) { app.showToast('Connector connections require the desktop app'); return; }
  const dialog = document.getElementById('connector-dialog');
  if (!dialog) return;
  activeConnector = entry;
  const title = document.getElementById('connector-dialog-title');
  const description = document.getElementById('connector-dialog-description');
  const hint = document.getElementById('connector-token-hint');
  const token = document.getElementById('connector-token');
  if (title) title.textContent = `Connect ${entry.name}`;
  if (description) description.textContent = entry.description || '';
  if (hint) hint.textContent = entry.auth || '';
  if (token) token.value = '';
  setConnectorStatus('');
  if (!dialog.open) dialog.showModal();
}

async function submitConnector(app, event) {
  event.preventDefault();
  const bridge = connectorBridge();
  if (!bridge) {
    setConnectorStatus('Connector connections require the desktop app');
    app.showToast('Connector connections require the desktop app');
    return;
  }
  if (!activeConnector) return;
  const token = document.getElementById('connector-token')?.value.trim() || '';
  if (!token) { setConnectorStatus('Enter the access token.'); return; }
  const button = document.getElementById('connector-save');
  if (button) button.disabled = true;
  setConnectorStatus('Saving…');
  try {
    const saved = await bridge.save({ id: activeConnector.id, token });
    if (!saved?.ok) {
      setConnectorStatus(saved?.error?.message || 'Could not save the token.');
      return;
    }
    const input = document.getElementById('connector-token');
    if (input) input.value = '';
    await refreshConnectors(app);
    app.showToast(`${activeConnector.name} connected`);
    setConnectorStatus('Validating token…');
    const result = await bridge.test({ id: activeConnector.id });
    await refreshConnectors(app);
    const data = result?.data;
    if (data?.supported === false) setConnectorStatus(data.message || 'Saved. No validation endpoint is configured yet.');
    else if (data?.ok) setConnectorStatus('Connection verified.');
    else setConnectorStatus(data?.message || 'Token saved, but the provider rejected it.');
  } finally {
    if (button) button.disabled = false;
  }
}

async function testConnector(app, entry) {
  const bridge = connectorBridge();
  if (!bridge) { app.showToast('Connector connections require the desktop app'); return; }
  app.showToast(`Testing ${entry.name}…`);
  const result = await bridge.test({ id: entry.id });
  await refreshConnectors(app);
  const data = result?.data;
  app.showToast(data?.ok ? `${entry.name} verified`
    : data?.supported === false ? `${entry.name}: no validation endpoint yet`
      : `${entry.name} check failed`);
}

async function disconnectConnector(app, entry) {
  const bridge = connectorBridge();
  if (!bridge) { app.showToast('Connector connections require the desktop app'); return; }
  const result = await bridge.remove({ id: entry.id });
  if (!result?.ok) { app.showToast(result?.error?.message || 'Could not disconnect'); return; }
  await refreshConnectors(app);
  app.showToast(`${entry.name} disconnected`);
}

function bindConnectors(app) {
  const dialog = document.getElementById('connector-dialog');
  if (dialog) {
    document.getElementById('connector-form')?.addEventListener('submit', (event) => void submitConnector(app, event));
    document.getElementById('connector-dialog-close')?.addEventListener('click', () => { if (dialog.open) dialog.close(); });
    document.getElementById('connector-cancel')?.addEventListener('click', () => { if (dialog.open) dialog.close(); });
  }
  // app.js re-renders the catalog with replaceChildren; re-decorate after each swap.
  const list = document.getElementById('connectors-list');
  if (list) new MutationObserver(() => decorateConnectors(app)).observe(list, { childList: true });
  void refreshConnectors(app);
}

export function openResourceDetail(app, kind, id) {
  const source = RESOURCE_KINDS[kind];
  const entry = source?.entries.find((item) => item.id === id);
  if (!source || !entry) { app.showToast('No details available'); return; }
  openDetailDialog(app, source.label, entry);
}

export function bindCatalogUi(app) {
  if (!app || typeof app !== 'object' || boundApps.has(app)) return;
  boundApps.add(app);
  populateCategories();
  bindFilter();
  renderCommunity(app);
  bindTheme(app);
  bindTaskActions(app);
  bindDataExport(app);
  bindDetails(app);
  bindConnectors(app);
}
