'use strict';

// Apps opened from the Finder or the Dock on macOS start with the system's minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), so tools installed with Homebrew, nvm, pyenv, pipx or into
// ~/.local/bin are missing for commands the user or the model runs ("npm: command not found").
// Like other editors, ScaleMax asks the user's login shell for its PATH once at start (with a
// time limit) and puts those folders in front of the inherited ones.
// Such apps get no locale either (LANG, LC_*), and Ruby (CocoaPods), Python and others then fail on
// any non-ASCII text: the shell's locale is taken too, or else LANG=en_US.UTF-8, as Terminal sets.

const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const MARK = '__SCALEMAX_PATH__';
const LOCALE_MARK = '__SCALEMAX_LOCALE__';
const LOCALE_KEYS = ['LANG', 'LC_ALL', 'LC_CTYPE'];
// Locale names such as en_US.UTF-8, C.UTF-8 or sr_RS@latin; anything else is not taken.
const LOCALE_VALUE = /^[A-Za-z0-9_.@-]{1,64}$/;
const DEFAULT_LANG = 'en_US.UTF-8';
const TIMEOUT_MS = 5000;
const MAX_OUTPUT = 256 * 1024;
// Where package managers put tools on macOS, in case the shell cannot be asked.
const DARWIN_FALLBACK = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];

/** Joins PATH strings or lists, keeping the first occurrence of every absolute folder. */
function mergePaths(...parts) {
  const seen = new Set();
  const result = [];
  for (const part of parts) {
    const entries = Array.isArray(part) ? part : typeof part === 'string' ? part.split(path.delimiter) : [];
    for (const entry of entries) {
      if (typeof entry !== 'string' || !path.isAbsolute(entry) || entry.includes('\0') || seen.has(entry)) continue;
      seen.add(entry);
      result.push(entry);
    }
  }
  return result.join(path.delimiter);
}

function loginShell() {
  let shell = process.env.SHELL;
  try { shell = os.userInfo().shell || shell; } catch { /* no passwd entry */ }
  return typeof shell === 'string' && path.isAbsolute(shell) ? shell : '/bin/zsh';
}

// What the shell prints: its PATH, then each locale variable. Separate commands, so a shell that
// refuses an unset variable (setopt nounset) still gives its PATH.
const SCRIPT = [
  `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`,
  ...LOCALE_KEYS.map((key) => `printf '%s%s%s' '${LOCALE_MARK}${key}=' "$${key}" '${LOCALE_MARK}'`),
].join('; ');

/** { PATH, LANG, LC_ALL, LC_CTYPE } as far as the shell's output between the markers has them. */
function parseShellOutput(output) {
  const values = {};
  const match = new RegExp(`${MARK}([^\\n]*?)${MARK}`).exec(output);
  const shellPath = match ? mergePaths(match[1]) : '';
  if (shellPath) values.PATH = shellPath;
  for (const [, key, value] of output.matchAll(new RegExp(`${LOCALE_MARK}(${LOCALE_KEYS.join('|')})=([^\\n]*?)${LOCALE_MARK}`, 'g'))) {
    if (LOCALE_VALUE.test(value)) values[key] = value;
  }
  return values;
}

/**
 * The PATH and locale (LANG, LC_ALL, LC_CTYPE) the user's interactive login shell sets up, or null
 * (Windows, timeout, failure, nothing found).
 * @param {{ shell?: string, timeoutMs?: number, spawnImpl?: typeof childProcess.spawn, platform?: string }} [options]
 * @returns {Promise<{PATH?: string, LANG?: string, LC_ALL?: string, LC_CTYPE?: string}|null>}
 */
function readShellEnvironment({ shell = loginShell(), timeoutMs = TIMEOUT_MS, spawnImpl = childProcess.spawn, platform = process.platform } = {}) {
  if (platform === 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    let child;
    let output = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      // -i and -l load the same files a Terminal window does; the markers skip anything the
      // shell's startup files print.
      child = spawnImpl(shell, ['-ilc', SCRIPT], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, TERM: 'dumb' },
        detached: false,
        windowsHide: true,
      });
    } catch {
      finish(null);
      return;
    }
    child.stdout?.on('data', (chunk) => {
      output += chunk;
      if (output.length > MAX_OUTPUT) finish(null);
    });
    child.on('error', () => finish(null));
    child.on('close', () => {
      const values = parseShellOutput(output);
      finish(Object.keys(values).length ? values : null);
    });
  });
}

/** The PATH the user's interactive login shell sets up, or null (Windows, timeout, failure). */
async function readShellPath(options = {}) {
  return (await readShellEnvironment(options))?.PATH || null;
}

// Only for an app started without any locale (from the Finder): one started from a terminal keeps
// the one it was given.
function applyLocale(env, values, platform) {
  if (LOCALE_KEYS.some((key) => typeof env[key] === 'string' && env[key])) return;
  for (const key of LOCALE_KEYS) if (typeof values[key] === 'string' && LOCALE_VALUE.test(values[key])) env[key] = values[key];
  if (!env.LANG && platform === 'darwin') env.LANG = DEFAULT_LANG;
}

/**
 * Puts the login shell's PATH (or, failing that, the usual package-manager folders on macOS) in
 * front of process.env.PATH, so every command ScaleMax starts can find the user's tools. An app
 * started without a locale takes the shell's (LANG, LC_ALL, LC_CTYPE), and on macOS at least
 * LANG=en_US.UTF-8.
 * @param {{ read?: (options: object) => Promise<object|string|null> }} [options] `read` gives
 *   readShellEnvironment()'s answer (a PATH string alone is accepted too)
 * @returns {Promise<string>} the PATH now in effect
 */
async function applyShellPath({ env = process.env, platform = process.platform, read = readShellEnvironment } = {}) {
  if (platform === 'win32') return env.PATH || '';
  const shell = await read({ platform });
  const values = typeof shell === 'string' ? { PATH: shell } : shell && typeof shell === 'object' ? shell : {};
  env.PATH = mergePaths(values.PATH || '', env.PATH || '', platform === 'darwin' ? DARWIN_FALLBACK : []);
  applyLocale(env, values, platform);
  return env.PATH;
}

module.exports = { applyShellPath, readShellPath, readShellEnvironment, mergePaths, DARWIN_FALLBACK, DEFAULT_LANG, LOCALE_KEYS };
