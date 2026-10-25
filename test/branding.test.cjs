'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { APP_NAME, ICON_PATH, buildMenuTemplate, aboutPanelOptions, applyBranding } = require('../lib/app-branding.cjs');
const { devAppPaths } = require('../build/dev-app.cjs');

const ROOT = path.join(__dirname, '..');
const labels = (template) => JSON.stringify(template, (key, value) => (typeof value === 'function' ? undefined : value));

test('macOS menu names ScaleMax and keeps the standard edit roles', () => {
  const template = buildMenuTemplate({ platform: 'darwin' });
  const [appMenu, ...rest] = template;
  assert.equal(appMenu.label, 'ScaleMax');
  const byRole = Object.fromEntries(appMenu.submenu.filter((item) => item.role).map((item) => [item.role, item.label]));
  assert.equal(byRole.about, 'About ScaleMax');
  assert.equal(byRole.hide, 'Hide ScaleMax');
  assert.equal(byRole.quit, 'Quit ScaleMax');
  assert.deepEqual(rest.map((menu) => menu.role), ['fileMenu', 'editMenu', 'viewMenu', 'windowMenu', 'help']);
  assert.doesNotMatch(labels(template), /Electron|scalemax-ide/);
});

test('other platforms get the same menus without the macOS app menu', () => {
  const template = buildMenuTemplate({ platform: 'win32' });
  assert.deepEqual(template.map((menu) => menu.role), ['fileMenu', 'editMenu', 'viewMenu', 'windowMenu', 'help']);
});

test('the menus list the window\'s commands with their shortcuts, and a click sends the command to that window', () => {
  const sent = [];
  const template = buildMenuTemplate({ platform: 'darwin', runCommand: (win, command) => sent.push([win, command]) });
  const find = (id) => {
    for (const menu of template) {
      const item = (menu.submenu || []).find((entry) => entry.id === id);
      if (item) return { menu: menu.label || menu.role, item };
    }
    return null;
  };
  const preferences = find('command:preferences');
  assert.equal(preferences.menu, 'ScaleMax', 'Preferences sit in the app menu on a Mac');
  assert.equal(preferences.item.accelerator, 'CmdOrCtrl+,');
  assert.equal(find('command:new-task').menu, 'File');
  assert.equal(find('command:new-task').item.accelerator, 'CmdOrCtrl+N');
  assert.equal(find('command:search').item.accelerator, 'CmdOrCtrl+K');
  assert.equal(find('command:recent-sessions').item.accelerator, 'CmdOrCtrl+Shift+O');
  assert.equal(find('command:focus-composer').menu, 'View');
  assert.deepEqual(['chat', 'workspace', 'assistant', 'experts', 'automation', 'more'].map((view) => find(`command:view:${view}`).item.accelerator),
    ['CmdOrCtrl+1', 'CmdOrCtrl+2', 'CmdOrCtrl+3', 'CmdOrCtrl+4', 'CmdOrCtrl+5', 'CmdOrCtrl+6']);
  // The View menu keeps Electron's own items (reload, zoom, full screen).
  const view = template.find((menu) => menu.role === 'viewMenu');
  for (const role of ['reload', 'toggleDevTools', 'zoomIn', 'togglefullscreen']) assert.ok(view.submenu.some((item) => item.role === role), role);
  assert.ok(template.find((menu) => menu.role === 'fileMenu').submenu.some((item) => item.role === 'close'));
  const win = { id: 1 };
  find('command:new-task').item.click({}, win);
  assert.deepEqual(sent, [[win, 'new-task']]);
  // Elsewhere Preferences are in the File menu, before Quit.
  const other = buildMenuTemplate({ platform: 'linux' });
  const file = other.find((menu) => menu.role === 'fileMenu').submenu;
  assert.ok(file.some((item) => item.id === 'command:preferences'));
  assert.equal(file.at(-1).role, 'quit');
});

test('a menu command reaches the page as a fixed DOM event, and only a known command', async () => {
  const scripts = [];
  const contents = { isDestroyed: () => false, executeJavaScript: async (script) => { scripts.push(script); } };
  const template = buildMenuTemplate({ platform: 'darwin' });
  const item = template.flatMap((menu) => menu.submenu || []).find((entry) => entry.id === 'command:view:workspace');
  item.click({}, { isDestroyed: () => false, webContents: contents });
  assert.deepEqual(scripts, [`document.dispatchEvent(new CustomEvent('scalemax:command', { detail: "view:workspace" }))`]);
  // No window (the app is in the Dock without one), or a closed one: nothing happens.
  item.click({}, undefined);
  item.click({}, { isDestroyed: () => true, webContents: contents });
  assert.equal(scripts.length, 1);
});

test('help opens the ScaleMax website', () => {
  const opened = [];
  const help = buildMenuTemplate({ platform: 'darwin', openExternal: (url) => opened.push(url) }).at(-1);
  assert.equal(help.submenu[0].label, 'ScaleMax Website');
  help.submenu[0].click();
  assert.deepEqual(opened, ['https://scalemax.pro']);
});

test('About panel shows ScaleMax and the app version', () => {
  assert.deepEqual(aboutPanelOptions({ version: '1.2.3', year: 2026 }), {
    applicationName: 'ScaleMax',
    applicationVersion: '1.2.3',
    version: '1.2.3',
    copyright: 'Copyright © 2026 ScaleMax',
    website: 'https://scalemax.pro',
    iconPath: ICON_PATH,
  });
});

function fakeElectron({ isPackaged }) {
  const calls = { about: null, menu: null, dockIcon: null };
  const app = {
    isPackaged,
    getVersion: () => '1.0.0',
    setAboutPanelOptions: (options) => { calls.about = options; },
    dock: { setIcon: (icon) => { calls.dockIcon = icon; } },
  };
  const Menu = { buildFromTemplate: (template) => ({ template }), setApplicationMenu: (menu) => { calls.menu = menu; } };
  return { app, Menu, shell: { openExternal: () => {} }, calls };
}

test('applyBranding sets the menu, About panel and (unpackaged macOS only) the Dock icon', () => {
  const dev = fakeElectron({ isPackaged: false });
  applyBranding({ ...dev, platform: 'darwin' });
  assert.equal(dev.calls.about.applicationName, APP_NAME);
  assert.equal(dev.calls.menu.template[0].label, APP_NAME);
  assert.equal(dev.calls.dockIcon, ICON_PATH);

  const packaged = fakeElectron({ isPackaged: true });
  applyBranding({ ...packaged, platform: 'darwin' });
  assert.equal(packaged.calls.dockIcon, null);

  const linux = fakeElectron({ isPackaged: false });
  applyBranding({ ...linux, platform: 'linux' });
  assert.equal(linux.calls.dockIcon, null);
  assert.equal(linux.calls.menu.template[0].role, 'fileMenu');
});

test('icon files are the rendered agent icon', () => {
  const png = fs.readFileSync(ICON_PATH);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
  const icns = fs.readFileSync(path.join(ROOT, 'assets/icons/icon.icns'));
  assert.equal(icns.subarray(0, 4).toString(), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  for (const svg of ['scalemax-icon.svg', 'scalemax-icon-small.svg', 'scalemax-mark.svg']) {
    assert.match(fs.readFileSync(path.join(ROOT, 'assets/icons', svg), 'utf8'), /^<svg /, svg);
  }
});

test('the sidebar and About marks are the agent mark from scalemax-mark.svg', () => {
  const mark = fs.readFileSync(path.join(ROOT, 'assets/icons/scalemax-mark.svg'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
  const shapes = mark.match(/<(path|rect) [^>]+\/>/g);
  assert.ok(shapes.length >= 5);
  const marks = html.match(/<span class="brand-mark"[^>]*><svg[^>]*>.*?<\/svg><\/span>/g);
  assert.equal(marks.length, 2);
  for (const inline of marks) {
    assert.match(inline, /viewBox="0 -1 22 22"/);
    for (const shape of shapes) assert.ok(inline.includes(shape), shape);
  }
});

test('the branded development runtime stays inside node_modules', () => {
  const paths = devAppPaths(ROOT);
  assert.equal(path.relative(ROOT, paths.app), path.join('node_modules', '.scalemax-dev', 'ScaleMax.app'));
  assert.equal(path.relative(paths.app, paths.executable), path.join('Contents', 'MacOS', 'Electron'));
});
