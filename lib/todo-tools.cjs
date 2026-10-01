'use strict';
// The model's to-do list for work with several steps, like the plan and to-do tools of other
// coding agents: it writes the list, marks what it is doing and what is done, and the window
// shows the list live under the reply (lib/tool-loop.cjs reports it; src/reply-ui.js draws it).
// The list belongs to the conversation, not to the project: nothing is written to disk. It is
// read-only in the permission sense (it changes nothing of the user's), so it runs in Plan too.
const { normalizeTodos } = require('./tool-loop.cjs');

const SERVER_ID = 'Todos';
const MAX_TODOS = 30;
const TOOL = {
  name: 'todo_write',
  toolName: 'todo_write',
  description: 'Keep a short to-do list for work with several steps, and keep it current as you go; the user sees it live. Send the whole list every time. Mark an item in_progress before you start it (one at a time) and completed as soon as it is really done and checked; do not save completions up. Add items you discover on the way. Skip the list for a single quick step.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        maxItems: MAX_TODOS,
        description: 'The whole list, in order.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'What to do, in a few words ("Add the parser test").' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['todos'],
    additionalProperties: false,
  },
};

class TodoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TodoError';
    this.code = 'INVALID_TODOS';
  }
}

/** The list as one line per item, for the model ("[x] Add the test"). */
function todoLines(todos) {
  const mark = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };
  return todos.map((item, index) => `${index + 1}. ${mark[item.status]} ${item.content}`).join('\n');
}

/**
 * The to-do tool for one reply. `initial` is the list the previous reply left, so the model can
 * pick up where it stopped.
 */
function createTodoTools({ initial = [] } = {}) {
  let current = normalizeTodos(initial);
  return {
    SERVER_ID,
    family: 'todos',
    definitions() {
      return [{ type: 'function', function: { name: TOOL.name, description: TOOL.description, parameters: structuredClone(TOOL.parameters) } }];
    },
    resolve(name) {
      // Its updates must stay in order, so it never runs side by side with another call.
      return name === TOOL.name ? { serverId: SERVER_ID, toolName: TOOL.toolName, readOnly: true, exclusive: true } : null;
    },
    async call(toolName, args) {
      if (toolName !== TOOL.toolName) throw new TodoError(`Unknown to-do tool: ${toolName}`);
      const raw = args && typeof args === 'object' ? args.todos : undefined;
      if (!Array.isArray(raw)) throw new TodoError('"todos" must be the whole list: [{ content, status }].');
      if (raw.length > MAX_TODOS) throw new TodoError(`Keep the list to at most ${MAX_TODOS} items.`);
      const todos = normalizeTodos(raw);
      if (raw.length && !todos.length) throw new TodoError('Every item needs a short "content".');
      current = todos;
      const done = todos.filter((item) => item.status === 'completed').length;
      const active = todos.filter((item) => item.status === 'in_progress');
      const notes = [];
      if (active.length > 1) notes.push('Only one item should be in progress at a time.');
      if (todos.length && done === todos.length) notes.push('Every item is done: finish with your answer.');
      const text = todos.length
        ? `To-do list updated (${done} of ${todos.length} done):\n${todoLines(todos)}${notes.length ? `\n${notes.join(' ')}` : ''}`
        : 'To-do list cleared.';
      return { text, todos };
    },
    describeCall(toolName, args) {
      const todos = normalizeTodos(args && typeof args === 'object' ? args.todos : []);
      const active = todos.find((item) => item.status === 'in_progress');
      const done = todos.filter((item) => item.status === 'completed').length;
      if (!todos.length) return 'Cleared the to-do list';
      return active ? `To-do: ${active.content}` : `Updated the to-do list (${done}/${todos.length} done)`;
    },
    current: () => current.map((item) => ({ ...item })),
  };
}

module.exports = { createTodoTools, todoLines, SERVER_ID, TOOL, MAX_TODOS };
