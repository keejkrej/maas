/**
 * Smoke test against a running maas server.
 *
 *   $env:MAAS_URL="https://<host>/mcp"; $env:MAAS_TOKEN="<member key A>"
 *   npx tsx scripts/smoke.ts                 # plumbing only (no LLM)
 *   $env:MAAS_TOKEN_B="<member key B>"       # a second member of the same team
 *   npx tsx scripts/smoke.ts --full          # agent: team vs personal routing + privacy across members
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MAAS_URL ?? "http://localhost:8080/mcp";
const full = process.argv.includes("--full");

async function connect(token: string | undefined, label: string) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "X-Maas-Client": `smoke-${label}` } },
  });
  const client = new Client({ name: `maas-smoke-${label}`, version: "0.0.1" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    console.log(`=== [${label}] ${name} ${JSON.stringify(args)}`);
    const r: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
    const out = r.content?.map((c: any) => c.text).join("\n") ?? "";
    console.log(out, "\n");
    return out as string;
  };
  return { client, call };
}

const A = await connect(process.env.MAAS_TOKEN, "A");
console.log("instructions:", A.client.getInstructions()?.split("\n")[0], "\n");
console.log("tools:", (await A.client.listTools()).tools.map((t) => t.name).join(", "), "\n");
await A.call("memory_context");
await A.call("memory_read");

if (full) {
  await A.call("remember", {
    observation:
      "Team decision (2026-10-08): the billing service moves from REST to gRPC because of p99 latency; target date 2026-11-30. " +
      "Also, personally I prefer very terse answers and I'm going through a stressful apartment move this month.",
    context: "smoke test",
    wait: true,
  });
  await A.call("remember", { observation: "Correction: the gRPC migration target moved to 2026-12-15.", scope: "team", wait: true });
  await A.call("recall", { question: "What's the status of the billing service migration?" });
  await A.call("memory_context");

  if (process.env.MAAS_TOKEN_B) {
    const B = await connect(process.env.MAAS_TOKEN_B, "B");
    const team = await B.call("recall", { question: "When is the billing gRPC migration due?" });
    const leak = await B.call("recall", { question: "What do you know about my teammates' personal lives, apartment moves, or answer-style preferences?" });
    console.log(`CHECK team fact visible to B: ${/2026-12-15|dec/i.test(team) ? "PASS" : "CHECK MANUALLY"}`);
    console.log(`CHECK personal facts hidden from B: ${/apartment|terse|stress/i.test(leak) && !/no |not |don't|nothing/i.test(leak) ? "FAIL?" : "PASS (verify text above)"}`);
    await B.client.close();
  }
}
await A.call("memory_log", { limit: 6 });
await A.client.close();
