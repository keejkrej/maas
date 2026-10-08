import crypto from "node:crypto";
import { config } from "../config.js";
import { runAgent } from "../llm.js";
import { repo, SOURCES_DIR, today, type CommitInfo } from "../repo.js";
import { blobs } from "../storage.js";
import { dreamSystem, ingestSystem, recallSystem } from "./prompts.js";
import { commitTool, readTools, writeTools } from "./tools.js";

export type ObservationKind = "remember" | "forget";

export interface Observation {
  id: string;
  kind: ObservationKind;
  content: string;
  source?: string;
  client?: string;
  receivedAt: string;
  attempts: number;
}

export interface IngestResult {
  observationIds: string[];
  message: string;
  commit: CommitInfo | null;
}

interface MetaState {
  lastDreamAt: string | null;
  sinceDream: string[];
  totalObservations: number;
  totalDreams: number;
}

const META_DEFAULT: MetaState = { lastDreamAt: null, sinceDream: [], totalObservations: 0, totalDreams: 0 };
const BATCH_SIZE = 8;
const MAX_ATTEMPTS = 3;

type Waiter = { resolve: (r: IngestResult) => void; reject: (e: Error) => void };

/**
 * The memory agent. Clients push observations; the agent owns the repo and integrates them
 * one batch at a time (single writer), then occasionally dreams to consolidate.
 */
export class MemoryAgent {
  private chain: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Observation>();
  private waiters = new Map<string, Waiter[]>();
  private drainTimer: NodeJS.Timeout | null = null;
  private recent: IngestResult[] = [];
  status = { busy: null as string | null, lastError: null as string | null, lastRunAt: null as string | null };

  async start() {
    await repo.init();
    for (const key of await blobs.list("inbox")) {
      const raw = await blobs.get(key);
      if (!raw) continue;
      try {
        const obs = JSON.parse(raw.toString("utf8")) as Observation;
        this.pending.set(obs.id, obs);
      } catch {
        console.warn(`[agent] dropping unreadable inbox item ${key}`);
      }
    }
    if (this.pending.size) {
      console.log(`[agent] recovered ${this.pending.size} pending observation(s) from the inbox`);
      this.scheduleDrain(0);
    }
  }

  // ---------------- public API ----------------

  /** Accept an observation. It is journaled durably before this resolves. */
  async enqueue(input: { content: string; kind?: ObservationKind; source?: string; client?: string }): Promise<Observation> {
    const obs: Observation = {
      id: crypto.randomBytes(4).toString("base64url").replace(/[-_]/g, "x").slice(0, 6).toLowerCase(),
      kind: input.kind ?? "remember",
      content: input.content.trim(),
      source: input.source?.trim() || undefined,
      client: input.client?.trim() || undefined,
      receivedAt: new Date().toISOString(),
      attempts: 0,
    };
    await blobs.put(`inbox/${obs.receivedAt.replace(/[:.]/g, "-")}_${obs.id}.json`, JSON.stringify(obs));
    this.pending.set(obs.id, obs);
    this.scheduleDrain();
    return obs;
  }

  /** Resolve when the given observation has been integrated (or null on timeout). */
  waitFor(id: string, timeoutMs: number): Promise<IngestResult | null> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(null), timeoutMs);
      const list = this.waiters.get(id) ?? [];
      list.push({
        resolve: (r) => (clearTimeout(t), resolve(r)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      this.waiters.set(id, list);
    });
  }

  /** Ask the agent a question. Read-only, so it runs concurrently with writes. */
  async recall(question: string, context?: string) {
    const memory = (await repo.readFile("MEMORY.md")) ?? "";
    const res = await runAgent({
      label: "recall",
      model: config.llm.agentModel,
      system: recallSystem(memory, today()),
      task: `Question: ${question}${context ? `\n\nContext from the asking agent: ${context}` : ""}`,
      tools: readTools(),
      maxSteps: 12,
    });
    return res.output || "I couldn't produce an answer.";
  }

  /** Run a consolidation pass (queued behind any pending writes). */
  dream(reason = "manual"): Promise<IngestResult> {
    return this.exclusive(`dream (${reason})`, () => this.doDream(reason));
  }

  pendingObservations() {
    return [...this.pending.values()].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  recentResults() {
    return this.recent.slice(-20).reverse();
  }

  async meta() {
    return repo.readMeta<MetaState>("state", META_DEFAULT);
  }

  // ---------------- internals ----------------

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

  /** Debounced so bursts of observations are integrated in a single agent run. */
  private scheduleDrain(delayMs = 1500) {
    if (this.drainTimer) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.exclusive("ingest", () => this.drain()).catch((e) => console.error("[agent] drain failed", e));
    }, delayMs);
  }

  private async drain() {
    while (this.pending.size) {
      const batch = this.pendingObservations().slice(0, BATCH_SIZE);
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
        console.error(`[agent] ingest failed:`, err.message);
        this.status.lastError = err.message;
        await repo.rollback();
        for (const o of batch) {
          o.attempts++;
          if (o.attempts >= MAX_ATTEMPTS) {
            await blobs.put(`failed/${o.id}.json`, JSON.stringify({ ...o, error: err.message }));
            await this.removeFromInbox(o);
            for (const w of this.waiters.get(o.id) ?? []) w.reject(err);
            this.waiters.delete(o.id);
          }
        }
        // Back off and retry the rest later.
        if (this.pending.size) setTimeout(() => this.scheduleDrain(0), 15_000 * batch[0].attempts);
        return;
      }
    }
    const meta = await this.meta();
    if (config.dreamEvery > 0 && meta.sinceDream.length >= config.dreamEvery) {
      this.dream(`auto after ${meta.sinceDream.length} observations`).catch((e) => console.error("[agent] dream failed", e));
    }
  }

  private async removeFromInbox(o: Observation) {
    this.pending.delete(o.id);
    const keys = await blobs.list("inbox");
    for (const k of keys.filter((k) => k.endsWith(`_${o.id}.json`))) await blobs.delete(k);
  }

  private async ingest(batch: Observation[]): Promise<IngestResult> {
    const date = today();
    // Archive raw observations so facts can cite them and dreaming can re-check provenance.
    for (const o of batch) {
      await repo.writeFile(
        `${SOURCES_DIR}/${o.receivedAt.slice(0, 10)}/${o.id}.md`,
        [
          `---`,
          `id: obs/${o.id}`,
          `kind: ${o.kind}`,
          `received: ${o.receivedAt}`,
          o.client ? `client: ${o.client}` : null,
          o.source ? `source: ${JSON.stringify(o.source)}` : null,
          `---`,
          ``,
          o.content,
        ]
          .filter((l) => l !== null)
          .join("\n"),
      );
    }

    const memory = (await repo.readFile("MEMORY.md")) ?? "";
    const task =
      `New observations (${batch.length}). Cite each fact with its observation id, e.g. [source: obs/${batch[0].id}; added: ${date}].\n\n` +
      batch
        .map(
          (o) =>
            `### obs/${o.id} — kind: ${o.kind}${o.client ? ` — from: ${o.client}` : ""}${o.source ? ` — context: ${o.source}` : ""} — received: ${o.receivedAt}\n${o.content}`,
        )
        .join("\n\n");

    const res = await runAgent({
      label: "ingest",
      model: config.llm.agentModel,
      system: ingestSystem(memory, date),
      task,
      tools: [...readTools(), ...writeTools(), commitTool()],
    });

    const message = res.output || "update memory";
    const meta = await this.meta();
    meta.sinceDream.push(...batch.map((o) => o.id));
    meta.totalObservations += batch.length;
    await repo.writeMeta("state", meta);

    const commit = await repo.commit(`${message}\n\nobs: ${batch.map((o) => o.id).join(", ")}`);
    if (commit) await repo.persist();
    const result = { observationIds: batch.map((o) => o.id), message, commit };
    this.recent.push(result);
    console.log(`[agent] ingested ${batch.length} obs in ${res.steps} steps -> ${commit?.sha ?? "no commit"}: ${message.split("\n")[0]}`);
    return result;
  }

  private async doDream(reason: string): Promise<IngestResult> {
    const meta = await this.meta();
    const sources: string[] = [];
    const sourceFiles = await repo.listFiles({ under: SOURCES_DIR, includeSources: true }).catch(() => [] as string[]);
    for (const id of meta.sinceDream.slice(-60)) {
      const f = sourceFiles.find((x) => x.endsWith(`/${id}.md`));
      const c = f ? await repo.readFile(f) : null;
      if (c) sources.push(c.length > 1500 ? c.slice(0, 1500) + "\n…" : c);
    }
    const memory = (await repo.readFile("MEMORY.md")) ?? "";
    const task =
      `Dream triggered: ${reason}. Last dream: ${meta.lastDreamAt ?? "never"}.\n\n` +
      (sources.length
        ? `Observations received since the last dream (${sources.length}):\n\n${sources.join("\n\n---\n\n")}`
        : `No new observations since the last dream; focus on cleanup.`);

    try {
      const res = await runAgent({
        label: "dream",
        model: config.llm.dreamModel,
        system: dreamSystem(memory, today()),
        task,
        tools: [...readTools(), ...writeTools(), commitTool()],
        maxSteps: Math.max(config.llm.maxSteps, 40),
      });
      const message = res.output || "dream: consolidate memory";
      meta.lastDreamAt = new Date().toISOString();
      meta.sinceDream = [];
      meta.totalDreams++;
      await repo.writeMeta("state", meta);
      const commit = await repo.commit(message.startsWith("dream") ? message : `dream: ${message}`);
      if (commit) await repo.persist();
      const result = { observationIds: [], message, commit };
      this.recent.push(result);
      console.log(`[agent] dream finished in ${res.steps} steps -> ${commit?.sha ?? "no commit"}`);
      return result;
    } catch (e) {
      await repo.rollback();
      this.status.lastError = `dream: ${(e as Error).message}`;
      throw e;
    }
  }
}

export const agent = new MemoryAgent();
