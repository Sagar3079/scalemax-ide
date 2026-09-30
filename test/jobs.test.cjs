'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createJobManager } = require('../lib/jobs.cjs');
const { commandLine, cleanOutput, shellArgv } = require('../lib/commands.cjs');
const sandbox = require('../lib/sandbox.cjs');
const { createWorkspace } = require('../lib/workspace.cjs');
const { createWorkspaceTools } = require('../lib/workspace-tools.cjs');

const mac = process.platform === 'darwin';
const macSandbox = { skip: !sandbox.available() && 'needs macOS sandbox-exec' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function folder(t, prefix = 'sm-jobs-') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function manager(t) {
  const jobs = createJobManager({ environment: () => ({ PATH: process.env.PATH, HOME: os.homedir() }) });
  t.after(() => jobs.stopAll());
  return jobs;
}
async function until(test, ms = 5000) {
  const started = Date.now();
  while (!test() && Date.now() - started < ms) await sleep(25);
  return test();
}

test('terminal output is cleaned for the model: colours, CRLF, redrawn lines', () => {
  assert.equal(cleanOutput('\x1b[32mok\x1b[0m done\r\n'), 'ok done\n');
  assert.equal(cleanOutput('downloading 10%\rdownloading 50%\rdownloading 100%\nnext'), 'downloading 100%\nnext');
  assert.equal(cleanOutput('\x1b]0;title\x07prompt> \x1b[2K\x1b[1Gprompt> ls'), 'prompt> prompt> ls');
  assert.equal(cleanOutput('half line\r'), 'half line');
  assert.equal(cleanOutput('bell\x07 and nul\x00 gone'), 'bell and nul gone');
});

test('command lines: the shell, a terminal on request, the sandbox around it', () => {
  assert.deepEqual(shellArgv('ls', { platform: 'darwin' }), ['/bin/zsh', '-f', '-c', 'ls']);
  assert.deepEqual(shellArgv('ls', { platform: 'linux' }), ['/bin/sh', '-c', 'ls']);
  const tty = shellArgv('ls', { platform: 'darwin', tty: true });
  assert.equal(tty[0], '/bin/zsh');
  assert.match(tty[3], /\/usr\/bin\/script -q \/dev\/null/);
  assert.equal(tty.at(-1), 'ls', 'the command is passed as an argument, never pasted into the wrapper');
  const boxed = commandLine('echo "a b"', { platform: 'darwin', box: { project: '/Users/x/p', network: false, appData: '/Users/x/data' } });
  assert.equal(boxed.file, '/usr/bin/sandbox-exec');
  assert.ok(boxed.args.includes('PROJECT=/Users/x/p'));
  assert.ok(boxed.args.includes('APPDATA=/Users/x/data'));
  assert.deepEqual(boxed.args.slice(-4), ['/bin/zsh', '-f', '-c', 'echo "a b"']);
  assert.throws(() => sandbox.wrap(['x'], { project: 'relative', appData: '/a' }), /absolute project/);
});

test('the sandbox profile: paths only as parameters, network rules only when off', () => {
  const online = sandbox.profile({ network: true });
  const offline = sandbox.profile({ network: false });
  assert.equal(online.includes('network-outbound'), false);
  assert.match(offline, /\(deny network-outbound\)/);
  assert.match(offline, /mDNSResponder/);
  assert.match(online, /osascript/);
  assert.match(online, /\(deny signal\)/);
  assert.equal(/\/Users\//.test(online), false, 'no home path written into the rules');
  assert.match(online, /\.git\/hooks/);
  assert.equal(sandbox.available({ platform: 'linux' }), false);
  assert.match(sandbox.refusalHint('zsh: operation not permitted: /etc/x'), /sandbox: false/);
  assert.equal(sandbox.refusalHint('all fine'), '');
});

test('inside the sandbox: the project changes, the rest of the disk and .git/hooks do not', macSandbox, (t) => {
  const project = folder(t, 'sm-sbx-project-');
  const outside = folder(t, 'sm-sbx-outside-');
  // Outside means outside every allowed place: a folder in the home folder's Library would be a
  // cache, so a fresh folder next to the project stands in, with the project itself as a sibling
  // denied by making it the app data folder.
  const appData = folder(t, 'sm-sbx-appdata-');
  fs.writeFileSync(path.join(appData, 'state.json'), 'secret');
  fs.mkdirSync(path.join(project, '.git', 'hooks'), { recursive: true });
  const run = (command, box = { project, network: true, appData }) => {
    const { file, args } = commandLine(command, { box });
    return spawnSync(file, args, { cwd: project, encoding: 'utf8' });
  };
  // The rules match real paths: a folder named through a link is protected all the same.
  const link = path.join(outside, 'appdata-link');
  fs.symlinkSync(appData, link);
  assert.notEqual(run(`cat ${JSON.stringify(path.join(appData, 'state.json'))}`, { project, network: true, appData: link }).status, 0);
  assert.equal(run('echo inside > made.txt').status, 0);
  assert.equal(fs.readFileSync(path.join(project, 'made.txt'), 'utf8'), 'inside\n');
  const hook = run('echo x > .git/hooks/pre-commit');
  assert.notEqual(hook.status, 0);
  assert.match(hook.stderr, /operation not permitted/i);
  const config = run('echo x > .git/config');
  assert.notEqual(config.status, 0);
  assert.match(config.stderr, /operation not permitted/i);
  // A nested repository or a symlink cannot make a hook writable under another spelling.
  assert.notEqual(run('mkdir -p nested && mkdir nested/.git').status, 0);
  fs.symlinkSync(path.join(project, '.git', 'hooks'), path.join(project, 'sneaky-hooks'));
  assert.notEqual(run('echo x > sneaky-hooks/pre-push').status, 0);
  // Commands cannot drive desktop applications or signal another process under the model sandbox.
  const desktop = run(`osascript -e 'tell application "Finder" to get name'`);
  assert.notEqual(desktop.status, 0);
  assert.match(desktop.stderr, /operation not permitted/i);
  const victim = spawn('/bin/sleep', ['10']);
  t.after(() => { try { victim.kill('SIGKILL'); } catch { /* already ended */ } });
  const signal = run(`kill ${victim.pid}`);
  assert.match(`${signal.stdout}${signal.stderr}`, /operation not permitted/i);
  assert.doesNotThrow(() => process.kill(victim.pid, 0), 'the sandbox did not signal another process');
  // Network-off leaves local services and Unix sockets usable, but not public DNS through the
  // mDNSResponder socket (otherwise looking a name up leaks it to the network).
  const offline = run(`node -e "require('dns').lookup('example.com',(error, address) => console.log(error ? error.code : address))"`, { project, network: false, appData });
  assert.match(offline.stdout, /ENOTFOUND|EAI_AGAIN/);
  const local = run(`node -e "require('dns').lookup('localhost',(error, address) => console.log(error ? error.code : address))"`, { project, network: false, appData });
  assert.match(local.stdout, /127\.0\.0\.1|::1/);
  const secret = run(`cat ${JSON.stringify(path.join(appData, 'state.json'))}`);
  assert.notEqual(secret.status, 0, 'ScaleMax data cannot be read');
  // The temporary folders stay writable (compilers and tests need them).
  assert.equal(run('echo t > "$TMPDIR/sm-sbx-probe.txt" 2>/dev/null || echo t > /private/tmp/sm-sbx-probe.txt').status, 0);
  fs.rmSync('/private/tmp/sm-sbx-probe.txt', { force: true });
  assert.ok(outside);
});

test('a background job runs, is read from offsets, waits, and ends with its code', async (t) => {
  const root = folder(t);
  const jobs = manager(t);
  const job = jobs.start({ root, command: 'echo first; sleep 0.3; echo second; exit 3' });
  assert.equal(job.id.startsWith('j'), true);
  assert.equal(job.status, 'running');
  await jobs.wait(job.id, { from: 0, ms: 3000 });
  const early = jobs.read(job.id);
  assert.match(early.text, /first/);
  await jobs.wait(job.id, { ms: 5000, untilEnd: true });
  const done = jobs.read(job.id, { from: early.to });
  assert.equal(done.text, 'second\n');
  assert.equal(done.status, 'failed');
  assert.equal(done.exitCode, 3);
  assert.equal(jobs.list()[0].id, job.id);
  assert.equal(jobs.list('/elsewhere').length, 0, 'jobs belong to their folder');
  assert.throws(() => jobs.read(job.id, { root: '/elsewhere' }), /no background command/);
});

test('input reaches a waiting program; stop ends it and what it started', { skip: !mac && 'uses zsh' }, async (t) => {
  const root = folder(t);
  const jobs = manager(t);
  const job = jobs.start({ root, command: 'printf "name? "; read name; echo "hello $name"; sleep 31.25 & wait' });
  await until(() => jobs.read(job.id).text.includes('name?'));
  jobs.write(job.id, 'Ada\n');
  await until(() => jobs.read(job.id).text.includes('hello Ada'));
  const stopped = await jobs.stop(job.id, { graceMs: 500 });
  assert.equal(stopped.status, 'stopped');
  assert.throws(() => jobs.write(job.id, 'late\n'), /not running/);
  await sleep(300);
  const left = spawnSync('/bin/ps', ['-A', '-o', 'command']).stdout.toString().split('\n').filter((line) => line.startsWith('sleep 31.25')).length;
  assert.equal(left, 0, 'the program it started in the background ended too');
});

test('a job in a terminal gets a tty and answers prompts', { skip: !mac && 'uses script(1)' }, async (t) => {
  const root = folder(t);
  const jobs = manager(t);
  const job = jobs.start({ root, command: 'test -t 1 && echo tty-yes; printf "ok? "; read answer; echo "got $answer"', tty: true });
  await until(() => jobs.read(job.id).text.includes('ok?'));
  jobs.write(job.id, 'yes\n');
  await jobs.wait(job.id, { ms: 5000, untilEnd: true });
  const { text, status } = jobs.read(job.id);
  assert.match(text, /tty-yes/);
  assert.match(text, /got yes/);
  assert.equal(status, 'exited');
});

test('a job ends when its command ends, even if it left a program behind', async (t) => {
  const root = folder(t);
  const jobs = manager(t);
  const job = jobs.start({ root, command: 'sleep 30 & echo started' });
  await jobs.wait(job.id, { ms: 5000, untilEnd: true });
  assert.equal(jobs.get(job.id).status, 'exited');
});

test('limits: eight running jobs, the output keeps its end', async (t) => {
  const root = folder(t);
  const jobs = manager(t);
  const started = Array.from({ length: 8 }, () => jobs.start({ root, command: 'sleep 30' }));
  assert.throws(() => jobs.start({ root, command: 'sleep 30' }), /At most 8/);
  await Promise.all(started.map((job) => jobs.stop(job.id, { graceMs: 200 })));
  const noisy = jobs.start({ root, command: `node -e "process.stdout.write('x'.repeat(1500000) + 'END')"` });
  await jobs.wait(noisy.id, { ms: 10000, untilEnd: true });
  const read = jobs.read(noisy.id);
  assert.ok(read.text.endsWith('END'));
  assert.ok(read.dropped > 0, 'the start was dropped');
  assert.ok(read.text.length <= 1024 * 1024);
  assert.throws(() => jobs.start({ root, command: '' }), /command line/);
});

// A child process that prints what the test says.
function fakeSpawn() {
  const { EventEmitter } = require('node:events');
  const children = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { written: [], destroyed: false, write(text) { this.written.push(text); }, end() { this.destroyed = true; } });
    child.kill = () => {};
    children.push(child);
    return child;
  };
  return { spawnImpl, children };
}

test('a line still being written is read again from its start; a half-written terminal code waits', () => {
  const { spawnImpl, children } = fakeSpawn();
  const jobs = createJobManager({ spawnImpl, platform: 'darwin' });
  const job = jobs.start({ root: '/p', command: 'progress' });
  const out = (text) => children[0].stdout.emit('data', Buffer.from(text));
  out('step 1\nloading 10%');
  let read = jobs.read(job.id);
  assert.deepEqual([read.complete, read.partial, read.lineStart, read.to], ['step 1\n', 'loading 10%', 7, 18]);
  out('\rloading 90%\x1b[3');
  read = jobs.read(job.id, { from: read.lineStart });
  assert.deepEqual([read.complete, read.partial, read.from], ['', 'loading 90%', 7]);
  assert.equal(read.to, 'step 1\nloading 10%\rloading 90%'.length, 'the unfinished code is left for later');
  out('2mdone\x1b[0m\n');
  read = jobs.read(job.id, { from: read.lineStart });
  assert.deepEqual([read.complete, read.partial, read.text], ['loading 90%done\n', '', 'loading 90%done\n']);
  assert.deepEqual(jobs.read(job.id, { from: Number.MAX_SAFE_INTEGER }).text, '');
  jobs.write(job.id, 'q');
  assert.deepEqual(children[0].stdin.written, ['q']);
  children[0].emit('exit', 0, null);
  assert.equal(jobs.get(job.id).status, 'exited');
  assert.equal(children[0].stdin.destroyed, true);
});

// ---- The model's tools --------------------------------------------------------------------

async function tools(t, { policy = null } = {}) {
  const root = folder(t, 'sm-jobtools-');
  const workspace = createWorkspace({ approve: async () => true });
  t.after(() => workspace.dispose());
  await workspace.select(root);
  const jobs = manager(t);
  return { root, jobs, workspace, tools: createWorkspaceTools({ getWorkspace: () => workspace, jobs, commandPolicy: () => policy }) };
}

test('the model starts a background command, reads new output, types into it and stops it', { skip: !mac && 'uses zsh' }, async (t) => {
  const { tools: tool } = await tools(t);
  const started = await tool.call('run_command', { command: 'echo ready; while read line; do echo "got $line"; done', background: true, wait_seconds: 1 });
  const id = /Background command (j\d+)/.exec(started.text)[1];
  assert.match(started.text, /running for/);
  assert.match(started.text, /ready/);
  const nothing = await tool.call('job_output', { job: id });
  assert.match(nothing.text, /\(no new output\)/);
  const typed = await tool.call('job_input', { job: id, text: 'ping' });
  assert.match(typed.text, /got ping/);
  const again = await tool.call('job_output', { job: id });
  assert.match(again.text, /\(no new output\)/, 'output the model saw is not repeated');
  assert.match((await tool.call('list_jobs', {})).text, new RegExp(`${id} · running`));
  const stopped = await tool.call('job_stop', { job: id });
  assert.match(stopped.text, /Stopped background command/);
  assert.match((await tool.call('job_stop', { job: id })).text, /not running: stopped/);
  await assert.rejects(tool.call('job_output', { job: 'j999' }), /no background command/);
  assert.equal(tool.describeCall('job_output', { job: id }), `Checked echo ready; while read line; do echo "got $line"; done (${id})`);
  assert.equal(tool.describeCall('run_command', { command: 'npm run dev', background: true }), 'Started npm run dev in the background');
});

test('waiting for output returns as soon as it comes; a failing background command reports it', async (t) => {
  const { tools: tool } = await tools(t);
  const started = await tool.call('run_command', { command: 'sleep 0.5; echo late', background: true, wait_seconds: 0 });
  const id = /Background command (j\d+)/.exec(started.text)[1];
  const begun = Date.now();
  const waited = await tool.call('job_output', { job: id, wait_seconds: 10 });
  assert.ok(Date.now() - begun < 5000);
  assert.match(waited.text, /late/);
  const failing = await tool.call('run_command', { command: 'echo broken >&2; exit 2', background: true, wait_seconds: 5 });
  assert.match(failing.text, /failed \(exit code 2\)/);
  assert.match(failing.text, /It has already ended/);
});

test('with the sandbox on, the tools say so and outside-sandbox jobs always ask before input too', async (t) => {
  const policy = { sandbox: true, network: false, appData: '/private/tmp/sm-no-such-appdata' };
  const { tools: boxed, jobs, root } = await tools(t, { policy });
  const run = boxed.definitions().find((definition) => definition.function.name === 'workspace_run').function;
  assert.match(run.description, /sandbox without network/);
  assert.ok(run.description.length <= 1024);
  assert.ok(run.parameters.properties.sandbox);
  const target = boxed.resolve('workspace_run');
  assert.equal(target.alwaysAsk({ command: 'x', sandbox: false }), 'unsandboxed');
  assert.equal(target.alwaysAsk({ command: 'x' }), '');
  const outsideJob = jobs.start({ root, command: 'sleep 30' });
  const jobInput = boxed.resolve('workspace_job_input');
  assert.equal(jobInput.alwaysAsk({ job: outsideJob.id, text: 'anything' }), 'unsandboxed-input');
  assert.equal(jobInput.alwaysAsk({ job: 'j999', text: 'anything' }), '');
  const { tools: plain } = await tools(t);
  const open = plain.definitions().find((definition) => definition.function.name === 'workspace_run').function;
  assert.equal(open.description.includes('sandbox'), false);
  assert.equal(open.parameters.properties.sandbox, undefined);
  assert.equal(plain.resolve('workspace_run').alwaysAsk({ sandbox: false }), '');
  for (const definition of boxed.definitions()) assert.ok(definition.function.description.length <= 1024, definition.function.name);
});

test('a sandboxed command that is refused tells the model what the sandbox allows', macSandbox, async (t) => {
  const appData = folder(t, 'sm-sbx-tool-appdata-');
  const { tools: tool, root } = await tools(t, { policy: { sandbox: true, network: true, appData } });
  fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
  const refused = await tool.call('run_command', { command: 'echo x > .git/hooks/pre-commit' });
  assert.match(refused.text, /operation not permitted/i);
  assert.match(refused.text, /run just it again with sandbox: false/);
  const fine = await tool.call('run_command', { command: 'echo ok > inside.txt && cat inside.txt' });
  assert.match(fine.text, /Exit code: 0/);
  const outside = await tool.call('run_command', { command: 'echo x > .git/hooks/pre-commit && echo done', sandbox: false });
  assert.match(outside.text, /done/, 'outside the sandbox (after the user agreed) it works');
});
