'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MODES, MODE_IDS, DEFAULT_MODE, normalizeMode, modeConfig, modeFamilies, modeInstructions, modeMaxRounds } = require('../lib/modes.cjs');
const { createWorkspace } = require('../lib/workspace.cjs');
const { createWorkspaceTools, combineToolSources } = require('../lib/workspace-tools.cjs');
const { createWebTools } = require('../lib/web-tools.cjs');
const { createComputerTools } = require('../lib/computer-tools.cjs');
const { createProjectNotes, prepareChatRequest } = require('../lib/project-notes.cjs');
const { createSpecTools } = require('../lib/specs.cjs');
const { createToolLoop } = require('../lib/tool-loop.cjs');

test('there are two modes and Working is the default', () => {
  assert.deepEqual(MODE_IDS, ['working', 'coding']);
  assert.equal(DEFAULT_MODE, 'working');
  for (const id of MODE_IDS) {
    const mode = MODES[id];
    assert.equal(mode.id, id);
    assert.ok(mode.label && mode.summary, id);
    assert.ok(mode.families.includes('workspace'), id);
    assert.ok(mode.maxRounds >= 8 && mode.maxRounds <= 64, id);
    assert.ok(mode.instructions.length > 400, id);
  }
});

test('anything unexpected is Working', () => {
  for (const value of ['working', 'coding']) assert.equal(normalizeMode(value), value);
  for (const value of [undefined, null, '', 'WORKING', 'plan', 42, {}, 'constructor', '__proto__']) assert.equal(normalizeMode(value), 'working');
  assert.equal(modeConfig('nope').id, 'working');
});

test('Working works the computer, Coding stays in the project', () => {
  assert.deepEqual(modeFamilies('working'), ['workspace', 'web', 'computer', 'specs', 'todos']);
  // Coding stays in the project, but writing a feature down before building it, and keeping a
  // to-do list while doing it, belong to both.
  assert.deepEqual(modeFamilies('coding'), ['workspace', 'web', 'specs', 'todos']);
  assert.match(modeInstructions('working'), /todo_write/);
  assert.match(modeInstructions('coding'), /todo_write/);
  // Coding gets more rounds: explore, change, run the tests, fix, run again.
  assert.ok(modeMaxRounds('coding') > modeMaxRounds('working'));
  const working = modeInstructions('working');
  const coding = modeInstructions('coding');
  assert.match(working, /^Mode: Working\./);
  assert.match(working, /plan/i);
  assert.match(working, /web_search/);
  assert.match(working, /clipboard/);
  assert.match(coding, /^Mode: Coding\./);
  assert.match(coding, /workspace_edit/);
  assert.match(coding, /tests/);
  assert.match(coding, /Do not commit or push unless the user asks/);
  assert.doesNotMatch(coding, /clipboard/);
  // Neither mode invites invented results.
  for (const text of [working, coding]) assert.match(text, /[Nn]ever (claim|report)|not invent/);
  assert.notEqual(working, coding);
});

// A project folder with the three built-in sources wired the way main does it.
async function setup(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-modes-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'demo');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'README.md'), '# demo\n');
  const workspace = createWorkspace({ approve: async () => true });
  t.after(() => workspace.dispose());
  await workspace.select(root);
  const getWorkspace = () => workspace;
  const clipboardText = { value: 'copied text' };
  const opened = [];
  const builtins = {
    workspace: createWorkspaceTools({ getWorkspace }),
    web: createWebTools({ fetchImpl: async () => { throw new Error('no network in tests'); } }),
    computer: createComputerTools({
      getWorkspace,
      clipboard: { readText: () => clipboardText.value, writeText: (value) => { clipboardText.value = value; } },
      shell: { openPath: async (value) => { opened.push(['open', value]); return ''; }, openExternal: async (value) => { opened.push(['external', value]); }, showItemInFolder: (value) => { opened.push(['reveal', value]); } },
    }),
    specs: createSpecTools({ getWorkspace }),
  };
  const source = combineToolSources({
    builtins: (mode) => modeFamilies(mode).map((family) => builtins[family]),
    mcp: { async chatTools() { return { tools: [], resolve: () => null, errors: [] }; }, async callTool() { throw new Error('no mcp'); } },
  });
  return { root, workspace, builtins, source, clipboardText, opened };
}

const names = (catalog) => catalog.tools.map((tool) => tool.function.name);

test('the offered tools follow the mode', async (t) => {
  const { source } = await setup(t);
  const working = names(await source.chatTools({ mode: 'working' }));
  const coding = names(await source.chatTools({ mode: 'coding' }));
  assert.deepEqual(working.filter((name) => name.startsWith('workspace_')), ['workspace_list', 'workspace_read', 'workspace_search', 'workspace_write', 'workspace_edit', 'workspace_run']);
  assert.deepEqual(working.filter((name) => name.startsWith('web_')), ['web_search', 'web_open']);
  assert.deepEqual(working.filter((name) => name.startsWith('computer_')), ['computer_clipboard_read', 'computer_clipboard_write', 'computer_open', 'computer_reveal']);
  assert.deepEqual(coding.filter((name) => name.startsWith('computer_')), [], 'no computer tools while coding');
  assert.deepEqual(coding.filter((name) => name.startsWith('web_')), ['web_search', 'web_open'], 'the web stays available for docs');
  for (const set of [working, coding]) {
    assert.deepEqual(set.filter((name) => name.startsWith('spec_')), ['spec_list', 'spec_read', 'spec_write', 'spec_task'], 'specs in both modes');
  }
  // An unknown mode gets the Working set, and no mode at all still works.
  assert.deepEqual(names(await source.chatTools({ mode: 'nonsense' })), working);
  assert.deepEqual(names(await source.chatTools({})), working);
});

test('every offered tool resolves to its own source, and only writes need approval', async (t) => {
  const { source } = await setup(t);
  const catalog = await source.chatTools({ mode: 'working' });
  const readOnly = [];
  for (const name of names(catalog)) {
    const target = catalog.resolve(name);
    assert.ok(target, name);
    assert.ok(['Workspace', 'Web', 'Computer', 'Specs'].includes(target.serverId), `${name} -> ${target.serverId}`);
    if (target.readOnly) readOnly.push(name);
  }
  assert.deepEqual(readOnly, ['workspace_list', 'workspace_read', 'workspace_search', 'web_search', 'web_open', 'computer_clipboard_read', 'spec_list', 'spec_read']);
  assert.equal(catalog.resolve('computer_open').readOnly, false);
  assert.equal(catalog.resolve('made_up'), null);
});

test('a tool call reaches the source it belongs to, even for another mode', async (t) => {
  const { source, clipboardText, opened, root } = await setup(t);
  assert.match((await source.callTool({ id: 'Workspace', name: 'list_files', arguments: {} })).text, /README\.md/);
  assert.match((await source.callTool({ id: 'Computer', name: 'read_clipboard', arguments: {} })).text, /copied text/);
  assert.match((await source.callTool({ id: 'Computer', name: 'write_clipboard', arguments: { text: 'new value' } })).text, /Put 9 characters on the clipboard/);
  assert.equal(clipboardText.value, 'new value');
  assert.match((await source.callTool({ id: 'Computer', name: 'open', arguments: { path: 'README.md' } })).text, /Opened README\.md/);
  assert.match((await source.callTool({ id: 'Computer', name: 'reveal', arguments: { path: 'README.md' } })).text, /Finder/);
  assert.deepEqual(opened.map(([kind]) => kind), ['open', 'reveal']);
  assert.ok(opened.every(([, value]) => value.startsWith(root)), 'only project paths are handed to the system');
  assert.match((await source.callTool({ id: 'Computer', name: 'open', arguments: { url: 'https://example.com' } })).text, /browser/);
  // Paths outside the project, secret files and unknown tools are refused.
  await assert.rejects(source.callTool({ id: 'Computer', name: 'open', arguments: { path: '../outside.txt' } }), { code: 'INVALID_PATH' });
  await assert.rejects(source.callTool({ id: 'Computer', name: 'open', arguments: { path: '.env' } }), { code: 'SENSITIVE_PATH' });
  await assert.rejects(source.callTool({ id: 'Computer', name: 'open', arguments: {} }), /project "path" or a web "url"/);
  await assert.rejects(source.callTool({ id: 'Computer', name: 'nope', arguments: {} }), /Unknown computer tool/);
  await assert.rejects(source.callTool({ id: 'Elsewhere', name: 'x', arguments: {} }), /no mcp/);
});

test('the clipboard tools work without a folder; opening needs one', async (t) => {
  const { workspace, builtins } = await setup(t);
  workspace.dispose();
  assert.deepEqual(builtins.computer.definitions().map((definition) => definition.function.name), ['computer_clipboard_read', 'computer_clipboard_write']);
  await assert.rejects(builtins.computer.call('open', { path: 'README.md' }), { code: 'NO_WORKSPACE' });
  assert.match((await builtins.computer.call('read_clipboard', {})).text, /copied text/);
});

test('the request carries the mode agreement, the folder and the project context', async (t) => {
  const { builtins, root } = await setup(t);
  const notes = createProjectNotes({ getWorkspace: () => builtins.workspace.folder() && null });
  const projectNotes = { ensure: async () => ({ created: false }), context: async () => '## Project notes\n(none)' };
  const input = { requestId: 'r1', systemPrompt: 'Be brief.', messages: [{ role: 'user', content: 'go' }] };
  for (const mode of ['working', 'coding']) {
    const prepared = await prepareChatRequest(input, {
      workspaceTools: builtins.workspace, projectNotes, modeInstructions: modeInstructions(mode),
    });
    const prompt = prepared.input.systemPrompt;
    assert.ok(prompt.startsWith('Be brief.\n\n'), mode);
    assert.match(prompt, mode === 'coding' ? /Mode: Coding\./ : /Mode: Working\./);
    // The agreement comes before the folder facts, which come before the project context.
    assert.ok(prompt.indexOf('Mode:') < prompt.indexOf(path.basename(root)), mode);
    assert.ok(prompt.indexOf(path.basename(root)) < prompt.indexOf('## Project notes'), mode);
  }
  assert.equal(typeof notes.context, 'function');
});

test('the tool loop asks the source for the mode and honours its round limit', async (t) => {
  const { source } = await setup(t);
  const asked = [];
  const wrapped = {
    chatTools: (options) => { asked.push(options); return source.chatTools(options); },
    callTool: (input) => source.callTool(input),
  };
  let rounds = 0;
  const provider = {
    async send() { return { text: 'plain', model: 'm' }; },
    async complete() {
      rounds += 1;
      // Never stops on its own: the loop must stop at the mode's limit.
      return { content: '', toolCalls: [{ id: `c${rounds}`, name: 'workspace_list', arguments: '{}' }] };
    },
    cancel: () => false,
  };
  const loop = createToolLoop({ provider, mcp: wrapped, maxRounds: 8 });
  const result = await loop.send({ requestId: 'r-coding', messages: [{ role: 'user', content: 'hi' }] }, { permission: 'bypass', mode: 'coding', maxRounds: modeMaxRounds('coding') });
  assert.deepEqual(asked, [{ mode: 'coding' }]);
  assert.equal(rounds, modeMaxRounds('coding') + 1, 'the rounds plus the final answer without tools');
  assert.equal(result.toolCalls.length, modeMaxRounds('coding'));
  // Without a mode the option is left out, and the configured limit applies.
  rounds = 0;
  await createToolLoop({ provider, mcp: wrapped, maxRounds: 3 }).send({ requestId: 'r-default', messages: [{ role: 'user', content: 'hi' }] }, { permission: 'bypass' });
  assert.deepEqual(asked[1], {});
  assert.equal(rounds, 4);
  // A silly limit cannot exceed the hard cap.
  rounds = 0;
  await createToolLoop({ provider, mcp: wrapped, maxRounds: 8 }).send({ requestId: 'r-big', messages: [{ role: 'user', content: 'hi' }] }, { permission: 'bypass', maxRounds: 5000 });
  assert.equal(rounds, 65);
});
