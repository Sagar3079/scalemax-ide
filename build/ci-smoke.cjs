'use strict';
// CI: runs the end-to-end smoke check (build/smoke-check.cjs, SCALEMAX_SMOKE=1 npm start) and
// fails the job unless every check passed, naming the ones that did not.
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TIMEOUT_MS = 8 * 60 * 1000;

function parseResult(output) {
  const at = output.indexOf('SMOKE_RESULT ');
  if (at < 0) return null;
  const start = output.indexOf('{', at);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < output.length; i += 1) {
    const char = output[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return JSON.parse(output.slice(start, i + 1));
  }
  return null;
}

if (require.main === module) {
  let output = '';
  const child = spawn(process.execPath, [path.join(ROOT, 'build', 'dev-app.cjs'), '--run'], {
    cwd: ROOT, env: { ...process.env, SCALEMAX_SMOKE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const keep = (chunk) => { output += chunk; process.stdout.write(chunk); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const timer = setTimeout(() => { console.error('[ci-smoke] timed out'); child.kill(); }, TIMEOUT_MS);
  child.on('close', (code) => {
    clearTimeout(timer);
    let result = null;
    try { result = parseResult(output); } catch (error) { console.error(`[ci-smoke] unreadable result: ${error.message}`); }
    if (!result) {
      console.error(`[ci-smoke] no SMOKE_RESULT (exit ${code})`);
      process.exit(1);
    }
    const failed = Object.entries(result.checks || {}).filter(([, ok]) => ok !== true).map(([name]) => name);
    const total = Object.keys(result.checks || {}).length;
    console.log(`\n[ci-smoke] ${total - failed.length}/${total} checks passed${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
    if (result.errors?.length) console.log(`[ci-smoke] page errors: ${JSON.stringify(result.errors).slice(0, 2000)}`);
    process.exit(result.ok === true && failed.length === 0 ? 0 : 1);
  });
}

module.exports = { parseResult };
