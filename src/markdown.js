/**
 * Markdown for chat replies, rendered as DOM nodes.
 *
 * Replies from the model are untrusted text, so nothing here builds HTML: parseMarkdown turns the
 * text into plain objects (what the tests check) and renderMarkdown turns those into elements
 * with createElement / createTextNode only. Raw HTML in a reply stays literal text, and only
 * http:, https: and mailto: links become links (the main process opens them in the browser).
 *
 * Supported: paragraphs (a single newline is a line break, as in chat apps), ATX headings,
 * thematic breaks, fenced code blocks, bullet / ordered / task lists with nesting, blockquotes,
 * GitHub tables, code spans, strong / em / strikethrough, links, autolinks and bare URLs.
 * Tuned for model output: "_" only emphasises at word boundaries (snake_case and __init__.py stay
 * as written), "*" needs text right inside it (2 * 3 stays as written), a list may follow a
 * paragraph line directly, and nested items only need to be indented a little.
 */

// Longer replies are shown as plain text; so are paragraphs past the inline limit.
const MAX_CHARS = 200000;
const MAX_INLINE_CHARS = 20000;
// Containers (lists, quotes) and inline spans nested deeper than this are shown as plain text.
const MAX_BLOCK_DEPTH = 12;
const MAX_INLINE_DEPTH = 8;
const MAX_URL_CHARS = 2048;
const MAX_TITLE_CHARS = 300;
const PUNCTUATION = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const TASK = /^\[([ xX])\][ \t]+/;
const TABLE_DELIMITER = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const BARE_URL = /^https?:\/\/[^\s<>"'`]+/i;
const SAFE_HREF = /^(?:https?:\/\/[^\s]+|mailto:[^\s@]+@[^\s@]+)$/i;
// "_" closes emphasis only before these (or whitespace, the end, or a sentence-final ".").
const UNDERSCORE_CLOSE_AFTER = new Set([')', ']', '}', ',', ';', ':', '!', '?', '"', "'", '\u201d', '\u2019']);
const UNDERSCORE_OPEN_BEFORE = new Set(['(', '[', '{', '"', "'", '\u201c', '\u2018']);

const isBlank = (line) => !/\S/.test(line);
const isSpace = (char) => char === undefined || /\s/.test(char);

/** Width of a line's leading whitespace (a tab counts to the next multiple of 4). */
function columns(line) {
  let width = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === ' ') width += 1;
    else if (line[i] === '\t') width += 4 - (width % 4);
    else break;
  }
  return width;
}

/** Removes up to `count` columns of leading whitespace. */
function dedent(line, count) {
  let width = 0;
  let index = 0;
  while (index < line.length && width < count) {
    if (line[index] === ' ') width += 1;
    else if (line[index] === '\t') width += 4 - (width % 4);
    else break;
    index += 1;
  }
  return line.slice(index);
}

// ---- Blocks -----------------------------------------------------------------------------

function openFence(line) {
  const match = FENCE_OPEN.exec(line);
  if (!match) return null;
  const [, indent, marker, info] = match;
  if (marker[0] === '`' && info.includes('`')) return null;
  const lang = (info.trim().split(/\s+/)[0] || '').slice(0, 32);
  return { indent: columns(indent), char: marker[0], length: marker.length, lang: /^[\w+#.-]+$/.test(lang) ? lang : '' };
}

function closesFence(line, fence) {
  const match = FENCE_CLOSE.exec(line);
  return Boolean(match) && match[1][0] === fence.char && match[1].length >= fence.length;
}

const isRule = (line) => line.length <= 200 && RULE.test(line);

function listItem(line) {
  if (isRule(line)) return null;
  const match = LIST_ITEM.exec(line);
  if (!match) return null;
  const [, indentText, marker, spacing = '', content = ''] = match;
  const ordered = marker.length > 1 || /\d/.test(marker);
  const indent = columns(indentText);
  const gap = spacing.length > 4 ? 1 : Math.max(1, spacing.length);
  return {
    indent,
    ordered,
    delimiter: ordered ? marker.slice(-1) : '',
    start: ordered ? Number.parseInt(marker, 10) : null,
    contentIndent: indent + marker.length + gap,
    content,
    empty: !content.trim(),
  };
}

/** GitHub table cells of one row; `\|` is a literal pipe. */
function splitRow(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells = [];
  let cell = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\' && text[i + 1] === '|') { cell += '|'; i += 1; continue; }
    if (text[i] === '|') { cells.push(cell.trim()); cell = ''; continue; }
    cell += text[i];
  }
  cells.push(cell.trim());
  return cells;
}

function tableStart(lines, i) {
  if (i + 1 >= lines.length) return false;
  const head = lines[i];
  const delimiter = lines[i + 1];
  if (!head.includes('|') || !delimiter.includes('|') || delimiter.length > 4000 || !TABLE_DELIMITER.test(delimiter)) return false;
  return splitRow(head).length === splitRow(delimiter).length;
}

const startsBlock = (line) => Boolean(openFence(line)) || HEADING.test(line) || isRule(line) || QUOTE.test(line);

// A line that ends the paragraph before it: another block, a bullet item, an ordered item
// starting at 1, or a table.
function interrupts(lines, i) {
  const line = lines[i];
  if (startsBlock(line)) return true;
  const item = listItem(line);
  if (item && !item.empty && (!item.ordered || item.start === 1)) return true;
  return tableStart(lines, i);
}

function paragraph(parts) {
  // A backslash at the end of a line is a Markdown hard break; every newline is one here anyway.
  const text = parts.map((part) => part.replace(/(^|[^\\])((?:\\\\)*)\\$/, '$1$2')).join('\n');
  return { type: 'paragraph', children: parseInline(text) };
}

function parseParagraph(lines, start, plain) {
  const parts = [lines[start].trim()];
  let i = start + 1;
  while (i < lines.length && !isBlank(lines[i]) && (plain || !interrupts(lines, i))) {
    parts.push(lines[i].trim());
    i += 1;
  }
  return { block: paragraph(parts), next: i };
}

function parseFence(lines, start, fence) {
  const body = [];
  let i = start + 1;
  while (i < lines.length && !closesFence(lines[i], fence)) {
    body.push(dedent(lines[i], fence.indent));
    i += 1;
  }
  return { block: { type: 'code', lang: fence.lang, text: body.join('\n') }, next: i < lines.length ? i + 1 : i };
}

function parseQuote(lines, start, depth) {
  const inner = [];
  let i = start;
  let lazy = false;
  while (i < lines.length) {
    const match = QUOTE.exec(lines[i]);
    if (match) {
      inner.push(match[1]);
      lazy = !isBlank(match[1]);
      i += 1;
      continue;
    }
    // A paragraph inside the quote may continue on a line without ">".
    if (lazy && !isBlank(lines[i]) && !interrupts(lines, i) && !listItem(lines[i])) {
      inner.push(lines[i]);
      i += 1;
      continue;
    }
    break;
  }
  return { block: { type: 'blockquote', blocks: parseBlocks(inner, depth + 1) }, next: i };
}

function parseList(lines, start, first, depth) {
  const items = [];
  let current = null;
  let loose = false;
  let blankPending = false;
  // An open code fence inside the current item takes every line until it closes.
  let fence = null;
  // Lines indented at least this much belong to the current item (children and continuations).
  let limit = 0;
  const startItem = (item) => {
    if (current && blankPending) loose = true;
    current = { lines: [item.content] };
    items.push(current);
    limit = Math.min(item.contentIndent, item.indent + 2);
    blankPending = false;
    const opened = openFence(item.content);
    fence = opened || null;
  };
  startItem(first);
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i];
    if (fence) {
      current.lines.push(dedent(line, limit));
      if (closesFence(line, fence)) fence = null;
      i += 1;
      continue;
    }
    if (isBlank(line)) {
      blankPending = true;
      current.lines.push('');
      i += 1;
      continue;
    }
    const indent = columns(line);
    const item = listItem(line);
    if (item && indent < limit) {
      // Another item of this list, or a different kind of list after it.
      if (item.ordered !== first.ordered || item.delimiter !== first.delimiter) break;
      startItem(item);
      i += 1;
      continue;
    }
    if (indent >= limit) {
      if (blankPending) loose = true;
      blankPending = false;
      const text = dedent(line, limit);
      fence = openFence(text) || null;
      current.lines.push(text);
      i += 1;
      continue;
    }
    // Not indented: a lazy continuation of the item's paragraph, or the end of the list.
    if (!blankPending && !interrupts(lines, i)) {
      current.lines.push(line.trim());
      i += 1;
      continue;
    }
    break;
  }
  const built = items.map((entry) => {
    let itemLines = entry.lines;
    let checked = null;
    const task = TASK.exec(itemLines[0]);
    if (task) {
      checked = task[1] !== ' ';
      itemLines = [itemLines[0].slice(task[0].length), ...itemLines.slice(1)];
    }
    return { checked, blocks: parseBlocks(itemLines, depth + 1) };
  });
  return {
    block: { type: 'list', ordered: first.ordered, start: first.ordered ? first.start : null, tight: !loose, items: built },
    next: i,
  };
}

function parseTable(lines, start) {
  const head = splitRow(lines[start]);
  const align = splitRow(lines[start + 1]).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return left ? 'left' : null;
  });
  const rows = [];
  let i = start + 2;
  while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|') && !startsBlock(lines[i])) {
    const cells = splitRow(lines[i]);
    rows.push(align.map((_, index) => parseInline(cells[index] ?? '')));
    i += 1;
  }
  return { block: { type: 'table', align, head: head.map((cell) => parseInline(cell)), rows }, next: i };
}

function parseBlocks(lines, depth) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i += 1; continue; }
    let result = null;
    if (depth >= MAX_BLOCK_DEPTH) {
      result = parseParagraph(lines, i, true);
    } else {
      const fence = openFence(line);
      const heading = fence ? null : HEADING.exec(line);
      const item = fence || heading ? null : listItem(line);
      if (fence) result = parseFence(lines, i, fence);
      else if (heading) {
        const text = (heading[2] || '').trim().replace(/(?:^|[ \t]+)#+$/, '').trim();
        result = { block: { type: 'heading', level: heading[1].length, children: parseInline(text) }, next: i + 1 };
      } else if (isRule(line)) result = { block: { type: 'hr' }, next: i + 1 };
      else if (QUOTE.test(line)) result = parseQuote(lines, i, depth);
      else if (item) result = parseList(lines, i, item, depth);
      else if (tableStart(lines, i)) result = parseTable(lines, i);
      else result = parseParagraph(lines, i, false);
    }
    blocks.push(result.block);
    i = result.next;
  }
  return blocks;
}

// ---- Inline -----------------------------------------------------------------------------

function plainNodes(text) {
  const nodes = [];
  text.split('\n').forEach((part, index) => {
    if (index) nodes.push({ type: 'br' });
    if (part) nodes.push({ type: 'text', text: part });
  });
  return nodes;
}

function escapedAt(text, i) {
  let backslashes = 0;
  while (i - backslashes - 1 >= 0 && text[i - backslashes - 1] === '\\') backslashes += 1;
  return backslashes % 2 === 1;
}

/**
 * Code spans: an opening backtick run and the next run of the same length (start -> end).
 * Backslashes are literal inside code (`C:\Users\` works); only an opening run can be escaped.
 */
function codeSpans(text) {
  const runs = [];
  for (let i = 0; i < text.length;) {
    if (text[i] !== '`') { i += 1; continue; }
    let length = 1;
    while (text[i + length] === '`') length += 1;
    runs.push([i, length, escapedAt(text, i)]);
    i += length;
  }
  const byLength = new Map();
  runs.forEach(([, length], index) => {
    if (!byLength.has(length)) byLength.set(length, []);
    byLength.get(length).push(index);
  });
  const cursor = new Map();
  const spans = new Map();
  let index = 0;
  while (index < runs.length) {
    const [start, length, escaped] = runs[index];
    if (escaped) { index += 1; continue; }
    const list = byLength.get(length);
    let position = cursor.get(length) ?? 0;
    while (position < list.length && list[position] <= index) position += 1;
    cursor.set(length, position);
    if (position < list.length) {
      const close = list[position];
      spans.set(start, runs[close][0] + length);
      cursor.set(length, position + 1);
      index = close + 1;
    } else {
      index += 1;
    }
  }
  return spans;
}

function codeText(text, start, end) {
  let length = 0;
  while (text[start + length] === '`') length += 1;
  let content = text.slice(start + length, end - length).replace(/\n/g, ' ');
  if (content.length > 1 && content.startsWith(' ') && content.endsWith(' ') && /\S/.test(content)) content = content.slice(1, -1);
  return content;
}

/** Matching "[" -> "]" positions, ignoring escaped brackets and brackets inside code spans. */
function matchBrackets(text, spans) {
  const pairs = new Map();
  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\\') { i += 1; continue; }
    if (char === '`' && spans.has(i)) { i = spans.get(i) - 1; continue; }
    if (char === '[') stack.push(i);
    else if (char === ']' && stack.length) pairs.set(stack.pop(), i);
  }
  return pairs;
}

function findWithin(text, char, from, limit) {
  const end = Math.min(text.length, from + limit);
  for (let i = from; i < end; i += 1) if (text[i] === char) return i;
  return -1;
}

const unescape = (value) => value.replace(/\\([!-/:-@[-`{-~])/g, '$1');

/** The "(url "title")" after a link label, starting after "(". */
function linkTarget(text, from) {
  let i = from;
  while (text[i] === ' ' || text[i] === '\t') i += 1;
  let href;
  if (text[i] === '<') {
    const end = findWithin(text, '>', i + 1, MAX_URL_CHARS);
    if (end < 0) return null;
    href = text.slice(i + 1, end);
    if (/[\n<]/.test(href)) return null;
    i = end + 1;
  } else {
    const start = i;
    let depth = 0;
    while (i < text.length && i - start <= MAX_URL_CHARS) {
      const char = text[i];
      if (char === '\\' && i + 1 < text.length && PUNCTUATION.has(text[i + 1])) { i += 2; continue; }
      if (char === '(') depth += 1;
      else if (char === ')') { if (depth === 0) break; depth -= 1; }
      else if (/\s/.test(char)) break;
      i += 1;
    }
    href = unescape(text.slice(start, i));
  }
  while (text[i] === ' ' || text[i] === '\t') i += 1;
  if (text[i] === '"' || text[i] === "'" || text[i] === '(') {
    const end = findWithin(text, text[i] === '(' ? ')' : text[i], i + 1, MAX_TITLE_CHARS);
    if (end < 0) return null;
    i = end + 1;
    while (text[i] === ' ' || text[i] === '\t') i += 1;
  }
  if (text[i] !== ')') return null;
  return { href: href.trim(), end: i + 1 };
}

const safeHref = (href) => typeof href === 'string' && href.length <= MAX_URL_CHARS && SAFE_HREF.test(href);

/** Links cannot contain links: nested ones keep only their text. */
function withoutLinks(nodes) {
  return nodes.flatMap((node) => {
    if (node.type === 'link') return withoutLinks(node.children);
    if (node.children) return [{ ...node, children: withoutLinks(node.children) }];
    return [node];
  });
}

function count(text, char) {
  let total = 0;
  for (const value of text) if (value === char) total += 1;
  return total;
}

/** A bare http(s) URL at the start of `text`, without trailing punctuation. */
function bareUrl(text) {
  const match = BARE_URL.exec(text.slice(0, MAX_URL_CHARS));
  if (!match) return '';
  let url = match[0];
  for (;;) {
    const before = url;
    url = url.replace(/[.,;:!?'"*_~]+$/, '');
    if (url.endsWith(')') && count(url, ')') > count(url, '(')) url = url.slice(0, -1);
    if (url.endsWith(']') && count(url, ']') > count(url, '[')) url = url.slice(0, -1);
    if (url === before) break;
  }
  return /^https?:\/\/[^/]/i.test(url) ? url : '';
}

/**
 * Inline content: code spans, escapes, links, emphasis and line breaks. Closing delimiters are
 * looked up once per kind and position range (noCloser), so text full of unmatched "*" or "["
 * still parses in linear time.
 */
function parseInline(text, depth = 0) {
  if (!text) return [];
  if (text.length > MAX_INLINE_CHARS || depth > MAX_INLINE_DEPTH) return plainNodes(text);
  const spans = codeSpans(text);
  const brackets = matchBrackets(text, spans);
  const noCloser = new Map();
  const nodes = [];
  let buffer = '';
  const flush = () => {
    if (buffer) nodes.push({ type: 'text', text: buffer });
    buffer = '';
  };
  const push = (node) => {
    flush();
    nodes.push(node);
  };

  function canOpen(i, char, run) {
    if (isSpace(text[i + run])) return false;
    if (char !== '_') return true;
    const before = text[i - 1];
    return before === undefined || /\s/.test(before) || UNDERSCORE_OPEN_BEFORE.has(before);
  }

  function canClose(j, char, run) {
    if (j === 0 || /\s/.test(text[j - 1])) return false;
    if (char !== '_') return true;
    const after = text[j + run];
    if (after === undefined || /\s/.test(after) || UNDERSCORE_CLOSE_AFTER.has(after)) return true;
    return after === '.' && isSpace(text[j + run + 1]);
  }

  function findCloser(from, char, run) {
    const key = `${char}${run}`;
    if (noCloser.has(key) && from >= noCloser.get(key)) return -1;
    let j = from;
    while (j < text.length) {
      const value = text[j];
      if (value === '\\') { j += 2; continue; }
      if (value === '`' && spans.has(j)) { j = spans.get(j); continue; }
      if (value === char) {
        let length = 1;
        while (text[j + length] === char) length += 1;
        if (length === run && canClose(j, char, run)) return j;
        j += length;
        continue;
      }
      j += 1;
    }
    noCloser.set(key, Math.min(noCloser.get(key) ?? Infinity, from));
    return -1;
  }

  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '\\' && i + 1 < text.length && PUNCTUATION.has(text[i + 1])) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }
    if (char === '\n') {
      push({ type: 'br' });
      i += 1;
      continue;
    }
    if (char === '`') {
      const end = spans.get(i);
      if (end !== undefined) {
        push({ type: 'code', text: codeText(text, i, end) });
        i = end;
        continue;
      }
      let run = 1;
      while (text[i + run] === '`') run += 1;
      buffer += text.slice(i, i + run);
      i += run;
      continue;
    }
    if (char === '<') {
      const end = findWithin(text, '>', i + 1, MAX_URL_CHARS);
      const inner = end > i ? text.slice(i + 1, end) : '';
      if (inner && /^(?:https?:\/\/|mailto:)[^\s<>]+$/i.test(inner) && safeHref(inner)) {
        push({ type: 'link', href: inner, children: [{ type: 'text', text: inner.replace(/^mailto:/i, '') }] });
        i = end + 1;
        continue;
      }
    }
    if (char === '[') {
      const close = brackets.get(i);
      if (close !== undefined && text[close + 1] === '(') {
        const target = linkTarget(text, close + 2);
        if (target) {
          const children = withoutLinks(parseInline(text.slice(i + 1, close), depth + 1));
          if (safeHref(target.href)) push({ type: 'link', href: target.href, children });
          else {
            // Not a web or mail link: its text only.
            flush();
            nodes.push(...children);
          }
          i = target.end;
          continue;
        }
      }
    }
    if ((char === 'h' || char === 'H') && (i === 0 || !/[A-Za-z0-9]/.test(text[i - 1]))) {
      const url = /^https?:\/\//i.test(text.slice(i, i + 8)) ? bareUrl(text.slice(i)) : '';
      if (url) {
        push({ type: 'link', href: url, children: [{ type: 'text', text: url }] });
        i += url.length;
        continue;
      }
    }
    if (char === '*' || char === '_') {
      let run = 1;
      while (text[i + run] === char) run += 1;
      if (run <= 3 && canOpen(i, char, run)) {
        const close = findCloser(i + run, char, run);
        if (close > i + run - 1) {
          const inner = parseInline(text.slice(i + run, close), depth + 1);
          const node = run === 1 ? { type: 'em', children: inner }
            : run === 2 ? { type: 'strong', children: inner }
              : { type: 'strong', children: [{ type: 'em', children: inner }] };
          push(node);
          i = close + run;
          continue;
        }
      }
      buffer += text.slice(i, i + run);
      i += run;
      continue;
    }
    if (char === '~' && text[i + 1] === '~' && text[i + 2] !== '~' && canOpen(i, char, 2)) {
      const close = findCloser(i + 2, '~', 2);
      if (close > i + 1) {
        push({ type: 'del', children: parseInline(text.slice(i + 2, close), depth + 1) });
        i = close + 2;
        continue;
      }
    }
    buffer += char;
    i += 1;
  }
  flush();
  return nodes;
}

/** Blocks of a Markdown text (see the file header for what is supported). */
export function parseMarkdown(text) {
  if (typeof text !== 'string' || !/\S/.test(text)) return [];
  if (text.length > MAX_CHARS) return [{ type: 'paragraph', children: plainNodes(text) }];
  return parseBlocks(text.replace(/\r\n?/g, '\n').split('\n'), 0);
}

// ---- DOM --------------------------------------------------------------------------------

function make(doc, tag, className) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** Copies `text` when the button is pressed; the label says "Copied" (or why not) briefly. */
export function bindCopy(button, text, label = 'Copy') {
  let timer = null;
  button.addEventListener('click', () => {
    const show = (value) => {
      button.textContent = value;
      clearTimeout(timer);
      timer = setTimeout(() => { button.textContent = label; }, 1500);
    };
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard?.writeText) {
      show('Copy failed');
      return;
    }
    clipboard.writeText(text).then(() => show('Copied'), () => show('Copy failed'));
  });
}

function appendInline(doc, parent, nodes) {
  for (const node of nodes) {
    if (node.type === 'text') parent.append(doc.createTextNode(node.text));
    else if (node.type === 'br') parent.append(make(doc, 'br'));
    else if (node.type === 'code') {
      const code = make(doc, 'code');
      code.textContent = node.text;
      parent.append(code);
    } else if (node.type === 'link') {
      const link = make(doc, 'a', 'md-link');
      link.setAttribute('href', node.href);
      // The main process opens new-window links in the browser; the app never navigates.
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      link.setAttribute('title', node.href);
      appendInline(doc, link, node.children);
      parent.append(link);
    } else if (node.type === 'strong' || node.type === 'em' || node.type === 'del') {
      const span = make(doc, node.type);
      appendInline(doc, span, node.children);
      parent.append(span);
    }
  }
}

function renderCode(doc, block) {
  const wrap = make(doc, 'div', 'md-code');
  const head = make(doc, 'div', 'md-code-head');
  const lang = make(doc, 'span', 'md-code-lang');
  lang.textContent = block.lang || 'code';
  const copy = make(doc, 'button', 'md-copy');
  copy.setAttribute('type', 'button');
  copy.setAttribute('aria-label', block.lang ? `Copy ${block.lang} code` : 'Copy code');
  copy.textContent = 'Copy';
  bindCopy(copy, block.text);
  head.append(lang, copy);
  const pre = make(doc, 'pre');
  const code = make(doc, 'code');
  code.textContent = block.text;
  pre.append(code);
  wrap.append(head, pre);
  return wrap;
}

function renderList(doc, block) {
  const list = make(doc, block.ordered ? 'ol' : 'ul', block.tight ? 'md-tight' : '');
  if (block.ordered && Number.isSafeInteger(block.start) && block.start !== 1) list.setAttribute('start', String(block.start));
  for (const item of block.items) {
    const li = make(doc, 'li', item.checked === null ? '' : 'md-task');
    let box = null;
    if (item.checked !== null) {
      box = make(doc, 'input', 'md-checkbox');
      box.setAttribute('type', 'checkbox');
      box.setAttribute('disabled', '');
      if (item.checked) box.setAttribute('checked', '');
    }
    let rest = item.blocks;
    const first = item.blocks[0];
    if (first && first.type === 'paragraph') {
      // Tight items hold their text directly, so nested lists sit right under it.
      const target = block.tight ? li : make(doc, 'p');
      if (target !== li) li.append(target);
      if (box) target.append(box);
      appendInline(doc, target, first.children);
      rest = item.blocks.slice(1);
    } else if (box) {
      li.append(box);
    }
    for (const child of rest) li.append(renderBlock(doc, child));
    list.append(li);
  }
  return list;
}

const alignClass = (align) => (align ? `md-${align}` : '');

function renderTable(doc, block) {
  const wrap = make(doc, 'div', 'md-table-wrap');
  const table = make(doc, 'table');
  const head = make(doc, 'thead');
  const headRow = make(doc, 'tr');
  block.head.forEach((cell, index) => {
    const th = make(doc, 'th', alignClass(block.align[index]));
    th.setAttribute('scope', 'col');
    appendInline(doc, th, cell);
    headRow.append(th);
  });
  head.append(headRow);
  table.append(head);
  if (block.rows.length) {
    const body = make(doc, 'tbody');
    for (const row of block.rows) {
      const tr = make(doc, 'tr');
      row.forEach((cell, index) => {
        const td = make(doc, 'td', alignClass(block.align[index]));
        appendInline(doc, td, cell);
        tr.append(td);
      });
      body.append(tr);
    }
    table.append(body);
  }
  wrap.append(table);
  return wrap;
}

function renderBlock(doc, block) {
  if (block.type === 'heading') {
    // Headings in a reply stay below the page's own headings (h3 and smaller).
    const node = make(doc, `h${Math.min(6, block.level + 2)}`, `md-h${block.level}`);
    appendInline(doc, node, block.children);
    return node;
  }
  if (block.type === 'code') return renderCode(doc, block);
  if (block.type === 'list') return renderList(doc, block);
  if (block.type === 'table') return renderTable(doc, block);
  if (block.type === 'hr') return make(doc, 'hr');
  if (block.type === 'blockquote') {
    const quote = make(doc, 'blockquote');
    for (const child of block.blocks) quote.append(renderBlock(doc, child));
    return quote;
  }
  const node = make(doc, 'p');
  appendInline(doc, node, block.children);
  return node;
}

/** The reply as a DocumentFragment of formatted elements (put it in an element with class "md"). */
export function renderMarkdown(text, doc = globalThis.document) {
  const fragment = doc.createDocumentFragment();
  if (typeof text !== 'string' || !/\S/.test(text)) return fragment;
  if (text.length > MAX_CHARS) {
    const plain = make(doc, 'p', 'md-plain');
    plain.textContent = text;
    fragment.append(plain);
    return fragment;
  }
  for (const block of parseMarkdown(text)) fragment.append(renderBlock(doc, block));
  return fragment;
}
