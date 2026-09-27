import { COMMUNITY_SKILLS, CONNECTORS } from './data.js';
import { OAUTH_SUPPORT } from './oauth-catalog.js';
import { MCP_SIGN_IN, MCP_LISTING_NAMES } from './mcp-directory.js';

// Entries are read through the app so user-created experts and skills are included.
const CATALOGS = [
  { selector: '#experts-grid', trigger: '.expert-use', idKey: 'expertId', entries: (app) => app.allExperts() },
  { selector: '#skills-list', trigger: '.skill-toggle', idKey: 'id', entries: (app) => app.allSkills() },
  { selector: '#connectors-list', trigger: '[data-connector-action]', idKey: 'connectorAction', entries: () => CONNECTORS },
  { selector: '#community-list', trigger: '[data-detail-id]', idKey: 'detailId', entries: () => COMMUNITY_SKILLS },
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

function populateCategories(app) {
  const select = document.getElementById('catalog-category');
  if (!select) return;
  const previous = select.value;
  const categories = [...new Set(
    [...app.allExperts(), ...app.allSkills(), ...CONNECTORS].map((entry) => entry.category).filter(Boolean),
  )].sort((a, b) => a.localeCompare(b));
  const current = [...select.options].map((node) => node.value).join('\n');
  // Rebuilding the options on every catalog render would reset keyboard focus; only rebuild on change.
  if (current === ['all', ...categories].join('\n')) return;
  select.replaceChildren(option('all', 'All'), ...categories.map((category) => option(category, category)));
  select.value = categories.includes(previous) ? previous : 'all';
}

function bindFilter(app) {
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
        const entry = catalog.entries(app).find((item) => item.id === trigger?.dataset[catalog.idKey]);
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
  // app.js re-renders the catalogs with replaceChildren, so re-apply after each swap
  // (custom experts and skills can add categories).
  for (const catalog of CATALOGS) {
    const list = document.querySelector(catalog.selector);
    if (list) new MutationObserver(() => { populateCategories(app); apply(); }).observe(list, { childList: true });
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
      customExperts: app.customExperts,
      customSkills: app.customSkills,
    });
    app.showToast('Data exported');
  });
}

// Catalog entries carry full records — prompt templates for skills, setup
// guides for connectors, prompt context for experts — that the list rows only
// summarise. Clicking a row opens the full record.
const DETAIL_SOURCES = [
  { selector: '#experts-grid', row: '.expert-card', kind: 'Expert role', entries: (app) => app.allExperts(), idFrom: (node) => node.querySelector('.expert-use')?.dataset.expertId },
  { selector: '#skills-list', row: '.skill-card', kind: 'Prompt template', entries: (app) => app.allSkills(), idFrom: (node) => node.querySelector('.skill-toggle')?.dataset.id },
  { selector: '#connectors-list', row: '.connector-card', kind: 'Setup guide', entries: () => CONNECTORS, idFrom: (node) => node.querySelector('[data-connector-action]')?.dataset.connectorAction },
];

const RESOURCE_KINDS = {
  expert: { label: 'Expert role', entries: (app) => app.allExperts() },
  skill: { label: 'Prompt template', entries: (app) => app.allSkills() },
  community: { label: 'Community', entries: () => COMMUNITY_SKILLS },
  connector: { label: 'Setup guide', entries: () => CONNECTORS },
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
      if (event.target.closest('.skill-toggle, .skill-run, .connector-actions, .expert-use, .custom-edit, .custom-delete')) return;
      const row = event.target.closest(source.row);
      if (!row) return;
      const id = source.idFrom(row);
      const entry = source.entries(app).find((item) => item.id === id);
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
// renderer only ever sees sanitized metadata, never a token or client secret.
// OAuth provider URLs and rules are owned by main (lib/oauth-catalog.cjs); the
// renderer passes a connector id and reads display details via getOAuthConfig.

let connectorCredentials = {};
let activeConnector = null;
let activeOAuthConfig = null;
// The connector whose browser sign-in is in progress; it keeps running if the dialog closes.
let oauthPendingId = null;
// MCP servers (sanitized list entries); one-click sign-ins are the ones with auth.directoryId.
let mcpServers = [];
// The connector whose one-click sign-in is in progress.
let mcpPendingId = null;
const MCP_CHANGED = 'scalemax:mcp-changed';
// Connectors that can sign in through an installed CLI ({ github: { installed } }), and the
// CLI sign-in in progress ({ id, code }; code is set once the device page is open).
let cliSupport = {};
let cliPending = null;

function mcpBridge() {
  return window.scalemaxAPI?.mcp || null;
}

function mcpListing(connectorId) {
  return Object.hasOwn(MCP_SIGN_IN, connectorId) ? MCP_SIGN_IN[connectorId] : null;
}

/** The signed-in MCP server that serves this connector, or null. */
function mcpServerFor(connectorId) {
  const listing = mcpListing(connectorId);
  return mcpServers.find((server) => (listing && server.auth?.directoryId === listing)
    || server.connector === connectorId) || null;
}

// Installed, or downloadable on the first Connect.
function cliAvailableFor(connectorId) {
  const support = Object.hasOwn(cliSupport, connectorId) ? cliSupport[connectorId] : null;
  return Boolean(support && (support.installed || support.installable) && connectorBridge()?.cliConnect);
}

const CLI_PHASES = {
  starting: 'Connecting…',
  downloading: 'Downloading GitHub CLI…',
  verifying: 'Verifying GitHub CLI…',
  installing: 'Installing GitHub CLI…',
  checking: 'Checking GitHub CLI login…',
  login: 'Starting GitHub CLI login…',
};

function cliPendingText(pendingState) {
  if (pendingState.code) return `Code ${pendingState.code}`;
  const base = CLI_PHASES[pendingState.phase] || 'Connecting…';
  return pendingState.phase === 'downloading' && Number.isFinite(pendingState.percent)
    ? base.replace('…', ` ${pendingState.percent}%…`) : base;
}

function toolCountText(count) {
  return `${count} tool${count === 1 ? '' : 's'}`;
}

function mcpConnectedLabel(server) {
  if (server.lastStatus === 'error') return 'Signed in · connection failed';
  if (server.lastStatus === 'ok') return `Connected · ${toolCountText(server.toolCount)} in chat`;
  return 'Signed in';
}

const LOOPBACK_LABELS = {
  yes: 'Loopback redirect supported',
  'localhost-only': 'Uses a localhost redirect',
  unknown: 'Loopback redirect unconfirmed',
};

function connectorBridge() {
  return window.scalemaxAPI?.connectors || null;
}

function byId(id) {
  return document.getElementById(id);
}

function setText(id, text) {
  const node = byId(id);
  if (node) node.textContent = text;
}

function setConnectorStatus(message) {
  setText('connector-status', message);
}

function setOAuthStatus(message) {
  setText('connector-oauth-status', message);
}

function connectorDotClass(status) {
  if (status === 'ok') return 'ok';
  if (status === 'error') return 'fail';
  if (status === 'unsupported') return 'pending';
  return '';
}

function oauthAvailable(id) {
  return Object.hasOwn(OAUTH_SUPPORT, id) && OAUTH_SUPPORT[id] !== 'no';
}

function copyText(app, value, label) {
  if (!value) return;
  if (!navigator.clipboard?.writeText) { app.showToast('Clipboard is unavailable'); return; }
  navigator.clipboard.writeText(value)
    .then(() => app.showToast(`${label} copied`))
    .catch(() => app.showToast('Could not copy'));
}

function connectedLabel(record) {
  if (record.identity) return record.oauth ? `Signed in as ${record.identity}` : record.identity;
  return record.oauth ? `OAuth ${record.hint || 'token stored'}` : (record.hint || 'token stored');
}

function connectorActions(app, entry, slot, chip) {
  const test = element('button', 'button secondary', 'Test');
  test.addEventListener('click', () => void testConnector(app, entry));
  const manage = element('button', 'button secondary', 'Manage');
  manage.addEventListener('click', () => void openConnectorDialog(app, entry));
  const remove = element('button', 'button danger', 'Disconnect');
  remove.addEventListener('click', () => void disconnectConnector(app, entry));
  slot.append(chip, test, manage, remove);
}

function decorateConnectors(app) {
  for (const slot of document.querySelectorAll('[data-connector-action]')) {
    const entry = CONNECTORS.find((item) => item.id === slot.dataset.connectorAction);
    if (!entry) continue;
    const record = connectorCredentials[entry.id];
    const server = mcpServerFor(entry.id);
    slot.replaceChildren();
    if (server) {
      const chip = element('span', 'connector-chip');
      chip.title = server.lastStatus === 'error' ? (server.lastError || 'Signed in, but the connection failed')
        : `Connected through the official ${MCP_LISTING_NAMES[server.auth?.directoryId] || entry.name} MCP server`;
      chip.append(
        element('span', `status-dot ${connectorDotClass(server.lastStatus)}`),
        element('span', 'connector-chip-text', mcpConnectedLabel(server)),
      );
      connectorActions(app, entry, slot, chip);
      continue;
    }
    if (!record?.connected && cliPending?.id === entry.id) {
      // The device page is open: show the one-time code the user enters there.
      const waiting = element('span', 'connector-chip');
      waiting.append(element('span', 'status-dot pending'),
        element('span', 'connector-chip-text', cliPendingText(cliPending)));
      if (cliPending.code) waiting.title = 'Enter this code on github.com/login/device';
      slot.append(waiting);
      if (cliPending.code) {
        const code = cliPending.code;
        const copy = element('button', 'button secondary', 'Copy code');
        copy.addEventListener('click', () => copyText(app, code, 'Code'));
        slot.append(copy);
      }
      const cancel = element('button', 'button secondary', 'Cancel');
      cancel.addEventListener('click', () => void connectorBridge()?.cliCancel?.({ id: entry.id }));
      slot.append(cancel);
      continue;
    }
    if (!record?.connected && cliAvailableFor(entry.id)) {
      const connect = element('button', 'button secondary', 'Connect');
      connect.addEventListener('click', () => void startCliConnect(app, entry));
      const more = element('button', 'connector-more', 'More options');
      more.setAttribute('aria-label', `More ways to connect ${entry.name}`);
      more.addEventListener('click', () => void openConnectorDialog(app, entry));
      slot.append(connect, more);
      continue;
    }
    const oneClick = Boolean(mcpListing(entry.id) && mcpBridge()?.signIn);
    if (!record?.connected && oneClick && mcpPendingId === entry.id) {
      // The consent page is open in the browser; the card waits for it.
      const waiting = element('span', 'connector-chip');
      waiting.append(element('span', 'status-dot pending'), element('span', 'connector-chip-text', 'Waiting for browser…'));
      const cancel = element('button', 'button secondary', 'Cancel');
      cancel.addEventListener('click', () => void cancelMcpSignIn());
      slot.append(waiting, cancel);
      continue;
    }
    if (!record?.connected) {
      const connect = element('button', 'button secondary', 'Connect');
      // One-click connectors go straight to the provider's consent page; the others need the dialog.
      connect.addEventListener('click', () => (oneClick
        ? void startMcpSignIn(app, entry)
        : void openConnectorDialog(app, entry)));
      slot.append(connect);
      if (oneClick) {
        const more = element('button', 'connector-more', 'More options');
        more.setAttribute('aria-label', `More ways to connect ${entry.name}`);
        more.addEventListener('click', () => void openConnectorDialog(app, entry));
        slot.append(more);
      } else {
        slot.append(element('span', 'connector-auth-hint', oauthAvailable(entry.id) ? 'OAuth or token' : 'Access token'));
      }
      continue;
    }
    const chip = element('span', 'connector-chip');
    chip.title = record.lastStatus === 'ok' ? 'Credential verified'
      : record.lastStatus === 'error' ? (record.lastError || 'Credential stored, provider check failed')
        : record.lastStatus === 'unsupported' ? 'Token stored, no validation endpoint yet'
          : 'Credential stored';
    chip.append(
      element('span', `status-dot ${connectorDotClass(record.lastStatus)}`),
      element('span', 'connector-chip-text', connectedLabel(record)),
    );
    connectorActions(app, entry, slot, chip);
  }
}

async function refreshConnectors(app) {
  const bridge = connectorBridge();
  if (bridge?.list) {
    const result = await bridge.list();
    connectorCredentials = result?.ok && result.data ? result.data : {};
  }
  const mcp = mcpBridge();
  if (mcp?.list) {
    const result = await mcp.list();
    mcpServers = result?.ok && Array.isArray(result.data) ? result.data : [];
  }
  if (bridge?.cliAvailable) {
    const result = await bridge.cliAvailable();
    cliSupport = result?.ok && result.data ? result.data : {};
  }
  decorateConnectors(app);
  renderConnectorCurrent();
  if (activeConnector) renderMcpSection(activeConnector);
}

// Tells the MCP view (and this one) that the server list changed.
function announceMcpChange() {
  window.dispatchEvent(new CustomEvent(MCP_CHANGED, { detail: { source: 'connectors' } }));
}

// The "currently connected" line at the top of the dialog.
function renderConnectorCurrent() {
  const node = byId('connector-current');
  if (!node) return;
  const record = activeConnector ? connectorCredentials[activeConnector.id] : null;
  const server = activeConnector ? mcpServerFor(activeConnector.id) : null;
  const parts = [];
  if (server) parts.push(`${mcpConnectedLabel(server)}${server.lastStatus === 'error' && server.lastError ? ` · ${server.lastError}` : ''}`);
  if (record?.connected) {
    parts.push(`${server ? 'Token' : 'Connected'} · ${connectedLabel(record)}${record.lastStatus === 'error' && record.lastError ? ` · ${record.lastError}` : ''}`);
  }
  node.hidden = !parts.length;
  node.textContent = parts.join('\n');
}

function setMcpStatus(message) {
  setText('connector-mcp-status', message);
}

// One-click sign-in section; the advanced options collapse underneath when it is available.
function renderMcpSection(entry) {
  const section = byId('connector-mcp-section');
  const advanced = byId('connector-advanced');
  const listing = mcpListing(entry.id);
  const available = Boolean(listing && mcpBridge()?.signIn);
  if (section) section.hidden = !available;
  setText('connector-advanced-summary', available
    ? 'Advanced: use your own OAuth app or an access token'
    : 'Sign-in options');
  if (!available) {
    if (advanced) advanced.open = true;
    return;
  }
  const server = mcpServerFor(entry.id);
  const pending = mcpPendingId === entry.id;
  const name = MCP_LISTING_NAMES[listing] || entry.name;
  setText('connector-mcp-copy', server
    ? `Connected through the official ${name} MCP server. Its tools are offered in chat.`
    : `Opens ${name} in your browser. Approve access and ScaleMax connects automatically: no app registration, `
      + `keys or callback URL needed. ${name} tools then become available in chat.`);
  setText('connector-mcp-start', server ? 'Sign in again' : `Sign in with ${entry.name}`);
  const start = byId('connector-mcp-start');
  if (start) start.disabled = pending;
  const cancel = byId('connector-mcp-cancel');
  if (cancel) cancel.hidden = !pending;
  const disconnect = byId('connector-mcp-disconnect');
  if (disconnect) disconnect.hidden = !server || pending;
}

// Starts the browser sign-in from the card (Connect) or from the dialog.
async function startMcpSignIn(app, entry = activeConnector) {
  const mcp = mcpBridge();
  if (!mcp?.signIn || !entry || mcpPendingId === entry.id) return;
  // Starting a sign-in cancels any other one in main, so only one card waits at a time.
  mcpPendingId = entry.id;
  decorateConnectors(app);
  if (activeConnector === entry) renderMcpSection(entry);
  const report = (message, toast) => {
    if (activeConnector === entry) setMcpStatus(message);
    else if (toast) app.showToast(`${entry.name}: ${message}`);
  };
  if (activeConnector === entry) {
    report(`Approve access in your browser. ScaleMax finishes connecting as soon as ${entry.name} redirects back (up to 5 minutes)…`, false);
  } else {
    app.showToast(`Approve ${entry.name} access in your browser…`);
  }
  try {
    const result = await mcp.signIn({ connectorId: entry.id });
    if (!result?.ok) {
      const cancelled = result?.error?.code === 'CANCELLED';
      report(cancelled ? 'Sign-in cancelled.' : (result?.error?.message || 'Sign-in failed.'), !cancelled);
      return;
    }
    const server = result.data;
    if (server.lastStatus === 'ok') {
      report(`Connected. ${toolCountText(server.toolCount)} available in chat.`, false);
      app.showToast(`${entry.name} connected · ${toolCountText(server.toolCount)} in chat`);
    } else {
      report(`Signed in, but connecting failed: ${server.lastError || 'unknown error'}`, true);
    }
  } catch (error) {
    report(error?.message || 'Sign-in failed.', true);
  } finally {
    if (mcpPendingId === entry.id) mcpPendingId = null;
    await refreshConnectors(app);
    announceMcpChange();
  }
}

function cliConnectedMessage(entry, data) {
  const via = data.source === 'existing' ? ' with your GitHub CLI login' : '';
  if (data.mcpError) return `${entry.name} connected${via}. Chat tools are unavailable: ${data.mcpError}`;
  return `${entry.name} connected${via} · ${toolCountText(data.toolCount || 0)} in chat`;
}

// Connect through the provider's CLI: an existing login finishes at once; otherwise the device
// page opens and the card shows the one-time code until the user approves.
async function startCliConnect(app, entry) {
  const bridge = connectorBridge();
  if (!bridge?.cliConnect || cliPending) return;
  const mine = { id: entry.id, code: null, phase: 'starting', percent: null };
  cliPending = mine;
  decorateConnectors(app);
  const fail = (result) => {
    if (result?.error?.code !== 'CANCELLED') app.showToast(`${entry.name}: ${result?.error?.message || 'sign-in failed'}`);
  };
  if (!cliSupport[entry.id]?.installed) app.showToast('Downloading the GitHub CLI from github.com…');
  // Download and login progress until the one-time code (or the connection) arrives.
  let shown = cliPendingText(mine);
  const poll = setInterval(async () => {
    if (cliPending !== mine || mine.code || !bridge.cliStatus) return;
    const progress = await bridge.cliStatus({ id: entry.id });
    if (cliPending !== mine || mine.code || !progress?.ok || progress.data.phase === 'idle') return;
    mine.phase = progress.data.phase;
    mine.percent = Number.isFinite(progress.data.percent) ? progress.data.percent : null;
    const text = cliPendingText(mine);
    if (text !== shown) {
      shown = text;
      decorateConnectors(app);
    }
  }, 400);
  try {
    const started = await bridge.cliConnect({ id: entry.id });
    clearInterval(poll);
    if (!started?.ok) { fail(started); return; }
    if (started.data.installed) cliSupport[entry.id] = { ...cliSupport[entry.id], installed: true };
    if (started.data.status === 'connected') {
      app.showToast(cliConnectedMessage(entry, started.data));
      return;
    }
    mine.code = started.data.code;
    decorateConnectors(app);
    app.showToast(`${started.data.installed ? 'GitHub CLI installed. ' : ''}Log in to the GitHub CLI: enter code ${mine.code} `
      + `on the GitHub page in your browser${started.data.copied ? ' (copied)' : ''}`);
    const done = await bridge.cliWait({ id: entry.id });
    if (!done?.ok) { fail(done); return; }
    app.showToast(cliConnectedMessage(entry, done.data));
  } catch (error) {
    app.showToast(`${entry.name}: ${error?.message || 'sign-in failed'}`);
  } finally {
    clearInterval(poll);
    if (cliPending === mine) cliPending = null;
    await refreshConnectors(app);
    announceMcpChange();
  }
}

async function cancelMcpSignIn() {
  await mcpBridge()?.cancelSignIn?.();
}

/** Removes the one-click sign-in (server entry and tokens). Returns false if it failed. */
async function removeMcpServer(app, entry) {
  const server = mcpServerFor(entry.id);
  if (!server) return true;
  const result = await mcpBridge().remove({ id: server.id });
  if (!result?.ok) { app.showToast(result?.error?.message || 'Could not disconnect'); return false; }
  return true;
}

async function disconnectMcp(app) {
  const entry = activeConnector;
  if (!entry) return;
  if (!(await removeMcpServer(app, entry))) return;
  setMcpStatus('Disconnected. The sign-in was removed from this device.');
  await refreshConnectors(app);
  announceMcpChange();
}

function setOAuthPending(pending) {
  const start = byId('connector-oauth-start');
  const cancel = byId('connector-oauth-cancel');
  if (start) start.disabled = pending;
  if (cancel) cancel.hidden = !pending;
  for (const id of ['connector-client-id', 'connector-client-secret', 'connector-shop']) {
    const input = byId(id);
    if (input) input.disabled = pending;
  }
}

function renderOAuthSection(entry, config) {
  const section = byId('connector-oauth-section');
  const unavailable = byId('connector-oauth-unavailable');
  activeOAuthConfig = config?.supported ? config : null;
  if (section) section.hidden = !activeOAuthConfig || activeOAuthConfig.loopback === 'no';
  if (unavailable) {
    const blocked = Boolean(activeOAuthConfig && activeOAuthConfig.loopback === 'no');
    unavailable.hidden = !blocked;
    unavailable.textContent = blocked
      ? `OAuth sign-in isn't available for ${entry.name} in a desktop app: ${activeOAuthConfig.redirectNote || 'the provider requires HTTPS redirects.'} Use an access token below.`
      : '';
  }
  if (!activeOAuthConfig || activeOAuthConfig.loopback === 'no') return;
  const current = activeOAuthConfig;
  setText('connector-oauth-title', `Sign in with ${entry.name}`);
  setText('connector-oauth-badge', LOOPBACK_LABELS[current.loopback] || 'Loopback redirect');
  setText('connector-register-url', current.registerUrl || 'See the provider documentation');
  setText('connector-redirect-uri', current.redirectUri || '');
  const note = byId('connector-redirect-note');
  if (note) {
    note.hidden = !current.redirectNote;
    note.textContent = current.redirectNote || '';
  }
  const clientId = byId('connector-client-id');
  if (clientId) clientId.value = current.clientId || '';
  const secretGroup = byId('connector-client-secret-group');
  const secretNone = byId('connector-secret-none');
  const secret = byId('connector-client-secret');
  if (secretGroup) secretGroup.hidden = current.secret === 'none';
  if (secretNone) secretNone.hidden = current.secret !== 'none';
  setText('connector-secret-mode', current.secret === 'required' ? '(required)' : '(optional)');
  if (secret) {
    secret.value = '';
    secret.placeholder = current.hasSecret
      ? `Stored ${current.secretStorage === 'session' ? 'for this session' : 'encrypted'}; leave blank to keep it`
      : "The app's client secret";
  }
  const shopGroup = byId('connector-shop-group');
  const shop = byId('connector-shop');
  if (shopGroup) shopGroup.hidden = !current.needsShop;
  if (shop) shop.value = current.shop || '';
  const forget = byId('connector-oauth-forget');
  if (forget) forget.hidden = !current.configured;
  const record = connectorCredentials[entry.id];
  setText('connector-oauth-start', record?.oauth && record.connected ? `Sign in to ${entry.name} again` : `Sign in with ${entry.name}`);
}

async function openConnectorDialog(app, entry) {
  const bridge = connectorBridge();
  if (!bridge) { app.showToast('Connector connections require the desktop app'); return; }
  const dialog = byId('connector-dialog');
  if (!dialog) return;
  activeConnector = entry;
  activeOAuthConfig = null;
  setText('connector-dialog-title', `Connect ${entry.name}`);
  setText('connector-dialog-description', entry.description || '');
  setText('connector-token-hint', entry.auth || '');
  const token = byId('connector-token');
  if (token) token.value = '';
  setConnectorStatus('');
  const pending = oauthPendingId === entry.id;
  setOAuthStatus(pending ? `Waiting for the ${entry.name} sign-in to finish in your browser…` : '');
  setOAuthPending(pending);
  renderOAuthSection(entry, null);
  renderConnectorCurrent();
  const advanced = byId('connector-advanced');
  // With one-click sign-in available the other options start collapsed, unless one is in use.
  if (advanced) advanced.open = !(mcpListing(entry.id) && mcpBridge()?.signIn) || Boolean(connectorCredentials[entry.id]?.connected) || pending;
  setMcpStatus(mcpPendingId === entry.id ? `Waiting for the ${entry.name} sign-in to finish in your browser…` : '');
  renderMcpSection(entry);
  if (!dialog.open) dialog.showModal();
  if (Object.hasOwn(OAUTH_SUPPORT, entry.id) && bridge.getOAuthConfig) {
    const result = await bridge.getOAuthConfig({ id: entry.id });
    // The user may have switched connectors while this was loading.
    if (activeConnector !== entry) return;
    if (result?.ok) renderOAuthSection(entry, result.data);
    else setOAuthStatus(result?.error?.message || 'OAuth settings could not be loaded.');
  }
}

async function saveOAuthSettings(bridge) {
  const input = { id: activeConnector.id, clientId: byId('connector-client-id')?.value.trim() || '' };
  const secret = byId('connector-client-secret')?.value.trim() || '';
  // A blank secret keeps the stored one; clearing happens through "Forget app settings".
  if (secret && activeOAuthConfig?.secret !== 'none') input.clientSecret = secret;
  if (activeOAuthConfig?.needsShop) input.shop = byId('connector-shop')?.value.trim() || '';
  const saved = await bridge.saveOAuthConfig(input);
  if (!saved?.ok) throw new Error(saved?.error?.message || 'OAuth settings could not be saved.');
  const secretInput = byId('connector-client-secret');
  if (secretInput) secretInput.value = '';
  renderOAuthSection(activeConnector, saved.data);
  return saved.data;
}

async function startConnectorOAuth(app, event) {
  event.preventDefault();
  const bridge = connectorBridge();
  if (!bridge?.startOAuth || !activeConnector || oauthPendingId === activeConnector.id) return;
  const entry = activeConnector;
  if (!byId('connector-client-id')?.value.trim()) { setOAuthStatus('Enter the client ID of your OAuth app.'); return; }
  oauthPendingId = entry.id;
  setOAuthPending(true);
  setOAuthStatus('Saving app settings…');
  // The dialog may be closed while the browser flow runs; results then arrive as toasts.
  const report = (message, toast) => {
    if (activeConnector === entry) setOAuthStatus(message);
    else if (toast) app.showToast(`${entry.name}: ${message}`);
  };
  try {
    await saveOAuthSettings(bridge);
    report(`Complete the sign-in in your browser. Waiting for ${entry.name} to redirect back (up to 5 minutes)…`, false);
    const result = await bridge.startOAuth({ id: entry.id });
    if (!result?.ok) {
      const cancelled = result?.error?.code === 'CANCELLED';
      report(cancelled ? 'Sign-in cancelled.' : (result?.error?.message || 'OAuth sign-in failed.'), !cancelled);
      return;
    }
    const identity = result.data?.identity;
    report(identity ? `Signed in as ${identity}.` : 'Signed in. The access token is stored encrypted.', false);
    app.showToast(`${entry.name} connected`);
  } catch (error) {
    report(error?.message || 'OAuth sign-in failed.', true);
  } finally {
    if (oauthPendingId === entry.id) oauthPendingId = null;
    if (activeConnector === entry) setOAuthPending(false);
    await refreshConnectors(app);
    if (activeConnector === entry) renderOAuthSection(entry, activeOAuthConfig);
  }
}

async function cancelConnectorOAuth() {
  const bridge = connectorBridge();
  if (!bridge?.disconnectOAuth || !activeConnector) return;
  await bridge.disconnectOAuth({ id: activeConnector.id, pendingOnly: true });
}

async function forgetConnectorOAuth(app) {
  const bridge = connectorBridge();
  const entry = activeConnector;
  if (!bridge?.disconnectOAuth || !entry) return;
  if (!window.confirm(`Remove the saved OAuth app settings for ${entry.name} and disconnect it?`)) return;
  const result = await bridge.disconnectOAuth({ id: entry.id, forgetClient: true });
  if (!result?.ok) { setOAuthStatus(result?.error?.message || 'Could not remove the app settings.'); return; }
  setOAuthStatus('App settings removed.');
  await refreshConnectors(app);
  const config = await bridge.getOAuthConfig({ id: entry.id });
  if (activeConnector === entry && config?.ok) renderOAuthSection(entry, config.data);
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
  const entry = activeConnector;
  const token = byId('connector-token')?.value.trim() || '';
  if (!token) { setConnectorStatus('Enter the access token.'); return; }
  const button = byId('connector-save');
  if (button) button.disabled = true;
  setConnectorStatus('Saving…');
  try {
    const saved = await bridge.save({ id: entry.id, token });
    if (!saved?.ok) {
      setConnectorStatus(saved?.error?.message || 'Could not save the token.');
      return;
    }
    const input = byId('connector-token');
    if (input) input.value = '';
    await refreshConnectors(app);
    app.showToast(`${entry.name} connected`);
    setConnectorStatus('Validating token…');
    const result = await bridge.test({ id: entry.id });
    await refreshConnectors(app);
    const data = result?.data;
    if (data?.supported === false) setConnectorStatus(data.message || 'Saved. No validation endpoint is configured yet.');
    else if (data?.ok) setConnectorStatus('Connection verified.');
    else setConnectorStatus(data?.message || result?.error?.message || 'Token saved, but the provider rejected it.');
  } finally {
    if (button) button.disabled = false;
  }
}

async function testConnector(app, entry) {
  const bridge = connectorBridge();
  if (!bridge) { app.showToast('Connector connections require the desktop app'); return; }
  app.showToast(`Testing ${entry.name}…`);
  const server = mcpServerFor(entry.id);
  if (server) {
    const tested = await mcpBridge().test({ id: server.id });
    await refreshConnectors(app);
    announceMcpChange();
    app.showToast(tested?.ok
      ? `${entry.name} verified · ${toolCountText(tested.data.tools.length)}`
      : `${entry.name}: ${tested?.error?.message || 'check failed'}`);
    return;
  }
  const result = await bridge.test({ id: entry.id });
  await refreshConnectors(app);
  const data = result?.data;
  app.showToast(data?.ok ? `${entry.name} verified`
    : data?.supported === false ? `${entry.name}: no validation endpoint yet`
      : `${entry.name}: ${data?.message || result?.error?.message || 'check failed'}`);
}

// Removes every credential of the connector: the one-click sign-in and any stored token.
async function disconnectConnector(app, entry) {
  const bridge = connectorBridge();
  if (!bridge) { app.showToast('Connector connections require the desktop app'); return; }
  const hadServer = Boolean(mcpServerFor(entry.id));
  if (!(await removeMcpServer(app, entry))) return;
  if (connectorCredentials[entry.id]?.connected || !hadServer) {
    const result = await bridge.remove({ id: entry.id });
    if (!result?.ok) { app.showToast(result?.error?.message || 'Could not disconnect'); return; }
  }
  await refreshConnectors(app);
  if (hadServer) announceMcpChange();
  app.showToast(`${entry.name} disconnected`);
}

function bindConnectors(app) {
  const dialog = byId('connector-dialog');
  if (dialog) {
    byId('connector-form')?.addEventListener('submit', (event) => void submitConnector(app, event));
    byId('connector-oauth-form')?.addEventListener('submit', (event) => void startConnectorOAuth(app, event));
    byId('connector-oauth-cancel')?.addEventListener('click', () => void cancelConnectorOAuth());
    byId('connector-oauth-forget')?.addEventListener('click', () => void forgetConnectorOAuth(app));
    byId('connector-mcp-start')?.addEventListener('click', () => void startMcpSignIn(app, activeConnector));
    byId('connector-mcp-cancel')?.addEventListener('click', () => void cancelMcpSignIn());
    byId('connector-mcp-disconnect')?.addEventListener('click', () => void disconnectMcp(app));
    byId('connector-register-copy')?.addEventListener('click', () => copyText(app, activeOAuthConfig?.registerUrl, 'Link'));
    byId('connector-redirect-copy')?.addEventListener('click', () => copyText(app, activeOAuthConfig?.redirectUri, 'Redirect URI'));
    // Closing the dialog leaves a browser sign-in running; "Cancel sign-in" stops it.
    const close = () => { if (dialog.open) dialog.close(); };
    byId('connector-dialog-close')?.addEventListener('click', close);
    byId('connector-cancel')?.addEventListener('click', close);
    dialog.addEventListener('close', () => { activeConnector = null; });
  }
  // app.js re-renders the catalog with replaceChildren; re-decorate after each swap.
  const list = byId('connectors-list');
  if (list) new MutationObserver(() => decorateConnectors(app)).observe(list, { childList: true });
  // Servers added or removed in the MCP view change what the connector cards show.
  window.addEventListener(MCP_CHANGED, (event) => {
    if (event.detail?.source !== 'connectors') void refreshConnectors(app);
  });
  void refreshConnectors(app);
}


export function openResourceDetail(app, kind, id) {
  const source = Object.hasOwn(RESOURCE_KINDS, kind) ? RESOURCE_KINDS[kind] : null;
  const entry = source?.entries(app).find((item) => item.id === id);
  if (!source || !entry) { app.showToast('No details available'); return; }
  openDetailDialog(app, source.label, entry);
}

export function bindCatalogUi(app) {
  if (!app || typeof app !== 'object' || boundApps.has(app)) return;
  boundApps.add(app);
  populateCategories(app);
  bindFilter(app);
  renderCommunity(app);
  bindTheme(app);
  bindTaskActions(app);
  bindDataExport(app);
  bindDetails(app);
  bindConnectors(app);
}
