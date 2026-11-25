# S1 · Codex App Server with ChatGPT login

Question: does `codex app-server` (JSON-RPC 2.0 over stdio, JSONL, without the `jsonrpc` field) cover the whole lifecycle of a Blue session using the ChatGPT login already present?
**Answer: yes.** All 10 criteria pass with `@openai/codex@0.167.0`, Plus plan. There are some surprises, though, that change the plan (see "What changes in the plan").

Verified on November 7, 2026 on macOS 26.6 (arm64), Node 24.20.

## How to run

```sh
npm install          # exact versions, outside the pnpm workspace
npm run generate     # types in generated/stable and generated/experimental (ignored by git)
npm run typecheck
npm run all          # or the individual scripts, in the order below
```

| Script | What it does | Thread |
|---|---|---|
| `probe` | handshake, `account/read`, `account/rateLimits/read`, `model/list`, picks the cheapest model | none |
| `run` | `thread/start` in a temporary git repo, turn with files and commands, approvals, streaming; at the end `SIGKILL` of the process | 1 persistent, "blue-spike S1 lifecycle" |
| `resume` | new process, `thread/list`, `thread/read`, `thread/resume`, question about the created file | reuses the one from `run` |
| `steer` | first-delta latency, `turn/steer`, `turn/interrupt` on a long command, next turn | ephemeral |
| `schema` | `outputSchema` on a turn, then a turn without schema | ephemeral |
| `reasoning` | a turn with high effort to see the reasoning deltas | ephemeral |
| `bgclean` | after an interrupt, closes the command left alive with `thread/backgroundTerminals/clean` (experimental) | ephemeral |
| `features` | list of feature flags (diagnostics) | none |
| `events` | distinct methods seen in the logs and mapping to Blue's events | none |

The client is `src/client.ts`: spawn, JSONL, requests with id and timeout, typed notifications, responses to server requests, JSONL log in `results/` (email and account ids redacted). The types come from `generated/stable` with `import type`, so Node does not load them at runtime. `src/util.ts` has the temporary repo, model selection, `runTurn` with the counts. Outcomes in `results/checks.json`, methods in `results/methods.json`.

The login remains the one in `~/.codex` (default CODEX_HOME). The scripts do not read `auth.json` or `config.toml`; from the account they print only type and plan.
Each `npm run run` adds a thread to Codex's history; the other threads are ephemeral. During the spike I created 2, both "blue-spike S1 lifecycle".

## Results

Model used: `gpt-6-luna`, effort `low`, tier `default` (see the gotcha on the tier).

| # | Criterion | Outcome | Evidence |
|---|---|---|---|
| 1 | Handshake | ✅ | `initialize` → `userAgent: blue/0.167.0 …`, `codexHome`, then `initialized`. A second `initialize` → `-32600 Already initialized` |
| 2 | Account and limits | ✅ | `account/read` → `type: chatgpt`, `planType: plus`. `account/rateLimits/read` → bucket `codex`: 14 % of the 300 min window, 11 % of the weekly one, with `resetsAt`. `account/rateLimits/updated` arrives after every model call |
| 3 | `model/list` | ✅ | 8 models: `gpt-6.1-sol` (default), `gpt-6-astra`, `gpt-6.1-terra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`. Effort `low`…`max`, plus `ultra` except the luna models; default `low` or `medium`; a single extra tier, `priority` ("Fast, 2x speed, increased usage"). No prices: picked `gpt-6-luna` ("Fast and affordable") |
| 4 | `thread/start` | ✅ | cwd of the temporary repo, `sandbox: workspaceWrite`, `approvalPolicy: untrusted`. Name set with `thread/name/set` |
| 5 | Approvals | ✅ | 3 requests: file edit accepted (file created), `git add` rejected (item `declined`, file not in the index), following command accepted (exit 0); the turn continues after the rejection and ends `completed`. Order always: `item/started` → `…/requestApproval` → response → `serverRequest/resolved` (within 1 ms) → `item/completed` |
| 6 | Streaming | ✅ | Turn with tools: 41 `item/agentMessage/delta`, 2 `item/commandExecution/outputDelta`, 5 `turn/diff/updated`, 1 `turn/plan/updated`, 5 `thread/tokenUsage/updated`, 5 `account/rateLimits/updated`. Reasoning: 0 deltas with low effort; with high 2 `summaryPartAdded` and 2 `summaryTextDelta`, 204 reasoning tokens. First text delta on a simple turn: 1.7–2.7 s |
| 7 | Steer and interrupt | ✅ | `turn/steer` with `expectedTurnId` → same `turnId`, no new `turn/started`, listing stopped after 1 line, final answer "STEERED". Wrong id → `-32600 expected active turn id …`; without an active turn → `-32600 no active turn to steer`. `turn/interrupt` → `{}` and `turn/completed` with `interrupted` in about 100 ms; the next turn works. **But the command stays alive** (see gotcha) |
| 8 | Resume after kill | ✅ | `SIGKILL` of the process, new process, `thread/read` → `notLoaded`, `thread/resume` (with `excludeTurns`) + `thread/turns/list` → 2 turns, answer "blue-spike.txt". `approvalPolicy: untrusted` and effort persist. `thread/list` finds the thread, but with `sourceKinds: ["appServer"]` it does **not**: the thread is registered as `vscode` |
| 9 | `outputSchema` | ✅ | Final message `{"verdict":"pass","summary":"…","filesTouched":2}`, valid against the schema; the next turn without a schema goes back to free text ("Hello!") |
| 10 | Event mapping | ✅ | 22 distinct notifications, 2 server request types, 10 item/type combinations, all classified (table below) |

Not verified, for lack of time or because they cost quota: `failed` turn due to usage limit (`codexErrorInfo: usageLimitExceeded`), `error` notification with `willRetry`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, MCP calls and web search, `cancel` and `acceptForSession` decisions, login from scratch, multiple threads in parallel on the same process.

## Mapping to Blue's events

| Blue event | From Codex 0.167.0 | Notes |
|---|---|---|
| turn.started | `turn/started` | The response to `turn/start` arrives first, already with the `turnId` |
| message.delta | `item/agentMessage/delta` | |
| message.completed | `item/completed` with `agentMessage` | `phase`: `commentary` (preamble before the tools) or `final_answer`. Useful for the chat hierarchy |
| reasoning | `item/reasoning/summaryPartAdded`, `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta`; `reasoning` item | Summaries arrive as whole titles, not token by token |
| tool.started / completed | `item/started` and `item/completed` for `commandExecution`, `fileChange` (and `mcpToolCall`, `webSearch`, `dynamicToolCall`) | Final status `completed`, `failed`, `declined` |
| tool.output | `item/commandExecution/outputDelta` | Not complete: see gotcha. The authority is `aggregatedOutput` in `item/completed` |
| request.opened | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` (`item/permissions/requestApproval`) | For files the diff is in the preceding `item/started` (`changes[].diff`), not in the request |
| question.opened | `item/tool/requestUserInput` | Not observed |
| request.resolved | `serverRequest/resolved` | Also arrives when the end of the turn cancels a pending request |
| diff.updated | `turn/diff/updated` | Aggregated unified diff of the turn |
| plan.updated | `turn/plan/updated` | Only with `tools.update_plan.enabled` |
| usage / limits | `thread/tokenUsage/updated`, `account/rateLimits/updated` | The second is partial: it must be merged with the last `account/rateLimits/read` |
| turn.completed / failed | `turn/completed` with `status` `completed`, `interrupted`, `failed` (+ `error`) | |
| session state | `thread/status/changed` | `activeFlags: ["waitingOnApproval"]` is the signal for "Needs you" |
| metadata | `thread/started`, `thread/name/updated`, `account/updated` | |
| diagnostics | `mcpServer/startupStatus/updated`, `deprecationNotice`, `warning`, `configWarning`, stderr | Log only |
| ignored | `remoteControl/status/changed`, `thread/goal/cleared`, `turn/moderationMetadata` | The last one arrives only with `experimentalApi` |

## Gotchas

- **Version.** The generated types are valid only for the version that generates them. `generate-ts --experimental` adds about 70 methods (`process/*`, `thread/backgroundTerminals/*`, `thread/queue/*`…) that are rejected without `experimentalApi: true` in the handshake. The server nonetheless sends fields outside the stable types: `availableDecisions` in the approval requests and `emittedAtMs` on every notification.
- **Binary.** `node_modules/.bin/codex` is a JS launcher that on Node 24 does an `execve` of the native binary (same PID, signals arrive directly). In Electron it is better to launch `@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex` directly.
- **sourceKinds.** Threads created by the app-server are registered with `source: "vscode"`, not `appServer`. The default `thread/list` (cli + vscode) already finds them; with `sourceKinds: ["appServer"]` it finds nothing. They therefore also show up in the history of Codex and of the VS Code extension.
- **Thread effort.** `thread/start` does not accept effort: the thread starts with the one from `config.toml` (here `high`). It must be passed on every `turn/start` or with `config: { model_reasoning_effort: "low" }`. The `turn/start` overrides persist for later turns; `outputSchema` does not.
- **Tier.** Every model offers `priority` (2x consumption). The spike passes `serviceTierForTurn: "default"` so as not to inherit a fast tier from the configuration.
- **Plan.** In 0.167.0 the `update_plan` tool is off: without `config: { "tools.update_plan.enabled": true }` in `thread/start` the model says the tool does not exist and `turn/plan/updated` never arrives.
- **Reasoning.** With low effort `gpt-6-luna` does not reason (`reasoningOutputTokens: 0`), so there are no reasoning deltas. With high they arrive, but they are just a few titles.
- **Command output.** The first output block does not arrive as a delta ("tick 1" only in `aggregatedOutput`); short commands produce no deltas.
- **Interrupt.** `turn/interrupt` closes the turn but not the command: the process stays alive as a background terminal, the `commandExecution` item does not receive `item/completed` and the `outputDelta`s keep arriving with the old `turnId`, even during the next turn. It is closed with `thread/backgroundTerminals/clean` (experimental) or when the app-server exits.
- **Steer.** The in-progress `agentMessage` is left without `item/completed`; the steer input arrives as a second `userMessage` in the same turn.
- **Approvals.** With `untrusted` it asks for confirmation for almost everything, even for a `true` launched by the model at shell startup. `availableDecisions` does not list `decline`, which nevertheless works. Server request ids start from 0 on every connection.
- **History.** After resume the rejected command is gone: Codex's history contains only the completed one. Full rehydration in `thread/resume` is deprecated (`deprecationNotice`): use `excludeTurns: true` with `thread/turns/list` and `thread/items/list`.
- **Paths.** On macOS the temporary folder `/var/…` becomes `/private/var/…`, and the `cwd` filter of `thread/list` wants the exact path: always pass the realpath.
- **Base cost.** Every turn starts from about 15k input tokens (system prompt and tools), largely cached. Every thread also starts the `codex_apps` MCP server.
- **stderr.** Logs with ANSI colors (for example `exec_command failed … rejected by user` after a rejection): it should be recorded, not interpreted.

## Recommendation for the Codex adapter

1. One `codex app-server` process per project, as planned: native binary from the pinned version, stdio JSONL, `experimentalApi: false`. Supervision: if the process dies, Blue restarts it and resumes the active threads with `thread/resume` (`excludeTurns`).
2. Client generated from the stable types plus a small method → response map (the bindings do not include it). On a version change: regenerate, `typecheck`, rerun these scripts.
3. `thread/start` with `cwd`, `sandbox`, `approvalPolicy`, `config: { "tools.update_plan.enabled": true, model_reasoning_effort }`. Every `turn/start` with explicit `model`, `effort` and `serviceTierForTurn`.
4. In the adapter, a per-item state machine: at the end of the turn it closes the items left open (steer, interrupt) and discards deltas with a `turnId` different from the active one.
5. Pending requests indexed by process and id, closed by `serverRequest/resolved`. The approval card takes the command or diff from the `item/started` with the same `itemId`.
6. The history is kept by Blue with its own event log (rejections, plans, output). The ids of threads created by Blue are in Blue's database; `thread/list` with a `cwd` filter is only for importing threads born in the terminal.
7. After an interrupt: if a command is left alive, the first solution is to restart the project's process. If it is needed often, enable `experimentalApi` only for `thread/backgroundTerminals/clean`.

## What changes in the plan

- The initial plan assumed that "to also see threads created by Blue, `sourceKinds` must be passed": in 0.167.0 it is the opposite. App-server threads show up as `vscode`, appear by default and also in Codex's history. Blue must recognize its own threads from its database, not from `source`.
- `turn/interrupt` does not stop running commands: one of the two strategies in point 7 is needed.
- `turn/plan/updated` requires enabling `tools.update_plan.enabled`.
- Visible reasoning depends on effort: with low it is often absent, so the UI must not expect it.
- Approvals with `untrusted` are very frequent; for normal use `on-request` remains the right choice, as in the `thread/start` example of the initial plan.
