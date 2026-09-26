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
    fetch: (input) => ipcRenderer.invoke('connector:fetch', input),

    /**
     * Saves the OAuth app registration for a connector. The client secret is write-only:
     * omit it to keep the stored one, pass '' to clear it. shop is required for Shopify.
     * @param {{id: string, clientId: string, clientSecret?: string, shop?: string}} input
     * @returns {Promise<{ok: boolean, data?: object, error?: object}>} the getOAuthConfig shape; the secret is never returned
     */
    saveOAuthConfig: (input) => ipcRenderer.invoke('connector:oauth-config-save', input),

    /**
     * Reads the OAuth setup for a connector: registration hints plus what is stored.
     * @param {{id: string}} input
     * @returns {Promise<{ok: boolean, data?: {id: string, supported: boolean, configured?: boolean, clientId?: string, hasSecret?: boolean, secretStorage?: string, shop?: string|null, secret?: string, needsShop?: boolean, redirectUri?: string, loopback?: string, redirectNote?: string, registerUrl?: string, docsUrl?: string, scopes?: string}, error?: object}>}
     *          data.supported is false when the connector has no OAuth sign-in
     */
    getOAuthConfig: (input) => ipcRenderer.invoke('connector:oauth-config-get', input),

    /**
     * Opens the provider sign-in page in the system browser and resolves once the
     * loopback callback has been exchanged for tokens. Starting another sign-in cancels
     * the one in progress.
     * @param {{id: string}} input
     * @returns {Promise<{ok: boolean, data?: object, error?: object}>} sanitized list entry; tokens are never returned
     */
    startOAuth: (input) => ipcRenderer.invoke('connector:oauth-start', input),

    /**
     * @param {{id: string}} input
     * @returns {Promise<{ok: boolean, data?: {id: string, pending: boolean, connected: boolean, oauth: boolean, identity: string|null, expiresAt: number|null, expired: boolean, hasRefreshToken: boolean, lastError: string|null}, error?: object}>}
     */
    oauthStatus: (input) => ipcRenderer.invoke('connector:oauth-status', input),

    /**
     * Cancels a pending sign-in and removes the stored tokens. forgetClient also deletes
     * the saved client ID and secret; pendingOnly only cancels the sign-in in progress
     * and keeps any existing connection.
     * @param {{id: string, forgetClient?: boolean, pendingOnly?: boolean}} input
     * @returns {Promise<{ok: boolean, data?: {removed: boolean, clientForgotten: boolean, cancelled?: boolean}, error?: object}>}
     */
    disconnectOAuth: (input) => ipcRenderer.invoke('connector:oauth-disconnect', input),

    /**
     * Connectors that can sign in through an installed CLI (GitHub via `gh`).
     * @returns {Promise<{ok: boolean, data?: {github: {installed: boolean}}, error?: object}>}
     */
    cliAvailable: () => ipcRenderer.invoke('connector:cli-available'),

    /**
     * Connects through the provider's CLI. With an existing gh login it finishes at once
     * (status 'connected'); otherwise it opens the device page and returns the one-time code
     * (status 'code', already copied to the clipboard). Then call cliWait. Tokens are never returned.
     * @param {{id: 'github'}} input
     * @returns {Promise<{ok: boolean, data?: {status: 'connected'|'code', code?: string, verificationUri?: string, copied?: boolean, source?: string, toolCount?: number, mcpError?: string|null}, error?: object}>}
     */
    cliConnect: (input) => ipcRenderer.invoke('connector:cli-start', input),

    /**
     * Resolves when the pending CLI sign-in finished (browser approval done, token stored).
     * @param {{id: 'github'}} input
     * @returns {Promise<{ok: boolean, data?: {status: 'connected', source: string, toolCount: number, mcpError: string|null}, error?: object}>}
     */
    cliWait: (input) => ipcRenderer.invoke('connector:cli-wait', input),

    /** @param {{id: 'github'}} input @returns {Promise<{ok: boolean, data?: {cancelled: boolean}, error?: object}>} */
    cliCancel: (input) => ipcRenderer.invoke('connector:cli-cancel', input)
  },

  mcp: {
    /**
     * Lists configured MCP servers. Env and header values are never returned, only their names.
     * @returns {Promise<{ok: boolean, data?: Array<{id: string, name: string, transport: 'stdio'|'http', command: string|null, args: string[], cwd: string|null, url: string|null, enabled: boolean, envKeys: string[], headerKeys: string[], secretStorage: string, lastStatus: string, lastError: string|null, toolCount: number, connected: boolean, serverInfo: object|null, updatedAt: number}>, error?: object}>}
     */
    list: () => ipcRenderer.invoke('mcp:list'),

    /**
     * Adds or updates a server. Omit env/headers on update to keep the stored values.
     * @param {{id?: string, name: string, transport: 'stdio'|'http', command?: string, args?: string[], cwd?: string, url?: string, env?: {[key: string]: string}, headers?: {[key: string]: string}, enabled?: boolean}} input
     * @returns {Promise<{ok: boolean, data?: object, error?: object}>} the sanitized list entry
     */
    save: (input) => ipcRenderer.invoke('mcp:save', input),

    /**
     * @param {{id: string}} input
     * @returns {Promise<{ok: boolean, data?: {removed: boolean}, error?: object}>}
     */
    remove: (input) => ipcRenderer.invoke('mcp:remove', input),

    /**
     * Connects, initializes and lists tools.
     * @param {{id: string}} input
     * @returns {Promise<{ok: boolean, data?: {ok: true, serverInfo: object, protocolVersion: string, tools: Array<{name: string, title: string, description: string, readOnly: boolean}>}, error?: object}>}
     */
    test: (input) => ipcRenderer.invoke('mcp:test', input),

    /**
     * @param {{id: string}} input
     * @returns {Promise<{ok: boolean, data?: Array<{name: string, title: string, description: string, readOnly: boolean}>, error?: object}>}
     */
    tools: (input) => ipcRenderer.invoke('mcp:tools', input),

    /**
     * One-click sign-in: opens the service's consent page in the browser, registers ScaleMax
     * automatically (no OAuth app, client ID or callback URL needed), then connects the server.
     * Pass a connector id for the built-in directory, or the id of a saved HTTP server.
     * Starting another sign-in cancels the one in progress. Tokens are never returned.
     * @param {{connectorId: string} | {id: string}} input
     * @returns {Promise<{ok: boolean, data?: object, error?: object}>} the sanitized list entry
     */
    signIn: (input) => ipcRenderer.invoke('mcp:oauth-start', input),

    /** @returns {Promise<{ok: boolean, data?: {cancelled: boolean}, error?: object}>} */
    cancelSignIn: () => ipcRenderer.invoke('mcp:oauth-cancel')
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
