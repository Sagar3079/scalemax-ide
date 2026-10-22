/**
 * ScaleMax IDE: manage MCP servers (presets, add by URL, add, edit, test, enable for chat, remove),
 * and show what an expanded server offers: its tools, resources and prompts (a prompt can be
 * filled in and put into the message box).
 */
import { MCP_PRESETS, PRESET_GROUPS, presetCommand, presetServer } from './mcp-presets.js';

const byId = (id) => document.getElementById(id);
// Presets being added right now: id -> status text shown on the tile ("Waiting for browser…").
const presetBusy = new Map();
const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const HEADER_LINE = /^([A-Za-z0-9-]+)\s*:\s*(.*)$/;

let servers = [];
// Tool summaries from the last successful test or listing, keyed by server id.
const toolCache = new Map();
const expanded = new Set();
const busy = new Set();
// Resources, URI templates and prompts of expanded servers, keyed by server id
// ({ resources, templates, prompts, error }), and the servers whose listing is on its way.
const extrasCache = new Map();
const extrasLoading = new Set();
// What the user typed into a prompt's argument fields, so a redraw of the list keeps it.
const promptValues = new Map();
const promptKey = (serverId, prompt, argument) => `${serverId}\u0000${prompt}\u0000${argument}`;
// Shared with the connector cards (src/catalog-ui.js), which show one-click sign-ins.
const MCP_CHANGED = 'scalemax:mcp-changed';

function announceChange() {
  window.dispatchEvent(new CustomEvent(MCP_CHANGED, { detail: { source: 'mcp' } }));
}

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
  if (server.signInPending) return 'Waiting for the sign-in in your browser…';
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

function renderResourceItem(entry, uri, template) {
  const item = element('li', 'mcp-tool');
  const head = element('div', 'mcp-tool-head');
  head.append(element('code', 'mcp-tool-name', entry.title || entry.name));
  if (template) head.append(element('span', 'badge', 'template'));
  if (entry.mimeType) head.append(element('span', 'badge', entry.mimeType));
  item.append(head, element('p', 'mcp-resource-uri', uri));
  if (entry.description) item.append(element('p', 'mcp-tool-desc', entry.description));
  return item;
}

function renderPromptItem(server, prompt) {
  const item = element('li', 'mcp-tool');
  item.dataset.promptName = prompt.name;
  const head = element('div', 'mcp-tool-head');
  head.append(element('code', 'mcp-tool-name', prompt.name));
  if (prompt.title && prompt.title !== prompt.name) head.append(element('span', 'mcp-tool-desc', prompt.title));
  item.append(head);
  if (prompt.description) item.append(element('p', 'mcp-tool-desc', prompt.description));
  if (prompt.arguments.length) {
    const fields = element('div', 'mcp-prompt-args');
    for (const argument of prompt.arguments) {
      const label = element('label', 'mcp-prompt-arg');
      label.append(element('span', '', `${argument.name}${argument.required ? ' (required)' : ''}`));
      const input = element('input');
      input.type = 'text';
      input.dataset.promptArg = argument.name;
      input.value = promptValues.get(promptKey(server.id, prompt.name, argument.name)) || '';
      input.placeholder = argument.description || argument.name;
      input.required = argument.required;
      label.append(input);
      fields.append(label);
    }
    item.append(fields);
  }
  const insert = element('button', 'button secondary compact', 'Insert into message');
  insert.dataset.mcpAction = 'prompt';
  insert.setAttribute('aria-label', `Insert the ${prompt.title || prompt.name} prompt of ${server.name} into the message box`);
  item.append(insert);
  return item;
}

// What a server offers besides tools, under its tool list.
function renderExtras(server) {
  if (extrasLoading.has(server.id)) return [element('p', 'mcp-tool-empty mcp-extras-note', 'Loading resources and prompts…')];
  const extras = extrasCache.get(server.id);
  if (!extras) return [];
  const nodes = [];
  if (extras.error) nodes.push(element('p', 'mcp-tool-empty mcp-extras-note', `Resources and prompts: ${extras.error}`));
  if (extras.resources.length || extras.templates.length) {
    const list = element('ul', 'mcp-tools mcp-resources');
    list.setAttribute('aria-label', `${server.name} resources`);
    list.append(...extras.resources.map((entry) => renderResourceItem(entry, entry.uri, false)),
      ...extras.templates.map((entry) => renderResourceItem(entry, entry.uriTemplate, true)));
    nodes.push(element('h4', 'mcp-extras-title', 'Resources'), list);
  }
  if (extras.prompts.length) {
    const list = element('ul', 'mcp-tools mcp-prompts');
    list.setAttribute('aria-label', `${server.name} prompts`);
    list.append(...extras.prompts.map((prompt) => renderPromptItem(server, prompt)));
    nodes.push(element('h4', 'mcp-extras-title', 'Prompts'), list);
  }
  if (!nodes.length) nodes.push(element('p', 'mcp-tool-empty mcp-extras-note', 'This server offers no resources or prompts.'));
  return nodes;
}

// Lists an expanded server's resources and prompts (once per connection test).
async function loadExtras(id) {
  const api = bridge();
  if (!api?.resources || !api?.prompts || extrasLoading.has(id)) return;
  extrasLoading.add(id);
  renderServers();
  try {
    const [resources, prompts] = await Promise.all([api.resources({ id }), api.prompts({ id })]);
    extrasCache.set(id, {
      resources: resources?.ok && Array.isArray(resources.data?.resources) ? resources.data.resources : [],
      templates: resources?.ok && Array.isArray(resources.data?.templates) ? resources.data.templates : [],
      prompts: prompts?.ok && Array.isArray(prompts.data) ? prompts.data : [],
      error: (!resources?.ok && resources?.error?.message) || (!prompts?.ok && prompts?.error?.message) || '',
    });
  } finally {
    extrasLoading.delete(id);
  }
  renderServers();
}

// Like the specs dialog's buttons: the message box is seeded, never over a draft, and the user
// reads (and can change) the prompt before sending it.
function seedComposer(app, text) {
  const input = byId('chat-input');
  if (!input) return false;
  app.switchView?.('chat');
  input.focus();
  if (input.value.trim()) {
    app.showToast('Send or clear what you have typed first');
    return false;
  }
  input.value = text;
  input.setSelectionRange(input.value.length, input.value.length);
  app.updateSendEnabled?.();
  return true;
}

async function insertPrompt(app, server, button) {
  const api = bridge();
  const item = button.closest('[data-prompt-name]');
  const prompt = extrasCache.get(server.id)?.prompts.find((entry) => entry.name === item?.dataset.promptName);
  if (!api?.getPrompt || !prompt) return;
  const fields = [...item.querySelectorAll('input[data-prompt-arg]')];
  const args = {};
  for (const field of fields) if (field.value.trim()) args[field.dataset.promptArg] = field.value;
  const missing = prompt.arguments.filter((argument) => argument.required && !args[argument.name]);
  if (missing.length) {
    app.showToast(`Fill in ${missing.map((argument) => argument.name).join(', ')} first`);
    fields.find((field) => field.dataset.promptArg === missing[0].name)?.focus();
    return;
  }
  button.disabled = true;
  let result;
  try {
    result = await api.getPrompt({ id: server.id, name: prompt.name, arguments: args });
  } finally {
    button.disabled = false;
  }
  if (!result?.ok) { app.showToast(`${server.name}: ${result?.error?.message || 'the prompt could not be filled in'}`); return; }
  if (!result.data?.text) { app.showToast(`${server.name}: this prompt has no text`); return; }
  if (seedComposer(app, result.data.text)) app.showToast(`${prompt.title || prompt.name} is in the message box. Read it, then send it.`);
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
    if (server.auth) {
      status.append(element('span', 'mcp-secret-keys',
        `Signed in via ${server.auth.issuer}${server.auth.storage === 'session' ? ' (this session only)' : ''}`));
    }
    // Whether its "only reads" labels count (lib/mcp.cjs trustReadOnly).
    status.append(element('span', 'mcp-secret-keys', server.trustReadOnly ? 'Read-only labels trusted' : 'Read-only labels not trusted'));
    const actions = element('div', 'mcp-server-actions');
    const buttons = [['test', 'Test'], ['tools', expanded.has(server.id) ? 'Hide tools' : 'Tools']];
    if (server.signInPending) buttons.push(['cancelsignin', 'Cancel sign-in']);
    else if (server.transport === 'http' && server.url?.startsWith('https://')) {
      buttons.push(['signin', server.auth ? 'Sign in again' : 'Sign in']);
    }
    buttons.push(['edit', 'Edit'], ['remove', 'Remove']);
    for (const [action, label] of buttons) {
      const button = element('button', `button ${action === 'remove' ? 'danger' : 'secondary'} compact`, label);
      button.dataset.mcpAction = action;
      button.disabled = busy.has(server.id) && action !== 'tools' && action !== 'cancelsignin';
      if (action === 'tools') button.setAttribute('aria-expanded', String(expanded.has(server.id)));
      actions.append(button);
    }
    card.append(head, command, status, actions);
    if (expanded.has(server.id)) card.append(renderToolList(server), ...renderExtras(server));
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
  for (const id of [...extrasCache.keys()]) if (!servers.some((server) => server.id === id)) extrasCache.delete(id);
  renderServers();
  renderPresets();
}

// ---- Presets and add-by-URL ------------------------------------------------------------

function renderPresets() {
  const host = byId('mcp-presets');
  if (!host) return;
  host.replaceChildren(...PRESET_GROUPS.map(([group, title, hint]) => {
    const section = element('section', 'mcp-preset-group');
    section.setAttribute('aria-label', title);
    const head = element('div', 'mcp-preset-group-head');
    head.append(element('h3', 'mcp-subtitle', title), element('span', 'status-text', hint));
    const grid = element('div', 'mcp-preset-grid');
    for (const preset of MCP_PRESETS.filter((item) => item.group === group)) {
      const added = presetServer(preset, servers);
      const pending = presetBusy.get(preset.id);
      // A tile counts as added once its server is saved and nothing is still in progress.
      const tile = element('div', `mcp-preset${added && !pending ? ' is-added' : ''}`);
      tile.dataset.presetId = preset.id;
      const text = element('div', 'mcp-preset-text');
      text.append(element('strong', 'mcp-preset-name', preset.name), element('span', 'mcp-preset-desc', preset.description));
      const action = element('div', 'mcp-preset-action');
      if (pending) {
        action.append(element('span', 'mcp-preset-status', pending));
        if (preset.via === 'directory' || preset.via === 'cli' || preset.via === 'url') {
          const cancel = element('button', 'button secondary compact', 'Cancel');
          cancel.dataset.presetCancel = preset.id;
          action.append(cancel);
        }
      } else if (added) {
        const state = added.lastStatus === 'ok' ? `Added · ${added.toolCount} tool${added.toolCount === 1 ? '' : 's'}`
          : (added.lastStatus === 'error' ? 'Added · connection failed' : 'Added');
        action.append(element('span', `mcp-preset-status${added.lastStatus === 'error' ? ' is-error' : ''}`, state));
      } else {
        const label = group === 'signin' ? 'Sign in' : 'Add';
        const button = element('button', `button ${group === 'signin' ? 'primary' : 'secondary'} compact`, label);
        button.dataset.presetAdd = preset.id;
        button.setAttribute('aria-label', `${label}: ${preset.name}`);
        action.append(button);
      }
      tile.append(text, action);
      grid.append(tile);
    }
    section.append(head, grid);
    return section;
  }));
}

function setPresetBusy(id, text) {
  if (text) presetBusy.set(id, text);
  else presetBusy.delete(id);
  renderPresets();
}

function toolsToast(app, name, tools) {
  app.showToast(`${name}: ${tools} tool${tools === 1 ? '' : 's'} available in chat`);
}

// A remote server by URL: save, connect, and sign in when the server asks for it.
async function addRemote(app, { name, url, presetId = null }) {
  const api = bridge();
  const saved = await api.save({ name, transport: 'http', url, enabled: true });
  if (!saved?.ok) { app.showToast(saved?.error?.message || 'The server could not be added'); return false; }
  await refreshServers(app);
  const tested = await testServer(app, saved.data.id, { quiet: true });
  if (tested?.ok) {
    toolsToast(app, saved.data.name, tested.data.tools.length);
  } else if (tested?.error?.code === 'MCP_AUTH_REQUIRED' && api.signIn) {
    if (presetId) setPresetBusy(presetId, 'Waiting for browser…');
    app.showToast(`${saved.data.name} needs sign-in. Approve access in your browser…`);
    await signInServer(app, saved.data.id);
  } else {
    app.showToast(`${saved.data.name}: added, but connecting failed: ${tested?.error?.message || 'unknown error'}`);
  }
  announceChange();
  return true;
}

async function addPreset(app, preset) {
  const api = bridge();
  if (!api?.save) { app.showToast('MCP servers require the desktop app'); return; }
  try {
    if (preset.via === 'directory') {
      setPresetBusy(preset.id, 'Waiting for browser…');
      const result = await api.signIn({ connectorId: preset.connectorId });
      await refreshServers(app);
      announceChange();
      if (!result?.ok) {
        if (result?.error?.code !== 'CANCELLED') app.showToast(`${preset.name}: ${result?.error?.message || 'sign-in failed'}`);
      } else if (result.data.lastStatus === 'ok') toolsToast(app, preset.name, result.data.toolCount);
      else app.showToast(`${preset.name}: signed in, but connecting failed: ${result.data.lastError || 'unknown error'}`);
      return;
    }
    if (preset.via === 'cli') {
      const connectors = window.scalemaxAPI?.connectors;
      if (!connectors?.cliConnect) { app.showToast('GitHub sign-in needs the desktop app'); return; }
      setPresetBusy(preset.id, 'Connecting…');
      const started = await connectors.cliConnect({ id: 'github' });
      if (!started?.ok) {
        if (started?.error?.code !== 'CANCELLED') app.showToast(`GitHub: ${started?.error?.message || 'sign-in failed'}`);
        return;
      }
      let done = started;
      if (started.data.status === 'code') {
        setPresetBusy(preset.id, `Enter code ${started.data.code} on GitHub`);
        app.showToast(`Enter code ${started.data.code} on the GitHub page in your browser${started.data.copied ? ' (copied)' : ''}`);
        done = await connectors.cliWait({ id: 'github' });
        if (!done?.ok) {
          if (done?.error?.code !== 'CANCELLED') app.showToast(`GitHub: ${done?.error?.message || 'sign-in failed'}`);
          return;
        }
      }
      await refreshServers(app);
      announceChange();
      if (done.data.mcpError) app.showToast(`GitHub connected. Chat tools are unavailable: ${done.data.mcpError}`);
      else toolsToast(app, 'GitHub', done.data.toolCount || 0);
      return;
    }
    if (preset.url) {
      setPresetBusy(preset.id, 'Connecting…');
      await addRemote(app, { name: preset.name, url: preset.url, presetId: preset.id });
      return;
    }
    // A local command: needs the workspace folder for some servers, and the user's OK to run it.
    let folder = '';
    if (preset.folder) {
      folder = app.workspace?.root || '';
      if (!folder) {
        app.showToast(`Choose the folder ${preset.name} may use`);
        await app.openWorkspace();
        folder = app.workspace?.root || '';
        if (!folder) return;
      }
    }
    const { command, args } = presetCommand(preset, folder);
    if (!window.confirm(`ScaleMax will run this command on your Mac:\n\n${[command, ...args].join(' ')}\n\nThe first start downloads the package. Continue?`)) return;
    setPresetBusy(preset.id, 'Starting…');
    const saved = await api.save({ name: preset.name, transport: 'stdio', command, args, enabled: true });
    if (!saved?.ok) { app.showToast(saved?.error?.message || 'The server could not be added'); return; }
    await refreshServers(app);
    const tested = await testServer(app, saved.data.id, { quiet: true });
    if (tested?.ok) toolsToast(app, preset.name, tested.data.tools.length);
    else {
      const message = tested?.error?.message || 'unknown error';
      const hint = /Command not found: (npx|uvx)/.test(message)
        ? ` Install ${/uvx/.test(message) ? 'uv (brew install uv)' : 'Node.js (brew install node)'} and choose Test.` : '';
      app.showToast(`${preset.name}: added, but it did not start: ${message}${hint}`);
    }
    announceChange();
  } finally {
    setPresetBusy(preset.id, null);
  }
}

function cancelPreset(preset) {
  if (preset.via === 'cli') void window.scalemaxAPI?.connectors?.cliCancel?.({ id: 'github' });
  else void bridge()?.cancelSignIn?.();
}

/** The name shown for a server added by URL: its host without "mcp."/"www." ("Notion"). */
export function nameFromUrl(value) {
  try {
    const host = new URL(value).hostname.replace(/^(www|mcp|api)\./, '');
    const base = host.split('.').slice(0, -1).join('.') || host;
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    return 'MCP server';
  }
}

async function addByUrl(app, event) {
  event.preventDefault();
  const input = byId('mcp-quick-url-input');
  const button = byId('mcp-quick-url-add');
  const url = input?.value.trim() || '';
  if (!url) { app.showToast('Paste the server URL first'); input?.focus(); return; }
  if (!/^https?:\/\//i.test(url)) { app.showToast('The URL must start with https://'); return; }
  const known = servers.find((server) => server.transport === 'http' && server.url?.replace(/\/+$/, '') === url.replace(/\/+$/, ''));
  if (known) { app.showToast(`${known.name} is already added`); return; }
  if (button) button.disabled = true;
  try {
    if (await addRemote(app, { name: nameFromUrl(url), url }) && input) input.value = '';
  } finally {
    if (button) button.disabled = false;
  }
}

function handlePresetClick(app, event) {
  const add = event.target.closest('[data-preset-add]');
  const cancel = event.target.closest('[data-preset-cancel]');
  const preset = MCP_PRESETS.find((item) => item.id === (add?.dataset.presetAdd || cancel?.dataset.presetCancel));
  if (!preset) return;
  if (cancel) cancelPreset(preset);
  else if (!presetBusy.has(preset.id)) void addPreset(app, preset);
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
  // A fresh connection: what it offers besides tools is listed again.
  extrasCache.delete(id);
  if (result?.ok && expanded.has(id)) void loadExtras(id);
  await refreshServers(app);
  const server = servers.find((item) => item.id === id);
  if (!quiet) {
    app.showToast(result?.ok
      ? `${server?.name || 'Server'}: ${result.data.tools.length} tool${result.data.tools.length === 1 ? '' : 's'} available`
      : `${server?.name || 'Server'}: ${result?.error?.message || 'connection failed'}`);
  }
  return result;
}

// Browser sign-in for a saved HTTP server (MCP authorization with automatic app registration).
async function signInServer(app, id) {
  const api = bridge();
  if (!api?.signIn) return null;
  busy.add(id);
  const pending = api.signIn({ id });
  // The list entry now reports signInPending.
  await refreshServers(app);
  let result;
  try {
    result = await pending;
  } finally {
    busy.delete(id);
  }
  if (result?.ok) toolCache.delete(id);
  await refreshServers(app);
  announceChange();
  const server = servers.find((item) => item.id === id);
  const name = server?.name || 'Server';
  if (!result?.ok) {
    if (result?.error?.code !== 'CANCELLED') app.showToast(`${name}: ${result?.error?.message || 'sign-in failed'}`);
  } else if (result.data.lastStatus === 'ok') {
    app.showToast(`${name}: signed in · ${result.data.toolCount} tool${result.data.toolCount === 1 ? '' : 's'} available`);
  } else {
    app.showToast(`${name}: signed in, but connecting failed: ${result.data.lastError || 'unknown error'}`);
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
  const trust = byId('mcp-trust');
  if (trust) trust.checked = server?.trustReadOnly === true;
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
    trustReadOnly: Boolean(byId('mcp-trust')?.checked),
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
      void loadExtras(saved.data.id);
      renderServers();
      byId('mcp-dialog')?.close();
      app.showToast(`${saved.data.name}: ${count} tool${count === 1 ? '' : 's'} available`);
    } else if (tested?.error?.code === 'MCP_AUTH_REQUIRED' && input.transport === 'http' && bridge()?.signIn) {
      // The server wants a sign-in: continue straight into the browser consent page.
      byId('mcp-dialog')?.close();
      app.showToast(`${saved.data.name} needs sign-in. Approve access in your browser…`);
      await signInServer(app, saved.data.id);
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
  announceChange();
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
  else if (action === 'signin') await signInServer(app, server.id);
  else if (action === 'cancelsignin') await bridge()?.cancelSignIn?.();
  else if (action === 'toggle') await toggleServer(app, server);
  else if (action === 'prompt') await insertPrompt(app, server, button);
  else if (action === 'edit') openDialog(server);
  else if (action === 'remove') await removeServer(app, server);
  else if (action === 'tools') {
    if (expanded.has(server.id)) expanded.delete(server.id);
    else {
      expanded.add(server.id);
      if (!toolCache.has(server.id)) {
        renderServers();
        await testServer(app, server.id, { quiet: true });
      } else if (!extrasCache.has(server.id)) {
        void loadExtras(server.id);
      }
    }
    renderServers();
  }
}

export function bindMcpUi(app) {
  const dialog = byId('mcp-dialog');
  byId('mcp-add-btn')?.addEventListener('click', () => {
    if (!bridge()?.save) { app.showToast('MCP servers require the desktop app'); return; }
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
  // Prompt arguments survive a redraw of the list.
  byId('mcp-list')?.addEventListener('input', (event) => {
    const field = event.target.closest?.('input[data-prompt-arg]');
    const prompt = field?.closest('[data-prompt-name]')?.dataset.promptName;
    const serverId = field?.closest('.mcp-server')?.dataset.mcpId;
    if (field && prompt && serverId) promptValues.set(promptKey(serverId, prompt, field.dataset.promptArg), field.value);
  });
  byId('mcp-presets')?.addEventListener('click', (event) => handlePresetClick(app, event));
  byId('mcp-quick-url')?.addEventListener('submit', (event) => void addByUrl(app, event));
  renderPresets();
  // One-click sign-ins from the connector cards add or remove servers here.
  window.addEventListener(MCP_CHANGED, (event) => {
    if (event.detail?.source !== 'mcp') void refreshServers(app);
  });
  void refreshServers(app);
}
