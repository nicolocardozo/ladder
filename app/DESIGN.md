---
name: Ladder
description: Desktop workspace for macOS for working on several repositories with coding agents.
colors:
  circuit-canvas: "#181424"
  circuit-sidebar: "#1A1427"
  circuit-surface: "#211A30"
  circuit-ink: "#F7F4FF"
  circuit-ink-muted: "#A9A6B2"
  circuit-hairline: "#4A4357"
  circuit-control-border: "#6C6777"
  iris-signal: "#AC97FF"
  iris-brand: "#5525CF"
  deep-violet: "#22123C"
  citron-running: "#ECFC7F"
  amber-waiting: "#FDBB69"
  mint-success: "#8CE9B7"
  rose-error: "#FDA4AE"
  circuit-selection: "#362D50"
typography:
  display:
    fontFamily: "Mona Sans Variable, -apple-system, sans-serif"
    fontSize: 26px
    fontWeight: 600
    lineHeight: 32px
    letterSpacing: -0.02em
  headline:
    fontFamily: "Mona Sans Variable, -apple-system, sans-serif"
    fontSize: 21px
    fontWeight: 600
    lineHeight: 28px
    letterSpacing: -0.015em
  title:
    fontFamily: "Mona Sans Variable, -apple-system, sans-serif"
    fontSize: 17px
    fontWeight: 600
    lineHeight: 24px
    letterSpacing: -0.01em
  body:
    fontFamily: "Mona Sans Variable, -apple-system, sans-serif"
    fontSize: 15px
    fontWeight: 400
    lineHeight: 24px
  label:
    fontFamily: "Mona Sans Variable, -apple-system, sans-serif"
    fontSize: 13px
    fontWeight: 500
    lineHeight: 18px
  caption:
    fontFamily: "Mona Sans Variable, -apple-system, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
  code:
    fontFamily: "Monaspace Neon, ui-monospace, SF Mono, monospace"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 20px
rounded:
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
spacing:
  "1": 4px
  "2": 8px
  "3": 12px
  "4": 16px
  "5": 20px
  "6": 24px
  "8": 32px
components:
  button-primary:
    backgroundColor: "{colors.iris-signal}"
    textColor: "{colors.circuit-canvas}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: 32px
    padding: 0 12px
  button-secondary:
    backgroundColor: "{colors.circuit-surface}"
    textColor: "{colors.circuit-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: 32px
    padding: 0 12px
  chip:
    backgroundColor: "{colors.circuit-surface}"
    textColor: "{colors.circuit-ink-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: 28px
    padding: 0 8px
  composer:
    backgroundColor: "{colors.circuit-surface}"
    textColor: "{colors.circuit-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.xl}"
    padding: 12px 16px
  session-row:
    textColor: "{colors.circuit-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 6px 8px
  request-card:
    backgroundColor: "{colors.circuit-surface}"
    textColor: "{colors.circuit-ink}"
    rounded: "{rounded.lg}"
    padding: 14px 16px
---

# Design System: Ladder

## 1. Overview

**Creative North Star: "The quiet control room"**

Ladder is a room where you keep an eye on several jobs at once without anything raising its voice. At a glance you see who is working, with which agent and model, and who is waiting for you; everything else sits a step back. The conversation with the agent is the content: wide, readable, with plenty of air. Navigation, bars and panels are smaller, quieter and denser.

The look comes from Cursor's agents window: dark background, few actions at the top, surfaces told apart by tone rather than by lines. Precision comes from typography: a single family, a short scale, weights that carry the hierarchy. The Circuit identity lives in the details: iris for focus and choices, citron only for work in progress, amber only for what blocks you.

It must not look like: a crowded interface with many overlapping modes, a dashboard SaaS with identical cards and giant numbers, or the first version of Ladder with twelve text sizes, spaced small caps and borders everywhere.

**Key Characteristics:**
- One sans family (Mona Sans) in four weights and a twin monospace (Monaspace Neon) for code, diffs and the terminal.
- Six text steps, the smallest at 12 px.
- Tonal surfaces, thin lines only where they separate work zones.
- State reads without opening anything: shape, label, and the provider icon with the model.

## 2. Colors

**Restrained** strategy: neutrals tinted toward Circuit's violet and an accent under 10% of the surface. Themes change the values, not the roles. The values below are Circuit's, the initial theme; the source of truth remains `brand/themes.json`.

### Primary
- **Iris signal** (#AC97FF): focus, active selection, primary button, the dot on replies waiting to be read. Never decorative.
- **Iris brand** (#5525CF) and **Deep violet** (#22123C): only the app icon in the Dock. In the interface the logo takes the theme's accent (Iris signal in Circuit), except the engraved one in empty states, which stays tone on tone.

### Neutral
- **Circuit canvas** (#181424): conversation background.
- **Circuit sidebar** (#1A1427): second neutral layer for the sidebar and bars.
- **Circuit surface** (#211A30): cards, composer, menus, inspector.
- **Ink** (#F7F4FF) and **Muted ink** (#A9A6B2): primary and secondary text.
- **Hairline** (#4A4357): separator lines, used sparingly.

### Named Rules
**The code rule.** In the Mono themes the interface stays black and white, but code, diffs and the terminal have their own colors (the `syntax` block of `brand/themes.json`).

**The three signals rule.** Citron means "in progress", amber means "waiting for you", rose means "error". No other use, and always together with a shape and a label.

**The hairline rule.** A line only where it separates two work zones (sidebar, conversation, inspector, terminal). Inside a zone, separate with space and tone.

## 3. Typography

**Sans:** Mona Sans Variable (GitHub, OFL), with the system font as fallback.
**Mono:** Monaspace Neon (GitHub Next, OFL), designed to sit alongside Mona Sans.

**Character:** crisp neo-grotesque, slightly technical, calm at small sizes. The monospace has the same x-height and the same tone, so code and text coexist without friction.

### Hierarchy
- **Display** (600, 26/32, -0.02em): title of the new chat and of empty states. Rare.
- **Headline** (600, 21/28, -0.015em): title of settings sections and dialogs.
- **Title** (600, 17/24, -0.01em): session title, panel headers.
- **Body** (400, 15/24): composer text and long-form text. In the conversation the size depends on the chat font: 15/24 with the sans fonts (default), 14/23 with the monospace ones.
- **Label** (500 or 400, 13/18): the whole interface: sidebar rows, tabs, buttons, menus, inspector.
- **Caption** (400, 12/16): metadata, age, shortcuts, badges, second lines.
- **Code** (400, 12/20): code, diffs, commands, terminal.

### Named Rules
**The chat font rule.** Only the conversation (`.chat-md` and the user bubble) uses `--font-chat`, chosen in Settings → Appearance and reflected by `prefs.chatFont` on `<html data-chat-font>`: system sans (default, SF Pro on macOS, 15/24), system monospace (14/23), Mona Sans (15/24) or Monaspace Neon (14/23). Code blocks stay `font-mono` 12 px and stand out from the background. The rest of the app does not change. This is the only exception to the six-steps rule: the 14 px of the monospace chat (an optional choice) is not a step of the scale and comes from `--chat-size`. In the compact view only intermediate messages are 13 px; final answers and the user bubble stay at `--chat-size`. The report in the sub-agent dialog is chat markdown and follows the same font.

**The chat width rule.** Text (answers, user bubble, steps) sits in a centered column whose limit is in pixels: 820 px (Comfortable, default), 1100 px (Wide) or the full view (Full), from Settings → Appearance and `prefs.chatWidth` on `<html data-chat-width>` (`--chat-measure`). The scrolling area is a container (`container-type: inline-size`) and the column is `min(available space, limit)`, with 24 px margins (12 px in the compact view): it behaves the same for a narrow column, a normal monitor, an ultrawide and two side-by-side columns, with no breakpoints. Wide blocks (code blocks, tables, tool output, cards for commands awaiting approval) use `.chat-wide`: with Comfortable they extend beyond the column up to `min(1100px, available space)`, centered on the text; with Wide (1100 px) they match the text, and never cause horizontal scroll; with Full they fill the column. Inside lists and quotes they do not extend. Small tables stay as wide as the text column, centered; large ones grow up to the wide block. Tool output inside the steps (`.chat-wide-sym`) sits with a 21 px inset on each side of the column and, when it extends, is centered on the text. The scrolling area always reserves the scrollbar gutter (`scrollbar-gutter: stable`) and the composer and notes add the same space on the right, so they stay on the text axis. The composer and the notes above it use the same column (`.chat-measure.chat-bleed`), slightly wider than the text by 16 px per side (less in narrow views): the text written in the composer (16 px padding) falls on the same line as the chat. The user bubble sits at 82% of the column and does not exceed 100 ch of the chat font. The app font returns in the children with `.chat-reset`: the chat font is only used to measure `ch` (user bubble). The row height estimate (`chatColumn` in `chat/turns.ts`) derives the characters per line from the same pixel column and from the font metrics, so it changes with view width, setting and font.

**The six steps rule.** Every text uses one of the six steps of the scale, which in Tailwind are `text-xs` (caption, 12), `text-sm` (label, 13), `text-base` (body, 15), `text-lg` (title, 17), `text-xl` (headline, 21) and `text-2xl` (display, 26), defined in `globals.css`. Code uses `font-mono` with `text-xs`. No hand-written sizes, nothing below 12 px.

**The capitals rule.** No spaced small caps. Section labels are in sentence case, 12 px, weight 600, muted tone.

## 4. Elevation

Flat by default, tonal: sidebar, canvas and surfaces are told apart by brightness. Shadows exist only for what floats above the work (menus, popovers, dialogs, palette), and are wide and soft, never hard.

### Shadow Vocabulary
- **Floating** (`0 1px 2px rgb(0 0 0 / .2), 0 12px 32px rgb(0 0 0 / .32)` on dark themes, halved opacities on light ones): menus, popovers, dialogs.

### Named Rules
**The flat rule.** A surface at rest has no shadow. A shadow says "this sits on top and will go away".

## 5. Components

### Buttons
- **Shape:** 6 px radius, 32 px height (28 px in bars and compact cards), 13 px text at weight 500.
- **Primary:** iris background, dark text. One per view at most.
- **Secondary:** surface background, 1 px hairline in the controls color; hover one tone lighter.
- **Ghost:** no background or border, muted text; on hover a light selection background. For actions in bars.
- **Shortcut:** the key sits inside the button at 12 px, muted tone.

### Chips
New chat context (project, branch, folder, agent) and composer choices: 28 px, 6 px radius, 13 px, 14 px icon, no border at rest.

### Cards / Containers
- **Request card:** surface, 12 px radius, amber hairline at 45%, header with icon and request name in amber, sentence case. No side stripe.
- **Modified files card:** closed by default it is a single 22 px header row (arrow, count and +/−, like the per-agent row), with "Review" as a separate button on the right. The file list appears only when open, with surface and 10 px radius, rows of about 26 px.
- Never cards inside cards.

### Inputs / Fields
- **Composer:** surface, 16 px radius, muted hairline that turns iris at 50% on focus; 15 px text; control bar at the bottom with 28 px chips.
- **Fields:** 32 px, 6 px radius, controls hairline, focus with a 2 px iris ring.

### Navigation
- **Sidebar:** 264 px. One project is open at a time, the selected one (muted background and weight 500); the others show only badges. Below sit the live sessions, those to read or with a draft, and the last 5 idle ones, then the "All sessions · N" row, which on hover opens a second 320 px sidebar over the chat (a click keeps it open). Groups you create sit above the list, one level further right. Without a status symbol the title starts at the edge; long titles scroll on hover. Session rows on two levels: title (13 px) and age on the right; below, provider icon, model and activity or branch (12 px muted). Status on the left in a 16 px slot. Selection with the selection background, 8 px radius.
- **Account:** at the bottom of the sidebar, to the left of the gear: initial in a 28 px neutral circle, email (13 px) and agent plans (12 px muted). Opens Settings → Subscriptions.
- **Top bar:** 44 px: on the left `project / branch`, then the tabs and a few actions, including the "Files" button; tabs show the provider icon and title, and the status when not at rest.

### First launch
A single centered screen, at most 560 px wide, with the logo (symbol and name, 56 px tall, on the left and in the theme's accent) above the title at 24 px weight 600 and a muted sentence at 14 px. Below, the connection rows; at the bottom the "you can do this later" note at 12 px muted and a single button: ghost "Skip for now", which becomes primary (iris) with "Continue" when at least one agent is connected. The same list lives in Settings → Subscriptions.

### Connection rows
A list with a 1 px hairline and 8 px radius, one row per service (Claude, ChatGPT / Codex, GitHub), spacing 16 px horizontally and 14 px vertically. On the left the service mark; in the center the name (14 px, weight 500), an optional plan in a chip with hairline and the status at 12 px with a 12 px icon: "Connected" in mint, "Signing in…" muted with a spinning ring, "Problem" in rose with a warning, "Not signed in" muted with a dashed circle. Below, at 12 px muted, the account or purpose; errors in rose with the alert role, except a deliberate cancellation, which stays muted. On the right small buttons (28 px): "Sign in" secondary (and "Try again" after an error), "Cancel" during sign-in, "Switch account" and "Sign out" ghost when connected. Buttons stay disabled until the host responds and focus moves to the primary action that takes over. "Switch account" always asks for confirmation; "Sign out" only for Claude, whose sign-in is shared with Claude Code. The confirmation is a muted box inside the row (6 px radius, 12 px text): focus goes to "Cancel", Esc closes only the confirmation and returns focus to the button that opened it. While the tool is downloading, a 4 px pill-shaped bar in the theme's `running` color (the same "in progress" as the agents; citron only in Circuit), with bytes and percentage in tabular figures below; if the size is unknown the bar pulses at two fifths. Iris stays reserved for focus, selection and the primary button.

### Agent catalog
In Settings → Agents, under "Your agents": "Most used" (curated) and "More from the ACP registry" behind a search, in lists with a 1 px hairline and 8 px radius like the connection rows. Each row has a mark, name (14 px, weight 500), description at 12 px muted and a source line ("Binary from {host} · v{version}", "Starts with npx on first use"). On the right a single small button (28 px): "Add" for detected CLIs and npx/uvx packages, "Download and add" for binaries, "Update" when there is a new version and the download is known, "Cancel" during download, "Try again" after an error. Never a download without confirmation: the muted box inside the row (6 px radius, 12 px) shows name, version, origin host and where the checksum comes from (ACP registry or GitHub release), then "Download and add" and "Cancel". Focus goes to "Cancel", Esc closes only the box and returns focus to the button that opened it. Entries whose download has no verifiable checksum stay unavailable, with no button, with the reason at 12 px muted: Ladder does not download them. If the host does not provide the download data, "Update" does not appear. When an agent is removed from "Your agents" the row goes back to "Add" immediately. Progress bars are the same as the connection ones.

**Security and sign-in (LAD-56).** The confirmation box (same muted box, 6 px radius, 12 px) has a two-column table: version, origin host, size ("Unknown" if unknown; binary units KiB, MiB, GiB, like the limits; the unit goes up when the rounded value reaches 1024, so 1048575 bytes is "1 MiB") and SHA-256 checksum with its origin. The box is offered only with a known checksum and no block: never an "unknown checksum" row. The checksum is shown abbreviated (first 8 and last 8 characters) with "Show full checksum" that opens it in groups of 8 and a "Copy checksum" (the accessible name is the text, the outcome "Checksum copied" is announced separately) that always copies the whole thing. With an unknown checksum, or `checksum-unavailable`, the muted note says "Checksum not available now" with "Try again" (small `outline` button) that rereads the catalog and no link to the site. If the host refuses because version, checksum or host changed, the error stays in the row and the confirmation reopens by itself with the new data and a note in the attention color; this also applies to the `checksum-changed` error (rejected promise or event), for which the row says "The download changed after you checked it" and "Try again" reopens the confirmation only after the reread (disabled while reading), never with the old sha. If the reread makes it unconfirmable, only the right block note remains. An install error does not stay forever, but only the user or a new version overcomes it: the reread removes it if it concerns another registry version (always), or if it has a non-final code (`no-checksum` for a momentary 404, `host` for a redirect) and the entry has no blocks, but in this second case only after a MANUAL read (Rescan, a note's "Try again"). The reread triggered by the refusal itself, or by another event, never removes it: the catalog only checks the registry URL and does not see what the host saw at download, so a redirect to a disallowed host or a momentary checksum rejected by start() remain visible with the note and "Try again". The error code arrives with the `agent.install` event, which fires before the rejection: the rejected promise carries only the message and does not overwrite the event. The raw error text (red line with no code) is not shown while the reopened confirmation or the block note are visible, nor during the reread that follows a refusal: no flicker and no repeated text next to the confirmation. Signature, team, quarantine, too large and `checksum-conflict` are final: they stay as long as the registry version is the same. A `checksum-conflict` (rejected promise or event: same state) is a warning in the attention color, with no "Try again" and without reopening the confirmation. A confirmation that reopens by itself moves focus to Cancel only if it was already in the row; if the row has just appeared (a search that shows it, a group that opens) focus stays where it is, for example on the search field while typing, and the confirmation is announced with a `role="status"` ("A confirmation for … is open. Check the details before you confirm."). Confirmations to reopen live in a per-agent map (two close rejections do not cancel each other); for a row in the closed "More from the ACP registry" group the group opens, so the row mounts and reopens the confirmation right away. An open confirmation that changes before your eyes shows the same note in the attention color. The host is shown as it is: `github.com/owner/repository` for GitHub. With an update available but the checksum not readable now, below the row there is a muted note ("Update to v… is available, but the checksum is not available now") with "Try again". An agent's progress bar writes bytes in KiB, MiB, GiB like the confirmation; the connections one stays in MB. Entries Ladder does not download show below the description a muted note (`bg-muted` box, 6 px radius, 12 px) with a title at weight 500, the explanation and "Open the install guide" (link with icon, opened with `openExternal` only if https), with no download button; a checksum conflict is instead a warning (border and icon in the attention color, announced as an alert). If the CLI is already detected it stays "Add". The signature sits in the installed agent's row and at the end of installation, at 12 px muted with an icon: "Signed by …", "Signature intact, signer not verified" (no name, same icon as ad hoc), "Ad hoc signature, signer unknown", "Not signed", never words like "safe" or "trusted"; a signature, team or quarantine error is the same note, announced, and does not offer "Try again". `team` (curated with a pinned developer, unsigned, ad hoc or other-team download) has its own text and title ("Not signed by the developer Ladder expects"), never "the signature does not hold", which belongs only to `signature`; the expected team is not shown because the contract does not carry it. The sign-in of an already added agent that requires it is a muted box below the row: a small button for each agent-type method ("Sign in", then "Try again" after an error), which stays in place with `aria-disabled` while waiting (state announced), for terminal methods a text with no button and for unsupported ones the name, "Ladder does not support this sign-in method." and the description, with no button. "Stop waiting" sends the cancellation to the host and the state stays "required", ready for a new "Sign in". A last line at 12 px faint reminds that Ladder does not see the credentials.

### Other agents found on your Mac
In first launch, below the connection rows and 24 px away: section "Other agents found on your Mac" with title at 12 px weight 600 muted and a ghost "Hide" on the right. Lists only CLIs already installed and detected, each with "Add". "Hide" hides it only for the current session: at the next launch it reappears if there is still something to add.

### Agent Mark (Signature Component)
Monochrome provider icon (Claude Code, Codex, the ACP agent's icon from the registry, otherwise an initial) at 12–16 px, always next to the model name when there is room. It says who is working without opening the session: sidebar, tabs, header, "Waiting", ⌘K, agent menus, composer.

### Engraved logo
In the empty states of chats the logo is symbol only, centered and large (112 px tall), carved into the surface: fill slightly darker than the background, inner shadow at the top, light 1 px hairline below. Three values derived from `--background` (`.ladder-engraved` in `globals.css`), so it works for every theme. Decorative: hidden from assistive technologies.

### Files in tabs
An editable file is a tab next to the chats: icon, name and a dot in place of the × while there are unsaved changes. The editor uses the Code step (12/20) and the theme's code colors. Above the text a 32 px bar with the path, "Save" only when needed and the open-in-Cursor action; warnings (agent at work, file changed on disk) sit in a row below, never in a dialog. The dialog exists only for closing with unsaved changes.

### Effort
In the model menu: label with the level in parentheses and a 100 px pill-shaped slider with a notch for each level the model accepts. The filled part is in the accent, the thumb in the text color. You click, drag or use the left and right arrows.

### Default badge
Marks the model (in the composer menu) and the effort level a session starts with when it has not chosen them: component `default-badge.tsx`, 16 px tall, 4 px radius, 12 px muted on a `foreground/10` background, to the right of the name. The tooltip gives the source: "Default from Ladder settings (project)" or "(all projects)", or "Default of Claude Code". With no choice, the composer shows the effective model and level (Ladder's default, then the agent's), never "Default model" if the name is known; "Reset to default" at the bottom of the section removes the explicit choice. In settings, where there is "Inherit", the effective name is shown.

### Shortcuts and badges
Shortcuts use a single component (`ui/kbd.tsx`): one key per symbol, 18 px, system font, light background in the text color. The request count is a light amber pill with icon and number; the to-read one is an iris dot with the number beside it. No exclamation marks.

### Message queue
Above the composer, a header at 12 px muted with the clock icon: "Sends when the turn ends" (weight 500) and after the middle dot the reason, for example "3 agents working". When the session is idle it says instead "Waiting · send a message to continue", because messages do not go out by themselves. Each row is dashed, with text editable by clicking; on the right "Send into turn" (only if the agent allows it) and "Send now" as 20 px text buttons at 12 px muted, then the ×. "Send now" stops the turn: the tooltip says so, no confirmation.

Plan usage limits (`composer/usage-button.tsx`, `composer/usage-banner.tsx`): no cap on active sessions, only warnings near the limits. With a window of the profile in use at 80% or more, `limited`, or `warning` when the percentage is missing (extra usage, with no reset, does not count), the usage icon becomes a warning triangle (different shape, not just color: amber, red when the limit is exhausted) with an aria-label that names the window, and the popover opens with a muted line (12 px, `attention/10` or `destructive/10` background) saying which window is near the limit and when it resets, in local time. Below the threshold the icon stays the chart one and there is no line. The small banner above the composer appears only from 95% or at an exhausted limit, even in the compact view: 12 px row, 8 px radius, hairline and `attention` (or `destructive`) background, with the profile name if the agent has more than one and a 20 px ×. Once dismissed, it stays dismissed until the window resets (localStorage per agent, profile, window and reset to the minute; shared across columns; with no reset it lasts only in memory). Icon and banner turn off by themselves at reset. In the chat nothing is duplicated: Claude already sends its own note. **Limits panel (LAD-82).** The popover (w-80, fixed header and a list that scrolls up to `min(60vh, 440px)` with the usual minimal bar) is called "Plan limits": under the title, at 12 px muted, "Updated … ago" for the oldest data among the subscriptions shown (or "Updating…", or "Update failed · …"), and on the right the 24 px "Refresh all usage" button that rereads all of them in parallel (`agents.usage` for each agent and native profile; on open only those older than 60 seconds or never read). The button stays in place while reading (`aria-disabled`, `aria-busy`, spinning icon) and the outcome is announced in a hidden `role="status"` region. The list has one subscription per entry (`li` with an `h3` header): agent logo (14 px), name "plan · profile" (the profile only if the agent has more than one) as a button that opens Settings → Subscriptions on its row (with `focusConnection(…, { highlight: true })`: the row scrolls into view, takes focus and is highlighted for 1.8 seconds with `bg-accent/60`; the name is not a button for ACP agents, which say "Usage isn't available for this agent."), "N sessions in use" at 12 px muted when there is at least one (same agent and profile, sessions that are `running`, `starting` or `waiting`, plus idle ones with sub-agents still at work, because they consume the same plan; `sessionsInUse` in `lib/usage-accounts.ts`), then the windows with the compact `UsageRow`. The open session's account comes first, then Claude and Codex in the order of Settings, one profile after another. A subscription near the limit (same threshold as `usageAlert`) has the warning triangle next to the name (amber, red when the limit is exhausted, with an aria-label that names the window); the muted sentence below the header, the icon in the composer and the banner remain only for the open session's account. A subscription with no data says "No usage data yet…" with a 24 px button that rereads only that one; "Update failed" appears only if the request fails, and an empty read is not repeated at every open before 60 seconds. The open session's account is always there, even if its profile has been removed. In Settings → Subscriptions the limits block of each profile is always open (not collapsible) and shows the plan windows (5 hours and weekly, not the per-model ones) with the same sessions in use and the same warning sign above them.

### Message sent into the turn
A user message that entered the running turn carries below the text, right-aligned, the line "Sent into the turn": 12 px muted with a wrap-back arrow (12 px). In summarized turns it stays visible after the recap. The agent's output is never lost: if it arrives when there is no open turn (for example a background sub-agent that finishes while the session is idle), Ladder opens a turn to show it, which counts like the others.

### Sending during a turn
The send key does what the setting says (inserts into the turn or queues); with ⌥ (Alt) added it does the other action, and when idle ⌥ has no effect. The button and the placeholder say "Send into turn" or "Queue" according to what actually happens, and the tooltip shows both combinations with `Kbd`.

### Agent Map
Badge in the composer's bottom bar, to the right of the flexible space and before the context indicator, only when the session has started sub-agents: 28 px, 6 px radius, 12 px muted, no border at rest. In progress: citron ring and "N running"; none in progress: gray icon and "N agents"; with errors a 6 px rose dot is added. In narrow columns only the number remains. It opens a popover at most 34 rem wide: at the top "Agents" and the summary; beyond 15 agents, below it a row with search and two filters (type, status) at 28 px. The list is virtualized (`@tanstack/react-virtual`, fixed-height rows) and ordered in sections: in progress, then with errors or stopped, then completed in a closed group "86 completed". Children sit under the parent, indented by 14 px, with a chevron to collapse them; a running child keeps its parent among the running agents. With a filter active the list is flat. 44 px row: status in a 16 px slot, task at 13 px and duration on the right in tabular figures; below, at 12 px muted, type, model (if not known, the session's one with "inherited"), effort and "background", and on the right the tokens. Up and down arrows move focus between rows; a click opens the dialog and closes the popover. In the sidebar the count is enough: "2 agents" at the end of the second line.

End of background sub-agents (`agentsNotice`): the idle session has a state of its own, in the sidebar, in "All sessions", in the inbox among the replies to read and in the tabs. Agents finished: iris "unread" dot and a muted "Subagents finished" note. With errors: red triangle and a red "1 subagent failed" note, no amber (amber stays for what blocks you). It resets when you open the session or look at it with the window in the foreground. In the chat the turn opened by the agent, with no user message, starts with a system line (14 px bot icon and "Started by the agent after background agents finished", 14 px muted, like the command rows).

### Sub-agent graph (LAD-81)
The Agent Map popover has two views, "Graph" and "List", chosen with a two-segment selector in the header (`muted` background, 20 px segments, 6 px radius, 12 px; the active one has the selection background, `aria-pressed`). The choice is kept in `localStorage` (`ladder.agentMapView`). With no choice the graph is the view up to 12 agents and the list beyond; the view and the 40 limit are decided once when the popover opens and do not change under the cursor (if agents exceed 40 while the popover is open the graph stays until the next opening). Beyond 40 agents the graph is not proposed: the "Graph" segment stays but turned off (`aria-disabled`, muted, tooltip "The graph is available up to 40 agents. Use the list.") and the view is the list, which has search and filters as before. In the graph view a 24 px "Expand" button with a 14 px icon sits to the right of the selector.

The graph has the session at the top ("This session" with the count) and one node per agent on the levels below, children under the parent. Each level is a single row, never wrapping: if the graph is wider than the popover it scrolls horizontally (the app's minimal bar) and the node that takes keyboard focus is brought into view. The layout is computed by hand (`lib/agent-graph.ts`, no library): each node's width is measured on the title with the real font (from 124 to 188 px, the title truncates), siblings centered under the parent. The node is a 44 px tall pill, 8 px radius, `muted` background at 60% and a 1 px hairline (`ring`): citron hairline when running, rose with an error, the others neutral. Tall row: status mark in a 16 px slot (spinning ring, mint check, rose cross, muted square as in the list), task at 13 px, duration on the right in tabular figures; below, at 12 px muted, the type. On mouse hover and on focus a tooltip shows the full title, type, model, tokens, tools and, if running, the activity. The links are 1.5 px Bézier curves from the parent's bottom edge to the child's top edge, colored by state in a solid color, with no transparency (with opacity the green dropped to 2.4:1 on the light themes' background, solid stays above 4.8:1): solid citron running, solid mint completed, short dots in rose with an error, long dashes in gray if stopped; links go only between adjacent levels and never cross a node; color is never the only signal, the status mark and the stroke remain. In both light and dark themes the colors come from the tokens (`running`, `success`, `destructive`, `muted-foreground`).

Keyboard and accessibility: `role="tree"` and `role="treeitem"` with `aria-level`, `aria-posinset`, `aria-setsize` and a name that gives title, type, status and duration; no `aria-expanded`, there is nothing to expand. The arrows are spatial, not those of a classic tree, because it is a graph, and the tree's `aria-description` says so. A single tab stop; up and down arrows go to parent and first child, left and right to siblings, Home and End to the first and last; Enter or click opens the detail dialog (with ↑↓ to move among the other agents), which closes the popover. The list remains the complete alternative.

"Expand" opens a nearly full-screen dialog (the window minus 24 px per side): header with "Agent graph", the summary and on the right the 28 px buttons "Zoom out", the percentage, "Zoom in", "Fit to view" and "Close"; below, the graph area and a 36 px footer with the controls. Wheel or two fingers pan the view; zoom (from 30% to 250%, around the pointer) works with trackpad pinch (wheel with ctrl), ctrl or ⌘ and wheel and the buttons, so the trackpad does not zoom by mistake; the `+`, `-` and `0` keys do the same; dragging with the pointer (captured only beyond 4 px, so a click on a node stays a click). On opening, the graph is fitted entirely (never beyond 100%); if fitting would bring the scale below 60% it stops at 60%, centered on the session, and the rest is reached by panning, and with the arrows the node that takes focus is brought into view. The view never leaves the frame completely, with any gesture (drag, wheel, pinch, buttons, keys): at least a part (80 px) of the graph and at least one node stay in view; if not, the view returns toward the center. The percentage is announced only after a click on the zoom buttons. With more than 40 agents the dialog does not draw the graph but points to the list; with no agents it says "No agents yet". The frame does not scroll by itself: the view is the transform, written directly without re-rendering the nodes. Esc closes and focus returns to the badge; opening an agent's detail closes the dialog and focus moves to the detail.

### Session waiting for agents
Idle coordinator and sub-agents still running (`run` idle, `subagentCounts.running > 0`): it is not "to read" and it is not waiting for you. In the sidebar, tabs and "All sessions" the symbol is the 12 px bot in the `running` color (its own shape, no spinning ring) and the note is "Waiting for N agents"; it takes precedence over the notice for agents already finished and over the reply to read, as long as someone is working. In the chat, below the last turn, a 22 px row with the discreet spinner and "Waiting for N background agents" (`role="status"`, 14 px muted). It disappears by itself when the agents finish or a turn starts.

### Agents finished with the coordinator idle
`agents-finished` row at the end of the turn, never inside the recap. "waiting": 14 px bot, "N background agents finished" (with "· N failed" in rose), on the right "Continue" (secondary, 28 px, off while the request is in flight, error in rose below) and below, at 12 px muted, that the agent did not restart by itself. "continued": wrap-back arrow and "Continued". "resumed": "The agent picked up after N background agents finished", hidden if the "Started by the agent" row of the turn opened by the agent already exists. "dismissed": not shown.

### Turn stopped without asking
With `stallHint` active, the end of a turn with no edits, commands, agents or questions has a muted row with the pause icon (14 px): "Stopped without asking anything · Tell it to keep going", and the text button "Write “Continue”" (12 px, iris) that puts "Continue" (translated into the interface language) in the composer without sending it.

### Sub-agent detail
680 px wide dialog, at most 82% of the window tall, with no padding of its own (the zones have theirs) and with a 36 px footer separated by a hairline: header with status, title (17 px, weight 600, two lines at most) and below, at 12 px muted, status, type and "background"; on the right the 28 px buttons "Previous agent", "Next agent" and "Close". The body scrolls on its own: data grid (model, effort, tokens, tools, duration) with labels at 12 px muted, then current activity, prompt in a muted box of 176 px at most, report with the chat markdown in compact version, list of tools used in 24 px rows. Section labels in sentence case, 12 px, weight 600. While the agent is working the detail reloads at most once every 900 ms. Up and down arrows move to the previous or next agent in the popover's order, but only if focus is not on a scrollable area (body, prompt, tools list): there they scroll; with ⌥ they change agent from anywhere. The footer reminds `↑↓`, `⌥↑↓` and the position. Esc closes and focus returns where it was (badge or chat row). For old turns, without agent data, the dialog starts from the title and status of the chat row and completes with what the host answers.

### Sub-agent row in chat
A single 22 px row like the other tool rows: bot icon, "title · type · model" (type and model in a faded tone), duration in monospace and status (ring, check, cross). No expanded prompt and report: a click opens the detail dialog. The link to the agent is the `toolId` or the id equal to the row's; without `SubagentInfo` (old turns) the row uses its own status and the dialog asks for the detail with the row's id.

### Scrollbar
A single one, in `globals.css`, for the whole app: transparent track, 6 px rounded thumb (2 px transparent border and `background-clip: padding-box`) in the text color at 16%, 32% on hover and 44% on drag, so identical in light and dark. Only `::-webkit-scrollbar` is used: from Chromium 121 `scrollbar-width` and `scrollbar-color` disable it, so no other rule sets them. To hide the bar there is the `no-scrollbar` class; the sidebar's ScrollArea draws its own and hides the native one.

## 6. Do's and Don'ts

### Do:
- **Do** use only the six steps of the scale and the code step.
- **Do** separate with space and tone before a line.
- **Do** show provider and model wherever a session appears.
- **Do** give every state a shape and a label besides color.
- **Do** keep the conversation within 68ch, with plenty of air around it.

### Don't:
- **Don't** write hand-set text sizes or anything below 12 px.
- **Don't** use spaced small caps for labels.
- **Don't** use colored side stripes on cards and rows: use a full hairline, a tinted background or an icon.
- **Don't** use citron, amber or rose outside their three meanings.
- **Don't** put cards inside cards or shadows on surfaces at rest.
- **Don't** repeat the session title in two different bars.
