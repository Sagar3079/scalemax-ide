const { app, BrowserWindow, ipcMain, safeStorage, dialog, shell, clipboard } = require('electron');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createProvider } = require('./lib/provider.cjs');
const { createConnectorStore } = require('./lib/connectors.cjs');
const { createWorkspace } = require('./lib/workspace.cjs');
const { createStore } = require('./lib/state.cjs');
const { createMcpManager } = require('./lib/mcp.cjs');
const { createToolLoop } = require('./lib/tool-loop.cjs');
const { createCliConnect } = require('./lib/cli-auth.cjs');

// The automated smoke check must never read or write the real user data.
if (process.env.SCALEMAX_SMOKE === '1') {
  // The smoke run deletes this profile; the next run sweeps any files Chromium
  // writes into it while shutting down (see build/smoke-check.cjs).
  app.setPath('userData', path.join(os.tmpdir(), `scalemax-smoke-${process.pid}`));
} else if (process.env.SCALEMAX_USER_DATA) {
  // Development and UI testing: run against a throwaway profile instead of the real one.
  app.setPath('userData', path.resolve(process.env.SCALEMAX_USER_DATA));
}

// ---------------------------------------------------------------------------
// Persistent state (atomic, validated key/value store)
// ---------------------------------------------------------------------------
const STATE_FILE = path.join(app.getPath('userData'), 'scalemax-state.json');

// lib/state.cjs expects the state directory to already exist.
fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

/**
 * Builds the atomic state store. An unreadable existing file is backed up
 * (never deleted) so recovery stays possible, then a fresh store is built.
 */
function buildStateStore() {
  try {
    return createStore(STATE_FILE, { io: fs });
  } catch (error) {
    const backup = `${STATE_FILE}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(STATE_FILE, backup);
      console.error(`[ScaleMax] State file was unreadable and was backed up to ${path.basename(backup)}:`, error.message);
    } catch (renameError) {
      console.error('[ScaleMax] Unreadable state file could not be backed up:', renameError.message);
    }
    return createStore(STATE_FILE, { io: fs });
  }
}

const stateStore = buildStateStore();

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 700,
    title: 'ScaleMax',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#fafafa',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // A reload or a crashed renderer can never answer a pending approval.
  mainWindow.webContents.on('did-start-loading', () => denyAllApprovals());
  mainWindow.webContents.on('render-process-gone', () => denyAllApprovals());

  mainWindow.on('closed', () => {
    denyAllApprovals();
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Provider client (OpenAI-compatible endpoints)
// ---------------------------------------------------------------------------
// lib/provider.cjs and lib/connectors.cjs need readAll/update so they can keep
// credentials in the same state file while never exposing them through the
// allowlisted store bridge.
const stateAdapter = {
  readAll: () => stateStore.readAll(),
  update: (mutator) => stateStore.update(mutator)
};

const provider = createProvider({
  store: stateAdapter,
  safeStorage,
  // Approval is always granted: endpoint and key changes never prompt a native
  // dialog. The SCALEMAX_SMOKE run uses this same path.
  approve: async () => true
});

// The main process owns every OAuth provider URL and rule (lib/oauth-catalog.cjs); the
// renderer only ever passes a connector id.
const connectors = createConnectorStore({
  store: stateAdapter,
  safeStorage,
  oauth: require('./lib/oauth.cjs'),
  oauthConfigs: require('./lib/oauth-catalog.cjs').OAUTH_PROVIDERS
});

// ---------------------------------------------------------------------------
// MCP servers and the chat tool loop
// ---------------------------------------------------------------------------
// Server configs live under the reserved `mcpServers` state key; env and header
// values are encrypted with safeStorage and never cross the bridge.
const mcp = createMcpManager({
  store: stateAdapter,
  safeStorage,
  clientInfo: { name: 'ScaleMax', version: app.getVersion() }
});

// Chat requests offer tools from enabled MCP servers to the model and run the
// tool calls it makes (lib/tool-loop.cjs); without tools it is a plain send.
// Tool calls that need the user's OK (Manual, and non-read-only tools in Basic) are sent to the
// window as `tool:approval-request`; the renderer answers through `tool:approval-respond`.
// A cancelled chat, a reload or a closed window denies whatever is still pending.
const APPROVAL_TIMEOUT_MS = 15 * 60_000;
const APPROVAL_DECISIONS = new Set(['once', 'request', 'deny']);
const pendingApprovals = new Map();

function mcpServerName(serverId) {
  try {
    return mcp.list().find((server) => server.id === serverId)?.name || serverId;
  } catch {
    return serverId;
  }
}

function requestToolApproval(request, { signal } = {}) {
  const target = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (!target) return Promise.resolve('deny');
  return new Promise((resolve) => {
    const approvalId = randomUUID();
    let timer = null;
    const finish = (decision, notify) => {
      if (!pendingApprovals.has(approvalId)) return;
      pendingApprovals.delete(approvalId);
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (notify && !target.isDestroyed()) target.send('tool:approval-closed', { approvalId });
      resolve(decision);
    };
    const onAbort = () => finish('deny', true);
    pendingApprovals.set(approvalId, { finish, webContentsId: target.id });
    timer = setTimeout(() => finish('deny', true), APPROVAL_TIMEOUT_MS);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    target.send('tool:approval-request', {
      approvalId,
      requestId: request.requestId,
      serverId: request.serverId,
      serverName: mcpServerName(request.serverId),
      toolName: request.toolName,
      readOnly: request.readOnly,
      arguments: request.arguments,
    });
  });
}

function denyAllApprovals() {
  for (const entry of [...pendingApprovals.values()]) entry.finish('deny', false);
}

const toolLoop = createToolLoop({ provider, mcp, approve: requestToolApproval });

// GitHub through the GitHub CLI (lib/cli-auth.cjs): reuses an existing `gh` login or runs gh's
// device-flow login in a throwaway config; the token lands in the connector store and on
// GitHub's MCP server, never in the renderer. The one-time code is copied for the user.
// When gh is missing it is downloaded (checksum + GitHub signature verified) into the app's own
// tools folder, so no admin rights or Homebrew are needed.
const cliConnect = createCliConnect({
  connectors,
  mcp,
  clipboard,
  toolsDir: path.join(app.getPath('userData'), 'tools'),
  // Development only: SCALEMAX_GH_SYSTEM=ignore pretends no system gh is installed, so the
  // download path can be tested on a Mac that has one. Ignored in packaged builds.
  // SCALEMAX_GH_HOME gives gh an empty home (no keychain login) to test the CLI login prompt.
  ...(!app.isPackaged && process.env.SCALEMAX_GH_SYSTEM === 'ignore'
    ? {
      locations: [],
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        ...(process.env.SCALEMAX_GH_HOME ? { HOME: path.resolve(process.env.SCALEMAX_GH_HOME) } : {})
      }
    }
    : {})
});

// Earlier permission values map onto the three modes; bypass never survives without consent.
const LEGACY_PERMISSIONS = { ask: 'basic', 'auto-write': 'basic', full: 'basic', readonly: 'manual', plan: 'manual' };

/** The chat permission mode (manual | basic | bypass) from the persisted assistant settings. */
function chatPermission() {
  try {
    const settings = stateStore.get('settings') || {};
    let mode = ['manual', 'basic', 'bypass'].includes(settings.permission)
      ? settings.permission : (LEGACY_PERMISSIONS[settings.permission] || 'basic');
    // Autonomous mode is only honoured when the user agreed to it in the consent dialog.
    if (mode === 'bypass' && settings.bypassConsent !== true) mode = 'basic';
    return mode;
  } catch {
    return 'manual';
  }
}

// ---------------------------------------------------------------------------
// Workspace service (project folder, file access, Git)
// ---------------------------------------------------------------------------
const MAX_FILE_BYTES = 1024 * 1024;
// Matches the workspace service's own listing cap; entries beyond it never exist.
const MAX_LISTED_ENTRIES = 1000;

// A single workspace service is created lazily and reused for the app's life.
// Approval is always granted because the app does not show native prompts.
let workspace = null;

function getWorkspace() {
  if (!workspace) {
    workspace = createWorkspace({
      approve: async () => true,
      // Read-only and plan modes block writes and commands in the workspace
      // service; every other mode is treated as 'ask'.
      // Saves and commands in the Workspace tab are the user's own actions; the chat permission
      // modes (manual / basic / bypass) govern the tool calls the model makes.
      getPermission: () => 'ask'
    });
  }
  return workspace;
}

/** Returns the workspace service, or fails clearly when no folder is open. */
function requireWorkspace() {
  const instance = getWorkspace();
  if (!instance.current()) throw bridgeError('NO_WORKSPACE', 'Open a folder first.');
  return instance;
}

/** Builds an Error carrying a stable code for the IPC error envelope. */
function bridgeError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Normalises lib/workspace.cjs list() entries to { path, name, type }.
 * The module lists one directory level at a time, so no depth is attached.
 * @param {Array<{name: string, path: string, type: string}>} entries
 * @returns {Array<{path: string, name: string, type: 'file'|'directory'}>}
 */
function normaliseEntries(entries) {
  return entries.slice(0, MAX_LISTED_ENTRIES).map((entry) => ({
    path: entry.path,
    name: entry.name,
    type: entry.type === 'directory' ? 'directory' : 'file'
  }));
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
ipcMain.handle('app:get-version', async () => app.getVersion());

ipcMain.handle('app:quit', async () => {
  app.quit();
});

// Provider, connector, OAuth client and MCP records are reserved: they are only
// reachable through the provider:*/connector:*/mcp:* channels, which return
// metadata and never a stored secret. The legacy `user` record is unreachable
// for the same reason. (lib/state.cjs also refuses every non-public key.)
const RESERVED_STATE_KEYS = new Set(['provider', 'connectors', 'connectorOAuthClients', 'mcpServers', 'user']);

ipcMain.handle('store:get', async (_event, key) => {
  if (typeof key !== 'string' || RESERVED_STATE_KEYS.has(key)) return undefined;
  try {
    return stateStore.get(key);
  } catch {
    return undefined;
  }
});

// The returned boolean tells the renderer whether the write was accepted, so
// it can fall back to localStorage when the allowlisted store rejects the key.
ipcMain.handle('store:set', async (_event, key, value) => {
  if (typeof key !== 'string' || RESERVED_STATE_KEYS.has(key)) return false;
  try {
    stateStore.set(key, value);
    return true;
  } catch {
    return false;
  }
});

// Every IPC channel resolves to { ok: true, data } or { ok: false, error } so
// the renderer never receives a raw stack trace across the bridge.
function wrap(run, fallback) {
  return async (event, ...args) => {
    try {
      return { ok: true, data: await run(event, ...args) };
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : fallback.code;
      const message = error instanceof Error && error.message
        ? error.message
        : fallback.message;
      return { ok: false, error: { code, message } };
    }
  };
}

const providerChannels = {
  'provider:get': () => provider.get(),
  'provider:save': (_event, input) => provider.save(input),
  'provider:test': () => provider.test(),
  'provider:discover': (_event, input) => provider.discover(input),
  // An unconfigured provider fails fast without starting any MCP server.
  // Progress (thinking / running a tool / waiting for approval) goes to the window that asked.
  'provider:send': (event, input) => (provider.get().configured
    ? toolLoop.send(input, {
      permission: chatPermission(),
      onProgress: (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('provider:progress', progress);
      }
    })
    : provider.send(input)),
  'provider:cancel': (_event, id) => toolLoop.cancel(id),
  'provider:set-model': (_event, input) => provider.setModel(input),
  'provider:refresh-models': () => provider.refreshModels(),
  'provider:clear': () => provider.clear()
};

for (const [channel, run] of Object.entries(providerChannels)) {
  ipcMain.handle(channel, wrap(run, { code: 'PROVIDER_ERROR', message: 'Provider request failed.' }));
}

// Connector tokens are only reachable through these channels, which return
// sanitized metadata and bounded provider data, never the token itself.
const CONNECTOR_FALLBACK = { code: 'CONNECTOR_ERROR', message: 'Connector request failed.' };

const connectorChannels = {
  'connector:list': () => connectors.list(),
  'connector:save': (_event, input) => connectors.save(input),
  'connector:remove': (_event, input) => connectors.remove(input),
  'connector:test': (_event, input) => connectors.test(input),
  'connector:fetch': (_event, input) => connectors.fetch(input)
};

for (const [channel, run] of Object.entries(connectorChannels)) {
  ipcMain.handle(channel, wrap(run, CONNECTOR_FALLBACK));
}

// OAuth channels. The client secret is written here and never read back: the
// renderer only ever sees whether one is stored. Access and refresh tokens never
// cross the bridge, and lib/connectors.cjs only lets https sign-in pages reach
// shell.openExternal.
const oauthChannels = {
  'connector:oauth-config-save': (_event, input) => connectors.saveOAuthConfig(input),
  'connector:oauth-config-get': (_event, input) => connectors.getOAuthConfig(input),
  'connector:oauth-start': (_event, input) => connectors.startOAuth(input, {
    openExternal: (url) => shell.openExternal(url)
  }),
  'connector:oauth-status': (_event, input) => connectors.oauthStatus(input),
  'connector:oauth-disconnect': (_event, input) => connectors.disconnectOAuth(input),
  // CLI sign-in: only the fixed https://github.com/login/device page is ever opened.
  'connector:cli-available': () => cliConnect.available(),
  'connector:cli-start': (_event, input) => cliConnect.start(input, {
    openExternal: (url) => shell.openExternal(url)
  }),
  'connector:cli-wait': (_event, input) => cliConnect.wait(input),
  'connector:cli-status': (_event, input) => cliConnect.status(input),
  'connector:cli-cancel': (_event, input) => cliConnect.cancel(input)
};

for (const [channel, run] of Object.entries(oauthChannels)) {
  ipcMain.handle(channel, wrap(run, CONNECTOR_FALLBACK));
}

// MCP channels return sanitized server entries and tool summaries only; env and
// header values are write-only. Tools run inside chat through the tool loop.
const MCP_FALLBACK = { code: 'MCP_ERROR', message: 'MCP request failed.' };

const mcpChannels = {
  'mcp:list': () => mcp.list(),
  'mcp:save': (_event, input) => mcp.save(input),
  'mcp:remove': (_event, input) => mcp.remove(input),
  'mcp:test': (_event, input) => mcp.test(input),
  'mcp:tools': (_event, input) => mcp.listTools(input),
  // Zero-setup sign-in (MCP authorization + dynamic client registration). The renderer passes a
  // connector id (resolved by lib/mcp-directory.cjs) or a saved server id, never a URL; only
  // https consent pages reach shell.openExternal. Tokens never cross the bridge.
  'mcp:oauth-start': (_event, input) => mcp.startOAuth(input, {
    openExternal: (url) => shell.openExternal(url)
  }),
  'mcp:oauth-cancel': () => mcp.cancelOAuth()
};

for (const [channel, run] of Object.entries(mcpChannels)) {
  ipcMain.handle(channel, wrap(run, MCP_FALLBACK));
}

// The user's answer to a tool approval prompt: once | request (allow the rest of this reply) | deny.
// Only the window the prompt was sent to can answer it.
ipcMain.handle('tool:approval-respond', wrap((event, input) => {
  const approvalId = input && typeof input.approvalId === 'string' ? input.approvalId : '';
  const decision = input && APPROVAL_DECISIONS.has(input.decision) ? input.decision : null;
  const entry = pendingApprovals.get(approvalId);
  if (!entry || !decision || entry.webContentsId !== event.sender.id) return { accepted: false };
  entry.finish(decision, false);
  return { accepted: true };
}, { code: 'APPROVAL_ERROR', message: 'Approval could not be recorded.' }));

// ---------------------------------------------------------------------------
// Dialog + workspace IPC (native pickers, project files, Git status)
// ---------------------------------------------------------------------------
const DIALOG_FALLBACK = { code: 'DIALOG_ERROR', message: 'Dialog request failed.' };
const WORKSPACE_FALLBACK = { code: 'WORKSPACE_ERROR', message: 'Workspace request failed.' };

/** Opens a native picker, attached to the main window when one exists. */
function showOpenDialog(options) {
  return mainWindow
    ? dialog.showOpenDialog(mainWindow, options)
    : dialog.showOpenDialog(options);
}

ipcMain.handle('dialog:open-folder', wrap(async () => {
  const { canceled, filePaths } = await showOpenDialog({
    title: 'Open Folder',
    properties: ['openDirectory', 'createDirectory']
  });
  return { path: canceled || filePaths.length === 0 ? null : filePaths[0] };
}, DIALOG_FALLBACK));

ipcMain.handle('dialog:open-file', wrap(async () => {
  const { canceled, filePaths } = await showOpenDialog({
    title: 'Open File',
    properties: ['openFile']
  });
  if (canceled || filePaths.length === 0) return null;
  const filePath = filePaths[0];
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_FILE_BYTES) throw bridgeError('FILE_TOO_LARGE', 'Files must be at most 1 MiB.');
  const bytes = await fs.promises.readFile(filePath);
  if (bytes.length > MAX_FILE_BYTES) throw bridgeError('FILE_TOO_LARGE', 'Files must be at most 1 MiB.');
  if (bytes.includes(0)) throw bridgeError('BINARY_FILE', 'Binary files are not supported.');
  return { path: filePath, name: path.basename(filePath), content: bytes.toString('utf8') };
}, DIALOG_FALLBACK));

ipcMain.handle('workspace:select', wrap(async (_event, root) => {
  const instance = getWorkspace();
  const selected = await instance.select(root);
  const listing = await instance.list('');
  return { root: selected.path, files: normaliseEntries(listing.entries) };
}, WORKSPACE_FALLBACK));

// The root in the envelope always stays the project root; a relative path only
// changes which directory level is listed.
ipcMain.handle('workspace:list', wrap(async (_event, relative) => {
  const instance = requireWorkspace();
  const listing = await instance.list(typeof relative === 'string' && relative ? relative : '');
  return { root: instance.current().path, files: normaliseEntries(listing.entries) };
}, WORKSPACE_FALLBACK));

ipcMain.handle('workspace:read', wrap(
  (_event, relative) => requireWorkspace().read(relative),
  WORKSPACE_FALLBACK
));

ipcMain.handle('workspace:write', wrap(async (_event, input) => {
  const result = await requireWorkspace().write(input);
  return { path: result.path, revision: result.revision };
}, WORKSPACE_FALLBACK));

ipcMain.handle('workspace:git-status', wrap(
  () => requireWorkspace().gitStatus(),
  WORKSPACE_FALLBACK
));

ipcMain.handle('workspace:git-diff', wrap(async (_event, relative) => {
  const diff = await requireWorkspace().gitDiff(typeof relative === 'string' ? relative : '');
  return { diff };
}, WORKSPACE_FALLBACK));

ipcMain.handle('workspace:run', wrap(
  (_event, request) => requireWorkspace().run(request),
  WORKSPACE_FALLBACK
));

ipcMain.handle('workspace:cancel', wrap(
  () => requireWorkspace().cancel(),
  WORKSPACE_FALLBACK
));

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  // safeStorage is available for encrypting secrets at rest in future revisions.
  if (typeof safeStorage?.isEncryptionAvailable === 'function') {
    console.log(
      '[ScaleMax] safeStorage encryption available:',
      safeStorage.isEncryptionAvailable()
    );
  }

  createWindow();

  if (process.env.SCALEMAX_SMOKE === '1') {
    // Development-only renderer/IPC verification; see build/smoke-check.cjs.
    // build/ is excluded from packaged builds, so absence is not fatal.
    try {
      require('./build/smoke-check.cjs').run(mainWindow).then((code) => app.exit(code))
        .catch((error) => {
          console.error('[ScaleMax] Smoke check failed:', error);
          app.exit(1);
        });
    } catch (error) {
      console.error('[ScaleMax] Smoke check unavailable:', error.message);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  console.error('[ScaleMax] Startup failed:', error);
  app.exit(1);
});

// MCP stdio servers run in their own process groups; stop them with the app.
app.on('before-quit', () => {
  cliConnect.closeAll();
  void mcp.closeAll();
});

app.on('window-all-closed', () => {
  // macOS convention: keep the app running without windows.
  if (process.platform !== 'darwin') app.quit();
});
