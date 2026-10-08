/**
 * Smoke test: connects to a maas server as an MCP client and exercises the tools.
 *   MAAS_URL=http://localhost:8080/mcp MAAS_TOKEN=... npx tsx scripts/smoke.ts [--full]
 * --full also exercises the LLM-backed tools (remember with wait, recall).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MAAS_URL ?? "http://localhost:8080/mcp";
const token = process.env.MAAS_TOKEN;
const full = process.argv.includes("--full");

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "X-Maas-Client": "smoke-test" } },
});
const client = new Client({ name: "maas-smoke", version: "0.0.1" });
await client.connect(transport);

const show = (r: any) => console.log(r.content?.map((c: any) => c.text).join("\n"), "\n");
const call = async (name: string, args: Record<string, unknown> = {}) => {
  console.log(`=== ${name} ${JSON.stringify(args)}`);
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  show(r);
  return r;
};

console.log("instructions:", client.getInstructions()?.slice(0, 120), "…\n");
console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "), "\n");
await call("memory_context");
await call("memory_read");

if (full) {
  await call("remember", {
    observation:
      "The user (Chris) prefers TypeScript with strict mode and pnpm over npm. They dislike default exports. " +
      "They are building 'maas' (memory as a service), an MCP server backed by a memory agent, hosted on Google Cloud Run.",
    context: "smoke test session",
    wait: true,
  });
  await call("remember", {
    observation: "Correction: Chris actually uses bun as package manager for new projects now, not pnpm.",
    context: "smoke test session",
    wait: true,
  });
  await call("recall", { question: "Which package manager should I use for Chris's new JS project, and why?" });
  await call("memory_context");
}
await call("memory_log", { limit: 5 });
await client.close();
