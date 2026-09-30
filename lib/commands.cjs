'use strict';
// How commands are started, for the model's foreground commands (lib/workspace.cjs run()) and
// its background jobs (lib/jobs.cjs): the shell line, optionally in a terminal and in the
// sandbox (lib/sandbox.cjs), and what their output looks like to the model.
const sandbox = require('./sandbox.cjs');

// A terminal for the command, through script(1). script cannot take the socket Node gives as
// stdin ("Operation not supported on socket"), so input reaches it through cat on a pipe; the
// terminal is 120 × 40, and the command runs with `eval` so it is never re-quoted.
const TTY_WRAPPER = '/usr/bin/script -q /dev/null /bin/zsh -f -c \'stty cols 120 rows 40 2>/dev/null; eval "$1"\' zsh "$1" < <(cat 2>/dev/null)';

/** The program and arguments that run a shell command line. */
function shellArgv(command, { tty = false, platform = process.platform } = {}) {
  if (platform === 'win32') return ['C:\\Windows\\System32\\cmd.exe', '/d', '/s', '/c', command];
  if (platform !== 'darwin') return ['/bin/sh', '-c', command];
  if (tty) return ['/bin/zsh', '-f', '-c', TTY_WRAPPER, 'zsh', command];
  return ['/bin/zsh', '-f', '-c', command];
}

/**
 * { file, args } for spawn: the command's shell line, in a terminal when `tty` (macOS only) and
 * in the sandbox when `box` is given ({ project, network, appData }).
 */
function commandLine(command, { tty = false, box = null, platform = process.platform } = {}) {
  const argv = shellArgv(command, { tty: tty && platform === 'darwin', platform });
  if (box) return sandbox.wrap(argv, box);
  return { file: argv[0], args: argv.slice(1) };
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

module.exports = { shellArgv, commandLine, cleanOutput, TTY_WRAPPER };
