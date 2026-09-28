const { app, BrowserWindow, Menu, ipcMain, safeStorage, dialog, shell, clipboard, protocol } = require('electron');
const { Readable } = require('stream');
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
const { createProgressForwarder } = require('./lib/progress.cjs');
const { createCheckpoints, validId: validCheckpointId } = require('./lib/checkpoints.cjs');
const { createWorkspaceTools, combineToolSources } = require('./lib/workspace-tools.cjs');
const { createWebTools } = require('./lib/web-tools.cjs');
const { createComputerTools } = require('./lib/computer-tools.cjs');
const { normalizeMode, modeFamilies, modeInstructions, modeMaxRounds } = require('./lib/modes.cjs');
const { collectNames, restoreNames, modelNames } = require('./lib/reply-names.cjs');
const { createProjectNotes, prepareChatRequest } = require('./lib/project-notes.cjs');
const { createCliConnect } = require('./lib/cli-auth.cjs');
const { createMediaStudio } = require('./lib/media.cjs');
const { applyBranding, ICON_PATH } = require('./lib/app-branding.cjs');
const { applyShellPath } = require('./lib/shell-path.cjs');

// Opened from the Finder or the Dock, the app gets macOS's minimal PATH; the user's login shell
// knows where npm, node, git, Python and friends live (lib/shell-path.cjs). Commands the user or
// the model runs wait for this (at most 5 seconds, once per start).
const shellPathReady = applyShellPath().catch(() => process.env.PATH);

// Generated images and videos are served to the renderer from the app's media folder through
// scalemax-media://<id>/ (registered before ready so <video> can stream and seek).
protocol.registerSchemesAsPrivileged([
  { scheme: 'scalemax-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

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
    // Windows and Linux window icon; macOS uses the bundle / Dock icon.
    icon: ICON_PATH,
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

  // Links in replies open in the browser (web and mail links only); the app window itself never
  // navigates away from the app or opens other windows.
  const webLink = (url) => /^(https?:|mailto:)/i.test(url);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (webLink(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (webLink(url)) void shell.openExternal(url);
  });

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

// Chat requests offer the built-in workspace tools (lib/workspace-tools.cjs: list, read, search,
// write files and run commands in the folder the user opened) and the tools of enabled MCP
// servers to the model, and run the tool calls it makes (lib/tool-loop.cjs); without any tools
// it is a plain send.
// Tool calls that need the user's OK (Manual, and non-read-only tools in Basic) are sent to the
// window as `tool:approval-request`; the renderer answers through `tool:approval-respond`.
// A cancelled chat, a reload or a closed window denies whatever is still pending.
const APPROVAL_TIMEOUT_MS = 15 * 60_000;
const APPROVAL_DECISIONS = new Set(['once', 'request', 'deny']);
const pendingApprovals = new Map();

function mcpServerName(serverId) {
  if (serverId === workspaceTools.SERVER_ID) return 'Workspace';
  if (serverId === webTools.SERVER_ID) return 'Web';
  if (serverId === computerTools.SERVER_ID) return 'Computer';
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
      kind: request.serverId === workspaceTools.SERVER_ID ? 'workspace'
        : request.serverId === webTools.SERVER_ID ? 'web'
          : request.serverId === computerTools.SERVER_ID ? 'computer' : 'mcp',
      toolName: request.toolName,
      readOnly: request.readOnly,
      arguments: request.arguments,
      // Several tasks can work at once, each in its own folder: the prompt says which.
      folderName: chatRequests.get(request.requestId)?.folderName || '',
    });
  });
}

function denyAllApprovals() {
  for (const entry of [...pendingApprovals.values()]) entry.finish('deny', false);
}

// Workspace tools on the Workspace tab's service (getWorkspace below): the folder open in the
// window. Chat replies get tools of their own, bound to their task's folder (openChatSession).
const workspaceTools = createWorkspaceTools({ getWorkspace: () => getWorkspace() });
// Web and computer tools belong to the mode the user picked above the message box: Working gets all
// three families, Coding the project and the web (lib/modes.cjs).
const webTools = createWebTools();
const computerTools = createComputerTools({ getWorkspace: () => getWorkspace(), clipboard, shell });
const BUILTIN_TOOLS = { workspace: workspaceTools, web: webTools, computer: computerTools };
const builtinsFor = (mode) => modeFamilies(mode).map((family) => BUILTIN_TOOLS[family]).filter(Boolean);
// The ScaleMax API replaces the word "kiro" in reply text with the model's name, which turned a
// folder called "kiro-scalemax-ide" into "DeepSeek V4 Flash-scalemax-ide" (lib/reply-names.cjs).
// Names the model was given in the request (folder, file paths, the user's words) are put back.
function replyNameRepair(names, model) {
  const config = provider.get();
  const entry = Array.isArray(config.models) ? config.models.find((item) => item.id === config.model) : null;
  const replacements = modelNames({ modelId: config.model, displayName: entry?.displayName, responseModel: model });
  return (text) => restoreNames(text, { names, replacements });
}
function restoreReplyText(text, sources, { model, folderName } = {}) {
  const folder = folderName || workspaceTools.folder()?.name;
  return replyNameRepair(collectNames(sources, folder ? [folder] : []), model)(text);
}
// The same repair for text while it streams in (lib/progress.cjs), from what the request says.
function streamingRepair(input, folderName) {
  const sources = [input?.systemPrompt, ...(Array.isArray(input?.messages) ? input.messages.map((message) => message?.content) : [])];
  const names = collectNames(sources, folderName ? [folderName] : []);
  return names.length ? replyNameRepair(names) : null;
}

const toolLoop = createToolLoop({
  provider,
  mcp: combineToolSources({ builtins: builtinsFor, mcp, serverName: mcpServerName }),
  approve: requestToolApproval,
  restoreText: restoreReplyText,
  // Coding work takes many steps (read, edit, run the tests, fix); Stop cancels at any point.
  maxRounds: 25
});

/**
 * Every chat request works in its task's folder through a workspace session of its own, so
 * several tasks can run at once in different folders, and opening another folder in the window
 * never pulls the files out from under a running reply.
 * The folder must be one the user opened in ScaleMax (the open one or a recent one); a request
 * for any other folder is refused (FOLDER_NOT_OPENED). A request without a folder (automations)
 * works in the folder that is open, if any.
 * Returns the session's tools, its project notes (.scalemax/SCALEMAX.md: created on the first
 * message in a folder that has none, and read, with AGENTS.md / CLAUDE.md / Kiro steering, into
 * every chat there) and dispose(), which ends the session and any command it still runs.
 */
// Folder sessions of replies in progress; quitting ends them and the commands they run.
const chatSessions = new Set();
// Chat requests in progress, by request id: whether Stop came before the tool loop started, and
// the folder the request works in (named in its approval prompts).
const chatRequests = new Map();
/** Refuses a folder the user never opened in ScaleMax (the open one or a recent one). */
function requireOpenedFolder(folder, what = 'This task works in') {
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || folder.length > 4096) {
    throw bridgeError('INVALID_FOLDER', 'The task folder must be an absolute path.');
  }
  if (workspaceTools.folder()?.path === folder || readFolders().recent.includes(folder)) return;
  const name = path.basename(folder) || folder;
  throw bridgeError('FOLDER_NOT_OPENED', `${what} "${name}", which has not been opened in ScaleMax. Open it with the folder button first.`);
}
async function openChatSession(input) {
  const expected = input && typeof input === 'object' && !Array.isArray(input) ? input.folder : undefined;
  await restoreFolder();
  let root = null;
  if (expected !== undefined && expected !== null) {
    requireOpenedFolder(expected);
    root = expected;
  } else {
    root = workspaceTools.folder()?.path || null;
  }
  const session = createWorkspace({ approve: async () => true, getPermission: () => 'ask' });
  if (root) {
    try {
      await session.select(root);
    } catch (error) {
      // A task's folder that is gone fails the request; a request without a folder (an
      // automation) runs without one when the open folder has gone away meanwhile.
      if (root === expected) {
        session.dispose();
        throw error;
      }
    }
  }
  chatSessions.add(session);
  const getSession = () => session;
  // What a task's reply changes is recorded as it happens (lib/checkpoints.cjs), so the window
  // can show it for review and undo, also when the reply is stopped part way. Requests without
  // a task folder (automations) have no window to show it in and are not recorded.
  const requestId = typeof input?.requestId === 'string' ? input.requestId : '';
  const recorder = root === expected && session.current()
    ? checkpoints.recorder({ requestId, folder: session.current() })
    : null;
  if (recorder) recordingIds.add(requestId);
  const chat = {
    folder: session.current(),
    // Hears the reply's changes after each one ({ id, folderName, files }, or null when all of
    // them were changed back).
    onChanges: null,
    changes: () => recorder?.summary() || null,
  };
  const onChange = recorder ? (change) => {
    try {
      recorder.record(change);
    } catch (error) {
      console.error('[ScaleMax] A change could not be recorded for undo:', error?.code || 'error');
      return;
    }
    if (typeof chat.onChanges === 'function') chat.onChanges(recorder.summary());
  } : null;
  const tools = createWorkspaceTools({ getWorkspace: getSession, onChange });
  const families = { workspace: tools, web: webTools, computer: createComputerTools({ getWorkspace: getSession, clipboard, shell }) };
  return Object.assign(chat, {
    tools,
    notes: createProjectNotes({ getWorkspace: getSession }),
    source: combineToolSources({
      builtins: (mode) => modeFamilies(mode).map((family) => families[family]).filter(Boolean),
      mcp,
      serverName: mcpServerName,
    }),
    dispose: () => {
      chatSessions.delete(session);
      session.dispose();
    },
    // After dispose: a save that was finishing when the reply stopped either completes and is
    // recorded, or stops before it changes the file. Then the recording is complete.
    settle: async () => {
      let timer = null;
      await Promise.race([session.idle(), new Promise((resolve) => { timer = setTimeout(resolve, 3000); })]);
      clearTimeout(timer);
      // The tool records the change right after the save returns.
      await new Promise((resolve) => setImmediate(resolve));
      recordingIds.delete(requestId);
    },
  });
}
// Replies whose changes are still being recorded: their checkpoints cannot be undone or kept yet.
const recordingIds = new Set();

// ---------------------------------------------------------------------------
// Checkpoints (lib/checkpoints.cjs): what every reply changed, for review and undo in the window.
// ---------------------------------------------------------------------------
const checkpoints = createCheckpoints({ dir: path.join(app.getPath('userData'), 'checkpoints') });
/** Runs `task` with a workspace session on the folder a checkpoint belongs to. */
async function withCheckpointFolder(id, task) {
  const folder = checkpoints.folderOf(id);
  await restoreFolder();
  requireOpenedFolder(folder.path, 'These changes are in');
  const session = createWorkspace({ approve: async () => true, getPermission: () => 'ask' });
  chatSessions.add(session);
  try {
    await session.select(folder.path);
    return await task(session, folder);
  } finally {
    chatSessions.delete(session);
    session.dispose();
  }
}
// Undo and keep change a reply's record: never while that reply still records, and an undo never
// while any reply works in the same folder (it may be reading or changing those files).
function requireSettled(id, folderPath = null) {
  if (recordingIds.has(id)) throw bridgeError('REPLY_RUNNING', 'This reply is still working. Wait for it to finish, or stop it first.');
  if (folderPath && [...chatRequests.values()].some((request) => request.folderPath === folderPath)) {
    throw bridgeError('FOLDER_BUSY', 'A reply is working in this folder. Wait for it to finish, or stop it, then undo.');
  }
}
// Operations on one checkpoint run one after another (two quick clicks never interleave).
const checkpointQueues = new Map();
function queueCheckpoint(id, task) {
  const previous = checkpointQueues.get(id) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  const tail = next.catch(() => {});
  checkpointQueues.set(id, tail);
  void tail.then(() => { if (checkpointQueues.get(id) === tail) checkpointQueues.delete(id); });
  return next;
}
function checkpointId(input) {
  const id = input && typeof input === 'object' ? input.id : undefined;
  if (!validCheckpointId(id)) throw bridgeError('INVALID_CHECKPOINT', 'That list of changes is not valid.');
  return id;
}
function checkpointPaths(input) {
  const paths = input && typeof input === 'object' ? input.paths : undefined;
  if (paths === undefined || paths === null) return null;
  if (!Array.isArray(paths) || paths.length > 500 || paths.some((item) => typeof item !== 'string' || item.length > 1024)) {
    throw bridgeError('INVALID_CHECKPOINT', 'Choose the changed files by their project paths.');
  }
  return paths;
}

function projectNotesEnabled() {
  try {
    return (stateStore.get('settings') || {}).projectNotes !== false;
  } catch {
    return true;
  }
}

// GitHub through the GitHub CLI (lib/cli-auth.cjs): reuses an existing `gh` login or runs gh's
// device-flow login in a throwaway config; the token lands in the connector store and on
// GitHub's MCP server, never in the renderer. The one-time code is copied for the user.
// When gh is missing it is downloaded (checksum + GitHub signature verified) into the app's own
// tools folder, so no admin rights or Homebrew are needed.
// Image and video generation (lib/media.cjs). Results live in <userData>/media and reach the
// renderer only through the scalemax-media: protocol below, never as file paths.
const mediaStudio = createMediaStudio({ provider, dir: path.join(app.getPath('userData'), 'media') });

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

// ---------------------------------------------------------------------------
// Remembered folders (main-only state key `workspaceFolders`): like other coding apps, the
// folder that was open is opened again at the next start, and recent folders are offered in the
// folder menu. { current: absolute path | null, recent: [absolute paths, newest first] }
// ---------------------------------------------------------------------------
const MAX_RECENT_FOLDERS = 8;

function readFolders() {
  try {
    const value = stateStore.readAll().workspaceFolders;
    const valid = (item) => typeof item === 'string' && item.length <= 4096 && path.isAbsolute(item);
    return {
      current: valid(value?.current) ? value.current : null,
      recent: Array.isArray(value?.recent) ? [...new Set(value.recent.filter(valid))].slice(0, MAX_RECENT_FOLDERS) : [],
    };
  } catch {
    return { current: null, recent: [] };
  }
}

function writeFolders(next) {
  try {
    stateStore.update((draft) => { draft.workspaceFolders = next; });
  } catch (error) {
    console.error('[ScaleMax] The open folder could not be remembered:', error.message);
  }
}

function rememberFolder(root) {
  const { recent } = readFolders();
  writeFolders({ current: root, recent: [root, ...recent.filter((item) => item !== root)].slice(0, MAX_RECENT_FOLDERS) });
}

function isDirectory(target) {
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
}

/** Recent folders that still exist, newest first (the open one included). */
function recentFolders() {
  return readFolders().recent.filter(isDirectory).map((item) => ({ name: path.basename(item), path: item }));
}

// Reopens the remembered folder once per app run. A folder that was moved or deleted is
// forgotten instead of failing every start.
let folderRestore = null;
function restoreFolder() {
  if (!folderRestore) {
    folderRestore = (async () => {
      const instance = getWorkspace();
      const { current, recent } = readFolders();
      if (instance.current() || !current) return;
      try {
        await instance.select(current);
      } catch {
        writeFolders({ current: null, recent: recent.filter((item) => item !== current) });
      }
    })();
  }
  return folderRestore;
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
const RESERVED_STATE_KEYS = new Set(['provider', 'providerProfiles', 'connectors', 'connectorOAuthClients', 'mcpServers', 'workspaceFolders', 'user']);

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
  // With a folder open the request carries the project context and may create the project
  // notes first; the reply then says so (projectNotes.created) so the window can show it.
  // The reply streams to the window as it is written (lib/progress.cjs gathers the pieces), with
  // every tool call as a step and a command's output as it runs.
  'provider:send': async (event, input) => {
    if (!provider.get().configured) return provider.send(input);
    // Known from the first moment, so Stop works while the folder session and the project
    // context are still being prepared (the tool loop only knows requests it already runs).
    const requestId = typeof input?.requestId === 'string' ? input.requestId : '';
    const tracked = { stopped: false, folderName: '', folderPath: '' };
    const owned = Boolean(requestId) && !chatRequests.has(requestId);
    if (owned) chatRequests.set(requestId, tracked);
    const checkStopped = () => {
      if (tracked.stopped) throw bridgeError('CANCELLED', 'Provider request was cancelled.');
    };
    let chat = null;
    try {
      await shellPathReady;
      checkStopped();
      chat = await openChatSession(input);
      checkStopped();
      tracked.folderName = chat.folder?.name || '';
      tracked.folderPath = chat.folder?.path || '';
      // Working or Coding: the mode decides the working agreement, which tools are offered and
      // how many tool rounds a reply may take.
      const mode = normalizeMode(input?.mode);
      const prepared = await prepareChatRequest(input, {
        workspaceTools: chat.tools, projectNotes: chat.notes, notesEnabled: projectNotesEnabled(), modeInstructions: modeInstructions(mode),
      });
      const folderName = tracked.folderName;
      const forward = createProgressForwarder({
        send: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send('provider:progress', progress);
        },
        restore: streamingRepair(prepared.input, folderName),
      });
      // The files changed so far, after every change: a reply that is stopped or fails still
      // shows what it changed, for review and undo.
      chat.onChanges = (changes) => forward.push({ requestId, phase: 'changes', changes });
      let result;
      try {
        // Checked in the same turn as the loop starts, so no Stop falls in between.
        checkStopped();
        result = await toolLoop.send(prepared.input, {
          permission: chatPermission(),
          mode,
          maxRounds: modeMaxRounds(mode),
          source: chat.source,
          folderName,
          onProgress: forward.push,
        });
      } finally {
        chat.onChanges = null;
        forward.close();
      }
      const changes = chat.changes();
      return {
        ...result,
        ...(prepared.notes?.created ? { projectNotes: { created: true, path: prepared.notes.path } } : {}),
        ...(changes ? { changes } : {}),
      };
    } finally {
      if (chat) {
        // Commands stop at once; a save that was finishing is waited for, so the reply's list
        // of changes is complete when the window asks for it.
        chat.dispose();
        await chat.settle();
      }
      if (owned && chatRequests.get(requestId) === tracked) chatRequests.delete(requestId);
    }
  },
  'provider:cancel': (_event, id) => {
    const tracked = typeof id === 'string' ? chatRequests.get(id) : undefined;
    if (tracked) tracked.stopped = true;
    return toolLoop.cancel(id) || Boolean(tracked);
  },
  'provider:set-model': (_event, input) => provider.setModel(input),
  'provider:refresh-models': () => provider.refreshModels(),
  // Several saved providers; the active one is what chat and generation use.
  'provider:profiles': () => provider.profiles(),
  'provider:profile-add': (_event, input) => provider.addProfile(input),
  'provider:profile-select': (_event, input) => provider.selectProfile(input),
  'provider:profile-rename': (_event, input) => provider.renameProfile(input),
  'provider:profile-remove': (_event, input) => provider.removeProfile(input),
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
// Checkpoint IPC: a reply's changes as a summary and per-file diffs, undo and keep. File
// contents never cross the bridge, only diff lines of the file being reviewed.
// ---------------------------------------------------------------------------
const CHECKPOINT_FALLBACK = { code: 'CHECKPOINT_ERROR', message: 'The changes could not be handled.' };
const checkpointChannels = {
  'checkpoint:get': (_event, input) => checkpoints.summary(checkpointId(input)),
  'checkpoint:diff': async (_event, input) => {
    const id = checkpointId(input);
    const file = typeof input?.path === 'string' ? input.path : '';
    if (!file || file.length > 1024) throw bridgeError('INVALID_CHECKPOINT', 'Choose a changed file.');
    // How the file is now needs its folder; without it the diff still shows.
    try {
      return await withCheckpointFolder(id, (session) => checkpoints.diff(id, file, { workspace: session }));
    } catch (error) {
      if (['NO_CHECKPOINT', 'NOT_FOUND', 'INVALID_CHECKPOINT'].includes(error?.code)) throw error;
      return checkpoints.diff(id, file);
    }
  },
  'checkpoint:undo': (_event, input) => {
    const id = checkpointId(input);
    const paths = checkpointPaths(input);
    return queueCheckpoint(id, () => withCheckpointFolder(id, (session, folder) => {
      requireSettled(id, folder.path);
      return checkpoints.undo(id, paths, { workspace: session });
    }));
  },
  'checkpoint:keep': (_event, input) => {
    const id = checkpointId(input);
    const paths = checkpointPaths(input);
    return queueCheckpoint(id, () => {
      requireSettled(id);
      return checkpoints.keep(id, paths);
    });
  },
  'checkpoint:remove': (_event, input) => {
    const ids = Array.isArray(input?.ids) ? input.ids.filter((id) => validCheckpointId(id)).slice(0, 1000) : [];
    return checkpoints.remove(ids);
  },
};
for (const [channel, run] of Object.entries(checkpointChannels)) {
  ipcMain.handle(channel, wrap(run, CHECKPOINT_FALLBACK));
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
  // A folder picked before the start-up restore finished must win over the remembered one.
  await restoreFolder();
  const selected = await instance.select(root);
  const listing = await instance.list('');
  rememberFolder(selected.path);
  return { root: selected.path, files: normaliseEntries(listing.entries), recent: recentFolders() };
}, WORKSPACE_FALLBACK));

// The open folder (restored from the last run on the first call) and the recent folders.
ipcMain.handle('workspace:current', wrap(async () => {
  await restoreFolder();
  const instance = getWorkspace();
  const open = instance.current();
  const files = open ? normaliseEntries((await instance.list('')).entries) : [];
  return { root: open ? open.path : '', files, recent: recentFolders() };
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
  async (_event, request) => {
    await shellPathReady;
    return requireWorkspace().run(request);
  },
  WORKSPACE_FALLBACK
));

ipcMain.handle('workspace:cancel', wrap(
  () => requireWorkspace().cancel(),
  WORKSPACE_FALLBACK
));

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Media: scalemax-media://<id>/ serves one stored file (with Range for video seeking)
// ---------------------------------------------------------------------------
function serveMedia(request) {
  let id = '';
  try { id = new URL(request.url).hostname; } catch { id = ''; }
  const file = mediaStudio.filePath(id);
  const meta = file ? mediaStudio.item(id) : null;
  if (!file || !meta) return new Response('Not found', { status: 404 });
  const size = fs.statSync(file).size;
  const headers = {
    'Content-Type': meta.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
  if (range && size > 0) {
    let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
    let end = range[1] === '' || range[2] === '' ? size - 1 : Number(range[2]);
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (!(start <= end)) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) }
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}

// Media channels: generation runs in main with the stored key; the renderer only sees ids.
const MEDIA_FALLBACK = { code: 'MEDIA_ERROR', message: 'Media request failed.' };
const MEDIA_ID = /^m-[a-f0-9]{16}$/;

const mediaChannels = {
  'media:generate': (event, input) => mediaStudio.generate(input, {
    onProgress: (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('media:progress', progress);
    }
  }),
  'media:cancel': (_event, requestId) => mediaStudio.cancel(requestId),
  'media:info': (_event, input) => {
    const meta = mediaStudio.item(input?.id);
    return meta ? { id: meta.id, kind: meta.kind, mime: meta.mime, model: meta.model || null, source: meta.source } : null;
  },
  // A source image for editing or image-to-video, copied into the media folder.
  'media:pick-image': async () => {
    const { canceled, filePaths } = await showOpenDialog({
      title: 'Choose an image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    });
    if (canceled || !filePaths.length) return null;
    return mediaStudio.importImage(filePaths[0]);
  },
  'media:save': async (_event, input) => {
    const id = typeof input?.id === 'string' && MEDIA_ID.test(input.id) ? input.id : '';
    if (!mediaStudio.filePath(id)) throw bridgeError('NOT_FOUND', 'That file no longer exists.');
    const options = { title: 'Save', defaultPath: path.join(app.getPath('downloads'), mediaStudio.suggestedName(id)) };
    const { canceled, filePath } = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (canceled || !filePath) return { saved: false };
    return { ...mediaStudio.saveAs(id, filePath), name: path.basename(filePath) };
  }
};

for (const [channel, run] of Object.entries(mediaChannels)) {
  ipcMain.handle(channel, wrap(run, MEDIA_FALLBACK));
}

app.whenReady().then(() => {
  // "ScaleMax" menu labels, About panel and Dock icon (app.name itself stays the package name).
  applyBranding({ app, Menu, shell });
  // Reopen the folder from the last run (the renderer waits for this through workspace:current).
  void restoreFolder();
  // Changes of replies are kept for 30 days (at most 500 replies).
  setTimeout(() => {
    try {
      checkpoints.prune();
    } catch (error) {
      console.error('[ScaleMax] Old reply changes could not be cleaned up:', error.message);
    }
  }, 5000).unref?.();
  protocol.handle('scalemax-media', serveMedia);
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
  mediaStudio.closeAll();
  void mcp.closeAll();
  // Commands run in their own process group and would outlive the app: end them.
  for (const session of [...chatSessions]) session.dispose();
  chatSessions.clear();
  workspace?.dispose();
});

app.on('window-all-closed', () => {
  // macOS convention: keep the app running without windows.
  if (process.platform !== 'darwin') app.quit();
});
