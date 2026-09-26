#!/usr/bin/env node
'use strict';

// A successful installer exit is not proof of a complete Electron runtime.
// This wrapper never downloads on startup, fabricates path.txt, deletes the
// dependency tree, or disables package approval / host file protections.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');

function inspectRuntime(root = ROOT, io = fs, platform = process.platform) {
  const dir = path.join(root, 'node_modules', 'electron');
  const issues = [];
  let version;
  try { version = JSON.parse(io.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; }
  catch { return { ready: false, issues: ['Electron npm package is missing or unreadable. Run npm install first.'] }; }
  const executable = platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
    : platform === 'win32' ? 'electron.exe' : 'electron';
  function checkText(relative, expected, normalize = (s) => s.trim()) {
    try {
      if (normalize(io.readFileSync(path.join(dir, relative), 'utf8')) !== expected) issues.push(`${relative} does not match Electron ${version}.`);
    } catch { issues.push(`${relative} is missing or unreadable.`); }
  }
  checkText('path.txt', executable, (s) => s);
  checkText('dist/version', version, (s) => s.trim().replace(/^v/, ''));
  const required = [`dist/${executable}`];
  if (platform === 'darwin') required.push(
    'dist/Electron.app/Contents/Info.plist',
    'dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
  );
  for (const relative of required) {
    try {
      const stat = io.statSync(path.join(dir, relative));
      if (!stat.isFile() || stat.size === 0) issues.push(`${relative} is empty or not a file.`);
    } catch { issues.push(`${relative} is missing or unreadable.`); }
  }
  return { ready: issues.length === 0, version, issues, executable: path.join(dir, 'dist', executable) };
}

function requireComplete(result) {
  if (!result.ready) throw new Error(`Electron runtime is incomplete:\n${result.issues.map((s) => `  - ${s}`).join('\n')}\nRun npm run repair:electron from macOS Terminal. Do not create path.txt manually.`);
  return result;
}

function assertWorkspacePath(target) {
  const root = fs.realpathSync(ROOT);
  let current = path.resolve(target);
  if (current !== ROOT && !current.startsWith(ROOT + path.sep)) throw new Error('Repair paths must remain inside this project.');
  // Check existing ancestors too, so a symlink cannot redirect a new cache.
  while (!fs.existsSync(current)) current = path.dirname(current);
  const resolved = fs.realpathSync(current);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error(`Repair path resolves outside this project: ${target}`);
}

function repair() {
  const installed = inspectRuntime();
  if (!installed.version) return requireComplete(installed);
  if (installed.ready) return installed;
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (pkg.allowScripts?.[`electron@${installed.version}`] !== true) {
    throw new Error(`Electron ${installed.version} needs version-specific install-script approval. Review its install.js, then run npm install-scripts approve electron.`);
  }
  const electronDir = path.join(ROOT, 'node_modules', 'electron');
  const cache = path.join(ROOT, '.cache', 'electron');
  const tmp = path.join(ROOT, '.cache', 'tmp');
  for (const target of [electronDir, path.join(electronDir, 'dist'), cache, tmp]) assertWorkspacePath(target);
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  const env = { ...process.env, electron_config_cache: cache, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  // These are Electron installer options, not host security controls.
  // Scope their removal to the approved installer child, never the user's shell.
  for (const name of ['ELECTRON_SKIP_BINARY_DOWNLOAD', 'ELECTRON_OVERRIDE_DIST_PATH']) {
    if (env[name]) console.log(`[ScaleMax] Ignoring ${name} for this repair only.`);
    delete env[name];
  }
  for (const name of ['npm_config_platform', 'npm_config_arch']) {
    if (env[name]) throw new Error(`Unset ${name} in your Terminal before repairing a native macOS runtime.`);
  }
  // Retry into a clean destination: interrupted macOS archives can contain
  // symlinks which extract-zip refuses to overwrite. Preserve, never delete,
  // the exact previous bundle and marker inside the project before retrying.
  const backupRoot = path.join(ROOT, '.cache', 'electron-repair-backups');
  assertWorkspacePath(backupRoot);
  const backup = path.join(backupRoot, randomUUID());
  for (const name of ['dist', 'path.txt']) {
    const source = path.join(electronDir, name);
    let stat;
    try { stat = fs.lstatSync(source); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Refusing to move a symlinked ${name}. Review your Electron installation manually.`);
    fs.mkdirSync(backup, { recursive: true });
    const target = path.join(backup, name);
    console.log(`[ScaleMax] Preserving incomplete ${name} at ${target}`);
    fs.renameSync(source, target);
  }
  console.log(`[ScaleMax] Running the approved Electron ${installed.version} installer with Node ${process.version}.`);
  const child = spawnSync(process.execPath, [path.join(electronDir, 'install.js')], {
    cwd: electronDir, env, stdio: 'inherit', timeout: 10 * 60 * 1000,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`Electron installer failed (${child.signal || `exit ${child.status}`}). See its error above; file protections were not bypassed.`);
  const result = inspectRuntime();
  if (!result.ready) console.error('[ScaleMax] Installer exited 0 but extraction did not finish. Success has NOT been recorded.');
  return requireComplete(result);
}

if (require.main === module) {
  try {
    const mode = process.argv[2] || '--check';
    if (!['--check', '--repair'].includes(mode)) throw new Error('Usage: node build/electron-runtime.cjs --check|--repair');
    const result = mode === '--repair' ? repair() : requireComplete(inspectRuntime());
    console.log(`[ScaleMax] Electron ${result.version}: required runtime files verified.`);
    console.log(result.executable);
  } catch (error) {
    console.error(`[ScaleMax] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { inspectRuntime, requireComplete };
