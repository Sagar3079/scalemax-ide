'use strict';
// The macOS sandbox (Seatbelt, /usr/bin/sandbox-exec) for commands the model runs, like the
// sandboxes of other coding agents. Inside it a command can:
//   - read everything except credential stores (~/.ssh, ~/.aws, ~/.gnupg, keychains, …) and
//     ScaleMax's own data;
//   - change files only in the project folder, the temporary folders and the package and build
//     caches (npm, pip, cargo, go, gradle, Xcode DerivedData, …), never the hooks or config of
//     a Git folder in the project, nor a .git entry itself (they run code later, outside the
//     sandbox). Commits, branches and stashes work; deleting project files, .git's history
//     included, is not prevented;
//   - use the network, or with the network off only this computer (localhost, local sockets),
//     so a dev server and its tests still work.
// Paths go in as parameters (-D NAME=value), never pasted into the profile text, so no folder
// name can change the rules. Other systems have no Seatbelt: there `available()` is false and
// commands run as before.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
// Shell commands the model runs must not become a back door into desktop control: the app has
// separate, permissioned computer tools for that. This does not prevent building or running
// project code (Node, compilers, test runners and the terminal wrapper stay available).
const DESKTOP_COMMANDS = [
  '/usr/bin/osascript', '/usr/bin/open', '/usr/bin/automator', '/usr/bin/shortcuts',
  '/bin/launchctl', '/usr/bin/killall', '/usr/bin/pkill', '/bin/kill',
];
// Folders under the home folder that commands may change: caches of package managers and
// build tools. Installing programs (~/.cargo/bin, ~/.local/bin, Homebrew) is not among them.
const HOME_CACHES = [
  '.npm', '.cache', '.node-gyp', '.yarn/berry', '.pnpm-store', '.bun/install/cache', '.cargo', 'go/pkg',
  '.gradle', '.m2', '.nuget/packages', '.cocoapods/repos', '.composer/cache', '.bundle/cache', '.expo',
  '.android/cache', 'Library/Caches', 'Library/pnpm/store', 'Library/Developer/Xcode/DerivedData',
  'Library/org.swift.swiftpm', 'Library/Logs',
];
// Where programs get installed, inside the allowed caches: installing needs the user's OK.
const HOME_INSTALLS = ['.cargo/bin', '.cargo/env', 'go/bin'];
// Credential stores under the home folder that commands may not even read.
const HOME_SECRETS = [
  '.ssh', '.aws', '.gnupg', '.netrc', '.git-credentials', '.config/git/credentials', '.config/gh', '.config/gcloud',
  '.azure', '.kube', '.pypirc', '.vault-token', '.password-store', '.terraform.d/credentials.tfrc.json', 'Library/Keychains',
];

// SBPL: every path comes from a parameter. The last matching rule wins, so the denials come last.
function profile({ network = true } = {}) {
  const home = (relative) => `(subpath (string-append (param "HOME") "/${relative}"))`;
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    '  (subpath (param "PROJECT"))',
    '  (subpath "/private/tmp")',
    '  (subpath "/private/var/folders")',
    '  (subpath "/dev")',
    ...HOME_CACHES.map((relative) => `  ${home(relative)}`),
    ')',
    '(deny file-write*',
    ...HOME_INSTALLS.map((relative) => `  ${home(relative)}`),
    ')',
    // Code in these runs later, outside the sandbox: git runs hooks, and its config can run
    // programs. That goes for every Git folder in the project (nested repositories, submodules),
    // and no .git entry can be made, moved or replaced (a .git file can send git anywhere).
    '(deny file-write*',
    '  (subpath (string-append (param "PROJECT") "/.git/hooks"))',
    '  (literal (string-append (param "PROJECT") "/.git/config"))',
    '  (literal (string-append (param "PROJECT") "/.git"))',
    '  (require-all (subpath (param "PROJECT")) (regex #"/\\.git$"))',
    '  (require-all (subpath (param "PROJECT")) (regex #"/\\.git(/modules/.+)?/(hooks(/.*)?|config)$")))',
    '(deny file-read* file-write*',
    ...HOME_SECRETS.map((relative) => `  ${home(relative)}`),
    '  (subpath (param "APPDATA")))',
    // No desktop automation, application launching, service registration or signalling other
    // processes from a shell command. Those operations need their own explicit user approval.
    '(deny process-exec',
    ...DESKTOP_COMMANDS.map((command) => `  (literal "${command}")`),
    ')',
    '(deny signal)',
    ...(network ? [] : [
      '(deny network-outbound)',
      '(allow network-outbound (remote unix-socket))',
      '(allow network-outbound (remote ip "localhost:*"))',
      // mDNSResponder is a local socket that performs public DNS for its caller. Without this
      // final denial, network-off commands can disclose arbitrary host names through it.
      '(deny network-outbound (literal "/private/var/run/mDNSResponder"))',
    ]),
  ].join('\n');
}

/** True where commands can be sandboxed (macOS with sandbox-exec). */
function available({ platform = process.platform, exists = fs.existsSync } = {}) {
  return platform === 'darwin' && exists(SANDBOX_EXEC);
}

/**
 * The program and arguments that run `argv` in the sandbox for `project`.
 * @param {{ project: string, network?: boolean, home?: string, appData: string }} options
 */
function wrap(argv, { project, network = true, home = os.homedir(), appData }) {
  for (const [name, value] of [['project', project], ['home', home], ['appData', appData]]) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new TypeError(`The sandbox needs an absolute ${name} path.`);
  }
  // The rules match real paths (/private/var/…, not the /var/… link to it).
  return {
    file: SANDBOX_EXEC,
    args: ['-D', `PROJECT=${canonical(project)}`, '-D', `HOME=${canonical(home)}`, '-D', `APPDATA=${canonical(appData)}`, '-p', profile({ network }), ...argv],
  };
}
function canonical(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return value;
  }
}

/**
 * A hint for the model when a sandboxed command was refused something ("Operation not
 * permitted"), so it can tell the user or ask to leave the sandbox. Empty otherwise.
 */
function refusalHint(output) {
  if (typeof output !== 'string' || !/operation not permitted/i.test(output)) return '';
  return '[ScaleMax: this command ran in the sandbox. There it can change files only in the project folder, temporary folders and package caches; cannot change .git hooks or config; cannot read credential folders such as ~/.ssh; cannot control desktop apps; and may have no network. If this command must do more, run just it again with sandbox: false (the user is asked each time); keep other commands in the sandbox.]';
}

module.exports = { available, wrap, profile, refusalHint, SANDBOX_EXEC, DESKTOP_COMMANDS, HOME_CACHES, HOME_INSTALLS, HOME_SECRETS };
