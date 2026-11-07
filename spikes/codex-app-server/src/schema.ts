// Criterio 9: outputSchema su un turno (thread effimero). Il messaggio finale deve essere JSON
// valido rispetto allo schema; il turno successivo, senza schema, torna a testo libero.
import type { JsonValue } from "../generated/stable/serde_json/JsonValue.ts";
import { printStats, readState, recordCheck, runTurn, startServer, text, makeTempRepo } from "./util.ts";

const { model, effort } = readState();
if (!model || !effort) throw new Error("run `npm run probe` first (model selection)");

const schema: JsonValue & { required: string[]; properties: Record<string, JsonValue> } = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    summary: { type: "string" },
    filesTouched: { type: "integer", minimum: 0 },
  },
  required: ["verdict", "summary", "filesTouched"],
  additionalProperties: false,
};

/** Validatore minimo per lo schema sopra (niente dipendenze). */
function validate(v: unknown): string[] {
  const errs: string[] = [];
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["not an object"];
  const o = v as Record<string, unknown>;
  for (const k of schema.required) if (!(k in o)) errs.push(`missing ${k}`);
  for (const k of Object.keys(o)) if (!(k in schema.properties)) errs.push(`extra ${k}`);
  if (!["pass", "fail"].includes(o.verdict as string)) errs.push("verdict not in enum");
  if (typeof o.summary !== "string") errs.push("summary not string");
  if (!Number.isInteger(o.filesTouched) || (o.filesTouched as number) < 0) errs.push("filesTouched not a non-negative integer");
  return errs;
}

const repo = makeTempRepo("schema");
const s = await startServer({ logName: "schema" });
s.setRequestHandler((req) => ({ error: { code: -32601, message: `unexpected ${req.method}` } }));
const { thread } = await s.request("thread/start", {
  model,
  cwd: repo,
  approvalPolicy: "never",
  sandbox: "read-only",
  ephemeral: true,
  serviceName: "blue-spike",
});
const threadId = thread.id;

const a = await runTurn(s, () =>
  s.request("turn/start", {
    threadId,
    input: [text("Pretend you just reviewed a change that touched 2 files and found no problems. Report the result. Do not run any tools.")],
    model,
    effort,
    serviceTierForTurn: "default",
    outputSchema: schema,
  }),
);
printStats("A (outputSchema)", a);
let parsed: unknown = null;
let parseError = "";
try {
  parsed = JSON.parse(a.finalMessage ?? "");
} catch (e) {
  parseError = String(e);
}
const errors = parseError ? [parseError] : validate(parsed);
console.log(`  parsed: ${JSON.stringify(parsed)}; validation errors: ${errors.length ? errors.join("; ") : "none"}`);

// Lo schema vale solo per il turno in cui è passato.
const b = await runTurn(s, () =>
  s.request("turn/start", { threadId, input: [text("Now say hello in one short plain sentence.")], model, effort, serviceTierForTurn: "default" }),
);
printStats("B (no schema)", b);
let bIsJson = false;
try {
  JSON.parse(b.finalMessage ?? "");
  bIsJson = true;
} catch {
  bIsJson = false;
}

recordCheck(
  "9-outputSchema",
  errors.length === 0 && a.completed?.status === "completed",
  `messaggio finale ${JSON.stringify(a.finalMessage)} → JSON valido rispetto allo schema (${errors.length ? errors.join("; ") : "0 errori"}); ` +
    `turno successivo senza schema → ${bIsJson ? "ancora JSON" : `testo libero ${JSON.stringify(b.finalMessage)}`}`,
);
await s.close();
