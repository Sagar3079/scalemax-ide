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

    getPlatform: function () {
      return 'browser';
    }
  };
})();
