/** ScaleMax IDE: manage MCP servers (add, edit, test, enable for chat, remove). */

const byId = (id) => document.getElementById(id);
const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const HEADER_LINE = /^([A-Za-z0-9-]+)\s*:\s*(.*)$/;

let servers = [];
// Tool summaries from the last successful test or listing, keyed by server id.
const toolCache = new Map();
const expanded = new Set();
const busy = new Set();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tag === 'button') node.type = 'button';
  return node;
}

function bridge() {
  return window.scalemaxAPI?.mcp || null;
}

function setStatus(message) {
  const node = byId('mcp-status');
  if (node) node.textContent = message;
}

/** Parses KEY=value (env) or Name: value (headers) lines; returns { values } or { error }. */
export function parsePairs(text, kind) {
  const pattern = kind === 'env' ? ENV_LINE : HEADER_LINE;
  const values = {};
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const match = pattern.exec(line);
    if (!match) {
      return { error: kind === 'env'
        ? `Line ${index + 1}: use KEY=value for environment variables.`
        : `Line ${index + 1}: use Name: value for headers.` };
    }
    values[match[1]] = match[2];
  }
  return { values, count: lines.length };
}

function commandLine(server) {
  if (server.transport === 'http') return server.url || '';
  return [server.command, ...(server.args || [])].filter(Boolean).join(' ');
}

function statusText(server) {
  if (busy.has(server.id)) return 'Connecting…';
  if (server.lastStatus === 'ok') return `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}${server.connected ? ' · connected' : ''}`;
  if (server.lastStatus === 'error') return server.lastError || 'Connection failed';
  return 'Not tested yet';
}

function dotClass(server) {
  if (busy.has(server.id)) return 'pending';
  if (server.lastStatus === 'ok') return 'ok';
  if (server.lastStatus === 'error') return 'fail';
  return '';
}

function renderToolList(server) {
  const tools = toolCache.get(server.id);
  const list = element('ul', 'mcp-tools');
  list.setAttribute('aria-label', `${server.name} tools`);
  if (!tools) {
    list.append(element('li', 'mcp-tool-empty', 'Test the server to load its tools.'));
    return list;
  }
  if (!tools.length) {
    list.append(element('li', 'mcp-tool-empty', 'This server offers no tools.'));
    return list;
  }
  for (const tool of tools) {
    const item = element('li', 'mcp-tool');
    const head = element('div', 'mcp-tool-head');
    head.append(element('code', 'mcp-tool-name', tool.name));
    if (tool.readOnly) head.append(element('span', 'badge', 'read-only'));
    item.append(head);
    if (tool.description) item.append(element('p', 'mcp-tool-desc', tool.description));
    list.append(item);
  }
  return list;
}

function renderServers() {
  const host = byId('mcp-list');
  if (!host) return;
  if (!servers.length) {
    host.replaceChildren(element('p', 'empty-state', 'No MCP servers yet. Add a local command (stdio) or a remote Streamable HTTP endpoint.'));
    return;
  }
  host.replaceChildren(...servers.map((server) => {
    const card = element('div', 'mcp-server');
    card.dataset.mcpId = server.id;
    const head = element('div', 'mcp-server-head');
    const title = element('div', 'mcp-server-title');
    title.append(element('strong', 'mcp-server-name', server.name),
      element('span', 'badge', server.transport === 'http' ? 'HTTP' : 'stdio'));
    if (server.serverInfo?.name) title.append(element('span', 'mcp-server-info', `${server.serverInfo.name} ${server.serverInfo.version || ''}`.trim()));
    const toggle = element('button', 'mcp-toggle', server.enabled ? 'In chat' : 'Off');
    toggle.dataset.mcpAction = 'toggle';
    toggle.setAttribute('aria-pressed', String(server.enabled));
    toggle.setAttribute('aria-label', `${server.enabled ? 'Stop offering' : 'Offer'} ${server.name} tools in chat`);
    head.append(title, toggle);
    const command = element('code', 'mcp-server-command', commandLine(server));
    command.title = commandLine(server);
    const status = element('div', 'mcp-server-status');
    status.append(element('span', `status-dot ${dotClass(server)}`), element('span', 'mcp-status-text', statusText(server)));
    if (server.envKeys?.length || server.headerKeys?.length) {
      const keys = [...(server.envKeys || []), ...(server.headerKeys || [])];
      status.append(element('span', 'mcp-secret-keys', `Secrets: ${keys.join(', ')}${server.secretStorage === 'session' ? ' (this session only)' : ''}`));
    }
    const actions = element('div', 'mcp-server-actions');
    for (const [action, label] of [['test', 'Test'], ['tools', expanded.has(server.id) ? 'Hide tools' : 'Tools'], ['edit', 'Edit'], ['remove', 'Remove']]) {
      const button = element('button', `button ${action === 'remove' ? 'danger' : 'secondary'} compact`, label);
      button.dataset.mcpAction = action;
      button.disabled = busy.has(server.id) && action !== 'tools';
      if (action === 'tools') button.setAttribute('aria-expanded', String(expanded.has(server.id)));
      actions.append(button);
    }
    card.append(head, command, status, actions);
    if (expanded.has(server.id)) card.append(renderToolList(server));
    return card;
  }));
}

async function refreshServers(app) {
  const api = bridge();
  if (!api?.list) {
    servers = [];
    const host = byId('mcp-list');
    if (host) host.replaceChildren(element('p', 'empty-state', 'MCP servers require the desktop app.'));
    return;
  }
  const result = await api.list();
  if (!result?.ok) { app.showToast(result?.error?.message || 'MCP servers could not be loaded'); return; }
  servers = Array.isArray(result.data) ? result.data : [];
  for (const id of [...toolCache.keys()]) if (!servers.some((server) => server.id === id)) toolCache.delete(id);
  renderServers();
}

async function testServer(app, id, { quiet = false } = {}) {
  const api = bridge();
  if (!api?.test) return null;
  busy.add(id);
  renderServers();
  let result;
  try {
    result = await api.test({ id });
  } finally {
    busy.delete(id);
  }
  if (result?.ok) toolCache.set(id, result.data.tools || []);
  await refreshServers(app);
  const server = servers.find((item) => item.id === id);
  if (!quiet) {
    app.showToast(result?.ok
      ? `${server?.name || 'Server'}: ${result.data.tools.length} tool${result.data.tools.length === 1 ? '' : 's'} available`
      : `${server?.name || 'Server'}: ${result?.error?.message || 'connection failed'}`);
  }
  return result;
}

function syncTransportFields() {
  const transport = byId('mcp-transport')?.value === 'http' ? 'http' : 'stdio';
  for (const node of document.querySelectorAll('#mcp-form [data-mcp-field]')) {
    node.hidden = node.dataset.mcpField !== transport;
  }
}

function openDialog(server = null) {
  const dialog = byId('mcp-dialog');
  if (!dialog) return;
  const set = (id, value) => { const node = byId(id); if (node) node.value = value; };
  set('mcp-edit-id', server?.id || '');
  set('mcp-name', server?.name || '');
  set('mcp-transport', server?.transport || 'stdio');
  set('mcp-command', server?.command || '');
  set('mcp-args', (server?.args || []).join('\n'));
  set('mcp-cwd', server?.cwd || '');
  set('mcp-env', '');
  set('mcp-url', server?.url || '');
  set('mcp-headers', '');
  const enabled = byId('mcp-enabled');
  if (enabled) enabled.checked = server ? server.enabled : true;
  const keepHint = (keys) => (keys?.length ? `Stored: ${keys.join(', ')}. Leave blank to keep them; entering any lines replaces them all.` : '');
  const envHint = byId('mcp-env-hint');
  if (envHint) envHint.textContent = keepHint(server?.envKeys);
  const headersHint = byId('mcp-headers-hint');
  if (headersHint) headersHint.textContent = keepHint(server?.headerKeys);
  const title = byId('mcp-dialog-title');
  if (title) title.textContent = server ? `Edit ${server.name}` : 'Add MCP server';
  const remove = byId('mcp-remove');
  if (remove) remove.hidden = !server;
  setStatus('');
  syncTransportFields();
  if (!dialog.open) dialog.showModal();
  byId('mcp-name')?.focus();
}

// Builds the save payload from the form; returns { input } or { error }.
function readForm() {
  const value = (id) => byId(id)?.value ?? '';
  const transport = value('mcp-transport') === 'http' ? 'http' : 'stdio';
  const input = {
    name: value('mcp-name').trim(),
    transport,
    enabled: Boolean(byId('mcp-enabled')?.checked),
  };
  const editId = value('mcp-edit-id');
  if (editId) input.id = editId;
  if (!input.name) return { error: 'Enter a name for the server.' };
  if (transport === 'stdio') {
    input.command = value('mcp-command').trim();
    if (!input.command) return { error: 'Enter the command that starts the server.' };
    input.args = value('mcp-args').split('\n').map((line) => line.trim()).filter(Boolean);
    const cwd = value('mcp-cwd').trim();
    if (cwd) input.cwd = cwd;
    const env = parsePairs(value('mcp-env'), 'env');
    if (env.error) return { error: env.error };
    // Blank keeps what is stored; any lines replace it.
    if (env.count) input.env = env.values;
  } else {
    input.url = value('mcp-url').trim();
    if (!input.url) return { error: 'Enter the server URL.' };
    const headers = parsePairs(value('mcp-headers'), 'headers');
    if (headers.error) return { error: headers.error };
    if (headers.count) input.headers = headers.values;
  }
  return { input };
}

async function saveServer(app, event) {
  event.preventDefault();
  const api = bridge();
  if (!api?.save) { setStatus('MCP servers require the desktop app.'); return; }
  const { input, error } = readForm();
  if (error) { setStatus(error); return; }
  const existing = input.id ? servers.find((server) => server.id === input.id) : null;
  const commandChanged = input.transport === 'stdio'
    && (!existing || existing.command !== input.command || (existing.args || []).join('\n') !== input.args.join('\n'));
  if (commandChanged && !window.confirm(`ScaleMax will run this command on your Mac:\n\n${[input.command, ...input.args].join(' ')}\n\nContinue?`)) {
    setStatus('Not saved.');
    return;
  }
  const button = byId('mcp-save');
  if (button) button.disabled = true;
  setStatus('Saving…');
  try {
    const saved = await api.save(input);
    if (!saved?.ok) { setStatus(saved?.error?.message || 'The server could not be saved.'); return; }
    toolCache.delete(saved.data.id);
    await refreshServers(app);
    setStatus('Saved. Connecting to list its tools…');
    const tested = await testServer(app, saved.data.id, { quiet: true });
    if (tested?.ok) {
      const count = tested.data.tools.length;
      expanded.add(saved.data.id);
      renderServers();
      byId('mcp-dialog')?.close();
      app.showToast(`${saved.data.name}: ${count} tool${count === 1 ? '' : 's'} available`);
    } else {
      setStatus(`Saved, but the connection failed: ${tested?.error?.message || 'unknown error'}`);
    }
  } finally {
    if (button) button.disabled = false;
  }
}

async function removeServer(app, server) {
  const api = bridge();
  if (!api?.remove || !server) return false;
  if (!window.confirm(`Remove the MCP server "${server.name}"? Its stored secrets are deleted too.`)) return false;
  const result = await api.remove({ id: server.id });
  if (!result?.ok) { app.showToast(result?.error?.message || 'The server could not be removed'); return false; }
  toolCache.delete(server.id);
  expanded.delete(server.id);
  await refreshServers(app);
  app.showToast(`${server.name} removed`);
  return true;
}

async function toggleServer(app, server) {
  const api = bridge();
  if (!api?.save) return;
  // save() needs the full record; env/header values are omitted so they are kept.
  const input = { id: server.id, name: server.name, transport: server.transport, enabled: !server.enabled };
  if (server.transport === 'stdio') {
    input.command = server.command;
    input.args = server.args || [];
    if (server.cwd) input.cwd = server.cwd;
  } else {
    input.url = server.url;
  }
  const result = await api.save(input);
  if (!result?.ok) { app.showToast(result?.error?.message || 'Could not update the server'); return; }
  await refreshServers(app);
  app.showToast(`${server.name}: ${input.enabled ? 'tools offered in chat' : 'not used in chat'}`);
}

async function handleListClick(app, event) {
  const button = event.target.closest('button[data-mcp-action]');
  const card = button?.closest('.mcp-server');
  const server = servers.find((item) => item.id === card?.dataset.mcpId);
  if (!server) return;
  const action = button.dataset.mcpAction;
  if (action === 'test') await testServer(app, server.id);
  else if (action === 'toggle') await toggleServer(app, server);
  else if (action === 'edit') openDialog(server);
  else if (action === 'remove') await removeServer(app, server);
  else if (action === 'tools') {
    if (expanded.has(server.id)) expanded.delete(server.id);
    else {
      expanded.add(server.id);
      if (!toolCache.has(server.id)) {
        renderServers();
        await testServer(app, server.id, { quiet: true });
      }
    }
    renderServers();
  }
}

export function bindMcpUi(app) {
  const dialog = byId('mcp-dialog');
  byId('mcp-add-btn')?.addEventListener('click', () => {
    if (!bridge()) { app.showToast('MCP servers require the desktop app'); return; }
    openDialog(null);
  });
  byId('mcp-transport')?.addEventListener('change', syncTransportFields);
  byId('mcp-form')?.addEventListener('submit', (event) => void saveServer(app, event));
  const close = () => { if (dialog?.open) dialog.close(); };
  byId('mcp-close')?.addEventListener('click', close);
  byId('mcp-cancel')?.addEventListener('click', close);
  byId('mcp-remove')?.addEventListener('click', async () => {
    const server = servers.find((item) => item.id === byId('mcp-edit-id')?.value);
    if (await removeServer(app, server)) close();
  });
  byId('mcp-list')?.addEventListener('click', (event) => void handleListClick(app, event));
  void refreshServers(app);
}
