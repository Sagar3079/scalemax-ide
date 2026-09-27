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

/** Application menu template. Edit/View/Window use Electron's roles, so copy, paste and undo keep working. */
function buildMenuTemplate({ platform = process.platform, openExternal = () => {} } = {}) {
  const help = { role: 'help', submenu: [{ label: `${APP_NAME} Website`, click: () => openExternal(WEBSITE) }] };
  const common = [{ role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }, help];
  if (platform !== 'darwin') return common;
  return [
    {
      // macOS always titles this menu with the bundle name (CFBundleName): "ScaleMax" in the
      // packaged app and in `npm start` (build/dev-app.cjs).
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `About ${APP_NAME}` },
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

module.exports = { APP_NAME, WEBSITE, ICON_PATH, buildMenuTemplate, aboutPanelOptions, applyBranding };
