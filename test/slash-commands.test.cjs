'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  BUILTIN_NAMES, parseFrontMatter, splitArguments, expandCommand, loadCommands, publicCommand, findCommand, validName,
  commandPrompt, commandModel, limitTools, isReviewCommand, reviewFocus, reviewPrompt, reviewChanges, withReview,
} = require('../lib/slash-commands.cjs');
const { createWorkspace } = require('../lib/workspace.cjs');

const TEMP = fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir();
function folder(t, prefix = 'sm-slash-') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(TEMP, prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(root, relative, text) {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), text);
}
async function session(t, root) {
  const workspace = createWorkspace({ approve: async () => true });
  t.after(() => workspace.dispose());
  await workspace.select(root);
  return workspace;
}
const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

test('front matter: key: value lines, quotes, comments, lists; a file without it is all body', () => {
  const text = [
    '---',
    'description: "Fix an issue" # shown in the menu',
    "argument-hint: [issue-number] [priority]",
    'Mode: Coding',
    'model: deepseek-v4-flash',
    'allowed-tools: workspace_read, workspace_(write|edit), Bash(git add:*, git status:*)',
    'tools:',
    '  - "a b"',
    '  - c',
    '__proto__: polluted',
    '---',
    'Fix issue $1.',
  ].join('\r\n');
  const { data, body } = parseFrontMatter(text);
  assert.deepEqual(data, {
    description: 'Fix an issue',
    'argument-hint': '[issue-number] [priority]',
    mode: 'Coding',
    model: 'deepseek-v4-flash',
    'allowed-tools': 'workspace_read, workspace_(write|edit), Bash(git add:*, git status:*)',
    tools: ['a b', 'c'],
  });
  assert.equal(body, 'Fix issue $1.');
  assert.equal(Object.getPrototypeOf(data), Object.prototype, 'no key reaches the prototype');
  assert.deepEqual(parseFrontMatter('Just a prompt\n---\nnot front matter'), { data: {}, body: 'Just a prompt\n---\nnot front matter' });
  assert.deepEqual(parseFrontMatter('---\n---\nbody'), { data: {}, body: 'body' });
  assert.deepEqual(parseFrontMatter("---\nsay: 'it''s'\n---\n").data, { say: "it's" });
  assert.deepEqual(parseFrontMatter('﻿---\ndescription: x---y\n---\nb').data, { description: 'x---y' });
});

test('arguments: $ARGUMENTS, $1 … $9, quoted words, and arguments added when the text has no place for them', () => {
  assert.deepEqual(splitArguments('123 "two words" \'single quoted\' "" it\'s\' last'), ['123', 'two words', 'single quoted', '', 'its', 'last']);
  assert.equal(expandCommand('Fix #$1 ($2). Everything: $ARGUMENTS', '42 "high priority"'), 'Fix #42 (high priority). Everything: 42 "high priority"');
  assert.equal(expandCommand('Missing: [$3]', 'a b'), 'Missing: []');
  assert.equal(expandCommand('Review the code.\n', 'focus on errors'), 'Review the code.\n\nARGUMENTS: focus on errors');
  assert.equal(expandCommand('Review the code.', ''), 'Review the code.');
  assert.equal(expandCommand('Cost: $$1 and $&', '$&'), 'Cost: $$& and $&', 'replacement patterns stay text');
});

test('commands are loaded from the project and the user, .scalemax before .claude, with namespaces', async (t) => {
  const home = folder(t, 'sm-slash-home-');
  const root = folder(t, 'sm-slash-project-');
  write(root, '.scalemax/commands/fix.md', '---\ndescription: Fix an issue\nargument-hint: <issue>\nmode: coding\nmodel: fast-model\nallowed-tools: [workspace_read, workspace_edit]\n---\nFix issue $1 in @src/app.js.\n');
  write(root, '.scalemax/commands/frontend/component.md', '# Make a component\nCreate a component named $ARGUMENTS.\n');
  write(root, '.scalemax/commands/a/b/ok.md', 'Two folders deep.');
  write(root, '.scalemax/commands/a/b/c/too-deep.md', 'never offered');
  write(root, '.scalemax/commands/notes.txt', 'not a command');
  write(root, '.scalemax/commands/bad name.md', 'not a command name');
  write(root, '.scalemax/commands/secrets.md', 'a secret-looking file is never read');
  write(root, '.scalemax/commands/review.md', 'the app\'s own /review wins');
  write(root, '.scalemax/commands/huge.md', 'x'.repeat(300 * 1024));
  write(root, '.claude/commands/fix.md', 'shadowed by .scalemax');
  write(root, '.claude/commands/legacy.md', '---\ndescription: From another agent\n---\nDo the legacy thing.');
  write(home, '.scalemax/commands/fix.md', 'shadowed by the project');
  write(home, '.scalemax/commands/Mine.md', 'My own command.');
  write(home, '.claude/commands/old.md', 'Old one.');
  const elsewhere = folder(t, 'sm-slash-elsewhere-');
  write(elsewhere, 'planted.md', 'planted');
  fs.symlinkSync(path.join(elsewhere, 'planted.md'), path.join(root, '.scalemax', 'commands', 'linked.md'));

  const roots = { project: await session(t, root), user: await session(t, home) };
  const { commands, errors } = await loadCommands(roots);
  assert.deepEqual(commands.map((command) => [command.name, command.source, command.origin]), [
    ['a:b:ok', 'project', '.scalemax'],
    ['fix', 'project', '.scalemax'],
    ['frontend:component', 'project', '.scalemax'],
    ['legacy', 'project', '.claude'],
    ['Mine', 'user', '.scalemax'],
    ['old', 'user', '.claude'],
  ]);
  assert.ok(errors.some((error) => /huge\.md: a command file may have at most 256 KiB/.test(error)), errors.join('\n'));
  const fix = findCommand(commands, 'FIX');
  assert.deepEqual(publicCommand(fix), { name: 'fix', description: 'Fix an issue', argumentHint: '<issue>', source: 'project' });
  assert.deepEqual([fix.mode, fix.model, fix.allowedTools], ['coding', 'fast-model', ['workspace_read', 'workspace_edit']]);
  assert.equal(fix.file, '.scalemax/commands/fix.md');
  assert.equal(commandPrompt(fix, '17'), 'Fix issue 17 in @src/app.js.', '@path stays for the @-mention path to attach');
  const component = findCommand(commands, 'frontend:component');
  assert.equal(component.description, 'Make a component', 'the first line describes a command without a description');
  assert.equal(commandPrompt(component, 'Button'), '# Make a component\nCreate a component named Button.');
  assert.equal(findCommand(commands, 'mine').source, 'user');
  assert.equal(findCommand(commands, 'too-deep'), null);
  assert.equal(findCommand(commands, 'a:b:c:too-deep'), null);
  assert.equal(findCommand(commands, '../x'), null);
  for (const name of BUILTIN_NAMES) assert.equal(findCommand(commands, name), null, `/${name} stays the app's`);

  // The project is the home folder: its commands are the user's, listed once.
  const homeSession = await session(t, home);
  const homeOnly = await loadCommands({ project: homeSession, user: homeSession });
  assert.deepEqual(homeOnly.commands.map((command) => `${command.name}:${command.source}`), ['fix:user', 'Mine:user', 'old:user']);
  assert.deepEqual(await loadCommands({}), { commands: [], errors: [] });
});

test('names, prompts that are empty or too large, and the model a command asks for', () => {
  assert.equal(validName('fix'), true);
  assert.equal(validName('frontend:component'), true);
  assert.equal(validName('a:b:c:d'), false);
  assert.equal(validName('-x'), false);
  assert.equal(validName('x y'), false);
  assert.throws(() => commandPrompt({ name: 'empty', body: '  \n' }, ''), { code: 'EMPTY_COMMAND' });
  assert.throws(() => commandPrompt({ name: 'big', body: '$ARGUMENTS $ARGUMENTS' }, 'x'.repeat(300 * 1024)), { code: 'COMMAND_TOO_LARGE' });
  const scalemax = { kind: 'scalemax', models: [{ id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', chat: true }, { id: 'img', chat: false }, { id: 'gone', available: false }] };
  assert.equal(commandModel('', scalemax), '');
  assert.equal(commandModel('DeepSeek V4 Flash', scalemax), 'deepseek-v4-flash');
  assert.equal(commandModel('DEEPSEEK-V4-FLASH', scalemax), 'deepseek-v4-flash');
  assert.throws(() => commandModel('img', scalemax), { code: 'COMMAND_MODEL' });
  assert.throws(() => commandModel('gone', scalemax), { code: 'COMMAND_MODEL' });
  assert.throws(() => commandModel('gpt-x', scalemax), /does not offer/);
  assert.equal(commandModel('my-local-model', { kind: 'custom', models: [] }), 'my-local-model', 'an endpoint without a list takes the name as written');
});

test('allowed-tools only narrows the tools offered, and names another agent uses are ignored', async () => {
  const definitions = ['workspace_read', 'workspace_write', 'web_search'].map((name) => ({ type: 'function', function: { name } }));
  const source = {
    chatTools: async () => ({ tools: definitions, resolve: (name) => ({ serverId: 'S', toolName: name }), errors: [] }),
    callTool: async (input) => ({ text: input.name }),
    describeCall: () => 'title',
  };
  assert.equal(limitTools(source, []), source);
  assert.equal(limitTools(source, undefined), source);
  const limited = limitTools(source, ['workspace_read', 'web_.*']);
  const catalog = await limited.chatTools({});
  assert.deepEqual(catalog.tools.map((tool) => tool.function.name), ['workspace_read', 'web_search']);
  assert.equal(catalog.resolve('workspace_write'), null, 'a tool left out cannot be called either');
  assert.deepEqual(catalog.resolve('workspace_read'), { serverId: 'S', toolName: 'workspace_read' });
  assert.deepEqual(await limited.callTool({ name: 'x' }), { text: 'x' });
  assert.equal(limited.describeCall(), 'title');
  const foreign = await limitTools(source, ['Bash(git add:*)', 'Read']).chatTools({});
  assert.equal(foreign.tools.length, 3, 'names that match nothing here limit nothing');
});

test('/review: the folder\'s Git changes, read through the workspace guards, as a read-only instruction', async (t) => {
  assert.equal(isReviewCommand('/review'), true);
  assert.equal(isReviewCommand('  /review the error handling'), true);
  assert.equal(isReviewCommand('/reviewer'), false);
  assert.equal(isReviewCommand('please /review'), false);
  assert.equal(reviewFocus('/review  the error handling\n'), 'the error handling');
  assert.match(reviewPrompt({ status: { isRepo: false, files: [] } }), /not the root of a Git repository/);
  assert.match(reviewPrompt({ error: 'Git was not found.' }), /could not read the Git changes here: Git was not found\./);
  assert.match(reviewPrompt({ status: { isRepo: true, files: [] } }), /no uncommitted changes/);
  assert.match(reviewPrompt({ status: { isRepo: true, files: [{ status: ' M', path: 'a.js' }] }, diffError: 'Git output exceeded 1 MiB' }), /The diff could not be read \(Git output exceeded 1 MiB\)/);

  const root = folder(t, 'sm-slash-review-');
  if (git(root, 'init', '-q').status !== 0) {
    t.skip('git is not available');
    return;
  }
  write(root, 'src/app.js', 'export const a = 1;\n');
  write(root, '.env', 'TOKEN=one\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'first');
  write(root, 'src/app.js', 'export const a = 2; // changed\n');
  write(root, '.env', 'TOKEN=two-secret\n');
  write(root, 'new.md', '# New\n');
  const changes = await reviewChanges(await session(t, root));
  assert.equal(changes.status.isRepo, true);
  assert.deepEqual(changes.status.files.map((file) => file.path).sort(), ['new.md', 'src/app.js'], 'secret files are not listed');
  assert.match(changes.diff, /\+export const a = 2; \/\/ changed/);
  assert.ok(!changes.diff.includes('two-secret'), 'nor in the diff');
  const input = { requestId: 'r', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: '/review naming', images: ['m-0123456789abcdef'] }] };
  const reviewed = withReview(input, changes);
  const last = reviewed.messages[2];
  assert.deepEqual(last.images, ['m-0123456789abcdef']);
  assert.match(last.content, /^\/review: review the uncommitted changes/);
  assert.match(last.content, /This reply is read-only/);
  assert.match(last.content, /What the user asked you to focus on: naming/);
  assert.match(last.content, /^ M src\/app\.js$/m);
  assert.match(last.content, /^\?\? new\.md$/m);
  assert.match(last.content, /~~~diff\n[\s\S]*\+export const a = 2;[\s\S]*\n~~~/);
  assert.equal(reviewed.messages[0], input.messages[0], 'earlier turns stay as they were');
  assert.equal(withReview({ messages: [{ role: 'user', content: 'not a review' }] }, changes).messages[0].content, 'not a review');
  assert.deepEqual(await reviewChanges(null), { status: { isRepo: false, files: [] } });
});

test('@folder/: what is in a folder, two levels deep, through the workspace guards', async (t) => {
  const { folderListing } = require('../lib/file-find.cjs');
  const root = folder(t, 'sm-slash-listing-');
  write(root, 'src/app.js', 'x');
  write(root, 'src/lib/parse.js', 'x');
  write(root, 'src/lib/deep/hidden-too-deep.js', 'x');
  write(root, 'src/node_modules/dep/index.js', 'x');
  write(root, 'src/.env', 'TOKEN=secret');
  write(root, 'src/vendor/lib.js', 'x');
  const workspace = await session(t, root);
  const listing = await folderListing(workspace, './src/');
  assert.equal(listing.path, 'src');
  assert.equal(listing.complete, true);
  assert.deepEqual(listing.lines, ['src/lib/', 'src/vendor/', 'src/app.js', 'src/lib/deep/', 'src/lib/parse.js'],
    'secret files and build folders are left out; vendor/ is named but not opened');
  assert.deepEqual((await folderListing(workspace, 'src', { depth: 1 })).lines, ['src/lib/', 'src/vendor/', 'src/app.js']);
  const capped = await folderListing(workspace, '', { max: 2 });
  assert.deepEqual([capped.lines.length, capped.complete], [2, false]);
  await assert.rejects(folderListing(workspace, 'missing/'), { code: 'ENOENT' });
  await assert.rejects(folderListing(workspace, '../'), { code: 'INVALID_PATH' });
});
