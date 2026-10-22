#!/usr/bin/env node
'use strict';

// Vendors CodeMirror 6 for the Workspace editor (src/editor.js). The app has no build step and
// no runtime dependencies, so the editor's packages are bundled once, here, into one committed
// ES module, src/vendor/codemirror.js, with their licence notices next to it in
// src/vendor/codemirror.LICENSE.txt. Run it again after changing a version below:
//
//   node build/vendor-codemirror.cjs
//
// The packages are installed at exactly these versions (their dependencies pinned too, through
// npm overrides) into a temporary folder outside the repository: never into this project's
// node_modules or package.json. Install scripts do not run (esbuild finds its binary in its
// platform package without one). esbuild then bundles the exports below into one minified file
// with no import left in it, and the script checks that before writing anything.
//
// One upstream line is changed while bundling (STYLE_MOD_PATCH): style-mod, which mounts
// CodeMirror's CSS, uses a constructed stylesheet (adoptedStyleSheets) only in shadow roots and
// falls back to a <style> element in documents. The page's CSP (style-src 'self', no
// 'unsafe-inline') refuses <style> elements, so the editor would have no styles at all. The
// patch takes the constructed-stylesheet path in documents too: rules added with insertRule are
// CSSOM, which the CSP does not restrict, and Chromium (Electron 33) supports
// document.adoptedStyleSheets. The build fails if the line ever changes upstream.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'scalemax-cm');
const OUT = path.join(ROOT, 'src', 'vendor', 'codemirror.js');
const LICENSE_OUT = path.join(ROOT, 'src', 'vendor', 'codemirror.LICENSE.txt');
const REGENERATE = 'node build/vendor-codemirror.cjs';

// What src/editor.js imports. Versions published at least two weeks before they were pinned.
const PACKAGES = {
  '@codemirror/state': '6.7.6',
  '@codemirror/view': '6.43.13',
  '@codemirror/commands': '6.11.1',
  '@codemirror/language': '6.12.4',
  '@codemirror/search': '6.7.2',
  '@codemirror/autocomplete': '6.20.3',
  '@codemirror/merge': '6.12.2',
  '@codemirror/lang-javascript': '6.2.5',
  '@codemirror/lang-json': '6.0.2',
  '@codemirror/lang-css': '6.3.1',
  '@codemirror/lang-html': '6.4.12',
  '@codemirror/lang-markdown': '6.5.2',
  '@codemirror/lang-python': '6.2.1',
  '@codemirror/lang-rust': '6.0.2',
  '@codemirror/lang-go': '6.0.1',
  '@codemirror/lang-java': '6.0.2',
  '@codemirror/lang-cpp': '6.0.3',
  '@codemirror/lang-php': '6.0.2',
  '@codemirror/lang-sql': '6.10.0',
  '@codemirror/lang-xml': '6.1.0',
  '@codemirror/lang-yaml': '6.1.3',
  // Shell and TOML (the old editor highlighted both) have no lang-* package: their legacy modes.
  '@codemirror/legacy-modes': '6.5.4',
};
// Their dependencies, pinned so a rebuild bundles the same code.
const PINNED = {
  '@lezer/common': '1.5.3',
  '@lezer/highlight': '1.2.5',
  '@lezer/lr': '1.4.10',
  '@lezer/cpp': '1.1.6',
  '@lezer/css': '1.3.8',
  '@lezer/go': '1.0.1',
  '@lezer/html': '1.3.13',
  '@lezer/java': '1.1.4',
  '@lezer/javascript': '1.5.5',
  '@lezer/json': '1.0.3',
  '@lezer/markdown': '1.7.2',
  '@lezer/php': '1.0.6',
  '@lezer/python': '1.1.19',
  '@lezer/rust': '1.0.3',
  '@lezer/xml': '1.0.6',
  '@lezer/yaml': '1.0.4',
  '@marijn/find-cluster-break': '1.0.4',
  'style-mod': '4.1.4',
  'w3c-keyname': '2.2.8',
  crelt: '1.0.7',
};
const ESBUILD = '0.28.2';

// The bundle's exports: one ES module, so src/editor.js imports everything from one place.
const ENTRY = `
export {
  EditorState, EditorSelection, Compartment, Prec, Transaction, StateEffect, StateField, Text, ChangeSet, countColumn,
} from '@codemirror/state';
export {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor, scrollPastEnd,
} from '@codemirror/view';
export {
  defaultKeymap, history, historyKeymap, isolateHistory, indentMore, indentLess, undo, redo, undoDepth,
} from '@codemirror/commands';
export {
  syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap, indentUnit, StreamLanguage,
  language,
} from '@codemirror/language';
export { tags } from '@lezer/highlight';
export { search, searchKeymap, highlightSelectionMatches, openSearchPanel, gotoLine } from '@codemirror/search';
export { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
// Not acceptChunk / rejectChunk: rejectChunk puts restored lines back joined by bare LF, which a
// CRLF document keeps inside one line (src/editor.js has its own, on Text slices).
export { unifiedMergeView, getChunks, getOriginalDoc, updateOriginalDoc, goToNextChunk, goToPreviousChunk } from '@codemirror/merge';
export { javascript } from '@codemirror/lang-javascript';
export { json } from '@codemirror/lang-json';
export { css } from '@codemirror/lang-css';
export { html } from '@codemirror/lang-html';
export { markdown, markdownLanguage } from '@codemirror/lang-markdown';
export { python } from '@codemirror/lang-python';
export { rust } from '@codemirror/lang-rust';
export { go } from '@codemirror/lang-go';
export { java } from '@codemirror/lang-java';
export { cpp } from '@codemirror/lang-cpp';
export { php } from '@codemirror/lang-php';
export { sql } from '@codemirror/lang-sql';
export { xml } from '@codemirror/lang-xml';
export { yaml } from '@codemirror/lang-yaml';
export { shell } from '@codemirror/legacy-modes/mode/shell';
export { toml } from '@codemirror/legacy-modes/mode/toml';
`;

// See the top of this file. Exactly one occurrence, or the build stops.
const STYLE_MOD_FILE = /[\\/]node_modules[\\/]style-mod[\\/]src[\\/]style-mod\.js$/;
const STYLE_MOD_PATCH = {
  from: 'if (!root.head && root.adoptedStyleSheets && win.CSSStyleSheet) {',
  to: 'if (root.adoptedStyleSheets && win.CSSStyleSheet) {',
};

function install() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const manifest = {
    name: 'scalemax-codemirror-vendor',
    private: true,
    version: '0.0.0',
    dependencies: { ...PACKAGES, esbuild: ESBUILD },
    overrides: PINNED,
  };
  fs.writeFileSync(path.join(WORK, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: WORK, stdio: 'inherit' });
  // Every pinned package must be there at its version (overrides only apply when npm agrees).
  for (const [name, version] of Object.entries({ ...PACKAGES, ...PINNED, esbuild: ESBUILD })) {
    const installed = packageInfo(path.join(WORK, 'node_modules', name)).version;
    if (installed !== version) throw new Error(`${name} installed as ${installed}, expected ${version}.`);
  }
}

function packageInfo(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

function licenseText(dir) {
  const file = fs.readdirSync(dir).find((name) => /^licen[cs]e(\.(md|txt))?$/i.test(name));
  if (!file) throw new Error(`No licence file in ${dir}.`);
  return fs.readFileSync(path.join(dir, file), 'utf8').trim();
}

// node_modules/@codemirror/view/dist/index.js → @codemirror/view
function packageOf(input) {
  const parts = input.split(/[\\/]/);
  const at = parts.lastIndexOf('node_modules');
  if (at === -1) return null;
  return parts[at + 1].startsWith('@') ? `${parts[at + 1]}/${parts[at + 2]}` : parts[at + 1];
}

async function bundle() {
  const esbuild = require(path.join(WORK, 'node_modules', 'esbuild'));
  const entry = path.join(WORK, 'entry.mjs');
  fs.writeFileSync(entry, ENTRY);
  let patched = 0;
  const result = await esbuild.build({
    absWorkingDir: WORK,
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome130',
    minify: true,
    legalComments: 'none',
    metafile: true,
    write: false,
    logLevel: 'warning',
    plugins: [{
      name: 'style-mod-adopted-sheets',
      setup(build) {
        build.onLoad({ filter: STYLE_MOD_FILE }, (args) => {
          const source = fs.readFileSync(args.path, 'utf8');
          if (source.split(STYLE_MOD_PATCH.from).length !== 2) {
            throw new Error('style-mod changed: review STYLE_MOD_PATCH in build/vendor-codemirror.cjs.');
          }
          patched += 1;
          return { contents: source.replace(STYLE_MOD_PATCH.from, STYLE_MOD_PATCH.to), loader: 'js' };
        });
      },
    }],
  });
  if (patched !== 1) throw new Error(`style-mod was patched ${patched} times, expected once.`);
  const [output] = result.outputFiles;
  const meta = Object.values(result.metafile.outputs)[0];
  // Nothing left for the browser to resolve: no static, dynamic or bare imports.
  if (meta.imports.length) throw new Error(`The bundle still imports ${meta.imports.map((item) => item.path).join(', ')}.`);
  const names = [...new Set(Object.keys(result.metafile.inputs).map(packageOf).filter(Boolean))].sort();
  return { code: output.text, names };
}

function header(packages) {
  const list = packages.map(({ name, version }) => `${name} ${version}`);
  const lines = [];
  let line = ' *  ';
  for (const item of list) {
    if (line.length + item.length > 98) { lines.push(line.trimEnd()); line = ' *  '; }
    line += `${item}, `;
  }
  lines.push(line.replace(/, $/, '.'));
  return [
    '/*',
    ' * CodeMirror 6 for the ScaleMax IDE Workspace editor (src/editor.js). Generated: do not edit.',
    ` * Regenerate: ${REGENERATE}`,
    ` * One ES module bundled and minified by esbuild ${ESBUILD}; licence notices in codemirror.LICENSE.txt.`,
    ' * Packages:',
    ...lines,
    ' * Changed from upstream: style-mod mounts the editor\'s CSS in a constructed stylesheet',
    ' * (document.adoptedStyleSheets) in documents too, because the page\'s CSP refuses <style>.',
    ' */',
    '',
  ].join('\n');
}

function licenses(packages) {
  const parts = [
    'Third-party software bundled in src/vendor/codemirror.js (ScaleMax IDE).',
    `Generated by ${REGENERATE}; one notice per package.`,
    '',
  ];
  for (const { name, version, license, text } of packages) {
    parts.push('='.repeat(78), `${name} ${version} (${license})`, '='.repeat(78), '', text, '');
  }
  return `${parts.join('\n').trimEnd()}\n`;
}

async function main() {
  install();
  const { code, names } = await bundle();
  const packages = names.map((name) => {
    const dir = path.join(WORK, 'node_modules', name);
    const info = packageInfo(dir);
    if (info.license !== 'MIT') throw new Error(`${name} is licensed ${info.license}; check it before vendoring.`);
    return { name, version: info.version, license: info.license, text: licenseText(dir) };
  });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, header(packages) + code);
  fs.writeFileSync(LICENSE_OUT, licenses(packages));
  const size = fs.statSync(OUT).size;
  console.log(`Wrote ${path.relative(ROOT, OUT)} (${(size / 1024).toFixed(0)} KB, ${packages.length} packages) and ${path.relative(ROOT, LICENSE_OUT)}.`);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
