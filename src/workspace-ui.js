/**
 * ScaleMax IDE: Workspace tab behaviour.
 *
 * Tabbed editor (per-tab content, revision and dirty state), ARIA file tree
 * with filtering and Git decorations, resizable explorer and bottom panel,
 * panel tabs, keyboard shortcuts and a lightweight syntax-highlight overlay.
 *
 * app.workspace.openPath / revision / dirty always describe the active tab,
 * so attachFile(), runSkill() and saveFile() keep their meaning.
 * All DOM is built with createElement + textContent. Importing this module
 * never touches the DOM; the pure helpers are unit-tested in Node.
 */

const LAYOUT_KEY = 'scalemax-workspace-layout';
const MAX_TABS = 12;
const MAX_HIGHLIGHT_CHARS = 150_000;
const EXPLORER_MIN = 160;
const EXPLORER_MAX = 480;
const PANEL_MIN = 96;
const EDITOR_MIN = 140;
const KEY_STEP = 16;
const INDENT = '  ';

// ---------------------------------------------------------------------------
// Pure helpers (no DOM)
// ---------------------------------------------------------------------------

const LANGUAGES = {
  javascript: { label: 'JavaScript', exts: ['js', 'mjs', 'cjs', 'jsx'] },
  typescript: { label: 'TypeScript', exts: ['ts', 'tsx', 'mts', 'cts'] },
  json: { label: 'JSON', exts: ['json', 'jsonc', 'webmanifest'] },
  css: { label: 'CSS', exts: ['css', 'scss', 'less'] },
  html: { label: 'HTML', exts: ['html', 'htm', 'xml', 'svg', 'plist'] },
  markdown: { label: 'Markdown', exts: ['md', 'mdx', 'markdown'] },
  python: { label: 'Python', exts: ['py', 'pyw'] },
  shell: { label: 'Shell', exts: ['sh', 'zsh', 'bash', 'command'] },
  yaml: { label: 'YAML', exts: ['yml', 'yaml'] },
  toml: { label: 'TOML', exts: ['toml'] },
};
const EXT_TO_LANGUAGE = new Map();
for (const [id, language] of Object.entries(LANGUAGES)) {
  for (const ext of language.exts) EXT_TO_LANGUAGE.set(ext, id);
}
const FILENAME_LANGUAGES = new Map([
  ['.zshrc', 'shell'], ['.bashrc', 'shell'], ['.profile', 'shell'], ['dockerfile', 'shell'],
  ['makefile', 'shell'], ['.gitignore', 'shell'], ['.npmrc', 'shell'], ['.editorconfig', 'toml'],
]);

/** Lowercase extension of a file name ('' when none; dotfiles have none). */
export function extOf(name) {
  const base = String(name || '').split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Language id for a path, or 'plain'. */
export function languageFor(path) {
  const base = String(path || '').split('/').pop().toLowerCase();
  if (FILENAME_LANGUAGES.has(base)) return FILENAME_LANGUAGES.get(base);
  return EXT_TO_LANGUAGE.get(extOf(base)) || 'plain';
}

export function languageLabel(language) {
  return LANGUAGES[language]?.label || 'Plain text';
}

const JS_KEYWORDS = 'abstract|as|async|await|break|case|catch|class|const|continue|debugger|declare|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|namespace|new|null|of|private|protected|public|readonly|return|set|static|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|with|yield';
const PY_KEYWORDS = 'False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|match|case|self';
const SH_KEYWORDS = 'if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|return|local|export|readonly|declare|unset|set|shift|source|exit|echo|printf|cd|test';
const NUMBER = String.raw`\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?n?)\b`;
const DQ = String.raw`"(?:\\.|[^"\\\n])*"?`;
const SQ = String.raw`'(?:\\.|[^'\\\n])*'?`;

// Each grammar is an ordered list of [tokenType, pattern]; the patterns are
// joined into one alternation and scanned left to right with a global regex.
const GRAMMARS = {
  javascript: [
    ['comment', String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`],
    ['string', `${DQ}|${SQ}|` + String.raw`\x60(?:\\[\s\S]|[^\x60\\])*\x60?`],
    ['number', NUMBER],
    ['keyword', String.raw`\b(?:${JS_KEYWORDS})\b`],
  ],
  json: [
    ['attr', String.raw`"(?:\\.|[^"\\\n])*"(?=\s*:)`],
    ['string', DQ],
    ['number', String.raw`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b`],
    ['keyword', String.raw`\b(?:true|false|null)\b`],
    ['comment', String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`],
  ],
  css: [
    ['comment', String.raw`\/\*[\s\S]*?(?:\*\/|$)`],
    ['string', `${DQ}|${SQ}`],
    ['keyword', String.raw`@[\w-]+|!important\b`],
    ['attr', String.raw`--?[A-Za-z_][\w-]*(?=\s*:[^;{}]*[;}])|\b[A-Za-z][\w-]*(?=\s*:[^;{}]*[;}])`],
    ['number', String.raw`#[\da-fA-F]{3,8}\b|-?\b\d*\.?\d+(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|ex|pt)?\b`],
  ],
  html: [
    ['comment', String.raw`<!--[\s\S]*?(?:-->|$)`],
    ['tag', String.raw`<\/?[A-Za-z][\w:.-]*|\/?>|<!DOCTYPE[^>]*>`],
    ['attr', String.raw`\b[A-Za-z_:@][\w:.-]*(?=\s*=)`],
    ['string', String.raw`"[^"\n]*"|'[^'\n]*'`],
  ],
  markdown: [
    ['string', String.raw`\x60\x60\x60[\s\S]*?(?:\x60\x60\x60|$)|\x60[^\x60\n]+\x60`],
    ['heading', String.raw`^#{1,6}[ \t][^\n]*`],
    ['keyword', String.raw`\*\*[^*\n]+\*\*|__[^_\n]+__|^[ \t]*(?:[-*+]|\d+\.)(?=[ \t])`],
    ['tag', String.raw`!?\[[^\]\n]*\]\([^)\n]*\)`],
    ['comment', String.raw`^>[^\n]*`],
  ],
  python: [
    ['comment', String.raw`#[^\n]*`],
    ['string', String.raw`\b[rRbBuUfF]{0,2}(?:'''[\s\S]*?(?:'''|$)|"""[\s\S]*?(?:"""|$))|\b[rRbBuUfF]{0,2}(?:"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)`],
    ['attr', String.raw`@[\w.]+`],
    ['number', NUMBER],
    ['keyword', String.raw`\b(?:${PY_KEYWORDS})\b`],
  ],
  shell: [
    ['comment', String.raw`(?<![\w$\\])#[^\n]*`],
    ['string', String.raw`"(?:\\[\s\S]|[^"\\])*"?|'[^']*'?`],
    ['attr', String.raw`\$\{[^}\n]*\}?|\$[A-Za-z_]\w*|\$[0-9#?@*$!-]`],
    ['keyword', String.raw`\b(?:${SH_KEYWORDS})\b`],
    ['number', String.raw`\b\d+\b`],
  ],
  yaml: [
    ['comment', String.raw`(?<![^\s])#[^\n]*`],
    ['attr', String.raw`^[ \t]*(?:-[ \t]+)?[\w.\-"'/]+(?=[ \t]*:(?:\s|$))`],
    ['string', `${DQ}|${SQ}`],
    ['keyword', String.raw`\b(?:true|false|null|yes|no|on|off)\b|[&*][\w-]+|^---$`],
    ['number', String.raw`-?\b\d+(?:\.\d+)?\b`],
  ],
  toml: [
    ['comment', String.raw`#[^\n]*`],
    ['tag', String.raw`^\s*\[\[?[^\]\n]*\]\]?`],
    ['attr', String.raw`^[ \t]*[\w.\-"']+(?=[ \t]*=)`],
    ['string', String.raw`"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|` + `${DQ}|${SQ}`],
    ['keyword', String.raw`\b(?:true|false)\b`],
    ['number', String.raw`-?\b\d[\d_]*(?:\.\d+)?\b`],
  ],
};
GRAMMARS.typescript = GRAMMARS.javascript;

const COMPILED = new Map();

function compiled(language) {
  if (!COMPILED.has(language)) {
    const grammar = GRAMMARS[language];
    COMPILED.set(language, grammar ? {
      types: grammar.map(([type]) => type),
      regex: new RegExp(grammar.map(([, pattern]) => `(${pattern})`).join('|'), 'gm'),
    } : null);
  }
  return COMPILED.get(language);
}

/**
 * Splits text into [type, text] segments; type is null for plain text.
 * Concatenating every segment's text always reproduces the input exactly.
 */
export function tokenize(text, language) {
  const source = String(text ?? '');
  const grammar = compiled(language);
  if (!grammar || !source) return source ? [[null, source]] : [];
  const segments = [];
  const { regex, types } = grammar;
  regex.lastIndex = 0;
  let last = 0;
  let match;
  while ((match = regex.exec(source)) !== null) {
    if (match[0] === '') { regex.lastIndex += 1; continue; }
    if (match.index > last) segments.push([null, source.slice(last, match.index)]);
    let group = 1;
    while (group < match.length && match[group] === undefined) group += 1;
    segments.push([types[group - 1] || null, match[0]]);
    last = match.index + match[0].length;
  }
  if (last < source.length) segments.push([null, source.slice(last)]);
  return segments;
}

/** 1-based line and column of an offset, plus the number of lines. */
export function cursorPosition(text, offset) {
  const value = String(text ?? '');
  const at = Math.max(0, Math.min(Number(offset) || 0, value.length));
  let line = 1;
  let lineStart = 0;
  for (let index = value.indexOf('\n'); index !== -1 && index < at; index = value.indexOf('\n', index + 1)) {
    line += 1;
    lineStart = index + 1;
  }
  return { line, column: at - lineStart + 1 };
}

/**
 * Indents (or outdents) every line touched by [start, end) by two spaces.
 * Returns the replacement for the covered line block and the new selection.
 */
export function indentLines(text, start, end, outdent = false) {
  const value = String(text ?? '');
  const blockStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const endAt = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const nextBreak = value.indexOf('\n', endAt);
  const blockEnd = nextBreak === -1 ? value.length : nextBreak;
  const lines = value.slice(blockStart, blockEnd).split('\n');
  let firstDelta = 0;
  let totalDelta = 0;
  const changed = lines.map((line, index) => {
    let next = line;
    if (outdent) {
      const remove = line.startsWith(INDENT) ? INDENT.length : (line.startsWith(' ') || line.startsWith('\t') ? 1 : 0);
      next = line.slice(remove);
    } else {
      next = INDENT + line;
    }
    const delta = next.length - line.length;
    if (index === 0) firstDelta = delta;
    totalDelta += delta;
    return next;
  });
  const replacement = changed.join('\n');
  return {
    blockStart,
    blockEnd,
    replacement,
    selectionStart: Math.max(blockStart, start + firstDelta),
    selectionEnd: Math.max(blockStart, end + totalDelta),
  };
}

/**
 * Rows for the tree: [{ entry, depth, kind: 'entry'|'empty' }]. With a
 * query, only loaded entries whose names match (and their ancestors) show.
 */
export function visibleTreeRows(files, { expanded = new Set(), tree = {}, query = '' } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  const rows = [];
  const walk = (entries, depth) => {
    let any = false;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const directory = entry.type === 'directory';
      const children = tree[entry.path];
      const selfMatch = !needle || String(entry.name).toLowerCase().includes(needle);
      if (!needle) {
        rows.push({ entry, depth, kind: 'entry' });
        any = true;
        if (directory && expanded.has(entry.path)) {
          if (Array.isArray(children) && children.length) walk(children, depth + 1);
          else rows.push({ entry: null, depth: depth + 1, kind: 'empty', parent: entry.path, loading: !Array.isArray(children) });
        }
        continue;
      }
      // Filtering: descend into every loaded folder, keep ancestors of matches.
      const mark = rows.length;
      rows.push({ entry, depth, kind: 'entry' });
      const childMatch = directory && Array.isArray(children) ? walk(children, depth + 1) : false;
      if (selfMatch || childMatch) any = true;
      else rows.length = mark;
    }
    return any;
  };
  walk(files, 0);
  return rows;
}

// ---------------------------------------------------------------------------
// DOM layer
// ---------------------------------------------------------------------------

const $ = (selector) => document.querySelector(selector);
const state = {
  tabs: [],
  active: null,
  focusedPath: null,
  query: '',
  git: new Map(),
  branch: null,
  panel: 'terminal',
  gutterLines: 0,
  highlightFrame: 0,
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tag === 'button') node.type = 'button';
  return node;
}

function setText(selector, text) {
  const node = $(selector);
  if (node) node.textContent = text;
}

function readLayout() {
  try {
    const value = JSON.parse(window.localStorage.getItem(LAYOUT_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function writeLayout(patch) {
  try {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...readLayout(), ...patch }));
  } catch { /* storage unavailable: the layout just resets next time */ }
}

function activeTab() {
  return state.tabs.find((tab) => tab.path === state.active) || null;
}

/** Content of the active tab including unsaved edits, or null. */
export function activeTabContent() {
  const tab = activeTab();
  if (!tab) return null;
  const input = $('#editor-input');
  return input ? input.value : tab.content;
}

/** Toolbar breadcrumb: folder name first, parent path dimmed (ellipsized at the start). */
export function renderCrumb(root) {
  const node = $('#workspace-path');
  if (!node) return;
  node.title = root || '';
  if (!root) {
    node.textContent = 'No folder selected';
    return;
  }
  const parts = root.split('/').filter(Boolean);
  const name = parts.pop() || root;
  const parent = element('span', 'ws-crumb-parent');
  // The isolate keeps the path left-to-right inside the right-to-left overflow box.
  parent.append(element('bdi', '', parts.length ? `/${parts.join('/')}` : '/'));
  node.replaceChildren(element('span', 'ws-crumb-name', name), parent);
}

// ---- Filter crawl ------------------------------------------------------------
// The tree loads one folder level at a time. When the user filters, a bounded
// breadth-first crawl loads more folders so matches deeper in the project show.

const CRAWL_SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage', '.cache', 'target',
  'vendor', '__pycache__', '.venv', 'venv', '.turbo', '.parcel-cache',
]);
const CRAWL_MAX_FOLDERS = 200;
const CRAWL_MAX_ENTRIES = 5000;
let crawlTimer = 0;
let crawl = null;

function scheduleCrawl(app) {
  window.clearTimeout(crawlTimer);
  crawlTimer = window.setTimeout(() => void crawlForFilter(app), 180);
}

async function crawlForFilter(app) {
  const bridge = window.scalemaxAPI?.workspace;
  const root = app.workspace.root;
  if (!bridge?.list || !root || !state.query.trim()) return;
  if (crawl && crawl.root === root && (crawl.running || crawl.done)) return;
  crawl = { root, running: true, done: false, folders: 0, entries: 0, truncated: false };
  const current = crawl;
  const queue = [...(app.workspace.files || [])];
  try {
    while (queue.length) {
      if (app.workspace.root !== root || crawl !== current) return;
      const entry = queue.shift();
      if (entry.type !== 'directory' || CRAWL_SKIP.has(entry.name)) continue;
      let children = app.workspace.tree?.[entry.path];
      if (!Array.isArray(children)) {
        if (current.folders >= CRAWL_MAX_FOLDERS || current.entries >= CRAWL_MAX_ENTRIES) {
          current.truncated = true;
          break;
        }
        const result = await bridge.list(entry.path);
        if (app.workspace.root !== root || crawl !== current) return;
        children = result?.ok && Array.isArray(result.data?.files) ? result.data.files : [];
        if (!app.workspace.tree) app.workspace.tree = {};
        app.workspace.tree[entry.path] = children;
        current.folders += 1;
        current.entries += children.length;
        if (current.folders % 10 === 0 && state.query.trim()) renderTree(app);
      }
      queue.push(...children);
    }
    current.done = true;
  } finally {
    current.running = false;
    if (crawl === current && state.query.trim()) renderTree(app);
  }
}

/** Forgets crawl progress (a refresh or another folder). */
export function resetCrawl() {
  crawl = null;
}

function syncApp(app) {
  const tab = activeTab();
  app.workspace.openPath = tab ? tab.path : '';
  app.workspace.revision = tab ? tab.revision : '';
  app.workspace.dirty = Boolean(tab?.dirty);
  app.workspace.tabs = state.tabs.map((item) => ({ path: item.path, dirty: item.dirty }));
}

function gitClass(status) {
  if (!status) return '';
  if (status === '??') return 'is-untracked';
  const letter = status.trim().charAt(0);
  if (letter === 'M') return 'is-modified';
  if (letter === 'A') return 'is-added';
  if (letter === 'D') return 'is-deleted';
  return '';
}

function gitLetter(status) {
  if (!status) return '';
  if (status === '??') return 'U';
  return status.trim().charAt(0);
}

function fileIcon(name, directory) {
  const icon = element('span', directory ? 'tree-icon is-folder' : 'tree-icon is-file');
  icon.setAttribute('aria-hidden', 'true');
  if (!directory) {
    const ext = extOf(name);
    if (ext) icon.dataset.ext = ext;
  }
  return icon;
}

// Name with the filter match wrapped in <mark>, built from text nodes.
function nameNode(name) {
  const label = element('span', 'file-name');
  const needle = state.query.trim().toLowerCase();
  const index = needle ? name.toLowerCase().indexOf(needle) : -1;
  if (index === -1) {
    label.textContent = name;
    return label;
  }
  label.append(
    document.createTextNode(name.slice(0, index)),
    element('mark', '', name.slice(index, index + needle.length)),
    document.createTextNode(name.slice(index + needle.length)),
  );
  return label;
}

export function renderTree(app) {
  const tree = $('#file-tree');
  if (!tree) return;
  const files = app.workspace.files || [];
  if (!app.workspace.root) {
    tree.replaceChildren(element('p', 'tree-message', 'No folder open.'));
    return;
  }
  if (!files.length) {
    tree.replaceChildren(element('p', 'tree-message', 'This folder is empty.'));
    return;
  }
  const rows = visibleTreeRows(files, {
    expanded: app.workspace.expanded || new Set(),
    tree: app.workspace.tree || {},
    query: state.query,
  });
  const searching = Boolean(state.query.trim()) && crawl?.root === app.workspace.root && crawl.running;
  if (!rows.length) {
    tree.replaceChildren(element('p', 'tree-message', searching ? 'Searching folders…' : 'No matching files.'));
    return;
  }
  const paths = rows.filter((row) => row.kind === 'entry').map((row) => row.entry.path);
  if (!paths.includes(state.focusedPath)) state.focusedPath = paths.includes(state.active) ? state.active : paths[0];
  tree.replaceChildren(...rows.map((row) => {
    if (row.kind === 'empty') {
      const message = element('p', 'tree-message', row.loading ? 'Loading…' : 'Empty folder');
      message.style.setProperty('--depth', String(row.depth));
      return message;
    }
    const { entry, depth } = row;
    const directory = entry.type === 'directory';
    const item = element('div', 'tree-row');
    item.setAttribute('role', 'treeitem');
    item.setAttribute('aria-level', String(depth + 1));
    item.dataset.filePath = entry.path;
    item.dataset.fileKind = directory ? 'directory' : 'file';
    item.style.setProperty('--depth', String(depth));
    item.tabIndex = entry.path === state.focusedPath ? 0 : -1;
    // While filtering, every loaded folder is shown open.
    const expandedNow = directory && (state.query.trim()
      ? Array.isArray(app.workspace.tree?.[entry.path])
      : Boolean(app.workspace.expanded?.has(entry.path)));
    if (directory) item.setAttribute('aria-expanded', String(Boolean(expandedNow)));
    const selected = !directory && entry.path === state.active;
    item.setAttribute('aria-selected', String(selected));
    if (selected) item.classList.add('active');
    const chevron = element('span', directory ? 'tree-chevron' : 'tree-chevron is-leaf');
    chevron.setAttribute('aria-hidden', 'true');
    item.append(chevron, fileIcon(entry.name, directory), nameNode(entry.name));
    const status = state.git.get(entry.path);
    if (status) {
      const badge = element('span', `tree-git ${gitClass(status)}`, gitLetter(status));
      badge.title = status === '??' ? 'Untracked' : `Git status ${status.trim()}`;
      item.append(badge);
    }
    item.title = entry.path;
    return item;
  }));
  if (state.query.trim() && crawl?.root === app.workspace.root && (searching || crawl.truncated)) {
    tree.append(element('p', 'tree-message', searching
      ? 'Searching more folders…'
      : `Showing matches from the first ${CRAWL_MAX_FOLDERS} folders.`));
  }
}

// ---- Editor chrome -------------------------------------------------------

export function updateGutter() {
  const input = $('#editor-input');
  const gutter = $('#editor-gutter');
  if (!input || !gutter) return;
  let lines = 1;
  for (let index = input.value.indexOf('\n'); index !== -1; index = input.value.indexOf('\n', index + 1)) lines += 1;
  if (lines !== state.gutterLines) {
    state.gutterLines = lines;
    const numbers = new Array(lines);
    for (let line = 0; line < lines; line += 1) numbers[line] = line + 1;
    gutter.textContent = numbers.join('\n');
  }
  gutter.scrollTop = input.scrollTop;
}

function renderHighlight() {
  state.highlightFrame = 0;
  const input = $('#editor-input');
  const overlay = $('#editor-highlight');
  const code = input?.parentElement;
  if (!input || !overlay || !code) return;
  const tab = activeTab();
  const language = tab ? languageFor(tab.path) : 'plain';
  const enabled = Boolean(tab) && language !== 'plain' && compiled(language) && input.value.length <= MAX_HIGHLIGHT_CHARS;
  code.classList.toggle('is-highlighted', Boolean(enabled));
  if (!enabled) { overlay.replaceChildren(); return; }
  const fragment = document.createDocumentFragment();
  for (const [type, text] of tokenize(input.value, language)) {
    if (type) fragment.append(element('span', `tok-${type}`, text));
    else fragment.append(document.createTextNode(text));
  }
  // A trailing newline needs a character after it to keep the last line's height.
  fragment.append(document.createTextNode('\n '));
  overlay.replaceChildren(fragment);
  overlay.scrollTop = input.scrollTop;
  overlay.scrollLeft = input.scrollLeft;
}

function scheduleHighlight() {
  if (state.highlightFrame) return;
  state.highlightFrame = window.requestAnimationFrame(renderHighlight);
}

function syncScroll() {
  const input = $('#editor-input');
  if (!input) return;
  const gutter = $('#editor-gutter');
  const overlay = $('#editor-highlight');
  if (gutter) gutter.scrollTop = input.scrollTop;
  if (overlay) {
    overlay.scrollTop = input.scrollTop;
    overlay.scrollLeft = input.scrollLeft;
  }
}

function updateLocation() {
  const input = $('#editor-input');
  const node = $('#editor-location');
  if (!input || !node) return;
  if (!activeTab()) { node.textContent = 'Ln 1, Col 1'; return; }
  const { line, column } = cursorPosition(input.value, input.selectionStart);
  const selected = Math.abs(input.selectionEnd - input.selectionStart);
  node.textContent = `Ln ${line}, Col ${column}${selected ? ` (${selected} selected)` : ''}`;
}

function renderEmptyState(app) {
  const empty = $('#workspace-empty');
  if (!empty) return;
  const hasRoot = Boolean(app.workspace.root);
  empty.hidden = Boolean(activeTab());
  setText('#workspace-empty-title', hasRoot ? 'Select a file' : 'Open a project folder');
  setText('#workspace-empty-text', hasRoot
    ? 'Choose a file in the explorer. Files open in tabs and keep unsaved edits while you switch.'
    : 'Browse files, edit with tabs, review Git changes and run commands, all on this Mac.');
  const open = $('#workspace-open-empty');
  if (open) open.hidden = hasRoot;
}

function renderTabs(app) {
  const host = $('#editor-tabs');
  if (!host) return;
  host.replaceChildren(...state.tabs.map((tab) => {
    const active = tab.path === state.active;
    const button = element('div', `ws-tab${tab.dirty ? ' is-dirty' : ''}`);
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    button.dataset.tabPath = tab.path;
    button.title = tab.path;
    const label = element('span', 'ws-tab-name', tab.name);
    const close = element('button', 'ws-tab-close');
    close.dataset.tabClose = tab.path;
    close.setAttribute('aria-label', `Close ${tab.name}${tab.dirty ? ' (unsaved changes)' : ''}`);
    close.tabIndex = -1;
    close.append(element('span', 'ws-tab-x', '×'));
    button.append(fileIcon(tab.name, false), label, close);
    button.setAttribute('aria-label', `${tab.name}${tab.dirty ? ', unsaved changes' : ''}`);
    return button;
  }));
  host.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  syncApp(app);
}

function renderEditorChrome(app) {
  const tab = activeTab();
  setText('#editor-title', tab ? tab.name : 'Editor');
  setText('#editor-path', tab ? tab.path : (app.workspace.root ? 'No file open' : 'No file selected'));
  setText('#editor-language', tab ? languageLabel(languageFor(tab.path)) : 'Plain text');
  const save = $('#editor-save');
  if (save) save.disabled = !tab;
  const input = $('#editor-input');
  if (input) input.readOnly = !tab;
  renderEmptyState(app);
  updateLocation();
}

function captureActive() {
  const tab = activeTab();
  const input = $('#editor-input');
  if (!tab || !input) return;
  tab.content = input.value;
  tab.scrollTop = input.scrollTop;
  tab.scrollLeft = input.scrollLeft;
  tab.selectionStart = input.selectionStart;
  tab.selectionEnd = input.selectionEnd;
}

function loadActive(app) {
  const tab = activeTab();
  const input = $('#editor-input');
  if (input) {
    input.value = tab ? tab.content : '';
    if (tab) {
      input.setSelectionRange(tab.selectionStart || 0, tab.selectionEnd || 0);
      input.scrollTop = tab.scrollTop || 0;
      input.scrollLeft = tab.scrollLeft || 0;
    }
  }
  state.gutterLines = 0;
  updateGutter();
  renderHighlight();
  syncScroll();
  renderTabs(app);
  renderEditorChrome(app);
  renderTree(app);
}

function activate(app, path) {
  if (path === state.active) return;
  captureActive();
  state.active = path;
  const tab = activeTab();
  if (tab) tab.usedAt = Date.now();
  loadActive(app);
  setText('#editor-status', tab ? (tab.dirty ? 'Unsaved changes.' : 'Ready.') : 'Choose a file before editing or saving.');
}

/** Opens a file in a tab (or focuses its tab). */
export async function openFileInTab(app, path) {
  const bridge = window.scalemaxAPI?.workspace;
  if (!bridge || !path) return false;
  if (state.tabs.some((tab) => tab.path === path)) {
    activate(app, path);
    $('#editor-input')?.focus();
    return true;
  }
  if (state.tabs.length >= MAX_TABS) {
    // Make room by closing the least recently used clean tab.
    const candidates = state.tabs.filter((tab) => !tab.dirty && tab.path !== state.active)
      .sort((left, right) => (left.usedAt || 0) - (right.usedAt || 0));
    if (!candidates.length) { app.showToast(`Save or close a tab first (at most ${MAX_TABS} open files)`); return false; }
    state.tabs = state.tabs.filter((tab) => tab !== candidates[0]);
  }
  const root = app.workspace.root;
  const result = await bridge.read(path);
  if (!result?.ok) { app.showToast(result?.error?.message || 'Could not open that file'); return false; }
  // The folder may have changed while the file was loading.
  if (app.workspace.root !== root) return false;
  if (!state.tabs.some((tab) => tab.path === result.data.path)) {
    state.tabs.push({
      path: result.data.path,
      name: result.data.path.split('/').pop(),
      content: result.data.content,
      revision: result.data.revision,
      dirty: false,
      usedAt: Date.now(),
    });
  }
  activate(app, result.data.path);
  setText('#editor-status', 'Loaded.');
  return true;
}

export function closeTab(app, path) {
  const index = state.tabs.findIndex((tab) => tab.path === path);
  if (index === -1) return;
  const tab = state.tabs[index];
  if (tab.path === state.active) captureActive();
  if (tab.dirty && !window.confirm(`Discard unsaved changes to ${tab.path}?`)) return;
  state.tabs.splice(index, 1);
  if (state.active === path) {
    state.active = null;
    const next = state.tabs[index] || state.tabs[index - 1] || null;
    if (next) {
      state.active = next.path;
      next.usedAt = Date.now();
    }
    loadActive(app);
    setText('#editor-status', state.active ? 'Ready.' : 'Choose a file before editing or saving.');
  } else {
    renderTabs(app);
  }
}

/** Saves the active tab with optimistic concurrency (the stored revision). */
export async function saveActiveTab(app) {
  const bridge = window.scalemaxAPI?.workspace;
  const tab = activeTab();
  if (!bridge || !tab) { app.showToast('Open a file first'); return false; }
  captureActive();
  const content = tab.content;
  const result = await bridge.write({ path: tab.path, content, revision: tab.revision });
  if (!result?.ok) {
    app.showToast(result?.error?.message || 'Could not save that file');
    setText('#editor-status', result?.error?.message || 'Save failed.');
    return false;
  }
  tab.revision = result.data.revision;
  // Edits typed while the write was in flight keep the tab dirty.
  const input = $('#editor-input');
  tab.dirty = state.active === tab.path && input ? input.value !== content : false;
  renderTabs(app);
  setText('#editor-status', 'Saved.');
  app.showToast('File saved');
  if (typeof app.refreshGit === 'function') void app.refreshGit({ quiet: true });
  return true;
}

/** Closes every tab; used when another folder is opened. */
export function resetTabs(app) {
  state.tabs = [];
  state.active = null;
  state.focusedPath = null;
  resetCrawl();
  state.git = new Map();
  state.branch = null;
  setText('#editor-branch', 'No branch');
  setText('#editor-status', 'Choose a file before editing or saving.');
  const count = $('#ws-git-count');
  if (count) count.hidden = true;
  loadActive(app);
}

/** Records Git status for tree decorations, the branch label and the tab badge. */
export function setGitDecorations(app, files, branch, isRepo) {
  state.git = new Map();
  for (const file of Array.isArray(files) ? files : []) {
    const path = typeof file === 'string' ? file : file?.path;
    const status = typeof file === 'string' ? 'M' : (file?.status || '');
    if (path) state.git.set(path, status);
  }
  state.branch = isRepo ? (branch || 'HEAD') : null;
  setText('#editor-branch', state.branch || 'No branch');
  const count = $('#ws-git-count');
  if (count) {
    count.hidden = !state.git.size;
    count.textContent = String(state.git.size);
  }
  renderTree(app);
}

// ---- Panel tabs ------------------------------------------------------------

export function showPanel(name, { focus = false } = {}) {
  const tabs = [...document.querySelectorAll('.ws-panel-tab[data-panel]')];
  if (!tabs.some((tab) => tab.dataset.panel === name)) return;
  state.panel = name;
  for (const tab of tabs) {
    const selected = tab.dataset.panel === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  for (const view of document.querySelectorAll('.ws-panel-view[data-panel-view]')) {
    view.hidden = view.dataset.panelView !== name;
  }
  writeLayout({ panelTab: name });
}

function bindPanelTabs() {
  const list = $('.ws-panel-tablist');
  if (!list) return;
  list.addEventListener('click', (event) => {
    const tab = event.target.closest('.ws-panel-tab[data-panel]');
    if (tab) showPanel(tab.dataset.panel);
  });
  list.addEventListener('keydown', (event) => {
    const tabs = [...list.querySelectorAll('.ws-panel-tab[data-panel]')];
    const index = tabs.findIndex((tab) => tab.dataset.panel === state.panel);
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next === -1) return;
    event.preventDefault();
    showPanel(tabs[next].dataset.panel, { focus: true });
  });
}

// ---- Splitters ---------------------------------------------------------------

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function bindSplitters() {
  const root = $('.ws');
  const explorerSplitter = $('#ws-splitter-explorer');
  const panelSplitter = $('#ws-splitter-panel');
  if (!root) return;
  const explorer = () => $('.ws-explorer');
  const panel = () => $('#ws-panel');
  const explorerMax = () => Math.min(EXPLORER_MAX, ($('.ws-body')?.clientWidth || 1200) - 360);
  const panelMax = () => ($('.ws-center')?.clientHeight || 700) - EDITOR_MIN;

  const setExplorer = (width, persist = false) => {
    const next = Math.round(clamp(width, EXPLORER_MIN, explorerMax()));
    root.style.setProperty('--ws-explorer-width', `${next}px`);
    explorerSplitter?.setAttribute('aria-valuenow', String(next));
    if (persist) writeLayout({ explorer: next });
  };
  const setPanel = (height, persist = false) => {
    const next = Math.round(clamp(height, PANEL_MIN, panelMax()));
    root.style.setProperty('--ws-panel-height', `${next}px`);
    panelSplitter?.setAttribute('aria-valuenow', String(next));
    if (persist) writeLayout({ panel: next });
  };

  const layout = readLayout();
  explorerSplitter?.setAttribute('aria-valuemin', String(EXPLORER_MIN));
  explorerSplitter?.setAttribute('aria-valuemax', String(EXPLORER_MAX));
  panelSplitter?.setAttribute('aria-valuemin', String(PANEL_MIN));
  if (Number.isFinite(layout.explorer)) root.style.setProperty('--ws-explorer-width', `${Math.round(clamp(layout.explorer, EXPLORER_MIN, EXPLORER_MAX))}px`);
  if (Number.isFinite(layout.panel)) root.style.setProperty('--ws-panel-height', `${Math.round(Math.max(PANEL_MIN, layout.panel))}px`);
  explorerSplitter?.setAttribute('aria-valuenow', String(parseInt(getComputedStyle(root).getPropertyValue('--ws-explorer-width'), 10) || 260));
  panelSplitter?.setAttribute('aria-valuenow', String(parseInt(getComputedStyle(root).getPropertyValue('--ws-panel-height'), 10) || 220));

  const drag = (splitter, onMove, onDone) => {
    splitter?.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      splitter.setPointerCapture(event.pointerId);
      splitter.classList.add('is-dragging');
      root.classList.add('is-resizing');
      const start = { x: event.clientX, y: event.clientY };
      const move = (moveEvent) => onMove(moveEvent, start);
      const up = (upEvent) => {
        splitter.releasePointerCapture?.(upEvent.pointerId);
        splitter.classList.remove('is-dragging');
        root.classList.remove('is-resizing');
        splitter.removeEventListener('pointermove', move);
        splitter.removeEventListener('pointerup', up);
        splitter.removeEventListener('pointercancel', up);
        onDone();
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', up);
      splitter.addEventListener('pointercancel', up);
    });
  };

  let explorerStart = 0;
  explorerSplitter?.addEventListener('pointerdown', () => { explorerStart = explorer()?.getBoundingClientRect().width || 260; });
  drag(explorerSplitter, (event, start) => setExplorer(explorerStart + (event.clientX - start.x)),
    () => setExplorer(explorer()?.getBoundingClientRect().width || 260, true));
  let panelStart = 0;
  panelSplitter?.addEventListener('pointerdown', () => { panelStart = panel()?.getBoundingClientRect().height || 220; });
  drag(panelSplitter, (event, start) => setPanel(panelStart - (event.clientY - start.y)),
    () => setPanel(panel()?.getBoundingClientRect().height || 220, true));

  explorerSplitter?.addEventListener('keydown', (event) => {
    const width = explorer()?.getBoundingClientRect().width || 260;
    if (event.key === 'ArrowLeft') setExplorer(width - KEY_STEP, true);
    else if (event.key === 'ArrowRight') setExplorer(width + KEY_STEP, true);
    else if (event.key === 'Home') setExplorer(EXPLORER_MIN, true);
    else if (event.key === 'End') setExplorer(EXPLORER_MAX, true);
    else return;
    event.preventDefault();
  });
  panelSplitter?.addEventListener('keydown', (event) => {
    const height = panel()?.getBoundingClientRect().height || 220;
    if (event.key === 'ArrowUp') setPanel(height + KEY_STEP, true);
    else if (event.key === 'ArrowDown') setPanel(height - KEY_STEP, true);
    else if (event.key === 'Home') setPanel(PANEL_MIN, true);
    else if (event.key === 'End') setPanel(panelMax(), true);
    else return;
    event.preventDefault();
  });
  // Keep the panel inside the view when the window shrinks.
  window.addEventListener('resize', () => {
    const height = panel()?.getBoundingClientRect().height;
    if (height && height > panelMax()) setPanel(panelMax());
  });
}

// ---- Tree interaction ------------------------------------------------------

function treeRows() {
  return [...document.querySelectorAll('#file-tree .tree-row[data-file-path]')];
}

function focusRow(row) {
  if (!row) return;
  for (const item of treeRows()) item.tabIndex = item === row ? 0 : -1;
  state.focusedPath = row.dataset.filePath;
  row.focus();
}

async function activateRow(app, row) {
  if (!row) return;
  state.focusedPath = row.dataset.filePath;
  if (row.dataset.fileKind === 'directory') {
    if (state.query.trim()) return;
    await app.toggleFolder(row.dataset.filePath);
    focusRow(treeRows().find((item) => item.dataset.filePath === state.focusedPath));
  } else {
    await openFileInTab(app, row.dataset.filePath);
  }
}

function bindTree(app) {
  const tree = $('#file-tree');
  if (!tree) return;
  tree.addEventListener('click', (event) => {
    const row = event.target.closest('.tree-row[data-file-path]');
    if (row) void activateRow(app, row);
  });
  tree.addEventListener('keydown', async (event) => {
    const row = event.target.closest('.tree-row[data-file-path]');
    if (!row) return;
    const rows = treeRows();
    const index = rows.indexOf(row);
    const directory = row.dataset.fileKind === 'directory';
    const expanded = row.getAttribute('aria-expanded') === 'true';
    const level = Number(row.getAttribute('aria-level'));
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); focusRow(rows[index + 1]); break;
      case 'ArrowUp': event.preventDefault(); focusRow(rows[index - 1]); break;
      case 'Home': event.preventDefault(); focusRow(rows[0]); break;
      case 'End': event.preventDefault(); focusRow(rows[rows.length - 1]); break;
      case 'ArrowRight':
        event.preventDefault();
        if (directory && !expanded) await activateRow(app, row);
        else if (directory) focusRow(rows[index + 1]);
        break;
      case 'ArrowLeft': {
        event.preventDefault();
        if (directory && expanded) { await activateRow(app, row); break; }
        const parent = rows.slice(0, index).reverse().find((item) => Number(item.getAttribute('aria-level')) === level - 1);
        focusRow(parent);
        break;
      }
      case 'Enter':
      case ' ':
        event.preventDefault();
        await activateRow(app, row);
        break;
      default:
    }
  });
  const filter = $('#workspace-filter');
  filter?.addEventListener('input', () => {
    state.query = filter.value;
    renderTree(app);
    if (state.query.trim()) scheduleCrawl(app);
  });
  filter?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && filter.value) {
      event.preventDefault();
      filter.value = '';
      state.query = '';
      renderTree(app);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusRow(treeRows()[0]);
    }
  });
  $('#workspace-collapse')?.addEventListener('click', () => {
    app.workspace.expanded = new Set();
    renderTree(app);
  });
}

// ---- Editor interaction ----------------------------------------------------

function insertText(input, text) {
  // execCommand keeps the edit on the textarea's native undo stack.
  input.focus();
  const inserted = typeof document.execCommand === 'function' && document.execCommand('insertText', false, text);
  if (!inserted) {
    input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function handleTab(event) {
  const input = event.currentTarget;
  if (input.readOnly) return;
  event.preventDefault();
  const { selectionStart: start, selectionEnd: end, value } = input;
  const multiline = value.slice(start, end).includes('\n');
  if (!event.shiftKey && !multiline) {
    insertText(input, INDENT);
    return;
  }
  const change = indentLines(value, start, end, event.shiftKey);
  if (change.replacement === value.slice(change.blockStart, change.blockEnd)) return;
  input.setSelectionRange(change.blockStart, change.blockEnd);
  insertText(input, change.replacement);
  input.setSelectionRange(change.selectionStart, change.selectionEnd);
}

function bindEditor(app) {
  const input = $('#editor-input');
  if (!input) return;
  input.addEventListener('input', () => {
    const tab = activeTab();
    if (!tab) return;
    tab.content = input.value;
    if (!tab.dirty) {
      tab.dirty = true;
      renderTabs(app);
    }
    app.workspace.dirty = true;
    setText('#editor-status', 'Unsaved changes.');
    updateGutter();
    scheduleHighlight();
    updateLocation();
  });
  input.addEventListener('scroll', syncScroll, { passive: true });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Tab' && !event.altKey && !event.metaKey && !event.ctrlKey) handleTab(event);
  });
  for (const type of ['click', 'keyup', 'select', 'focus']) input.addEventListener(type, updateLocation);
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === input) updateLocation();
  });

  const tabs = $('#editor-tabs');
  tabs?.addEventListener('click', (event) => {
    const close = event.target.closest('[data-tab-close]');
    if (close) {
      event.stopPropagation();
      closeTab(app, close.dataset.tabClose);
      return;
    }
    const tab = event.target.closest('.ws-tab[data-tab-path]');
    if (tab) activate(app, tab.dataset.tabPath);
  });
  // Middle-click closes a tab, like most editors.
  tabs?.addEventListener('auxclick', (event) => {
    const tab = event.target.closest('.ws-tab[data-tab-path]');
    if (tab && event.button === 1) closeTab(app, tab.dataset.tabPath);
  });
  tabs?.addEventListener('keydown', (event) => {
    const items = [...tabs.querySelectorAll('.ws-tab[data-tab-path]')];
    const index = items.findIndex((item) => item.dataset.tabPath === state.active);
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      if (state.active) closeTab(app, state.active);
      return;
    }
    if (next === -1 || !items.length) return;
    event.preventDefault();
    activate(app, items[next].dataset.tabPath);
    tabs.querySelector('.ws-tab[aria-selected="true"]')?.focus();
  });

  // Cmd/Ctrl+S saves while the Workspace view is showing.
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 's') return;
    if (!$('#view-workspace')?.classList.contains('active')) return;
    event.preventDefault();
    void saveActiveTab(app);
  });
}

export function bindWorkspaceUi(app) {
  if (!$('#view-workspace')) return;
  bindPanelTabs();
  bindSplitters();
  bindTree(app);
  bindEditor(app);
  $('#workspace-open-empty')?.addEventListener('click', () => void app.openWorkspace());
  const layout = readLayout();
  showPanel(['terminal', 'git', 'diff'].includes(layout.panelTab) ? layout.panelTab : 'terminal');
  loadActive(app);
}
