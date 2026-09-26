const { app, BrowserWindow, ipcMain, safeStorage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createProvider } = require('./lib/provider.cjs');
const { createConnectorStore } = require('./lib/connectors.cjs');
const { createWorkspace } = require('./lib/workspace.cjs');
const { createStore } = require('./lib/state.cjs');

// The automated smoke check must never read or write the real user data.
if (process.env.SCALEMAX_SMOKE === '1') {
  app.setPath('userData', path.join(os.tmpdir(), `scalemax-smoke-${process.pid}`));
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

  mainWindow.on('closed', () => {
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

const connectors = createConnectorStore({
  store: stateAdapter,
  safeStorage
});

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
      getPermission: () => {
        try {
          const permission = stateStore.get('settings')?.permission;
          return permission === 'readonly' || permission === 'plan' ? 'readonly' : 'ask';
        } catch {
          return 'ask';
        }
      }
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

// Provider and connector credentials are reserved: they are only reachable
// through the provider:*/connector:* channels, which return metadata and never
// the stored token. The legacy `user` record is unreachable for the same reason.
const RESERVED_STATE_KEYS = new Set(['provider', 'connectors', 'user']);

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
  'provider:send': (_event, input) => provider.send(input),
  'provider:cancel': (_event, id) => provider.cancel(id),
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

app.on('window-all-closed', () => {
  // macOS convention: keep the app running without windows.
  if (process.platform !== 'darwin') app.quit();
});
