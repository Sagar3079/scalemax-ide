'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createWorkspace } = require('../lib/workspace.cjs');
const { createProjectNotes, isInitCommand, NOTES_PATH, INIT_PROMPT, firstParagraph, frontMatter } = require('../lib/project-notes.cjs');

const DAY = new Date('2026-09-27T10:00:00Z');

async function folder(t, name, files = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-notes-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, name);
  fs.mkdirSync(root);
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  const workspace = createWorkspace({ approve: async () => true });
  t.after(() => workspace.dispose());
  await workspace.select(root);
  return { root, workspace, notes: createProjectNotes({ getWorkspace: () => workspace, now: () => DAY }) };
}

const readNotes = (root) => fs.readFileSync(path.join(root, NOTES_PATH), 'utf8');

test('without an open folder nothing is created and there is no context', async () => {
  const workspace = createWorkspace({ approve: async () => true });
  const notes = createProjectNotes({ getWorkspace: () => workspace });
  assert.deepEqual(await notes.ensure(), { created: false });
  assert.equal(await notes.context(), '');
  workspace.dispose();
});

test('an empty folder gets notes that say so, once', async (t) => {
  const { root, notes } = await folder(t, 'kiro-scalemax-ide');
  assert.deepEqual(await notes.ensure(), { created: true, path: NOTES_PATH });
  const text = readNotes(root);
  assert.match(text, /^# kiro-scalemax-ide\n/);
  assert.match(text, /was empty when ScaleMax first opened it/);
  assert.match(text, /## Tech stack\n- Nothing yet\./);
  assert.match(text, /_Created by ScaleMax on 2026-09-27 from a scan of the folder\._/);
  // Never overwritten: the user's edits survive.
  fs.writeFileSync(path.join(root, NOTES_PATH), '# mine\n');
  assert.deepEqual(await notes.ensure(), { created: false, path: NOTES_PATH });
  assert.equal(readNotes(root), '# mine\n');
});

test('two messages at once create the notes only once', async (t) => {
  const { notes } = await folder(t, 'race');
  const results = await Promise.all([notes.ensure(), notes.ensure()]);
  assert.equal(results.filter((result) => result.created).length, 1);
});

test('a Node project: overview, libraries, runner commands and structure', async (t) => {
  const { root, notes } = await folder(t, 'shop', {
    'package.json': JSON.stringify({ name: 'shop', description: 'unused because the README wins', scripts: { dev: 'vite', build: 'vite build', test: 'vitest run' }, dependencies: { react: '^19.0.0' }, devDependencies: { vite: '^6', vitest: '^3', typescript: '^5' } }),
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'tsconfig.json': '{}',
    'README.md': '# Shop\n\n[![build](https://x/badge.svg)](https://x)\n\nA small online shop for\nhandmade candles.\n\n## Setup\nRun it.\n',
    'src/main.tsx': 'export {}\n',
    'src/App.tsx': 'export {}\n',
    'src/components/Cart.tsx': 'export {}\n',
    '.env': 'STRIPE_SECRET=sk_live_do_not_read\n',
  });
  assert.equal((await notes.ensure()).created, true);
  const text = readNotes(root);
  assert.match(text, /## Overview\nA small online shop for handmade candles\./);
  assert.match(text, /- Node\.js package `shop` \(package\.json, pnpm\)/);
  assert.match(text, /- Libraries: React, Vite, TypeScript, Vitest/);
  assert.match(text, /- `pnpm install` — install dependencies\n- `pnpm dev` — runs `vite`\n- `pnpm build` — runs `vite build`\n- `pnpm test` — runs `vitest run`/);
  assert.match(text, /- `src\/` — 2 files, 1 folder \(components\/, App\.tsx, main\.tsx\)/);
  assert.ok(!text.includes('sk_live_do_not_read') && !text.includes('.env'), 'secret files are never read or listed');
});

test('Python, Rust, Go and Make projects are recognised', async (t) => {
  const { root, notes } = await folder(t, 'mixed', {
    'pyproject.toml': '[project]\nname = "mixed-tool"\ndescription = "Converts things."\n',
    'uv.lock': '',
    'tests/test_x.py': '',
    'Cargo.toml': '[package]\nname = "fast-core"\n',
    'go.mod': 'module example.com/mixed\n\ngo 1.22\n',
    Makefile: 'build:\n\tgo build\nlint: build\n\techo lint\nVAR := 1\n',
  });
  await notes.ensure();
  const text = readNotes(root);
  for (const expected of ['Python project `mixed-tool` (pyproject.toml, uv)', '`uv sync`', '`pytest` — run the tests', 'Rust crate `fast-core`', '`cargo test`', 'Go module `example.com/mixed`', '`go test ./...`', '`make build`', '`make lint`', '## Overview\nConverts things.']) {
    assert.ok(text.includes(expected), expected);
  }
  assert.ok(!text.includes('`make VAR`'));
});

test('context: notes, other agents\' instructions, always-on steering, top level, no secrets', async (t) => {
  const { notes } = await folder(t, 'app', {
    [NOTES_PATH]: '# app\nUse tabs.\n',
    'AGENTS.md': 'Run npm test before finishing.\n',
    'CLAUDE.md': 'Prefer small functions.\n',
    '.kiro/steering/tech.md': '---\ninclusion: always\n---\nWe use Postgres.\n',
    '.kiro/steering/api.md': '---\ninclusion: manual\n---\nOnly when asked.\n',
    '.kiro/steering/plain.md': 'No front matter.\n',
    '.env': 'SECRET=nope\n',
    'index.html': '<!doctype html>\n',
  });
  const text = await notes.context();
  assert.match(text, /^# Project context for "app"/);
  assert.match(text, /## Project notes \(\.scalemax\/SCALEMAX\.md\)\n# app\nUse tabs\./);
  assert.match(text, /## Project instructions from AGENTS\.md\nRun npm test before finishing\./);
  assert.match(text, /## Project instructions from CLAUDE\.md\nPrefer small functions\./);
  assert.match(text, /## Project instructions from \.kiro\/steering\/tech\.md\nWe use Postgres\./);
  assert.match(text, /## Project instructions from \.kiro\/steering\/plain\.md\nNo front matter\./);
  assert.ok(!text.includes('Only when asked.'), 'manual steering is not loaded');
  assert.match(text, /## Top level of app right now \(5 entries\)\n\.kiro\/\n\.scalemax\/\nAGENTS\.md\nCLAUDE\.md\nindex\.html/);
  assert.ok(!text.includes('SECRET=nope') && !text.includes('.env'));
});

test('context without notes says so; large notes are cut with a pointer', async (t) => {
  const { root, notes } = await folder(t, 'big');
  assert.match(await notes.context(), /This folder has no \.scalemax\/SCALEMAX\.md yet\./);
  fs.mkdirSync(path.join(root, '.scalemax'));
  fs.writeFileSync(path.join(root, NOTES_PATH), `# big\n${'x'.repeat(40 * 1024)}\n`);
  const text = await notes.context();
  assert.match(text, /\[… cut here; read \.scalemax\/SCALEMAX\.md for the rest\]/);
  assert.ok(Buffer.byteLength(text) < 30 * 1024);
});

test('context shows the Git branch and changed files', { skip: spawnSync('git', ['--version']).status !== 0 }, async (t) => {
  const { root, notes } = await folder(t, 'repo', { 'a.txt': 'one\n' });
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  // `git init -b` needs Git 2.28; name the branch the portable way.
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'add', '.');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'new\n');
  const text = await notes.context();
  assert.match(text, /## Git\nBranch main; 2 changed files:\n M a\.txt\n\?\? b\.txt/);
  await notes.ensure();
  assert.match(readNotes(root), /Git repository \(branch `main`\)/);
});

test('/init detection and helpers', () => {
  assert.ok(isInitCommand('/init') && isInitCommand('  /INIT \n'));
  assert.ok(!isInitCommand('/init please') && !isInitCommand('init') && !isInitCommand(null));
  assert.match(INIT_PROMPT, /\.scalemax\/SCALEMAX\.md/);
  assert.equal(firstParagraph('---\ntitle: x\n---\n# T\n\n```\ncode\n```\nReal text\ncontinues.\n\nNext.'), 'Real text continues.');
  assert.deepEqual(frontMatter('---\ninclusion: fileMatch\nfileMatchPattern: "*.ts"\n---\nbody').data, { inclusion: 'fileMatch', filematchpattern: '*.ts' });
});

test('a refused folder keeps the open one open', async (t) => {
  const { root, workspace } = await folder(t, 'keep-me', { 'a.txt': 'a\n' });
  await assert.rejects(workspace.select(path.join(root, 'missing')), { code: 'ENOENT' });
  await assert.rejects(workspace.select(os.homedir()), { code: 'UNSAFE_ROOT' });
  assert.equal(workspace.current().path, root);
  assert.equal((await workspace.read('a.txt')).content, 'a\n');
});

const { createWorkspaceTools } = require('../lib/workspace-tools.cjs');
const { prepareChatRequest } = require('../lib/project-notes.cjs');

test('prepareChatRequest: first message creates notes, adds context and the folder marker', async (t) => {
  const { root, workspace, notes } = await folder(t, 'kiro-scalemax-ide', { 'README.md': '# Demo\n\nA demo app.\n' });
  const workspaceTools = createWorkspaceTools({ getWorkspace: () => workspace });
  const input = { requestId: 'r1', systemPrompt: 'Be brief.', messages: [{ role: 'assistant', content: 'hi' }, { role: 'user', content: 'current folder name' }] };
  const first = await prepareChatRequest(input, { workspaceTools, projectNotes: notes });
  assert.deepEqual(first.notes, { created: true, path: NOTES_PATH });
  assert.ok(fs.existsSync(path.join(root, NOTES_PATH)));
  const prompt = first.input.systemPrompt;
  assert.ok(prompt.startsWith('Be brief.\n\nYou are working in the user\'s project folder "kiro-scalemax-ide"'));
  assert.match(prompt, /# Project context for "kiro-scalemax-ide"/);
  assert.match(prompt, /## Project notes \(\.scalemax\/SCALEMAX\.md\)\n# kiro-scalemax-ide/);
  assert.match(prompt, /## Overview\nA demo app\./);
  assert.equal(first.input.messages[1].content, 'current folder name\n\n[Workspace folder right now: "kiro-scalemax-ide"]');
  assert.equal(first.input.messages[0].content, 'hi');
  assert.equal(input.messages[1].content, 'current folder name', 'the caller\'s input is not changed');
  // Second message: notes exist, nothing is created.
  assert.deepEqual((await prepareChatRequest(input, { workspaceTools, projectNotes: notes })).notes, { created: false, path: NOTES_PATH });
});

test('prepareChatRequest: /init, notes turned off, and no folder', async (t) => {
  const { root, workspace, notes } = await folder(t, 'app');
  const workspaceTools = createWorkspaceTools({ getWorkspace: () => workspace });
  const init = await prepareChatRequest({ requestId: 'r2', messages: [{ role: 'user', content: '/init' }] }, { workspaceTools, projectNotes: notes, notesEnabled: false });
  assert.equal(init.notes, null);
  assert.ok(!fs.existsSync(path.join(root, NOTES_PATH)), 'turned off: nothing created');
  assert.ok(init.input.messages[0].content.startsWith(INIT_PROMPT));
  assert.match(init.input.systemPrompt, /This folder has no \.scalemax\/SCALEMAX\.md yet/);
  const empty = createWorkspace({ approve: async () => true });
  t.after(() => empty.dispose());
  const none = await prepareChatRequest({ requestId: 'r3', messages: [{ role: 'user', content: '/init' }] }, {
    workspaceTools: createWorkspaceTools({ getWorkspace: () => empty }),
    projectNotes: createProjectNotes({ getWorkspace: () => empty }),
  });
  assert.equal(none.notes, null);
  assert.match(none.input.systemPrompt, /^No workspace folder is open/);
  assert.match(none.input.messages[0].content, /no folder is open/);
});
