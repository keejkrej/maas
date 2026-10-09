import crypto from "node:crypto";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { type Access, SOURCES_DIR, zoneOf } from "./access.js";
import { db, docId } from "./db.js";

export interface CommitInfo {
  seq: number;
  sha: string;
  message: string;
  date: string;
  files: string[];
}

interface CommitDoc extends CommitInfo {
  patches: { path: string; patch: string }[];
}

export interface Hit {
  path: string;
  line: number;
  text: string;
}

export interface SourceDoc {
  id: string;
  member: string;
  kind: string;
  scope: string;
  client?: string;
  context?: string;
  receivedAt: string;
  content: string;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

const MAX_PATCH = 60_000;
const MAX_COMMIT_PATCHES = 700_000; // Firestore docs are capped at 1 MiB

/**
 * One team's memory: a folder of markdown files stored in Firestore, with a commit log of diffs.
 *
 * An agent job `load()`s a working copy, edits it in memory, then `commit()`s: changed files and a
 * commit doc (message + unified diffs) are written in one batch. `rollback()` discards edits.
 * Writes happen only while holding the team's lease lock, so there's a single writer per team.
 */
export class TeamStore {
  private files = new Map<string, string>();
  private base = new Map<string, string>();
  private loaded = false;

  constructor(readonly teamId: string) {}

  private get root() {
    return `teams/${this.teamId}`;
  }

  async load(force = false) {
    if (this.loaded && !force) return this;
    const rows = await db.list<{ path: string; content: string }>(`${this.root}/files`);
    this.files = new Map(rows.map((r) => [r.data.path, r.data.content]));
    this.base = new Map(this.files);
    this.loaded = true;
    return this;
  }

  /** Create the seed files if the team has no memory yet. */
  async init(seed: Record<string, string>) {
    await this.load(true);
    if (this.files.size) return;
    for (const [p, c] of Object.entries(seed)) this.writeFile(p, c);
    await this.commit("init: create team memory");
  }

  // ---------- paths ----------

  resolve(rel: string): string {
    let clean = String(rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
    if (clean.startsWith("[[") && clean.endsWith("]]")) clean = clean.slice(2, -2);
    const norm = path.posix.normalize(clean);
    if (!norm || norm === "." || norm.startsWith("..") || norm.endsWith("/")) throw new Error(`Invalid path: ${rel}`);
    if (zoneOf(norm).kind === "meta") throw new Error(`Path not allowed: ${rel}`);
    if (norm.length > 300) throw new Error("Path too long");
    return norm;
  }

  /** Resolve a path or wiki link to an existing file (adds .md if needed). */
  async locate(rel: string): Promise<string | null> {
    const r = this.resolve(rel);
    if (this.files.has(r)) return r;
    if (!r.endsWith(".md") && this.files.has(r + ".md")) return r + ".md";
    return null;
  }

  // ---------- reads ----------

  async readFile(rel: string): Promise<string | null> {
    return this.files.get(this.resolve(rel)) ?? null;
  }

  async listFiles(opts: { access?: Access; under?: string } = {}): Promise<string[]> {
    const prefix = opts.under ? this.resolve(opts.under).replace(/\/?$/, "/") : "";
    return [...this.files.keys()].filter((f) => f.startsWith(prefix) && (!opts.access || opts.access.canRead(f))).sort();
  }

  /** Case-insensitive regex (falls back to literal) over visible files, and optionally the member's own raw sources. */
  async search(pattern: string, opts: { access?: Access; includeSources?: boolean; limit?: number } = {}): Promise<Hit[]> {
    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const limit = opts.limit ?? 80;
    const hits: Hit[] = [];
    const scan = (p: string, content: string) => {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && hits.length < limit; i++) {
        if (re.test(lines[i]) || (i === 0 && re.test(p))) hits.push({ path: p, line: i + 1, text: lines[i].slice(0, 400) });
      }
    };
    for (const f of await this.listFiles({ access: opts.access })) {
      scan(f, this.files.get(f)!);
      if (hits.length >= limit) return hits;
    }
    const m = opts.access?.member;
    if (opts.includeSources && m && opts.access!.canRead(`${SOURCES_DIR}/${m}/x`)) {
      for (const s of await this.recentSources(m, 200)) {
        scan(`${SOURCES_DIR}/${m}/${s.id}`, s.content);
        if (hits.length >= limit) break;
      }
    }
    return hits;
  }

  // ---------- raw observations (sources) ----------

  async putSource(s: SourceDoc) {
    await db.set(`${this.root}/members/${s.member}/sources/${s.id}`, s);
  }

  async getSource(member: string, id: string): Promise<SourceDoc | null> {
    const bare = String(id).replace(/^obs\//, "").replace(/[^a-z0-9]/gi, "");
    if (!bare) return null;
    return db.get<SourceDoc>(`${this.root}/members/${member}/sources/${bare}`);
  }

  async recentSources(member: string, limit = 50): Promise<SourceDoc[]> {
    return (await db.list<SourceDoc>(`${this.root}/members/${member}/sources`, { orderBy: ["receivedAt", "desc"], limit })).map((r) => r.data);
  }

  async sourcesSince(member: string, sinceIso: string | null, limit = 60): Promise<SourceDoc[]> {
    const all = await this.recentSources(member, limit);
    return all.filter((s) => !sinceIso || s.receivedAt > sinceIso).reverse();
  }

  // ---------- writes (working copy) ----------

  writeFile(rel: string, content: string) {
    const r = this.resolve(rel);
    this.files.set(r, content.endsWith("\n") ? content : content + "\n");
  }

  deleteFile(rel: string) {
    this.files.delete(this.resolve(rel));
  }

  rollback() {
    this.files = new Map(this.base);
  }

  changedFiles(): string[] {
    const out = new Set<string>();
    for (const [p, c] of this.files) if (this.base.get(p) !== c) out.add(p);
    for (const p of this.base.keys()) if (!this.files.has(p)) out.add(p);
    return [...out].sort();
  }

  /**
   * Commit changed files (optionally only those matching `filter`) as one atomic batch:
   * file docs + a commit doc with unified diffs. Returns null when nothing changed.
   */
  async commit(message: string, filter?: (rel: string) => boolean): Promise<CommitInfo | null> {
    const changed = this.changedFiles().filter((f) => !filter || filter(f));
    if (!changed.length) return null;

    const meta = await db.update<{ seq?: number }>(`${this.root}/state/counter`, (cur) => ({ seq: (cur?.seq ?? 0) + 1 }));
    const seq = meta!.seq!;
    const sha = crypto.randomBytes(4).toString("hex").slice(0, 7);
    const date = new Date().toISOString();

    let budget = MAX_COMMIT_PATCHES;
    const patches = changed.map((p) => {
      let patch = createTwoFilesPatch(`a/${p}`, `b/${p}`, this.base.get(p) ?? "", this.files.get(p) ?? "", "", "", { context: 2 });
      if (patch.length > MAX_PATCH) patch = patch.slice(0, MAX_PATCH) + "\n…[patch truncated]\n";
      if (patch.length > budget) patch = `…[patch omitted: commit too large]\n`;
      budget -= patch.length;
      return { path: p, patch };
    });

    const commit: CommitDoc = { seq, sha, message, date, files: changed, patches };
    await db.batch([
      ...changed.map((p) =>
        this.files.has(p)
          ? { op: "set" as const, path: `${this.root}/files/${docId(p)}`, data: { path: p, content: this.files.get(p)!, updatedAt: date } }
          : { op: "delete" as const, path: `${this.root}/files/${docId(p)}` },
      ),
      { op: "set", path: `${this.root}/commits/${String(seq).padStart(10, "0")}`, data: commit },
    ]);
    for (const p of changed) {
      if (this.files.has(p)) this.base.set(p, this.files.get(p)!);
      else this.base.delete(p);
    }
    return { seq, sha, message, date, files: changed };
  }

  // ---------- history ----------

  async head(): Promise<number> {
    return (await db.get<{ seq?: number }>(`${this.root}/state/counter`))?.seq ?? 0;
  }

  async log(limit = 50): Promise<CommitInfo[]> {
    const rows = await db.list<CommitDoc>(`${this.root}/commits`, { orderBy: ["seq", "desc"], limit });
    return rows.map(({ data: { patches: _, ...c } }) => c);
  }

  async show(sha: string, filter: (rel: string) => boolean = () => true): Promise<string> {
    if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new Error("bad sha");
    const [row] = await db.list<CommitDoc>(`${this.root}/commits`, { where: ["sha", sha], limit: 1 });
    if (!row) throw new Error("commit not found");
    const c = row.data;
    return `${c.sha} ${c.date}\n\n${c.message}\n\n${c.patches.filter((p) => filter(p.path)).map((p) => p.patch).join("\n")}`;
  }

  async getCommit(sha: string): Promise<CommitInfo | null> {
    const [row] = await db.list<CommitDoc>(`${this.root}/commits`, { where: ["sha", sha], limit: 1 });
    if (!row) return null;
    const { patches: _, ...c } = row.data;
    return c;
  }

  /** Concatenated diffs of commits after `seq`, restricted to files matching `filter`. */
  async diffSince(seq: number, filter: (rel: string) => boolean, maxChars = 40_000): Promise<string> {
    const rows = await db.list<CommitDoc>(`${this.root}/commits`, { gt: ["seq", seq], orderBy: ["seq", "asc"], limit: 300 });
    let out = "";
    for (const { data: c } of rows) {
      const ps = c.patches.filter((p) => filter(p.path));
      if (!ps.length) continue;
      out += `# commit ${c.sha} (${c.date.slice(0, 16)}): ${c.message.split("\n")[0]}\n${ps.map((p) => p.patch).join("\n")}\n`;
      if (out.length > maxChars) return out.slice(0, maxChars) + "\n…[diff truncated]";
    }
    return out;
  }

  // ---------- team state ----------

  async readMeta<T extends object>(fallback: T): Promise<T> {
    const m = await db.get<T>(`${this.root}/state/meta`);
    return { ...structuredClone(fallback), ...(m ?? {}) };
  }

  async writeMeta(value: object) {
    await db.set(`${this.root}/state/meta`, value);
  }
}
