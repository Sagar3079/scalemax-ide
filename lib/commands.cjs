'use strict';
// How commands are started, for the model's foreground commands (lib/workspace.cjs run()) and
// its background jobs (lib/jobs.cjs): the shell line, optionally in a terminal and in the
// sandbox (lib/sandbox.cjs), and what their output looks like to the model.
const fs = require('node:fs');
const path = require('node:path');
const sandbox = require('./sandbox.cjs');

// A terminal for the command, through script(1). script cannot take the socket Node gives as
// stdin ("Operation not supported on socket"), so input reaches it through cat on a pipe; the
// terminal is 120 × 40, and the command runs with `eval` so it is never re-quoted.
// script starts the command in a session (and process group) of its own, so a signal to the
// wrapper's group never reaches it: a program that ignores the terminal's hangup (nohup,
// gunicorn) outlived Stop and time limits. So the terminal's shell first writes its process id,
// which is also its group's, to descriptor GROUP_FD when the caller opened one (TERMINAL_STDIO),
// and closes it before the command runs (watchTerminalGroup).
const GROUP_FD = 3;
const TERMINAL_STDIO = Object.freeze(['pipe', 'pipe', 'pipe', 'pipe']);
const TTY_WRAPPER = '/usr/bin/script -q /dev/null /bin/zsh -f -c \'{ print -r -- $$ >&3; } 2>/dev/null; exec 3>&-; stty cols 120 rows 40 2>/dev/null; eval "$1"\' zsh "$1" < <(cat 2>/dev/null)';

const CMD_EXE = 'C:\\Windows\\System32\\cmd.exe';

/**
 * The program and arguments that run a shell command line. On Windows the line goes to cmd.exe
 * in quotes, as Node's own `shell: true` does, and must be spawned with windowsVerbatimArguments
 * (commandLine says so): Node's usual quoting (\") is not what cmd.exe reads.
 */
function shellArgv(command, { tty = false, platform = process.platform } = {}) {
  if (platform === 'win32') return [CMD_EXE, '/d', '/s', '/c', `"${command}"`];
  if (platform !== 'darwin') return ['/bin/sh', '-c', command];
  if (tty) return ['/bin/zsh', '-f', '-c', TTY_WRAPPER, 'zsh', command];
  return ['/bin/zsh', '-f', '-c', command];
}

/**
 * { file, args, windowsVerbatimArguments } for spawn: the command's shell line, in a terminal
 * when `tty` (macOS only) and in the sandbox when `box` is given ({ project, network, appData }).
 */
function commandLine(command, { tty = false, box = null, platform = process.platform } = {}) {
  const argv = shellArgv(command, { tty: tty && platform === 'darwin', platform });
  if (box) return { ...sandbox.wrap(argv, box), windowsVerbatimArguments: false };
  return { file: argv[0], args: argv.slice(1), windowsVerbatimArguments: platform === 'win32' };
}

// Windows programs need these to start at all (without SystemRoot even Node and cmd.exe fail),
// so the small environment the model's commands, hooks and MCP servers get keeps them there.
const WINDOWS_ENV_KEYS = Object.freeze([
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'USERNAME', 'USERDOMAIN',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'TEMP', 'TMP', 'OS', 'PUBLIC',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'COMPUTERNAME',
]);

/** The Windows variables of `env` (Windows names are case-insensitive); nothing elsewhere. */
function platformEnvironment({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return {};
  const byName = new Map(Object.keys(env).map((key) => [key.toUpperCase(), key]));
  const out = {};
  for (const key of WINDOWS_ENV_KEYS) {
    const actual = byName.get(key.toUpperCase());
    if (actual !== undefined && typeof env[actual] === 'string') out[key] = env[actual];
  }
  return out;
}

// cmd.exe's special characters, escaped with ^ (the rules cross-spawn uses).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function cmdArgument(arg, doubleEscape) {
  let text = String(arg);
  // Backslashes before a quote, or at the end (before the closing quote), are doubled.
  text = text.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, '$1$1');
  text = `"${text}"`.replace(CMD_META, '^$1');
  return doubleEscape ? text.replace(CMD_META, '^$1') : text;
}

/**
 * How to start `command args` without a shell on Windows. npx, npm, pnpm, yarn and uvx are .cmd
 * scripts there, which Node starts only through cmd.exe: the program is looked up on PATH (with
 * PATHEXT), and a script gets a cmd.exe line with each argument quoted and escaped, so no argument
 * can add a command of its own. Elsewhere, and for a real program, nothing changes.
 * @returns {{ file: string, args: string[], windowsVerbatimArguments: boolean }}
 */
function windowsProgram(command, args = [], { platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const plain = { file: command, args, windowsVerbatimArguments: false };
  if (platform !== 'win32' || typeof command !== 'string' || !command) return plain;
  const vars = platformEnvironment({ platform, env });
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
  const extensions = (vars.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const candidates = /[\\/]/.test(command) || path.win32.isAbsolute(command)
    ? [command]
    : String((pathKey && env[pathKey]) || '').split(';').filter(Boolean).map((dir) => path.win32.join(dir, command));
  let found = null;
  for (const base of candidates) {
    const names = path.win32.extname(base) ? [base] : extensions.map((ext) => `${base}${ext.toLowerCase()}`);
    found = names.find((name) => exists(name)) || null;
    if (found) break;
  }
  if (!found || !/\.(?:cmd|bat)$/i.test(found)) return found ? { ...plain, file: found } : plain;
  // A shim in node_modules\.bin runs the line through cmd.exe once more.
  const shim = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(found);
  const line = [path.win32.normalize(found).replace(CMD_META, '^$1'), ...args.map((arg) => cmdArgument(arg, shim))].join(' ');
  return { file: CMD_EXE, args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
}

/**
 * Calls `onGroup(pid)` once with the process group of a terminal command (TTY_WRAPPER), as its
 * shell reported it on descriptor GROUP_FD of `child` (spawned with TERMINAL_STDIO). Only the first
 * line counts: the shell closes the descriptor before the command itself runs.
 */
function watchTerminalGroup(child, onGroup) {
  const stream = child?.stdio?.[GROUP_FD];
  if (!stream || typeof stream.on !== 'function') return;
  let text = '';
  stream.on('error', () => { /* the wrapper ended */ });
  stream.on('data', (chunk) => {
    if (text === null) return;
    text += String(chunk);
    const match = /^(\d{1,9})\n/.exec(text);
    if (!match && text.length < 16) return;
    text = null;
    stream.destroy();
    const pid = match ? Number(match[1]) : 0;
    if (pid > 1) onGroup(pid);
  });
}

/**
 * Terminal output as plain text: colour and cursor codes removed, CRLF as LF, and a line that
 * was redrawn in place (progress bars) as what it finally showed.
 */
function cleanOutput(text) {
  const value = String(text ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b[@-Z\\-_=>]/g, '')
    .replace(/\r+\n/g, '\n');
  return value.split('\n').map((line) => {
    const cut = line.lastIndexOf('\r');
    // "\r" at the very end is a line still being drawn: keep what was there.
    const shown = cut < 0 ? line : cut === line.length - 1 ? line.slice(line.lastIndexOf('\r', cut - 1) + 1, cut) : line.slice(cut + 1);
    return shown.replace(/[^\n]\x08/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  }).join('\n');
}

module.exports = {
  shellArgv, commandLine, cleanOutput, watchTerminalGroup, platformEnvironment, windowsProgram,
  TTY_WRAPPER, TERMINAL_STDIO, GROUP_FD, WINDOWS_ENV_KEYS,
};
