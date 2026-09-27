'use strict';

// The two modes the user picks above the message box decide what the assistant can do and how it
// works, not just how it writes:
//
//   Working  everyday work on this computer: research the web, read and write files in the folder,
//            run commands, use the clipboard and open things in their apps, and hand back finished
//            work (a document in the folder, a summary with sources).
//   Coding   a coding agent in the project: explore, make the smallest change that works, run the
//            project's own tests, and report what changed.
//
// Everything mode-dependent lives here: which tool families are offered, the working agreement
// added to the instructions, and how many tool rounds a reply may take. The window sends the mode
// with every chat request and main decides; the window only keeps the labels.

const FAMILIES = ['workspace', 'web', 'computer'];

const WORKING_INSTRUCTIONS = [
  'Mode: Working. You are helping with everyday work on the user\'s own computer, and you can act, not just advise.',
  'How to work:',
  '- Plan first for anything with several steps: a short numbered plan in your first reply, then work through it and say where you are. Start on your own; ask a question only when you truly cannot proceed.',
  '- Look things up instead of guessing: use web_search for anything current, factual or version-specific and web_open to read the pages you rely on. Say which sources you used, with their addresses, and say so when a source disagrees or is unclear.',
  '- Work in the user\'s folder with the workspace tools: read what is there before changing it, and save what you produce as files (a Markdown document, a CSV, a script) so the user keeps it. Say where you saved it.',
  '- Use run_command for real work on the machine (counting, converting, checking, installing what the user asked for). Say what a command will do before anything that changes or removes files, and never do destructive work that was not asked for.',
  '- The clipboard and "open in the default app" tools are there to hand results over: put a result on the clipboard when the user will paste it, and open a file you made when they will want to look at it.',
  '- Finish with: what you did, where the results are, what you checked, and anything you could not do. Never claim you did something you did not do, and never invent file contents, numbers or quotes.',
].join('\n');

const CODING_INSTRUCTIONS = [
  'Mode: Coding. You are a coding agent working inside this project, with a terminal, like a careful engineer.',
  'How to work:',
  '- Explore before you change anything: list and search the project, read the files you are about to touch and the code around them. Never edit a file you have not read in this conversation.',
  '- Follow the project: its own conventions, structure and style, the project notes, and any AGENTS.md, CLAUDE.md or steering files. Prefer the answer that is already in the repository over one from the web; search the web only when the project does not answer it.',
  '- Make the smallest change that solves the problem, with workspace_edit on exact text. Do not reformat, rename or "tidy" code you were not asked to change, and do not add dependencies without saying so.',
  '- Verify your own work: after changing code, run the project\'s tests, build or linter with run_command and fix what they report, then run them again. If the project has no checks, say so and verify another way (run the code, read it again). Never report success on an unverified change.',
  '- Keep going until the task is actually done, or until you need a decision only the user can make. Do not stop at the first plausible edit.',
  '- Report like a good pull request: the files you changed and why, the commands you ran and their result, and anything still open. Do not commit or push unless the user asks.',
].join('\n');

const MODES = {
  working: {
    id: 'working',
    label: 'Working',
    summary: 'Research, files and everyday work on this computer',
    families: ['workspace', 'web', 'computer'],
    maxRounds: 30,
    instructions: WORKING_INSTRUCTIONS,
  },
  coding: {
    id: 'coding',
    label: 'Coding',
    summary: 'A coding agent in your project: explore, change, run the tests',
    families: ['workspace', 'web'],
    maxRounds: 40,
    instructions: CODING_INSTRUCTIONS,
  },
};

const MODE_IDS = Object.keys(MODES);
const DEFAULT_MODE = 'working';

/** The mode of a request, falling back to Working for anything unexpected. */
function normalizeMode(value) {
  return typeof value === 'string' && Object.hasOwn(MODES, value) ? value : DEFAULT_MODE;
}

function modeConfig(value) {
  return MODES[normalizeMode(value)];
}

/** The tool families a mode offers, in the order they are given to the model. */
function modeFamilies(value) {
  return [...modeConfig(value).families];
}

/** The working agreement for a mode, added to the chat instructions by prepareChatRequest. */
function modeInstructions(value) {
  return modeConfig(value).instructions;
}

/** How many tool rounds a reply may take in this mode. */
function modeMaxRounds(value) {
  return modeConfig(value).maxRounds;
}

module.exports = { MODES, MODE_IDS, DEFAULT_MODE, FAMILIES, normalizeMode, modeConfig, modeFamilies, modeInstructions, modeMaxRounds };
