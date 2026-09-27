'use strict';

// Renders the ScaleMax agent icon sources (assets/icons/*.svg) into the files
// the app and the packager use: icon.png (1024 px, Dock / window icon) and
// icon.icns (macOS bundle icon). Uses Electron's own Chromium, so it needs no
// extra dependencies. Run with: npm run icons   (icon.icns needs macOS iconutil)
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DIR = path.join(__dirname, '..', 'assets', 'icons');
const FULL = 'scalemax-icon.svg';
// 16 and 32 px use a simplified drawing (bigger head, no microphone or shoulders).
const SMALL = 'scalemax-icon-small.svg';
const ICONSET = [
  ['icon_16x16.png', 16, SMALL], ['icon_16x16@2x.png', 32, SMALL],
  ['icon_32x32.png', 32, SMALL], ['icon_32x32@2x.png', 64, FULL],
  ['icon_128x128.png', 128, FULL], ['icon_128x128@2x.png', 256, FULL],
  ['icon_256x256.png', 256, FULL], ['icon_256x256@2x.png', 512, FULL],
  ['icon_512x512.png', 512, FULL], ['icon_512x512@2x.png', 1024, FULL],
];

async function render(win, file, size) {
  const svg = fs.readFileSync(path.join(DIR, file));
  const uri = `data:image/svg+xml;base64,${svg.toString('base64')}`;
  // The SVG is rasterised at the target size (vector, not a downscaled bitmap).
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(uri)};
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = ${size};
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, ${size}, ${size});
    return canvas.toDataURL('image/png');
  })()`);
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

async function main() {
  if (app.dock) app.dock.hide();
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL('data:text/html,<!doctype html><title>icons</title>');
  fs.writeFileSync(path.join(DIR, 'icon.png'), await render(win, FULL, 1024));
  console.log('[ScaleMax] wrote assets/icons/icon.png (1024 px)');
  if (process.platform !== 'darwin') {
    console.log('[ScaleMax] icon.icns needs macOS iconutil; skipped.');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scalemax-icons-'));
  const iconset = path.join(tmp, 'ScaleMax.iconset');
  fs.mkdirSync(iconset);
  try {
    for (const [name, size, file] of ICONSET) fs.writeFileSync(path.join(iconset, name), await render(win, file, size));
    execFileSync('iconutil', ['-c', 'icns', '-o', path.join(DIR, 'icon.icns'), iconset]);
    console.log('[ScaleMax] wrote assets/icons/icon.icns (16-1024 px)');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0), (error) => { console.error(`[ScaleMax] ${error.stack || error}`); app.exit(1); });
