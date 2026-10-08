import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { memberAccess, privateRoot } from "./access.js";
import type { TeamMemory } from "./agent/agent.js";
import { activeMembers, type Member } from "./teams.js";

export interface McpCtx {
  tm: TeamMemory;
  member: Member;
  client: string;
}

function instructions(ctx: McpCtx) {
  const team = ctx.tm.team;
  return `This server is the shared long-term memory of the "${team.name}" team (${activeMembers(team).length} members). You are connected as ${ctx.member.name} (${ctx.member.id}).
Behind it is a memory agent that curates a git repo of markdown. You don't write records: you tell the agent what you learned, and it decides what to keep, where to file it, and whether it is team knowledge (visible to all members) or personal (visible only to ${ctx.member.id}).

How to use it:
- At the start of a task, call memory_context to load the team's core memory and ${ctx.member.id}'s personal memory.
- When you need knowledge (team conventions, project context, decisions, who owns what, the user's preferences), call recall with a question.
- Whenever you learn something durable — a decision and its rationale, a convention, a gotcha that cost time, a preference or correction from the user — call remember with a self-contained note. Don't ask permission for routine memories. Never send secrets.
- If something remembered is wrong or outdated, call forget.`;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const visibleFiles = (files: string[]) => files.filter((f) => !f.startsWith(".maas/"));

/** A fresh MCP server per request (stateless Streamable HTTP), bound to the authenticated member. */
export function buildMcpServer(ctx: McpCtx) {
  const { tm, member, client } = ctx;
  const access = memberAccess(member.id);
  const server = new McpServer({ name: "maas", version: "0.2.0" }, { instructions: instructions(ctx) });

  server.registerTool(
    "memory_context",
    {
      title: "Load core memory",
      description:
        "Return the team's MEMORY.md and your personal MEMORY.md (short entry points with core facts and an index of topics). Call once at the start of a session or task.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const c = await tm.context(member.id);
      const pending = tm.pendingObservations(member.id).length;
      return text(
        `# Team memory (${tm.team.name})\n\n${c.team.trim()}\n\n` +
          `# Personal memory (${member.name} — only you can see this)\n\n${c.personal?.trim() ?? "(empty)"}\n\n---\n` +
          `Use recall for details behind any [[link]].` +
          (pending ? ` ${pending} of your observation(s) are still being integrated.` : ""),
      );
    },
  );

  server.registerTool(
    "remember",
    {
      title: "Tell the memory agent something",
      description:
        "Send an observation to the team's memory agent. Write a self-contained note (who/what/why, absolute dates). Batch related facts into one call. " +
        "The agent dedupes, files and reconciles it, and decides per fact whether it is team knowledge or personal to you (override with scope). " +
        "Example: 'We decided to move the billing service from REST to gRPC because of latency; Alice owns the migration, target 2026-11-30.' Never include secrets.",
      inputSchema: {
        observation: z.string().min(3).describe("What you learned, as a self-contained note"),
        scope: z
          .enum(["auto", "team", "personal"])
          .optional()
          .describe("auto (default): agent decides per fact. team: share with the team. personal: keep private to you."),
        context: z.string().optional().describe("Optional provenance: project/repo, session or link, what you were doing"),
        wait: z.boolean().optional().describe("Wait (up to ~90s) for the agent to integrate it and report what changed. Default false."),
      },
    },
    async ({ observation, scope, context, wait }) => {
      const obs = await tm.enqueue({ member: member.id, content: observation, scope: scope ?? "auto", source: context, client });
      if (!wait) return text(`Received by the memory agent as obs/${obs.id}. It will be integrated shortly.`);
      const r = await tm.waitFor(obs.id, 90_000);
      if (!r) return text(`obs/${obs.id} is queued; the agent is still working on it.`);
      const files = r.commits.flatMap((c) => visibleFiles(c.files)).filter((f) => !f.startsWith("sources/"));
      return text(
        `Integrated obs/${obs.id}.\nTeam: ${r.teamMessage}\nPersonal: ${r.personalMessage}\n` +
          (files.length ? `Files: ${[...new Set(files)].join(", ")}` : "No memory files changed."),
      );
    },
  );

  server.registerTool(
    "recall",
    {
      title: "Ask the memory agent",
      description:
        "Ask the memory agent a natural-language question. It searches team memory and your personal memory, follows links, and answers with the facts, who contributed them, and sources. " +
        "Examples: 'How do we deploy the payments service?', 'Who knows the most about our Kafka setup?', 'How does the user like PR descriptions written?'",
      inputSchema: {
        question: z.string().min(3).describe("What you want to know"),
        context: z.string().optional().describe("Optional: what you're working on, so the agent can pick what's relevant"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ question, context }) => text(await tm.recall(member, question, context)),
  );

  server.registerTool(
    "forget",
    {
      title: "Correct or remove a memory",
      description: "Ask the memory agent to delete or correct something (e.g. it's wrong or outdated). Applies to team memory and your personal memory.",
      inputSchema: {
        what: z.string().min(3).describe("What should be forgotten or corrected, and the correct information if any"),
        reason: z.string().optional().describe("Why (e.g. 'user said this is outdated')"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ what, reason }) => {
      const obs = await tm.enqueue({ member: member.id, content: what, kind: "forget", source: reason, client });
      const r = await tm.waitFor(obs.id, 90_000);
      return text(r ? `Done (obs/${obs.id}).\nTeam: ${r.teamMessage}\nPersonal: ${r.personalMessage}` : `Queued as obs/${obs.id}; the agent will apply it shortly.`);
    },
  );

  server.registerTool(
    "memory_read",
    {
      title: "Read a memory file",
      description: `Read a memory file directly, e.g. a [[link]] ('projects/payments' or '${privateRoot(member.id)}/preferences.md'). Omit path to list all files you can see.`,
      inputSchema: { path: z.string().optional().describe("Repo-relative path or wiki link; omit to list files") },
      annotations: { readOnlyHint: true },
    },
    async ({ path }) => {
      if (!path) return text((await tm.repo.listFiles({ access })).join("\n") || "(no files)");
      const rel = await tm.repo.locate(path).catch(() => null);
      if (!rel || !access.canRead(rel)) return text(`Not found: ${path}`);
      return text((await tm.repo.readFile(rel)) ?? `Not found: ${path}`);
    },
  );

  server.registerTool(
    "memory_log",
    {
      title: "Recent memory changes",
      description: "Show recent commits by the memory agent that you can see (team changes plus your personal ones), and queue status.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional().describe("Number of commits (default 15)") },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const log = await tm.visibleLog(member.id, limit ?? 15);
      const meta = await tm.meta();
      const lines = log.map(
        (c) => `${c.sha} ${c.date.slice(0, 16).replace("T", " ")}  ${c.message.split("\n")[0]}\n    ${visibleFiles(c.files).join(", ")}`,
      );
      return text(
        `Team ${tm.team.id} · agent: ${tm.status.busy ?? "idle"} · pending: ${tm.pendingObservations().length} · observations: ${meta.totalObservations} · dreams: ${meta.totalDreams} · last dream: ${meta.lastDreamAt ?? "never"}` +
          `\n\n${lines.join("\n")}`,
      );
    },
  );

  server.registerTool(
    "dream",
    {
      title: "Consolidate memory now",
      description: "Trigger a dreaming pass over team memory and changed personal spaces: merge duplicates, resolve contradictions, prune stale entries, record patterns. Runs in the background.",
      inputSchema: {},
    },
    async () => {
      tm.dream(`requested by ${member.id} via ${client}`, true).catch((e) => console.error("[dream]", e));
      return text("Dream started. Check memory_log in a minute or two to see what changed.");
    },
  );

  return server;
}
