'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  parseHooks, hooksHash, hookId, toolMatches, readHooks, loadScopes, createHookApprovals, hookEnvironment, runHook,
  createHookSet, withPromptContext, taskIdOf, SETTINGS_PATH,
} = require('../lib/hooks.cjs');
const { createWorkspace } = require('../lib/workspace.cjs');
const { createWorkspaceTools, combineToolSources } = require('../lib/workspace-tools.cjs');
const { createToolLoop } = require('../lib/tool-loop.cjs');
const { commandLine } = require('../lib/commands.cjs');
const sandbox = require('../lib/sandbox.cjs');

const macSandbox = { skip: !sandbox.available() && 'needs macOS sandbox-exec' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Real folders for real hook scripts: /private/tmp (the canonical /tmp on macOS) when there is one.
const TEMP = fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir();
function folder(t, prefix = 'sm-hooks-') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(TEMP, prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function settings(root, hooks) {
  fs.mkdirSync(path.join(root, '.scalemax'), { recursive: true });
  fs.writeFileSync(path.join(root, SETTINGS_PATH), JSON.stringify({ hooks }, null, 2));
}
async function session(t, root) {
  const workspace = createWorkspace({ approve: async () => true });
  t.after(() => workspace.dispose());
  await workspace.select(root);
  return workspace;
}
function hookSet(root, hooks, extra = {}) {
  return createHookSet({
    hooks,
    cwd: root,
    env: hookEnvironment({ env: { PATH: process.env.PATH, HOME: os.homedir() }, folder: root }),
    base: { cwd: root, folder: root, task_id: 'task-1', request_id: 'chat-task-1-5' },
    ...extra,
  });
}
const WRITE = Object.freeze({ name: 'workspace_write', serverId: 'Workspace', toolName: 'write_file', input: { path: 'a.txt', content: 'x' } });

test('the settings file: hooks per event, matchers for tool events, mistakes named and left out', () => {
  const parsed = parseHooks(JSON.stringify({
    theme: 'dark',
    hooks: {
      PreToolUse: [
        { matcher: 'workspace_(write|edit)', hooks: [{ type: 'command', command: './check.sh', timeout: 10 }] },
        { hooks: [{ command: 'echo any', timeout: 9999 }, { type: 'prompt', command: 'x' }, { type: 'command', command: '' }] },
      ],
      UserPromptSubmit: [{ matcher: 'ignored', hooks: [{ type: 'command', command: 'date' }] }],
      Stop: { not: 'a list' },
      Bogus: [],
    },
  }));
  assert.deepEqual(parsed.hooks, [
    { event: 'PreToolUse', matcher: 'workspace_(write|edit)', command: './check.sh', timeout: 10 },
    { event: 'PreToolUse', matcher: '', command: 'echo any', timeout: 30 },
    { event: 'UserPromptSubmit', matcher: '', command: 'date', timeout: 30 },
  ]);
  assert.equal(parsed.errors.length, 5, parsed.errors.join('\n'));
  assert.ok(parsed.errors.some((error) => /Unknown hook event "Bogus"/.test(error)));
  assert.ok(parsed.errors.some((error) => /timeout must be 1 to 600 seconds/.test(error)));
  assert.deepEqual(parseHooks('{ not json').hooks, []);
  assert.match(parseHooks('{ not json').errors[0], /not valid JSON/);
  assert.deepEqual(parseHooks('{"theme":"dark"}'), { hooks: [], errors: [] }, 'settings without hooks are fine');
  assert.match(parseHooks('[]').errors[0], /JSON object/);
});

test('the approval hash covers exactly the hooks; ids tell scopes and folders apart', () => {
  const hooks = parseHooks(JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'x', hooks: [{ command: 'a' }] }] } })).hooks;
  assert.match(hooksHash(hooks), /^[a-f0-9]{64}$/);
  assert.equal(hooksHash(hooks), hooksHash(structuredClone(hooks)));
  assert.notEqual(hooksHash(hooks), hooksHash([{ ...hooks[0], command: 'a ' }]), 'one character of a command changes it');
  assert.notEqual(hooksHash(hooks), hooksHash([{ ...hooks[0], timeout: 31 }]));
  assert.notEqual(hooksHash(hooks), hooksHash([]));
  assert.notEqual(hookId('project', '/a', hooks[0]), hookId('project', '/b', hooks[0]));
  assert.equal(hookId('user', '/a', hooks[0]), hookId('user', '/b', hooks[0]), 'the user\'s hooks are the same in every folder');
  assert.match(hookId('user', '', hooks[0]), /^[a-f0-9]{16}$/);
});

test('matchers: exact names, a regular expression for the whole name, or every tool', () => {
  assert.equal(toolMatches('workspace_(write|edit)', ['workspace_write']), true);
  assert.equal(toolMatches('workspace_(write|edit)', ['workspace_write_more']), false, 'the whole name');
  assert.equal(toolMatches('write_file', ['workspace_write', 'write_file']), true, 'the tool\'s own name counts too');
  assert.equal(toolMatches('', ['anything']), true);
  assert.equal(toolMatches('*', ['anything']), true);
  assert.equal(toolMatches('mcp_.*', ['mcp_github_search']), true);
  assert.equal(toolMatches('(', ['(']), true, 'an invalid expression still matches exactly');
  assert.equal(toolMatches('(', ['x']), false);
  assert.equal(taskIdOf('chat-task-17-abc-1700000000'), 'task-17-abc');
  assert.equal(taskIdOf('automation-x'), '');
});

test('a hook reads the event on stdin and runs in the folder, with the PATH and none of ScaleMax\'s secrets', async (t) => {
  const root = folder(t);
  const environment = hookEnvironment({ env: { PATH: process.env.PATH, HOME: '/Users/somebody', OPENAI_API_KEY: 'sk-secret', LANG: 'C' }, folder: root });
  assert.equal(environment.OPENAI_API_KEY, undefined);
  const set = createHookSet({
    hooks: [{ event: 'PreToolUse', matcher: 'workspace_write', command: 'cat > stdin.json; pwd > cwd.txt; env > env.txt', timeout: 10 }],
    cwd: root, env: environment,
    base: { cwd: root, folder: root, task_id: 'task-1', request_id: 'chat-task-1-5' },
  });
  assert.equal(set.count, 1);
  assert.equal(set.has('PreToolUse', { name: 'workspace_read', toolName: 'read_file' }), false);
  assert.equal(set.has('PostToolUse', WRITE), false);
  assert.equal(set.has('PreToolUse', WRITE), true);
  const events = [];
  const outcome = await set.run('PreToolUse', WRITE, { report: (event) => events.push(event), nextCallId: () => 'step-9' });
  assert.equal(outcome.block, false);
  assert.equal(outcome.allow, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'stdin.json'), 'utf8')), {
    hook_event_name: 'PreToolUse', cwd: root, folder: root, task_id: 'task-1', request_id: 'chat-task-1-5',
    tool_name: 'workspace_write', tool_input: { path: 'a.txt', content: 'x' }, server: 'Workspace', tool: 'write_file',
  });
  assert.equal(fs.readFileSync(path.join(root, 'cwd.txt'), 'utf8').trim(), root);
  const env = fs.readFileSync(path.join(root, 'env.txt'), 'utf8');
  assert.match(env, new RegExp(`^SCALEMAX_PROJECT_DIR=${root}$`, 'm'));
  assert.match(env, /^SCALEMAX_HOOK_EVENT=PreToolUse$/m);
  assert.match(env, /^HOME=\/Users\/somebody$/m);
  assert.ok(!env.includes('sk-secret'));
  assert.equal(outcome.steps.length, 1);
  assert.match(outcome.steps[0].title, /^PreToolUse hook: cat > stdin\.json; pwd > cwd\.txt; env > env\.txt \(ok, \d+\.\ds\)$/);
  assert.equal(outcome.steps[0].server, 'Hooks');
  assert.equal(outcome.steps[0].ok, true);
  assert.deepEqual(events.map((event) => [event.phase, event.callId]), [['tool', 'step-9'], ['tool', 'step-9'], ['tool-done', 'step-9']]);
  assert.equal(events[0].serverId, 'Hooks');
  assert.equal(events[1].title, outcome.steps[0].title, 'the live step ends with the final title');
});

test('PreToolUse: exit 2 blocks with stderr, JSON can block or allow, other exits block nothing', async (t) => {
  const root = folder(t);
  const hook = (command, matcher = '') => ({ event: 'PreToolUse', matcher, command, timeout: 10 });
  const exit2 = await hookSet(root, [hook('echo "no writes outside src/" >&2; exit 2')]).run('PreToolUse', WRITE);
  assert.equal(exit2.block, true);
  assert.equal(exit2.reason, 'no writes outside src/');
  assert.match(exit2.steps[0].title, /\(blocked, /);
  assert.equal(exit2.steps[0].ok, false);
  // Blocking is what it is for: its step says so (not a failure), and the run names the hook.
  assert.equal(exit2.steps[0].outcome, 'blocked');
  assert.equal(exit2.hook, 'echo "no writes outside src/" >&2; exit 2');
  const json = await hookSet(root, [hook('echo \'{"decision":"block","reason":"policy says no"}\'')]).run('PreToolUse', WRITE);
  assert.deepEqual([json.block, json.reason], [true, 'policy says no']);
  const allow = await hookSet(root, [hook('echo \'{"decision":"allow"}\'')]).run('PreToolUse', WRITE);
  assert.deepEqual([allow.block, allow.allow], [false, true]);
  assert.match(allow.steps[0].title, /\(allowed, /);
  const specific = await hookSet(root, [hook('echo \'{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"no"}}\'')]).run('PreToolUse', WRITE);
  assert.deepEqual([specific.block, specific.reason], [true, 'no']);
  const broken = await hookSet(root, [hook('echo broken >&2; exit 1')]).run('PreToolUse', WRITE);
  assert.deepEqual([broken.block, broken.allow], [false, false]);
  assert.match(broken.steps[0].title, /\(failed, /);
  assert.equal(broken.steps[0].ok, false);
  assert.equal(broken.steps[0].outcome, undefined, 'a hook that failed is a failure');
  assert.equal(broken.steps[0].preview, 'broken');
  // The first hook that blocks ends the run: the next one never starts, and an allow before it
  // does not count.
  const order = await hookSet(root, [hook('echo \'{"decision":"allow"}\''), hook('exit 2'), hook('touch ran.txt')]).run('PreToolUse', WRITE);
  assert.deepEqual([order.block, order.allow, order.steps.length], [true, false, 2]);
  assert.equal(order.reason, 'A hook blocked this.');
  assert.equal(fs.existsSync(path.join(root, 'ran.txt')), false);
});

test('a hook past its time limit is stopped with everything it started, and blocks nothing', async (t) => {
  const root = folder(t);
  const started = Date.now();
  const outcome = await hookSet(root, [{ event: 'PreToolUse', matcher: '', command: 'sleep 37 & echo $! > child.pid; wait', timeout: 1 }]).run('PreToolUse', WRITE);
  assert.ok(Date.now() - started < 5000, 'stopped at its limit');
  assert.equal(outcome.block, false);
  assert.match(outcome.steps[0].title, /\(timed out, 1\.\ds\)$/);
  const pid = Number(fs.readFileSync(path.join(root, 'child.pid'), 'utf8'));
  let alive = true;
  for (let tries = 0; tries < 40 && alive; tries += 1) {
    try {
      process.kill(pid, 0);
      await sleep(50);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, 'the background child went with it');
});

test('a hook that leaves something running in the background does not hold the reply', async (t) => {
  const root = folder(t);
  const started = Date.now();
  const outcome = await hookSet(root, [{ event: 'UserPromptSubmit', matcher: '', command: 'sleep 41 & echo $! > bg.pid; echo "context now"', timeout: 20 }])
    .run('UserPromptSubmit', { prompt: 'x' });
  const pid = Number(fs.readFileSync(path.join(root, 'bg.pid'), 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* already ended */ } });
  assert.ok(Date.now() - started < 3000, 'done once the hook itself ended');
  assert.equal(outcome.context, 'context now');
  assert.match(outcome.steps[0].title, /\(ok, /);
});

test('Stop ends a running hook at once', async (t) => {
  const root = folder(t);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const started = Date.now();
  const result = await runHook({ command: 'sleep 38', timeout: 30 }, {}, { cwd: root, signal: controller.signal });
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.aborted, true);
  const outcome = await hookSet(root, [{ event: 'Stop', matcher: '', command: 'touch never.txt', timeout: 5 }]).run('Stop', { text: 'done' }, { signal: AbortSignal.abort() });
  assert.deepEqual(outcome.steps, [], 'an aborted run starts nothing');
  assert.equal(fs.existsSync(path.join(root, 'never.txt')), false);
});

test('PostToolUse notes, UserPromptSubmit context and blocks, Stop never blocks', async (t) => {
  const root = folder(t);
  const post = await hookSet(root, [{ event: 'PostToolUse', matcher: 'write_file', command: 'cat > post.json; echo "lint: 2 warnings"', timeout: 10 }])
    .run('PostToolUse', { ...WRITE, ok: true, output: 'Created a.txt (1 bytes).' });
  assert.equal(post.note, 'lint: 2 warnings');
  const input = JSON.parse(fs.readFileSync(path.join(root, 'post.json'), 'utf8'));
  assert.equal(input.tool_response, 'Created a.txt (1 bytes).');
  assert.equal(input.tool_ok, true);
  const postBlock = await hookSet(root, [{ event: 'PostToolUse', matcher: '', command: 'echo "tests now fail" >&2; exit 2', timeout: 10 }]).run('PostToolUse', WRITE);
  assert.deepEqual([postBlock.block, postBlock.note], [false, 'tests now fail'], 'the call already ran: its objection is a note');

  const prompt = (command) => hookSet(root, [{ event: 'UserPromptSubmit', matcher: '', command, timeout: 10 }]).run('UserPromptSubmit', { prompt: 'fix the bug' });
  assert.equal((await prompt('echo "Release freeze until Friday."')).context, 'Release freeze until Friday.');
  assert.equal((await prompt('echo \'{"additionalContext":"branch: main"}\'')).context, 'branch: main');
  const blocked = await prompt('echo "no prompts with secrets" >&2; exit 2');
  assert.deepEqual([blocked.block, blocked.reason], [true, 'no prompts with secrets']);
  const asked = await prompt('cat > prompt.json');
  assert.equal(asked.block, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'prompt.json'), 'utf8')).prompt, 'fix the bug');

  const stop = await hookSet(root, [{ event: 'Stop', matcher: '', command: 'cat > stop.json; exit 2', timeout: 10 }]).run('Stop', { text: 'All done.' });
  assert.equal(stop.block, false);
  assert.match(stop.steps[0].title, /^Stop hook: .*\(blocked, /);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'stop.json'), 'utf8')).reply, 'All done.');

  const request = { requestId: 'r', messages: [{ role: 'assistant', content: 'a' }, { role: 'user', content: 'fix it' }] };
  assert.equal(withPromptContext(request, 'ctx').messages[1].content, 'fix it\n\n[Context from a UserPromptSubmit hook the user set up]\nctx');
  assert.equal(withPromptContext(request, ''), request);
});

test('project hooks run only once approved as they are; a change asks again; any hook can be switched off', async (t) => {
  const home = folder(t, 'sm-hooks-home-');
  const root = folder(t, 'sm-hooks-project-');
  settings(home, { Stop: [{ hooks: [{ command: 'echo mine' }] }] });
  settings(root, { PreToolUse: [{ matcher: 'workspace_write', hooks: [{ command: './guard.sh' }] }] });
  const roots = { project: await session(t, root), user: await session(t, home) };
  const store = { value: undefined };
  const approvals = createHookApprovals({ read: () => store.value, write: (value) => { store.value = structuredClone(value); } });

  let scopes = await loadScopes(roots);
  assert.deepEqual(scopes.map((scope) => [scope.scope, scope.exists, scope.hooks.length]), [['project', true, 1], ['user', true, 1]]);
  let view = approvals.view(scopes);
  assert.deepEqual(view.map((scope) => [scope.scope, scope.approved, scope.pending]), [['project', false, true], ['user', true, false]]);
  assert.equal(view[0].file, '.scalemax/settings.json');
  assert.equal(view[1].file, '~/.scalemax/settings.json');
  assert.deepEqual(approvals.active(scopes).map((hook) => hook.command), ['echo mine'], 'the user\'s own hooks need no approval');

  assert.throws(() => approvals.approve(root, 'not-a-hash'), { code: 'INVALID_HOOKS' });
  approvals.approve(root, scopes[0].hash);
  assert.deepEqual(approvals.active(scopes).map((hook) => hook.command), ['./guard.sh', 'echo mine']);
  assert.equal(approvals.view(scopes)[0].pending, false);

  // The project's file changes (by hand, by a command or by the model): approved no more.
  settings(root, { PreToolUse: [{ matcher: 'workspace_write', hooks: [{ command: './guard.sh; curl https://example.test/x' }] }] });
  scopes = await loadScopes(roots);
  view = approvals.view(scopes);
  assert.deepEqual([view[0].approved, view[0].pending], [false, true]);
  assert.deepEqual(approvals.active(scopes).map((hook) => hook.command), ['echo mine']);
  assert.equal(store.value.approved[root], hooksHash([{ event: 'PreToolUse', matcher: 'workspace_write', command: './guard.sh', timeout: 30 }]), 'the old approval stays for the old hooks only');

  // Switched off: a hook does not run, whatever its scope.
  approvals.approve(root, scopes[0].hash);
  const userHook = scopes[1].hooks[0];
  assert.deepEqual(approvals.setEnabled(userHook.id, false), { id: userHook.id, enabled: false });
  assert.deepEqual(approvals.active(scopes).map((hook) => hook.scope), ['project']);
  assert.equal(approvals.view(scopes)[1].hooks[0].enabled, false);
  approvals.setEnabled(userHook.id, true);
  assert.equal(approvals.active(scopes).length, 2);
  assert.throws(() => approvals.setEnabled('nope', false), { code: 'INVALID_HOOK' });
  assert.equal(approvals.revoke(root), true);
  assert.equal(approvals.revoke(root), false);
  assert.equal(approvals.active(scopes).length, 1);
  // A broken store reads as nothing approved.
  const broken = createHookApprovals({ read: () => { throw new Error('unreadable'); }, write: () => {} });
  assert.deepEqual(broken.state(), { approved: {}, disabled: [] });
});

test('settings are read through the workspace guards; the home folder as a project is the user\'s scope', async (t) => {
  const home = folder(t, 'sm-hooks-home-');
  const root = folder(t, 'sm-hooks-project-');
  const elsewhere = folder(t, 'sm-hooks-elsewhere-');
  settings(elsewhere, { Stop: [{ hooks: [{ command: 'echo planted' }] }] });
  fs.mkdirSync(path.join(root, '.scalemax'));
  fs.symlinkSync(path.join(elsewhere, SETTINGS_PATH), path.join(root, SETTINGS_PATH));
  const linked = await readHooks(await session(t, root));
  assert.deepEqual(linked.hooks, [], 'a linked settings file is not read');
  assert.equal(linked.exists, true);
  assert.match(linked.errors[0], /could not be read/);
  assert.deepEqual(await readHooks(await session(t, home)), { exists: false, hooks: [], errors: [] });
  settings(home, { Stop: [{ hooks: [{ command: 'echo mine' }] }] });
  const homeSession = await session(t, home);
  const scopes = await loadScopes({ project: homeSession, user: homeSession });
  assert.deepEqual(scopes.map((scope) => scope.scope), ['user']);
  assert.deepEqual(await loadScopes({ project: null, user: null }), [{ scope: 'user', file: '~/.scalemax/settings.json', exists: false, hooks: [], hash: hooksHash([]), errors: [] }]);
});

test('the model cannot quietly change the hooks settings: writing them always asks, even in Bypass', async (t) => {
  const home = folder(t, 'sm-hooks-home-');
  const root = folder(t, 'sm-hooks-project-');
  const workspace = await session(t, root);
  const tools = createWorkspaceTools({ getWorkspace: () => workspace, homeDir: home });
  for (const name of ['workspace_write', 'workspace_edit']) {
    const target = tools.resolve(name);
    for (const file of ['.scalemax/settings.json', './.scalemax/settings.json', '.SCALEMAX/Settings.JSON']) assert.equal(target.alwaysAsk({ path: file }), 'hooks-config', `${name} ${file}`);
    for (const file of ['.scalemax/SCALEMAX.md', '.scalemax/commands/fix.md', 'settings.json', '']) assert.equal(target.alwaysAsk({ path: file }), '', `${name} ${file}`);
  }
  // A project that is the home folder's .scalemax: its settings.json is the user's hooks file.
  fs.mkdirSync(path.join(home, '.scalemax'));
  const homeSettings = await session(t, path.join(home, '.scalemax'));
  const homeTools = createWorkspaceTools({ getWorkspace: () => homeSettings, homeDir: home });
  assert.equal(homeTools.resolve('workspace_write').alwaysAsk({ path: 'settings.json' }), 'hooks-config');

  // Through the tool loop, in Bypass and after "Allow all": the user is asked, and a denial leaves
  // the file alone.
  const asked = [];
  const write = { id: 'c1', name: 'workspace_write', arguments: JSON.stringify({ path: '.scalemax/settings.json', content: '{"hooks":{}}' }) };
  const replies = [{ content: null, toolCalls: [write], model: 'm', finishReason: 'tool_calls' }, { content: 'Done.', toolCalls: [], model: 'm', finishReason: 'stop' }];
  const provider = { send: async () => ({ text: '' }), complete: async () => structuredClone(replies.length > 1 ? replies.shift() : replies[0]), cancel: () => false };
  const loop = createToolLoop({
    provider,
    mcp: combineToolSources({ builtins: [tools], mcp: { chatTools: async () => ({ tools: [], resolve: () => null }), callTool: async () => ({}) } }),
    approve: async (request) => { asked.push(request.reason); return 'request'; },
  });
  const denying = createToolLoop({
    provider: { ...provider, complete: async () => structuredClone(replies[0]) },
    mcp: combineToolSources({ builtins: [tools], mcp: { chatTools: async () => ({ tools: [], resolve: () => null }), callTool: async () => ({}) } }),
    approve: async (request) => { asked.push(request.reason); return 'deny'; },
    maxRounds: 1,
  });
  await denying.send({ requestId: 'deny-1', messages: [{ role: 'user', content: 'go' }] }, { permission: 'bypass' });
  assert.equal(fs.existsSync(path.join(root, SETTINGS_PATH)), false, 'denied: nothing written');
  await loop.send({ requestId: 'allow-1', messages: [{ role: 'user', content: 'go' }] }, { permission: 'bypass' });
  assert.deepEqual(asked, ['hooks-config', 'hooks-config']);
  assert.equal(fs.readFileSync(path.join(root, SETTINGS_PATH), 'utf8'), '{"hooks":{}}', 'allowed: written');
});

test('a PreToolUse hook script blocks a real workspace write in the tool loop', async (t) => {
  const root = folder(t);
  fs.writeFileSync(path.join(root, 'guard.sh'), '#!/bin/sh\ninput=$(cat)\ncase "$input" in *secrets*) echo "secrets/ is off limits" >&2; exit 2;; esac\nexit 0\n');
  fs.chmodSync(path.join(root, 'guard.sh'), 0o755);
  const workspace = await session(t, root);
  const tools = createWorkspaceTools({ getWorkspace: () => workspace });
  const calls = [
    { id: 'c1', name: 'workspace_write', arguments: JSON.stringify({ path: 'secrets/key.txt', content: 'x' }) },
    { id: 'c2', name: 'workspace_write', arguments: JSON.stringify({ path: 'notes.md', content: 'ok' }) },
  ];
  const requests = [];
  const replies = [{ content: null, toolCalls: calls, model: 'm', finishReason: 'tool_calls' }, { content: 'Done.', toolCalls: [], model: 'm', finishReason: 'stop' }];
  const provider = {
    send: async () => ({ text: '' }),
    complete: async (request) => { requests.push(structuredClone(request)); return structuredClone(replies.length > 1 ? replies.shift() : replies[0]); },
    cancel: () => false,
  };
  const loop = createToolLoop({ provider, mcp: combineToolSources({ builtins: [tools], mcp: { chatTools: async () => ({ tools: [], resolve: () => null }), callTool: async () => ({}) } }) });
  const hooks = hookSet(root, [{ event: 'PreToolUse', matcher: 'workspace_(write|edit)', command: './guard.sh', timeout: 10 }]);
  const result = await loop.send({ requestId: 'r-hooks', messages: [{ role: 'user', content: 'write them' }] }, { permission: 'bypass', hooks });
  assert.equal(fs.existsSync(path.join(root, 'secrets', 'key.txt')), false);
  assert.equal(fs.readFileSync(path.join(root, 'notes.md'), 'utf8'), 'ok');
  const toolMessages = requests[1].messages.filter((message) => message.role === 'tool');
  assert.match(toolMessages[0].content, /^Error: a PreToolUse hook the user set up blocked this call: secrets\/ is off limits/);
  assert.match(toolMessages[1].content, /^Created notes\.md/);
  assert.deepEqual(result.steps.map((step) => [step.server, step.ok]), [['Hooks', false], ['Workspace', false], ['Hooks', true], ['Workspace', true]]);
});

test('in the sandbox a command cannot write the project\'s hooks settings', macSandbox, (t) => {
  const project = folder(t, 'sm-hooks-sbx-');
  const appData = folder(t, 'sm-hooks-sbx-data-');
  fs.mkdirSync(path.join(project, '.scalemax'));
  const run = (command) => {
    const { file, args } = commandLine(command, { box: { project, network: true, appData } });
    return spawnSync(file, args, { cwd: project, encoding: 'utf8' });
  };
  const refused = run('echo \'{"hooks":{}}\' > .scalemax/settings.json');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /operation not permitted/i);
  assert.equal(fs.existsSync(path.join(project, SETTINGS_PATH)), false);
  assert.equal(run('echo x > .scalemax/notes.json').status, 0, 'the rest of .scalemax stays writable');
});
