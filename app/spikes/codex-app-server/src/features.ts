// Diagnostica: elenco dei feature flag (nessun thread, nessun turno).
import { startServer } from "./util.ts";
const s = await startServer({ logName: "features" });
const res = (await s.request("experimentalFeature/list", { limit: 200 })) as { data: { name: string; stage: unknown; enabled: boolean; defaultEnabled: boolean }[] };
for (const f of res.data) console.log(`${f.enabled ? "on " : "off"} ${f.name} stage=${JSON.stringify(f.stage)} default=${f.defaultEnabled}`);
await s.close();
