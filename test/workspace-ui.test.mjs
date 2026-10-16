import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  extOf, languageFor, languageLabel, languageIds, fenceLanguage, lineBreakOf, indentFor, cursorPosition, locationText,
  originalFromHunks, reviewTargets, visibleTreeRows, refreshedTree,
} from '../src/workspace-ui.js';

const { diffLines } = createRequire(import.meta.url)('../lib/line-diff.cjs');

// A seeded generator, so a failing random case can be replayed.
function random(seed) {
  let value = seed;
  return () => { value = (value * 1103515245 + 12345) % 2 ** 31; return value / 2 ** 31; };
}

test('extensions and languages come from the file name', () => {
  assert.equal(extOf('src/app.js'), 'js');
  assert.equal(extOf('README.MD'), 'md');
  assert.equal(extOf('.gitignore'), '');
  assert.equal(extOf('archive.tar.gz'), 'gz');
  assert.equal(languageFor('lib/state.cjs'), 'javascript');
  assert.equal(languageFor('src/types.d.ts'), 'typescript');
  assert.equal(languageFor('src/App.tsx'), 'tsx');
  assert.equal(languageFor('src/Button.jsx'), 'jsx');
  assert.equal(languageFor('package.json'), 'json');
  assert.equal(languageFor('src/styles.css'), 'css');
  assert.equal(languageFor('src/theme.scss'), 'scss');
  assert.equal(languageFor('index.html'), 'html');
  assert.equal(languageFor('docs/guide.md'), 'markdown');
  assert.equal(languageFor('tool.py'), 'python');
  assert.equal(languageFor('src/main.rs'), 'rust');
  assert.equal(languageFor('cmd/server.go'), 'go');
  assert.equal(languageFor('App.java'), 'java');
  assert.equal(languageFor('include/list.h'), 'c');
  assert.equal(languageFor('src/list.cpp'), 'cpp');
  assert.equal(languageFor('public/index.php'), 'php');
  assert.equal(languageFor('db/schema.sql'), 'sql');
  assert.equal(languageFor('assets/icon.svg'), 'xml');
  assert.equal(languageFor('Info.plist'), 'xml');
  assert.equal(languageFor('scripts/run.sh'), 'shell');
  assert.equal(languageFor('.github/ci.yml'), 'yaml');
  assert.equal(languageFor('Cargo.toml'), 'toml');
  assert.equal(languageFor('Makefile'), 'shell');
  assert.equal(languageFor('.eslintrc'), 'json');
  assert.equal(languageFor('LICENSE'), 'plain');
  assert.equal(languageLabel('typescript'), 'TypeScript');
  assert.equal(languageLabel('cpp'), 'C++');
  assert.equal(languageLabel('plain'), 'Plain text');
  assert.ok(!languageIds().includes('plain'));
  for (const id of languageIds()) assert.notEqual(languageLabel(id), 'Plain text', id);
});

test('a Markdown code fence names its language by id, extension or common name', () => {
  assert.equal(fenceLanguage('js'), 'javascript');
  assert.equal(fenceLanguage('typescript'), 'typescript');
  assert.equal(fenceLanguage('ts title="a.ts"'), 'typescript');
  assert.equal(fenceLanguage('py'), 'python');
  assert.equal(fenceLanguage('bash'), 'shell');
  assert.equal(fenceLanguage('golang'), 'go');
  assert.equal(fenceLanguage('c++'), 'cpp');
  assert.equal(fenceLanguage('rs'), 'rust');
  assert.equal(fenceLanguage('JSON'), 'json');
  assert.equal(fenceLanguage('yml'), 'yaml');
  assert.equal(fenceLanguage(''), null);
  assert.equal(fenceLanguage('brainfuck'), null);
  assert.equal(fenceLanguage('constructor'), null, 'no prototype names');
});

test('a text keeps its own line breaks', () => {
  assert.equal(lineBreakOf(''), '\n');
  assert.equal(lineBreakOf('one line'), '\n');
  assert.equal(lineBreakOf('a\nb\n'), '\n');
  assert.equal(lineBreakOf('a\r\nb\r\n'), '\r\n');
  assert.equal(lineBreakOf('a\r\nb'), '\r\n');
  assert.equal(lineBreakOf('a\rb\r'), '\r');
  // Mixed: '\n' splits the lines and any '\r' stays a character, so nothing is rewritten.
  assert.equal(lineBreakOf('a\r\nb\nc'), '\n');
  assert.equal(lineBreakOf('a\r\r\nb'), '\n');
  assert.equal(lineBreakOf('a\rb\nc'), '\n');
});

test('indentation is guessed from the file, else from its language', () => {
  assert.equal(indentFor('function a() {\n  return 1;\n}\n', 'javascript'), '  ');
  assert.equal(indentFor('def a():\n    if x:\n        return 1\n    return 2\n', 'python'), '    ');
  assert.equal(indentFor('func a() {\n\treturn 1\n}\n', 'go'), '\t');
  assert.equal(indentFor('{\n\t"a": 1,\n\t"b": 2\n}\n', 'json'), '\t');
  // JSDoc's " * " alignment is not indentation.
  assert.equal(indentFor('/**\n * Doc.\n */\nclass A {\n    b() {\n        return 1;\n    }\n}\n', 'javascript'), '    ');
  assert.equal(indentFor('a: 1\nb:\n  c: 2\n  d:\n    e: 3\n', 'yaml'), '  ');
  assert.equal(indentFor('', 'javascript'), '  ');
  assert.equal(indentFor('', 'python'), '    ');
  assert.equal(indentFor('', 'rust'), '    ');
  assert.equal(indentFor('package main\n', 'go'), '\t');
  assert.equal(indentFor('no indent here', 'plain'), '  ');
});

test('cursor position is 1-based line and column', () => {
  assert.deepEqual(cursorPosition('abc', 0), { line: 1, column: 1 });
  assert.deepEqual(cursorPosition('abc\ndef', 5), { line: 2, column: 2 });
  assert.deepEqual(cursorPosition('a\n\nb', 2), { line: 2, column: 1 });
  assert.deepEqual(cursorPosition('a\nb', 99), { line: 2, column: 2 });
});

test('the statusbar location names the selection and the cursors', () => {
  assert.equal(locationText(), 'Ln 1, Col 1');
  assert.equal(locationText({ line: 3, column: 7 }), 'Ln 3, Col 7');
  assert.equal(locationText({ line: 3, column: 7, selected: 12 }), 'Ln 3, Col 7 (12 selected)');
  assert.equal(locationText({ line: 2, column: 1, selected: 6, cursors: 3 }), 'Ln 2, Col 1 (6 selected) \u00b7 3 cursors');
});

test('the text before a reply is rebuilt from the text after it and the reply\'s diff', () => {
  const cases = [
    ['a\nb\nc\n', 'a\nB\nc\n'],
    ['', 'new file\nwith two lines\n'],
    ['one\ntwo\n', 'one\ntwo\nthree\n'],
    ['keep\ndrop\n', 'keep\n'],
    ['no final break', 'no final break\n'],
    ['final break\n', 'final break'],
    ['crlf\r\nlines\r\n', 'crlf\r\nLINES\r\n'],
    [Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n'), Array.from({ length: 60 }, (_, index) => (index % 17 ? `line ${index}` : `changed ${index}`)).join('\n')],
  ];
  for (const [before, after] of cases) {
    assert.equal(originalFromHunks(after, diffLines(before, after)), before, JSON.stringify(before));
  }
  // Random edits over a small alphabet, so lines repeat (the hard case for a diff).
  const next = random(11);
  const pick = (items) => items[Math.floor(next() * items.length)];
  for (let round = 0; round < 400; round += 1) {
    const base = Array.from({ length: Math.floor(next() * 30) }, () => pick(['a', 'b', 'c', '', '  x', 'y\r']));
    const edited = base.filter(() => next() > 0.2).flatMap((line) => (next() < 0.15 ? [line, pick(['a', 'z', 'q'])] : [line]));
    const before = base.join('\n') + (next() < 0.5 ? '\n' : '');
    const after = edited.join('\n') + (next() < 0.5 ? '\n' : '');
    const diff = diffLines(before, after);
    // A reply that emptied a file is the one case the diff cannot settle.
    if (!after && before) {
      assert.equal(originalFromHunks(after, diff), null);
      continue;
    }
    assert.equal(originalFromHunks(after, diff), before, `round ${round}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  }
});

test('a diff that does not fit the text, or is incomplete, rebuilds nothing', () => {
  const before = 'a\nb\nc\nd\n';
  const after = 'a\nB\nc\nd\n';
  const diff = diffLines(before, after);
  assert.equal(originalFromHunks('a\nX\nc\nd\n', diff), null, 'the file changed since the reply');
  assert.equal(originalFromHunks(after, { ...diff, truncated: true }), null);
  assert.equal(originalFromHunks(after, { noDiff: true, hunks: [] }), null);
  assert.equal(originalFromHunks(after, { untracked: true, hunks: [] }), null);
  assert.equal(originalFromHunks(after, null), null);
  assert.equal(originalFromHunks(after, { hunks: [{ lines: [{ type: '?', text: 'x' }] }] }), null);
  assert.equal(originalFromHunks(after, { hunks: [{ lines: [{ type: '-', text: 'x' }] }] }), null, 'no line number');
  assert.equal(originalFromHunks('', diffLines('was here\n', '')), null, 'an emptied file');
  assert.equal(originalFromHunks(after, { hunks: [] }), after, 'no hunks: nothing changed');
});

test('a reply\'s changes are reviewed in clean open tabs only', () => {
  const changes = {
    id: 'chat-1',
    files: [
      { path: 'a.js', status: 'changed' },
      { path: 'b.js', status: 'changed' },
      { path: 'c.js', status: 'kept' },
      { path: 'd.js', status: 'changed', untracked: true },
      { path: 'e.js', status: 'changed' },
    ],
  };
  const tabs = [{ path: 'a.js', dirty: false }, { path: 'b.js', dirty: true }, { path: 'c.js' }, { path: 'd.js' }];
  assert.deepEqual(reviewTargets(changes, tabs), ['a.js']);
  assert.deepEqual(reviewTargets(changes, tabs, ['b.js']), []);
  assert.deepEqual(reviewTargets(changes, [...tabs, { path: 'e.js' }], ['e.js']), ['e.js']);
  assert.deepEqual(reviewTargets(null, tabs), []);
});

test('visible tree rows follow expansion and filtering', () => {
  const files = [
    { name: 'src', path: 'src', type: 'directory' },
    { name: 'README.md', path: 'README.md', type: 'file' },
  ];
  const tree = {
    src: [
      { name: 'app.js', path: 'src/app.js', type: 'file' },
      { name: 'lib', path: 'src/lib', type: 'directory' },
    ],
  };
  const paths = (rows) => rows.map((row) => (row.kind === 'entry' ? `${row.depth}:${row.entry.path}` : `${row.depth}:(empty)`));
  assert.deepEqual(paths(visibleTreeRows(files, {})), ['0:src', '0:README.md']);
  assert.deepEqual(paths(visibleTreeRows(files, { expanded: new Set(['src']), tree })),
    ['0:src', '1:src/app.js', '1:src/lib', '0:README.md']);
  assert.deepEqual(paths(visibleTreeRows(files, { expanded: new Set(['src', 'src/lib']), tree })),
    ['0:src', '1:src/app.js', '1:src/lib', '2:(empty)', '0:README.md']);
  // Filtering searches loaded folders even when collapsed and keeps ancestors.
  assert.deepEqual(paths(visibleTreeRows(files, { tree, query: 'APP' })), ['0:src', '1:src/app.js']);
  assert.deepEqual(paths(visibleTreeRows(files, { tree, query: 'readme' })), ['0:README.md']);
  assert.deepEqual(visibleTreeRows(files, { tree, query: 'zzz' }), []);
});

test('a refresh keeps the open folders open, closes the ones that are gone', () => {
  const fresh = [{ name: 'new.js', path: 'src/new.js', type: 'file' }];
  const loaded = [{ name: 'later.js', path: 'lib/later.js', type: 'file' }];
  const { expanded, tree } = refreshedTree(
    new Set(['src', 'gone', 'lib', 'never-loaded']),
    new Map([['src', fresh], ['gone', null]]),
    { src: [{ name: 'old.js', path: 'src/old.js', type: 'file' }], gone: [], lib: loaded, closed: [] },
  );
  // src read again; gone closed; lib opened while the listings were read keeps what it loaded;
  // a closed folder's cached listing is dropped.
  assert.deepEqual([...expanded], ['src', 'lib']);
  assert.deepEqual(tree, { src: fresh, lib: loaded });
  assert.deepEqual(refreshedTree(new Set(), new Map(), { src: [] }), { expanded: new Set(), tree: {} });
});
