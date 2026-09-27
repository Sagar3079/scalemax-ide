#!/usr/bin/env node
'use strict';

// Development runs on macOS start a branded copy of the Electron runtime so the
// Dock, the menu bar and Cmd-Tab say "ScaleMax" and show the ScaleMax icon
// instead of "Electron" and its atom icon.
//
// The copy lives in node_modules/.scalemax-dev/ScaleMax.app (git-ignored) and
// is an APFS clone, so it costs no extra disk space. Only Info.plist and the
// bundle icon change. The Electron executable is not touched or re-signed: its
// ad-hoc signature is linker-made and binds neither Info.plist nor resources,
// so the copy keeps the same code identity (cdhash) and the macOS keychain
// keeps trusting it for the "scalemax-ide Safe Storage" item (no new prompt).
//
//   node build/dev-app.cjs --run [args]  start the app (npm start)
//   node build/dev-app.cjs --path        print the executable to launch
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { inspectRuntime, requireComplete } = require('./electron-runtime.cjs');

const ROOT = path.resolve(__dirname, '..');
const NAME = 'ScaleMax';
const BUNDLE_ID = 'com.scalemax.ide.dev';
// Bump when the branding steps below change, so existing copies are rebuilt.
const RECIPE = 1;
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

function devAppPaths(root = ROOT) {
  const dir = path.join(root, 'node_modules', '.scalemax-dev');
  const app = path.join(dir, `${NAME}.app`);
  return {
    dir,
    app,
    executable: path.join(app, 'Contents', 'MacOS', 'Electron'),
    stamp: path.join(dir, 'stamp.json'),
    icon: path.join(root, 'assets', 'icons', 'icon.icns'),
  };
}

function sourceStamp(runtime, paths) {
  const exe = fs.statSync(runtime.executable);
  const icon = crypto.createHash('sha256').update(fs.readFileSync(paths.icon)).digest('hex');
  return { recipe: RECIPE, electron: runtime.version, size: exe.size, mtimeMs: Math.round(exe.mtimeMs), icon };
}

function readStamp(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function cdhash(bundle) {
  // codesign writes its report to stderr.
  const result = spawnSync('codesign', ['-dvvv', bundle], { encoding: 'utf8' });
  return `${result.stdout || ''}${result.stderr || ''}`.match(/^CDHash=(\w+)/m)?.[1] || null;
}

function removeInside(target, root) {
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.join(root, 'node_modules', '.scalemax-dev') + path.sep)) {
    throw new Error(`Refusing to remove ${resolved}: not inside node_modules/.scalemax-dev.`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

/** Builds (or reuses) the branded runtime copy and returns its executable. */
function ensureDevApp({ root = ROOT, log = console.log } = {}) {
  const runtime = requireComplete(inspectRuntime(root));
  const paths = devAppPaths(root);
  const stamp = sourceStamp(runtime, paths);
  const current = readStamp(paths.stamp);
  if (current && JSON.stringify(current) === JSON.stringify(stamp) && fs.existsSync(paths.executable)) return paths.executable;

  const source = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app');
  fs.mkdirSync(paths.dir, { recursive: true });
  const partial = path.join(paths.dir, `${NAME}.app.partial-${process.pid}`);
  removeInside(partial, root);
  try {
    // -c clones on APFS (no extra space); -R keeps the framework symlinks.
    execFileSync('cp', ['-Rc', source, partial], { stdio: 'ignore' });
  } catch {
    removeInside(partial, root);
    execFileSync('ditto', [source, partial], { stdio: 'ignore' });
  }
  const plist = path.join(partial, 'Contents', 'Info.plist');
  for (const [key, value] of [['CFBundleName', NAME], ['CFBundleDisplayName', NAME], ['CFBundleIdentifier', BUNDLE_ID]]) {
    execFileSync('plutil', ['-replace', key, '-string', value, plist]);
  }
  const iconFile = execFileSync('plutil', ['-extract', 'CFBundleIconFile', 'raw', plist], { encoding: 'utf8' }).trim() || 'electron.icns';
  fs.copyFileSync(paths.icon, path.join(partial, 'Contents', 'Resources', iconFile));

  const expected = cdhash(source);
  const actual = cdhash(partial);
  if (!expected || expected !== actual) {
    removeInside(partial, root);
    throw new Error(`The branded copy changed the Electron code identity (${expected} -> ${actual}); the keychain would ask again. Using the plain runtime.`);
  }
  removeInside(paths.app, root);
  fs.renameSync(partial, paths.app);
  // Let Finder and the Dock pick up the new name and icon right away.
  try { execFileSync(LSREGISTER, ['-f', paths.app], { stdio: 'ignore' }); } catch { /* best effort */ }
  fs.writeFileSync(paths.stamp, `${JSON.stringify(stamp, null, 2)}\n`);
  log(`[ScaleMax] Prepared ${path.relative(root, paths.app)} (Electron ${runtime.version}, same code identity ${actual.slice(0, 12)}…).`);
  return paths.executable;
}

/** The executable `npm start` launches: the branded copy on macOS, plain Electron elsewhere or on failure. */
function launchExecutable({ root = ROOT, log = console.log, warn = console.warn } = {}) {
  if (process.platform === 'darwin') {
    try { return ensureDevApp({ root, log }); } catch (error) { warn(`[ScaleMax] ${error.message}`); }
  }
  return requireComplete(inspectRuntime(root)).executable;
}

function run(args) {
  const executable = launchExecutable();
  const child = spawn(executable, ['.', ...args], { cwd: ROOT, stdio: 'inherit', windowsHide: false });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (!child.killed) child.kill(signal); });
  child.on('close', (code, signal) => {
    if (code === null) {
      console.error(`[ScaleMax] ${NAME} exited with signal ${signal}`);
      process.exit(1);
    }
    process.exit(code);
  });
}

if (require.main === module) {
  const [mode = '--run', ...rest] = process.argv.slice(2);
  try {
    if (mode === '--run') run(rest);
    else if (mode === '--path') console.log(launchExecutable({ log: () => {} }));
    else throw new Error('Usage: node build/dev-app.cjs --run [args] | --path');
  } catch (error) {
    console.error(`[ScaleMax] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { devAppPaths, ensureDevApp, launchExecutable };
