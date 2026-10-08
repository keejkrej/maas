import crypto from "node:crypto";
import { memberAccess, privateDreamAccess, privateRoot, sharedDreamAccess, zoneOf } from "../access.js";
import { config } from "../config.js";
import { db, docId } from "../db.js";
import { runAgent } from "../llm.js";
import { TeamStore, today, type CommitInfo } from "../store.js";
import { activeMembers, registry, type Member, type Team } from "../teams.js";
import { ingestSystem, privateDreamSystem, recallSystem, sharedDreamSystem, type MemberCtx, type PromptCtx } from "./prompts.js";
import { commitTool, ingestCommitTool, readTools, writeTools } from "./tools.js";

export type ObservationKind = "remember" | "forget" | "dream";
export type ScopeHint = "auto" | "team" | "personal";

export interface RunResult {
  teamMessage?: string;
  personalMessage?: string;
  commits: CommitInfo[];
}

/** An inbox item: an observation from a member, or a dream request. Stored at teams/{t}/inbox/{id}. */
export interface InboxItem {
  id: string;
  kind: ObservationKind;
  scope: ScopeHint;
  member: string;
  content: string;
  context?: string;
  client?: string;
  receivedAt: string;
  status: "pending" | "done" | "failed";
  attempts: number;
  nextAttemptAt?: string;
  force?: boolean;
  result?: RunResult;
  error?: string;
  /** Firestore TTL field (optional TTL policy on `expireAt` cleans up old inbox items). */
  expireAt?: Date | string;
}

interface MetaState {
  lastDreamAt: string | null;
  sharedDreamSeq: number;
  privateDreamSeq: Record<string, number>;
  privateDreamAt: Record<string, string>;
  sinceDream: number;
  totalObservations: number;
  totalDreams: number;
  lastError: string | null;
}

const META_DEFAULT: MetaState = {
  lastDreamAt: null,
  sharedDreamSeq: 0,
  privateDreamSeq: {},
  privateDreamAt: {},
  sinceDream: 0,
  totalObservations: 0,
  totalDreams: 0,
  lastError: null,
};
const BATCH_SIZE = 8;
const MAX_ATTEMPTS = 3;
const LEASE_MS = 10 * 60_000;
const SYSTEM = "_system";

const isNoop = (m?: string) => !m || /^no-?op\b/i.test(m.trim());
const isShared = (rel: string) => zoneOf(rel).kind === "shared";
const inboxPath = (teamId: string) => `teams/${teamId}/inbox`;

function seedMemory(team: Team) {
  return {
    "MEMORY.md": `# Memory: ${team.name}

Shared memory of the ${team.name} team. Loaded at the start of every session of every member,
so it stays short: only what every session needs, plus links to topic files.

## Core facts

## Index
`,
  };
}

// ---------------- read side (any instance, any time) ----------------

const readCache = new Map<string, { seq: number; store: TeamStore }>();

/** A loaded, read-only snapshot of a team's files (cached per instance until the next commit). */
export async function readStore(teamId: string): Promise<TeamStore> {
  const s = new TeamStore(teamId);
  const seq = await s.head();
  const c = readCache.get(teamId);
  if (c && c.seq === seq) return c.store;
  await s.load();
  readCache.set(teamId, { seq, store: s });
  return s;
}

export async function initTeamMemory(team: Team) {
  await new TeamStore(team.id).init(seedMemory(team));
}

/** Team MEMORY.md + the member's personal MEMORY.md (two direct reads). */
export async function memoryContext(teamId: string, memberId: string) {
  const get = async (p: string) => (await db.get<{ content: string }>(`teams/${teamId}/files/${docId(p)}`))?.content ?? null;
  return { team: (await get("MEMORY.md")) ?? "", personal: await get(`${privateRoot(memberId)}/MEMORY.md`) };
}

export async function recall(team: Team, member: Member, question: string, context?: string) {
  const store = await readStore(team.id);
  const res = await runAgent({
    label: `${team.id}/recall/${member.id}`,
    model: config.llm.agentModel,
    system: recallSystem(await memberCtx(team, member, store)),
    task: `Question: ${question}${context ? `\n\nContext from the asking agent: ${context}` : ""}`,
    tools: readTools(store, memberAccess(member.id)),
    maxSteps: 12,
  });
  return res.output || "I couldn't produce an answer.";
}

export async function meta(teamId: string) {
  return new TeamStore(teamId).readMeta<MetaState>(META_DEFAULT);
}

export async function status(teamId: string) {
  const lock = await db.get<{ label: string; until: number }>(`teams/${teamId}/state/lock`);
  const pending = await db.list<InboxItem>(inboxPath(teamId), { where: ["status", "pending"], limit: 200 });
  const m = await meta(teamId);
  return {
    busy: lock && lock.until > Date.now() ? lock.label : null,
    pending: pending.map((p) => p.data).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)),
    lastError: m.lastError,
  };
}

/** Commit history filtered to what a member may see. */
export async function visibleLog(teamId: string, memberId: string, limit = 30): Promise<CommitInfo[]> {
  const all = await new TeamStore(teamId).log(limit * 3);
  return all.filter((c) => commitVisibleTo(c, memberId)).slice(0, limit);
}

/** A commit is visible to a member if every file it touched is shared or theirs. */
export function commitVisibleTo(c: { files: string[] }, memberId: string) {
  const access = memberAccess(memberId);
  return c.files.every((f) => access.canRead(f));
}

/** Recent processed inbox items, redacted to what `memberId` may see. */
export async function recentRuns(teamId: string, memberId: string, limit = 30) {
  const rows = await db.list<InboxItem>(inboxPath(teamId), { orderBy: ["receivedAt", "desc"], limit: limit * 2 });
  return rows
    .map((r) => r.data)
    .filter((i) => i.status !== "pending")
    .slice(0, limit)
    .map((i) =>
      i.member === memberId
        ? i
        : {
            ...i,
            content: i.kind === "dream" ? i.content : "(teammate's observation)",
            context: undefined,
            result: i.result && {
              teamMessage: i.result.teamMessage,
              commits: i.result.commits.filter((c) => commitVisibleTo(c, memberId)),
            },
            error: undefined,
          },
    );
}

// ---------------- write side: inbox ----------------

export async function enqueue(
  teamId: string,
  input: { member: string; content: string; kind?: ObservationKind; scope?: ScopeHint; context?: string; client?: string; force?: boolean },
): Promise<InboxItem> {
  const receivedAt = new Date().toISOString();
  const item: InboxItem = {
    id: crypto.randomBytes(6).toString("hex").slice(0, 8),
    kind: input.kind ?? "remember",
    scope: input.scope ?? "auto",
    member: input.member,
    content: input.content.trim(),
    context: input.context?.trim() || undefined,
    client: input.client?.trim() || undefined,
    receivedAt,
    status: "pending",
    attempts: 0,
    force: input.force,
    expireAt: config.useFirestore ? new Date(Date.now() + 30 * 864e5) : undefined,
  };
  await db.set(`${inboxPath(teamId)}/${item.id}`, item);
  // On Firebase the Firestore trigger runs the worker; locally we kick it in-process.
  if (!config.onFirebase) kickLocal(teamId);
  return item;
}

export function requestDream(teamId: string, reason: string, force = false) {
  return enqueue(teamId, { member: SYSTEM, kind: "dream", content: reason, force });
}

/** Poll until the item is processed (or timeout → null). */
export async function waitFor(teamId: string, id: string, timeoutMs: number): Promise<InboxItem | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const item = await db.get<InboxItem>(`${inboxPath(teamId)}/${id}`);
    if (item && item.status !== "pending") return item;
    await new Promise((r) => setTimeout(r, 1200));
  }
  return null;
}

const localTimers = new Map<string, NodeJS.Timeout>();
function kickLocal(teamId: string, delayMs = 1500) {
  if (localTimers.has(teamId)) return;
  localTimers.set(
    teamId,
    setTimeout(() => {
      localTimers.delete(teamId);
      drainTeam(teamId).catch((e) => console.error(`[${teamId}] drain failed`, e));
    }, delayMs),
  );
}

// ---------------- write side: worker ----------------

async function acquire(teamId: string, holder: string, label: string) {
  const now = Date.now();
  const got = await db.update<{ holder: string; label: string; until: number }>(`teams/${teamId}/state/lock`, (cur) =>
    cur && cur.until > now && cur.holder !== holder ? undefined : { holder, label, until: now + LEASE_MS },
  );
  return got?.holder === holder;
}

async function release(teamId: string, holder: string) {
  await db.update<{ holder: string }>(`teams/${teamId}/state/lock`, (cur) => (cur?.holder === holder ? null : undefined));
}

async function readyItems(teamId: string): Promise<InboxItem[]> {
  const now = new Date().toISOString();
  const rows = await db.list<InboxItem>(inboxPath(teamId), { where: ["status", "pending"], limit: 100 });
  return rows
    .map((r) => r.data)
    .filter((i) => !i.nextAttemptAt || i.nextAttemptAt <= now)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

/**
 * Process a team's pending inbox under its lease lock (single writer per team).
 * Safe to call from many places at once: losers return immediately and the holder re-checks before exiting.
 */
export async function drainTeam(teamId: string, budgetMs = 420_000): Promise<void> {
  const started = Date.now();
  const holder = crypto.randomUUID();
  if (!(await acquire(teamId, holder, "ingest"))) return;
  try {
    while (Date.now() - started < budgetMs) {
      const items = await readyItems(teamId);
      if (!items.length) break;
      const first = items[0];
      const batch = first.kind === "dream" ? [first] : items.filter((i) => i.kind !== "dream" && i.member === first.member).slice(0, BATCH_SIZE);
      await processBatch(teamId, batch, holder);
    }
  } finally {
    await release(teamId, holder);
  }
  // Something may have arrived between the last check and release.
  const left = await readyItems(teamId);
  if (left.length) {
    if (Date.now() - started < budgetMs) return drainTeam(teamId, budgetMs - (Date.now() - started));
    if (!config.onFirebase) kickLocal(teamId, 0);
  } else if (!config.onFirebase) {
    // Retry-delayed items locally (on Firebase the sweeper handles them).
    const pending = await db.list<InboxItem>(inboxPath(teamId), { where: ["status", "pending"], limit: 1 });
    if (pending.length) kickLocal(teamId, 30_000);
  }
}

async function processBatch(teamId: string, batch: InboxItem[], holder: string) {
  const ref = (i: InboxItem) => `${inboxPath(teamId)}/${i.id}`;
  const store = new TeamStore(teamId);
  try {
    await db.update(`teams/${teamId}/state/lock`, (cur: any) => (cur?.holder === holder ? { ...cur, label: batch[0].kind === "dream" ? "dream" : `ingest (${batch[0].member})`, until: Date.now() + LEASE_MS } : undefined));
    const team = await registry.get(teamId);
    await store.load(true);
    if (!store.changedFiles().length && !(await store.listFiles()).length) await store.init(seedMemory(team));

    const result = batch[0].kind === "dream" ? await doDream(team, store, batch[0].content, !!batch[0].force) : await ingest(team, store, batch);
    for (const i of batch) await db.set(ref(i), { ...i, status: "done", result, expireAt: i.expireAt });
    readCache.delete(teamId);
    const m = await meta(teamId);
    if (m.lastError) await store.writeMeta({ ...m, lastError: null });
  } catch (e) {
    const err = (e as Error).message;
    console.error(`[${teamId}] ${batch[0].kind} failed:`, err);
    store.rollback();
    const m = await meta(teamId);
    await store.writeMeta({ ...m, lastError: `${new Date().toISOString().slice(0, 16)} ${batch[0].kind}: ${err.slice(0, 300)}` });
    for (const i of batch) {
      const attempts = i.attempts + 1;
      await db.set(
        ref(i),
        attempts >= MAX_ATTEMPTS
          ? { ...i, attempts, status: "failed", error: err.slice(0, 1000) }
          : { ...i, attempts, nextAttemptAt: new Date(Date.now() + 30_000 * attempts).toISOString() },
      );
    }
  }
}

function baseCtx(team: Team, teamMemory: string): PromptCtx {
  return { teamName: team.name, roster: activeMembers(team).map((m) => ({ id: m.id, name: m.name })), today: today(), teamMemory };
}

async function memberCtx(team: Team, member: Pick<Member, "id" | "name">, store: TeamStore): Promise<MemberCtx> {
  return {
    ...baseCtx(team, (await store.readFile("MEMORY.md")) ?? ""),
    member: { id: member.id, name: member.name },
    personalMemory: await store.readFile(`${privateRoot(member.id)}/MEMORY.md`),
  };
}

async function ingest(team: Team, store: TeamStore, batch: InboxItem[]): Promise<RunResult> {
  const memberId = batch[0].member;
  const member = team.members.find((m) => m.id === memberId) ?? ({ id: memberId, name: memberId } as Member);
  const date = today();

  for (const o of batch)
    await store.putSource({ id: o.id, member: memberId, kind: o.kind, scope: o.scope, client: o.client, context: o.context, receivedAt: o.receivedAt, content: o.content });

  const task =
    `New observations from ${memberId} (${batch.length}). Cite facts like [source: obs/${batch[0].id}; by: ${memberId}; added: ${date}].\n\n` +
    batch
      .map(
        (o) =>
          `### obs/${o.id} — kind: ${o.kind} — scope: ${o.scope}${o.client ? ` — via: ${o.client}` : ""}${o.context ? ` — context: ${o.context}` : ""} — received: ${o.receivedAt}\n${o.content}`,
      )
      .join("\n\n");

  const access = memberAccess(memberId);
  const res = await runAgent({
    label: `${team.id}/ingest/${memberId}`,
    model: config.llm.agentModel,
    system: ingestSystem(await memberCtx(team, member, store)),
    task,
    tools: [...readTools(store, access), ...writeTools(store, access), ingestCommitTool()],
    requireTerminal: true,
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

  const ids = batch.map((o) => o.id).join(", ");
  const commits: CommitInfo[] = [];
  const mine = (rel: string) => {
    const z = zoneOf(rel);
    return z.kind === "private" && z.member === memberId;
  };
  // Personal and shared changes are separate commits so teammates never see personal commit messages.
  const personal = await store.commit(`personal(${memberId}): ${isNoop(personalMessage) ? "update" : personalMessage}\n\nobs: ${ids}`, mine);
  if (personal) commits.push(personal);
  const shared = await store.commit(`${isNoop(teamMessage) ? "update team memory" : teamMessage}\n\nby: ${memberId}`, isShared);
  if (shared) commits.push(shared);
  store.rollback(); // drop anything outside the allowed zones (tools prevent this, belt and braces)

  const m = await meta(team.id);
  m.sinceDream += batch.length;
  m.totalObservations += batch.length;
  await store.writeMeta(m);
  if (config.dreamEvery > 0 && m.sinceDream >= config.dreamEvery) {
    const pendingDream = (await db.list<InboxItem>(inboxPath(team.id), { where: ["status", "pending"], limit: 100 })).some((r) => r.data.kind === "dream");
    if (!pendingDream) await requestDream(team.id, `auto after ${m.sinceDream} observations`);
  }
  console.log(`[${team.id}] ingested ${batch.length} obs from ${memberId} in ${res.steps} steps: team="${teamMessage.split("\n")[0]}"`);
  return { teamMessage, personalMessage, commits };
}

async function doDream(team: Team, store: TeamStore, reason: string, force: boolean): Promise<RunResult> {
  const m = await meta(team.id);
  const commits: CommitInfo[] = [];
  const messages: string[] = [];

  // 1) Shared space, if it changed since the last shared dream (or forced).
  const sharedDiff = await store.diffSince(m.sharedDreamSeq, isShared);
  if (sharedDiff.trim() || force) {
    const access = sharedDreamAccess();
    const res = await runAgent({
      label: `${team.id}/dream/shared`,
      model: config.llm.dreamModel,
      system: sharedDreamSystem(baseCtx(team, (await store.readFile("MEMORY.md")) ?? "")),
      task:
        `Dream triggered: ${reason}. Last dream: ${m.lastDreamAt ?? "never"}.\n\n` +
        (sharedDiff.trim() ? `Changes to shared memory since the last dream:\n\n\`\`\`diff\n${sharedDiff}\n\`\`\`` : "No changes since the last dream; focus on cleanup."),
      tools: [...readTools(store, access), ...writeTools(store, access), commitTool()],
      maxSteps: Math.max(config.llm.maxSteps, 40),
      requireTerminal: true,
    });
    const c = await store.commit(`dream: ${res.output.replace(/^dream:\s*/i, "")}`, isShared);
    if (c) commits.push(c);
    messages.push(res.output);
  }
  store.rollback();
  m.sharedDreamSeq = await store.head();

  // 2) Each member's personal space that changed (or got new raw observations) since their last dream.
  for (const member of activeMembers(team)) {
    const root = privateRoot(member.id) + "/";
    const diff = await store.diffSince(m.privateDreamSeq[member.id] ?? 0, (rel) => rel.startsWith(root), 25_000);
    const sources = await store.sourcesSince(member.id, m.privateDreamAt[member.id] ?? null, 40);
    const hasPrivate = (await store.listFiles({ under: privateRoot(member.id) })).length > 0;
    if (!hasPrivate || (!diff.trim() && !sources.length)) continue;
    const access = privateDreamAccess(member.id);
    const res = await runAgent({
      label: `${team.id}/dream/${member.id}`,
      model: config.llm.dreamModel,
      system: privateDreamSystem(await memberCtx(team, member, store)),
      task:
        `Dream triggered: ${reason}.\n\n` +
        (diff.trim() ? `Changes to ${member.id}'s personal space since their last dream:\n\n\`\`\`diff\n${diff}\n\`\`\`\n\n` : "") +
        (sources.length ? `Their raw observations since then:\n\n${sources.map((s) => `### obs/${s.id} (${s.receivedAt})\n${s.content.slice(0, 1500)}`).join("\n\n")}` : ""),
      tools: [...readTools(store, access), ...writeTools(store, access), commitTool()],
      maxSteps: Math.max(config.llm.maxSteps, 30),
      requireTerminal: true,
    });
    const c = await store.commit(`personal(${member.id}): dream: ${res.output.replace(/^dream:\s*/i, "")}`, (rel) => rel.startsWith(root));
    if (c) commits.push(c);
    store.rollback();
    m.privateDreamSeq[member.id] = await store.head();
    m.privateDreamAt[member.id] = new Date().toISOString();
  }

  m.lastDreamAt = new Date().toISOString();
  m.sinceDream = 0;
  m.totalDreams++;
  await store.writeMeta(m);
  console.log(`[${team.id}] dream (${reason}) done: ${commits.length} commit(s)`);
  return { teamMessage: messages.join("\n") || "dream: nothing to consolidate", commits };
}

/** Called by the scheduled sweeper: drain any team with ready items (e.g. retries, or work left after a timeout). */
export async function sweepAll() {
  for (const t of await registry.list()) {
    if ((await readyItems(t.id)).length) await drainTeam(t.id).catch((e) => console.error(`[${t.id}] sweep failed`, e));
  }
}

export async function dreamAll(reason: string) {
  for (const t of await registry.list()) await requestDream(t.id, reason);
}
