/**
 * ScaleMax IDE: Workspace tab behaviour.
 *
 * Tabbed code editor (CodeMirror 6, set up in src/editor.js: each tab keeps its own editor
 * state, so switching tabs keeps its undo history, selection and scroll position), dirty state
 * from the text itself, revision-checked saves, the review of a reply's changes inside the
 * editor (Keep / Undo per change), ARIA file tree with filtering and Git decorations, resizable
 * explorer and bottom panel, panel tabs and keyboard shortcuts.
 *
 * app.workspace.openPath / revision / dirty always describe the active tab,
 * so attachFile(), runSkill() and saveFile() keep their meaning.
 * All DOM is built with createElement + textContent. Importing this module
 * never touches the DOM; src/editor.js, which needs a real page, is imported once the Workspace
 * is bound, and until it has loaded (or when it cannot) the plain #editor-input textarea is the
 * editor. The pure helpers are unit-tested in Node.
 */

const LAYOUT_KEY = 'scalemax-workspace-layout';
const MAX_TABS = 12;
const EXPLORER_MIN = 160;
const EXPLORER_MAX = 480;
const PANEL_MIN = 96;
const EDITOR_MIN = 140;
const KEY_STEP = 16;

// ---------------------------------------------------------------------------
// Pure helpers (no DOM)
// ---------------------------------------------------------------------------

// Language ids, each highlighted by its CodeMirror package (LANGUAGE_SUPPORT in src/editor.js).
const LANGUAGES = {
  javascript: { label: 'JavaScript', exts: ['js', 'mjs', 'cjs'] },
  jsx: { label: 'JavaScript JSX', exts: ['jsx'] },
  typescript: { label: 'TypeScript', exts: ['ts', 'mts', 'cts'] },
  tsx: { label: 'TypeScript JSX', exts: ['tsx'] },
  json: { label: 'JSON', exts: ['json', 'jsonc', 'json5', 'webmanifest'] },
  css: { label: 'CSS', exts: ['css'] },
  scss: { label: 'SCSS', exts: ['scss'] },
  less: { label: 'Less', exts: ['less'] },
  html: { label: 'HTML', exts: ['html', 'htm', 'xhtml'] },
  markdown: { label: 'Markdown', exts: ['md', 'mdx', 'markdown'] },
  python: { label: 'Python', exts: ['py', 'pyw', 'pyi'] },
  rust: { label: 'Rust', exts: ['rs'] },
  go: { label: 'Go', exts: ['go'] },
  java: { label: 'Java', exts: ['java'] },
  c: { label: 'C', exts: ['c', 'h'] },
  cpp: { label: 'C++', exts: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'] },
  php: { label: 'PHP', exts: ['php', 'phtml'] },
  sql: { label: 'SQL', exts: ['sql'] },
  xml: { label: 'XML', exts: ['xml', 'svg', 'plist', 'xsd', 'xsl', 'xslt'] },
  yaml: { label: 'YAML', exts: ['yml', 'yaml'] },
  shell: { label: 'Shell', exts: ['sh', 'zsh', 'bash', 'command'] },
  toml: { label: 'TOML', exts: ['toml'] },
};
const EXT_TO_LANGUAGE = new Map();
for (const [id, language] of Object.entries(LANGUAGES)) {
  for (const ext of language.exts) EXT_TO_LANGUAGE.set(ext, id);
}
const FILENAME_LANGUAGES = new Map([
  ['.zshrc', 'shell'], ['.bashrc', 'shell'], ['.profile', 'shell'], ['dockerfile', 'shell'],
  ['makefile', 'shell'], ['.gitignore', 'shell'], ['.npmrc', 'shell'], ['.editorconfig', 'toml'],
  ['.babelrc', 'json'], ['.eslintrc', 'json'], ['.prettierrc', 'json'], ['cargo.lock', 'toml'], ['pipfile', 'toml'],
]);
// Names a Markdown code fence may use besides the language ids and file extensions.
const FENCE_NAMES = new Map([
  ['node', 'javascript'], ['bash', 'shell'], ['console', 'shell'], ['shellsession', 'shell'],
  ['golang', 'go'], ['c++', 'cpp'], ['yml', 'yaml'], ['svg', 'xml'],
]);
// Languages whose code is usually indented by four spaces (or a tab: Go) when a file shows none.
const FOUR_SPACES = new Set(['python', 'rust', 'java', 'c', 'cpp', 'php']);

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

/** Every language id but 'plain'. */
export function languageIds() {
  return Object.keys(LANGUAGES);
}

/** Language id for the info string of a Markdown code fence ("```ts"), or null. */
export function fenceLanguage(info) {
  const name = String(info || '').trim().split(/[\s{,]/)[0].toLowerCase();
  if (!name) return null;
  if (Object.hasOwn(LANGUAGES, name)) return name;
  return FENCE_NAMES.get(name) || EXT_TO_LANGUAGE.get(name) || null;
}

/**
 * The line break a text uses: '\r\n' when every line ends with one, '\r' for a file of old Mac
 * line breaks only, else '\n'. The editor keeps it, so saving writes the file's own line breaks
 * (a stray '\r' in a '\n' file stays a character of its line).
 */
export function lineBreakOf(text) {
  const value = String(text ?? '');
  let lf = 0;
  let crlf = 0;
  for (let at = value.indexOf('\n'); at !== -1; at = value.indexOf('\n', at + 1)) {
    lf += 1;
    if (at > 0 && value.charCodeAt(at - 1) === 13) crlf += 1;
  }
  let cr = 0;
  for (let at = value.indexOf('\r'); at !== -1; at = value.indexOf('\r', at + 1)) cr += 1;
  if (lf && crlf === lf && cr === crlf) return '\r\n';
  if (!lf && cr) return '\r';
  return '\n';
}

/**
 * The indentation a file already uses, like VS Code guesses it: a tab when more lines start
 * with one, else the step (2, 4 or 8 spaces) most lines indent by. A file without indented
 * lines gets its language's usual one.
 */
export function indentFor(text, language = 'plain') {
  let tabs = 0;
  let spaces = 0;
  let previous = 0;
  const steps = new Map();
  for (const line of String(text ?? '').split('\n', 2000)) {
    if (!line.trim()) continue;
    if (line.startsWith('\t')) { tabs += 1; previous = 0; continue; }
    const width = /^ */.exec(line)[0].length;
    if (width) spaces += 1;
    const step = Math.abs(width - previous);
    // Steps of 1 and 3 are alignment (" * " in block comments), not indentation.
    if (step === 2 || step === 4 || step === 8) steps.set(step, (steps.get(step) || 0) + 1);
    previous = width;
  }
  if (tabs > spaces) return '\t';
  let best = 0;
  for (const step of [2, 4, 8]) if ((steps.get(step) || 0) > (steps.get(best) || 0)) best = step;
  if (best) return ' '.repeat(best);
  if (language === 'go') return '\t';
  return FOUR_SPACES.has(language) ? '    ' : '  ';
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

/** The statusbar's "Ln 3, Col 7 (12 selected)", with the number of cursors when there are several. */
export function locationText({ line = 1, column = 1, selected = 0, cursors = 1 } = {}) {
  let text = `Ln ${line}, Col ${column}`;
  if (selected) text += ` (${selected} selected)`;
  if (cursors > 1) text += ` · ${cursors} cursors`;
  return text;
}

/**
 * The text a file had before a reply changed it, rebuilt from the text it has now (`after`,
 * exactly as the reply left it) and the reply's diff of the file (checkpoints.diff: hunks with
 * three lines of context and old/new line numbers, see lib/line-diff.cjs). File contents never
 * cross the bridge, so this is how the editor gets the earlier version. Every context and added
 * line is checked against `after`; null when they do not match, or when the diff cannot tell:
 * cut short (`truncated`), not recorded, or a file the reply emptied (the diff does not say
 * whether its earlier last line ended with a line break).
 */
export function originalFromHunks(after, diff) {
  if (!diff || diff.truncated || diff.noDiff || diff.untracked || !Array.isArray(diff.hunks)) return null;
  const text = String(after ?? '');
  // Lines as lib/line-diff.cjs splits them: a final line break ends the last line.
  const lines = text ? text.split('\n') : [];
  const newline = !text || lines[lines.length - 1] === '';
  if (text && newline) lines.pop();
  const before = [];
  let beforeNewline = newline;
  let next = 0;
  // Unchanged lines of `after` up to (not including) line index `end`.
  const copyTo = (end) => {
    if (!Number.isSafeInteger(end) || end < next || end > lines.length) return false;
    while (next < end) before.push(lines[next++]);
    return true;
  };
  for (const hunk of diff.hunks) {
    for (const line of Array.isArray(hunk?.lines) ? hunk.lines : []) {
      if (line?.noNewline) {
        // The marker stands in the version that lacks the final line break.
        if (line.type === '-') beforeNewline = false;
        else if (line.type === '+') beforeNewline = true;
        continue;
      }
      if (line?.type === '-') {
        if (!copyTo(next + (line.oldLine - 1 - before.length))) return null;
        before.push(String(line.text));
      } else if (line?.type === '+' || line?.type === ' ') {
        if (!copyTo(line.newLine - 1) || lines[next] !== line.text) return null;
        if (line.type === ' ') {
          if (before.length !== line.oldLine - 1) return null;
          before.push(lines[next]);
        }
        next += 1;
      } else {
        return null;
      }
    }
  }
  copyTo(lines.length);
  if (!text && before.length) return null;
  return before.length ? before.join('\n') + (beforeNewline ? '\n' : '') : '';
}

/**
 * The files of a reply's changes (normalizeChanges in src/domain.mjs) that can be reviewed in
 * the editor: still as the reply left them in its record (not undone or kept), recorded, and
 * open in a tab without unsaved edits. `paths` narrows them down.
 */
export function reviewTargets(changes, tabs, paths = null) {
  const open = new Map((Array.isArray(tabs) ? tabs : []).map((tab) => [tab.path, tab]));
  return (Array.isArray(changes?.files) ? changes.files : [])
    .filter((file) => file.status === 'changed' && !file.untracked && (!paths || paths.includes(file.path))
      && open.has(file.path) && !open.get(file.path).dirty)
    .map((file) => file.path);
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

/**
 * The open folders after a refresh (src/app.js refreshWorkspace): each one stays open with its
 * listing read again (`listings`: path → entries, or null when it is gone or unreadable, which
 * closes it). A folder opened while the listings were read keeps the one it loaded then. Closed
 * folders lose their cached listing, so they load fresh when opened.
 * @returns {{ expanded: Set<string>, tree: Record<string, object[]> }}
 */
export function refreshedTree(expanded, listings, tree = {}) {
  const open = new Set();
  const next = {};
  for (const path of expanded instanceof Set ? expanded : []) {
    const fresh = listings instanceof Map && listings.has(path) ? listings.get(path) : undefined;
    if (Array.isArray(fresh)) next[path] = fresh;
    else if (fresh === undefined && Array.isArray(tree?.[path])) next[path] = tree[path];
    else continue;
    open.add(path);
  }
  return { expanded: open, tree: next };
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
  // The tab whose text the editor holds: the active one, once it is drawn.
  shown: null,
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
  return tab ? tabText(tab) : null;
}

/** Toolbar breadcrumb: folder name first, parent path dimmed (ellipsized at the start). */
export function renderCrumb(root, label = '') {
  const node = $('#workspace-path');
  if (!node) return;
  node.title = root || '';
  if (!root) {
    node.textContent = 'No folder selected';
    return;
  }
  const parts = root.split('/').filter(Boolean);
  const own = parts.pop() || root;
  // A task worktree shows its task's name ("app (fix-login)"), not its generated folder name.
  const name = label || own;
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

// ---- Editor ----------------------------------------------------------------
// The editor shows one tab at a time (state.shown). With CodeMirror a hidden tab keeps its
// editor state and scroll snapshot in tab.view; with the textarea, its text in tab.content.
// tab.content is also the text a tab's first editor state is made from. tab.saved is the text
// on disk as last read or written, and tab.dirty says whether the tab's text differs from it.

let codemirror = null;
let codemirrorLoading = null;

/** Loads CodeMirror (src/editor.js) into #editor-view once; resolves to null when it cannot. */
function loadCodeMirror(app) {
  if (codemirrorLoading) return codemirrorLoading;
  const host = $('#editor-view');
  // A page without a real DOM (the unit tests' stand-in) keeps the textarea.
  if (typeof HTMLElement !== 'function' || !(host instanceof HTMLElement)) {
    codemirrorLoading = Promise.resolve(null);
    return codemirrorLoading;
  }
  codemirrorLoading = import('./editor.js')
    .then((module) => useEditor(app, module, (onUpdate) => module.createEditor(host, { onUpdate })))
    .catch((error) => {
      console.error('[ScaleMax] The code editor did not load; the plain text editor is used instead.', error);
      return null;
    });
  return codemirrorLoading;
}

/**
 * Makes CodeMirror the editor: `module` is src/editor.js, `create(onUpdate)` makes the view
 * (module.createEditor; the unit tests pass a stand-in view over real editor states).
 */
export function useEditor(app, module, create) {
  // A tab already shown in the textarea carries its text over.
  captureShown();
  const editor = create((update) => onEditorUpdate(app, update));
  codemirror = { module, editor };
  codemirrorLoading = Promise.resolve(codemirror);
  const input = $('#editor-input');
  if (input) input.hidden = true;
  loadActive(app);
  return codemirror;
}

function shownTab() {
  return state.tabs.find((tab) => tab.path === state.shown) || null;
}

// The CodeMirror state of a tab: the editor's while it is shown, else the one it keeps.
function editorState(tab) {
  if (!codemirror) return null;
  return tab.path === state.shown ? codemirror.editor.view.state : tab.view?.state || null;
}

/** A tab's text including unsaved edits. */
function tabText(tab) {
  if (codemirror) {
    const current = editorState(tab);
    return current ? codemirror.module.textOf(current) : tab.content;
  }
  const input = $('#editor-input');
  return tab.path === state.shown && input ? input.value : tab.content;
}

function markSaved(tab, text) {
  tab.saved = text;
  // CodeMirror's copy of it, made when the tab is next compared (isDirty).
  tab.savedDoc = null;
}

function isDirty(tab) {
  const current = editorState(tab);
  if (!current) return tabText(tab) !== tab.saved;
  if (!tab.savedDoc) tab.savedDoc = codemirror.module.savedDoc(current, tab.saved);
  return !codemirror.module.unchanged(current, tab.savedDoc);
}

// Applies a transaction to a tab's editor state, on screen or kept (its scroll snapshot follows).
function updateTab(tab, spec) {
  if (!codemirror) return;
  if (tab.path === state.shown) {
    codemirror.editor.dispatch(spec);
  } else if (tab.view) {
    const transaction = tab.view.state.update(spec);
    tab.view = { state: transaction.state, scroll: tab.view.scroll?.map(transaction.changes) || null };
  }
}

// The file changed on disk: the tab shows `text`. In CodeMirror that is one undoable change, so
// the selection and scroll position stay; a file whose line breaks changed kind starts afresh.
// A review ends with it: what is on disk now is no longer what one reply left, so marking it
// against that reply's earlier text would mix in whatever changed it since (another reply, an
// undo, a command). A reply that changed it reviews it anew (reviewReplyChanges).
function loadText(tab, text) {
  tab.content = text;
  markSaved(tab, text);
  forgetEditorUndos(tab);
  const current = editorState(tab);
  if (current) {
    const spec = codemirror.module.reloadSpec(current, text);
    if (spec) {
      if (tab.review) {
        tab.review = null;
        Object.assign(spec, codemirror.module.reviewSpec(current, null));
      }
      updateTab(tab, spec);
      return;
    }
    tab.review = null;
    tab.view = { state: codemirror.module.createTabState(text, { path: tab.path }), scroll: null };
    if (tab.path === state.shown) codemirror.editor.show(tab.view.state);
    return;
  }
  const input = $('#editor-input');
  if (tab.path === state.shown && input) input.value = text;
}

// The tab on screen keeps its editor state (or the textarea's text, selection and scroll).
function captureShown() {
  const tab = shownTab();
  if (!tab) return;
  if (codemirror) {
    tab.view = codemirror.editor.snapshot();
    return;
  }
  const input = $('#editor-input');
  if (!input) return;
  tab.content = input.value;
  tab.scrollTop = input.scrollTop;
  tab.scrollLeft = input.scrollLeft;
  tab.selectionStart = input.selectionStart;
  tab.selectionEnd = input.selectionEnd;
}

// Puts the active tab on screen.
function showActive() {
  const tab = activeTab();
  state.shown = tab ? tab.path : null;
  if (codemirror) {
    const { module, editor } = codemirror;
    if (tab && !tab.view) {
      tab.view = { state: module.createTabState(tab.content, { path: tab.path, review: tab.review?.original ?? null }), scroll: null };
    }
    editor.show(tab ? tab.view.state : null, tab ? tab.view.scroll : null);
    return;
  }
  const input = $('#editor-input');
  if (!input) return;
  input.value = tab ? tab.content : '';
  if (tab) {
    input.setSelectionRange(tab.selectionStart || 0, tab.selectionEnd || 0);
    input.scrollTop = tab.scrollTop || 0;
    input.scrollLeft = tab.scrollLeft || 0;
  }
}

function focusEditor() {
  if (codemirror) codemirror.editor.focus();
  else $('#editor-input')?.focus();
}

// Typing, a selection, an undone change of a review: the tab's state follows.
function onEditorUpdate(app, update) {
  const tab = shownTab();
  if (!tab) return;
  if (update.docChanged) {
    const wasDirty = tab.dirty;
    const dirty = isDirty(tab);
    if (dirty !== tab.dirty) {
      tab.dirty = dirty;
      renderTabs(app);
    }
    setText('#editor-status', dirty ? 'Unsaved changes.' : 'Ready.');
    // An undone change of a reply is saved straight away (after this update).
    const reverts = update.transactions.filter((transaction) => transaction.isUserEvent('revert'));
    noteEditorUndos(tab, update.transactions, reverts, wasDirty);
    if (reverts.length) {
      queueMicrotask(() => { if (state.tabs.includes(tab)) void saveActiveTab(app); });
    }
  }
  if (update.docChanged || update.selectionSet) updateLocation();
  if (tab.review) renderReview(app);
}

// ---- Editor chrome -------------------------------------------------------

function updateLocation() {
  const node = $('#editor-location');
  if (!node) return;
  const tab = activeTab();
  if (!tab || tab.path !== state.shown) { node.textContent = locationText(); return; }
  if (codemirror) {
    node.textContent = locationText(codemirror.module.location(codemirror.editor.view.state));
    return;
  }
  const input = $('#editor-input');
  if (!input) return;
  const { line, column } = cursorPosition(input.value, input.selectionStart);
  node.textContent = locationText({ line, column, selected: Math.abs(input.selectionEnd - input.selectionStart) });
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

function loadActive(app) {
  showActive();
  renderTabs(app);
  renderEditorChrome(app);
  renderReview(app);
  renderTree(app);
}

function activate(app, path) {
  if (path === state.active) return;
  captureShown();
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
  // The first file waits for the editor, so it opens straight in CodeMirror.
  await loadCodeMirror(app);
  const open = state.tabs.find((tab) => tab.path === path);
  if (open) {
    activate(app, path);
    focusEditor();
    // A clean tab shows the file as it is on disk now: a reply or a command may have changed it
    // since it was loaded. Unsaved edits are never replaced (reloadTabs).
    if (!open.dirty) void reloadTabs(app, [path]);
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
      saved: result.data.content,
      revision: result.data.revision,
      dirty: false,
      usedAt: Date.now(),
      view: null,
      review: null,
      undos: [],
      undoText: null,
    });
  }
  activate(app, result.data.path);
  setText('#editor-status', 'Loaded.');
  // Keyboard focus goes to the file's text, as for a tab already open: the tree is drawn again
  // when a file opens, so focus would otherwise be nowhere and the next Tab would indent line 1.
  focusEditor();
  return true;
}

/**
 * Loads open tabs of `paths` again from disk after something else changed them there (a reply,
 * an undo of a reply's changes, a ticked spec task). Tabs with unsaved edits are left alone; a
 * file that is gone closes. With `review` (a reply's changes, normalizeChanges), the files the
 * reply changed are then marked in the editor for review (reviewReplyChanges).
 */
export async function reloadTabs(app, paths, { review = null } = {}) {
  const bridge = window.scalemaxAPI?.workspace;
  const wanted = new Set(Array.isArray(paths) ? paths : []);
  if (!bridge?.read || !wanted.size) return;
  const root = app.workspace.root;
  let changed = false;
  let closed = false;
  for (const tab of [...state.tabs]) {
    if (!wanted.has(tab.path) || tab.dirty) continue;
    const result = await bridge.read(tab.path);
    if (app.workspace.root !== root) return;
    // Typed into while the file was read: the user's edits win.
    if (tab.dirty || !state.tabs.includes(tab)) continue;
    if (result?.ok) {
      if (result.data.revision === tab.revision) continue;
      tab.revision = result.data.revision;
      loadText(tab, result.data.content);
      changed = true;
    } else if (result?.error?.code === 'ENOENT') {
      state.tabs = state.tabs.filter((item) => item !== tab);
      if (state.active === tab.path) state.active = state.tabs[state.tabs.length - 1]?.path || null;
      closed = true;
    }
  }
  if (closed) loadActive(app);
  else if (changed) {
    renderTabs(app);
    updateLocation();
    renderReview(app);
  }
  if (review) await reviewReplyChanges(app, review);
}

export function closeTab(app, path) {
  const index = state.tabs.findIndex((tab) => tab.path === path);
  if (index === -1) return;
  const tab = state.tabs[index];
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

/**
 * Saves the active tab with optimistic concurrency (the stored revision). Saves of one tab run
 * one after another: a second save started while the first is on its way (Cmd+S twice, or an
 * undone change of a review) carries the revision the first one returned instead of failing as
 * a conflict.
 */
export async function saveActiveTab(app) {
  const bridge = window.scalemaxAPI?.workspace;
  const tab = activeTab();
  if (!bridge || !tab) { app.showToast('Open a file first'); return false; }
  const root = app.workspace.root;
  const saving = (tab.saving || Promise.resolve()).then(() => writeTab(app, bridge, tab, root));
  tab.saving = saving.catch(() => false);
  return saving;
}

async function writeTab(app, bridge, tab, root) {
  // Another folder opened while an earlier save of this tab ran: its tabs are gone.
  if (app.workspace.root !== root) return false;
  const content = tabText(tab);
  const from = tab.revision;
  // Changes of a reply undone in the review that this save writes (and nothing else).
  const undone = takeEditorUndos(tab, content);
  const result = await bridge.write({ path: tab.path, content, revision: from });
  if (!result?.ok) {
    app.showToast(result?.error?.message || 'Could not save that file');
    setText('#editor-status', result?.error?.message || 'Save failed.');
    return false;
  }
  tab.revision = result.data.revision;
  markSaved(tab, content);
  // Edits typed while the write was in flight keep the tab dirty, also when the user switched to
  // another tab meanwhile: what the tab holds now is compared with what was written.
  tab.dirty = isDirty(tab);
  renderTabs(app);
  setText('#editor-status', 'Saved.');
  app.showToast('File saved');
  if (typeof app.refreshGit === 'function') void app.refreshGit({ quiet: true });
  // The reply's changes card, its review and the note to the model learn what was undone. Waited
  // for, so the next save of this tab is recorded after this one.
  if (undone && from !== tab.revision) await recordEditorUndo(app, tab, undone, from, tab.revision);
  return true;
}

// ---- Changes undone in the review, for the reply's record ------------------------------------
// Undo on one change saves the tab (onEditorUpdate). When the tab held nothing else unsaved, that
// save is exactly the reply's version with that part put back, so the reply's record (main's
// lib/checkpoints.cjs editorUndo) takes it in: the changes card shows what is left and "Partly
// undone in the editor", the review dialog's diff and Undo work on what is left, and the model is
// told. A save that also carries typed edits is not recorded: the card then says the file
// changed since, and undo there never overwrites those edits.

function forgetEditorUndos(tab) {
  tab.undos = [];
  tab.undoText = null;
}

// The line (1-based, in the text after it) where each change of `transaction` starts.
function changedLines(transaction) {
  const lines = [];
  transaction.changes.iterChangedRanges((_fromA, _toA, fromB) => lines.push(transaction.state.doc.lineAt(fromB).number));
  return lines;
}

function noteEditorUndos(tab, transactions, reverts, wasDirty) {
  if (!tab.undos) forgetEditorUndos(tab);
  // Anything else typed, pasted or undone: the text is no longer only the reply's with parts put back.
  if (!reverts.length || reverts.length !== transactions.length || !tab.review || !codemirror) {
    forgetEditorUndos(tab);
    return;
  }
  const { textOf } = codemirror.module;
  // Clean before, or holding only undone changes not yet saved.
  const clean = !wasDirty || (tab.undoText != null && textOf(reverts[0].startState) === tab.undoText);
  if (!clean) {
    forgetEditorUndos(tab);
    return;
  }
  for (const transaction of reverts) {
    tab.undoText = textOf(transaction.state);
    tab.undos.push({ id: tab.review.id, text: tab.undoText, lines: changedLines(transaction) });
  }
}

// The undone changes a save of `content` writes, taken off the tab's list; null when none (or
// when the text holds more than undone changes).
function takeEditorUndos(tab, content) {
  const list = tab.undos || [];
  let last = -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index].text === content) { last = index; break; }
  }
  if (last === -1) return null;
  const taken = list.splice(0, last + 1);
  // One reply's changes at a time (a new review of another reply forgets the list).
  return { id: taken[0].id, changes: taken.length, lines: taken.flatMap((item) => item.lines).slice(0, 20) };
}

async function recordEditorUndo(app, tab, undone, from, revision) {
  try {
    const { recordEditorUndo: record } = await import('./changes-ui.js');
    await record(app, { id: undone.id, path: tab.path, from, revision, changes: undone.changes, lines: undone.lines });
  } catch (error) {
    console.error('[ScaleMax] The undone change could not be recorded.', error);
  }
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

// ---- Review of a reply's changes ----------------------------------------------
// Like Cursor's and Claude Code's inline review: a file a reply changed shows, in its tab, each
// change against the file as it was just before that reply (CodeMirror's unified merge view),
// with Keep and Undo on each change and a bar above the editor for all of them. A review shows
// one reply's changes, the same as that reply's review dialog: when another reply changes the
// file, its review starts afresh against the text from before it. Undo on one change puts that
// part back and saves through the normal, revision-checked save, and the reply's record learns
// which part was undone (recordEditorUndo). Keep all and Undo all, and a review that ends with
// every change kept, go through the same keep and undo as the reply's changes card
// (src/changes-ui.js), so the card, the review dialog and the note to the model agree.

/**
 * Marks in the editor what a reply (`changes`: normalizeChanges) changed in files open in clean
 * tabs, each still exactly as the reply left it. The earlier text is rebuilt from the reply's
 * diff (originalFromHunks), so the marks are exactly that reply's changes; a review of another
 * reply in the same tab is replaced.
 */
export async function reviewReplyChanges(app, changes, paths = null) {
  const api = window.scalemaxAPI?.checkpoints;
  if (!api?.diff || !changes?.id) return;
  await codemirrorLoading;
  if (!codemirror) return;
  const root = app.workspace.root;
  for (const path of reviewTargets(changes, state.tabs, paths)) {
    let result;
    try {
      result = await api.diff({ id: changes.id, path });
    } catch {
      continue;
    }
    if (app.workspace.root !== root) return;
    const tab = state.tabs.find((item) => item.path === path);
    if (!tab || tab.dirty || !result?.ok || result.data.current !== 'same') continue;
    // Already showing this reply's changes (Open in editor from its review dialog).
    if (tab.review?.id === changes.id) continue;
    const text = tabText(tab);
    const original = originalFromHunks(text, result.data);
    if (original === null || original === text) {
      // The file is as this reply left it: another reply's marks would not be its changes.
      if (tab.review) endReview(app, tab);
      continue;
    }
    forgetEditorUndos(tab);
    tab.review = { id: changes.id, original };
    // A tab never shown yet gets it with its first editor state (showActive).
    const current = editorState(tab);
    if (current) updateTab(tab, codemirror.module.reviewSpec(current, original));
    if (tab.path === state.shown) renderReview(app);
  }
}

/**
 * Ends the editor's review of files of a reply (request id `id`) that are no longer open for
 * keep or undo in its record (`changes`, normalizeChanges: kept or undone from its card or
 * review dialog, or the reply's changes are gone).
 */
export function settleReviews(app, id, changes) {
  const open = new Set((changes?.files || []).filter((file) => file.status === 'changed').map((file) => file.path));
  for (const tab of state.tabs) {
    if (tab.review?.id === id && !open.has(tab.path)) endReview(app, tab);
  }
}

function endReview(app, tab) {
  if (!tab.review) return;
  tab.review = null;
  const current = editorState(tab);
  if (current) updateTab(tab, codemirror.module.reviewSpec(current, null));
  const bar = $('#editor-review');
  const hadFocus = Boolean(bar?.contains?.(document.activeElement));
  renderReview(app);
  if (hadFocus) focusEditor();
}

// The bar above the editor while the shown tab is under review.
function renderReview(app) {
  const bar = $('#editor-review');
  if (!bar) return;
  const tab = activeTab();
  const changes = tab?.review && tab.path === state.shown && codemirror
    ? codemirror.module.reviewChanges(codemirror.editor.view.state) : null;
  if (!changes?.length) {
    bar.hidden = true;
    // Every change kept or undone (or typed away): the review is over.
    if (changes) queueMicrotask(() => finishReview(app, tab));
    return;
  }
  bar.hidden = false;
  setText('#editor-review-label', `${changes.length} ${changes.length === 1 ? 'change' : 'changes'} from the reply`);
}

// No change left to decide. When that came from the review alone (no edits of the user's own),
// the reply's record says so too: kept, or undone when every change was undone (recordEditorUndo
// has already said that). It waits for the save of a change just undone.
function finishReview(app, tab) {
  const current = editorState(tab);
  if (!tab.review || !current || codemirror.module.reviewChanges(current)?.length) return;
  const { id } = tab.review;
  const reviewOnly = !tab.dirty || (tab.undoText != null && tabText(tab) === tab.undoText);
  endReview(app, tab);
  if (!reviewOnly) return;
  void (async () => {
    await tab.saving;
    if (!state.tabs.includes(tab)) return;
    const { keepEditorReview } = await import('./changes-ui.js');
    await keepEditorReview(app, id, tab.path, { quiet: true });
  })();
}

/**
 * Runs an action of the review bar (#editor-review: previous, next, keep, undo, keep-all,
 * undo-all, open) on the shown tab.
 */
export async function reviewAction(app, action) {
  const tab = activeTab();
  if (!tab?.review || !codemirror || tab.path !== state.shown) return;
  const { module, editor } = codemirror;
  const current = editor.view.state;
  if (action === 'next' || action === 'previous') {
    editor.nextChange(action === 'next' ? 1 : -1);
  } else if (action === 'keep' || action === 'undo') {
    const spec = action === 'keep' ? module.keepChangeSpec(current) : module.undoChangeSpec(current);
    if (!spec) {
      setText('#editor-status', 'Put the cursor in a change first (Next change).');
      return;
    }
    editor.dispatch(spec);
    // Back in the text, on the next change: F7, Keep and Undo go on from there.
    focusEditor();
    if (module.reviewChanges(editor.view.state)?.length) editor.nextChange(1);
  } else if (action === 'keep-all' || action === 'undo-all') {
    // The same keep and undo as the reply's changes card, for this file.
    const { id } = tab.review;
    await tab.saving;
    const { keepEditorReview, undoEditorReview } = await import('./changes-ui.js');
    const done = action === 'keep-all'
      ? await keepEditorReview(app, id, tab.path)
      : await undoEditorReview(app, id, tab.path, { unsaved: tab.dirty });
    if (done && action === 'keep-all' && tab.review?.id === id) endReview(app, tab);
    if (state.tabs.includes(tab) && tab.path === state.shown) focusEditor();
  } else if (action === 'open') {
    void openFullReview(app, tab);
  }
}

// The reply's review dialog (src/changes-ui.js) for this file.
async function openFullReview(app, tab) {
  const id = tab.review?.id;
  const task = (app.tasks || []).find((item) => item.messages?.some((message) => message.changes?.id === id));
  if (!task) { app.showToast('That reply is no longer in a task.'); return; }
  const { openReview } = await import('./changes-ui.js');
  await openReview(app, task.id, id, tab.path, $('#editor-review-open'));
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

// The review bar's controls (#editor-review), built once; renderReview() shows the bar.
const REVIEW_ACTIONS = [
  ['previous', 'Previous', 'Previous change (Shift+F7)'],
  ['next', 'Next', 'Next change (F7)'],
  ['keep', 'Keep', 'Keep the change at the cursor'],
  ['undo', 'Undo', 'Undo the change at the cursor and save'],
  ['keep-all', 'Keep all', 'Keep all changes and close the review'],
  ['undo-all', 'Undo all', 'Undo all changes in this file and save'],
  ['open', 'Open full review', 'Open full review of this reply\'s changes'],
];

function bindReviewBar(app) {
  const bar = $('#editor-review');
  if (!bar) return;
  const label = element('span', 'ws-review-label');
  label.id = 'editor-review-label';
  const actions = element('div', 'ws-review-actions');
  for (const [action, text, title] of REVIEW_ACTIONS) {
    const button = element('button', 'button secondary compact', text);
    button.dataset.reviewAction = action;
    button.title = title;
    button.setAttribute('aria-label', title);
    if (action === 'open') button.id = 'editor-review-open';
    actions.append(button);
  }
  bar.replaceChildren(label, actions);
  bar.addEventListener('click', (event) => {
    const button = event.target.closest('[data-review-action]');
    if (button) void reviewAction(app, button.dataset.reviewAction);
  });
}

function bindEditor(app) {
  // The plain textarea, the editor until CodeMirror has loaded (or when it cannot).
  const input = $('#editor-input');
  input?.addEventListener('input', () => {
    const tab = shownTab();
    if (!tab || codemirror) return;
    const dirty = isDirty(tab);
    if (dirty !== tab.dirty) {
      tab.dirty = dirty;
      renderTabs(app);
    }
    setText('#editor-status', dirty ? 'Unsaved changes.' : 'Ready.');
    updateLocation();
  });
  for (const type of ['click', 'keyup', 'select', 'focus']) input?.addEventListener(type, updateLocation);
  document.addEventListener('selectionchange', () => {
    if (input && document.activeElement === input) updateLocation();
  });
  bindReviewBar(app);
  // While the editor has focus the statusbar says how to leave it (Tab indents there; Escape then
  // Tab moves on, CodeMirror's tab focus mode).
  const view = $('#editor-view');
  const hint = $('#editor-keys-hint');
  if (view && hint) {
    view.addEventListener('focusin', () => hint.classList.add('is-shown'));
    view.addEventListener('focusout', (event) => {
      if (!view.contains(event.relatedTarget)) hint.classList.remove('is-shown');
    });
  }

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
  // CodeMirror loads in the background; the first file opened waits for it (openFileInTab).
  void loadCodeMirror(app);
}
