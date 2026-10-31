'use strict';
// CI: starts an installed or packaged copy of the app on a throwaway profile and checks that its
// window loads the page, then closes it. Exits non-zero when it does not.
//
//   node build/ci-launch.cjs <path to the app's executable>
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 9339;
const WAIT_MS = 60_000;

/** Runs `expression` in the app's page (DevTools on PORT): its value, or null without a page. */
async function evaluate(expression, { awaitPromise = false } = {}) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((entry) => entry.type === 'page' && entry.url.endsWith('index.html'));
  if (!page) return null;
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  try {
    const reply = await new Promise((resolve, reject) => {
      socket.onmessage = (message) => resolve(JSON.parse(message.data));
      socket.onclose = () => reject(new Error('The page closed before it answered'));
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } }));
    });
    return reply.result?.result?.value || null;
  } finally {
    socket.close();
  }
}

function pageState() {
  return evaluate(`({ ready: document.readyState, platform: document.documentElement.dataset.platform || '',
    title: document.title, provider: (document.querySelector('#provider-status') || {}).textContent || '',
    views: document.querySelectorAll('.view').length })`);
}

async function main(executable) {
  if (!executable || !fs.existsSync(executable)) throw new Error(`No app at ${executable}`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'scalemax-launch-'));
  const child = spawn(executable, [`--remote-debugging-port=${PORT}`], {
    env: { ...process.env, SCALEMAX_USER_DATA: profile }, stdio: 'inherit',
  });
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  const started = Date.now();
  let state = null;
  while (Date.now() - started < WAIT_MS && exited === null) {
    try {
      state = await pageState();
      if (state?.ready === 'complete' && state.views > 0) break;
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  child.kill();
  console.log(`[ci-launch] ${JSON.stringify(state)}`);
  if (exited !== null) throw new Error(`The app exited early with code ${exited}`);
  if (state?.ready !== 'complete' || !(state.views > 0)) throw new Error('The window did not load the page in time.');
  console.log('[ci-launch] the app started and loaded its page');
}

if (require.main === module) {
  main(process.argv[2]).then(() => process.exit(0), (error) => { console.error(`[ci-launch] ${error.message}`); process.exit(1); });
}

module.exports = { PORT, evaluate, pageState, launch: main };
