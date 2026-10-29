'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspace } = require('../lib/workspace.cjs');
const { createComputerTools } = require('../lib/computer-tools.cjs');

// A real project folder (canonical path: /tmp and /var are symlinks on macOS) and a shell that
// only records what it was asked to open.
async function openTools(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-computer-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = createWorkspace({ approve: async () => true });
  t.after(() => workspace.dispose());
  await workspace.select(root);
  const opened = [];
  const shell = {
    openPath: async (value) => { opened.push(['open', path.relative(root, value).split(path.sep).join('/')]); return ''; },
    openExternal: async (value) => { opened.push(['external', value]); },
    showItemInFolder: (value) => { opened.push(['reveal', path.relative(root, value).split(path.sep).join('/')]); },
  };
  const tools = createComputerTools({ getWorkspace: () => workspace, clipboard: { readText: () => '', writeText: () => {} }, shell });
  return { root, tools, opened };
}

test('computer_open refuses apps, programs and launchers (they would run outside the sandbox)', async (t) => {
  const { root, tools, opened } = await openTools(t);
  // Everything a sandboxed command could leave in the project for the system to run.
  fs.mkdirSync(path.join(root, 'Build', 'Tool.app', 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Shout.APP'));
  fs.mkdirSync(path.join(root, 'Flow.workflow'));
  const launchers = ['run.command', 'run.tool', 'Shell.terminal', 'setup.pkg', 'app.jar', 'do.scpt', 'do.applescript',
    'site.webloc', 'site.inetloc', 'other.fileloc', 'script.py', 'Pane.prefPane',
    // Windows programs, installers, shortcuts and scripts.
    'setup.EXE', 'run.bat', 'go.cmd', 'Tool.lnk', 'site.url', 'install.msi', 'do.ps1', 'do.vbs', 'do.js', 'keys.reg', 'app.appref-ms'];
  for (const name of launchers) fs.writeFileSync(path.join(root, name), 'x\n');
  fs.writeFileSync(path.join(root, 'program'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'notes.txt'), 'x\n', { mode: 0o744 });
  // Windows has no execute bit, so there a file is a program only by its name.
  const executables = process.platform === 'win32' ? [] : ['program', 'notes.txt'];
  for (const target of ['Build/Tool.app', 'Shout.APP', 'Flow.workflow', ...launchers, ...executables, 'Build/Tool.app/']) {
    await assert.rejects(tools.call('open', { path: target }), (error) => {
      assert.equal(error.code, 'OPEN_REFUSED', target);
      assert.match(error.message, /computer_reveal/);
      assert.equal(error.message.includes(root), false, 'no absolute path for the model');
      return true;
    });
  }
  assert.deepEqual(opened, [], 'nothing reached the system');
  // Showing them in the Finder is still fine; so is opening documents and folders.
  assert.match((await tools.call('reveal', { path: 'Build/Tool.app' })).text, /Showed Build\/Tool\.app in (?:the Finder|File Explorer)/);
  fs.writeFileSync(path.join(root, 'report.html'), '<p>hi</p>\n');
  assert.match((await tools.call('open', { path: 'report.html' })).text, /Opened report\.html/);
  assert.match((await tools.call('open', { path: 'Build' })).text, /Opened Build/);
  assert.deepEqual(opened, [['reveal', 'Build/Tool.app'], ['open', 'report.html'], ['open', 'Build']]);
  const open = tools.definitions().find((definition) => definition.function.name === 'computer_open').function;
  assert.match(open.description, /Apps, programs and scripts are not opened/);
  assert.ok(open.description.length <= 1024);
});
