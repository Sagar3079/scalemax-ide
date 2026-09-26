const { contextBridge, ipcRenderer } = require('electron');

/**
 * Secure bridge exposed to the renderer.
 *
 * Renderer: contextIsolation: true, nodeIntegration: false (set in main.js),
 * so `window.scalemaxAPI` is the only window into the main process.
 */
contextBridge.exposeInMainWorld('scalemaxAPI', {
  app: {
    /** @returns {Promise<string>} */
    getVersion: () => ipcRenderer.invoke('app:get-version'),

    /** @returns {Promise<void>} */
    quit: () => ipcRenderer.invoke('app:quit')
  },

  store: {
    /** @param {string} key @returns {Promise<any>} */
    get: (key) => ipcRenderer.invoke('store:get', key),

    /** @param {string} key @param {any} value @returns {Promise<void>} */
    set: (key, value) => ipcRenderer.invoke('store:set', key, value)
  },

  provider: {
    /** @returns {Promise<{ok: boolean, data?: object, error?: object}>} metadata only, never the key */
    get: () => ipcRenderer.invoke('provider:get'),

    /**
     * @param {{baseUrl: string, model: string, apiKey?: string}} input
     * @returns {Promise<{ok: boolean, data?: object, error?: object}>}
     */
    save: (input) => ipcRenderer.invoke('provider:save', input),

    /** @returns {Promise<{ok: boolean, data?: object, error?: object}>} */
    test: () => ipcRenderer.invoke('provider:test'),

    /**
     * Verifies a key and loads the model catalog without saving.
     * @param {{kind?: string, baseUrl?: string, apiKey?: string}} input
     * @returns {Promise<{ok: boolean, data?: {kind: string, baseUrl: string, models: Array<object>}, error?: object}>}
     */
    discover: (input) => ipcRenderer.invoke('provider:discover', input),

    /**
     * @param {{requestId: string, messages: Array<{role: string, content: string}>, systemPrompt?: string, temperature?: number}} input
     * @returns {Promise<{ok: boolean, data?: object, error?: object}>}
     */
    send: (input) => ipcRenderer.invoke('provider:send', input),

    /** @param {string} requestId @returns {Promise<{ok: boolean, data?: boolean}>} */
    cancel: (requestId) => ipcRenderer.invoke('provider:cancel', requestId),

    /** @returns {Promise<{ok: boolean, data?: object, error?: object}>} */
    clear: () => ipcRenderer.invoke('provider:clear')
  },

  connectors: {
    /** @returns {Promise<{ok: boolean, data?: {[id: string]: object}, error?: object}>} sanitized metadata only; the token is never returned */
    list: () => ipcRenderer.invoke('connector:list'),

    /**
     * @param {{id: string, token: string, label?: string}} input
     * @returns {Promise<{ok: boolean, data?: object, error?: object}>} sanitized entry; the token is never returned
     */
    save: (input) => ipcRenderer.invoke('connector:save', input),

    /**
     * @param {{id: string}} input
     * @returns {Promise<{ok: boolean, data?: {removed: boolean}, error?: object}>}
     */
    remove: (input) => ipcRenderer.invoke('connector:remove', input),

    /**
     * Validates the stored token against the provider API.
     * @param {{id: string}} input
     * @returns {Promise<{ok: boolean, data?: {ok: boolean, supported: boolean, message?: string, status?: number}, error?: object}>}
     */
    test: (input) => ipcRenderer.invoke('connector:test', input),

    /**
     * Fetches live provider data for a connected connector.
     * @param {{id: string, action: string, params: {[key: string]: string}}} input
     * @returns {Promise<{ok: boolean, data?: object, error?: object}>} bounded, sanitized provider data; the token is never returned
     */
    fetch: (input) => ipcRenderer.invoke('connector:fetch', input)
  },

  dialog: {
    /** @returns {Promise<{ok: boolean, data?: {path: string|null}, error?: object}>} data.path is null when cancelled */
    openFolder: () => ipcRenderer.invoke('dialog:open-folder'),

    /**
     * @returns {Promise<{ok: boolean, data?: {path: string, name: string, content: string}|null, error?: object}>}
     *          data is null when cancelled
     */
    openFile: () => ipcRenderer.invoke('dialog:open-file')
  },

  workspace: {
    /**
     * @param {string} path absolute project folder
     * @returns {Promise<{ok: boolean, data?: {root: string, files: Array<{path: string, name: string, type: string}>}, error?: object}>}
     */
    select: (path) => ipcRenderer.invoke('workspace:select', path),

    /**
     * Lists one directory level of the workspace.
     * @param {string} [path] optional project-relative path; the workspace root when omitted
     * @returns {Promise<{ok: boolean, data?: {root: string, files: Array<{path: string, name: string, type: string}>}, error?: object}>}
     *          data.root is always the project root
     */
    list: (path) => ipcRenderer.invoke('workspace:list', path),

    /**
     * @param {string} path project-relative path
     * @returns {Promise<{ok: boolean, data?: {path: string, content: string, revision: string}, error?: object}>}
     */
    read: (path) => ipcRenderer.invoke('workspace:read', path),

    /**
     * @param {{path: string, content: string, revision: string}} input
     * @returns {Promise<{ok: boolean, data?: {path: string, revision: string}, error?: object}>}
     */
    write: (input) => ipcRenderer.invoke('workspace:write', input),

    /** @returns {Promise<{ok: boolean, data?: {isRepo: boolean, branch: string|null, files: Array<object>}, error?: object}>} */
    gitStatus: () => ipcRenderer.invoke('workspace:git-status'),

    /**
     * @param {string} [path] optional project-relative path
     * @returns {Promise<{ok: boolean, data?: {diff: string}, error?: object}>}
     */
    gitDiff: (path) => ipcRenderer.invoke('workspace:git-diff', path),

    /**
     * @param {{command: string}} input
     * @returns {Promise<{ok: boolean, data?: {stdout: string, stderr: string, exitCode: number|null}, error?: object}>}
     */
    run: (input) => ipcRenderer.invoke('workspace:run', input),

    /** @returns {Promise<{ok: boolean, data?: boolean, error?: object}>} true when an active command was cancelled */
    cancel: () => ipcRenderer.invoke('workspace:cancel')
  },

  /** @returns {string} e.g. 'darwin' | 'win32' | 'linux' */
  getPlatform: () => process.platform
});
