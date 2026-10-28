'use strict';
// npm run build (macOS .dmg and .zip), build:win (Windows installer .exe) and build:dir:
// electron-builder with the build number taken from the commit count. On macOS it is
// CFBundleVersion (About shows it); on Windows the fourth part of the file version (1.0.0.87).
// A script rather than "$(git …)" in package.json, which only a Unix shell understands.
//
//   node build/build.cjs --mac | --win [more electron-builder options]
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function buildNumber() {
  try {
    const count = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^\d+$/.test(count) ? count : '0';
  } catch {
    return '0';
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const number = buildNumber();
  const cli = require.resolve('electron-builder/cli.js', { paths: [ROOT] });
  // Windows takes the number from BUILD_NUMBER; a buildVersion would become its file version.
  const extra = args.includes('--win') ? [] : [`-c.buildVersion=${number}`];
  const result = spawnSync(process.execPath, [cli, ...args, ...extra, '--publish', 'never'], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, BUILD_NUMBER: number },
  });
  process.exit(result.status === null ? 1 : result.status);
}

module.exports = { buildNumber };
