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

    /**
     * Summarizes bounded historical user/assistant turns in a separate no-tools provider call.
     * `/compact` is handled by the app before ordinary chat, so the command never becomes a user
     * prompt for the normal tool loop.
     * @param {{requestId: string, messages: Array<{role: 'user'|'assistant', content: string}>}} input
     * @returns {Promise<{ok: boolean, data?: {summary: string, model: string, metrics?: object}, error?: object}>}
     */
    compact: (input) => ipcRenderer.invoke('provider:compact', input),

    /** @returns {Promise<{ok: boolean, data?: object, error?: object}>} */
    clear: () => ipcRenderer.invoke('provider:clear'),

    /**
     * Switches the chat model (composer model menu); the endpoint and key stay as they are.
     * @param {{model: string}} input
     * @returns {Promise<{ok: boolean, data?: object, error?: object}>} provider metadata
     */
    setModel: (input) => ipcRenderer.invoke('provider:set-model', input),

    /**
     * Reloads the model list (with chat/reasoning capabilities) using the stored key.
     * @returns {Promise<{ok: boolean, data?: object, error?: object}>} provider metadata
     */
    refreshModels: () => ipcRenderer.invoke('provider:refresh-models'),

    /**
     * What a reply in progress is doing: the model is thinking, a tool runs, or a tool call waits
     * for approval. Events carry the requestId of the send they belong to.
     * @param {(progress: {requestId: string, phase: 'thinking'|'tool'|'approval', serverId?: string, toolName?: string}) => void} callback
     * @returns {() => void} unsubscribe
     */
    onProgress: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, progress) => callback(progress);
      ipcRenderer.on('provider:progress', listener);
      return () => ipcRenderer.removeListener('provider:progress', listener);
    },

    /**
     * Every saved provider (the active one is what chat and generation use), with its models.
     * Keys are never returned, only whether one is stored.
     * @returns {Promise<{ok: boolean, data?: {activeId: string, profiles: Array<{id: string, name: string, active: boolean, kind: string, baseUrl: string, model: string, configured: boolean, hasKey: boolean, models: Array<object>}>}, error?: object}>}
     */
    profiles: () => ipcRenderer.invoke('provider:profiles'),

    /** Adds an empty provider and makes it active. @param {{name?: string}} input */
    addProfile: (input) => ipcRenderer.invoke('provider:profile-add', input),

    /** Makes a saved provider active, optionally with one of its models. @param {{id: string, model?: string}} input */
    selectProfile: (input) => ipcRenderer.invoke('provider:profile-select', input),

    /** @param {{id: string, name: string}} input */
    renameProfile: (input) => ipcRenderer.invoke('provider:profile-rename', input),

    /** Deletes a saved provider and its key (not the last one). @param {{id: string}} input */
    removeProfile: (input) => ipcRenderer.invoke('provider:profile-remove', input)
  },

  media: {
    /**
     * Generates images or a video with the active provider. Every option is checked against the
     * model's advertised capabilities first. Results are stored by the app and shown through
     * scalemax-media://<id>/ URLs; nothing else about the file system is exposed.
     * @param {{requestId: string, kind: 'image'|'video', model: string, prompt: string, mode?: 'generate'|'edit'|'animate', sourceId?: string, options?: {size?: string, quality?: string, n?: number, aspectRatio?: string, resolution?: string, duration?: number}}} input
     * @returns {Promise<{ok: boolean, data?: {items: Array<{id: string, kind: string, mime: string, model: string}>, request: object}, error?: object}>}
     */
    generate: (input) => ipcRenderer.invoke('media:generate', input),

    /** Stops waiting for a generation (a job the provider already started may still be billed). */
    cancel: (requestId) => ipcRenderer.invoke('media:cancel', requestId),

    /** @param {{id: string}} input @returns {Promise<{ok: boolean, data?: object|null}>} */
    info: (input) => ipcRenderer.invoke('media:info', input),

    /** Opens a file picker and imports an image to edit or animate. @returns {Promise<{ok: boolean, data?: object|null}>} */
    pickImage: () => ipcRenderer.invoke('media:pick-image'),
    /** A pasted or dropped picture: { data: base64, name } → the media item (id, kind, mime). */
    importImage: (input) => ipcRenderer.invoke('media:import-image', input),

    /** Saves a generated file where the user chooses. @param {{id: string}} input */
    save: (input) => ipcRenderer.invoke('media:save', input),

    /**
     * Generation progress: {requestId, kind, phase: 'starting'|'queued'|'generating'|'downloading', status?, progress?}.
     * @returns {() => void} unsubscribe
     */
    onProgress: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, progress) => callback(progress);
      ipcRenderer.on('media:progress', listener);
      return () => ipcRenderer.removeListener('media:progress', listener);
    }
  },

  approvals: {
    /**
     * Subscribes to tool calls that wait for the user's approval.
     * @param {(request: {approvalId: string, requestId: string, serverId: string, serverName: string, toolName: string, readOnly: boolean, arguments: string}) => void} callback
     * @returns {() => void} unsubscribe
     */
    onRequest: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, request) => callback(request);
      ipcRenderer.on('tool:approval-request', listener);
      return () => ipcRenderer.removeListener('tool:approval-request', listener);
    },

    /**
     * Fires when a pending approval ends without an answer (chat cancelled or timed out).
     * @param {(info: {approvalId: string}) => void} callback
     * @returns {() => void} unsubscribe
     */
    onClosed: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, info) => callback(info);
      ipcRenderer.on('tool:approval-closed', listener);
      return () => ipcRenderer.removeListener('tool:approval-closed', listener);
    },

    /**
     * @param {{approvalId: string, decision: 'once'|'request'|'deny'}} input
     * @returns {Promise<{ok: boolean, data?: {accepted: boolean}, error?: object}>}
     */
    respond: (input) => ipcRenderer.invoke('tool:approval-respond', input)
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
     * Connectors that can sign in through a CLI (GitHub via `gh`): installed now, or installable
     * automatically on first Connect.
     * @returns {Promise<{ok: boolean, data?: {github: {installed: boolean, installable: boolean}}, error?: object}>}
     */
    cliAvailable: () => ipcRenderer.invoke('connector:cli-available'),

    /**
     * Connects through the provider's CLI. Downloads the official GitHub CLI first when it is
     * missing (poll cliStatus for progress). With an existing gh login it finishes at once
     * (status 'connected'); otherwise it logs the CLI in: the device page opens and the one-time
     * code is returned (status 'code', already copied). Then call cliWait. Tokens are never returned.
     * @param {{id: 'github'}} input
     * @returns {Promise<{ok: boolean, data?: {status: 'connected'|'code', installed: boolean, code?: string, verificationUri?: string, copied?: boolean, source?: string, toolCount?: number, mcpError?: string|null}, error?: object}>}
     */
    cliConnect: (input) => ipcRenderer.invoke('connector:cli-start', input),

    /**
     * Resolves when the pending CLI sign-in finished (browser approval done, token stored).
     * @param {{id: 'github'}} input
     * @returns {Promise<{ok: boolean, data?: {status: 'connected', source: string, toolCount: number, mcpError: string|null}, error?: object}>}
     */
    cliWait: (input) => ipcRenderer.invoke('connector:cli-wait', input),

    /**
     * Progress of the CLI connect in progress.
     * @param {{id: 'github'}} input
     * @returns {Promise<{ok: boolean, data?: {phase: 'idle'|'starting'|'downloading'|'verifying'|'installing'|'checking'|'login'|'approve', percent?: number, version?: string}, error?: object}>}
     */
    cliStatus: (input) => ipcRenderer.invoke('connector:cli-status', input),

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
     * @returns {Promise<{ok: boolean, data?: {root: string, files: Array<{path: string, name: string, type: string}>, recent: Array<{name: string, path: string}>}, error?: object}>}
     */
    select: (path) => ipcRenderer.invoke('workspace:select', path),
    /**
     * The open folder (main reopens the folder from the last run on the first call) and the
     * recent folders that still exist, newest first.
     * @returns {Promise<{ok: boolean, data?: {root: string, files: Array<{path: string, name: string, type: string}>, recent: Array<{name: string, path: string}>}, error?: object}>}
     *          root is '' when no folder is open
     */
    current: () => ipcRenderer.invoke('workspace:current'),

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
    /** Files of the open folder whose names match `query` (for @-mentions): { files, complete }. */
    find: (query) => ipcRenderer.invoke('workspace:find', query),

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

  /**
   * Feature specs of the open folder (lib/specs.cjs): requirements, design and a task list as
   * Markdown files in .scalemax/specs. The model writes them; the window reads them and ticks
   * tasks off.
   */
  specs: {
    /** @returns {Promise<{ok: boolean, data?: {folder: object|null, specs: Array<object>}}>} */
    list: () => ipcRenderer.invoke('spec:list'),
    /** @param {{spec: string, doc?: 'requirements'|'design'|'tasks'}} input */
    read: (input) => ipcRenderer.invoke('spec:read', input),
    /** @param {{spec: string, task: number, done: boolean, revision?: string}} input
     *    revision is the tasksRevision read() returned, so a task list that changed is refused. */
    setTask: (input) => ipcRenderer.invoke('spec:task', input)
  },

  /**
   * Background commands the model started (lib/jobs.cjs): list them, read their output from a
   * character offset, type into them, stop them. onChanged hears the list when it changes.
   */
  jobs: {
    /** @returns {Promise<{ok: boolean, data?: {sandboxAvailable: boolean, policy: object}}>} */
    info: () => ipcRenderer.invoke('jobs:info'),
    list: () => ipcRenderer.invoke('jobs:list'),
    /** @param {{id: string, from?: number}} input */
    output: (input) => ipcRenderer.invoke('jobs:output', input),
    /** @param {{id: string, text: string}} input */
    input: (input) => ipcRenderer.invoke('jobs:input', input),
    /** @param {{id: string}} input */
    stop: (input) => ipcRenderer.invoke('jobs:stop', input),
    onChanged: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, list) => callback(list);
      ipcRenderer.on('jobs:changed', listener);
      return () => ipcRenderer.removeListener('jobs:changed', listener);
    }
  },

  /**
   * What each reply changed in its folder (lib/checkpoints.cjs), by the reply's request id:
   * review a file as a diff, undo files (only while they are as the reply left them) or keep them.
   */
  checkpoints: {
    /** @param {{id: string}} input @returns {Promise<{ok: boolean, data?: {id: string, folderName: string, files: Array<object>}|null}>} */
    get: (input) => ipcRenderer.invoke('checkpoint:get', input),
    /** @param {{id: string, path: string}} input @returns {Promise<{ok: boolean, data?: {hunks: Array<object>, current: string}>}} */
    diff: (input) => ipcRenderer.invoke('checkpoint:diff', input),
    /** @param {{id: string, paths?: string[]}} input all changed files when paths is left out */
    undo: (input) => ipcRenderer.invoke('checkpoint:undo', input),
    /** @param {{id: string, paths?: string[]}} input */
    keep: (input) => ipcRenderer.invoke('checkpoint:keep', input),
    /** @param {{ids: string[]}} input forgets the changes of these replies */
    remove: (input) => ipcRenderer.invoke('checkpoint:remove', input)
  },
  /** @returns {string} e.g. 'darwin' | 'win32' | 'linux' */
  getPlatform: () => process.platform
});
