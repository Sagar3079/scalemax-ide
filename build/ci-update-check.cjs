'use strict';
// CI (Windows): installs an older release, updates it the way Update now does, and checks that
// the new version replaced it, kept the user's files and starts.
//
//   node build/ci-update-check.cjs --from <older setup.exe> --expect <version> [--to <setup.exe>]
//
// Without --to, the older app's own Update now does it all, as it does for users: it asks GitHub
// for the newest release, downloads and checks its installer, starts it and quits. With --to (a
// build that isn't released yet), this script starts that installer with Update now's arguments
// and quits the older app the same way.
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PORT, evaluate, pageState, launch } = require('./ci-launch.cjs');

const INSTALL_DIR = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'scalemax-ide');
const APP_EXE = path.join(INSTALL_DIR, 'ScaleMax IDE.exe');
const USER_DATA = path.join(process.env.APPDATA || '', 'scalemax-ide');
const MARKER = path.join(USER_DATA, 'ci-update-marker.txt');
const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
// The installer arguments Update now uses (lib/updates.cjs, installOnce).
const UPDATE_ARGS = ['/S', '--updated', '--force-run'];
// 0xC0000005: installers built with electron-builder before 26.12 crashed now and then on a first
// install (electron-builder#9769), so the older release may need another try.
const CRASH_CODES = new Set([3221225477, -1073741819]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) => console.log(`[update-check] ${text}`);

async function until(test, ms, what) {
  const started = Date.now();
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error(`Gave up after ${ms / 1000} s waiting for ${what}`);
    await sleep(1000);
  }
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = /^--(from|to|expect)$/.exec(argv[i])?.[1];
    if (!name || !argv[i + 1]) throw new Error(`Usage: ci-update-check.cjs --from <setup.exe> --expect <version> [--to <setup.exe>]`);
    options[name] = argv[i + 1];
  }
  if (!options.from || !options.expect) throw new Error('--from and --expect are required');
  return options;
}

/** The DisplayVersion of the app's Uninstall entry, or null when it isn't installed. */
function installedVersion() {
  let listing;
  try {
    listing = execFileSync('reg', ['query', UNINSTALL_KEY, '/s'], { encoding: 'utf8' });
  } catch {
    return null;
  }
  for (const entry of listing.split(/\r?\n(?=HKEY_)/)) {
    const value = (name) => entry.match(new RegExp(`^\\s+${name}\\s+REG_SZ\\s+(.*)$`, 'm'))?.[1].trim();
    if (value('DisplayName')?.startsWith('ScaleMax IDE')) return value('DisplayVersion') || null;
  }
  return null;
}

function appRunning() {
  return execFileSync('tasklist', ['/FI', 'IMAGENAME eq ScaleMax IDE.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    .includes('"ScaleMax IDE.exe"');
}

/** The installed app's SHA-256, or null while the installer is still writing it. */
function appHash() {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(APP_EXE)).digest('hex');
  } catch {
    return null;
  }
}

function appFileVersion() {
  return execFileSync('powershell', ['-NoProfile', '-Command',
    `$v = (Get-Item -LiteralPath '${APP_EXE}').VersionInfo; "$($v.ProductVersion), file version $($v.FileVersion)"`], { encoding: 'utf8' }).trim();
}

async function installOlder(installer) {
  if (fs.existsSync(APP_EXE) || installedVersion()) throw new Error('ScaleMax IDE is already installed here');
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const { status } = spawnSync(installer, ['/S'], { stdio: 'ignore' });
    log(`${path.basename(installer)} /S, attempt ${attempt}: exit ${status}`);
    if (status === 0) {
      // The one-click installer can hand the copying to a child process: wait for the app.
      await until(() => fs.existsSync(APP_EXE) && installedVersion(), 60_000, 'the older version to be installed');
      return;
    }
    if (!CRASH_CODES.has(status)) throw new Error(`The older installer failed with exit code ${status}`);
  }
  throw new Error('The older installer crashed on every attempt');
}

/** The older app's Update now: check, then install. Returns once it has handed over and quit. */
async function updateNow(expect) {
  let checked = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    checked = await evaluate('window.scalemaxAPI.updates.check()', { awaitPromise: true });
    if (checked?.ok && checked.data.status !== 'error') break;
    log(`check ${attempt} failed: ${JSON.stringify(checked)}`);
    await sleep(20_000);
  }
  const release = checked?.data?.release;
  log(`Update now offers: ${JSON.stringify(release)}`);
  if (release?.version !== expect || !release.downloadable) throw new Error(`The older version's check didn't offer ${expect} with a download for this computer`);
  // Downloads and checks the installer, starts it and quits, so the answer may never arrive.
  const answer = await evaluate('window.scalemaxAPI.updates.install()', { awaitPromise: true }).catch(() => null);
  if (answer && (!answer.ok || answer.data.status === 'error')) throw new Error(`Update now failed: ${JSON.stringify(answer)}`);
}

async function main({ from, to, expect }) {
  await installOlder(from);
  const before = { version: installedVersion(), hash: appHash() };
  log(`installed ${before.version} (${appFileVersion()})`);

  // The older app on its real profile, as a user runs it, with DevTools for this script.
  const older = spawn(APP_EXE, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore' });
  let olderExit = null;
  older.on('exit', (code) => { olderExit = code; });
  await until(async () => {
    const state = await pageState().catch(() => null);
    return state?.ready === 'complete' && state.views > 0;
  }, 60_000, 'the older version to load');
  // A file of the user's, which the update must keep like their settings, tasks and keys.
  if (!fs.existsSync(USER_DATA)) throw new Error(`The older version has no profile at ${USER_DATA}`);
  fs.writeFileSync(MARKER, 'kept\n');

  if (to) {
    // What Update now does once its download checks out.
    spawn(to, UPDATE_ARGS, { detached: true, stdio: 'ignore' }).unref();
    await evaluate('window.scalemaxAPI.app.quit()').catch(() => null);
    log(`started ${path.basename(to)} ${UPDATE_ARGS.join(' ')} and quit the older version`);
  } else {
    await updateNow(expect);
  }
  await until(() => olderExit !== null, 300_000, 'the older version to quit');
  log(`the older version quit (exit ${olderExit})`);

  // The installer replaces the older copy, then starts the new one (--force-run).
  await until(() => installedVersion() === expect && appRunning() && ![null, before.hash].includes(appHash()),
    180_000, `${expect} to be installed and started`);
  log(`updated to ${installedVersion()} (${appFileVersion()}), and the installer started it`);
  if (!fs.existsSync(MARKER)) throw new Error(`The update removed the user's files in ${USER_DATA}`);
  log(`the user's files in ${USER_DATA} are still there`);

  try { execFileSync('taskkill', ['/F', '/T', '/IM', 'ScaleMax IDE.exe'], { stdio: 'ignore' }); } catch { /* already gone */ }
  await until(() => !appRunning(), 30_000, 'the updated app to stop');
  // The updated copy starts and loads its page (on a throwaway profile).
  await launch(APP_EXE);
  return `${before.version} → ${expect}`;
}

function summary(line) {
  console.log(`[update-check] ${line}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Update check\n\n${line}\n\n`);
}

if (require.main === module) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[update-check] ${error.message}`);
    process.exit(2);
  }
  const how = options.to ? `this build's installer, run with Update now's arguments` : `the older version's Update now`;
  main(options).then(
    (done) => { summary(`Passed: ${done}, through ${how}.`); process.exit(0); },
    (error) => { summary(`Failed (${how}): ${error.message}`); process.exit(1); },
  );
}
