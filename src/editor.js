/**
 * ScaleMax IDE: the Workspace code editor, CodeMirror 6 (src/vendor/codemirror.js, vendored by
 * build/vendor-codemirror.cjs).
 *
 * src/workspace-ui.js owns the editor's behaviour (tabs, saving, dirty state, the review of a
 * reply's changes) and imports this module lazily, because CodeMirror needs a real page. This
 * module only sets CodeMirror up: one EditorView for the Workspace and one EditorState per open
 * tab, so switching tabs keeps each file's undo history, selection and folds (the scroll
 * position travels next to it as a snapshot).
 *
 * Everything but createEditor() works on states alone (the few DOM helpers run only inside a
 * view), so it is unit-tested in Node (test/editor.test.mjs). Colours and the font are CSS variables (src/workspace.css on
 * top of src/sm-tokens.css), so a theme switch repaints without rebuilding anything. CodeMirror
 * adds its own CSS rules through a constructed stylesheet (see build/vendor-codemirror.cjs for
 * why that is the one way the page's CSP allows), and DOM is built with createElement only.
 */
import {
  EditorState, EditorSelection, Compartment, Text, ChangeSet, EditorView, keymap, lineNumbers,
  highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor,
  rectangularSelection, crosshairCursor, scrollPastEnd, defaultKeymap, history, historyKeymap,
  isolateHistory, indentMore, indentLess, syntaxHighlighting, HighlightStyle, indentOnInput,
  bracketMatching, foldGutter, foldKeymap, indentUnit, countColumn, StreamLanguage, tags, search,
  searchKeymap, highlightSelectionMatches, openSearchPanel, gotoLine, autocompletion, completionKeymap,
  closeBrackets, closeBracketsKeymap, unifiedMergeView, getChunks, getOriginalDoc, updateOriginalDoc,
  goToNextChunk, goToPreviousChunk, javascript, json, css, html, markdown, markdownLanguage, python,
  rust, go, java, cpp, php, sql, xml, yaml, shell, toml,
} from './vendor/codemirror.js';
import { languageFor, fenceLanguage, indentFor, lineBreakOf } from './workspace-ui.js';

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

// One entry per language id of src/workspace-ui.js (LANGUAGES), built the first time a file of
// that kind opens and then shared by every tab.
const LANGUAGE_SUPPORT = {
  javascript: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  json: () => json(),
  css: () => css(),
  scss: () => css(),
  less: () => css(),
  html: () => html(),
  // Fenced code blocks are highlighted in their own language.
  markdown: () => markdown({ base: markdownLanguage, codeLanguages: (info) => fencedLanguage(info) }),
  python: () => python(),
  rust: () => rust(),
  go: () => go(),
  java: () => java(),
  c: () => cpp(),
  cpp: () => cpp(),
  php: () => php(),
  sql: () => sql(),
  xml: () => xml(),
  yaml: () => yaml(),
  shell: () => StreamLanguage.define(shell),
  toml: () => StreamLanguage.define(toml),
};
const supports = new Map();

/** CodeMirror's support for a language id ('plain' and unknown ids have none). */
export function languageSupport(id) {
  if (!Object.hasOwn(LANGUAGE_SUPPORT, id)) return null;
  if (!supports.has(id)) supports.set(id, LANGUAGE_SUPPORT[id]());
  return supports.get(id);
}

function fencedLanguage(info) {
  const id = fenceLanguage(info);
  const support = id && id !== 'markdown' ? languageSupport(id) : null;
  // A legacy mode is a Language itself; the others wrap theirs.
  return support ? support.language || support : null;
}

// ---------------------------------------------------------------------------
// Look: CSS variables only (src/workspace.css defines them for both themes)
// ---------------------------------------------------------------------------

const HIGHLIGHT = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.modifier, tags.self], color: 'var(--tok-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.character, tags.docString], color: 'var(--tok-string)' },
  { tag: [tags.regexp, tags.escape, tags.url], color: 'var(--tok-regexp)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: 'var(--tok-comment)', fontStyle: 'italic' },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom, tags.unit, tags.color], color: 'var(--tok-number)' },
  { tag: [tags.tagName, tags.angleBracket, tags.link], color: 'var(--tok-tag)' },
  { tag: [tags.attributeName, tags.propertyName, tags.labelName], color: 'var(--tok-attr)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.function(tags.definition(tags.variableName)), tags.macroName], color: 'var(--tok-function)' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.typeName)], color: 'var(--tok-type)' },
  { tag: [tags.meta, tags.annotation, tags.processingInstruction, tags.documentMeta], color: 'var(--tok-meta)' },
  { tag: tags.heading, color: 'var(--tok-heading)', fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, textDecoration: 'underline' },
  { tag: tags.invalid, color: 'var(--tok-invalid)' },
]);

// Rules after CodeMirror's base themes, so equal selectors win. Its light/dark defaults that are
// not repeated here still follow the app theme (themeSlot below).
const THEME = EditorView.theme({
  '&': { color: 'var(--ws-editor-fg)', backgroundColor: 'var(--ws-editor-bg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--ws-code-font)',
    fontSize: 'var(--ws-code-size)',
    lineHeight: 'var(--ws-code-line)',
    fontVariantLigatures: 'none',
  },
  // CodeMirror sets tab-size as an attribute the CSP ignores; this is the same value.
  '.cm-content': { padding: 'var(--ws-code-pad-y) 0', caretColor: 'var(--ws-editor-caret)', tabSize: '4' },
  '.cm-line': { padding: '0 var(--ws-code-pad-x) 0 4px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ws-editor-caret)', borderLeftWidth: '2px' },
  '.cm-selectionBackground': { backgroundColor: 'var(--ws-editor-selection)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'var(--ws-editor-selection-focused)' },
  '.cm-activeLine': { backgroundColor: 'var(--ws-editor-active-line)' },
  '.cm-gutters': {
    color: 'var(--ws-editor-gutter-fg)',
    backgroundColor: 'var(--ws-editor-bg)',
    borderRight: '1px solid var(--sm-color-border-tertiary)',
  },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '32px', padding: '0 6px 0 10px' },
  '.cm-activeLineGutter': { color: 'var(--ws-editor-gutter-active-fg)', backgroundColor: 'transparent' },
  '.cm-foldGutter .cm-gutterElement': { width: '14px', textAlign: 'center', cursor: 'pointer' },
  '.cm-foldMarker': { color: 'transparent', transition: 'color 0.15s' },
  '.cm-gutters:hover .cm-foldMarker, .cm-foldMarker.is-folded': { color: 'var(--ws-editor-gutter-fg)' },
  '.cm-foldPlaceholder': {
    margin: '0 2px',
    padding: '0 4px',
    border: '1px solid var(--sm-color-border-secondary)',
    borderRadius: '4px',
    backgroundColor: 'var(--sm-app-surface-hover)',
    color: 'var(--sm-text-medium)',
  },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--ws-editor-bracket)', outline: '1px solid var(--ws-editor-bracket-border)' },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--ws-editor-bracket-bad)' },
  '.cm-searchMatch': { backgroundColor: 'var(--ws-editor-match)', outline: '1px solid var(--ws-editor-match-border)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--ws-editor-match-current)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--ws-editor-selection-match)' },
  '.cm-specialChar': { color: 'var(--tok-invalid)' },
  // Find / replace and go to line sit in a panel above the text.
  '.cm-panels': { backgroundColor: 'var(--sm-app-chrome)', color: 'var(--sm-text-strong)' },
  '.cm-panels-top': { borderBottom: '1px solid var(--sm-app-border)' },
  '.cm-panels-bottom': { borderTop: '1px solid var(--sm-app-border)' },
  '.cm-panel': { fontSize: '12px' },
  '.cm-panel.cm-search': { padding: '6px 34px 6px 10px' },
  '.cm-panel.cm-search label': { fontSize: '12px', color: 'var(--sm-text-medium)' },
  '.cm-panel.cm-search [name=close]': { top: '6px', right: '8px', fontSize: '16px', color: 'var(--sm-text-medium)' },
  '.cm-textfield': {
    minHeight: '24px',
    padding: '2px 8px',
    border: '1px solid var(--sm-color-border-solid)',
    borderRadius: '6px',
    backgroundColor: 'var(--sm-app-surface)',
    color: 'var(--sm-text-strong)',
    fontSize: '12px',
  },
  '.cm-textfield:focus': { borderColor: 'var(--sm-color-border-focus)', outline: 'none' },
  '.cm-button': {
    minHeight: '24px',
    padding: '2px 10px',
    border: '1px solid var(--sm-color-border-secondary)',
    borderRadius: '6px',
    backgroundImage: 'none',
    backgroundColor: 'var(--sm-app-surface)',
    color: 'var(--sm-text-strong)',
    fontSize: '12px',
  },
  '.cm-button:hover': { backgroundColor: 'var(--sm-app-surface-hover)' },
  '.cm-button:active': { backgroundImage: 'none', backgroundColor: 'var(--sm-app-surface-hover)' },
  '.cm-tooltip': {
    border: '1px solid var(--sm-color-border-secondary)',
    borderRadius: '6px',
    backgroundColor: 'var(--sm-app-surface)',
    color: 'var(--sm-text-strong)',
    boxShadow: '0 6px 20px rgba(0, 0, 0, 0.12)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--ws-code-font)', fontSize: 'var(--ws-code-size)' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--ws-editor-completion)', color: 'var(--ws-editor-completion-fg)' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600' },
  // Review of a reply's changes (unified merge view).
  '&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine': { backgroundColor: 'var(--ws-diff-add-line)' },
  '&.cm-merge-b .cm-changedText': { background: 'var(--ws-diff-add-text)' },
  '.cm-deletedChunk': { backgroundColor: 'var(--ws-diff-del-line)', paddingLeft: '4px' },
  '.cm-deletedChunk .cm-deletedText, &.cm-merge-b .cm-deletedText': { background: 'var(--ws-diff-del-text)' },
  '.cm-deletedChunk .cm-deletedLine': { padding: '0 var(--ws-code-pad-x) 0 4px', opacity: '0.85' },
  '.cm-changeGutter': { width: '3px', paddingLeft: '0' },
  '&.cm-merge-b .cm-changedLineGutter': { background: 'var(--ws-diff-add-bar)' },
  '.cm-deletedLineGutter': { background: 'var(--ws-diff-del-bar)' },
  '.cm-deletedChunk .cm-chunkButtons': { insetInlineEnd: '12px', zIndex: '1' },
  '.cm-deletedChunk .cm-chunkButtons button': {
    margin: '2px 0 0 4px',
    padding: '0 8px',
    border: '1px solid var(--sm-color-border-secondary)',
    borderRadius: '5px',
    background: 'var(--sm-app-surface)',
    color: 'var(--sm-text-strong)',
    fontFamily: 'var(--ws-ui-font)',
    fontSize: '11px',
    lineHeight: '18px',
  },
  '.cm-deletedChunk .cm-chunkButtons button:hover': { background: 'var(--sm-app-surface-hover)' },
  '.cm-deletedChunk .cm-chunkButtons button[name=accept]': { borderColor: 'var(--ws-diff-add-bar)' },
});

// The fold markers are drawn by CSS (hidden until the gutter is hovered, unless folded).
function foldMarker(open) {
  const marker = document.createElement('span');
  marker.className = `cm-foldMarker ${open ? 'is-open' : 'is-folded'}`;
  marker.textContent = open ? '⌄' : '›';
  marker.title = open ? 'Fold' : 'Unfold';
  return marker;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// Tab with a selection indents its lines (Shift-Tab outdents them, as always); at plain cursors
// it inserts spaces up to the next indentation stop, as VS Code and the old editor do.
function indentOrInsert(view) {
  const { state } = view;
  if (state.readOnly) return false;
  if (state.selection.ranges.some((range) => !range.empty)) return indentMore(view);
  const unit = state.facet(indentUnit);
  view.dispatch(state.update(state.changeByRange((range) => {
    let insert = unit;
    if (unit !== '\t') {
      const line = state.doc.lineAt(range.head);
      const column = countColumn(line.text.slice(0, range.head - line.from), state.tabSize);
      insert = ' '.repeat(unit.length - (column % unit.length));
    }
    return { changes: { from: range.head, insert }, range: EditorSelection.cursor(range.head + insert.length) };
  }), { scrollIntoView: true, userEvent: 'input.indent' }));
  return true;
}

// Cmd+Alt+F: the find panel with the replace field focused.
function openReplace(view) {
  openSearchPanel(view);
  const field = view.dom.querySelector('.cm-search [name=replace]');
  if (field) {
    field.focus();
    field.select();
  }
  return true;
}

// ---------------------------------------------------------------------------
// States (no DOM)
// ---------------------------------------------------------------------------

const reviewSlot = new Compartment();
const themeSlot = new Compartment();
// Update listeners per view (createEditor), so states stay shareable between views.
const listeners = new WeakMap();
const LINE_BREAK = Text.of(['', '']);

function appDark() {
  return typeof document !== 'undefined' && document.documentElement?.dataset?.theme === 'dark';
}

const BASE = [
  lineNumbers(),
  foldGutter({ markerDOM: foldMarker }),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  // Alt+click adds a cursor (Alt+drag a column of them), as in VS Code.
  EditorView.clickAddsSelectionRange.of((event) => event.altKey),
  EditorState.tabSize.of(4),
  indentOnInput(),
  syntaxHighlighting(HIGHLIGHT),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  search({ top: true }),
  scrollPastEnd(),
  EditorView.contentAttributes.of({ 'aria-label': 'File contents', 'aria-describedby': 'editor-status' }),
  // Pasted or dropped text takes the file's line breaks (a CRLF file stays CRLF).
  EditorView.clipboardInputFilter.of((text, state) => text.replace(/\r\n?|\n/g, state.lineBreak)),
  // Escape then Tab moves focus out of the editor (CodeMirror's tab focus mode), so the Tab
  // binding below never traps keyboard users.
  keymap.of([
    ...closeBracketsKeymap,
    { key: 'Tab', run: indentOrInsert, shift: indentLess },
    { key: 'Mod-Alt-f', run: openReplace, preventDefault: true },
    { mac: 'Ctrl-g', run: gotoLine, preventDefault: true },
    // In a review: the next / previous change, like VS Code's diff editor.
    { key: 'F7', run: (view) => goToNextChunk(view), shift: (view) => goToPreviousChunk(view) },
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...completionKeymap,
  ]),
  THEME,
  EditorView.updateListener.of((update) => listeners.get(update.view)?.(update)),
];

/**
 * A new tab's editor state for the file `path` holding `text`: its language, the indentation it
 * already uses and its own line breaks (kept as they are on disk, CRLF included). `review` is
 * the file's text before a reply changed it (see reviewExtension), or null.
 */
export function createTabState(text = '', { path = '', readOnly = false, review = null } = {}) {
  const value = String(text ?? '');
  const language = languageFor(path);
  const support = readOnly ? null : languageSupport(language);
  const extensions = [
    BASE,
    EditorState.lineSeparator.of(lineBreakOf(value)),
    indentUnit.of(indentFor(value, language)),
    themeSlot.of(EditorView.darkTheme.of(appDark())),
    support || [],
  ];
  if (readOnly) extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
  const state = EditorState.create({ doc: value, extensions: [...extensions, reviewSlot.of([])] });
  return review === null || review === undefined ? state : state.update(reviewSpec(state, review)).state;
}

/** The text of a state with its own line breaks: what saving writes. */
export function textOf(state) {
  return state.sliceDoc();
}

/** The document `text` stands for in this state (to compare with, see unchanged()). */
export function savedDoc(state, text) {
  return state.toText(String(text ?? ''));
}

/** True when the state's text is `doc` (savedDoc). Cheap unless the lengths are equal. */
export function unchanged(state, doc) {
  return state.doc.eq(doc);
}

/**
 * The transaction that makes a state hold `text`, which is what the file now holds on disk: one
 * change over the part that differs, so the selection and scroll position stay where they were
 * and Undo can take the new text back. Null when the file's line breaks changed kind: then the
 * tab needs a fresh state (createTabState).
 */
export function reloadSpec(state, text) {
  const value = String(text ?? '');
  if (lineBreakOf(value) !== state.lineBreak) return null;
  const next = state.toText(value);
  if (state.doc.eq(next)) return {};
  return { changes: difference(state.doc, next), annotations: isolateHistory.of('full') };
}

// The one change that turns document `from` into `to`: the part between what they share at the
// start and at the end (positions count a line break as one, as documents do).
function difference(from, to) {
  const before = from.toString();
  const after = to.toString();
  const shortest = Math.min(before.length, after.length);
  let start = 0;
  while (start < shortest && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
  let end = 0;
  while (end < shortest - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end += 1;
  return { from: start, to: before.length - end, insert: to.slice(start, after.length - end) };
}

/** Where the main cursor is (1-based), how many characters are selected and how many cursors. */
export function location(state) {
  const { main, ranges } = state.selection;
  const line = state.doc.lineAt(main.head);
  let selected = 0;
  for (const range of ranges) selected += range.to - range.from;
  return { line: line.number, column: main.head - line.from + 1, selected, cursors: ranges.length };
}

// ---- Review of a reply's changes ----------------------------------------------------------

// The per-change buttons inside the editor. They act on the change they sit on; the review bar
// (src/workspace-ui.js) offers the same for keyboard users.
function chunkButton(type) {
  const button = document.createElement('button');
  button.type = 'button';
  button.name = type;
  button.textContent = type === 'accept' ? 'Keep' : 'Undo';
  button.title = type === 'accept' ? 'Keep this change' : 'Undo this change (puts the earlier text back and saves)';
  button.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const root = button.closest('.cm-editor');
    const view = root ? EditorView.findFromDOM(root) : null;
    if (!view) return;
    const at = view.posAtDOM(button);
    const spec = type === 'accept' ? keepChangeSpec(view.state, at) : undoChangeSpec(view.state, at);
    if (spec) view.dispatch(spec);
  });
  return button;
}

/**
 * The extension that marks every change between `original` (the text before the reply) and the
 * editor's text, with the earlier lines shown above the new ones and Keep / Undo on each.
 */
function reviewExtension(state, original) {
  return unifiedMergeView({
    original: state.toText(String(original)),
    mergeControls: (type) => chunkButton(type),
    gutter: true,
    highlightChanges: true,
  });
}

/** Starts (original: the earlier text) or ends (null) the review of a state. */
export function reviewSpec(state, original) {
  return { effects: reviewSlot.reconfigure(original === null || original === undefined ? [] : reviewExtension(state, original)) };
}

/** The changes still under review as [from, to] in the editor's text, or null without a review. */
export function reviewChanges(state) {
  const chunks = getChunks(state)?.chunks;
  return chunks ? chunks.map((chunk) => [chunk.fromB, chunk.endB]) : null;
}

function chunkAt(state, pos) {
  const at = pos ?? state.selection.main.head;
  return getChunks(state)?.chunks.find((chunk) => chunk.fromB <= at && chunk.endB >= at) || null;
}

// The chunk's earlier lines, with the line break after them when the chunk does not end the
// document (CodeMirror's own rejectChunk, but with Text slices, so CRLF files stay intact).
function originalPart(state, chunk) {
  let insert = getOriginalDoc(state).slice(chunk.fromA, Math.max(chunk.fromA, chunk.toA - 1));
  if (chunk.fromA !== chunk.toA && chunk.toB <= state.doc.length) insert = insert.append(LINE_BREAK);
  return { from: chunk.fromB, to: Math.min(state.doc.length, chunk.toB), insert };
}

/** Undo of the change at `pos` (default: the cursor): its earlier text back. Null when none. */
export function undoChangeSpec(state, pos) {
  const chunk = chunkAt(state, pos);
  return chunk ? { changes: originalPart(state, chunk), userEvent: 'revert', scrollIntoView: true } : null;
}

/**
 * Undo of every change under review in one step: the earlier text back exactly (one change
 * straight from it, as CodeMirror's chunks can round a run of blank lines oddly). Null when
 * nothing is under review.
 */
export function undoAllSpec(state) {
  if (!getChunks(state)?.chunks.length) return null;
  return { changes: difference(state.doc, getOriginalDoc(state)), userEvent: 'revert', scrollIntoView: true };
}

/** Keep of the change at `pos` (default: the cursor): it stops being marked. Null when none. */
export function keepChangeSpec(state, pos) {
  const chunk = chunkAt(state, pos);
  if (!chunk) return null;
  const original = getOriginalDoc(state);
  let insert = state.doc.slice(chunk.fromB, Math.max(chunk.fromB, chunk.toB - 1));
  if (chunk.fromB !== chunk.toB && chunk.toA <= original.length) insert = insert.append(LINE_BREAK);
  const changes = ChangeSet.of({ from: chunk.fromA, to: Math.min(original.length, chunk.toA), insert }, original.length);
  return { effects: updateOriginalDoc.of({ doc: changes.apply(original), changes }), userEvent: 'accept' };
}

// ---------------------------------------------------------------------------
// The view (needs the page)
// ---------------------------------------------------------------------------

/**
 * The Workspace's editor view in `parent`. `onUpdate(update)` hears every CodeMirror update
 * (typing, selection, an undone change: `update.transactions[i].isUserEvent('revert')`).
 * show() puts a tab's state (and scroll snapshot) on screen; snapshot() takes them back.
 */
export function createEditor(parent, { onUpdate } = {}) {
  const view = new EditorView({ parent, state: createTabState('', { readOnly: true }) });
  if (typeof onUpdate === 'function') listeners.set(view, onUpdate);
  // The app theme changed: CodeMirror's own light/dark defaults follow (colours are variables).
  const syncTheme = () => {
    const dark = appDark();
    if (view.state.facet(EditorView.darkTheme) !== dark) view.dispatch({ effects: themeSlot.reconfigure(EditorView.darkTheme.of(dark)) });
  };
  const observer = new MutationObserver(syncTheme);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return {
    view,
    show(state, scroll = null) {
      view.setState(state || createTabState('', { readOnly: true }));
      syncTheme();
      if (scroll) view.dispatch({ effects: scroll });
    },
    snapshot() {
      return { state: view.state, scroll: view.scrollSnapshot() };
    },
    dispatch(spec) {
      view.dispatch(spec);
    },
    focus() {
      view.focus();
    },
    // The cursor to the next (or previous) change under review; keyboard focus stays where it is.
    nextChange(direction = 1) {
      return (direction < 0 ? goToPreviousChunk : goToNextChunk)(view);
    },
    destroy() {
      observer.disconnect();
      listeners.delete(view);
      view.destroy();
    },
  };
}
