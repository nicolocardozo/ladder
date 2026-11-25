# S2 · Claude Agent SDK

Question: does the TypeScript Agent SDK sustain the long, interactive sessions of Blue's chat, with the Max login already done in the CLI?

Short answer: **yes**. All criteria pass with `@anthropic-ai/claude-agent-sdk@0.3.319`, model `haiku`, `settingSources: []` and the subscription login. Three precautions that the initial plan did not anticipate are needed, though (a cleaned environment, claude.ai connectors turned off, a variable for `session_state_changed`), along with handling of orphan processes.

## How to run

```sh
cd app/spikes/claude-sdk
npm install
npm start            # run.ts: one session, 10 turns (criteria 1-6, 8, 9), ~2 min (approval held for 65 s)
npm run resume       # resume.ts: resumes the last session in a new process + `claude --resume` (criterion 7)
npm run kill         # kill.ts: SIGKILL of the host mid-turn; then `npm run resume`
node probe.ts        # claude.ai connectors and mid-session effort
```

Useful variables: `HOLD_MS` (duration of the pending approval, default 65000), `TOOL_WAIT_MS` (wait before interrupting the command, default 32000), `ONLY=stream,approvals,question,controls,interrupt`, `CLAUDE_BIN` (uses an installed CLI instead of the one bundled with the SDK), `SPIKE_MODEL`.

The test repositories are created in `.tmp/`; the raw logs (JSONL, one event per line) and the summaries in `results/`. Both are ignored by git. Session transcripts end up, as always, in `~/.claude/projects/-Users-…-spikes-claude-sdk--tmp-repo-*`: they can be deleted by hand.

## Results

Run of November 7, 2026, CLI bundled with the SDK 2.1.319, installed `claude` 2.1.316 → 2.1.319 (updated itself during the spike). Logs: `results/run-2026-11-07T13-08-59-291Z.jsonl`, `results/resume-*.jsonl`.

| # | Criterion | Outcome | Evidence |
|---|---|---|---|
| 1 | `query()` with streaming input, multiple turns | ✅ | 10 turns in the same process and the same `session_id`; at turn 2 it remembers the last word of turn 1 ("twelve") |
| 2 | Streaming with `includePartialMessages` | ✅ | 34 `text_delta` in the session; first delta 1.47 s after sending on turn 1 (including process startup), 1.2–1.5 s on the following short turns; `result.ttft_ms` 1.6 s. Haiku sends large chunks: a short reply arrives in 1 delta; the story in 6a had sent 21 when it was interrupted |
| 3 | Approvals with `canUseTool` | ✅ | Sequence `Write:allow → Bash:deny → Bash:allow`; the rejection message reaches the model as an error `tool_result`, the model retries, `notes.txt` ends up staged; `result.permission_denials` lists the rejected call |
| 3b | Pending promise ≥ 60 s | ✅ | `Write` approval held 65 s, `signal.aborted=false`, the turn ends with `success`. During the wait **no** message arrives (no heartbeat). Even **10 minutes** (600 s) go by: see below |
| 4 | `AskUserQuestion` | ✅ | Arrives in `canUseTool` with `input.questions`; answer with `updatedInput: { ...input, answers: { "Which color do you prefer?": "Green" } }`; the model replies "GREEN" |
| 5 | `setPermissionMode('acceptEdits')` | ✅ | Subsequent `Write` without `canUseTool`; `system/status` arrives with `permissionMode: "acceptEdits"` |
| 5 | `setModel('sonnet')` | ✅ | `assistant.message.model = claude-sonnet-5-5`; `modelUsage` with two keys (haiku and sonnet) |
| 5 | `supportedModels()` | ✅ | `default`/`opus` → claude-opus-5-5 "Opus 5.5", `fable` → claude-fable-5-1, `sonnet` → claude-sonnet-5-5, `haiku` → claude-haiku-5-5, plus explicit ids (Opus 5, Sonnet 5, Fable 5, Opus 4.8/4.7/4.6, Sonnet 4.6, Haiku 4.5). Effort low…max on all except Haiku 4.5 (none) and the 4.6 models (no xhigh) |
| 5 | Mid-session effort | ⚠️ | There is no `setEffort()`. `applyFlagSettings({ effortLevel: 'low' })` is accepted without errors, but no event confirms the applied value (`init.effort` is `null` or absent in this transport). At startup there is the `effort` option |
| 6 | `interrupt()` | ✅ | **During text**: `result` `error_during_execution`, `terminal_reason: aborted_streaming`, 9 ms after the call, 0 deltas after. **During a command** (32 s Bash): `terminal_reason: aborted_tools` in 7 ms, command processes terminated within 72 ms, `task_notification` with `status: stopped`. The next turn answers "still here" |
| 7 | Resume in a new process | ✅ | `resume: <id>` in a new process: same `session_id` (no fork), answers "notes.txt, edits.txt" in 2.1 s |
| 7 | `claude --resume <id> -p … --model haiku` | ✅ | Exit 0, same `session_id`, remembers the files and also counts the question asked by the SDK: SDK and CLI write the same transcript (147 → 171 lines). Works with both 2.1.319 and 2.1.316, and SDK 0.3.319 also drives CLI 2.1.316 (`CLAUDE_BIN`) |
| 7 | Resume after SIGKILL of the host | ✅ with a caveat | Resumes and remembers `a.txt`. The `claude` child survives about 8 s after the killed parent: if Blue resumes immediately, two processes write the same session |
| 8 | Message types | ✅ | List and mapping below |
| 9 | Subscription or API key | ✅ | `init.apiKeySource: "none"` (claude.ai login, no key); `accountInfo()`: `subscriptionType: "Claude Ultra"`, `apiProvider: "firstParty"`; there is `rate_limit_event`, which exists only with plans. Also works with `settingSources: []` |

10-minute test, as the initial plan requires (`ONLY=approvals HOLD_MS=600000 node run.ts`, output in `results/hold-10min.out`): ✅ `Write` approval pending for 600 s, `signal.aborted=false`, then `Bash:deny → Bash:allow` and the turn closed with `success` 5 s after the release. Meanwhile another session (`npm start`) ran in parallel without problems.

## Observed message types

Counts from a full session (`run.ts`). The main fields are in the logs.

| Type | N | Notes |
|---|---|---|
| `system/init` | 10 | **One per turn**, not one per session. `apiKeySource`, `model`, `permissionMode`, `claude_code_version`, `cwd`, `tools`, `mcp_servers`, `skills`, `agents`, `plugins`, `slash_commands`, `capabilities` (e.g. `interrupt_receipt_v1`, `ask_user_question_unanswered_v1`), `fast_mode_state`, `effort` (null) |
| `system/session_state_changed` | 30 | `running` / `requires_action` / `idle`. Only with `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` |
| `system/status` | 16 | `status: "requesting"` on every API call; `permissionMode` after `setPermissionMode`; `compacting` when compacting |
| `system/thinking_tokens` | 2 | `estimated_tokens`, `estimated_tokens_delta` |
| `system/task_started`, `system/task_notification` | 1+1 | Bash command as a task: `task_id`, `tool_use_id`, `description`, `status: stopped` after the interruption |
| `stream_event` | 230 | `message_start`, `content_block_start` (text, thinking, tool_use), `content_block_delta` (`text_delta`, `thinking_delta`, `input_json_delta`, `signature_delta`), `content_block_stop`, `message_delta` (stop_reason, usage), `message_stop` |
| `assistant` | 18 | **One message per block** (thinking, text, tool_use), groupable by `message.id`; `message.usage` per call |
| `user` with `tool_result` | 6 | `tool_use_id`, `is_error`, plus structured `tool_use_result` (e.g. `{stdout, stderr, interrupted}` for Bash, patch for Write) |
| `user` with text | 2 | Synthetic: "[Request interrupted by user]", "[Request interrupted by user for tool use]" |
| `user` with `isReplay` | 2 | After `setModel`: `<local-command-stdout>Set model to …</local-command-stdout>` |
| `tool_progress` | 1 | Heartbeat every 30 s: `tool_use_id` = `<id>-heartbeat-0`, the real id is in `parent_tool_use_id`; `elapsed_time_seconds` |
| `rate_limit_event` | 1 | Only on the first request: `status`, `resetsAt`, `rateLimitType` (`seven_day`), `unifiedWindows.seven_day.utilization` (0.09), overage state |
| `result/success` | 8 | `result`, `num_turns`, `duration_ms`, `ttft_ms`, `usage` (for the turn), `modelUsage` (per model, with `contextWindow` 1M and `maxOutputTokens`), `total_cost_usd` (**cumulative** and at list price, `costBasis: "list"`), `permission_denials`, `terminal_reason`, `subagent_stats` |
| `result/error_during_execution` | 2 | Interruptions: `is_error: true`, `terminal_reason` `aborted_streaming` / `aborted_tools`, `errors` with an internal diagnostic |

Expected from the types but not seen here: `system/compact_boundary`, `system/api_retry`, `system/permission_denied`, `system/hook_*`, `system/notification`, `auth_status`, `result/error_max_turns`, `error_max_budget_usd`, subagent events.

### Mapping to Blue's events

| Blue event | From the Agent SDK |
|---|---|
| `turn.started` | Emitted by the host when it puts the message in the queue; confirm with `session_state_changed: running`. The turn's `system/init` updates model, mode and tools |
| `message.delta` | `stream_event` → `content_block_delta` with `text_delta` and `parent_tool_use_id: null` (with a value, it is a subagent). `thinking_delta` → `reasoning.delta` |
| `message.completed` | `assistant` with a `text` block, grouped by `message.id` |
| `tool.started` | `assistant` with a `tool_use` block (`id`, `name`, `input`); `content_block_start` of type `tool_use` to show the spinner immediately |
| `tool.output` | `tool_progress` (uses `parent_tool_use_id`), `task_started` / `task_notification` |
| `tool.completed` | `user` with `tool_result` for the same `tool_use_id`, plus structured `tool_use_result` |
| `request.opened` | `canUseTool` call (`toolUseID`, `title`, `displayName`, `description`, `decisionReason`, `suggestions`, `blockedPath`); shortly before, `session_state_changed: requires_action` arrives |
| `request.resolved` | Promise resolved by Blue; then `session_state_changed: running`. Rejections also end up in `result.permission_denials` |
| `question.opened` / `resolved` | `canUseTool` with `toolName === "AskUserQuestion"`; answer in `updatedInput.answers` (key: question text, value: label; multiple choices comma-separated) |
| `usage` / `limits` | `result.usage` (turn), `result.modelUsage` (maximum context), `total_cost_usd` only as an "equivalent", `rate_limit_event` for the plan limits |
| `turn.completed` | `result/success`; the definitive end signal is `session_state_changed: idle` |
| `turn.interrupted` | `result/error_during_execution` with `terminal_reason` `aborted_*` after a Blue `interrupt()` |
| `turn.failed` | Other `result` with `is_error` (`error_max_turns`, `error_max_budget_usd`, API errors) |
| `session.config` | `system/status` with `permissionMode`; `user` with `isReplay` after `setModel` (to hide in chat) |

## Pitfalls

1. **Inherited environment.** If Blue starts from a Claude Code terminal (for example `pnpm dev`), the environment contains `CLAUDECODE`, `CLAUDE_CODE_SIMPLE` (equivalent to `--bare`), `ANTHROPIC_BASE_URL` (the host app's proxy) and about thirty other variables. It is not enough to remove `ANTHROPIC_API_KEY`: the spike removes all `ANTHROPIC_*` and `CLAUDE*` variables (`lib.ts`, `cleanEnv`).
2. **claude.ai connectors.** With the subscription login the CLI also attaches the connectors of the claude.ai account, **even with `settingSources: []`**. Tools go from 29 to 315 and the session's equivalent cost from 0.034 to 0.090 USD. Above all, a project's agent can read the mail. Blue must pass `settings: { disableClaudeAiConnectors: true }` (verified: `mcp_servers: []`) or `strictMcpConfig: true`.
3. **`session_state_changed` does not arrive** without `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` in the environment: the SDK requests the states for internal use and discards them.
4. **An omitted `permissionMode` means `auto`** (classifier) where available. To get approvals, `'default'` must be passed.
5. **`canUseTool` does not see everything.** Read-only commands (seen with `cat notes.txt`) and edits in `acceptEdits` pass without calling it. The `PreToolUse` hook registered in `run.ts` also sees these calls (verified with the `Write` in `acceptEdits`): it is needed for the log, as planned.
6. **No heartbeat during an approval.** In 65 s (and in 10 minutes) of waiting no message arrives: the "waiting" state must be kept by Blue. Requests do not expire: the SDK types say that permission prompts have no expiry, and the 10 minutes confirm it.
7. **The CLI blocks a foreground `sleep N`** ("use Monitor…"): the model gives up and the turn ends on its own. Other long commands are needed in tests.
8. **Two binaries.** The SDK installs its own CLI (`@anthropic-ai/claude-agent-sdk-darwin-arm64`, 2.1.319, 321 MB) different from `~/.local/bin/claude`, which updates itself. They share login (keychain) and transcripts. For Electron the binary must be left outside the asar and multiplied per architecture, or the user's CLI is used with `pathToClaudeCodeExecutable`.
9. **Orphans.** After a SIGKILL of the host the `claude` child stays alive about 8 s. Blue must remember the PID (or use `spawnClaudeCodeProcess`) and, on restart, wait for it or kill it before resuming the same session.
10. **Noise in the stream.** `system/init` on every turn, one `assistant` per block, synthetic `user` messages after interruptions and `setModel`. The adapter must filter them before the UI.
11. **Costs.** `total_cost_usd` is cumulative and at list price even with the subscription. It should be shown, if shown at all, as an equivalent.
12. **Extra tools.** Even with `settingSources: []` there remain 20 bundled skills, 4 internal plugins and tools such as `CronCreate`, `RemoteTrigger`, `PushNotification`, `SendToProject`, `Workflow`. A `tools` or `disallowedTools` list decided by Blue is advisable.

## Recommendation for the Claude Code adapter

- One `query()` per thread, with an async queue as `prompt` (`InputQueue` in `lib.ts`), kept alive between turns. End of turn on `result`, real end on `session_state_changed: idle`. Close the queue to terminate; `resume: sessionId` to reopen (the `session_id` stays the same).
- Base options: explicit `permissionMode`, `includePartialMessages: true`, `settings: { disableClaudeAiConnectors: true }`, cleaned `env` with `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` and `CLAUDE_AGENT_SDK_CLIENT_APP`, `PreToolUse` hook for the log, `canUseTool` that creates a persistent request and answers when the user decides (even after minutes).
- `settingSources`: the spike uses `[]` and the login works all the same. For real use at least `project` is needed (the project's CLAUDE.md and rules); `user` would also bring personal hooks into Blue's sessions, to be decided.
- Model: `supportedModels()` at startup to populate the selector, `setModel()` mid-session. Effort: `effort` option at startup; mid-session `applyFlagSettings({ effortLevel })`, to be verified once there is a way to read it (or restart with `resume` and a new `effort`).
- Interruption: `interrupt()` is enough; map `terminal_reason` `aborted_*` to `turn.interrupted`.
- Use the CLI bundled with the SDK, version pinned together with the package, and leave `pathToClaudeCodeExecutable` as an option. Transcript compatibility with the user's CLI is verified in both directions (2.1.316 and 2.1.319).
