'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspace } = require('../lib/workspace.cjs');
const { createWorkspaceTools, combineToolSources, SERVER_ID, TOOLS } = require('../lib/workspace-tools.cjs');
const { createToolLoop } = require('../lib/tool-loop.cjs');

// A real project folder on disk (canonical path: /tmp and /var are symlinks on macOS).
function project(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-ws-tools-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# Demo\nHello World\n');
  fs.writeFileSync(path.join(root, 'src', 'app.js'), "const greeting = 'hello';\nconsole.log(greeting);\n");
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=hello-secret\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'hello from a dependency\n');
  return root;
}

async function openTools(t) {
  const root = project(t);
  const workspace = createWorkspace({ approve: async () => true });
  t.after(() => workspace.dispose());
  await workspace.select(root);
  return { root, workspace, tools: createWorkspaceTools({ getWorkspace: () => workspace }) };
}

test('without an open folder there are no tools and the prompt says so', async () => {
  const workspace = createWorkspace({ approve: async () => true });
  const tools = createWorkspaceTools({ getWorkspace: () => workspace });
  assert.deepEqual(tools.definitions(), []);
  assert.equal(tools.folder(), null);
  assert.match(tools.describe(), /No workspace folder is open/);
  assert.equal(tools.marker(), '');
  await assert.rejects(tools.call('list_files', {}), { code: 'NO_WORKSPACE' });
  workspace.dispose();
});

test('an open folder offers six tools; reads are read-only, writes and commands are not', async (t) => {
  const { root, tools } = await openTools(t);
  const names = tools.definitions().map((definition) => definition.function.name);
  assert.deepEqual(names, ['workspace_list', 'workspace_read', 'workspace_search', 'workspace_write', 'workspace_edit', 'workspace_run']);
  for (const definition of tools.definitions()) {
    assert.match(definition.function.name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.equal(definition.function.parameters.type, 'object');
    assert.ok(definition.function.description.length <= 1024);
  }
  assert.deepEqual(tools.resolve('workspace_read'), { serverId: SERVER_ID, toolName: 'read_file', readOnly: true });
  assert.deepEqual(tools.resolve('workspace_write'), { serverId: SERVER_ID, toolName: 'write_file', readOnly: false });
  assert.equal(tools.resolve('workspace_run').readOnly, false);
  assert.equal(tools.resolve('mcp_other_tool'), null);
  // The model learns the folder name, never the full path on disk.
  const note = tools.describe();
  assert.ok(note.includes(`"${path.basename(root)}"`));
  assert.ok(!note.includes(root));
  assert.equal(tools.marker(), `[Workspace folder right now: "${path.basename(root)}"]`);
  // Four more (background commands) only come with a job manager (test/jobs.test.cjs).
  assert.equal(TOOLS.length, 10);
  assert.equal(tools.resolve('workspace_job_output'), null);
  assert.equal(tools.resolve('workspace_edit').readOnly, false);
});

test('list_files shows one level and hides secrets and build folders', async (t) => {
  const { tools } = await openTools(t);
  const { text } = await tools.call('list_files', {});
  assert.match(text, /^sm-ws-tools-\w+ \(the workspace folder\): 1 folders, 1 files/);
  assert.ok(text.includes('src/') && text.includes('README.md'));
  assert.ok(!text.includes('.env') && !text.includes('node_modules'));
  assert.match((await tools.call('list_files', { path: './src/' })).text, /src\/app\.js/);
  await assert.rejects(tools.call('list_files', { path: '../' }), { code: 'INVALID_PATH' });
});

test('read_file returns text, line ranges, and never an absolute path in errors', async (t) => {
  const { root, tools } = await openTools(t);
  assert.equal((await tools.call('read_file', { path: 'README.md' })).text, 'README.md (2 lines)\n# Demo\nHello World');
  assert.equal((await tools.call('read_file', { path: 'src/app.js', start_line: 2 })).text, 'src/app.js lines 2-2 of 2\nconsole.log(greeting);');
  await assert.rejects(tools.call('read_file', { path: '.env' }), { code: 'SENSITIVE_PATH' });
  await assert.rejects(tools.call('read_file', { path: 'missing.txt' }), (error) => {
    assert.equal(error.code, 'ENOENT');
    assert.ok(!error.message.includes(root));
    return true;
  });
  await assert.rejects(tools.call('read_file', {}), /"path" is required/);
});

test('read_file pages large files', async (t) => {
  const { root, tools } = await openTools(t);
  const lines = Array.from({ length: 4000 }, (_, index) => `line ${index + 1} ${'x'.repeat(20)}`);
  fs.writeFileSync(path.join(root, 'big.txt'), `${lines.join('\n')}\n`);
  const first = (await tools.call('read_file', { path: 'big.txt' })).text;
  assert.ok(Buffer.byteLength(first) < 50 * 1024);
  const next = Number(first.match(/start_line (\d+)\]$/)[1]);
  assert.ok(next > 1 && next < 4000);
  assert.match((await tools.call('read_file', { path: 'big.txt', start_line: next, end_line: next })).text, new RegExp(`^big\\.txt lines ${next}-${next} of 4000\\nline ${next} `));
});

test('search finds names and text, case-insensitively, without secrets or dependencies', async (t) => {
  const { tools } = await openTools(t);
  const { text } = await tools.call('search', { query: 'HELLO' });
  assert.ok(text.includes("src/app.js:1: const greeting = 'hello';"));
  assert.ok(text.includes('README.md:2: Hello World'));
  assert.ok(!text.includes('hello-secret') && !text.includes('dependency'));
  assert.match((await tools.call('search', { query: 'app' })).text, /File and folder names:\nsrc\/app\.js/);
  assert.match((await tools.call('search', { query: 'HELLO', case_sensitive: true })).text, /^No matches/);
  assert.match((await tools.call('search', { query: 'greeting', path: 'src' })).text, /in src\//);
  await assert.rejects(tools.call('search', { query: '' }), /"query"/);
});

test('write_file creates files and folders, replaces with a backup, and refuses secrets', async (t) => {
  const { root, tools } = await openTools(t);
  assert.equal((await tools.call('write_file', { path: 'docs/notes/todo.md', content: '- ship\n' })).text, 'Created docs/notes/todo.md (7 bytes).');
  assert.equal(fs.readFileSync(path.join(root, 'docs/notes/todo.md'), 'utf8'), '- ship\n');
  assert.match((await tools.call('write_file', { path: 'README.md', content: '# New\n' })).text, /^Replaced README\.md \(6 bytes\)/);
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), '# New\n');
  const backups = fs.readdirSync(path.join(root, '.cache', 'editor-backups'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(root, '.cache', 'editor-backups', backups[0]), 'utf8'), '# Demo\nHello World\n');
  assert.match((await tools.call('write_file', { path: 'README.md', content: '# New\n' })).text, /nothing changed/);
  await assert.rejects(tools.call('write_file', { path: '.env', content: 'x' }), { code: 'SENSITIVE_PATH' });
  await assert.rejects(tools.call('write_file', { path: 'README.md/child.txt', content: 'x' }), { code: 'NOT_DIRECTORY' });
  await assert.rejects(tools.call('write_file', { path: 'a.txt' }), /"content"/);
});

test('run_command runs in the folder and reports exit codes', { skip: process.platform === 'win32' }, async (t) => {
  const { tools } = await openTools(t);
  const { text } = await tools.call('run_command', { command: 'ls src && echo done' });
  assert.equal(text, 'Exit code: 0\nstdout:\napp.js\ndone\n');
  assert.match((await tools.call('run_command', { command: 'echo oops >&2; exit 3' })).text, /^Exit code: 3\nstderr:\noops/);
  await assert.rejects(tools.call('run_command', { command: '  ' }), /"command"/);
});

function fakeMcp(count, { fail = false } = {}) {
  const calls = [];
  const names = Array.from({ length: count }, (_, index) => `mcp_srv_tool${index}`);
  return {
    calls,
    async chatTools() {
      if (fail) throw new Error('MCP is broken');
      return {
        tools: names.map((name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } })),
        resolve: (name) => (names.includes(name) ? { serverId: 'srv', toolName: name.slice(8), readOnly: true } : null),
        errors: [],
      };
    },
    async callTool(input) {
      calls.push(input);
      return { text: `mcp:${input.name}` };
    },
  };
}

test('combined tools put the workspace first and keep MCP within the request limit', async (t) => {
  const { tools } = await openTools(t);
  const mcp = fakeMcp(130);
  const combined = combineToolSources({ workspaceTools: tools, mcp });
  const catalog = await combined.chatTools({});
  assert.equal(catalog.tools.length, 128);
  assert.equal(catalog.tools[0].function.name, 'workspace_list');
  assert.equal(catalog.resolve('workspace_run').serverId, SERVER_ID);
  assert.deepEqual(catalog.resolve('mcp_srv_tool0'), { serverId: 'srv', toolName: 'tool0', readOnly: true });
  assert.equal(catalog.resolve('mcp_srv_tool129'), null); // dropped over the limit
  assert.match(catalog.errors[0].message, /omitted/);
  assert.match((await combined.callTool({ id: SERVER_ID, name: 'list_files', arguments: {} })).text, /README\.md/);
  assert.equal((await combined.callTool({ id: 'srv', name: 'tool1', arguments: {} })).text, 'mcp:tool1');
  assert.equal(mcp.calls.length, 1);
});

test('a broken MCP setup still leaves the workspace tools', async (t) => {
  const { tools } = await openTools(t);
  const catalog = await combineToolSources({ workspaceTools: tools, mcp: fakeMcp(0, { fail: true }) }).chatTools({});
  assert.equal(catalog.tools.length, 6);
  assert.equal(catalog.errors[0].message, 'MCP is broken');
});

// A model that lists the folder, then writes a file, then answers.
function scriptedProvider() {
  const calls = [];
  const replies = [
    { content: '', toolCalls: [{ id: 'c1', name: 'workspace_list', arguments: '{}' }] },
    { content: '', toolCalls: [{ id: 'c2', name: 'workspace_write', arguments: JSON.stringify({ path: 'out.txt', content: 'hi\n' }) }] },
    { content: 'Done.' },
  ];
  return {
    calls,
    async send() { throw new Error('tools were expected'); },
    async complete(request) {
      calls.push(structuredClone(request));
      return replies[calls.length - 1];
    },
    cancel: () => false,
  };
}

for (const [permission, decision, created, approvals] of [
  ['basic', 'deny', false, ['write_file']],
  ['basic', 'once', true, ['write_file']],
  ['manual', 'once', true, ['list_files', 'write_file']],
  ['bypass', null, true, []],
]) {
  test(`chat tool loop: ${permission} mode${decision ? ` with "${decision}"` : ''}`, async (t) => {
    const { root, tools } = await openTools(t);
    const asked = [];
    const provider = scriptedProvider();
    const loop = createToolLoop({
      provider,
      mcp: combineToolSources({ workspaceTools: tools, mcp: fakeMcp(0) }),
      approve: async (request) => { asked.push(request.toolName); return decision; },
    });
    const result = await loop.send({ requestId: `r-${permission}-${decision}`, messages: [{ role: 'user', content: 'what is here?' }], systemPrompt: tools.describe() }, { permission });
    assert.equal(result.text, 'Done.');
    assert.deepEqual(asked, approvals);
    assert.equal(fs.existsSync(path.join(root, 'out.txt')), created);
    assert.deepEqual(result.toolCalls.map((call) => [call.server, call.tool, call.ok]), [['Workspace', 'list_files', true], ['Workspace', 'write_file', created]]);
    // The model saw the listing as the first tool result.
    const toolMessage = provider.calls[1].messages.find((message) => message.role === 'tool');
    assert.match(toolMessage.content, /README\.md/);
    assert.equal(provider.calls[0].tools.length, 6);
  });
}

test('an empty folder is reported as empty, by name', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-empty-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = createWorkspace({ approve: async () => true });
  t.after(() => workspace.dispose());
  await workspace.select(root);
  const { text } = await createWorkspaceTools({ getWorkspace: () => workspace }).call('list_files', {});
  assert.match(text, new RegExp(`^${path.basename(root)} \\(the workspace folder\\) is empty: it has no files or folders\\.`));
});

test('edit_file replaces exact text once, refuses missing or ambiguous text, and backs up', async (t) => {
  const { root, tools } = await openTools(t);
  fs.writeFileSync(path.join(root, 'src', 'util.js'), 'const a = 1;\nconst b = 1;\nexport { a, b };\n');
  assert.equal((await tools.call('edit_file', { path: 'src/util.js', old_text: 'const b = 1;', new_text: 'const b = 2;' })).text,
    'Edited src/util.js (at line 2). The previous version was backed up in .cache/editor-backups.');
  assert.equal(fs.readFileSync(path.join(root, 'src', 'util.js'), 'utf8'), 'const a = 1;\nconst b = 2;\nexport { a, b };\n');
  await assert.rejects(tools.call('edit_file', { path: 'src/util.js', old_text: 'const c', new_text: 'x' }), { code: 'NO_MATCH' });
  await assert.rejects(tools.call('edit_file', { path: 'src/util.js', old_text: 'const', new_text: 'let' }), { code: 'AMBIGUOUS_MATCH' });
  assert.match((await tools.call('edit_file', { path: 'src/util.js', old_text: 'const', new_text: 'let', replace_all: true })).text, /2 occurrences, first at line 1/);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'util.js'), 'utf8'), 'let a = 1;\nlet b = 2;\nexport { a, b };\n');
  await assert.rejects(tools.call('edit_file', { path: 'src/util.js', old_text: 'x', new_text: 'x' }), /the same/);
  await assert.rejects(tools.call('edit_file', { path: 'missing.js', old_text: 'a', new_text: 'b' }), { code: 'ENOENT' });
  assert.equal(fs.readdirSync(path.join(root, '.cache', 'editor-backups')).length, 2);
  // "$&" in the new text is inserted literally, not as a replacement pattern.
  await tools.call('edit_file', { path: 'src/util.js', old_text: 'export { a, b };', new_text: 'const price = "$&";' });
  assert.match(fs.readFileSync(path.join(root, 'src', 'util.js'), 'utf8'), /const price = "\$&";/);
});

test('run_command streams its output, honours timeout_seconds and stops with the reply', { skip: process.platform === 'win32' }, async (t) => {
  const { tools } = await openTools(t);
  const heard = [];
  const result = await tools.call('run_command', { command: 'printf "one\\n"; sleep 0.2; printf "two\\n"' }, { onOutput: (text) => heard.push(text) });
  assert.match(result.text, /^Exit code: 0\nstdout:\none\ntwo\n$/);
  assert.deepEqual(heard.join(''), 'one\ntwo\n');
  assert.ok(heard.length >= 2, 'output arrives while the command runs');
  // A short limit stops a long command and keeps what it printed.
  const slow = await tools.call('run_command', { command: 'printf started; sleep 5', timeout_seconds: 1 });
  assert.equal(slow.isError, true);
  assert.match(slow.text, /exceeded 1 seconds/);
  assert.match(slow.text, /started/);
  await assert.rejects(tools.call('run_command', { command: 'true', timeout_seconds: 601 }), /timeout_seconds/);
  await assert.rejects(tools.call('run_command', { command: 'true', timeout_seconds: 1.5 }), /timeout_seconds/);
  // An aborted signal (the reply was stopped) ends the command at once.
  const controller = new AbortController();
  const started = Date.now();
  const pending = tools.call('run_command', { command: 'sleep 20' }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  const stopped = await pending.then((value) => value, (error) => error);
  assert.ok(Date.now() - started < 5000, 'the command did not run to its end');
  assert.match(String(stopped?.message || stopped?.text), /cancelled/i);
});

test('steps get readable titles, and only built-in tools receive the call context', async (t) => {
  const { tools } = await openTools(t);
  assert.equal(tools.describeCall('read_file', { path: 'src/app.js' }), 'Read src/app.js');
  assert.equal(tools.describeCall('read_file', { path: 'a.js', start_line: 5, end_line: 9 }), 'Read a.js (lines 5-9)');
  assert.equal(tools.describeCall('run_command', { command: 'npm   test' }), 'Ran npm test');
  assert.equal(tools.describeCall('search', { query: 'TODO', path: 'src' }), 'Searched for "TODO" in src');
  assert.equal(tools.describeCall('edit_file', {}), 'Edited a file');
  const calls = [];
  const mcp = {
    chatTools: async () => ({ tools: [], resolve: () => null, errors: [] }),
    callTool: async (...args) => { calls.push(args); return { text: 'mcp' }; },
  };
  const combined = combineToolSources({ builtins: [tools], mcp, serverName: (id) => (id === 'gh' ? 'GitHub' : id) });
  const context = { onOutput: () => {}, signal: new AbortController().signal };
  await combined.callTool({ id: 'gh', name: 'list_issues', arguments: {} }, context);
  assert.deepEqual(calls, [[{ id: 'gh', name: 'list_issues', arguments: {} }]]);
  const listed = await combined.callTool({ id: SERVER_ID, name: 'list_files', arguments: {} }, context);
  assert.match(listed.text, /README\.md/);
  assert.equal(combined.describeCall({ serverId: SERVER_ID, toolName: 'write_file' }, { path: 'x.md' }), 'Wrote x.md');
  assert.equal(combined.describeCall({ serverId: 'gh', toolName: 'list_issues' }, {}), 'GitHub · list_issues');
});

test('a session ended in the middle of a save removes its staging file', async (t) => {
  const root = project(t);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let caught = false;
  // Holds the save at its staging file, the moment a stopped reply can end the session.
  const promises = {
    ...fs.promises,
    lstat: async (target, ...rest) => {
      if (!caught && /\.scalemax-[0-9a-f-]+\.tmp$/.test(String(target))) {
        caught = true;
        await held;
      }
      return fs.promises.lstat(target, ...rest);
    },
  };
  const workspace = createWorkspace({ approve: async () => true, io: { ...fs, promises } });
  await workspace.select(root);
  const file = await workspace.read('README.md');
  const saving = workspace.write({ path: 'README.md', content: 'replaced', revision: file.revision });
  for (let i = 0; i < 400 && !caught; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(caught, true, 'the save reached its staging file');
  workspace.dispose();
  release();
  await assert.rejects(saving, { code: 'SESSION_CHANGED' });
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith('.tmp')), []);
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), '# Demo\nHello World\n');
});
