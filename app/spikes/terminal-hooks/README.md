# S6 · Terminal session state via hooks

Question: can Blue know whether a terminal session (the original CLI in a PTY) is working, waiting for you or finished, by injecting hooks per process and without touching the global configuration?

**Yes for Claude Code, yes with caveats for Codex.** For Claude Code, inline hooks in `--settings` are enough, and they are immediate and precise. For Codex, `notify` and OSC 9 passed with `-c` work. Codex hooks, on the other hand, require the trust saved in `config.toml`, or `--dangerously-bypass-hook-trust`. In both CLIs, rejecting a permission with Esc produces no signal.

## How to run

```sh
npm install              # postinstall: chmod +x of node-pty's spawn-helper (see below)
npm run pty:check        # node-pty loads and opens a 120×40 PTY
npm run hash             # SHA-256 of ~/.claude/settings.json and ~/.codex/config.toml (hash only)

npm run claude                        # trust → permission allowed → AskUserQuestion → permission denied → 75 s wait → /exit
SCENARIO=idle npm run claude          # one turn, then wait for Notification idle_prompt
IDLE_WAIT_MS=3000 npm run claude      # as above, with a short final wait

npm run codex                                          # OSC 9 + notify: approval allowed, then denied
CODEX_NOTIF_METHOD=bel npm run codex                   # BEL instead of OSC 9
CODEX_HOOKS=1 npm run codex                            # hooks via -c, without trust: "Hooks need review" modal
CODEX_HOOKS=1 CODEX_BYPASS_HOOK_TRUST=1 npm run codex  # hooks with --dangerously-bypass-hook-trust
CODEX_DOTTED_REPO=1 CODEX_TRUST_FORM=table npm run codex  # trust for a path containing a dot
```

Each run writes these files in `results/<scenario>-<time>/`: `hooks.jsonl` with the hooks received, `pty.raw` with the raw PTY transcript, `pty-timeline.jsonl` with the timed chunks (input, output, terminal responses, OSC, BEL), `screens/` with the screen rendered by `@xterm/headless` at key moments, and `summary.json`.

Scripts: `src/claude.ts`, `src/codex.ts`, `src/notify.mjs` (Codex's `notify` program), `src/lib.ts` (PTY + headless screen + hook server), `src/toml-keys.ts` (lists the keys of `config.toml` with a short hash of the values, never showing them). The test repos live in `os.tmpdir()`. The child's environment is a whitelist (HOME, PATH, LANG…), without `ANTHROPIC_*`, `CLAUDE*` and `OPENAI_*`, so the subscription login applies.

## PTY

- **`node-pty` 1.1.0 works** on Node 24.20 / macOS arm64 with the included prebuild, without compiling. It is an N-API module (`napi_register_module_v1`), so in Electron `electron-rebuild` should not be needed: to be verified in the F0 scaffold. `@homebridge/node-pty-prebuilt-multiarch` was not needed.
- Pitfall: in the tarball `prebuilds/darwin-arm64/spawn-helper` arrives with `644` permissions, and the first `spawn` fails with `posix_spawnp failed`. The remedy is the `chmod +x` in postinstall. npm 11 blocks dependencies' install scripts (`allowScripts`) and pnpm does the same: the chmod must be done by the project. In Electron the `spawn-helper` must be outside the asar (`asarUnpack`).
- The terminal's responses (DA1, DSR, colors) must be returned to the process by connecting xterm's `term.onData` to `pty.write`, as Blue will do with xterm.js.

## Results

Reference runs: Claude `claude-…T13-08-41` (complete, 75 s wait), `claude-…T13-11-13` (idle), `claude-…T13-23-18` (final); Codex `codex-osc9-…T13-15-24`, `codex-bel-…T13-16-24`, `codex-osc9-hooks-…T13-19-31`, `codex-osc9-hooks-bypass-…T13-20-10`, `codex-osc9-…T13-23-56` (final). Latency = time of the hook minus time of the screen change (negative = the hook arrives first).

| # | Criterion | Outcome | Evidence |
|---|---|---|---|
| A1 | Inline hooks with `--settings '<json>'` (type `command` + curl) | ✅ | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Notification, Stop, SessionEnd arrive; `session_id` = `--session-id` in every payload |
| A1b | `http` handler | ✅ | Works without other settings (UserPromptSubmit, PermissionRequest, Notification, Stop). Arrives ~10 ms before the curl. Header `X-Blue-Token: $BLUE_HOOK_TOKEN` with `allowedEnvVars`: token verified on every call. SessionStart does not support `http` |
| A1c | StopFailure | ⚪ | Key accepted, never fired (no API error) |
| A2 | Folder trust | ✅ | Handled via PTY. In 2.1.316/319 the preselected option is **"No, exit"**: Enter closes Claude (exit 1). ↓ and then Enter are needed. Before confirmation **no** hook arrives; SessionStart arrives ~95 ms later |
| A3 | "Waiting for permission" | ✅ | `PermissionRequest` (tool_name, tool_input.command/description, permission_suggestions) arrives **6–8 ms before** the dialog. `Notification permission_prompt` ("Claude needs your permission") arrives **+6.0 s** later, with a fixed delay in 3 runs out of 3 |
| A3b | Consent via PTY | ✅ | Enter on "1. Yes": the dialog closes in ~25 ms. No hook signals the answer; the first is `PostToolUse` at +400 ms, when the command is done |
| A3c | End of turn | ✅ | `Stop` with `last_assistant_message: "ok"` arrives **11–14 ms before** the spinner disappears |
| A3d | Question (AskUserQuestion) | ✅ | `PreToolUse` + `PermissionRequest` with `tool_name: AskUserQuestion` ~13 ms before the dialog; no Notification within 3 s |
| A3e | Permission denied with Esc | ❌ | **No hook**: no Stop, PostToolUseFailure or PermissionDenied. The JSONL transcript (`transcript_path`) instead records `[Request interrupted by user for tool use]` and `system/turn_duration` |
| A4 | `idle_prompt` | ⚠️ | Arrives exactly **60.0 s after Stop** ("Claude is waiting for your input"), even without focus events. After a rejection it does not arrive (75 s wait). It does not indicate a block |
| B5 | `notify` via `-c` | ✅⚠️ | `agent-turn-complete` with `thread-id`, `turn-id`, `cwd`, `client: codex-tui`, `input-messages`, `last-assistant-message`; token ok. **False positive**: on the first turn it also fires for the internal thread that generates the title (different thread-id, input "Generate a concise, single-line task title…"), 0.4–2 s before the real end |
| B5b | OSC 9 (`tui.notification_method="osc9"`, `notification_condition="always"`) | ✅ | On approval, `Approval requested: /bin/zsh -lc 'date > now.txt'` (truncated if long) arrives in the same chunk as the dialog (0/−1 ms); at the end of the turn OSC 9 with the last message, ~40 ms before notify. Main thread only |
| B5c | BEL | ✅ | BEL on approval and at the end of the turn, but without text: it does not distinguish the two cases |
| B5d | Approval via PTY | ✅ | `y` approves. Esc denies and **emits no signal** (no notify, no OSC, no Stop hook) |
| B5e | Per-process project trust | ✅ | `-c projects.<path>.trust_level="trusted"` works without quotes. With quotes the "Trust this folder?" prompt reappears, because the `-c` path is split on dots. For paths with a dot the table form works: `-c 'projects={"<path>"={trust_level="trusted"}}'` |
| B6 | Codex hooks via `-c` | ⚠️ | Without trust a **blocking modal** "Hooks need review · 4 hooks are new or changed" appears (Review / Trust all and continue / Continue without trusting). With "Continue without trusting" the hooks do not run. With `--dangerously-bypass-hook-trust` (**used only in the `CODEX_BYPASS_HOOK_TRUST=1` scenario**) these arrive: SessionStart at the first prompt, with `session_id` = main thread-id from notify; UserPromptSubmit; PermissionRequest (tool_name Bash, tool_input.command) ~8 ms before the dialog; Stop with last_assistant_message ~40 ms before notify. After a rejection: no Stop |
| C | Global config unchanged | ✅ Claude / ⚠️ Codex | `~/.claude/settings.json` keeps the same hash throughout the spike. `~/.codex/config.toml`: the injected values (notify, tui.notification*, hooks, projects) are never written. The **TUI, however, writes its own interface state**: the first successful launch added `[tui.model_availability_nux] "gpt-6.1-sol" = 1` (certain, key diff); probably also `tui.screen_reader_detection_done` at the 13:11:18Z launch. After adding `-c 'tui.model_availability_nux={"gpt-6.1-sol"=99}'`, six subsequent runs leave hash and keys unchanged (final `76a5b567…` → `76a5b567…`). In the same period the `codex-app-server` spike was adding `[projects."…/blue-spike-codex-*"]`: its changes do not depend on this spike |

## State machine for Claude Code

Blue derives it only from the `command` hooks (or `http`, not both). The key is `session_id`, which Blue chooses with `--session-id`.

| Event | State |
|---|---|
| (startup, no hook) | `starting`. If it stays that way, there is probably the trust dialog: show "open the terminal" |
| SessionStart | `idle` (ready) |
| UserPromptSubmit, PreToolUse(≠AskUserQuestion), PostToolUse, PostToolUseFailure | `running` (detail: tool_name) |
| PermissionRequest(tool ≠ AskUserQuestion) | `waiting:permission` (command, description) |
| PreToolUse / PermissionRequest(AskUserQuestion) | `waiting:question` |
| Notification permission_prompt | confirmation only, arrives 6 s after PermissionRequest; use it if PermissionRequest is missing |
| Notification idle_prompt | no state change (false "waiting": the session is already `done`) |
| Stop | `done` (last_assistant_message for the preview) |
| StopFailure | `error` (`error` field: rate_limit, authentication_failed…) |
| SessionEnd / PTY exit | `exited` |
| **Rejection or interruption (Esc)** | no hook: a fallback is needed (see recommendations) |

## State machine for Codex

| Signal | State |
|---|---|
| Prompt input in the PTY (or UserPromptSubmit hook if trusted) | `running` |
| OSC 9 starting with `Approval requested:` (or PermissionRequest hook) | `waiting:permission` |
| OSC 9 with other text, notify `agent-turn-complete` of the main thread, or Stop hook | `done` |
| notify from another thread-id (title) | to ignore |
| Esc on an approval, Ctrl-C | no signal |
| PTY exit | `exited` |

Without hooks Blue does not know the main thread-id in advance: Codex has no `--session-id`. The most practical approach is to use OSC 9 as the primary source, which concerns only the main thread, and notify as confirmation, discarding the inputs "Generate a concise, single-line task title…". With trusted hooks, the `session_id` of SessionStart solves the problem.

## Pitfalls

- **Claude:** the trust dialog has "No, exit" preselected, and until you accept it no hook arrives. Accepting it writes the folder to `~/.claude.json` (`projects[…].hasTrustDialogAccepted`): the spike left 3 entries for temporary `blue-s6-claude-*` folders.
- **Claude:** without `DISABLE_AUTOUPDATER=1` the CLI updates itself during the session. The spike updated it from **2.1.316 to 2.1.319** (symlink `~/.local/bin/claude`, 14:06) before I added the variable. Subsequent runs use 2.1.319, with the same behavior.
- **Claude:** the `permission_prompt` Notification has a delay of ~6 s, so the immediate state must be taken from PermissionRequest. PermissionRequest hooks are blocking and can decide: Blue's server must answer 200 **with no body**, and curl must use `-o /dev/null`, otherwise the output becomes a decision.
- **Claude:** the token goes in the environment (`$BLUE_HOOK_TOKEN`) and not in the arguments, which are visible with `ps`.
- **Codex:** `approval_policy="untrusted"` is no longer supported in 0.167 and exits with an error at startup. To get an approval you need `-a on-request` with a sandbox that requires it.
- **Codex:** `tui.notification_condition` defaults to `unfocused`. In a PTY without focus events `always` is advisable, or Blue sends `CSI O`/`CSI I` (mode 1004) when the panel loses or gains focus.
- **Codex:** the spike uses `--no-daemon`, so the `-c` overrides apply to this process. Behavior with the shared server (`daemon_auto_start`) was not verified.
- **Codex:** the TUI saves the state of its own notices (model NUX, screen reader detection) in `config.toml`, as it would with a manual launch. Blue cannot prevent this in general: only case by case, with `-c` overrides.
- **Codex:** hook trust is saved in `config.toml` (from the binary's strings it appears to be `hooks.state.<id>.trusted_hash`, not verified). Choosing "Trust all" would therefore write to the global configuration.

## Recommendation for TerminalService

1. **Claude Code:** inline hooks with `--settings`, one handler per event (`http` where supported, `command`+curl for SessionStart and SessionEnd), `--session-id` generated by Blue, token in the environment, local server that answers an empty 200 and discards payloads without a valid token.
2. **Fallback for rejections and interruptions:** when the state is `waiting:*` and no hook arrives, Blue reads the tail of `transcript_path` (from SessionStart). The `system/turn_duration` entry closes every turn, even an interrupted one. It is an internal format, so it must be treated as a heuristic with the label "estimated state". In addition: user input in the PTY while the state is `waiting:permission` and the dialog is gone → `running?`.
3. **Trust:** before starting, Blue checks `~/.claude.json` (only `hasTrustDialogAccepted` for the cwd). If the folder is not trusted, the session starts with the label "confirmation needed in the terminal" instead of "running".
4. **Codex:** `-c` for notify, `tui.notifications=["agent-turn-complete","approval-requested"]`, `tui.notification_method="osc9"`, `tui.notification_condition="always"`, project trust in table form and `--no-daemon`. The state comes from OSC 9 read with xterm.js's `term.parser.registerOscHandler(9, …)`, plus notify filtered by thread. Codex hooks should not be used as long as trust requires writing to `config.toml` or the "dangerous" bypass; they can be reconsidered if Blue accepts having its own hooks trusted once through `/hooks`.
5. The initial plan needs updating (section S6): for Codex, approvals can already be read from OSC 9, so hooks are not needed. For both CLIs an "estimated" state after an Esc must be provided for.
