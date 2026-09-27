'use strict';

// Working-mode tools for handing results over to the user's own desktop: the clipboard, and
// opening or revealing a file of the project in the app that owns it.
//
// Reading the clipboard is read-only, so Basic mode runs it on its own; putting something on the
// clipboard, opening a file and revealing it change or take over the user's desktop, so Basic and
// Manual ask first (lib/tool-loop.cjs).
//
// Deliberately not here: taking over the screen, the mouse or the keyboard. That would need new
// system permissions (Screen Recording, Accessibility) and would let a reply act as the user
// anywhere on the machine, so it is not something to add quietly.

const SERVER_ID = 'Computer';
const LIMITS = { readChars: 100000, writeChars: 100000, urlChars: 2048 };
const WEB_URL = /^https?:\/\/[^\s]+$/i;

class ComputerToolError extends Error {
  constructor(message, code = 'COMPUTER_TOOL') {
    super(message);
    this.name = 'ComputerToolError';
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const TOOLS = [
  {
    name: 'computer_clipboard_read',
    toolName: 'read_clipboard',
    readOnly: true,
    description: 'Read the text the user currently has on the clipboard. Use it when they say "this" or ask you to work with what they just copied.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'computer_clipboard_write',
    toolName: 'write_clipboard',
    readOnly: false,
    description: 'Put text on the user\'s clipboard so they can paste it somewhere else. Use it for a result they will paste, not for long documents (save those as a file).',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The exact text to put on the clipboard.' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_open',
    toolName: 'open',
    readOnly: false,
    description: 'Open something in the app that owns it: a file of the project in its default application, or a web address in the browser. Use it to show the user a result you produced.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A file or folder of the project, relative to the workspace root.' },
        url: { type: 'string', description: 'A http or https address to open in the browser instead.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'computer_reveal',
    toolName: 'reveal',
    readOnly: false,
    description: 'Show a file or folder of the project in the Finder, so the user can see where it is.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'A file or folder of the project, relative to the workspace root.' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
const BY_TOOL = new Map(TOOLS.map((tool) => [tool.toolName, tool]));

/**
 * @param {{ getWorkspace: () => object|null, clipboard: {readText: Function, writeText: Function},
 *   shell: {openPath: Function, openExternal: Function, showItemInFolder: Function} }} options
 */
function createComputerTools({ getWorkspace, clipboard, shell } = {}) {
  if (typeof getWorkspace !== 'function') throw new TypeError('getWorkspace is required.');
  if (!clipboard || typeof clipboard.readText !== 'function' || typeof clipboard.writeText !== 'function') throw new TypeError('A clipboard with readText and writeText is required.');
  if (!shell || typeof shell.openPath !== 'function' || typeof shell.openExternal !== 'function' || typeof shell.showItemInFolder !== 'function') {
    throw new TypeError('A shell with openPath, openExternal and showItemInFolder is required.');
  }

  function folder() {
    try {
      return getWorkspace()?.current() || null;
    } catch {
      return null;
    }
  }

  /** The project file behind a relative path, checked by the workspace service. */
  async function projectPath(value, name = 'path') {
    if (typeof value !== 'string' || !value.trim()) throw new ComputerToolError(`"${name}" must be a path inside the project.`);
    const workspace = getWorkspace();
    if (!workspace?.current()) throw new ComputerToolError('No workspace folder is open.', 'NO_WORKSPACE');
    const trimmed = value.trim().replace(/^\.\/+/, '').replace(/\/+$/, '');
    return workspace.absolutePath(trimmed === '.' ? '' : trimmed);
  }

  async function readClipboard() {
    const text = String(clipboard.readText() ?? '');
    if (!text.trim()) return 'The clipboard holds no text.';
    const clipped = text.length > LIMITS.readChars ? `${text.slice(0, LIMITS.readChars)}\n[cut: the clipboard holds more]` : text;
    return `The clipboard holds:\n${clipped}`;
  }

  async function writeClipboard(args) {
    if (typeof args.text !== 'string' || !args.text) throw new ComputerToolError('"text" must be the text to put on the clipboard.');
    if (args.text.length > LIMITS.writeChars) throw new ComputerToolError(`"text" must be at most ${LIMITS.writeChars} characters; save longer results as a file instead.`);
    clipboard.writeText(args.text);
    const lines = args.text.split('\n').length;
    return `Put ${args.text.length} character${args.text.length === 1 ? '' : 's'} on the clipboard${lines > 1 ? ` (${lines} lines)` : ''}. The user can paste it now.`;
  }

  async function open(args) {
    const hasUrl = typeof args.url === 'string' && args.url.trim();
    const hasPath = typeof args.path === 'string' && args.path.trim();
    if (hasUrl && hasPath) throw new ComputerToolError('Give either "path" or "url", not both.');
    if (hasUrl) {
      const url = args.url.trim();
      if (!WEB_URL.test(url) || url.length > LIMITS.urlChars) throw new ComputerToolError('"url" must be a http or https address.');
      await shell.openExternal(url);
      return `Opened ${url} in the browser.`;
    }
    if (!hasPath) throw new ComputerToolError('Give a project "path" or a web "url" to open.');
    const target = await projectPath(args.path);
    const failure = await shell.openPath(target.path);
    if (failure) throw new ComputerToolError(`The system could not open ${target.relative || 'that folder'}: ${failure}`, 'OPEN_FAILED');
    return `Opened ${target.relative || folder()?.name || 'the folder'} in its default application.`;
  }

  async function reveal(args) {
    const target = await projectPath(args.path);
    shell.showItemInFolder(target.path);
    return `Showed ${target.relative || folder()?.name || 'the folder'} in the Finder.`;
  }

  const RUNNERS = { read_clipboard: readClipboard, write_clipboard: writeClipboard, open, reveal };

  return {
    SERVER_ID,
    family: 'computer',
    /** Clipboard tools always; opening and revealing need a folder, because they take a project path. */
    definitions() {
      const open = Boolean(folder());
      return TOOLS.filter((tool) => open || tool.toolName.endsWith('clipboard')).map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters) },
      }));
    },
    resolve(name) {
      const tool = typeof name === 'string' ? BY_NAME.get(name) : undefined;
      return tool ? { serverId: SERVER_ID, toolName: tool.toolName, readOnly: tool.readOnly } : null;
    },
    async call(toolName, args) {
      const tool = BY_TOOL.get(toolName);
      if (!tool) throw new ComputerToolError(`Unknown computer tool: ${toolName}`);
      try {
        return { text: await RUNNERS[tool.toolName](isRecord(args) ? args : {}) };
      } catch (error) {
        // File-system errors carry absolute paths; the model only ever sees relative ones.
        if (typeof error?.syscall === 'string') throw new ComputerToolError('That path is not in the project, or it no longer exists.', error.code);
        throw error;
      }
    },
  };
}

module.exports = { createComputerTools, SERVER_ID, TOOLS, LIMITS, ComputerToolError };
