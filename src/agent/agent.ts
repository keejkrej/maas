import crypto from "node:crypto";
import path from "node:path";
import { META_DIR, PRIVATE_DIR, SOURCES_DIR, memberAccess, privateDreamAccess, privateRoot, sharedDreamAccess, zoneOf } from "../access.js";
import { config } from "../config.js";
import { runAgent } from "../llm.js";
import { MemoryRepo, today, type CommitInfo } from "../repo.js";
import { blobs } from "../storage.js";
import { activeMembers, registry, type Member, type Team } from "../teams.js";
import { ingestSystem, privateDreamSystem, recallSystem, sharedDreamSystem, type MemberCtx, type PromptCtx } from "./prompts.js";
import { commitTool, ingestCommitTool, readTools, writeTools } from "./tools.js";

export type ObservationKind = "remember" | "forget";
export type ScopeHint = "auto" | "team" | "personal";

export interface Observation {
  id: string;
  kind: ObservationKind;
  scope: ScopeHint;
  member: string;
  content: string;
  source?: string;
  client?: string;
  receivedAt: string;
  attempts: number;
}

export interface RunResult {
  observationIds: string[];
  member?: string;
  teamMessage?: string;
  personalMessage?: string;
  commits: CommitInfo[];
}

interface MetaState {
  lastDreamAt: string | null;
  sharedDreamSha: string | null;
  privateDreamSha: Record<string, string>;
  sinceDream: number;
  totalObservations: number;
  totalDreams: number;
}

const META_DEFAULT: MetaState = {
  lastDreamAt: null,
  sharedDreamSha: null,
  privateDreamSha: {},
  sinceDream: 0,
  totalObservations: 0,
  totalDreams: 0,
};
const BATCH_SIZE = 8;
const MAX_ATTEMPTS = 3;
const SHARED_SPEC = [".", `:(exclude)${PRIVATE_DIR}`, `:(exclude)${SOURCES_DIR}`, `:(exclude)${META_DIR}`];

type Waiter = { resolve: (r: RunResult) => void; reject: (e: Error) => void };

const isNoop = (m?: string) => !m || /^no-?op\b/i.test(m.trim());

/**
 * One team's memory agent. Members push observations; the agent owns the team repo and integrates them
 * one batch at a time (single writer per team), then periodically dreams — once over the shared space
 * and once per member whose personal space changed.
 */
export class TeamMemory {
  readonly repo: MemoryRepo;
  private chain: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Observation>();
  private waiters = new Map<string, Waiter[]>();
  private drainTimer: NodeJS.Timeout | null = null;
  private recent: RunResult[] = [];
  status = { busy: null as string | null, lastError: null as string | null, lastRunAt: null as string | null };

  constructor(readonly teamId: string) {
    this.repo = new MemoryRepo(
      path.join(config.dataDir, "teams", teamId, "memory"),
      `teams/${teamId}/memory.bundle`,
      () => registry.get(teamId).gitRemote,
    );
  }

  get team(): Team {
    return registry.get(this.teamId);
  }

  private get inboxPrefix() {
    return `teams/${this.teamId}/inbox`;
  }

  async start() {
    await this.repo.init({
      "MEMORY.md": `# Memory: ${this.team.name}

Shared memory of the ${this.team.name} team. Loaded at the start of every session of every member,
so it stays short: only what every session needs, plus links to topic files.

## Core facts

## Index
`,
    });
    for (const key of await blobs.list(this.inboxPrefix)) {
      const raw = await blobs.get(key);
      if (!raw) continue;
      try {
        const obs = JSON.parse(raw.toString("utf8")) as Observation;
        this.pending.set(obs.id, obs);
      } catch {
        console.warn(`[${this.teamId}] dropping unreadable inbox item ${key}`);
      }
    }
    if (this.pending.size) {
      console.log(`[${this.teamId}] recovered ${this.pending.size} pending observation(s)`);
      this.scheduleDrain(0);
    }
  }

  // ---------------- public API ----------------

  async enqueue(input: { member: string; content: string; kind?: ObservationKind; scope?: ScopeHint; source?: string; client?: string }) {
    const obs: Observation = {
      id: crypto.randomBytes(6).toString("hex").slice(0, 8),
      kind: input.kind ?? "remember",
      scope: input.scope ?? "auto",
      member: input.member,
      content: input.content.trim(),
      source: input.source?.trim() || undefined,
      client: input.client?.trim() || undefined,
      receivedAt: new Date().toISOString(),
      attempts: 0,
    };
    await blobs.put(`${this.inboxPrefix}/${obs.receivedAt.replace(/[:.]/g, "-")}_${obs.id}.json`, JSON.stringify(obs));
    this.pending.set(obs.id, obs);
    this.scheduleDrain();
    return obs;
  }

  waitFor(id: string, timeoutMs: number): Promise<RunResult | null> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(null), timeoutMs);
      const list = this.waiters.get(id) ?? [];
      list.push({ resolve: (r) => (clearTimeout(t), resolve(r)), reject: (e) => (clearTimeout(t), reject(e)) });
      this.waiters.set(id, list);
    });
  }

  /** Team MEMORY.md + the member's personal MEMORY.md. */
  async context(memberId: string) {
    return {
      team: (await this.repo.readFile("MEMORY.md")) ?? "",
      personal: await this.repo.readFile(`${privateRoot(memberId)}/MEMORY.md`),
    };
  }

  /** Read-only, so it runs concurrently with writes. */
  async recall(member: Member, question: string, context?: string) {
    const res = await runAgent({
      label: `${this.teamId}/recall/${member.id}`,
      model: config.llm.agentModel,
      system: recallSystem(await this.memberCtx(member)),
      task: `Question: ${question}${context ? `\n\nContext from the asking agent: ${context}` : ""}`,
      tools: readTools(this.repo, memberAccess(member.id)),
      maxSteps: 12,
    });
    return res.output || "I couldn't produce an answer.";
  }

  /** Consolidate. Scopes with no changes since their last dream are skipped unless `force`. */
  dream(reason = "manual", force = false): Promise<RunResult[]> {
    return this.exclusive(`dream (${reason})`, () => this.doDream(reason, force));
  }

  pendingObservations(memberId?: string) {
    return [...this.pending.values()]
      .filter((o) => !memberId || o.member === memberId)
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  /** Recent agent runs a member is allowed to see (their own, plus shared-only info from others). */
  recentResults(memberId: string) {
    return this.recent
      .slice(-30)
      .reverse()
      .map((r) =>
        r.member === memberId || !r.member
          ? r
          : { ...r, personalMessage: undefined, commits: r.commits.filter((c) => commitVisibleTo(c, memberId)) },
      );
  }

  /** Commit history filtered to what a member may see. */
  async visibleLog(memberId: string, limit = 30): Promise<CommitInfo[]> {
    const all = await this.repo.log(limit * 3);
    return all.filter((c) => commitVisibleTo(c, memberId)).slice(0, limit);
  }

  async meta() {
    return this.repo.readMeta<MetaState>("state", META_DEFAULT);
  }

  // ---------------- internals ----------------

  private baseCtx(): PromptCtx & { teamMemory: string } {
    return {
      teamName: this.team.name,
      roster: activeMembers(this.team).map((m) => ({ id: m.id, name: m.name })),
      today: today(),
      teamMemory: "",
    };
  }

  private async memberCtx(member: Member): Promise<MemberCtx> {
    const ctx = await this.context(member.id);
    return { ...this.baseCtx(), teamMemory: ctx.team, member: { id: member.id, name: member.name }, personalMemory: ctx.personal };
  }

  private exclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      this.status.busy = label;
      try {
        return await fn();
      } finally {
        this.status.busy = null;
        this.status.lastRunAt = new Date().toISOString();
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  private scheduleDrain(delayMs = 1500) {
    if (this.drainTimer) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.exclusive("ingest", () => this.drain()).catch((e) => console.error(`[${this.teamId}] drain failed`, e));
    }, delayMs);
  }

  private async drain() {
    while (this.pending.size) {
      // Batch observations from the same member (an ingest run acts with that member's access).
      const oldest = this.pendingObservations()[0];
      const batch = this.pendingObservations(oldest.member).slice(0, BATCH_SIZE);
      try {
        const result = await this.ingest(batch);
        this.status.lastError = null;
        for (const o of batch) {
          await this.removeFromInbox(o);
          for (const w of this.waiters.get(o.id) ?? []) w.resolve(result);
          this.waiters.delete(o.id);
        }
      } catch (e) {
        const err = e as Error;
        console.error(`[${this.teamId}] ingest failed:`, err.message);
        this.status.lastError = err.message;
        await this.repo.rollback();
        for (const o of batch) {
          o.attempts++;
          if (o.attempts >= MAX_ATTEMPTS) {
            await blobs.put(`teams/${this.teamId}/failed/${o.id}.json`, JSON.stringify({ ...o, error: err.message }));
            await this.removeFromInbox(o);
            for (const w of this.waiters.get(o.id) ?? []) w.reject(err);
            this.waiters.delete(o.id);
          }
        }
        if (this.pending.size) setTimeout(() => this.scheduleDrain(0), 15_000 * Math.max(1, batch[0].attempts));
        return;
      }
    }
    const meta = await this.meta();
    if (config.dreamEvery > 0 && meta.sinceDream >= config.dreamEvery) {
      this.dream(`auto after ${meta.sinceDream} observations`).catch((e) => console.error(`[${this.teamId}] dream failed`, e));
    }
  }

  private async removeFromInbox(o: Observation) {
    this.pending.delete(o.id);
    for (const k of (await blobs.list(this.inboxPrefix)).filter((k) => k.endsWith(`_${o.id}.json`))) await blobs.delete(k);
  }

  private async ingest(batch: Observation[]): Promise<RunResult> {
    const memberId = batch[0].member;
    const member = this.team.members.find((m) => m.id === memberId) ?? { id: memberId, name: memberId } as Member;
    const date = today();

    // Archive raw observations in the member's source space so facts can cite them.
    for (const o of batch) {
      await this.repo.writeFile(
        `${SOURCES_DIR}/${memberId}/${o.receivedAt.slice(0, 10)}/${o.id}.md`,
        [
          `---`,
          `id: obs/${o.id}`,
          `kind: ${o.kind}`,
          `by: ${memberId}`,
          `scope: ${o.scope}`,
          `received: ${o.receivedAt}`,
          o.client ? `client: ${o.client}` : null,
          o.source ? `context: ${JSON.stringify(o.source)}` : null,
          `---`,
          ``,
          o.content,
        ]
          .filter((l) => l !== null)
          .join("\n"),
      );
    }

    const task =
      `New observations from ${memberId} (${batch.length}). Cite facts like [source: obs/${batch[0].id}; by: ${memberId}; added: ${date}].\n\n` +
      batch
        .map(
          (o) =>
            `### obs/${o.id} — kind: ${o.kind} — scope: ${o.scope}${o.client ? ` — via: ${o.client}` : ""}${o.source ? ` — context: ${o.source}` : ""} — received: ${o.receivedAt}\n${o.content}`,
        )
        .join("\n\n");

    const res = await runAgent({
      label: `${this.teamId}/ingest/${memberId}`,
      model: config.llm.agentModel,
      system: ingestSystem(await this.memberCtx(member)),
      task,
      tools: [...readTools(this.repo, memberAccess(memberId)), ...writeTools(this.repo, memberAccess(memberId)), ingestCommitTool()],
    });

    let teamMessage = "update team memory";
    let personalMessage = "update personal memory";
    try {
      const parsed = JSON.parse(res.output);
      teamMessage = parsed.team;
      personalMessage = parsed.personal;
    } catch {
      if (res.output) teamMessage = res.output;
    }

    const meta = await this.meta();
    meta.sinceDream += batch.length;
    meta.totalObservations += batch.length;
    await this.repo.writeMeta("state", meta);

    const ids = batch.map((o) => o.id).join(", ");
    const mine = (rel: string) => {
      const z = zoneOf(rel);
      return z.kind === "meta" || ((z.kind === "private" || z.kind === "source") && z.member === memberId);
    };
    const commits: CommitInfo[] = [];
    // Personal first (private + raw sources + bookkeeping), then shared changes, if any.
    const personal = await this.repo.commit(
      `personal(${memberId}): ${isNoop(personalMessage) ? "archive observations" : personalMessage}\n\nobs: ${ids}`,
      mine,
    );
    if (personal) commits.push(personal);
    const shared = await this.repo.commit(`${isNoop(teamMessage) ? "update team memory" : teamMessage}\n\nby: ${memberId}`);
    if (shared) commits.push(shared);
    if (commits.length) await this.repo.persist();

    const result: RunResult = { observationIds: batch.map((o) => o.id), member: memberId, teamMessage, personalMessage, commits };
    this.recent.push(result);
    console.log(`[${this.teamId}] ingested ${batch.length} obs from ${memberId} in ${res.steps} steps: team="${teamMessage.split("\n")[0]}"`);
    return result;
  }

  private async doDream(reason: string, force: boolean): Promise<RunResult[]> {
    const meta = await this.meta();
    const results: RunResult[] = [];
    try {
      // 1) Shared space — only if it changed since the last shared dream.
      const sharedDiff = await this.repo.diffSince(meta.sharedDreamSha, SHARED_SPEC);
      if (sharedDiff.trim() || force) {
        const res = await runAgent({
          label: `${this.teamId}/dream/shared`,
          model: config.llm.dreamModel,
          system: sharedDreamSystem({ ...this.baseCtx(), teamMemory: (await this.repo.readFile("MEMORY.md")) ?? "" }),
          task:
            `Dream triggered: ${reason}. Last dream: ${meta.lastDreamAt ?? "never"}.\n\n` +
            (sharedDiff.trim() ? `Changes to shared memory since the last dream:\n\n\`\`\`diff\n${sharedDiff}\n\`\`\`` : "No changes since the last dream; focus on cleanup."),
          tools: [...readTools(this.repo, sharedDreamAccess()), ...writeTools(this.repo, sharedDreamAccess()), commitTool()],
          maxSteps: Math.max(config.llm.maxSteps, 40),
        });
        const c = await this.repo.commit(`dream: ${res.output.replace(/^dream:\s*/i, "")}`, (rel) => zoneOf(rel).kind === "shared");
        results.push({ observationIds: [], teamMessage: res.output, commits: c ? [c] : [] });
      }
      meta.sharedDreamSha = await this.repo.head();

      // 2) Each member's personal space that changed since their last personal dream.
      for (const member of activeMembers(this.team)) {
        const spec = [privateRoot(member.id), `${SOURCES_DIR}/${member.id}`];
        const diff = await this.repo.diffSince(meta.privateDreamSha[member.id] ?? null, spec, 25_000);
        const hasPrivate = (await this.repo.listFiles({ under: privateRoot(member.id) }).catch(() => [])).length > 0;
        if (!diff.trim() || !hasPrivate) continue;
        const access = privateDreamAccess(member.id);
        const res = await runAgent({
          label: `${this.teamId}/dream/${member.id}`,
          model: config.llm.dreamModel,
          system: privateDreamSystem(await this.memberCtx(member)),
          task: `Dream triggered: ${reason}.\n\nChanges to ${member.id}'s personal space and new raw observations since their last dream:\n\n\`\`\`diff\n${diff}\n\`\`\``,
          tools: [...readTools(this.repo, access), ...writeTools(this.repo, access), commitTool()],
          maxSteps: Math.max(config.llm.maxSteps, 30),
        });
        const c = await this.repo.commit(`personal(${member.id}): dream: ${res.output.replace(/^dream:\s*/i, "")}`, (rel) => {
          const z = zoneOf(rel);
          return z.kind === "private" && z.member === member.id;
        });
        results.push({ observationIds: [], member: member.id, personalMessage: res.output, commits: c ? [c] : [] });
        meta.privateDreamSha[member.id] = await this.repo.head();
      }

      meta.lastDreamAt = new Date().toISOString();
      meta.sinceDream = 0;
      meta.totalDreams++;
      await this.repo.writeMeta("state", meta);
      await this.repo.commit("meta: dream bookkeeping");
      await this.repo.persist();
      this.recent.push(...results);
      console.log(`[${this.teamId}] dream (${reason}) done: ${results.length} scope(s)`);
      return results;
    } catch (e) {
      await this.repo.rollback();
      this.status.lastError = `dream: ${(e as Error).message}`;
      throw e;
    }
  }
}

/** A commit is visible to a member if every non-meta file it touched is shared or theirs. */
export function commitVisibleTo(c: CommitInfo, memberId: string) {
  const access = memberAccess(memberId);
  const files = c.files.filter((f) => zoneOf(f).kind !== "meta");
  return files.every((f) => access.canRead(f));
}

/** All teams' memory agents. */
export class Hub {
  private teams = new Map<string, Promise<TeamMemory>>();

  async start() {
    await registry.load();
    await Promise.all(registry.list().map((t) => this.get(t.id)));
  }

  get(teamId: string): Promise<TeamMemory> {
    let p = this.teams.get(teamId);
    if (!p) {
      registry.get(teamId); // throws 404 if unknown
      const tm = new TeamMemory(teamId);
      p = tm.start().then(() => tm);
      p.catch(() => this.teams.delete(teamId));
      this.teams.set(teamId, p);
    }
    return p;
  }

  async dreamAll(reason: string) {
    for (const t of registry.list()) {
      const tm = await this.get(t.id);
      await tm.dream(reason).catch((e) => console.error(`[${t.id}] dream failed`, e));
    }
  }

  async statusAll() {
    const out = [];
    for (const t of registry.list()) {
      const tm = await this.get(t.id);
      out.push({ team: t.id, busy: tm.status.busy, pending: tm.pendingObservations().length, lastError: tm.status.lastError });
    }
    return out;
  }
}

export const hub = new Hub();
