import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, renderMarkdown } from '../src/markdown.js';

// Inline nodes as a compact string: <S>strong</S> <E>em</E> <D>del</D> `code` <A href>link</A> ⏎ = br.
function show(nodes) {
  return nodes.map((node) => {
    if (node.type === 'text') return node.text;
    if (node.type === 'br') return '⏎';
    if (node.type === 'code') return `\`${node.text}\``;
    if (node.type === 'strong') return `<S>${show(node.children)}</S>`;
    if (node.type === 'em') return `<E>${show(node.children)}</E>`;
    if (node.type === 'del') return `<D>${show(node.children)}</D>`;
    if (node.type === 'link') return `<A ${node.href}>${show(node.children)}</A>`;
    return `?${node.type}`;
  }).join('');
}

// The inline content of a one-paragraph text.
function inline(text) {
  const blocks = parseMarkdown(text);
  assert.equal(blocks.length, 1, `one block for ${JSON.stringify(text)}`);
  assert.equal(blocks[0].type, 'paragraph');
  return show(blocks[0].children);
}

// Blocks as plain values for readable comparisons.
function outline(blocks) {
  return blocks.map((block) => {
    if (block.type === 'paragraph') return show(block.children);
    if (block.type === 'heading') return { h: block.level, text: show(block.children) };
    if (block.type === 'code') return { code: block.text, lang: block.lang };
    if (block.type === 'hr') return 'hr';
    if (block.type === 'blockquote') return { quote: outline(block.blocks) };
    if (block.type === 'table') return { table: block.align, head: block.head.map(show), rows: block.rows.map((row) => row.map(show)) };
    if (block.type === 'list') {
      const list = { [block.ordered ? 'ol' : 'ul']: block.items.map((item) => (item.checked === null ? outline(item.blocks) : { checked: item.checked, blocks: outline(item.blocks) })) };
      if (!block.tight) list.loose = true;
      if (block.ordered && block.start !== 1) list.start = block.start;
      return list;
    }
    return `?${block.type}`;
  });
}

const md = (text) => outline(parseMarkdown(text));

test('a typical model reply: bold, a list right after a line, code spans', () => {
  const reply = "We're in the **canvaautowebsitebykiro** workspace root. Here's what's here:\n\n**8 folders:**\n- `.scalemax/` — ScaleMax project notes\n- `brand/` — brand assets (bot-profile.png)\n- `server/` — Node.js server\n\n**4 files:**\n- `.gitignore`\n- `package.json`\n\nWhat would you like to do?";
  assert.deepEqual(md(reply), [
    "We're in the <S>canvaautowebsitebykiro</S> workspace root. Here's what's here:",
    '<S>8 folders:</S>',
    { ul: [['`.scalemax/` — ScaleMax project notes'], ['`brand/` — brand assets (bot-profile.png)'], ['`server/` — Node.js server']] },
    '<S>4 files:</S>',
    { ul: [['`.gitignore`'], ['`package.json`']] },
    'What would you like to do?',
  ]);
});

test('paragraphs keep their line breaks; blank lines separate them', () => {
  assert.deepEqual(md('one\ntwo\n\nthree'), ['one⏎two', 'three']);
  assert.deepEqual(md('ends with a hard break\\\nnext'), ['ends with a hard break⏎next']);
  assert.deepEqual(md('   \n\n'), []);
});

test('emphasis with asterisks needs text right inside the markers', () => {
  assert.equal(inline('**bold** and *it* and ***both***'), '<S>bold</S> and <E>it</E> and <S><E>both</E></S>');
  assert.equal(inline('**a *b* c**'), '<S>a <E>b</E> c</S>');
  assert.equal(inline('*a **b** c*'), '<E>a <S>b</S> c</E>');
  assert.equal(inline('2 * 3 * 4 and a * b'), '2 * 3 * 4 and a * b');
  assert.equal(inline('**not closed and *this is*'), '**not closed and <E>this is</E>');
  assert.equal(inline('**bold **'), '**bold **');
  assert.equal(inline('~~gone~~ and ~single~'), '<D>gone</D> and ~single~');
});

test('underscores only emphasise at word boundaries', () => {
  for (const literal of ['snake_case_name', '__init__.py', 'my_file_v2.txt', '__dirname', 'a_b_c and x__y__z', 'file_.txt']) {
    assert.equal(inline(literal), literal);
  }
  assert.equal(inline('__important__.'), '<S>important</S>.');
  assert.equal(inline('an _aside_, then (_quoted_)'), 'an <E>aside</E>, then (<E>quoted</E>)');
  assert.equal(inline('_note_'), '<E>note</E>');
});

test('code spans are literal, backslashes included', () => {
  assert.equal(inline('run `npm test` now'), 'run `npm test` now');
  assert.equal(inline('`` a ` b ``'), '`a ` b`');
  assert.equal(inline('`**not bold**` and `<b>`'), '`**not bold**` and `<b>`');
  assert.equal(inline('path `C:\\Users\\` here'), 'path `C:\\Users\\` here');
  assert.equal(inline('\\`not code\\` and \\*stars\\*'), '`not code` and *stars*');
  assert.equal(inline('an ` unmatched backtick'), 'an ` unmatched backtick');
});

test('links: web and mail links only; everything else is its text', () => {
  assert.equal(inline('[docs](https://example.com/a_(b) "Docs")'), '<A https://example.com/a_(b)>docs</A>');
  assert.equal(inline('[**bold** link](http://x.dev/path)'), '<A http://x.dev/path><S>bold</S> link</A>');
  assert.equal(inline('[click](javascript:alert(1))'), 'click');
  assert.equal(inline('[file](file:///etc/passwd) and [rel](./x.md)'), 'file and rel');
  assert.equal(inline('[a [nested](https://b.com) c](https://a.com)'), '<A https://a.com>a nested c</A>');
  assert.equal(inline('<https://example.com> and <mailto:me@example.com>'), '<A https://example.com>https://example.com</A> and <A mailto:me@example.com>me@example.com</A>');
  assert.equal(inline('[not a link] (https://x.com)'), '[not a link] (<A https://x.com>https://x.com</A>)');
});

test('bare URLs become links without trailing punctuation', () => {
  assert.equal(inline('See https://example.com/docs.'), 'See <A https://example.com/docs>https://example.com/docs</A>.');
  assert.equal(inline('(at https://x.dev/a_(b))'), '(at <A https://x.dev/a_(b)>https://x.dev/a_(b)</A>)');
  assert.equal(inline('**https://bold.dev**'), '<S><A https://bold.dev>https://bold.dev</A></S>');
  assert.equal(inline('xhttps://no.dev and http://'), 'xhttps://no.dev and http://');
});

test('raw HTML and entities stay literal text', () => {
  assert.equal(inline('<b>hi</b> &amp; <script>alert(1)</script>'), '<b>hi</b> &amp; <script>alert(1)</script>');
  assert.equal(inline('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
});

test('headings and thematic breaks', () => {
  assert.deepEqual(md('# Title\n## Sub ##\n###### Six\n#hashtag\n####### seven'), [
    { h: 1, text: 'Title' }, { h: 2, text: 'Sub' }, { h: 6, text: 'Six' }, '#hashtag⏎####### seven',
  ]);
  assert.deepEqual(md('a\n---\nb\n***\n* * *\n- - -\n___'), ['a', 'hr', 'b', 'hr', 'hr', 'hr', 'hr']);
  assert.deepEqual(md('# C# notes'), [{ h: 1, text: 'C# notes' }]);
});

test('fenced code blocks', () => {
  assert.deepEqual(md('Run:\n```bash\nnpm test\n  npm run lint\n```\ndone'), [
    'Run:', { code: 'npm test\n  npm run lint', lang: 'bash' }, 'done',
  ]);
  assert.deepEqual(md('~~~\nplain <b>text</b>\n~~~'), [{ code: 'plain <b>text</b>', lang: '' }]);
  assert.deepEqual(md('````md\n```js\ninner\n```\n````'), [{ code: '```js\ninner\n```', lang: 'md' }]);
  assert.deepEqual(md('```py\nunterminated\nstill code'), [{ code: 'unterminated\nstill code', lang: 'py' }]);
  assert.deepEqual(md('``` not `a fence`'), ['``` not `a fence`']);
});

test('lists: tight and loose, nesting at 2, 3 and 4 spaces, ordered starts, tasks', () => {
  assert.deepEqual(md('- a\n- b\n  - b1\n  - b2\n- c'), [{ ul: [['a'], ['b', { ul: [['b1'], ['b2']] }], ['c']] }]);
  assert.deepEqual(md('1. one\n   - x\n2. two\n  - y'), [{ ol: [['one', { ul: [['x']] }], ['two', { ul: [['y']] }]] }]);
  assert.deepEqual(md('- a\n    - deep\n- b'), [{ ul: [['a', { ul: [['deep']] }], ['b']] }]);
  assert.deepEqual(md('- a\n\n- b'), [{ ul: [['a'], ['b']], loose: true }]);
  assert.deepEqual(md('3. three\n4. four'), [{ ol: [['three'], ['four']], start: 3 }]);
  assert.deepEqual(md('- [ ] todo\n- [x] done\n- [X] also'), [{ ul: [
    { checked: false, blocks: ['todo'] }, { checked: true, blocks: ['done'] }, { checked: true, blocks: ['also'] },
  ] }]);
  assert.deepEqual(md('Steps:\n1. a\n2. b'), ['Steps:', { ol: [['a'], ['b']] }]);
  assert.deepEqual(md('Year\n2023. was good'), ['Year⏎2023. was good']);
  assert.deepEqual(md('- item\nlazy line\n- next'), [{ ul: [['item⏎lazy line'], ['next']] }]);
  assert.deepEqual(md('- a\n\nafter'), [{ ul: [['a']] }, 'after']);
  assert.deepEqual(md('- a\n1. b'), [{ ul: [['a']] }, { ol: [['b']] }]);
  assert.deepEqual(md('- a\n* * *\n- b'), [{ ul: [['a']] }, 'hr', { ul: [['b']] }]);
  assert.deepEqual(md('-no space\n+1 vote'), ['-no space⏎+1 vote']);
});

test('code inside list items, indented or not', () => {
  assert.deepEqual(md('1. Install:\n   ```bash\n   npm install\n   ```\n2. Run'), [
    { ol: [['Install:', { code: 'npm install', lang: 'bash' }], ['Run']] },
  ]);
  // The fence is indented but its lines are not: the item keeps them until the fence closes.
  assert.deepEqual(md('- Build:\n  ```\nmake all\n  ```\n- Done'), [
    { ul: [['Build:', { code: 'make all', lang: '' }], ['Done']] },
  ]);
});

test('blockquotes hold blocks and continue lazily', () => {
  assert.deepEqual(md('> **Note:** careful\nstill quoted\n>\n> - a\n> - b\n\nout'), [
    { quote: ['<S>Note:</S> careful⏎still quoted', { ul: [['a'], ['b']] }] }, 'out',
  ]);
});

test('GitHub tables: alignment, escaped pipes, uneven rows, after a paragraph line', () => {
  assert.deepEqual(md('Results:\n| Name | Count | Note |\n|:-----|------:|:----:|\n| `a\\|b` | 2 | **ok** |\n| c |\n| d | 4 | x | extra |\n\nafter'), [
    'Results:',
    { table: ['left', 'right', 'center'], head: ['Name', 'Count', 'Note'], rows: [['`a|b`', '2', '<S>ok</S>'], ['c', '', ''], ['d', '4', 'x']] },
    'after',
  ]);
  assert.deepEqual(md('a | b\n--- | ---\n1 | 2'), [{ table: [null, null], head: ['a', 'b'], rows: [['1', '2']] }]);
  // A header and a delimiter row with different cell counts are not a table.
  assert.deepEqual(md('| a | b |\n| --- |'), ['| a | b |⏎| --- |']);
});

// Each case takes well under 100 ms alone; the bound leaves room for a busy machine (npm test runs
// the test files in parallel) while a quadratic parser would take many seconds here.
function timed(label, text) {
  const started = performance.now();
  parseMarkdown(text);
  const ms = performance.now() - started;
  assert.ok(ms < 1500, `${label} took ${Math.round(ms)} ms`);
}

test('pathological input parses fast', () => {
  timed('20000 stars', '*'.repeat(20000));
  timed('20000 brackets', '['.repeat(20000));
  timed('unclosed emphasis', '*a '.repeat(6600));
  timed('unclosed underscores', '_a '.repeat(6600));
  timed('unclosed strong', '**a '.repeat(5000));
  timed('unclosed links', '[a](x "'.repeat(2800));
  timed('backticks', '`a ``b '.repeat(3000));
  timed('5000 quote markers', '>'.repeat(5000));
  timed('5000 quote lines', '> a\n'.repeat(5000));
  timed('indentation stairs', Array.from({ length: 300 }, (_, level) => `${' '.repeat(level * 2)}- item`).join('\n'));
  timed('many list items', '- item\n'.repeat(20000));
  timed('long heading spaces', `#${' '.repeat(50000)}x`);
  timed('pipes', `${'|'.repeat(20000)}\n${'|-'.repeat(5000)}`);
});

test('very long replies are plain text', () => {
  const blocks = parseMarkdown(`**x** ${'y'.repeat(200001)}`);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].children[0].text.startsWith('**x**'), true);
});

// ---- DOM mapping with a small fake document -------------------------------------------------

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = {};
    this.childNodes = [];
    this.listeners = {};
    this.className = '';
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...nodes) {
    for (const node of nodes) {
      if (typeof node !== 'object') throw new Error('only nodes are appended');
      this.childNodes.push(node);
    }
  }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  set textContent(value) { this.childNodes = [{ nodeType: 3, data: String(value) }]; }
  get textContent() { return this.childNodes.map((node) => (node.nodeType === 3 ? node.data : node.textContent)).join(''); }
  set innerHTML(_value) { throw new Error('innerHTML must not be used'); }
  get innerHTML() { throw new Error('innerHTML must not be used'); }
  get style() { throw new Error('inline styles must not be used'); }
  get children() { return this.childNodes.filter((node) => node instanceof FakeElement); }
  find(tagName) {
    for (const child of this.children) {
      if (child.tagName === tagName) return child;
      const found = child.find(tagName);
      if (found) return found;
    }
    return null;
  }
}

const fakeDocument = {
  createElement: (tagName) => new FakeElement(tagName),
  createTextNode: (data) => ({ nodeType: 3, data: String(data) }),
  createDocumentFragment: () => new FakeElement('#fragment'),
};

const render = (text) => renderMarkdown(text, fakeDocument);

test('renders elements with text nodes only', () => {
  const root = render('We use **ScaleMax** with `node`.\n\n- one\n- two');
  const [p, ul] = root.children;
  assert.equal(p.tagName, 'p');
  assert.deepEqual(p.children.map((node) => node.tagName), ['strong', 'code']);
  assert.equal(p.textContent, 'We use ScaleMax with node.');
  assert.equal(ul.tagName, 'ul');
  assert.equal(ul.className, 'md-tight');
  assert.deepEqual(ul.children.map((li) => li.textContent), ['one', 'two']);
  // Tight items hold their text directly (no <p> inside).
  assert.equal(ul.children[0].children.length, 0);
});

test('links open in a new window with safe attributes; unsafe ones are text', () => {
  const p = render('[docs](https://example.com) and [bad](javascript:alert(1))').children[0];
  const link = p.children[0];
  assert.equal(link.tagName, 'a');
  assert.deepEqual(link.attributes, { href: 'https://example.com', target: '_blank', rel: 'noopener noreferrer', title: 'https://example.com' });
  assert.equal(link.className, 'md-link');
  assert.equal(p.children.length, 1);
  assert.equal(p.textContent, 'docs and bad');
});

test('code blocks get a language label and a copy button', () => {
  const block = render('```js\nconst a = 1;\n```').children[0];
  assert.equal(block.className, 'md-code');
  const [head, pre] = block.children;
  assert.equal(head.children[0].textContent, 'js');
  const copy = head.children[1];
  assert.equal(copy.tagName, 'button');
  assert.equal(copy.getAttribute('type'), 'button');
  assert.equal(copy.getAttribute('aria-label'), 'Copy js code');
  assert.equal(copy.listeners.click.length, 1);
  assert.equal(pre.tagName, 'pre');
  assert.equal(pre.children[0].tagName, 'code');
  assert.equal(pre.textContent, 'const a = 1;');
});

test('copy writes exactly the code and says so', async () => {
  const written = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (text) => { written.push(text); } } } });
  try {
    const copy = render('```\nline 1\nline 2\n```').children[0].children[0].children[1];
    copy.listeners.click[0]();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(written, ['line 1\nline 2']);
    assert.equal(copy.textContent, 'Copied');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  }
});

test('headings, tables, tasks, quotes and rules map to the right elements', () => {
  const root = render('# Title\n\n| a | b |\n|---|--:|\n| 1 | 2 |\n\n- [x] done\n\n> quoted\n\n---\n\n3. three');
  assert.deepEqual(root.children.map((node) => node.tagName), ['h3', 'div', 'ul', 'blockquote', 'hr', 'ol']);
  assert.equal(root.children[0].className, 'md-h1');
  const table = root.children[1].find('table');
  assert.equal(root.children[1].className, 'md-table-wrap');
  assert.equal(table.find('th').getAttribute('scope'), 'col');
  assert.equal(table.find('tbody').children[0].children[1].className, 'md-right');
  const box = root.children[2].find('input');
  assert.deepEqual(box.attributes, { type: 'checkbox', disabled: '', checked: '' });
  assert.equal(root.children[2].children[0].className, 'md-task');
  assert.equal(root.children[5].getAttribute('start'), '3');
});

test('empty and very long texts', () => {
  assert.equal(render('   ').childNodes.length, 0);
  const long = render('x'.repeat(200001)).children[0];
  assert.equal(long.tagName, 'p');
  assert.equal(long.className, 'md-plain');
});
