/**
 * ScaleMax IDE — Browser preview shim (development only)
 *
 * The renderer talks to Electron exclusively through `window.scalemaxAPI`,
 * which is installed by preload.js via contextBridge. When index.html is
 * opened in a plain browser (no Electron), that bridge does not exist and
 * the app would boot to a permanently unusable login screen.
 *
 * This file installs a faithful browser stand-in so the UI can be previewed
 * and exercised without packaging the app. It mirrors the key rules and
 * persistence semantics of main.js, backed by localStorage instead of
 * `app.getPath('userData')/scalemax-state.json`.
 *
 * IMPORTANT: this is a NO-OP inside Electron. If `window.scalemaxAPI` is
 * already present (installed by preload.js), nothing here runs.
 */

(function () {
  'use strict';

  // Already running inside Electron — the real bridge wins.
  if (window.scalemaxAPI) return;

  console.info(
    '[ScaleMax] Electron bridge not detected — using browser preview shim.'
  );

  var STATE_KEY = 'scalemax-preview-state';
  function readState() {
    try {
      var raw = window.localStorage.getItem(STATE_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function writeState(state) {
    try {
      window.localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch (err) {
      /* storage unavailable */
    }
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, ms);
    });
  }

  // A small project folder kept in memory: chat needs an open folder, so without one the preview
  // could never send. "Open folder…" picks it, the Workspace view browses and edits it, and the
  // composer gets the labelled demo reply. Response shapes follow preload.js; nothing touches
  // the disk, and edits last until the tab is reloaded. The open folder is remembered like main
  // remembers it (reopened at the next start).
  var FOLDER_KEY = 'scalemax-preview-folder';
  var DEMO_ROOT = '/preview/demo-project';
  var DEMO_FOLDER = { name: 'demo-project', path: DEMO_ROOT };
  var demoFiles = {
    'README.md': '# Demo project\n\nA folder the browser preview of ScaleMax IDE keeps in memory.\n',
    'package.json': '{\n  "name": "demo-project",\n  "version": "1.0.0",\n  "scripts": { "test": "node --test" }\n}\n',
    'src/index.js': 'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n',
    'src/styles.css': 'body {\n  margin: 0;\n  font-family: system-ui, sans-serif;\n}\n'
  };
  var openRoot = '';
  try {
    openRoot = window.localStorage.getItem(FOLDER_KEY) === DEMO_ROOT ? DEMO_ROOT : '';
  } catch (err) {
    openRoot = '';
  }

  function failure(code, message) {
    return { ok: false, error: { code: code, message: message } };
  }

  // 64 hex characters like main's SHA-256 revisions (FNV-1a here: only equality matters).
  function revisionOf(content) {
    var hash = 0x811c9dc5;
    for (var index = 0; index < content.length; index += 1) {
      hash ^= content.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    var hex = hash.toString(16);
    return new Array(65 - hex.length).join('0') + hex;
  }

  // One directory level: { name, path, type }, folders first, like lib/workspace.cjs.
  function listDemo(relative) {
    var prefix = relative ? relative + '/' : '';
    var seen = {};
    var entries = [];
    Object.keys(demoFiles).forEach(function (path) {
      if (path.indexOf(prefix) !== 0) return;
      var rest = path.slice(prefix.length);
      var name = rest.split('/')[0];
      if (!name || seen[name]) return;
      seen[name] = true;
      entries.push({ name: name, path: prefix + name, type: rest.indexOf('/') === -1 ? 'file' : 'directory' });
    });
    if (relative && !entries.length) return null;
    entries.sort(function (a, b) {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }

  function noFolder() {
    return failure('NO_WORKSPACE', 'Open a folder first.');
  }

  function workspaceState() {
    return { root: openRoot, files: openRoot ? listDemo('') : [], recent: [DEMO_FOLDER] };
  }

  window.scalemaxAPI = {
    app: {
      getVersion: async function () {
        return '1.0.0 (browser preview)';
      },

      quit: async function () {
        /* no-op in a browser tab */
      }
    },

    store: {
      get: async function (key) {
        if (typeof key !== 'string') return undefined;
        var state = readState();
        return Object.prototype.hasOwnProperty.call(state, key)
          ? state[key]
          : undefined;
      },

      set: async function (key, value) {
        if (typeof key !== 'string') return;
        var state = readState();
        state[key] = value;
        writeState(state);
      }
    },

    // Provider calls need the desktop process for fetch + safeStorage, so the
    // preview reports an unconfigured provider and declines to act.
    provider: (function () {
      var UNAVAILABLE = {
        ok: false,
        error: {
          code: 'UNAVAILABLE',
          message: 'Provider connections require the desktop app.'
        }
      };
      return {
        get: async function () {
          return {
            ok: true,
            data: {
              kind: 'scalemax',
              baseUrl: 'https://api.scalemax.pro/token/v1',
              model: '',
              hasKey: false,
              keyStorage: 'none',
              enabledModels: [],
              models: [],
              configured: false
            }
          };
        },
        save: async function () { return UNAVAILABLE; },
        test: async function () { return UNAVAILABLE; },
        discover: async function () { return UNAVAILABLE; },
        send: async function () { return UNAVAILABLE; },
        cancel: async function () { return { ok: true, data: false }; },
        clear: async function () { return UNAVAILABLE; }
      };
    })(),

    // The folder picker always offers the in-memory demo folder.
    dialog: {
      openFolder: async function () {
        return { ok: true, data: { path: DEMO_ROOT } };
      }
    },

    workspace: {
      select: async function (path) {
        if (path !== DEMO_ROOT) return failure('ENOENT', 'The browser preview can only open its demo folder.');
        openRoot = DEMO_ROOT;
        try {
          window.localStorage.setItem(FOLDER_KEY, DEMO_ROOT);
        } catch (err) {
          /* storage unavailable: the folder is open for this session only */
        }
        return { ok: true, data: workspaceState() };
      },
      current: async function () {
        return { ok: true, data: workspaceState() };
      },
      list: async function (path) {
        if (!openRoot) return noFolder();
        var entries = listDemo(typeof path === 'string' ? path : '');
        if (!entries) return failure('ENOENT', 'That folder does not exist.');
        return { ok: true, data: { root: openRoot, files: entries } };
      },
      read: async function (path) {
        if (!openRoot) return noFolder();
        if (!Object.prototype.hasOwnProperty.call(demoFiles, path)) return failure('ENOENT', 'That file does not exist.');
        return { ok: true, data: { path: path, content: demoFiles[path], revision: revisionOf(demoFiles[path]) } };
      },
      find: async function (query) {
        if (!openRoot) return noFolder();
        var needle = typeof query === 'string' ? query.toLowerCase() : '';
        var files = Object.keys(demoFiles).filter(function (path) {
          return path.toLowerCase().indexOf(needle) !== -1;
        }).sort();
        return { ok: true, data: { files: files, complete: true } };
      },
      write: async function (input) {
        if (!openRoot) return noFolder();
        var path = input && input.path;
        if (!Object.prototype.hasOwnProperty.call(demoFiles, path)) return failure('ENOENT', 'That file does not exist.');
        if (typeof input.content !== 'string') return failure('INVALID_CONTENT', 'File content must be a string.');
        if (input.revision !== revisionOf(demoFiles[path])) return failure('CONFLICT', 'The file changed; reload it before saving.');
        demoFiles[path] = input.content;
        return { ok: true, data: { path: path, revision: revisionOf(input.content) } };
      },
      gitStatus: async function () {
        if (!openRoot) return noFolder();
        return { ok: true, data: { isRepo: false, branch: null, files: [] } };
      },
      gitDiff: async function () {
        if (!openRoot) return noFolder();
        return { ok: true, data: { diff: '' } };
      },
      run: async function () {
        return failure('UNAVAILABLE', 'Commands require the desktop app.');
      },
      cancel: async function () {
        return { ok: true, data: false };
      }
    },

    // Automations run in the desktop app's main process: the preview lists and edits them but
    // never runs one (src/scheduler.js reads these answers).
    automations: {
      state: async function () {
        return { ok: true, data: { running: [], background: true } };
      },
      runNow: async function () {
        return failure('UNAVAILABLE', 'Automations run in the desktop app.');
      },
      setContext: async function () {
        return { ok: true, data: { saved: false } };
      },
      onChanged: function () {
        return function () {};
      }
    },

    // MCP servers need the desktop app; the MCP view checks for each method it uses, so only the
    // resource and prompt listings are stood in for.
    mcp: {
      resources: async function () {
        return failure('UNAVAILABLE', 'MCP servers require the desktop app.');
      },
      prompts: async function () {
        return failure('UNAVAILABLE', 'MCP servers require the desktop app.');
      },
      getPrompt: async function () {
        return failure('UNAVAILABLE', 'MCP servers require the desktop app.');
      }
    },

    getPlatform: function () {
      return 'browser';
    }
  };
})();
