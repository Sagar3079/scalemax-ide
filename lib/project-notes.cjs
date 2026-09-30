'use strict';

// Project notes for the open folder, like CLAUDE.md, AGENTS.md or Kiro steering files in other
// coding agents: `.scalemax/SCALEMAX.md`. ScaleMax creates it on the first chat message in a
// folder that has none, from a quick scan (overview, stack, commands, structure), and reads it
// into the instructions of every chat in that folder, together with instruction files other
// agents may have left there (AGENTS.md, CLAUDE.md, .kiro/steering/*.md, ...) and a short live
// snapshot (top-level entries, Git branch and changes). `/init` asks the model to rewrite the
// notes after reading the project. Everything goes through the workspace service, so its guards
// apply unchanged: relative paths only, no links, no secret files, 1 MiB files.

const NOTES_PATH = '.scalemax/SCALEMAX.md';
// Instruction files of other coding agents, read when present (never created).
const OTHER_INSTRUCTIONS = ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md', '.cursorrules', '.windsurfrules'];
const STEERING_DIR = '.kiro/steering';
const LIMITS = {
  notesBytes: 24 * 1024,
  otherBytes: 12 * 1024,
  otherTotalBytes: 32 * 1024,
  steeringFiles: 8,
  topEntries: 60,
  gitFiles: 20,
  scanFolders: 12,
  folderPreview: 5,
  structureEntries: 40,
  readmeChars: 700,
  scripts: 12,
  dependencies: 12,
};

const INIT_PROMPT = [
  '/init: write the ScaleMax project notes for this folder.',
  `1. Explore the project with the workspace tools: list the top level and the main source folders, read the README, the manifest and config files (package.json, pyproject.toml, Cargo.toml, go.mod, Makefile, ...) and a few central source files. Read the current ${NOTES_PATH} too.`,
  `2. Replace ${NOTES_PATH} with workspace_write. Include: a two or three sentence overview of what the project is; the tech stack; the exact commands to install, run, build, test and lint; the structure (main folders and what they hold); conventions visible in the code (style, patterns, naming, testing); anything surprising a newcomer should know. Keep the section headings "Overview", "Tech stack", "Commands", "Structure" and "Conventions and notes", keep anything the user wrote there before, stay under 150 lines, and only write facts you checked in the files.`,
  '3. Reply with a short summary of what you wrote.',
].join('\n');

const NO_FOLDER_INIT = 'The user typed /init, which writes ScaleMax project notes (.scalemax/SCALEMAX.md) for the open folder, but no folder is open. Tell them to open their project with the folder button in the message box first, then run /init again.';

// /init in a reply that may not change anything (Plan permission).
const NO_CHANGE_INIT = 'The user typed /init, which writes ScaleMax project notes (.scalemax/SCALEMAX.md) for this folder. This reply cannot change anything, so the notes cannot be written now. Say that briefly, say that the permission needs to be Manual, Basic or Bypass for /init, and offer to summarize the project here instead.';

// Common libraries worth naming in the stack line, by package name.
const NODE_LIBRARIES = [
  ['next', 'Next.js'], ['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['@angular/core', 'Angular'],
  ['solid-js', 'Solid'], ['astro', 'Astro'], ['@remix-run/react', 'Remix'], ['nuxt', 'Nuxt'], ['electron', 'Electron'],
  ['express', 'Express'], ['fastify', 'Fastify'], ['koa', 'Koa'], ['@nestjs/core', 'NestJS'], ['hono', 'Hono'],
  ['vite', 'Vite'], ['webpack', 'webpack'], ['typescript', 'TypeScript'], ['tailwindcss', 'Tailwind CSS'],
  ['prisma', 'Prisma'], ['drizzle-orm', 'Drizzle'], ['mongoose', 'Mongoose'], ['jest', 'Jest'], ['vitest', 'Vitest'],
  ['mocha', 'Mocha'], ['@playwright/test', 'Playwright'], ['playwright', 'Playwright'], ['cypress', 'Cypress'],
  ['eslint', 'ESLint'], ['prettier', 'Prettier'], ['react-native', 'React Native'], ['expo', 'Expo'],
];

function isMissing(error) {
  return error?.code === 'ENOENT' || error?.code === 'NO_WORKSPACE';
}

async function readOptional(workspace, relative) {
  try {
    return (await workspace.read(relative)).content;
  } catch {
    return null; // missing, binary, too large, a secret path or a folder
  }
}

async function listOptional(workspace, relative) {
  try {
    return (await workspace.list(relative)).entries;
  } catch {
    return null;
  }
}

function parseJson(text) {
  if (typeof text !== 'string') return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function oneLine(text, chars) {
  const value = String(text).replace(/\s+/g, ' ').trim();
  return value.length > chars ? `${value.slice(0, chars - 1)}…` : value;
}

/** Cuts text to a byte budget on a character boundary and says where the rest is. */
function clipBytes(text, maxBytes, source) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let cut = text.slice(0, maxBytes);
  while (Buffer.byteLength(cut) > maxBytes) cut = cut.slice(0, -1);
  return `${cut}\n[… cut here; read ${source} for the rest]`;
}

/** Splits `---` front matter off a Markdown file (Kiro steering files use it). */
function frontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { data: {}, body: text };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (pair) data[pair[1].toLowerCase()] = pair[2].trim().replace(/^["']|["']$/g, '');
  }
  return { data, body: text.slice(match[0].length) };
}

/** The first real paragraph of a README (no headings, badges, HTML or front matter). */
function firstParagraph(markdown) {
  const lines = frontMatter(markdown).body.split(/\r?\n/);
  const paragraph = [];
  let fenced = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('```')) { fenced = !fenced; if (paragraph.length) break; continue; }
    if (fenced) continue;
    if (!line) { if (paragraph.length) break; continue; }
    if (/^(#|!\[|\[!\[|<|>|\||---|===|- \[)/.test(line)) { if (paragraph.length) break; continue; }
    paragraph.push(line);
  }
  return paragraph.length ? oneLine(paragraph.join(' '), LIMITS.readmeChars) : '';
}

function extensionOf(name) {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return match && !name.startsWith('.') ? `.${match[1].toLowerCase()}` : null;
}

function describeFolder(children) {
  const files = children.filter((entry) => entry.type === 'file').length;
  const folders = children.length - files;
  const counts = [];
  if (files) counts.push(`${files} file${files === 1 ? '' : 's'}`);
  if (folders) counts.push(`${folders} folder${folders === 1 ? '' : 's'}`);
  if (!counts.length) return 'empty';
  const preview = children.slice(0, LIMITS.folderPreview).map((entry) => (entry.type === 'directory' ? `${entry.name}/` : entry.name));
  const more = children.length > preview.length ? ', …' : '';
  return `${counts.join(', ')} (${preview.join(', ')}${more})`;
}

/** Reads the folder and returns what the notes say about stack, commands and structure. */
async function scanFolder(workspace) {
  const open = workspace.current();
  const top = (await workspace.list('')).entries;
  const names = new Set(top.map((entry) => entry.name));
  const has = (name) => names.has(name);
  const read = (name) => (has(name) ? readOptional(workspace, name) : Promise.resolve(null));
  const stack = [];
  const commands = [];
  let overview = '';

  const readme = top.find((entry) => entry.type === 'file' && /^readme(\.(md|markdown|txt|rst))?$/i.test(entry.name));
  if (readme) overview = firstParagraph((await readOptional(workspace, readme.name)) || '');

  const pkg = parseJson(await read('package.json'));
  if (pkg) {
    const runner = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : (has('bun.lockb') || has('bun.lock')) ? 'bun' : 'npm';
    const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
    const name = typeof pkg.name === 'string' ? ` \`${oneLine(pkg.name, 80)}\`` : '';
    stack.push(`Node.js package${name} (package.json, ${runner})`);
    const libraries = [...new Set(NODE_LIBRARIES.filter(([id]) => deps.includes(id)).map(([, label]) => label))];
    if (libraries.length) stack.push(`Libraries: ${libraries.join(', ')}`);
    else if (deps.length) stack.push(`Dependencies: ${deps.slice(0, LIMITS.dependencies).join(', ')}${deps.length > LIMITS.dependencies ? ', …' : ''}`);
    commands.push(`\`${runner} install\` — install dependencies`);
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? Object.entries(pkg.scripts) : [];
    for (const [script, command] of scripts.slice(0, LIMITS.scripts)) {
      if (typeof command !== 'string') continue;
      const run = runner === 'npm' ? (['start', 'test'].includes(script) ? `npm ${script}` : `npm run ${script}`) : `${runner} ${script}`;
      commands.push(`\`${run}\` — runs \`${oneLine(command, 120)}\``);
    }
    if (!overview && typeof pkg.description === 'string') overview = oneLine(pkg.description, LIMITS.readmeChars);
  }
  if (has('tsconfig.json') && !stack.some((line) => line.includes('TypeScript'))) stack.push('TypeScript (tsconfig.json)');

  const pyproject = await read('pyproject.toml');
  if (pyproject !== null) {
    const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1];
    stack.push(`Python project${name ? ` \`${oneLine(name, 80)}\`` : ''} (pyproject.toml${has('poetry.lock') ? ', Poetry' : has('uv.lock') ? ', uv' : ''})`);
    commands.push(has('poetry.lock') ? '`poetry install` — install dependencies' : has('uv.lock') ? '`uv sync` — install dependencies' : '`pip install -e .` — install the project');
    if (!overview) {
      const description = /^\s*description\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1];
      if (description) overview = oneLine(description, LIMITS.readmeChars);
    }
  }
  const requirements = await read('requirements.txt');
  if (requirements !== null) {
    const packages = requirements.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && !line.startsWith('-'))
      .map((line) => line.split(/[<>=!~;\[ ]/)[0]).filter(Boolean);
    if (pyproject === null) stack.push('Python (requirements.txt)');
    if (packages.length) stack.push(`Python packages: ${packages.slice(0, LIMITS.dependencies).join(', ')}${packages.length > LIMITS.dependencies ? ', …' : ''}`);
    commands.push('`pip install -r requirements.txt` — install dependencies');
  }
  if ((pyproject !== null || requirements !== null) && (has('tests') || has('test') || has('pytest.ini'))) commands.push('`pytest` — run the tests');

  const cargo = await read('Cargo.toml');
  if (cargo !== null) {
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
    stack.push(`Rust crate${name ? ` \`${oneLine(name, 80)}\`` : ''} (Cargo.toml)`);
    commands.push('`cargo build` — build', '`cargo test` — run the tests', '`cargo run` — run');
  }
  const gomod = await read('go.mod');
  if (gomod !== null) {
    const module = /^module\s+(\S+)/m.exec(gomod)?.[1];
    stack.push(`Go module${module ? ` \`${oneLine(module, 120)}\`` : ''} (go.mod)`);
    commands.push('`go build ./...` — build', '`go test ./...` — run the tests');
  }
  if (has('pom.xml')) { stack.push('Java (Maven, pom.xml)'); commands.push('`mvn package` — build', '`mvn test` — run the tests'); }
  if (has('build.gradle') || has('build.gradle.kts')) {
    const gradle = has('gradlew') ? './gradlew' : 'gradle';
    stack.push('JVM (Gradle)');
    commands.push(`\`${gradle} build\` — build`, `\`${gradle} test\` — run the tests`);
  }
  if (has('Gemfile')) { stack.push('Ruby (Gemfile)'); commands.push('`bundle install` — install dependencies'); }
  if (has('composer.json')) { stack.push('PHP (composer.json)'); commands.push('`composer install` — install dependencies'); }
  if (top.some((entry) => /\.(sln|csproj|fsproj)$/i.test(entry.name))) { stack.push('.NET'); commands.push('`dotnet build` — build', '`dotnet test` — run the tests'); }
  if (has('Package.swift')) { stack.push('Swift package (Package.swift)'); commands.push('`swift build` — build', '`swift test` — run the tests'); }
  if (has('pubspec.yaml')) { stack.push('Dart / Flutter (pubspec.yaml)'); commands.push('`flutter pub get` — install dependencies'); }
  const makefile = await read('Makefile');
  if (makefile !== null) {
    const targets = [...makefile.matchAll(/^([A-Za-z0-9][\w.-]*)\s*:(?!=)/gm)].map((match) => match[1]).filter((target, index, all) => all.indexOf(target) === index);
    for (const target of targets.slice(0, 8)) commands.push(`\`make ${target}\``);
  }
  if (has('Dockerfile')) stack.push('Docker (Dockerfile)');
  if (has('docker-compose.yml') || has('docker-compose.yaml') || has('compose.yaml') || has('compose.yml')) commands.push('`docker compose up` — start the services');
  if (!pkg && has('index.html')) stack.push('Static website (index.html)');

  // Structure: every top-level entry, with a peek into the first folders.
  const structure = [];
  const extensions = new Map();
  const count = (entry) => {
    const ext = entry.type === 'file' ? extensionOf(entry.name) : null;
    if (ext) extensions.set(ext, (extensions.get(ext) || 0) + 1);
  };
  let peeked = 0;
  for (const entry of top.slice(0, LIMITS.structureEntries)) {
    count(entry);
    if (entry.type === 'directory' && peeked < LIMITS.scanFolders) {
      peeked += 1;
      const children = (await listOptional(workspace, entry.path)) || [];
      children.forEach(count);
      structure.push(`\`${entry.name}/\` — ${describeFolder(children)}`);
    } else {
      structure.push(entry.type === 'directory' ? `\`${entry.name}/\`` : `\`${entry.name}\``);
    }
  }
  if (top.length > LIMITS.structureEntries) structure.push(`… and ${top.length - LIMITS.structureEntries} more entries`);
  const types = [...extensions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([ext, n]) => `${n} ${ext}`);
  if (types.length && !stack.length) stack.push(`Files: ${types.join(', ')}`);

  try {
    const git = await workspace.gitStatus();
    if (git?.isRepo) stack.push(`Git repository (branch \`${oneLine(git.branch || 'unknown', 80)}\`)`);
  } catch { /* Git missing or failing is not worth a note */ }

  return { name: open.name, empty: top.length === 0, overview, stack, commands, structure };
}

function renderNotes(scan, date) {
  const list = (items, fallback) => (items.length ? items.map((item) => `- ${item}`).join('\n') : `- ${fallback}`);
  const overview = scan.empty
    ? 'This folder was empty when ScaleMax first opened it. Describe the project here once it takes shape.'
    : scan.overview || 'Not written yet. Describe what this project is and who it is for, or type /init in chat to have ScaleMax write it.';
  return [
    `# ${scan.name}`,
    '',
    '> ScaleMax project notes. ScaleMax reads this file at the start of every chat in this folder (like CLAUDE.md or AGENTS.md in other coding tools). Keep it short and true; edit it any time, or type /init in chat to have ScaleMax rewrite it after reading the project.',
    '',
    '## Overview',
    overview,
    '',
    '## Tech stack',
    list(scan.stack, scan.empty ? 'Nothing yet.' : 'Not detected; add it here.'),
    '',
    '## Commands',
    list(scan.commands, scan.empty ? 'None yet.' : 'None found (no package.json, Makefile or similar); add the ones you use.'),
    '',
    '## Structure',
    list(scan.structure, 'Empty.'),
    '',
    '## Conventions and notes',
    '- Add coding conventions, decisions and anything ScaleMax should remember about this project.',
    '',
    `_Created by ScaleMax on ${date} from a scan of the folder._`,
    '',
  ].join('\n');
}

/**
 * @param {{ getWorkspace: () => object|null, now?: () => Date }} options
 *   getWorkspace returns the workspace service (lib/workspace.cjs) the chat tools use.
 */
function createProjectNotes({ getWorkspace, now = () => new Date() } = {}) {
  if (typeof getWorkspace !== 'function') throw new TypeError('getWorkspace is required.');
  // One creation at a time per folder, so two quick messages cannot race.
  const creating = new Map();

  function open() {
    try {
      const workspace = getWorkspace();
      return workspace && workspace.current() ? workspace : null;
    } catch {
      return null;
    }
  }

  /**
   * Creates the notes when the open folder has none. Never overwrites and never throws. Only
   * the request that started the creation reports `created: true`; one that arrives while it
   * runs waits for it and reports `created: false`.
   */
  async function ensure() {
    const workspace = open();
    if (!workspace) return { created: false };
    const root = workspace.current().path;
    if (creating.has(root)) return { ...(await creating.get(root)), created: false };
    const run = (async () => {
      try {
        await workspace.read(NOTES_PATH);
        return { created: false, path: NOTES_PATH };
      } catch (error) {
        if (!isMissing(error)) return { created: false, path: NOTES_PATH, error: error.message };
      }
      try {
        const content = renderNotes(await scanFolder(workspace), now().toISOString().slice(0, 10));
        await workspace.create({ path: NOTES_PATH, content });
        return { created: true, path: NOTES_PATH };
      } catch (error) {
        return { created: false, path: NOTES_PATH, error: error.message };
      }
    })();
    creating.set(root, run);
    try {
      return await run;
    } finally {
      creating.delete(root);
    }
  }

  /** The project context block for the chat instructions ('' without an open folder). */
  async function context() {
    const workspace = open();
    if (!workspace) return '';
    const folder = workspace.current();
    const parts = [];
    const notes = await readOptional(workspace, NOTES_PATH);
    if (notes !== null && notes.trim()) {
      parts.push(`## Project notes (${NOTES_PATH})\n${clipBytes(notes.trim(), LIMITS.notesBytes, NOTES_PATH)}`);
    } else {
      parts.push(`## Project notes\nThis folder has no ${NOTES_PATH} yet. If the user asks you to remember something about the project, create it.`);
    }
    let budget = LIMITS.otherTotalBytes;
    const addInstructions = (source, text) => {
      if (budget <= 0 || !text || !text.trim()) return;
      const clipped = clipBytes(text.trim(), Math.min(LIMITS.otherBytes, budget), source);
      budget -= Buffer.byteLength(clipped);
      parts.push(`## Project instructions from ${source}\n${clipped}`);
    };
    for (const source of OTHER_INSTRUCTIONS) addInstructions(source, await readOptional(workspace, source));
    const steering = (await listOptional(workspace, STEERING_DIR)) || [];
    for (const entry of steering.filter((item) => item.type === 'file' && /\.md$/i.test(item.name)).slice(0, LIMITS.steeringFiles)) {
      const text = await readOptional(workspace, entry.path);
      if (text === null) continue;
      const { data, body } = frontMatter(text);
      // Kiro loads "manual" and "fileMatch" steering only on request; only always-on files belong here.
      if (data.inclusion && data.inclusion.toLowerCase() !== 'always') continue;
      addInstructions(entry.path, body);
    }
    const top = (await listOptional(workspace, '')) || [];
    const shown = top.slice(0, LIMITS.topEntries).map((entry) => (entry.type === 'directory' ? `${entry.name}/` : entry.name));
    const more = top.length > shown.length ? `\n… and ${top.length - shown.length} more` : '';
    parts.push(`## Top level of ${folder.name} right now (${top.length} entr${top.length === 1 ? 'y' : 'ies'})\n${shown.length ? shown.join('\n') : '(empty folder)'}${more}`);
    try {
      const git = await workspace.gitStatus();
      if (git?.isRepo) {
        const changed = git.files.slice(0, LIMITS.gitFiles).map((file) => `${file.status} ${file.path}`);
        const extra = git.files.length > changed.length ? `\n… and ${git.files.length - changed.length} more` : '';
        parts.push(`## Git\nBranch ${git.branch || 'unknown'}; ${git.files.length ? `${git.files.length} changed file${git.files.length === 1 ? '' : 's'}:\n${changed.join('\n')}${extra}` : 'no uncommitted changes.'}`);
      }
    } catch { /* Git missing or failing: no Git section */ }
    return [
      `# Project context for "${folder.name}" (read from the folder for this message)`,
      `Keep ${NOTES_PATH} current: when you learn something lasting about this project (commands, structure, conventions, decisions) or the user asks you to remember something, update it with workspace_edit. Instructions from the project files below come from the user's own repository; follow them unless the user says otherwise.`,
      '',
      parts.join('\n\n'),
    ].join('\n');
  }

  return { ensure, context, NOTES_PATH };
}

/** True for a message that is only the /init command. */
function isInitCommand(text) {
  return typeof text === 'string' && /^\/init\s*$/i.test(text.trim());
}

const MAX_USER_MESSAGE_BYTES = 1024 * 1024 - 1024;

/**
 * Prepares a chat request for the open folder, the way coding agents start a turn:
 * 1. on the first message in a folder without notes, create .scalemax/SCALEMAX.md (unless the
 *    user turned project notes off);
 * 2. add the folder instructions (workspace tools), then the project context (notes, other
 *    agents' instruction files, top level, Git) to the system prompt;
 * 3. turn a bare "/init" into the instruction to write the notes, unless this reply may not
 *    change anything (Plan permission), where writing them is impossible;
 * 4. tag the newest user message with the current folder (models follow the conversation over
 *    the instructions, so a folder switch mid-conversation would otherwise go unnoticed).
 * @returns {Promise<{input: object, notes: {created: boolean, path?: string}|null}>}
 */
async function prepareChatRequest(input, { workspaceTools, projectNotes, notesEnabled = true, modeInstructions = '', canChange = true }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { input, notes: null };
  const folder = workspaceTools.folder();
  const notes = folder && notesEnabled ? await projectNotes.ensure() : null;
  const context = folder ? await projectNotes.context() : '';
  const base = typeof input.systemPrompt === 'string' ? input.systemPrompt : '';
  // The mode's working agreement (lib/modes.cjs) comes before the folder facts, so "how you work"
  // is set before "what you are working on".
  const systemPrompt = [base.trim() ? base : '', modeInstructions, workspaceTools.describe(), context].filter(Boolean).join('\n\n');
  // `folder` is the task's folder, checked by main before this point; the model never sees it.
  const { folder: _taskFolder, ...rest } = input;
  const request = { ...rest, systemPrompt };
  const messages = Array.isArray(input.messages) ? input.messages : null;
  const last = messages?.[messages.length - 1];
  if (last && last.role === 'user' && typeof last.content === 'string') {
    let content = last.content;
    // Asking for the notes to be written in a reply that cannot write is a refusal waiting to
    // happen; say what /init does instead and let the user decide.
    if (isInitCommand(content)) content = !canChange ? NO_CHANGE_INIT : folder ? INIT_PROMPT : NO_FOLDER_INIT;
    const marker = workspaceTools.marker();
    if (marker && Buffer.byteLength(content) < MAX_USER_MESSAGE_BYTES) content = `${content}\n\n${marker}`;
    if (content !== last.content) request.messages = [...messages.slice(0, -1), { ...last, content }];
  }
  return { input: request, notes };
}

module.exports = {
  createProjectNotes, prepareChatRequest, isInitCommand, NOTES_PATH, INIT_PROMPT, NO_FOLDER_INIT, NO_CHANGE_INIT,
  firstParagraph, frontMatter, OTHER_INSTRUCTIONS,
};
