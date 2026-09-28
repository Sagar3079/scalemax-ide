'use strict';

// Built-in chat tools for the workspace folder the user opened (lib/workspace.cjs), offered to
// the model next to MCP tools. The tool loop treats them like any other tool under the server id
// "Workspace" (upper case, so it can never clash with an MCP server id): listing, reading and
// searching are read-only and run on their own in Basic mode; writing a file and running a
// command change things, so Basic and Manual ask first and only Bypass runs them directly.
// All file access goes through the workspace service, so its guards apply unchanged:
// project-relative paths only, no symlinks, no secret files (.env, keys, .git, ...), 1 MiB files,
// 30-second commands.

const SERVER_ID = 'Workspace';
// The chat request limit (lib/provider.cjs MAX_TOOLS); MCP tools fill what is left.
const MAX_TOOLS = 128;
const MAX_PATH_CHARS = 1024;
const MAX_QUERY_CHARS = 200;
const READ_PAGE_BYTES = 48 * 1024;
const SEARCH = { folders: 400, files: 2000, matches: 100, timeMs: 10_000, lineChars: 200 };
// run_command time limit in seconds: builds, installs and test suites often need minutes.
const COMMAND_SECONDS = { default: 120, max: 600 };
// Files that are never text; skipping them saves reading up to 1 MiB each while searching.
const BINARY_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|bmp|ico|icns|tiff?|psd|heic|avif|pdf|zip|gz|tgz|bz2|xz|7z|rar|dmg|pkg|iso|jar|class|so|dylib|dll|exe|o|a|wasm|woff2?|ttf|otf|eot|mp3|mp4|m4a|mov|avi|mkv|webm|wav|flac|ogg|sqlite|db|bin|dat)$/i;

const TOOLS = [
  {
    name: 'workspace_list',
    toolName: 'list_files',
    readOnly: true,
    description: 'List the files and folders directly inside one folder of the open workspace (one level). Use path "" for the workspace root.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Folder path relative to the workspace root, with forward slashes. "" or omitted means the root.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_read',
    toolName: 'read_file',
    readOnly: true,
    description: 'Read a UTF-8 text file from the open workspace. Large files are returned in pages; pass start_line/end_line (1-based, inclusive) to read a part.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root, e.g. "src/index.js".' },
        start_line: { type: 'integer', minimum: 1, description: 'First line to return (default 1).' },
        end_line: { type: 'integer', minimum: 1, description: 'Last line to return (default: as much as fits).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_search',
    toolName: 'search',
    readOnly: true,
    description: 'Search file names and text contents in the open workspace for a plain-text query. Returns matching file names and "path:line: text" hits (at most 100).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to look for (not a regular expression).' },
        path: { type: 'string', description: 'Limit the search to this folder (relative to the workspace root). Default: the whole workspace.' },
        case_sensitive: { type: 'boolean', description: 'Match upper and lower case exactly (default false).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_write',
    toolName: 'write_file',
    readOnly: false,
    description: 'Create a text file in the open workspace, or replace the whole content of an existing one (the previous version is backed up). Missing parent folders are created.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        content: { type: 'string', description: 'The complete new file content.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_edit',
    toolName: 'edit_file',
    readOnly: false,
    description: 'Change part of a text file in the open workspace by replacing exact text. old_text must match the file exactly (spaces, indentation and line breaks included) and occur once, unless replace_all is true. Read the file first. The previous version is backed up. Use workspace_write for new files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        old_text: { type: 'string', description: 'The exact text to replace, with enough surrounding lines to be unique.' },
        new_text: { type: 'string', description: 'The text to put in its place.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of exactly one (default false).' },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_run',
    toolName: 'run_command',
    readOnly: false,
    description: 'Run a shell command in the workspace folder (non-interactive, 1 MiB output) and return its exit code and output. The command stops after timeout_seconds (default 120, at most 600): give installs, builds and test suites the time they need.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run, e.g. "npm test" or "git status".' },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, description: 'Time limit in seconds (default 120).' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
const BY_TOOL = new Map(TOOLS.map((tool) => [tool.toolName, tool]));

class WorkspaceToolError extends Error {
  constructor(message, code = 'WORKSPACE_TOOL') {
    super(message);
    this.name = 'WorkspaceToolError';
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pathArgument(value, { required = false, name = 'path' } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new WorkspaceToolError(`"${name}" is required.`);
    return '';
  }
  if (typeof value !== 'string' || value.length > MAX_PATH_CHARS) throw new WorkspaceToolError(`"${name}" must be a string of at most ${MAX_PATH_CHARS} characters.`);
  // Accept the common spellings of "the root" and of relative paths, then leave the rest to the
  // workspace service's own validation (it rejects absolute paths, "..", secrets and links).
  const trimmed = value.trim().replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (trimmed === '.' || trimmed === '/') return '';
  if (required && !trimmed) throw new WorkspaceToolError(`"${name}" must name a file.`);
  return trimmed;
}

function lineNumber(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw new WorkspaceToolError(`"${name}" must be a whole number of at least 1.`);
  return value;
}

function clip(text, chars) {
  return text.length > chars ? `${text.slice(0, chars)}…` : text;
}

function systemErrorText(code) {
  if (code === 'ENOENT') return 'No such file or folder in the workspace. List the folder to see what exists.';
  if (code === 'EACCES' || code === 'EPERM') return 'Permission denied by the operating system.';
  if (code === 'EISDIR') return 'That path is a folder, not a file.';
  if (code === 'ENOTDIR') return 'A part of that path is a file, not a folder.';
  return `File system error (${code || 'unknown'}).`;
}

function splitLines(content) {
  const lines = content.split(/\r\n|\n|\r/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * @param {{ getWorkspace: () => { current(): {name: string, path: string}|null, list: Function,
 *   read: Function, write: Function, create: Function, run: Function } }} options
 */
function createWorkspaceTools({ getWorkspace, now = () => Date.now(), onChange = null } = {}) {
  if (typeof getWorkspace !== 'function') throw new TypeError('getWorkspace is required.');
  // Every file a tool changed: { path, before (null for a new file), beforeRevision, after,
  // afterRevision } (lib/checkpoints.cjs records them so the user can review and undo them).
  const changed = (change) => {
    if (typeof onChange !== 'function') return;
    try { onChange(change); } catch { /* recording never fails the tool call */ }
  };

  function service() {
    const workspace = getWorkspace();
    if (!workspace || !workspace.current()) {
      throw new WorkspaceToolError('No workspace folder is open. Ask the user to choose one with the folder button in the message box.', 'NO_WORKSPACE');
    }
    return workspace;
  }

  /** The open folder ({name, path}) or null. */
  function folder() {
    try {
      return getWorkspace()?.current() || null;
    } catch {
      return null;
    }
  }

  /** Function definitions for the chat request; none while no folder is open. */
  function definitions() {
    if (!folder()) return [];
    return TOOLS.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters) },
    }));
  }

  function resolve(name) {
    const tool = typeof name === 'string' ? BY_NAME.get(name) : undefined;
    return tool ? { serverId: SERVER_ID, toolName: tool.toolName, readOnly: tool.readOnly } : null;
  }

  /** A line for the system prompt that tells the model which folder it works in. */
  function describe() {
    const open = folder();
    if (!open) {
      return 'No workspace folder is open, so there are no file tools. If the user asks about their files or folder, tell them to choose a folder with the folder button in the message box.';
    }
    return [
      `You are working in the user's project folder "${open.name}", like a coding agent in a terminal: you can list, read and search its files, change them and run commands there with the workspace_* tools. Paths are relative to that folder ("" is the folder itself).`,
      'Work like this: look at the relevant files before answering or changing anything, never guess file contents; make focused changes with workspace_edit (exact text replace) after reading the file, and use workspace_write only for new files or complete rewrites; after a change, run the project\'s own checks (tests, build, lint) with workspace_run when there are any, and fix what they report; finish with a short summary of what you changed.',
      'The user can switch folders during a conversation, so earlier messages may describe another folder or older file contents: check again with the tools before answering about files.',
    ].join('\n');
  }

  /** A short marker for the newest user message, so a folder switch mid-conversation is seen. */
  function marker() {
    const open = folder();
    return open ? `[Workspace folder right now: "${open.name}"]` : '';
  }

  async function listFiles(args) {
    const relative = pathArgument(args.path);
    const workspace = service();
    const result = await workspace.list(relative);
    const label = relative || `${workspace.current().name} (the workspace folder)`;
    if (!result.entries.length) {
      return `${label} is empty: it has no files or folders. (Build folders such as node_modules and secret files such as .env are never listed.)`;
    }
    const lines = result.entries.map((entry) => (entry.type === 'directory' ? `${entry.path}/` : entry.path));
    const folders = result.entries.filter((entry) => entry.type === 'directory').length;
    const more = result.entries.length >= 1000 ? '\n[listing stopped at 1000 entries]' : '';
    return `${label}: ${folders} folders, ${result.entries.length - folders} files\n${lines.join('\n')}${more}`;
  }

  async function readFile(args) {
    const relative = pathArgument(args.path, { required: true });
    const start = lineNumber(args.start_line, 'start_line') || 1;
    const end = lineNumber(args.end_line, 'end_line');
    if (end !== null && end < start) throw new WorkspaceToolError('"end_line" must not be before "start_line".');
    const file = await service().read(relative);
    const lines = splitLines(file.content);
    const total = lines.length;
    if (!file.content) return `${file.path} is empty.`;
    if (start > total) return `${file.path} has only ${total} lines.`;
    const last = Math.min(end ?? total, total);
    const picked = [];
    let bytes = 0;
    for (let index = start - 1; index < last; index += 1) {
      const size = Buffer.byteLength(lines[index]) + 1;
      if (picked.length && bytes + size > READ_PAGE_BYTES) break;
      picked.push(lines[index]);
      bytes += size;
    }
    const shownEnd = start + picked.length - 1;
    const whole = start === 1 && shownEnd === total;
    const header = whole ? `${file.path} (${total} lines)` : `${file.path} lines ${start}-${shownEnd} of ${total}`;
    const more = shownEnd < last ? `\n[more: call workspace_read with start_line ${shownEnd + 1}]` : '';
    return `${header}\n${picked.join('\n')}${more}`;
  }

  async function search(args) {
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > MAX_QUERY_CHARS) {
      throw new WorkspaceToolError(`"query" must be non-empty text of at most ${MAX_QUERY_CHARS} characters.`);
    }
    const workspace = service();
    const exact = args.case_sensitive === true;
    const needle = exact ? args.query : args.query.toLowerCase();
    const has = (text) => (exact ? text : text.toLowerCase()).includes(needle);
    const root = pathArgument(args.path);
    const started = now();
    const names = [];
    const hits = [];
    const queue = [root];
    let folders = 0;
    let files = 0;
    let stopped = '';
    let skippedFolders = false;
    const full = () => names.length + hits.length >= SEARCH.matches;
    while (queue.length && !stopped) {
      const current = queue.shift();
      let listing;
      try {
        listing = await workspace.list(current);
      } catch (error) {
        if (current === root) throw error;
        continue;
      }
      folders += 1;
      for (const entry of listing.entries) {
        if (full()) { stopped = `${SEARCH.matches} matches`; break; }
        if (now() - started > SEARCH.timeMs) { stopped = 'the time limit'; break; }
        if (has(entry.name)) names.push(entry.type === 'directory' ? `${entry.path}/` : entry.path);
        if (entry.type === 'directory') {
          if (folders + queue.length < SEARCH.folders) queue.push(entry.path);
          else skippedFolders = true;
          continue;
        }
        if (BINARY_EXTENSIONS.test(entry.name)) continue;
        if (files >= SEARCH.files) { stopped = `${SEARCH.files} files`; break; }
        files += 1;
        let content;
        try {
          content = (await workspace.read(entry.path)).content;
        } catch {
          continue; // binary, too large, or changed while reading
        }
        if (!has(content)) continue;
        const lines = splitLines(content);
        for (let index = 0; index < lines.length && !full(); index += 1) {
          if (has(lines[index])) hits.push(`${entry.path}:${index + 1}: ${clip(lines[index].trim(), SEARCH.lineChars)}`);
        }
      }
    }
    if (!stopped && skippedFolders) stopped = `${SEARCH.folders} folders`;
    const scope = root ? `in ${root}/` : 'in the workspace';
    const summary = `Searched ${files} files in ${folders} folders ${scope}${stopped ? ` (stopped at ${stopped}; narrow it with "path")` : ''}.`;
    if (!names.length && !hits.length) return `No matches for "${args.query}". ${summary}`;
    const parts = [summary];
    if (names.length) parts.push(`File and folder names:\n${names.join('\n')}`);
    if (hits.length) parts.push(`Text matches:\n${hits.join('\n')}`);
    return parts.join('\n\n');
  }

  async function writeFile(args) {
    const relative = pathArgument(args.path, { required: true });
    if (typeof args.content !== 'string') throw new WorkspaceToolError('"content" must be the complete file text.');
    const workspace = service();
    let existing = null;
    try {
      existing = await workspace.read(relative);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const bytes = Buffer.byteLength(args.content);
    if (!existing) {
      const created = await workspace.create({ path: relative, content: args.content });
      changed({ path: created.path, before: null, beforeRevision: null, after: args.content, afterRevision: created.revision });
      return `Created ${created.path} (${bytes} bytes).`;
    }
    if (existing.content === args.content) return `${existing.path} already has exactly this content; nothing changed.`;
    const saved = await workspace.write({ path: relative, content: args.content, revision: existing.revision });
    changed({ path: saved.path, before: existing.content, beforeRevision: existing.revision, after: args.content, afterRevision: saved.revision });
    return `Replaced ${saved.path} (${bytes} bytes). The previous version was backed up in .cache/editor-backups.`;
  }

  async function editFile(args) {
    const relative = pathArgument(args.path, { required: true });
    if (typeof args.old_text !== 'string' || !args.old_text) throw new WorkspaceToolError('"old_text" must be the exact, non-empty text to replace.');
    if (typeof args.new_text !== 'string') throw new WorkspaceToolError('"new_text" must be text (it may be empty to delete).');
    if (args.old_text === args.new_text) throw new WorkspaceToolError('"old_text" and "new_text" are the same; nothing would change.');
    const workspace = service();
    const file = await workspace.read(relative);
    const count = file.content.split(args.old_text).length - 1;
    if (count === 0) {
      throw new WorkspaceToolError(`old_text was not found in ${file.path}. Read the file again and copy the text exactly, including indentation.`, 'NO_MATCH');
    }
    if (count > 1 && args.replace_all !== true) {
      throw new WorkspaceToolError(`old_text occurs ${count} times in ${file.path}. Include more surrounding lines to make it unique, or set replace_all.`, 'AMBIGUOUS_MATCH');
    }
    const firstLine = file.content.slice(0, file.content.indexOf(args.old_text)).split('\n').length;
    const content = args.replace_all === true
      ? file.content.split(args.old_text).join(args.new_text)
      : file.content.replace(args.old_text, () => args.new_text);
    const saved = await workspace.write({ path: relative, content, revision: file.revision });
    changed({ path: saved.path, before: file.content, beforeRevision: file.revision, after: content, afterRevision: saved.revision });
    const where = count === 1 ? `at line ${firstLine}` : `${count} occurrences, first at line ${firstLine}`;
    return `Edited ${file.path} (${where}). The previous version was backed up in .cache/editor-backups.`;
  }

  function commandOutput({ exitCode, stdout, stderr }) {
    const parts = [`Exit code: ${exitCode ?? 'none'}`];
    if (stdout) parts.push(`stdout:\n${stdout}`);
    if (stderr) parts.push(`stderr:\n${stderr}`);
    if (!stdout && !stderr) parts.push('(no output)');
    return parts.join('\n');
  }

  async function runCommand(args, context = {}) {
    if (typeof args.command !== 'string' || !args.command.trim()) throw new WorkspaceToolError('"command" must be a non-empty command line.');
    let seconds = COMMAND_SECONDS.default;
    if (args.timeout_seconds !== undefined) {
      if (!Number.isInteger(args.timeout_seconds) || args.timeout_seconds < 1 || args.timeout_seconds > COMMAND_SECONDS.max) {
        throw new WorkspaceToolError(`"timeout_seconds" must be a whole number from 1 to ${COMMAND_SECONDS.max}.`);
      }
      seconds = args.timeout_seconds;
    }
    const request = { command: args.command, timeoutMs: seconds * 1000 };
    // The reply shows the output while the command runs, and Stop ends the command too.
    if (typeof context.onOutput === 'function') request.onOutput = context.onOutput;
    if (context.signal) request.signal = context.signal;
    try {
      return commandOutput(await service().run(request));
    } catch (error) {
      // Timeouts and output limits keep what the command printed so far.
      if (typeof error?.stdout === 'string' || typeof error?.stderr === 'string') {
        return { isError: true, text: `${error.message}\n${commandOutput(error)}` };
      }
      throw error;
    }
  }

  const RUNNERS = { list_files: listFiles, read_file: readFile, search, write_file: writeFile, edit_file: editFile, run_command: runCommand };

  /**
   * Runs one tool (by its toolName) and returns { text } or { isError, text }.
   * `context` ({ onOutput, signal }) streams a command's output and stops it with the reply.
   */
  async function call(toolName, args, context = {}) {
    const tool = BY_TOOL.get(toolName);
    if (!tool) throw new WorkspaceToolError(`Unknown workspace tool: ${toolName}`);
    let result;
    try {
      result = await RUNNERS[tool.toolName](isRecord(args) ? args : {}, isRecord(context) ? context : {});
    } catch (error) {
      // Raw file-system errors carry absolute paths; the model only ever sees relative ones.
      if (typeof error?.syscall === 'string') throw new WorkspaceToolError(systemErrorText(error.code), error.code);
      throw error;
    }
    return typeof result === 'string' ? { text: result } : result;
  }

  return { SERVER_ID, folder, definitions, resolve, describe, marker, call, describeCall };
}
/** A one-line title for a step in the reply ("Read src/app.js", "Ran npm test"). */
function describeCall(toolName, args) {
  const value = isRecord(args) ? args : {};
  const target = (text, fallback) => (typeof text === 'string' && text.trim() ? clip(text.trim().replace(/\s+/g, ' '), 120) : fallback);
  switch (toolName) {
    case 'list_files': return `Listed ${target(value.path, 'the folder')}`;
    case 'read_file': {
      const lines = Number.isInteger(value.start_line) ? ` (lines ${value.start_line}${Number.isInteger(value.end_line) ? `-${value.end_line}` : '+'})` : '';
      return `Read ${target(value.path, 'a file')}${lines}`;
    }
    case 'search': return `Searched for "${target(value.query, '…')}"${typeof value.path === 'string' && value.path.trim() ? ` in ${target(value.path, '')}` : ''}`;
    case 'write_file': return `Wrote ${target(value.path, 'a file')}`;
    case 'edit_file': return `Edited ${target(value.path, 'a file')}`;
    case 'run_command': return `Ran ${target(value.command, 'a command')}`;
    default: return toolName;
  }
}

/**
 * The tool source the chat loop uses: the built-in tools of the current mode first (workspace, and
 * in Working mode the web and computer tools), then MCP tools in the room left under the request
 * limit. A broken MCP setup never hides the built-in tools.
 *
 * @param {{ builtins: object[]|((mode: string) => object[]), mcp: object,
 *   serverName?: (serverId: string) => string }} options
 *   each built-in source has { SERVER_ID, family, definitions(), resolve(), call(), describeCall()? };
 *   serverName names MCP servers in step titles.
 */
function combineToolSources({ builtins, workspaceTools, mcp, serverName = null }) {
  const sources = (mode) => {
    if (typeof builtins === 'function') return builtins(mode);
    if (Array.isArray(builtins)) return builtins;
    return [workspaceTools];
  };
  // Every built-in source, not only those of the current mode: a call may arrive from a round
  // that started before the mode changed.
  const builtinFor = (serverId) => {
    if (typeof serverId !== 'string') return null;
    const all = typeof builtins === 'function' ? builtins(undefined) : Array.isArray(builtins) ? builtins : [workspaceTools];
    const known = [...new Set([...all, ...sources('working'), ...sources('coding')])];
    return known.find((candidate) => candidate?.SERVER_ID === serverId) || null;
  };
  return {
    async chatTools(options = {}) {
      const own = [];
      const owners = new Map();
      for (const source of sources(options.mode)) {
        for (const definition of source.definitions()) {
          own.push(definition);
          owners.set(definition.function.name, source);
        }
      }
      let external;
      try {
        external = await mcp.chatTools(options);
      } catch (error) {
        external = { tools: [], resolve: () => null, errors: [{ serverId: null, message: error instanceof Error ? error.message : String(error) }] };
      }
      const ownNames = new Set(own.map((definition) => definition.function.name));
      const candidates = (Array.isArray(external?.tools) ? external.tools : []).filter((definition) => !ownNames.has(definition?.function?.name));
      const room = Math.max(0, MAX_TOOLS - own.length);
      const errors = Array.isArray(external?.errors) ? [...external.errors] : [];
      if (candidates.length > room) errors.push({ serverId: null, message: 'Some MCP tools were omitted because the chat tool limit was reached.' });
      const kept = candidates.slice(0, room);
      const keptNames = new Set(kept.map((definition) => definition.function.name));
      const externalResolve = typeof external?.resolve === 'function' ? external.resolve : () => null;
      return {
        tools: [...own, ...kept],
        resolve(name) {
          const owner = owners.get(name);
          if (owner) return owner.resolve(name);
          return keptNames.has(name) ? externalResolve(name) : null;
        },
        errors,
      };
    },
    /**
     * Runs a call. `context` ({ onOutput, signal }) reaches the built-in tools only; MCP servers
     * get exactly the call.
     */
    callTool(input, context) {
      const source = builtinFor(input?.id);
      if (source && isRecord(input)) return source.call(input.name, input.arguments, isRecord(context) ? context : {});
      return mcp.callTool(input);
    },
    /** The step title for a call the tool loop resolved ({ serverId, toolName }). */
    describeCall(target, args) {
      const source = builtinFor(target?.serverId);
      if (source && typeof source.describeCall === 'function') {
        try {
          const title = source.describeCall(target.toolName, args);
          if (typeof title === 'string' && title) return title;
        } catch { /* fall back to the tool name */ }
      }
      const toolName = typeof target?.toolName === 'string' ? target.toolName : 'tool';
      let server = typeof target?.serverId === 'string' ? target.serverId : '';
      try { server = serverName?.(server) || server; } catch { /* keep the id */ }
      return server ? `${server} · ${toolName}` : toolName;
    },
  };
}

module.exports = { createWorkspaceTools, combineToolSources, SERVER_ID, TOOLS, WorkspaceToolError };
