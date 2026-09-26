import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extOf, languageFor, languageLabel, tokenize, cursorPosition, indentLines, visibleTreeRows,
} from '../src/workspace-ui.js';

const LANGUAGES = ['javascript', 'typescript', 'json', 'css', 'html', 'markdown', 'python', 'shell', 'yaml', 'toml', 'plain'];

test('extensions and languages come from the file name', () => {
  assert.equal(extOf('src/app.js'), 'js');
  assert.equal(extOf('README.MD'), 'md');
  assert.equal(extOf('.gitignore'), '');
  assert.equal(extOf('archive.tar.gz'), 'gz');
  assert.equal(languageFor('lib/state.cjs'), 'javascript');
  assert.equal(languageFor('src/types.d.ts'), 'typescript');
  assert.equal(languageFor('package.json'), 'json');
  assert.equal(languageFor('src/styles.css'), 'css');
  assert.equal(languageFor('index.html'), 'html');
  assert.equal(languageFor('docs/guide.md'), 'markdown');
  assert.equal(languageFor('tool.py'), 'python');
  assert.equal(languageFor('scripts/run.sh'), 'shell');
  assert.equal(languageFor('.github/ci.yml'), 'yaml');
  assert.equal(languageFor('Cargo.toml'), 'toml');
  assert.equal(languageFor('Makefile'), 'shell');
  assert.equal(languageFor('LICENSE'), 'plain');
  assert.equal(languageLabel('typescript'), 'TypeScript');
  assert.equal(languageLabel('plain'), 'Plain text');
});

test('tokenize always reproduces the input exactly', () => {
  const samples = [
    'const a = "x\\"y"; // done\nlet b = `t ${a}\nline` + 0x1F /* block\ncomment */',
    '{ "key": [1, 2.5e3, true, null], "s": "v" }',
    'a:hover { color: #fff; margin: 0 4px !important; } @media (x) {}',
    '<!doctype html><div class="a" data-x=\'y\'><!-- c --></div>',
    '# Title\n- item **bold** `code`\n```js\nx\n```\n> quote [link](https://x)',
    'def f(x):\n    """doc"""\n    return x + 1  # c\n@decorator\nclass A: pass',
    'if [ "$HOME" ]; then echo ${USER} $1 # note\nfi',
    'key: value # c\nlist:\n  - a\n  - "b"\nflag: true',
    '[tool]\nname = "x"\ncount = 3 # c',
    '', '\n\n', '"unterminated', '/* open', '```never closed',
  ];
  for (const language of LANGUAGES) {
    for (const sample of samples) {
      const segments = tokenize(sample, language);
      assert.equal(segments.map(([, text]) => text).join(''), sample, `${language}: ${JSON.stringify(sample)}`);
      for (const [type, text] of segments) {
        assert.ok(type === null || typeof type === 'string');
        assert.ok(text.length > 0, 'no empty segments');
      }
    }
  }
  // Randomized round trip.
  const alphabet = 'abc{}[]()<>"\'`#/*\\\n\t =:;.,$@-0123456789';
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  for (let round = 0; round < 300; round += 1) {
    const length = Math.floor(random() * 80);
    let text = '';
    for (let index = 0; index < length; index += 1) text += alphabet[Math.floor(random() * alphabet.length)];
    for (const language of LANGUAGES) {
      assert.equal(tokenize(text, language).map(([, part]) => part).join(''), text);
    }
  }
});

test('tokenize classifies the main token kinds', () => {
  const kinds = (text, language) => tokenize(text, language).filter(([type]) => type).map(([type, part]) => `${type}:${part}`);
  assert.deepEqual(kinds('const x = 42; // hi', 'javascript'), ['keyword:const', 'number:42', 'comment:// hi']);
  assert.deepEqual(kinds('return "a"', 'typescript'), ['keyword:return', 'string:"a"']);
  assert.deepEqual(kinds('{"k": false}', 'json'), ['attr:"k"', 'keyword:false']);
  assert.ok(kinds('p { color: red; }', 'css').includes('attr:color'));
  assert.ok(!kinds('a:hover { x: 1; }', 'css').includes('attr:a'), 'selectors are not properties');
  assert.ok(kinds('<a href="x">', 'html').includes('tag:<a'));
  assert.ok(kinds('<a href="x">', 'html').includes('attr:href'));
  assert.ok(kinds('# Heading', 'markdown').includes('heading:# Heading'));
  assert.ok(kinds('def f(): pass', 'python').includes('keyword:def'));
  assert.ok(kinds('echo $HOME', 'shell').includes('attr:$HOME'));
  assert.ok(kinds('name: x', 'yaml').includes('attr:name'));
  assert.deepEqual(tokenize('plain text', 'plain'), [[null, 'plain text']]);
});

test('cursor position is 1-based line and column', () => {
  assert.deepEqual(cursorPosition('abc', 0), { line: 1, column: 1 });
  assert.deepEqual(cursorPosition('abc\ndef', 5), { line: 2, column: 2 });
  assert.deepEqual(cursorPosition('a\n\nb', 2), { line: 2, column: 1 });
  assert.deepEqual(cursorPosition('a\nb', 99), { line: 2, column: 2 });
});

test('indentLines indents and outdents every touched line', () => {
  const text = 'one\ntwo\nthree';
  const indented = indentLines(text, 0, 7);
  assert.equal(indented.replacement, '  one\n  two');
  assert.equal(indented.blockStart, 0);
  assert.equal(indented.blockEnd, 7);
  assert.equal(indented.selectionStart, 2);
  assert.equal(indented.selectionEnd, 11);
  const outdented = indentLines('  one\n    two\nthree', 3, 12, true);
  assert.equal(outdented.replacement, 'one\n  two');
  // A selection ending right after a newline does not touch the next line.
  assert.equal(indentLines('a\nb\nc', 0, 2).replacement, '  a');
  // Outdenting a line with no indent leaves it alone.
  assert.equal(indentLines('x', 0, 1, true).replacement, 'x');
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
