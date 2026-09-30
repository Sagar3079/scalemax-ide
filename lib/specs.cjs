'use strict';
// Specs: a feature written down before it is built, the way Kiro does it — requirements, then a
// design, then a task list — as three Markdown files per feature in the project itself:
//   .scalemax/specs/<slug>/requirements.md | design.md | tasks.md
// They are ordinary project files, so they go through lib/workspace.cjs (path guards, backups,
// per-folder write lock) and land in the reply's changes for review and undo. The task list is
// plain Markdown checkboxes, so the window can tick one off and the model can read the progress.
const DOCS = Object.freeze(['requirements', 'design', 'tasks']);
const ROOT = '.scalemax/specs';
const MAX_SPECS = 100;
const MAX_DOC_BYTES = 128 * 1024;
const MAX_TASKS = 400;
const MAX_SLUG = 48;
const MAX_TASK_TEXT = 300;
const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
// "- [ ] Build the parser" / "- [x] Build the parser", with optional indentation for subtasks.
// `\r?$` so a file with Windows line endings still has tasks (splitting on \n leaves the \r).
const TASK_LINE = /^([ \t]*)([-*])[ \t]+\[([ xX])\][ \t]+(.*?)\r?$/;
// A checklist inside a fenced code block is an example, not a task of this spec.
const FENCE_LINE = /^[ \t]*(```+|~~~+)/;

class SpecError extends Error {
  constructor(message, code = 'SPEC_ERROR') {
    super(message);
    this.name = 'SpecError';
    this.code = code;
  }
}

/**
 * A feature name as a folder-safe slug ("Offline sync!" → "offline-sync"), or '' when unusable.
 * Nothing is truncated: two long names that differ only after the 48th character would otherwise
 * become the same spec and quietly overwrite each other's documents.
 */
function slugify(value) {
  if (typeof value !== 'string') return '';
  const slug = value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return SLUG.test(slug) ? slug : '';
}
function specSlug(value) {
  const slug = slugify(value);
  if (slug) return slug;
  const long = typeof value === 'string' && value.trim().length > MAX_SLUG;
  throw new SpecError(long
    ? `A spec name must be at most ${MAX_SLUG} characters of letters and numbers, for example "offline-sync".`
    : 'A spec needs a short name of letters and numbers, for example "offline-sync".', 'INVALID_SPEC');
}
function docName(value) {
  const doc = typeof value === 'string' ? value.trim().toLowerCase().replace(/\.md$/, '') : '';
  if (!DOCS.includes(doc)) throw new SpecError(`Choose which document: ${DOCS.join(', ')}.`, 'INVALID_DOC');
  return doc;
}
/** The project-relative path of one spec document. */
function docPath(slug, doc) {
  return `${ROOT}/${specSlug(slug)}/${docName(doc)}.md`;
}

/** The checkbox tasks of a tasks.md, numbered from 1 in file order (code blocks skipped). */
function parseTasks(content) {
  const tasks = [];
  const lines = typeof content === 'string' ? content.split('\n') : [];
  let fence = '';
  for (const [index, line] of lines.entries()) {
    const fenced = FENCE_LINE.exec(line);
    if (fenced) {
      // A fence of the same kind and at least the same length closes the block.
      if (!fence) fence = fenced[1];
      else if (fenced[1][0] === fence[0] && fenced[1].length >= fence.length) fence = '';
      continue;
    }
    if (fence) continue;
    const match = TASK_LINE.exec(line);
    if (!match) continue;
    if (tasks.length >= MAX_TASKS) break;
    const text = match[4].trim();
    if (!text) continue;
    tasks.push({
      number: tasks.length + 1,
      line: index,
      done: match[3].toLowerCase() === 'x',
      depth: Math.floor(match[1].replace(/\t/g, '  ').length / 2),
      text: text.slice(0, MAX_TASK_TEXT),
    });
  }
  return tasks;
}
/** Same content with task `number` ticked or cleared; null when nothing would change. */
function withTaskState(content, number, done) {
  const tasks = parseTasks(content);
  const task = tasks.find((item) => item.number === number);
  if (!task || task.done === done) return null;
  const lines = content.split('\n');
  lines[task.line] = lines[task.line].replace(/\[([ xX])\]/, done ? '[x]' : '[ ]');
  return { content: lines.join('\n'), task: { ...task, done } };
}
function progressOf(content) {
  const tasks = parseTasks(content);
  return { total: tasks.length, done: tasks.filter((task) => task.done).length };
}

/**
 * Reads and writes the specs of one workspace folder.
 * @param {{ getWorkspace: () => object, onChange?: (change: object) => void }} options
 *   onChange records a written document with the reply's changes (lib/checkpoints.cjs).
 */
function createSpecStore({ getWorkspace, onChange = null }) {
  if (typeof getWorkspace !== 'function') throw new TypeError('getWorkspace is required.');
  const changed = (change) => {
    if (typeof onChange !== 'function') return;
    try { onChange(change); } catch { /* recording never fails the write */ }
  };
  function service() {
    const workspace = getWorkspace();
    if (!workspace || !workspace.current()) {
      throw new SpecError('No workspace folder is open, so there are no specs. Ask the user to choose a folder.', 'NO_WORKSPACE');
    }
    return workspace;
  }
  async function readDoc(workspace, slug, doc) {
    try {
      return await workspace.read(docPath(slug, doc));
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'NOT_FILE') return null;
      throw error;
    }
  }
  /** The names of the documents a spec folder holds; [] when the folder is gone. */
  async function docsOf(workspace, slug) {
    try {
      const { entries } = await workspace.list(`${ROOT}/${slug}`);
      return DOCS.filter((doc) => entries.some((entry) => entry.type === 'file' && entry.name === `${doc}.md`));
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'NOT_DIRECTORY') return [];
      throw error;
    }
  }

  /**
   * Every spec of this folder in name order, with which documents exist and task progress. Which
   * documents exist comes from one directory listing per spec, so only tasks.md is ever read; a
   * document that cannot be read (too large, not text) counts as present with no tasks instead of
   * hiding every spec in the folder.
   */
  async function list() {
    const workspace = service();
    let entries;
    try {
      entries = (await workspace.list(ROOT)).entries;
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'NOT_DIRECTORY') return [];
      throw error;
    }
    const slugs = entries.filter((entry) => entry.type === 'directory' && slugify(entry.name) === entry.name)
      .map((entry) => entry.name).sort((left, right) => left.localeCompare(right)).slice(0, MAX_SPECS);
    const specs = [];
    for (const slug of slugs) {
      const present = await docsOf(workspace, slug);
      const docs = {};
      for (const doc of DOCS) docs[doc] = present.includes(doc);
      let progress = { total: 0, done: 0 };
      if (docs.tasks) {
        try {
          const file = await readDoc(workspace, slug, 'tasks');
          if (file) progress = progressOf(file.content);
        } catch { /* an unreadable task list just has no countable tasks */ }
      }
      specs.push({ slug, docs, progress });
    }
    return specs;
  }

  /** One spec: the text of the documents that exist, plus its tasks. */
  async function read(slug, doc = null) {
    const workspace = service();
    const wanted = doc ? [docName(doc)] : DOCS;
    // `tasksRevision` is the version the tasks were numbered from: setTask refuses to tick against
    // a task list that changed since, so a number can never land on the wrong line.
    const result = { slug: specSlug(slug), docs: {}, tasks: [], missing: [], tasksRevision: null };
    for (const name of wanted) {
      const file = await readDoc(workspace, result.slug, name);
      if (!file) {
        result.missing.push(name);
        continue;
      }
      result.docs[name] = file.content;
      if (name === 'tasks') {
        result.tasks = parseTasks(file.content);
        result.tasksRevision = file.revision;
      }
    }
    if (!Object.keys(result.docs).length) {
      throw new SpecError(`There is no spec "${result.slug}"${doc ? ` with a ${docName(doc)} document` : ''} yet.`, 'NO_SPEC');
    }
    return result;
  }

  /** Creates or replaces one document of a spec. */
  async function write(slug, doc, content) {
    const workspace = service();
    const name = docName(doc);
    const path = docPath(slug, name);
    if (typeof content !== 'string' || !content.trim()) throw new SpecError('A spec document needs text.', 'INVALID_CONTENT');
    if (Buffer.byteLength(content) > MAX_DOC_BYTES) throw new SpecError(`A spec document must be at most ${MAX_DOC_BYTES / 1024} KiB.`, 'INVALID_CONTENT');
    const text = content.endsWith('\n') ? content : `${content}\n`;
    // A task list nobody can tick off is a mistake worth saying out loud, not a silent success.
    const tasks = name === 'tasks' ? progressOf(text).total : -1;
    const existing = await readDoc(workspace, slug, name);
    if (!existing) {
      // The cap is enforced where a spec is created, not only where specs are listed.
      const known = await list();
      if (!known.some((spec) => spec.slug === specSlug(slug)) && known.length >= MAX_SPECS) {
        throw new SpecError(`This project already has ${MAX_SPECS} specs; finish or remove one first.`, 'TOO_MANY_SPECS');
      }
      const created = await workspace.create({ path, content: text });
      changed({ path: created.path, before: null, beforeRevision: null, after: text, afterRevision: created.revision });
      return { path: created.path, slug: specSlug(slug), doc: name, created: true, tasks };
    }
    if (existing.content === text) return { path: existing.path, slug: specSlug(slug), doc: name, created: false, unchanged: true, tasks };
    const saved = await workspace.write({ path, content: text, revision: existing.revision });
    changed({ path: saved.path, before: existing.content, beforeRevision: existing.revision, after: text, afterRevision: saved.revision });
    return { path: saved.path, slug: specSlug(slug), doc: name, created: false, tasks };
  }

  /**
   * Ticks a task of tasks.md off (or back on). `revision` is the version the caller's numbers came
   * from; when it no longer matches, the tick is refused rather than applied to a different line.
   */
  async function setTask(slug, number, done, { revision = null } = {}) {
    const workspace = service();
    const path = docPath(slug, 'tasks');
    if (!Number.isSafeInteger(number) || number < 1 || number > MAX_TASKS) throw new SpecError('Choose a task by its number.', 'INVALID_TASK');
    const existing = await readDoc(workspace, slug, 'tasks');
    if (!existing) throw new SpecError(`Spec "${specSlug(slug)}" has no task list yet.`, 'NO_SPEC');
    if (revision !== null && revision !== undefined && existing.revision !== revision) {
      throw new SpecError('This task list changed since it was read, so the task numbers may have moved. Read it again and try once more.', 'SPEC_CHANGED');
    }
    const next = withTaskState(existing.content, number, done === true);
    if (!next) {
      const tasks = parseTasks(existing.content);
      const task = tasks.find((item) => item.number === number);
      if (!task) throw new SpecError(`Spec "${specSlug(slug)}" has no task ${number}; it has ${tasks.length}.`, 'INVALID_TASK');
      return { slug: specSlug(slug), task, unchanged: true, progress: progressOf(existing.content) };
    }
    const saved = await workspace.write({ path, content: next.content, revision: existing.revision });
    changed({ path: saved.path, before: existing.content, beforeRevision: existing.revision, after: next.content, afterRevision: saved.revision });
    return { slug: specSlug(slug), task: next.task, progress: progressOf(next.content) };
  }

  return { list, read, write, setTask, folder: () => getWorkspace()?.current() || null };
}

// ---- The model's spec tools -----------------------------------------------------------------

const SERVER_ID = 'Specs';
const TOOLS = [
  {
    name: 'spec_list',
    toolName: 'spec_list',
    readOnly: true,
    description: 'List the feature specs of this project (.scalemax/specs): their names, which of the three documents exist, and how many tasks are done. Look here before planning a feature the project may already have written down.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'spec_read',
    toolName: 'spec_read',
    readOnly: true,
    description: 'Read a feature spec: its requirements, design and task list (or one of them). Read the spec before working on its tasks, and follow what it says.',
    parameters: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'The spec name, e.g. "offline-sync".' },
        doc: { type: 'string', enum: [...DOCS], description: 'Only this document (default: all three).' },
      },
      required: ['spec'],
      additionalProperties: false,
    },
  },
  {
    name: 'spec_write',
    toolName: 'spec_write',
    readOnly: false,
    description: 'Create or replace one document of a feature spec, in this order: requirements (numbered user stories with acceptance criteria), then design (the approach, the files and interfaces it touches, the trade-offs), then tasks (a checklist of "- [ ] step" lines, each small enough to verify on its own). Write one document at a time, show it to the user and let them correct it before you write the next; they approve the plan before you build it.',
    parameters: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'The spec name, e.g. "offline-sync". A new name starts a new spec.' },
        doc: { type: 'string', enum: [...DOCS], description: 'Which document to write.' },
        content: { type: 'string', description: 'The complete Markdown text of that document.' },
      },
      required: ['spec', 'doc', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'spec_task',
    toolName: 'spec_task',
    readOnly: false,
    description: 'Tick one task of a spec\'s task list off once it is really done and verified (or clear it again with done: false). Do this as you finish each task, so the user can follow the progress.',
    parameters: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'The spec name.' },
        task: { type: 'integer', minimum: 1, description: 'The task number, as shown by spec_read.' },
        done: { type: 'boolean', description: 'true when it is finished (default true).' },
      },
      required: ['spec', 'task'],
      additionalProperties: false,
    },
  },
];
const BY_TOOL = new Map(TOOLS.map((tool) => [tool.toolName, tool]));

// The numbers spec_task takes, without showing a checkbox style the parser would not accept back.
function taskLines(tasks) {
  return tasks.map((task) => `${'  '.repeat(Math.min(task.depth, 4))}${task.number}: ${task.text} — ${task.done ? 'done' : 'open'}`).join('\n');
}

/** The spec tool family for a chat reply, on the reply's own workspace session. */
function createSpecTools({ getWorkspace, onChange = null }) {
  const store = createSpecStore({ getWorkspace, onChange });
  const RUNNERS = {
    async spec_list() {
      const specs = await store.list();
      if (!specs.length) return 'This project has no specs yet. Write one with spec_write (requirements, then design, then tasks).';
      return specs.map((spec) => {
        const missing = DOCS.filter((doc) => !spec.docs[doc]);
        const progress = spec.progress.total ? `${spec.progress.done}/${spec.progress.total} tasks done` : 'no tasks yet';
        return `${spec.slug} · ${progress}${missing.length ? ` · missing: ${missing.join(', ')}` : ''}`;
      }).join('\n');
    },
    async spec_read(args) {
      const spec = await store.read(args.spec, args.doc);
      const parts = [`Spec "${spec.slug}"`];
      for (const doc of DOCS) {
        if (typeof spec.docs[doc] !== 'string') continue;
        parts.push(`--- ${doc}.md ---\n${spec.docs[doc].trimEnd()}`);
      }
      if (spec.tasks.length) parts.push(`--- tasks by number ---\n${taskLines(spec.tasks)}`);
      if (spec.missing.length) parts.push(`Not written yet: ${spec.missing.join(', ')}.`);
      return parts.join('\n\n');
    },
    async spec_write(args) {
      const result = await store.write(args.spec, args.doc, args.content);
      // A task list with no checkbox line cannot be ticked off by anyone, so say so either way.
      const tasks = result.doc === 'tasks' && result.tasks === 0
        ? ' Warning: it has no "- [ ] step" lines, so it has no tasks to work through. Write it again with one checkbox line per step.'
        : '';
      if (result.unchanged) return `${result.path} already has exactly this text; nothing changed.${tasks}`;
      const next = { requirements: 'design', design: 'tasks', tasks: '' }[result.doc];
      const hint = next ? ` Show it to the user and let them correct it before you write ${next}.` : ' Work through the tasks one at a time and tick each off with spec_task.';
      return `${result.created ? 'Created' : 'Replaced'} ${result.path}.${tasks || hint}`;
    },
    async spec_task(args) {
      const result = await store.setTask(args.spec, args.task, args.done === undefined ? true : args.done);
      const progress = `${result.progress.done}/${result.progress.total} tasks done`;
      if (result.unchanged) return `Task ${result.task.number} of "${result.slug}" was already ${result.task.done ? 'done' : 'open'} (${progress}).`;
      return `Task ${result.task.number} of "${result.slug}" is now ${result.task.done ? 'done' : 'open'}: ${result.task.text} (${progress}).`;
    },
  };
  return {
    SERVER_ID,
    family: 'specs',
    definitions() {
      if (!store.folder()) return [];
      return TOOLS.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters) },
      }));
    },
    resolve(name) {
      const tool = typeof name === 'string' ? BY_TOOL.get(name) : undefined;
      return tool && store.folder() ? { serverId: SERVER_ID, toolName: tool.toolName, readOnly: tool.readOnly } : null;
    },
    async call(toolName, args) {
      const tool = BY_TOOL.get(toolName);
      if (!tool) throw new SpecError(`Unknown spec tool: ${toolName}`);
      const value = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
      return { text: await RUNNERS[tool.toolName](value) };
    },
    describeCall(toolName, args) {
      const value = args && typeof args === 'object' ? args : {};
      const name = typeof value.spec === 'string' && value.spec.trim() ? value.spec.trim().slice(0, 60) : 'a spec';
      switch (toolName) {
        case 'spec_list': return 'Listed the specs';
        case 'spec_read': return `Read the spec ${name}`;
        case 'spec_write': return `Wrote ${typeof value.doc === 'string' ? value.doc : 'a document'} of ${name}`;
        case 'spec_task': return `Ticked task ${Number.isSafeInteger(value.task) ? value.task : ''} of ${name}`.replace('  ', ' ');
        default: return toolName;
      }
    },
  };
}

module.exports = {
  createSpecStore, createSpecTools, slugify, specSlug, docName, docPath, parseTasks, withTaskState, progressOf,
  SpecError, DOCS, ROOT, SERVER_ID, TOOLS, MAX_DOC_BYTES, MAX_TASKS,
};
