# S5 · Generic ACP client

Question: does an ACP agent connect to Blue without agent-specific code?
Answer: **yes**. The same client (`src/acp-client.ts`) starts the agent from a configuration entry or from the registry, and covers startup, session, prompt, updates, permissions, cancellation and resume after a kill. The limitations that emerged are in the agent's adapter, not in the protocol.

Agent tested: **`@agentclientprotocol/codex-acp` 2.5.0** (the latest, the same as the registry), which brings in `@openai/codex` 0.165.0. It used the ChatGPT login already present in `~/.codex` without calling `authenticate`. The fallback with Claude was not needed and was not started: `npm run probe -- --registry claude-acp` is ready (it does not consume quota and sends no prompt).

Verified on November 7, 2026 with Node 24.20, SDK `@agentclientprotocol/sdk` 2.4.0, protocol v1.

## How to run

```bash
npm install
npm run typecheck
npm run probe      # 1, 2: initialize, capabilities, session/new, options, cheap model
npm run turn       # 3, 4, 7: files and commands, permissions (allow once, then reject)
npm run cancel     # 5: session/cancel during `sleep 30`, then a normal prompt
npm run resume     # 6: SIGKILL, then session/load and session/resume in new processes
npm run ttfc       # 7: startup and first-chunk times, with empty client capabilities
npm run registry   # 8: downloads the registry and updates registry-sample.json
```

Options: `-- --agent codex|claude` (entries in `src/agents.ts`) or `-- --registry <id>` (entry built from the registry, like "Add an agent"). Variables: `ACP_MODEL` forces the model, `ACP_MODE` the mode, `ACP_SAMPLES` the `ttfc` samples. To debug codex-acp: `APP_SERVER_LOGS=$PWD/results/appserver`.

Each script writes a JSONL in `results/` (ignored by git): every message on the wire (`in`/`out`), the agent's stderr, the normalized Blue events (`blue`) and notes. The test repositories are in `$TMPDIR/blue-acp-*`. Codex sessions still end up in `~/.codex/sessions` (originator `blue-spike`).

| File | What it does |
|---|---|
| `src/acp-client.ts` | `AcpHost`: spawn, SDK 2.x `client()`, handlers for permissions and fs, raw log, prompts with timings |
| `src/normalize.ts` | Mapping from ACP to Blue events (criterion 9) |
| `src/harness.ts` | Scripted permissions, turns, mode selection with approvals |
| `src/agents.ts`, `src/registry.ts` | Agent entries as data; from registry to command |
| `scripts/*.ts` | One script per group of criteria |

## Results

| # | Criterion | Outcome | Evidence |
|---|---|---|---|
| 1 | Spawn over stdio, `initialize` v1 | PASS | `protocolVersion: 1`. `loadSession: true`; `image` and `embeddedContext` prompts (no audio); MCP `http` yes, `sse` no; `sessionCapabilities`: resume, list, close, delete, fork, additionalDirectories (plus subagents and systemPrompt, unstable). `authMethods`: `api-key`, `chat-gpt`. Client capabilities: none needed (`ttfc` runs with `{}`); fs/* and terminal/* never called even when offered |
| 2 | `session/new`, options, cheap model | PASS | `configOptions`: `mode` (read-only, workspace-write, agent = "Auto review" default, agent-full-access), `collaboration_mode` (default, plan), `model` (8 values), `reasoning_effort` (category `thought_level`, low…ultra), `fast-mode` (`model_config`). Also delivered are `modes` (old style) and `models` (old unstable field, no longer in the schema). `set_config_option` model=`gpt-6-luna`, effort=`low`: ok, the response reports all the options |
| 3 | Prompt with file and command | PASS, with gaps | Seen: `agent_message_chunk`, `agent_thought_chunk` (only with gpt-5.6-luna), `tool_call` (edit with `diff` content, read, execute), `tool_call_update` (status; command output in `_meta.terminal_output_delta`), `available_commands_update`, `usage_update`, `session_info_update`. `stopReason: end_turn`. Never seen: `plan` (in Codex 0.165 the model has no planning tool in default mode), `current_mode_update`, `config_option_update`. Gap: a command blocked by the sandbox produces no tool call |
| 4 | `session/request_permission` | PASS | File edit: `allow_once` "Yes, proceed", `allow_always` "…don't ask again for these files", `reject_once` (id `cancel`) "No, and tell Codex what to do differently". Allow once: `hello.txt` written. Reject: `second.txt` not written, but the turn ends with `stopReason: cancelled` |
| 5 | `session/cancel` | PASS | Cancelled 1 s after `sleep 30` started: `cancelled` in 11 ms, `sleep` process terminated; the next prompt answers "OK" with `end_turn` |
| 6 | Resume after kill | PASS | SIGKILL of the adapter (the `codex` child dies too). New process, `session/load`: 564 ms, replays 4 updates before the response (`user_message_chunk`, `agent_message_chunk`, commands, info); the model remembers "BLUEBERRY-42". `session/resume`: 48 ms, no updates replayed, memory intact. `session/list` lists it. Model and effort are **not** restored: they go back to those in `config.toml` |
| 7 | Time to first chunk | Measured | Spawn → `initialize`: 100–135 ms, 250 ms via `npx` (1.7 s on the first cold start). `session/new`: 0.3–1.0 s (once 2.3 s). First `session/update`: 5–40 ms. First `agent_message_chunk` (gpt-6-luna, low): 0.8–1.9 s on trivial prompts, 4.4–5.6 s if tool calls come first |
| 8 | Registry | PASS | 45 agents, version 1.0.0; distribution npx 23, binary 22, uvx 2. No login information. 7 binaries without `sha256`. Sample in `registry-sample.json`. `npm run probe -- --registry codex-acp` starts Codex from registry data alone |
| 9 | Mapping to Blue events | Proposal | Table below and `src/normalize.ts`, used by all scripts |

Reference logs in `results/` (local only): `probe-codex-acp-2026-11-07T12-56-56-537Z`, `turn-codex-acp-2026-11-07T13-03-01-053Z` (with `appserver-turn/`), `turn-codex-acp-2026-11-07T12-59-15-292Z` (invisible commands), `cancel-codex-acp-2026-11-07T13-03-57-888Z`, `resume-codex-acp-2026-11-07T13-04-41-469Z`, `ttfc-codex-acp-2026-11-07T13-05-51-314Z`.

## Pitfalls

**SDK 2.x.** `ClientSideConnection` is gone. You write `acp.client({ name }).onRequest(...).onNotification(...)`, then `app.connect(ndJsonStream(...))` returns a `ClientConnection`; from `connection.agent` you call `request(acp.methods.agent.session.new, …)` and `notify(acp.methods.agent.session.cancel, …)`. `connectWith` closes the connection when the callback finishes: a host that stays alive needs `connect`. The SDK does not spawn processes: the child's stdio must be converted with `Writable.toWeb` and `Readable.toWeb`. `zod` is a peer dependency to install. Async notification handlers run in parallel: ordering must be guaranteed by hand. To log every message it is enough to wrap the `Stream` in two `TransformStream`s. The stable v1 of 2.4.0 already includes session/list, resume, close, delete and `notice`; `usage` in `PromptResponse` exists only in `/unstable` and `models` in `session/new` is no longer in any schema, but codex-acp sends them anyway.

**Capabilities.** Codex does not use the client's fs or terminal: it writes and executes by itself. It still sends a `{ type: "terminal", terminalId }` content even if the client does not announce the terminal, and the real output arrives in `_meta.terminal_output_delta`, which is non-standard. The fs handlers of `AcpHost` are ready but with Codex they were never called.

**Login.** `authMethods` always arrives, even when logged in: Blue must ask for login only if `session/new` fails with `auth_required`. codex-acp sends an extension notification `_auth/status_update` with the account's email and plan: it must be treated as personal data.

**Cheap model.** ACP gives no prices and the names are opaque (Sol, Terra, Luna, Astra). The heuristic looks at the description ("affordable"); Blue must let the user choose or keep a default per agent. The choices are lost with load and resume (with Codex they go back to gpt-5.6-sol/high): they must be saved and reapplied.

**Permissions.** The `kind` is not enough. In codex-acp `reject_once` can be `cancel` (stops the turn) or, for commands, `decline` (continues without executing). Blue must show the option names and expect the turn to end after a rejection.

**Tool calls left open.** After a rejection or cancellation the tool call stays `in_progress` forever. Blue closes it by itself at the end of the turn.

**Invisible actions.** Codex 0.165 uses "code mode": the model calls everything through a JavaScript `exec` tool. Nested calls to `apply_patch` and `exec_command` become items and therefore ACP tool calls; a command blocked by the sandbox does not, because not even the App Server emits the item (verified in the App Server log and in the rollout). In a first attempt gpt-6-luna tried to write the file from a read-only shell: no event, only the final message. This also concerns spike S1.

**Other.** The default mode of codex-acp is "Auto review": it runs in the workspace without asking. After the first turn codex-acp makes one extra call to the model to generate the title. There is no end-of-message event: the boundary is derived from `messageId`, from the first update of another type, or from the end of the turn. The adapter uses the real `~/.codex`, with its `config.toml`.

## Mapping to Blue events

| ACP | Blue event | Notes |
|---|---|---|
| sending `session/prompt` | `turn.started` | client side |
| `agent_message_chunk` | `message.delta` | `messageId` when present |
| boundary or end of turn | `message.completed` | computed by Blue |
| `agent_thought_chunk` | `reasoning` | delta, closing computed as for messages |
| `tool_call` | `tool.started` | `kind` (read, edit, execute…), `title`, `locations`, `rawInput` |
| `tool_call_update` with `content` (text, terminal, diff) or `_meta.*terminal_output*` | `tool.output` | the diff is a per-file proposal (full text, before approval) |
| `tool_call_update` with status `completed` or `failed` | `tool.completed` | `rawOutput` (for example `exit_code`) |
| `session/request_permission` | `request.opened` | key: JSON-RPC id; options with `kind` and name |
| client response, or `cancelled` on cancellation | `request.resolved` | on cancellation the open requests must be closed with `cancelled` |
| `plan` | `plan.updated` | replaces the whole list |
| `usage_update` | `usage` | context window only (`used`, `size`, optional `cost`); turn tokens from `PromptResponse.usage` (unstable); no usage limits |
| `stopReason` `end_turn`, `max_tokens`, `max_turn_requests`, `refusal` | `turn.completed` | |
| `stopReason` `cancelled` | `turn.completed` with interrupted status | |
| JSON-RPC error on `session/prompt` or process exit | `turn.failed` | |
| `user_message_chunk` | history entry | arrives only with `session/load` |
| `available_commands_update` | composer commands | the `/` commands announced by the agent |
| `current_mode_update`, `config_option_update` | session configuration | |
| `session_info_update` | session title | |
| `notice` | notice | |
| methods and fields with `_` | ignored, kept in the raw log | |

What Blue must compute by itself:

- the turn's diff, from git against the checkpoint: ACP only gives per-tool-call diffs, and Codex sends them before approval (in the test there was also that of the rejected file, while `git diff` showed only `hello.txt`);
- the end of messages and reasoning, the duration of turns;
- the closing of tool calls and requests left open at the end of a turn, on cancellation or crash, and the "expired" state of cards;
- the per-thread configuration (model, effort, mode) to reapply after load and resume;
- the history: `session/resume` replays nothing, so the source remains Blue's event log;
- the usage limits, which ACP does not expose;
- restarting the process after a crash, followed by `session/resume`.

## Recommendation for Blue's ACP adapter

1. A single `AcpAdapter` configured by an `AgentSpec` (from the registry or hand-written). Differences between agents remain optional data: default model, variables to strip.
2. SDK 2.4.0 pinned, stable v1 entrypoint; types from `/unstable` only to read optional fields such as `usage`.
3. Capabilities: fs read and write limited to the session roots; terminal off in v1 (added with node-pty); `auth.terminal` when Blue can open a login terminal; no elicitation.
4. Configuration options in place of old-style modes, saved in the thread and reapplied after every load or resume.
5. Resume with `session/resume` and history from Blue's log; `session/load` only to import sessions Blue does not know, from `session/list`.
6. Permission cards with the agent's option names, shortcuts by `kind`, no assumption about what happens after a rejection.
7. Diff from GitService, not from tool calls.
8. Raw JSONL log per session, with the `_auth` notifications redacted.
9. For Claude Code and Codex the native adapters remain the first choice: via ACP, Codex loses the blocked commands, the usage limits, the aggregated diff and the plan.

## What changes in the plan

- Confirmed: "adding an ACP agent costs one configuration entry" for npx and uvx. For binaries Blue must download, verify and extract (7 entries without `sha256`). The registry does not say how to log in: Blue discovers it from `initialize`.
- Confirmed: `session/load` replays the history, `session/resume` does not.
- New: configuration options do not survive load and resume, at least with Codex.
- New: the meaning of rejection changes from agent to agent (with Codex it often stops the turn).
- New: with Codex 0.165 commands blocked by the sandbox produce no events, neither via ACP nor from the App Server. To be checked in spike S1.
- Open: the plan called for two different agents; here only Codex was tested. The second (`claude-acp` or `gemini`) runs with the same scripts by changing `--registry`.

## Second agent: Claude (run without a prompt)

Run after the spike was closed with `npm run probe -- --registry claude-acp` (`@agentclientprotocol/claude-agent-acp@0.101.0`, the user's Claude login, `ANTHROPIC_API_KEY` removed from the environment). Same client, no specific code:

- `initialize` in 7.7 s on first start (download with npx), protocol 1, `loadSession`, `resume`, `fork`, `list`, `close`; no login method exposed, the state arrives with `_auth/status_update`.
- `session/new` in 2 s; modes `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions` (default `auto`); options `mode`, `model`, `effort`.
- `set_config_option` for model (`haiku`) and effort (`low`) works.
- No client-side request (fs, terminal, permissions) during startup.

The prompt was not sent so as not to consume quota: a full turn with permissions remains to be tested.
