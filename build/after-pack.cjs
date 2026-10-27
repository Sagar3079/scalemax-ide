'use strict';

// electron-builder afterPack hook: ad-hoc signs the packaged macOS app.
//
// Without it the bundle keeps only the Electron binary's linker signature, which seals neither
// Info.plist nor the resources, so a copy downloaded from the internet is reported as "damaged"
// and macOS offers no way to open it. An ad-hoc signature seals the whole bundle; macOS then
// treats a downloaded copy as an app from an unidentified developer, which the user can allow in
// System Settings → Privacy & Security (see README "Install the app").
//
// package.json sets build.mac.identity to null, so electron-builder skips its own signing and keeps
// this signature. With a Developer ID certificate, remove that and this hook, and notarize instead.
const path = require('node:path');
const { execFileSync } = require('node:child_process');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
