// Firebase entry point. Everything scales to zero: no min instances, no always-on CPU.
//
//   api           HTTPS: MCP (/mcp), team API (/api), viewer (/view/)
//   ingest        Firestore trigger: a new inbox item wakes the memory agent for that team
//   sweep         every 10 min: retries and anything left over after a timeout
//   nightlyDream  04:00: queue a dream (consolidation) for every team
import { setGlobalOptions } from "firebase-functions/v2";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { app } from "./app.js";
import { dreamAll, drainTeam, sweepAll } from "./agent/agent.js";

const OLLAMA_API_KEY = defineSecret("OLLAMA_API_KEY");
const MAAS_ADMIN_TOKEN = defineSecret("MAAS_ADMIN_TOKEN");
const secrets = [OLLAMA_API_KEY, MAAS_ADMIN_TOKEN];

setGlobalOptions({ region: process.env.MAAS_REGION || "europe-west1", maxInstances: 10 });

export const api = onRequest({ timeoutSeconds: 300, memory: "512MiB", concurrency: 40, secrets }, app);

export const ingest = onDocumentCreated(
  { document: "teams/{teamId}/inbox/{itemId}", timeoutSeconds: 540, memory: "512MiB", secrets },
  async (event) => {
    await drainTeam(event.params.teamId);
  },
);

export const sweep = onSchedule({ schedule: "every 10 minutes", timeoutSeconds: 540, memory: "512MiB", secrets }, async () => {
  await sweepAll();
});

export const nightlyDream = onSchedule({ schedule: "0 4 * * *", timeZone: process.env.MAAS_TIMEZONE || "Europe/Berlin", secrets }, async () => {
  await dreamAll("nightly");
});
