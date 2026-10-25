---
name: ScaleMax IDE
description: A calm two-ink riso print on cool paper stock, where the agent's state is told in ink.
colors:
  paper: "#F3F4F1"
  paper-raised: "#FAFAF8"
  rail: "color-mix(in srgb, #0078BF 9%, #F3F4F1)"
  rail-patch: "color-mix(in srgb, #0078BF 13%, color-mix(in srgb, #0078BF 9%, #F3F4F1))"
  rail-active-text: "#004A78"
  ink: "#1A1B1F"
  ink-2: "#4A4D55"
  ink-3: "#6B6F78"
  rule: "color-mix(in srgb, #1A1B1F 14%, transparent)"
  rule-strong: "color-mix(in srgb, #1A1B1F 26%, transparent)"
  riso-blue: "#0078BF"
  blue-text: "#005E96"
  blue-fill-hover: "#006AA8"
  on-blue: "#FFFFFF"
  fluorescent-pink: "#FF48B0"
  pink-text: "#B8126F"
  highlighter-yellow: "#FFE800"
  yellow-text: "#7A5D00"
  riso-red: "#F15060"
  red-text: "#B42638"
  danger-fill: "#B42638"
  riso-green: "#00A95C"
  green-text: "#0A7A46"
  paper-dark: "#14161B"
  paper-raised-dark: "#1B1E24"
  rail-dark: "color-mix(in srgb, #0078BF 14%, #14161B)"
  ink-dark: "#E9EAE6"
  ink-2-dark: "#B4B7BE"
  ink-3-dark: "#8D919A"
  riso-blue-dark: "#4BA6E0"
  blue-text-dark: "#7CC0EC"
  on-blue-dark: "#0B1016"
  fluorescent-pink-dark: "#FF5CBA"
  pink-text-dark: "#FF8FD0"
  yellow-text-dark: "#F2D14B"
  riso-red-dark: "#FF6B78"
  red-text-dark: "#FF8C96"
  green-text-dark: "#4FD08A"
typography:
  display:
    fontFamily: "Bricolage Grotesque, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: "36px"
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Bricolage Grotesque, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: "28px"
    letterSpacing: "-0.01em"
  body-reading:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.6
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  small:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
  label:
    fontFamily: "Bricolage Grotesque, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: "12px"
    letterSpacing: "0.04em"
  mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 400
    fontFeature: "tnum"
rounded:
  tag: "3px"
  control: "6px"
  sheet: "8px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "6": "24px"
  "8": "32px"
components:
  button-primary:
    backgroundColor: "{colors.riso-blue}"
    textColor: "{colors.on-blue}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.blue-fill-hover}"
    textColor: "{colors.on-blue}"
  button-secondary:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "32px"
  button-danger:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.red-text}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "32px"
  button-danger-confirm:
    backgroundColor: "{colors.danger-fill}"
    textColor: "{colors.on-blue}"
    rounded: "{rounded.control}"
    height: "32px"
  input:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "4px 12px"
    height: "32px"
  nav-item-active:
    backgroundColor: "{colors.rail-patch}"
    textColor: "{colors.rail-active-text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
  state-tag-working:
    backgroundColor: "{colors.fluorescent-pink}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.tag}"
    padding: "2px 6px"
  state-tag-waiting:
    backgroundColor: "{colors.highlighter-yellow}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.tag}"
    padding: "2px 6px"
  state-tag-done:
    textColor: "{colors.blue-text}"
    typography: "{typography.label}"
    rounded: "{rounded.tag}"
    padding: "2px 6px"
  state-tag-failed:
    textColor: "{colors.red-text}"
    typography: "{typography.label}"
    rounded: "{rounded.tag}"
    padding: "2px 6px"
  dialog:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sheet}"
---

# Design System: ScaleMax IDE

## Overview

**Creative North Star: "Riso Zine Press"**

Every task is a print run. The shell is a calm two-ink risograph print on cool paper stock: ink-black words, riso blue for the structure of the page, fluorescent pink only where the agent is at work, and a yellow highlighter pass for the one thing that needs you. The agent's state is told in ink, most literally by the companion, whose pink and blue plates drift out of register while it works and snap back into register when the task is done.

The print metaphor governs density and depth too. Hierarchy comes from a strict six-step type scale and 1px rules, not from boxes and shadows; settings groups and notes are printed sections under a rule, not cards. The sidebar rail is a blue halftone screen; selection is a solid patch of that ink. Only sheets that need the user (dialogs and popovers) lift off the page, and the shell dims behind them. Dark mode is the same inks on deep blue-black stock, not a different palette.

The world refuses both the category's grey chat app with a single indigo accent and its neon-terminal opposite. It is built for an eight-hour day: quiet at rest, legible state at a glance, motion that carries meaning.

**Key Characteristics:**
- Cool, near-neutral paper ground with a faint grain on the page only; never cream.
- Four working inks with fixed jobs: blue structure, pink agent activity, yellow highlighter, red failure.
- 1px rules, few boxes, one 4px spacing module.
- A strict type scale (11 / 12 / 13 / 15 / 20 / 28) with a printed grotesk for headings and tags.
- Printed state tags and a two-ink companion whose registration is the task state.
- One lift: dialogs and popovers; everything else is flat stock.

## Colors

A two-ink riso palette on paper: one structural ink, one fluorescent activity ink, a highlighter, and a failure red, all printed over ink-black text.

### Primary
- **Riso Blue** (riso-blue; dark: riso-blue-dark): the structural ink. Active navigation, selection, primary buttons, focus rings (2px outline, 2px offset), links (as blue-text with a 1px underline at 55% strength), the context meter fill, the DONE tag outline, keywords in the editor. In dark mode the primary fill carries dark ink (on-blue-dark) because white on the lighter blue fails contrast.
- **Deep Blue Text** (blue-text, rail-active-text): blue at text weight, for links, done tags and the selected rail item's words.

### Secondary
- **Fluorescent Pink** (fluorescent-pink; dark: fluorescent-pink-dark): agent activity. The WORKING tag fill, the companion's ink A, thinking dots, running step spinners, the streaming cursor, running-job dots, this reply's share overprinted on the context meter, and the 3px top stripe on the approval dialog (the agent is asking).
- **Pink Text** (pink-text): pink at text weight. In the editor it is one of the syntax inks (numbers, regular expressions).

### Tertiary
- **Highlighter Yellow** (highlighter-yellow): a highlighter pass, never a text colour on paper. The WAITING FOR YOU tag, the companion's waiting swipe, search hits and editor selection washes, and the yellow wash behind notices that need the user. Yellow-text (#7A5D00 / dark #F2D14B) is the only legible yellow for words.
- **Riso Red** (riso-red, red-text, danger-fill): failure and destruction. FAILED tag outline, error dots, danger buttons (outline at rest, filled only inside a destructive confirmation).
- **Addition Green** (riso-green, green-text): additions only: diff added lines, OK dots, the string syntax ink.

### Neutral
- **Cool Paper** (paper; dark: paper-dark): the page ground, carrying the grain.
- **Raised Stock** (paper-raised; dark: paper-raised-dark): flat stock for editors, inputs, cards and dialogs. It covers the grain.
- **Blue Rail Tint** (rail; dark: rail-dark): the sidebar ground under the halftone screen.
- **Ink Black / Ink 2 / Ink 3** (ink, ink-2, ink-3): primary text, secondary text, meta text. On the rail, meta text uses a darker rail-specific ink 3 (#555962 light, #9DA1AA dark) to hold contrast against the screen.
- **Rule** (rule, rule-strong): every divider and border is ink at 14%; hover and emphasis borders at 26%.

### Named Rules
**The Four Inks Rule.** In the shell chrome each ink has one job: blue is structure, pink is the agent at work, yellow is a highlighter for what waits on the user, red is failure. A pink fill on a static control, or a blue fill on an agent state, is a misprint.

**The Ink-Black on Fluorescent Rule.** Text on a pink or yellow fill is always ink black (#1A1B1F), in both themes. Grey text never sits on yellow; it reads washed out.

**The Overprint Rule.** Where pink meets blue, they overprint: multiply on paper, screen on deep stock. The companion's two inks and the reply share on the context meter are printed this way.

**The Same Inks, Deeper Stock Rule.** Dark mode swaps the paper, not the identity: the same four inks, lightened only as far as contrast needs, on blue-black stock with its own fainter grain.

## Typography

**Display Font:** Bricolage Grotesque (bundled variable woff2, opsz 12-96, wght 200-800, wdth 75-100, SIL OFL), falling back to -apple-system
**Body Font:** the system UI face (-apple-system, BlinkMacSystemFont, SF Pro Text)
**Label/Mono Font:** Bricolage Grotesque for printed labels and tags; ui-monospace / SF Mono / Menlo for code, paths and measurement

**Character:** A printed grotesk with optical sizing sets the headings and the state tags, so 28px titles take the inky large-size drawing and 11px tags the open small-size cut. The system face carries everything you read and type, so the app stays a Mac app.

### Hierarchy
- **Display** (700, 28px / 36px, -0.01em): page titles and the home header. Drops to the headline size below 760px.
- **Headline** (600, 20px / 28px, -0.01em): dialog titles, catalog and section headings.
- **Body Reading** (400, 15px / 1.6): agent replies (markdown), page subtitles, the composer (15px / 24px). Reading notes cap at 76ch.
- **Body** (400, 13px / 1.5): the UI default: nav, buttons, inputs, list rows.
- **Small** (400 to 500, 12px / 16px): field notes, dialog context lines, status text, paths.
- **Label** (600, 11px / 12px, 0.04em, uppercase): printed state tags and change kinds (EDITED, NEW) only.
- **Mono** (400, 11 to 13px, tabular figures): code, file paths, token counts, cost, timings, the status bar model.

### Named Rules
**The Six Sizes Rule.** Type comes in 11, 12, 13, 15, 20 and 28px. Hierarchy is made from these steps and weight, never from a seventh size or a box.

**The Mono Is Measurement Rule.** Monospace appears only for code, paths and numbers that are measured (tokens, cost, time, context). Prose and labels never use it.

**The Caps Are Tags Rule.** Uppercase with tracking is reserved for printed state tags. Headings and section labels stay in sentence case.

## Layout

A fixed 240px sidebar rail (208px below 760px wide) beside a single working column; the chat column and the Workspace's tree / editor / terminal split fill the rest. Every gap and padding sits on one 4px module, mostly 4, 8, 12, 16 and 24px; page gutters are 24px, view toolbars are at least 48px tall with 8px / 24px padding. Controls are 32px tall. Dense where developers expect density (file tree, diffs, task rows), roomy where they read (replies at 15px). The shell tightens at 1080px (page gutters to 24px), 900px (the titlebar title hides) and 760px (narrower rail, smaller home title, stacked catalog filters); short windows (720px tall) pull the home header up. The minimum window is 900 x 700.

### Named Rules
**The 4px Module Rule.** Spacing, control heights and pane sizes are multiples of 4px.

## Elevation & Depth

The page is flat stock. Cards, inputs and buttons carry no shadow; separation comes from 1px rules and the step from paper to raised stock. Depth is reserved for one thing: a sheet that needs the user. Dialogs and popovers lift with a single soft shadow, and the shell behind a modal dims with a paper-coloured veil (55% light, 60% dark) blurred 2px and desaturated to 0.8.

### Shadow Vocabulary
- **Lift** (`box-shadow: 0 8px 24px color-mix(in srgb, #1A1B1F 14%, transparent), 0 1px 0 color-mix(in srgb, #1A1B1F 14%, transparent)`; dark uses `rgb(0 0 0 / 0.45)` for the soft layer): dialogs, popovers and menus. Nothing else.

### Named Rules
**The One Lift Rule.** Only sheets that ask for the user's attention lift. If it is not a dialog or popover, it has no shadow.

**The Grain Is For Ground Rule.** Paper grain prints on the page ground only (3.5% light, 3% dark). Editors, inputs, cards and dialogs are flat raised stock that covers it.

## Shapes

Small, consistent corners, like trimmed card stock: 3px for printed tags, 6px for controls (buttons, inputs, nav and task rows), 8px for cards, dialogs and popovers, and full pills only for meters, toggles and scrollbar thumbs. Dots (status, thinking, jobs) are circles. Borders are 1px everywhere; the only heavier mark is the approval dialog's 3px pink top stripe. Line icons are 14 to 16px strokes at 1.6, round caps and joins, in currentColor.

## Components

### Buttons
Quiet and printed: flat fills, 1px borders, no shadow.
- **Shape:** gently squared (6px), 32px tall, 12px side padding, 13px weight 500, 8px icon gap.
- **Primary:** solid riso blue with white words (dark ink on the dark-mode blue); hover darkens the fill.
- **Secondary:** raised stock with a 1px rule border; hover tints the fill 5% ink and strengthens the border.
- **Ghost:** transparent, hover 5% ink tint.
- **Danger:** raised stock, red words, red border at 55%; red wash on hover. Filled red only inside a destructive confirmation.
- **Focus / Disabled:** 2px riso blue outline at 2px offset; disabled at 55% opacity (primary goes to an ink tint with ink-3 words). Colour transitions take 120ms on the standard ease-out.

### State Tags
The printed marks that make task state legible at a glance; used on task rows, subagents and jobs.
- **Style:** Bricolage Grotesque 600, 11px uppercase, 0.04em tracking, 2px / 6px padding, 3px corners, 1px border.
- **WORKING:** solid fluorescent pink, ink-black words.
- **WAITING FOR YOU:** solid highlighter yellow, ink-black words.
- **DONE:** riso blue outline, deep blue words.
- **FAILED:** red outline, red words.
- **QUEUED / STOPPED:** ink-3 outline, ink-2 words.

### Inputs / Fields
- **Style:** raised stock, 1px rule border, 6px corners, 32px minimum height, 4px / 12px padding, 13px text.
- **Focus:** 2px riso blue outline at 2px offset; hover strengthens the border to 26% ink.
- **Composer:** the exception: borderless 15px text on 24px lines, at least 72px tall, inside a sheet with its controls along the bottom.

### Navigation (the printed rail)
- **Style:** the sidebar is a blue tint printed with a fine halftone screen (two offset dot layers on a 4px cell, a 45 degree lattice) and a blue 1px rule at its edge.
- **Items:** 13px ink-2 words with 16px line icons; hover lays a 5% ink tint.
- **Active:** an opaque solid blue patch that stops the screen at its edge, deep blue words at weight 500. Active task rows use the same patch with ink words.

### Dialogs
- **Sheet:** raised stock, 1px rule border, 8px corners, the Lift shadow; the backdrop dims and blurs the shell.
- **Header:** headline-size title; the context line (12px ink-2) sits beneath the title, never above it.
- **Approval:** the same sheet with a 3px fluorescent pink stripe across its top edge, because the agent is asking.

### Context Meter
A 64 x 6px pill with a 1px blue border at 35%: the window's used share in blue, this reply's part overprinted in pink by multiply.

### The Companion (signature)
A robot-blob printed as the same drawing twice: ink A fluorescent pink, ink B riso blue, overprinted by multiply on paper and screen on deep stock. Its registration is the task state: registered and breathing at idle, drifting while thinking, jittering out of register while working, snapping into register with a small stamp (550ms) when done, stuck out of register with a red dot after an error, with a yellow highlighter swipe behind it while waiting. It comes in three sizes (56px companion beside a running reply, teammates for subagents, minis on task rows). All motion is CSS, transform and opacity only; it stops under Reduce Motion and while the window is hidden, and Preferences can switch every mascot off.

**The brand mark** in the sidebar and About is the companion itself, idle and registered, with every animation and transition off. It is the brand, not a status, so it stays when the companion is switched off.

### Expert Avatars
The friendly character busts are printed, not painted: every fill is reduced to two riso plates (blue and pink) at computed densities over the paper, separately for light and dark stock, so the whole catalog shares the shell's two inks.

### Editor
CodeMirror on flat raised stock (no grain), blue caret, yellow highlighter selection and search matches. Syntax uses the inks at text weight: blue keywords and tags, green strings, pink numbers and regular expressions, deep blue types, ink-3 italic comments, functions in ink at 600.

### Motion
One ease-out curve (cubic-bezier(0.16, 1, 0.3, 1)) at 120 / 200 / 320ms. A view switch settles in from mostly visible (opacity 0.55, 3px rise, 200ms), never from blank. Everything goes still under Reduce Motion.

## Do's and Don'ts

### Do:
- **Do** keep the page ground cool paper (#F3F4F1) with faint grain, and dark mode on deep blue-black stock (#14161B) with fainter grain.
- **Do** use riso blue for every structural mark: active nav, selection, primary action, focus, links.
- **Do** reserve fluorescent pink in the chrome for the agent at work, and print ink-black words on it.
- **Do** use yellow as a highlighter pass under ink-black words for whatever waits on the user.
- **Do** tell task state with the printed tags: WORKING pink fill, WAITING FOR YOU yellow fill, DONE blue outline, FAILED red outline.
- **Do** separate with 1px rules and the step from paper to raised stock before reaching for a box.
- **Do** set sizes from 11 / 12 / 13 / 15 / 20 / 28px and space on the 4px module.
- **Do** mark the selected rail row with an opaque solid blue patch.
- **Do** lift dialogs with the one Lift shadow over a dimmed, 2px-blurred backdrop.
- **Do** let the companion's registration carry state, animate it with transform and opacity only, and keep it still under Reduce Motion.
- **Do** print new illustration and avatars as two-ink duotone in pink and blue.

### Don't:
- **Don't** warm the paper toward cream or beige.
- **Don't** use pink for static controls, branding accents or decoration in the chrome; it means the agent is working.
- **Don't** set yellow text on paper or grey text on yellow.
- **Don't** let halftone dots sit behind words; selected rows are solid patches.
- **Don't** put shadows on cards, inputs or buttons; only dialogs and popovers lift.
- **Don't** grain editors, inputs, cards or dialogs.
- **Don't** add labels or kickers above headings; context lines go beneath the title.
- **Don't** introduce type sizes off the six-step scale or uppercase outside state tags.
- **Don't** use monospace for prose or labels.
- **Don't** animate the brand mark.
- **Don't** fade a view in from nothing; it settles in from mostly visible.
