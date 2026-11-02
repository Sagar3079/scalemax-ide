'use strict';

// Slash commands: "/name arguments" at the start of a message. The app's own (BUILTIN_NAMES) act
// in the window (src/slash-ui.js: /clear, /plan, /model, /mode, /cost, /help) or are turned into
// instructions here in main (/init in lib/project-notes.cjs, /review below; /compact is the
// window's no-tools summary). Custom commands are Markdown files:
//   <project>/.scalemax/commands/*.md   the project's own commands
//   ~/.scalemax/commands/*.md            the user's, in every project
//   .claude/commands/*.md in both places  read too, for projects set up for another coding agent
// A subfolder is a namespace: frontend/component.md is /frontend:component. The file's text is
// the prompt; optional front matter between --- lines says more:
//   description, argument-hint, model, mode (working | coding), allowed-tools
// In the text, $ARGUMENTS is what follows the command and $1 … $9 its words (quotes group words);
// without either, the arguments are added at the end. @path names a file that goes along with
// the message like any @-mention (src/context-ui.js, read through the workspace service).
// A project's command wins over the user's of the same name, .scalemax over .claude, and the
// app's own commands over all of them.
// Files are read through workspace sessions (lib/workspace.cjs), so the usual guards apply: no
// links, no secret files, text only; a command file may have at most 256 KiB.
//
// What a command's front matter may do is deliberately small: `mode` picks Working or Coding,
// `model` a model of the active provider, and `allowed-tools` *limits* the tools offered for that
// reply. Nothing in a command file skips an approval: a project's command is the project's text.

const { MODE_IDS } = require('./modes.cjs');
const { toolMatches } = require('./hooks.cjs');

const BUILTIN_NAMES = Object.freeze(['bug', 'clear', 'compact', 'cost', 'help', 'init', 'mode', 'model', 'plan', 'review']);
const COMMAND_DIRS = Object.freeze([
  Object.freeze({ dir: '.scalemax/commands', origin: '.scalemax' }),
  Object.freeze({ dir: '.claude/commands', origin: '.claude' }),
]);
const SOURCES = Object.freeze(['project', 'user']);
const LIMITS = {
  // Command files per folder (.scalemax/commands of the project, …).
  files: 200,
  // Name parts: the file and at most two folders above it (/a:b:c).
  segments: 3,
  fileBytes: 256 * 1024,
  promptBytes: 512 * 1024,
  descriptionChars: 160,
  hintChars: 80,
  allowedTools: 64,
  toolChars: 200,
  // The diff /review hands the model.
  diffBytes: 200 * 1024,
  statusFiles: 200,
};
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}(?::[A-Za-z0-9][A-Za-z0-9_.-]{0,63}){0,2}$/;
const REVIEW_COMMAND = /^\/review(?=\s|$)/i;

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function oneLine(text, chars) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > chars ? `${value.slice(0, chars - 1)}…` : value;
}

// ---- Front matter --------------------------------------------------------------------------

// A value as written: quotes taken off ("…" understands \" and \\, '…' understands ''), and a
// trailing # comment dropped.
function unquote(raw) {
  const value = String(raw).trim();
  const double = /^"((?:[^"\\]|\\.)*)"(?:\s+#.*)?$/.exec(value);
  if (double) return double[1].replace(/\\(["\\])/g, '$1');
  const single = /^'((?:[^']|'')*)'(?:\s+#.*)?$/.exec(value);
  if (single) return single[1].replace(/''/g, "'");
  return value.replace(/\s+#.*$/, '').trim();
}

// "a, b(c, d), 'e, f'" → ["a", "b(c, d)", "e, f"]: commas inside quotes or parentheses stay.
function splitList(text) {
  const items = [];
  let current = '';
  let quote = '';
  let depth = 0;
  for (const char of String(text)) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '[') depth += 1;
    else if ((char === ')' || char === ']') && depth > 0) depth -= 1;
    else if (char === ',' && depth === 0) {
      items.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  items.push(current);
  return items.map(unquote).filter(Boolean);
}

/**
 * Splits a little YAML-like front matter off a Markdown file: `key: value` lines (quotes and a
 * trailing # comment taken off; "[a, b]" stays text, see commandFromFile) and `- item` lists under
 * a `key:` line. Keys are lower case. Anything else in it is ignored; a file without front matter
 * is all body.
 * @returns {{ data: Object<string, string|string[]>, body: string }}
 */
function parseFrontMatter(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const match = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) return { data: {}, body: source };
  const data = Object.create(null);
  let listKey = '';
  for (const raw of (match[1] || '').split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const item = /^\s*-\s+(.*)$/.exec(raw);
    if (item && listKey) {
      const value = unquote(item[1]);
      if (value) data[listKey].push(value);
      continue;
    }
    const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(raw);
    if (!pair) {
      listKey = '';
      continue;
    }
    const key = pair[1].toLowerCase();
    const value = pair[2].trim();
    if (['__proto__', 'constructor', 'prototype'].includes(key)) {
      listKey = '';
      continue;
    }
    if (!value) {
      // A list may follow on the next lines.
      data[key] = [];
      listKey = key;
      continue;
    }
    listKey = '';
    data[key] = unquote(value);
  }
  return { data: { ...data }, body: source.slice(match[0].length) };
}

// ---- Arguments -----------------------------------------------------------------------------

/** The words of a command's arguments: split at spaces, "double" or 'single' quotes group words. */
function splitArguments(text) {
  const words = [];
  let current = '';
  let quote = '';
  let started = false;
  for (const char of String(text ?? '')) {
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}

/**
 * The prompt a command's text becomes: $ARGUMENTS is the whole argument text, $1 … $9 its words
 * ('' when there are fewer). A text that uses neither gets the arguments added at its end.
 */
function expandCommand(body, argumentText = '') {
  const args = String(argumentText ?? '').trim();
  const words = splitArguments(args);
  let used = false;
  const text = String(body ?? '').replace(/\$(ARGUMENTS|[1-9])/g, (_match, key) => {
    used = true;
    return key === 'ARGUMENTS' ? args : (words[Number(key) - 1] ?? '');
  });
  if (!used && args) return `${text.replace(/\s+$/, '')}\n\nARGUMENTS: ${args}`;
  return text;
}

// ---- Loading -------------------------------------------------------------------------------

/** One command from its file: its name, what the front matter says, and its text. */
function commandFromFile(name, file, content) {
  const { data, body } = parseFrontMatter(content);
  const text = (value, chars) => (typeof value === 'string' ? oneLine(value, chars) : '');
  // Without a description, the first line of the text says what it is (a heading's # left off).
  const firstLine = body.split(/\r?\n/).map((line) => line.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
  const mode = typeof data.mode === 'string' && MODE_IDS.includes(data.mode.trim().toLowerCase()) ? data.mode.trim().toLowerCase() : '';
  const model = typeof data.model === 'string' && data.model.trim() && Buffer.byteLength(data.model.trim()) <= 256
    && !/[\x00-\x1f\x7f]/.test(data.model) ? data.model.trim() : '';
  // "a, b", "[a, b]" or a "- a" list.
  const rawTools = data['allowed-tools'];
  const tools = Array.isArray(rawTools) ? rawTools : typeof rawTools === 'string' ? splitList(rawTools.replace(/^\[(.*)\]$/s, '$1')) : [];
  return {
    name,
    file,
    description: text(data.description, LIMITS.descriptionChars) || oneLine(firstLine, LIMITS.descriptionChars),
    argumentHint: text(data['argument-hint'], LIMITS.hintChars),
    mode,
    model,
    allowedTools: [...new Set(tools.filter((tool) => typeof tool === 'string' && tool.trim() && tool.length <= LIMITS.toolChars).map((tool) => tool.trim()))].slice(0, LIMITS.allowedTools),
    body,
  };
}

/** The command files under `dir` of a workspace session, folders as namespaces. */
async function commandFiles(workspace, dir, errors) {
  const files = [];
  const queue = [{ path: dir, segments: [] }];
  while (queue.length && files.length < LIMITS.files) {
    const folder = queue.shift();
    let listing;
    try {
      listing = await workspace.list(folder.path);
    } catch (error) {
      // No commands folder at all is the usual case, not a problem.
      if (folder.path !== dir) errors.push(`${folder.path}: ${oneLine(error?.message || 'could not be listed', 160)}`);
      continue;
    }
    for (const entry of listing.entries) {
      if (files.length >= LIMITS.files) break;
      if (entry.type === 'directory') {
        if (folder.segments.length + 1 < LIMITS.segments && SEGMENT.test(entry.name)) queue.push({ path: entry.path, segments: [...folder.segments, entry.name] });
        continue;
      }
      if (!/\.md$/i.test(entry.name)) continue;
      const stem = entry.name.slice(0, -3);
      if (!SEGMENT.test(stem)) continue;
      let file;
      try {
        file = await workspace.read(entry.path);
      } catch (error) {
        errors.push(`${entry.path}: ${oneLine(error?.message || 'could not be read', 160)}`);
        continue;
      }
      if (Buffer.byteLength(file.content) > LIMITS.fileBytes) {
        errors.push(`${entry.path}: a command file may have at most 256 KiB.`);
        continue;
      }
      files.push(commandFromFile([...folder.segments, stem].join(':'), entry.path, file.content));
    }
  }
  return files;
}

/**
 * The custom commands of a project and of the user. `project` and `user` are workspace sessions on
 * the project folder and the home folder (either may be null); the project counts only when it is
 * not the home folder itself.
 * @returns {Promise<{ commands: object[], errors: string[] }>} commands sorted by name, each with
 *   { name, description, argumentHint, source: 'project'|'user', origin: '.scalemax'|'.claude',
 *   file, mode, model, allowedTools, body }
 */
async function loadCommands({ project = null, user = null } = {}) {
  const projectRoot = project?.current?.()?.path || '';
  const homeRoot = user?.current?.()?.path || '';
  const found = new Map();
  const errors = [];
  const roots = [];
  if (projectRoot && projectRoot !== homeRoot) roots.push(['project', project]);
  if (homeRoot) roots.push(['user', user]);
  for (const [source, workspace] of roots) {
    for (const { dir, origin } of COMMAND_DIRS) {
      for (const command of await commandFiles(workspace, dir, errors)) {
        const key = command.name.toLowerCase();
        // The first one found wins: project before user, .scalemax before .claude.
        if (BUILTIN_NAMES.includes(key) || found.has(key)) continue;
        found.set(key, { ...command, source, origin });
      }
    }
  }
  return { commands: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)), errors: errors.slice(0, 50) };
}

/** What the window gets of a command (never its file's text). */
function publicCommand(command) {
  return { name: command.name, description: command.description, argumentHint: command.argumentHint, source: command.source };
}

/** The command called `name` (any letter case), or null. */
function findCommand(commands, name) {
  if (typeof name !== 'string' || !NAME.test(name)) return null;
  const key = name.toLowerCase();
  return (Array.isArray(commands) ? commands : []).find((command) => command.name.toLowerCase() === key) || null;
}

/** True for a valid command name ("fix", "frontend:component"). */
function validName(name) {
  return typeof name === 'string' && NAME.test(name);
}

/** The prompt a custom command becomes with these arguments; refused when it grows too large. */
function commandPrompt(command, argumentText = '') {
  const prompt = expandCommand(command.body, argumentText).trim();
  if (!prompt) throw fail('EMPTY_COMMAND', `/${command.name} has no text to send.`);
  if (Buffer.byteLength(prompt) > LIMITS.promptBytes) throw fail('COMMAND_TOO_LARGE', `/${command.name} grew larger than 512 KiB with these arguments.`);
  return prompt;
}

/**
 * The model a command asks for, as the active provider names it (its id or its display name, any
 * letter case). A provider with a model list must offer it for chat; one without a list (a custom
 * endpoint) takes the name as written. Throws COMMAND_MODEL with what to do otherwise.
 */
function commandModel(value, provider) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const models = Array.isArray(provider?.models) ? provider.models : [];
  const wanted = value.trim().toLowerCase();
  const entry = models.find((model) => typeof model?.id === 'string'
    && (model.id.toLowerCase() === wanted || (typeof model.displayName === 'string' && model.displayName.toLowerCase() === wanted)));
  if (entry) {
    if (entry.chat === false || entry.available === false) throw fail('COMMAND_MODEL', `This command asks for ${entry.displayName || entry.id}, which cannot answer chat messages right now. Change "model:" in the command file, or remove it.`);
    return entry.id;
  }
  if (provider?.kind === 'scalemax' || models.length) {
    throw fail('COMMAND_MODEL', `This command asks for the model "${oneLine(value, 80)}", which the active provider does not offer. Change "model:" in the command file, or remove it.`);
  }
  return value.trim();
}

/**
 * The reply's tool source limited to a command's `allowed-tools`: only the tools whose names (as
 * the model sees them: workspace_read, web_search, …) one of them matches, exactly or as a regular
 * expression. Names that match none of the offered tools (another agent's tool names) are ignored,
 * so a list that names nothing here limits nothing. It never allows anything without its usual
 * approval.
 */
function limitTools(source, patterns) {
  const allowed = (Array.isArray(patterns) ? patterns : []).filter((pattern) => typeof pattern === 'string' && pattern.trim());
  if (!allowed.length || !source || typeof source.chatTools !== 'function') return source;
  const permitted = (name) => typeof name === 'string' && allowed.some((pattern) => toolMatches(pattern, [name]));
  const limited = {
    async chatTools(options) {
      const catalog = await source.chatTools(options);
      const tools = Array.isArray(catalog?.tools) ? catalog.tools : [];
      const kept = tools.filter((tool) => permitted(tool?.function?.name));
      if (!kept.length) return catalog;
      const resolve = typeof catalog?.resolve === 'function' ? catalog.resolve : () => null;
      return { ...catalog, tools: kept, resolve: (name) => (permitted(name) ? resolve(name) : null) };
    },
    callTool: (input, context) => source.callTool(input, context),
  };
  if (typeof source.describeCall === 'function') limited.describeCall = (target, args) => source.describeCall(target, args);
  return limited;
}

// ---- /review -------------------------------------------------------------------------------

/** True for a message that starts with the /review command. */
function isReviewCommand(text) {
  return typeof text === 'string' && REVIEW_COMMAND.test(text.trimStart());
}

/** What the user wrote after /review (what to focus on), or ''. */
function reviewFocus(text) {
  return typeof text === 'string' ? text.trimStart().replace(REVIEW_COMMAND, '').trim() : '';
}

// A fence longer than any run of ~ at the start of a line in `text`.
function fenceFor(text) {
  let longest = 2;
  for (const match of String(text).matchAll(/^(~{3,})/gm)) longest = Math.max(longest, match[1].length);
  return '~'.repeat(longest + 1);
}

/**
 * The instruction /review becomes (main sends it in Plan permission, so nothing can change):
 * the changed files from `git status`, the unstaged diff (secret files never in it: the workspace
 * service lists the paths first), and how to report.
 * @param {{ focus?: string, status?: {isRepo: boolean, files: Array<{status: string, path: string}>}|null, diff?: string,
 *   error?: string, diffError?: string }} input  error: Git could not be read; diffError: only the diff could not
 */
function reviewPrompt({ focus = '', status = null, diff = '', error = '', diffError = '' } = {}) {
  const lines = [
    '/review: review the uncommitted changes in this folder, the way a careful code reviewer would.',
    'This reply is read-only: read files and search with the workspace tools for context, but nothing can be changed in it, so do not try to edit or run anything.',
    'Answer with the problems that matter first (bugs, security issues, lost data, broken or missing tests, unhandled errors), each with its file and line and why it matters; then smaller suggestions (naming, clarity, duplication); then say plainly whether the change looks ready. Do not repeat the diff back.',
  ];
  if (focus) lines.push('', `What the user asked you to focus on: ${focus}`);
  lines.push('');
  if (error) {
    lines.push(`ScaleMax could not read the Git changes here: ${oneLine(error, 300)} Say so, and offer to review files the user names instead.`);
    return lines.join('\n');
  }
  if (!status?.isRepo) {
    lines.push('This folder is not the root of a Git repository, so there are no uncommitted changes to review. Say so, and offer to review files the user names instead.');
    return lines.join('\n');
  }
  const files = Array.isArray(status.files) ? status.files : [];
  if (!files.length) {
    lines.push('Git reports no uncommitted changes in this folder. Say so.');
    return lines.join('\n');
  }
  const shown = files.slice(0, LIMITS.statusFiles).map((file) => `${file.status} ${file.path}`);
  if (files.length > shown.length) shown.push(`… and ${files.length - shown.length} more`);
  lines.push('Changed files (git status: the first letter is the staged change, the second the unstaged one, ?? a new file):', ...shown, '');
  let text = String(diff || '');
  let cut = '';
  if (Buffer.byteLength(text) > LIMITS.diffBytes) {
    const buffer = Buffer.from(text, 'utf8');
    let end = LIMITS.diffBytes;
    while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
    text = buffer.subarray(0, end).toString('utf8');
    cut = '\n[The diff was shortened here; read the remaining files with workspace_read.]';
  }
  if (diffError) {
    lines.push(`The diff could not be read (${oneLine(diffError, 200)}): read the changed files with workspace_read.`);
  } else if (text.trim()) {
    const fence = fenceFor(text);
    lines.push('Unstaged changes (git diff):', `${fence}diff`, text.replace(/\s+$/, ''), fence + cut);
  } else {
    lines.push('There are no unstaged changes to show as a diff.');
  }
  lines.push('Staged changes and new files are not in this diff: read those files with workspace_read.');
  return lines.join('\n');
}

/**
 * The Git changes /review shows, through a workspace session on the folder (its guards keep secret
 * files out of the diff). Never throws: what could not be read is said in `error` / `diffError`.
 */
async function reviewChanges(workspace) {
  if (!workspace?.current?.()) return { status: { isRepo: false, files: [] } };
  let status;
  try {
    status = await workspace.gitStatus();
  } catch (error) {
    return { error: error?.message || 'Git could not be read.' };
  }
  if (!status?.isRepo || !status.files?.length) return { status };
  try {
    return { status, diff: await workspace.gitDiff('') };
  } catch (error) {
    return { status, diffError: error?.message || 'unknown error' };
  }
}

/** The request with its last user message, "/review …", turned into the review instruction. */
function withReview(input, changes) {
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || !isReviewCommand(last.content)) return input;
  const content = reviewPrompt({ focus: reviewFocus(last.content), ...changes });
  return { ...input, messages: [...messages.slice(0, -1), { ...last, content }] };
}

module.exports = {
  BUILTIN_NAMES, COMMAND_DIRS, SOURCES, LIMITS,
  parseFrontMatter, splitArguments, expandCommand, commandFromFile, loadCommands, publicCommand, findCommand, validName,
  commandPrompt, commandModel, limitTools, isReviewCommand, reviewFocus, reviewPrompt, reviewChanges, withReview,
};
