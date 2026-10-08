// Local dev server. In production the same Express app runs as the Firebase `api` function (see functions.ts).
import "./env.js";
import { app } from "./app.js";
import { sweepAll } from "./agent/agent.js";
import { config } from "./config.js";

if (!config.adminToken) console.warn("[maas] MAAS_ADMIN_TOKEN is not set — team creation via the API is disabled");
if (!config.llm.apiKey && config.llm.baseUrl.includes("ollama.com")) console.warn("[maas] OLLAMA_API_KEY is not set — the memory agent can't run");

app.listen(config.port, () => {
  console.log(
    `[maas] listening on :${config.port}  (MCP: /mcp, API: /api, viewer: /view/)  store=${config.useFirestore ? "firestore" : "local"} llm=${config.llm.baseUrl} model=${config.llm.agentModel}`,
  );
  // Pick up anything left pending by a previous run.
  sweepAll().catch((e) => console.error("[maas] startup sweep failed", e));
});
