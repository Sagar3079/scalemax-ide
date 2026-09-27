'use strict';

// Apps opened from the Finder or the Dock on macOS start with the system's minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), so tools installed with Homebrew, nvm, pyenv, pipx or into
// ~/.local/bin are missing for commands the user or the model runs ("npm: command not found").
// Like other editors, ScaleMax asks the user's login shell for its PATH once at start (with a
// time limit) and puts those folders in front of the inherited ones.

const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const MARK = '__SCALEMAX_PATH__';
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

/**
 * The PATH the user's interactive login shell sets up, or null (Windows, timeout, failure).
 * @param {{ shell?: string, timeoutMs?: number, spawnImpl?: typeof childProcess.spawn, platform?: string }} [options]
 */
function readShellPath({ shell = loginShell(), timeoutMs = TIMEOUT_MS, spawnImpl = childProcess.spawn, platform = process.platform } = {}) {
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
      child = spawnImpl(shell, ['-ilc', `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`], {
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
      const match = new RegExp(`${MARK}([^\\n]*?)${MARK}`).exec(output);
      const value = match ? mergePaths(match[1]) : '';
      finish(value || null);
    });
  });
}

/**
 * Puts the login shell's PATH (or, failing that, the usual package-manager folders on macOS) in
 * front of process.env.PATH, so every command ScaleMax starts can find the user's tools.
 * @returns {Promise<string>} the PATH now in effect
 */
async function applyShellPath({ env = process.env, platform = process.platform, read = readShellPath } = {}) {
  if (platform === 'win32') return env.PATH || '';
  const shellPath = await read({ platform });
  env.PATH = mergePaths(shellPath || '', env.PATH || '', platform === 'darwin' ? DARWIN_FALLBACK : []);
  return env.PATH;
}

module.exports = { applyShellPath, readShellPath, mergePaths, DARWIN_FALLBACK };
