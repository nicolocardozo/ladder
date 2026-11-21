// Criteri 1–3: handshake, account/read, account/rateLimits/read, model/list. Nessun thread.
import { startServer, pickCheapest, recordCheck, writeState } from "./util.ts";
import { RpcRequestError } from "./client.ts";
import type { Model, ModelListResponse } from "../generated/stable/v2/index.ts";

const s = await startServer({ logName: "probe" });
recordCheck("1-handshake", true, "initialize → risposta con userAgent/codexHome, poi notifica initialized");

// Un secondo initialize sulla stessa connessione deve fallire ("Already initialized").
try {
  await s.request("initialize", { clientInfo: { name: "blue", title: "Blue", version: "0.0.0" }, capabilities: null });
  console.log("second initialize unexpectedly succeeded");
} catch (e) {
  console.log(`second initialize rejected: ${e instanceof RpcRequestError ? `${e.rpc.code} ${e.rpc.message}` : e}`);
}

// 2. Account: si stampano solo tipo e piano.
const acc = await s.request("account/read", { refreshToken: false });
const a = acc.account;
const authMode = a?.type ?? "none";
const planType = a && a.type === "chatgpt" ? a.planType : "n/a";
console.log(`account/read: type=${authMode} planType=${planType} requiresOpenaiAuth=${acc.requiresOpenaiAuth}`);
recordCheck("2a-account", authMode === "chatgpt", `account.type=${authMode}, planType=${planType}, requiresOpenaiAuth=${acc.requiresOpenaiAuth}`);

const rl = await s.request("account/rateLimits/read", { excludeResetCreditDetails: true });
const w = (x: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null) =>
  x ? `${x.usedPercent}% of ${x.windowDurationMins}min, resets ${x.resetsAt ? new Date(x.resetsAt * 1000).toISOString() : "?"}` : "null";
console.log(`rateLimits: ordinaryUsageAllowed=${rl.ordinaryUsageAllowed} limitId=${rl.rateLimits.limitId} plan=${rl.rateLimits.planType}`);
console.log(`  primary:   ${w(rl.rateLimits.primary)}`);
console.log(`  secondary: ${w(rl.rateLimits.secondary)}`);
console.log(`  buckets: ${Object.keys(rl.rateLimitsByLimitId ?? {}).join(", ") || "(none)"}`);
for (const [id, b] of Object.entries(rl.rateLimitsByLimitId ?? {})) {
  console.log(`    ${id} (${b?.limitName ?? "-"}, model=${b?.normalModelSlug ?? "-"}): primary ${w(b?.primary ?? null)} | secondary ${w(b?.secondary ?? null)} | reached=${b?.rateLimitReachedType ?? "-"}`);
}
recordCheck(
  "2b-rateLimits",
  rl.rateLimits.primary !== null || rl.rateLimits.secondary !== null,
  `primary ${w(rl.rateLimits.primary)}; secondary ${w(rl.rateLimits.secondary)}; buckets=${Object.keys(rl.rateLimitsByLimitId ?? {}).length}`,
);

// 3. Modelli.
const models: Model[] = [];
let cursor: string | null = null;
do {
  const page: ModelListResponse = await s.request("model/list", { cursor, includeHidden: false });
  models.push(...page.data);
  cursor = page.nextCursor;
} while (cursor);
console.log(`\nmodel/list: ${models.length} models`);
for (const m of models) {
  const efforts = m.supportedReasoningEfforts.map((e) => e.reasoningEffort).join("/");
  console.log(`  ${m.isDefault ? "*" : " "} ${m.id.padEnd(22)} "${m.displayName}" default=${m.defaultReasoningEffort} efforts=${efforts} tiers=${m.serviceTiers.map((t) => t.id).join(",") || "-"}`);
}
const pick = pickCheapest(models);
console.log(`cheapest pick: ${pick.model} effort=${pick.effort}`);
writeState(pick);
recordCheck("3-model-list", models.length > 0, `${models.length} modelli: ${models.map((m) => m.id).join(", ")}; scelto ${pick.model}/${pick.effort}`);

console.log(`\nmethods received: ${JSON.stringify(Object.fromEntries(s.counts))}`);
await s.close();
