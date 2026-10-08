import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { agent } from "./agent/agent.js";
import { config } from "./config.js";
import { repo } from "./repo.js";

const INSTRUCTIONS = `This server is ${config.ownerName}'s long-term memory, shared across all of their AI tools.
Behind it is a memory agent that curates a git repo of markdown: you don't write records, you tell the agent what you learned and it decides what to keep, where to file it, and how to reconcile it with what it already knows.

How to use it:
- At the start of a task, call memory_context to load the core memory (MEMORY.md).
- When you need specific knowledge (preferences, people, project context, past decisions, how-tos), call recall with a natural-language question.
- Whenever you learn something durable — a preference, a correction from the user, a decision and its rationale, a fact about a person or project, a gotcha that cost time — call remember with a self-contained note. Don't ask permission for routine memories. Don't send secrets.
- If the user says something you remembered is wrong or should be forgotten, call forget.`;

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

/** A fresh MCP server per request (stateless Streamable HTTP). `client` identifies the calling tool. */
export function buildMcpServer(client: string) {
  const server = new McpServer({ name: "maas", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "memory_context",
    {
      title: "Load core memory",
      description:
        "Return MEMORY.md, the short entry point to the user's memory (core facts + index of topics). Call once at the start of a session or task.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const memory = (await repo.readFile("MEMORY.md")) ?? "(empty)";
      const pending = agent.pendingObservations().length;
      return text(
        memory +
          `\n\n---\nUse recall for details behind any [[link]].` +
          (pending ? ` (${pending} observation(s) are still being integrated by the memory agent.)` : ""),
      );
    },
  );

  server.registerTool(
    "remember",
    {
      title: "Tell the memory agent something",
      description:
        "Send an observation to the memory agent. Write it as a self-contained note in natural language (who/what/why, with absolute dates). " +
        "Batch several related facts into one call. The agent dedupes, files and reconciles it with existing memory in the background. " +
        "Good: 'User prefers pnpm over npm in all JS projects; they corrected me when I used npm install.' Never include secrets.",
      inputSchema: {
        observation: z.string().min(3).describe("What you learned, as a self-contained note"),
        context: z
          .string()
          .optional()
          .describe("Optional provenance: project/repo, session or conversation link, what you were doing"),
        wait: z
          .boolean()
          .optional()
          .describe("Wait (up to ~90s) for the agent to integrate it and return what changed. Default false."),
      },
    },
    async ({ observation, context, wait }) => {
      const obs = await agent.enqueue({ content: observation, source: context, client });
      if (!wait) return text(`Received by the memory agent as obs/${obs.id}. It will be integrated shortly.`);
      const r = await agent.waitFor(obs.id, 90_000);
      if (!r) return text(`obs/${obs.id} is queued; the agent is still working on it.`);
      return text(
        `Integrated obs/${obs.id}.\nAgent: ${r.message}\n` +
          (r.commit ? `Commit ${r.commit.sha} touched: ${r.commit.files.filter((f) => !f.startsWith("sources/") && !f.startsWith(".maas/")).join(", ") || "(sources only)"}` : ""),
      );
    },
  );

  server.registerTool(
    "recall",
    {
      title: "Ask the memory agent",
      description:
        "Ask the memory agent a natural-language question. It searches the memory repo, follows links, and answers with the relevant facts and their sources. " +
        "Examples: 'What are the user's coding style preferences for TypeScript?', 'What do I know about the payments project deadline?'",
      inputSchema: {
        question: z.string().min(3).describe("What you want to know"),
        context: z.string().optional().describe("Optional: what you're working on, so the agent can pick what's relevant"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ question, context }) => text(await agent.recall(question, context)),
  );

  server.registerTool(
    "forget",
    {
      title: "Correct or remove a memory",
      description: "Ask the memory agent to delete or correct something it remembers (e.g. the user said it's wrong or outdated).",
      inputSchema: {
        what: z.string().min(3).describe("What should be forgotten or corrected, and the correct information if any"),
        reason: z.string().optional().describe("Why (e.g. 'user said this is outdated')"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ what, reason }) => {
      const obs = await agent.enqueue({ content: what, kind: "forget", source: reason, client });
      const r = await agent.waitFor(obs.id, 90_000);
      return text(r ? `Done (obs/${obs.id}): ${r.message}` : `Queued as obs/${obs.id}; the agent will apply it shortly.`);
    },
  );

  server.registerTool(
    "memory_read",
    {
      title: "Read a memory file",
      description: "Read a file from the memory repo directly, e.g. a [[link]] from MEMORY.md ('people/priya' or 'projects/payments.md'). Omit path to list all files.",
      inputSchema: { path: z.string().optional().describe("Repo-relative path or wiki link; omit to list files") },
      annotations: { readOnlyHint: true },
    },
    async ({ path }) => {
      if (!path) return text((await repo.listFiles()).join("\n") || "(no files)");
      const c = await repo.readFile(path);
      return text(c ?? `Not found: ${path}`);
    },
  );

  server.registerTool(
    "memory_log",
    {
      title: "Recent memory changes",
      description: "Show the memory agent's recent commits (what it remembered, merged or cleaned up), plus queue status.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional().describe("Number of commits (default 15)") },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const log = await repo.log(limit ?? 15);
      const meta = await agent.meta();
      const lines = log.map(
        (c) =>
          `${c.sha} ${c.date.slice(0, 16).replace("T", " ")}  ${c.message.split("\n")[0]}\n    ${c.files.filter((f) => !f.startsWith(".maas/")).join(", ")}`,
      );
      return text(
        `Agent: ${agent.status.busy ?? "idle"} · pending: ${agent.pendingObservations().length} · observations: ${meta.totalObservations} · dreams: ${meta.totalDreams} · last dream: ${meta.lastDreamAt ?? "never"}` +
          (agent.status.lastError ? `\nLast error: ${agent.status.lastError}` : "") +
          `\n\n${lines.join("\n")}`,
      );
    },
  );

  server.registerTool(
    "dream",
    {
      title: "Consolidate memory now",
      description: "Trigger a dreaming pass: the agent merges duplicates, resolves contradictions, prunes stale entries and records cross-session patterns. Runs in the background.",
      inputSchema: {},
    },
    async () => {
      agent.dream(`requested by ${client}`).catch((e) => console.error("[dream]", e));
      return text("Dream started. Check memory_log in a minute or two to see what changed.");
    },
  );

  return server;
}
