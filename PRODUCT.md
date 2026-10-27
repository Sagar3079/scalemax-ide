# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Developers who write code for hours every day and want an AI coding agent next to their editor. They are the kind of user who already knows Cursor, Claude Code or Codex, works from the keyboard, keeps the app open for a whole working day, and runs several tasks in parallel across project folders. The interface is designed for them first; non-technical builders and ScaleMax API customers are welcome but not the primary target.

## Product Purpose
ScaleMax IDE is a macOS desktop workspace where a developer hands work to an AI agent that reads, edits, runs and verifies code inside a real project folder, and then reviews, keeps, undoes or commits what it did. Success is a developer finishing real tasks faster without losing control: every change visible and reversible, every risky action asked about, and a workspace calm enough to stay in all day.

## Positioning
- **Any model, your key:** it runs on the ScaleMax API or any OpenAI-compatible provider the user brings, several at once, instead of one vendor's subscription and models.
- **All-in-one workspace:** chat-first tasks, a real code editor with inline review, terminal, git (commit, push, PR, worktrees), automations, experts, connectors and MCP in one app.
- **Local and private:** no account or cloud sign-in; tasks and settings stay on the Mac, keys are encrypted at rest (with a key file only the user's account can read, never the keychain, so updates never ask for keychain access), and the agent's commands run in a macOS sandbox.
- **Friendly, not intimidating:** a tool that feels warm and calm over a long day; animated agent characters are part of the identity (see Brand Commitments).

## Operating Context
- Long daily sessions on a Mac (macOS 11+), window from the 900x700 minimum up to full screen, light and dark system themes.
- Typical loop: pick a project folder, describe a task, watch streamed steps (reads, edits, commands, subagents), answer approval prompts, review the changes card or inline diff, keep or undo, commit or open a PR.
- Several tasks run at once in different folders; background jobs (dev servers, watchers) keep running; scheduled automations fire even with the window closed.
- Users switch between Chat and the Workspace (file tree, CodeMirror editor, terminal, git panel) many times an hour.
- Modes: Working (research, files, everyday work) and Coding (explore, change, run tests). Permissions: Plan, Manual, Basic, Bypass.

## Capabilities and Constraints
- Electron 33, vanilla ES modules, no build step, no runtime npm dependencies; CodeMirror 6 is vendored as one bundle.
- Strict CSP: `script-src 'self'; style-src 'self'`, no inline styles in HTML, no innerHTML; styling through CSS files and CSSOM. Fonts must be bundled locally (assets/fonts); no web font CDNs.
- Design tokens live in `src/sm-tokens.css` (light and dark); component styles in `src/*.css`.
- macOS-only build (dmg/zip, arm64), signed ad hoc but not notarized; the version in package.json is per release (1.0.0-beta.4 next).
- Existing animated expert avatars are inline SVG built with createElementNS (`src/avatars.js`), CSS-only motion (`src/experts.css`).
- Must keep every existing element id the app and `build/smoke-check.cjs` rely on (103 smoke checks, 677 unit tests).
- Respect `prefers-reduced-motion` everywhere.

## Brand Commitments
- Name: **ScaleMax IDE** in the Dock, the menu bar and Finder (so it never reads as ScaleMax Studio); **ScaleMax** is the company and the in-window wordmark. The robot-head mark in `assets/icons/scalemax-icon.svg` / `scalemax-mark.svg`.
- Voice: plain, concrete, second person, no hype; UI copy explains what will happen and what changed.
- Animated agents are part of the identity: one small companion character that reflects what the assistant is doing (idle, thinking, working, waiting for the user, done, error), subagents shown as small teammates, quiet when idle, can be turned off, respects Reduce Motion. The existing expert avatars (friendly 2D character busts) are a confirmed asset family.

## Evidence on Hand
- The app itself (`src/`), its README, HANDOFF.md and the screenshots in `assets/` (they predate the latest work).
- No customer testimonials, usage numbers, benchmarks or pricing exist; never invent them.

## Product Principles
1. **The developer stays in control.** Every change is visible, reviewable and reversible; risky actions ask first; nothing happens behind the user's back.
2. **Calm over clever.** The workspace is for an eight-hour day: low visual noise, motion with meaning, delight that never interrupts work.
3. **State is always legible.** At a glance the user knows which tasks are working, waiting for them, done or failed, and what the agent is doing right now.
4. **Keyboard first, mouse friendly.** Dense where developers expect density (editor, file tree, diffs), roomy where they read (replies).
5. **Bring your own everything.** Models, providers, keys, tools and commands are the user's choice; the UI never assumes one vendor.

## Accessibility & Inclusion
- Respect `prefers-reduced-motion` (mascots and transitions go still) and `prefers-color-scheme`.
- Keyboard access for every control, visible focus, WCAG AA contrast for text in both themes.
