// Approfondimento del criterio 7: dopo turn/interrupt il comando resta vivo come terminale in
// background. Si prova a chiuderlo con i metodi sperimentali thread/backgroundTerminals/*.
import { execFileSync } from "node:child_process";

import type { ThreadBackgroundTerminalsListResponse } from "../generated/experimental/v2/index.ts";
import { CodexAppServer } from "./client.ts";
import { makeTempRepo, readState, recordCheck, runTurn, text } from "./util.ts";

const { model, effort } = readState();
if (!model || !effort) throw new Error("run `npm run probe` first (model selection)");
const pgrep = () => {
  try {
    return execFileSync("pgrep", ["-f", "seq 1 45"]).toString().trim().split("\n").join(",");
  } catch {
    return "";
  }
};

const s = new CodexAppServer({ logName: "bgclean" });
await s.initialize({ experimentalApi: true, requestAttestation: false });
s.setRequestHandler((req) => ({ error: { code: -32601, message: `unexpected ${req.method}` } }));
const repo = makeTempRepo("bgclean");
const { thread } = await s.request("thread/start", { model, cwd: repo, approvalPolicy: "never", sandbox: "workspace-write", ephemeral: true, serviceName: "blue-spike" });
const threadId = thread.id;

let sent = false;
const c = await runTurn(
  s,
  () => s.request("turn/start", { threadId, input: [text("Run this exact shell command and wait for it: `for i in $(seq 1 45); do echo tick $i; sleep 1; done`. Then say done.")], model, effort, serviceTierForTurn: "default" }),
  {
    onEvent: (n, turnId) => {
      if (!sent && n.method === "item/commandExecution/outputDelta") {
        sent = true;
        void s.request("turn/interrupt", { threadId, turnId });
      }
    },
    timeoutMs: 120_000,
  },
);
console.log(`turn → ${c.completed?.status}`);
await new Promise((r) => setTimeout(r, 1000));
const before = pgrep();
const list = (await s.requestRaw("thread/backgroundTerminals/list", { threadId })) as ThreadBackgroundTerminalsListResponse;
console.log(`after interrupt: pgrep=${before || "none"}; backgroundTerminals/list → ${JSON.stringify(list.data)}`);
await s.requestRaw("thread/backgroundTerminals/clean", { threadId });
await new Promise((r) => setTimeout(r, 1000));
const after = pgrep();
console.log(`after backgroundTerminals/clean: pgrep=${after || "none"}`);
recordCheck(
  "7d-background-clean",
  Boolean(before) && !after,
  `dopo interrupt: processo vivo=${Boolean(before)}, backgroundTerminals/list=${list.data.length} voci; dopo thread/backgroundTerminals/clean (sperimentale): processo vivo=${Boolean(after)}`,
);
await s.close();
