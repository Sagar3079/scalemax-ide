'use strict';

// Everything the operating system shows about the app says "ScaleMax".
//
// app.name deliberately stays "scalemax-ide" (the package name): Electron names
// the userData folder and the macOS keychain item that protects saved keys
// ("scalemax-ide Safe Storage") after it, so renaming it would orphan existing
// keys and settings. Instead, every label that Electron would otherwise derive
// from app.name (About / Hide / Quit, the About panel) is set explicitly here.
const path = require('node:path');

const APP_NAME = 'ScaleMax';
const WEBSITE = 'https://scalemax.pro';
const ICON_PATH = path.join(__dirname, '..', 'assets', 'icons', 'icon.png');

// The window's own commands (src/shortcuts.mjs runs them; the window handles the keys itself and
// stops the event, so a menu item acts only when it is clicked or the page did not take the key).
// [command, label, accelerator]
const VIEW_ITEMS = [
  ['view:chat', 'Chat', 'CmdOrCtrl+1'],
  ['view:workspace', 'Workspace', 'CmdOrCtrl+2'],
  ['view:assistant', 'Assistant', 'CmdOrCtrl+3'],
  ['view:experts', 'Experts & Resources', 'CmdOrCtrl+4'],
  ['view:automation', 'Automation', 'CmdOrCtrl+5'],
  ['view:more', 'Preferences & About', 'CmdOrCtrl+6'],
];
const MENU_COMMANDS = new Set(['new-task', 'preferences', 'search', 'recent-sessions', 'focus-composer', ...VIEW_ITEMS.map(([command]) => command)]);

/**
 * Runs a window command in the page: a DOM event src/app.js listens for. The name is one of
 * MENU_COMMANDS (never text from elsewhere), so the script is fixed.
 */
function sendCommand(browserWindow, command) {
  if (!MENU_COMMANDS.has(command)) return;
  const contents = browserWindow && !browserWindow.isDestroyed?.() ? browserWindow.webContents : null;
  if (!contents || contents.isDestroyed?.()) return;
  const script = `document.dispatchEvent(new CustomEvent('scalemax:command', { detail: ${JSON.stringify(command)} }))`;
  void Promise.resolve(contents.executeJavaScript(script)).catch(() => {});
}

/** Application menu template. Edit/View/Window use Electron's roles, so copy, paste and undo keep working. */
function buildMenuTemplate({ platform = process.platform, openExternal = () => {}, runCommand = sendCommand } = {}) {
  const mac = platform === 'darwin';
  const command = (id, label, accelerator) => ({
    id: `command:${id}`, label, accelerator, click: (_item, browserWindow) => runCommand(browserWindow, id),
  });
  const help = { role: 'help', submenu: [{ label: `${APP_NAME} Website`, click: () => openExternal(WEBSITE) }] };
  const preferences = command('preferences', 'Preferences…', 'CmdOrCtrl+,');
  const file = {
    role: 'fileMenu',
    label: 'File',
    submenu: [
      command('new-task', 'New Task', 'CmdOrCtrl+N'),
      { type: 'separator' },
      command('search', 'Search Workspace…', 'CmdOrCtrl+K'),
      command('recent-sessions', 'Recent Sessions…', 'CmdOrCtrl+Shift+O'),
      ...(mac ? [] : [{ type: 'separator' }, preferences]),
      { type: 'separator' },
      mac ? { role: 'close' } : { role: 'quit' },
    ],
  };
  const view = {
    role: 'viewMenu',
    label: 'View',
    submenu: [
      ...VIEW_ITEMS.map(([id, label, accelerator]) => command(id, label, accelerator)),
      { type: 'separator' },
      command('focus-composer', 'Focus Message Box', 'CmdOrCtrl+L'),
      { type: 'separator' },
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };
  const common = [file, { role: 'editMenu' }, view, { role: 'windowMenu' }, help];
  if (!mac) return common;
  return [
    {
      // macOS always titles this menu with the bundle name (CFBundleName): "ScaleMax" in the
      // packaged app and in `npm start` (build/dev-app.cjs).
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `About ${APP_NAME}` },
        { type: 'separator' },
        preferences,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${APP_NAME}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${APP_NAME}` },
      ],
    },
    ...common,
  ];
}

/** Options for app.setAboutPanelOptions (the version shown twice matches the packaged build). */
function aboutPanelOptions({ version, year = new Date().getFullYear() }) {
  return {
    applicationName: APP_NAME,
    applicationVersion: version,
    version,
    copyright: `Copyright © ${year} ${APP_NAME}`,
    website: WEBSITE,
    iconPath: ICON_PATH,
  };
}

/**
 * Applies the name and icon at startup. The Dock icon is set only for unpackaged runs; the
 * packaged app already carries the icon in its bundle (assets/icons/icon.icns).
 */
function applyBranding({ app, Menu, shell, platform = process.platform }) {
  app.setAboutPanelOptions(aboutPanelOptions({ version: app.getVersion() }));
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({ platform, openExternal: (url) => shell.openExternal(url) })));
  if (platform === 'darwin' && app.dock && !app.isPackaged) app.dock.setIcon(ICON_PATH);
}

module.exports = { APP_NAME, WEBSITE, ICON_PATH, MENU_COMMANDS, buildMenuTemplate, aboutPanelOptions, applyBranding };
