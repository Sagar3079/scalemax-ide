---
version: 1
slug: "src-index-html"
primary_target: "src/index.html"
related_targets: []
---

# ScaleMax app shell (Chat, Workspace and every view in src/index.html)

## Scope and mode
Operate. The whole desktop app shell: sidebar, chat with streamed replies, composer, Workspace (tree, CodeMirror editor, terminal, git), Assistant, Experts, Automation, Preferences, and every dialog. Developers using it all day on a Mac, light and dark.

## Job and constraints
Hand work to an AI agent, watch it, answer approvals, review and keep/undo/commit changes, run several tasks at once. Keep every element id, every behaviour and every control; CSP forbids inline styles and remote fonts (bundle fonts in assets/fonts); respect prefers-reduced-motion and prefers-color-scheme; mascots can be turned off.

## Direction contract
THESIS: Every task is a print run. The shell is a calm two-ink riso print on cool paper stock, and the agent's state is told in ink: how the companion's two inks register. It refuses the category's grey chat app with one indigo accent, and its neon-terminal opposite.
OWN-WORLD: Cool paper ground (not cream) with faint grain; ink black text; riso Blue as the structural ink (selection, links, active nav, focus); Fluorescent Pink only for agent activity; Yellow only as a highlighter pass for "waiting for you"; pink over blue overprints by multiply. Dark mode is the same inks on deep blue-black stock. 1 device-pixel rules, few boxes, hierarchy from a strict type scale; a printed grotesk for labels and headings, system UI for body, a mono for files.
STORY: A developer sees at a glance which tasks are working, waiting, done or failed, what the agent is doing right now, how long each step took and how much context it used; they review and keep changes without hunting; the companion makes long waits feel calm.
FIRST VIEWPORT: Left sidebar (brand, New task, nav, projects with task rows carrying state marks and mini mascots); top bar crumb with tokens and cost; centre column: user message, the running reply with timed steps, a subagent group with teammate marks, reply text, the changes card; composer pinned at the bottom with permission, folder, mode, model, context meter and Send; the 56 px companion beside the running reply's status line.
FORM: Riso Zine Press, position 6 on the ordered list, seed:c02bfaad88514870. Signature interaction: the companion's pink and blue layers drift apart while it works (misregistration) and snap into register when the task finishes; approvals lift their panel and dim the shell behind.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Raised lines (from declined challengers)
- Mixtape J-Card: every task and step shows its running time and its share of the context window.
- Centre-Rail Reference: one-device-pixel rules; states read as printed marks.
- Streaming Title Wall: the panel that needs you lifts; the rest of the shell dims.
- Crouwel Grid: one 4 px module; panes resize in whole cells.
- Variable Type Specimen: hierarchy from a strict type scale, not boxes.

## Unresolved
- Exact type faces (must be bundled locally, open licence).
