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
  '/usr/bin/pbpaste', '/usr/bin/pbcopy', '/usr/sbin/screencapture',
];
// A copy of one of those programs (or a script calling the same system service) would get
// around a list of paths, so the services themselves are closed: Apple events (scripting other
// apps) and the pasteboard (the clipboard, where passwords end up).
const DESKTOP_SERVICES = ['com.apple.coreservices.appleevents', 'com.apple.pasteboard.1'];
// Local sockets that hand out more than a command should have: the Docker daemon runs containers
// that can mount any folder of this computer, so a command could leave the sandbox through it.
const DAEMON_SOCKETS = ['/private/var/run/docker.sock'];
const HOME_DAEMON_SOCKETS = ['.docker/run', '.colima', '.orbstack/run', '.rd', '.lima'];
// Folders under the home folder that commands may change: caches of package managers and
// build tools. Installing programs (~/.cargo/bin, ~/.local/bin, Homebrew) is not among them.
const HOME_CACHES = [
  '.npm', '.cache', '.node-gyp', '.yarn/berry', '.pnpm-store', '.bun/install/cache', '.cargo', 'go/pkg',
  '.gradle', '.m2', '.nuget/packages', '.cocoapods/repos', '.composer/cache', '.bundle/cache', '.expo',
  '.android/cache', 'Library/Caches', 'Library/pnpm/store', 'Library/Developer/Xcode/DerivedData',
  'Library/org.swift.swiftpm', 'Library/Logs',
];
// Inside the allowed caches, what runs code later, outside the sandbox: installed programs, and
// the configuration and init scripts the build tools read on every run. Changing those needs the
// user's OK (leave the sandbox). The package caches themselves stay writable (npx, uv run and
// every install need them), so what they hold is only as trusted as the commands that filled them.
const HOME_INSTALLS = [
  '.cargo/bin', '.cargo/env', 'go/bin',
  '.cargo/config', '.cargo/config.toml', '.cargo/credentials', '.cargo/credentials.toml',
  '.gradle/init.d', '.gradle/init.gradle', '.gradle/init.gradle.kts', '.gradle/gradle.properties',
  '.m2/settings.xml', '.m2/settings-security.xml', '.m2/extensions.xml',
];
// Credential stores and private data under the home folder that commands may not even read:
// keys and tokens, shell histories (commands typed with passwords in them), other AI tools'
// sign-ins, browsers (cookies and saved sessions), mail and messages, password managers.
const HOME_SECRETS = [
  '.ssh', '.aws', '.gnupg', '.netrc', '.git-credentials', '.config/git/credentials', '.config/gh', '.config/gcloud',
  '.azure', '.kube', '.pypirc', '.vault-token', '.password-store', '.terraform.d/credentials.tfrc.json', 'Library/Keychains',
  '.docker/config.json', '.pgpass', '.boto', '.s3cfg', '.config/op', '.config/github-copilot', '.config/hub',
  '.cargo/credentials', '.cargo/credentials.toml',
  '.zsh_history', '.bash_history', '.zhistory', '.python_history', '.node_repl_history', '.psql_history', '.mysql_history', '.sqlite_history',
  '.codex', '.claude', '.claude.json', '.gemini',
  'Library/Application Support/Google/Chrome', 'Library/Application Support/Firefox', 'Library/Application Support/BraveSoftware',
  'Library/Application Support/Microsoft Edge', 'Library/Application Support/Arc', 'Library/Safari', 'Library/Cookies',
  'Library/Mail', 'Library/Messages', 'Library/Group Containers/2BUA8C4S2C.com.1password',
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
    '(deny mach-lookup',
    ...DESKTOP_SERVICES.map((service) => `  (global-name "${service}")`),
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
    // Last, so no allowance above reopens them: the container daemons' sockets.
    '(deny network-outbound',
    ...DAEMON_SOCKETS.map((socket) => `  (literal "${socket}")`),
    ...HOME_DAEMON_SOCKETS.map((relative) => `  ${home(relative)}`),
    ')',
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
  return '[ScaleMax: this command ran in the sandbox. There it can change files only in the project folder, temporary folders and package caches; cannot change .git hooks or config; cannot read credential folders such as ~/.ssh, shell histories or browser data; cannot control desktop apps, use the clipboard or reach Docker; and may have no network. If this command must do more, run just it again with sandbox: false (the user is asked each time); keep other commands in the sandbox.]';
}

module.exports = {
  available, wrap, profile, refusalHint, SANDBOX_EXEC, DESKTOP_COMMANDS, DESKTOP_SERVICES, DAEMON_SOCKETS, HOME_DAEMON_SOCKETS,
  HOME_CACHES, HOME_INSTALLS, HOME_SECRETS,
};
