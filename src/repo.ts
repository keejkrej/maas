import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { META_DIR, SOURCES_DIR, type Access, zoneOf } from "./access.js";
import { blobs } from "./storage.js";

const exec = promisify(execFile);

export interface CommitInfo {
  sha: string;
  message: string;
  date: string;
  files: string[];
}

export interface Hit {
  path: string;
  line: number;
  text: string;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * One team's memory: a git repository of markdown, maintained by the memory agent.
 * All writes go through the team's serial queue, so there is exactly one writer.
 */
export class MemoryRepo {
  constructor(
    readonly dir: string,
    /** Blob key of the git bundle snapshot. */
    private bundleKey: string,
    /** Returns the current git remote (may change at runtime via the admin API). */
    private remote: () => string | undefined,
  ) {}

  async git(args: string[], opts: { allowFail?: boolean } = {}): Promise<string> {
    try {
      const { stdout } = await exec(
        "git",
        ["-c", "user.name=maas-memory-agent", "-c", "user.email=agent@maas.local", "-c", "core.quotepath=off", ...args],
        { cwd: this.dir, maxBuffer: 64 * 1024 * 1024 },
      );
      return stdout;
    } catch (e: any) {
      if (opts.allowFail) return "";
      throw new Error(`git ${args.join(" ")} failed: ${e?.stderr || e?.message}`);
    }
  }

  /** Restore from remote/bundle or create a fresh repo seeded with `seed` files. */
  async init(seed: Record<string, string>) {
    await fs.mkdir(path.dirname(this.dir), { recursive: true });
    const hasGit = await fs
      .stat(path.join(this.dir, ".git"))
      .then(() => true)
      .catch(() => false);
    const remote = this.remote();

    if (!hasGit) {
      if (blobs.kind === "gcs" && (await this.tryRestoreBundle())) {
        console.log(`[repo] ${this.dir}: restored from GCS bundle`);
      } else if (remote && (await this.tryClone(remote))) {
        console.log(`[repo] ${this.dir}: cloned from git remote`);
      } else {
        await fs.mkdir(this.dir, { recursive: true });
        await this.git(["init", "-q", "-b", "main"]);
      }
    }
    const head = await this.git(["rev-parse", "--verify", "HEAD"], { allowFail: true });
    if (!head.trim()) {
      await this.git(["checkout", "-q", "-B", "main"], { allowFail: true });
      for (const [p, c] of Object.entries(seed)) await this.writeFile(p, c, { allowMeta: true });
      await this.commit("init: create memory repo");
      await this.persist();
    }
    await this.syncRemote();
  }

  async syncRemote() {
    const remote = this.remote();
    await this.git(["remote", "remove", "origin"], { allowFail: true });
    if (remote) await this.git(["remote", "add", "origin", remote]);
  }

  private async tryClone(url: string) {
    try {
      await exec("git", ["clone", "-q", url, this.dir]);
      return true;
    } catch (e) {
      console.warn(`[repo] clone failed, starting fresh:`, (e as Error).message.replace(/\/\/[^@/]+@/g, "//***@"));
      await fs.rm(this.dir, { recursive: true, force: true });
      return false;
    }
  }

  private async tryRestoreBundle() {
    const tmp = path.join(os.tmpdir(), `maas-restore-${Date.now()}.bundle`);
    if (!(await blobs.getFile(this.bundleKey, tmp))) return false;
    await exec("git", ["clone", "-q", "-b", "main", tmp, this.dir]);
    await this.git(["remote", "remove", "origin"], { allowFail: true });
    await fs.rm(tmp, { force: true });
    return true;
  }

  /** Push the current state to durable storage. Called after every commit. */
  async persist() {
    if (this.remote()) {
      await this.git(["push", "-q", "-u", "origin", "HEAD:main"]).catch((e) =>
        console.error(`[repo] push failed:`, e.message.replace(/\/\/[^@/]+@/g, "//***@")),
      );
    }
    if (blobs.kind === "gcs") {
      const tmp = path.join(os.tmpdir(), `maas-${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`);
      await this.git(["bundle", "create", "-q", tmp, "main"]);
      await blobs.putFile(this.bundleKey, tmp);
      await fs.rm(tmp, { force: true });
    }
  }

  // ---------- paths ----------

  /** Normalise and validate a repo-relative path. */
  resolve(rel: string, opts: { allowMeta?: boolean } = {}): { rel: string; abs: string } {
    let clean = String(rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
    if (clean.startsWith("[[") && clean.endsWith("]]")) clean = clean.slice(2, -2);
    const norm = path.posix.normalize(clean);
    if (!norm || norm === "." || norm.startsWith("..")) throw new Error(`Invalid path: ${rel}`);
    if (zoneOf(norm).kind === "meta" && !(opts.allowMeta && norm.startsWith(META_DIR + "/"))) throw new Error(`Path not allowed: ${rel}`);
    return { rel: norm, abs: path.join(this.dir, ...norm.split("/")) };
  }

  /** Resolve a path or wiki link to an existing file path (adds .md if needed). */
  async locate(rel: string): Promise<string | null> {
    const { rel: r, abs } = this.resolve(rel);
    if (await isFile(abs)) return r;
    if (!r.endsWith(".md") && (await isFile(abs + ".md"))) return r + ".md";
    return null;
  }

  // ---------- reads ----------

  async readFile(rel: string, opts: { allowMeta?: boolean } = {}): Promise<string | null> {
    const { abs } = this.resolve(rel, opts);
    try {
      return await fs.readFile(abs, "utf8");
    } catch {
      return null;
    }
  }

  /** Files (repo-relative, posix) visible to `access`. Raw sources are excluded unless asked for. */
  async listFiles(opts: { access?: Access; includeSources?: boolean; under?: string } = {}): Promise<string[]> {
    const out: string[] = [];
    const walk = async (absDir: string, relDir: string) => {
      let entries;
      try {
        entries = await fs.readdir(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const rel = relDir ? `${relDir}/${e.name}` : e.name;
        const z = zoneOf(rel);
        if (z.kind === "meta") continue;
        if (z.kind === "source" && !opts.includeSources) continue;
        if (e.isDirectory()) await walk(path.join(absDir, e.name), rel);
        else if (!opts.access || opts.access.canRead(rel)) out.push(rel);
      }
    };
    const start = opts.under ? this.resolve(opts.under) : { rel: "", abs: this.dir };
    await walk(start.abs, start.rel);
    return out.sort();
  }

  /** Case-insensitive regex (falls back to literal) search across visible files. */
  async search(pattern: string, opts: { access?: Access; includeSources?: boolean; limit?: number } = {}): Promise<Hit[]> {
    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const limit = opts.limit ?? 80;
    const hits: Hit[] = [];
    for (const f of await this.listFiles(opts)) {
      const content = await this.readFile(f);
      if (content === null) continue;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]) || (i === 0 && re.test(f))) {
          hits.push({ path: f, line: i + 1, text: lines[i].slice(0, 400) });
          if (hits.length >= limit) return hits;
        }
      }
    }
    return hits;
  }

  /** Find the archived raw observation file for an id. */
  async findSource(id: string): Promise<string | null> {
    const bare = String(id).replace(/^obs\//, "").replace(/[^a-z0-9]/gi, "");
    const files = await this.listFiles({ under: SOURCES_DIR, includeSources: true }).catch(() => [] as string[]);
    return files.find((f) => f.endsWith(`/${bare}.md`)) ?? null;
  }

  // ---------- writes (only called from inside the team's serial queue) ----------

  async writeFile(rel: string, content: string, opts: { allowMeta?: boolean } = {}) {
    const { abs } = this.resolve(rel, opts);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content.endsWith("\n") ? content : content + "\n", "utf8");
  }

  async deleteFile(rel: string) {
    const { abs } = this.resolve(rel);
    await fs.rm(abs, { force: true });
    let dir = path.dirname(abs);
    while (dir.startsWith(this.dir) && dir !== this.dir) {
      const left = await fs.readdir(dir).catch(() => ["x"]);
      if (left.length) break;
      await fs.rmdir(dir).catch(() => {});
      dir = path.dirname(dir);
    }
  }

  /** Discard uncommitted changes (used when an agent run fails mid-way). */
  async rollback() {
    await this.git(["reset", "-q", "--hard", "HEAD"], { allowFail: true });
    await this.git(["clean", "-qfd"], { allowFail: true });
  }

  /** Paths with uncommitted changes (including untracked and deleted files). */
  async changedFiles(): Promise<string[]> {
    const out = await this.git(["status", "--porcelain", "-z", "-uall"]);
    const parts = out.split("\0").filter(Boolean);
    const files: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      files.push(entry.slice(3));
      if (entry[0] === "R" || entry[0] === "C") i++; // skip rename source
    }
    return files;
  }

  /**
   * Stage and commit. With `filter`, only matching changed files are committed (used to split
   * private and shared changes into separate commits). Returns null when nothing changed.
   */
  async commit(message: string, filter?: (rel: string) => boolean): Promise<CommitInfo | null> {
    if (filter) {
      const selected = (await this.changedFiles()).filter(filter);
      if (!selected.length) return null;
      await this.git(["add", "-A", "--", ...selected]);
    } else {
      await this.git(["add", "-A"]);
    }
    const staged = await this.git(["diff", "--cached", "--name-only"]);
    const files = staged.split("\n").filter(Boolean);
    if (!files.length) return null;
    await this.git(["commit", "-q", "-m", message]);
    const sha = (await this.git(["rev-parse", "--short", "HEAD"])).trim();
    return { sha, message, date: new Date().toISOString(), files };
  }

  async head(): Promise<string> {
    return (await this.git(["rev-parse", "--short", "HEAD"], { allowFail: true })).trim();
  }

  /** Unified diff since `sha` restricted to pathspecs (git pathspec magic allowed). */
  async diffSince(sha: string | null, pathspecs: string[], maxChars = 40_000): Promise<string> {
    const base = sha || (await this.git(["rev-list", "--max-parents=0", "HEAD"])).trim().split("\n")[0];
    const out = await this.git(["diff", "--no-color", `${base}..HEAD`, "--", ...pathspecs], { allowFail: true });
    return out.length > maxChars ? out.slice(0, maxChars) + `\n…[diff truncated]` : out;
  }

  async log(limit = 50): Promise<CommitInfo[]> {
    const sep = "\u001f";
    const out = await this.git(["log", `-n${limit}`, "--pretty=format:%x1e%h%x1f%aI%x1f%B%x1f", "--name-only"]);
    return out
      .split("\u001e")
      .filter((c) => c.trim())
      .map((chunk) => {
        const [sha, date, body, names] = chunk.split(sep);
        return { sha, date, message: (body ?? "").trim(), files: (names ?? "").split("\n").map((s) => s.trim()).filter(Boolean) };
      });
  }

  async show(sha: string, pathspecs: string[] = []): Promise<string> {
    if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new Error("bad sha");
    return this.git(["show", "--no-color", "--stat", "--patch", "--format=%h %aI%n%n%B", sha, "--", ...pathspecs]);
  }

  // ---------- meta state (inside the repo so it persists with it) ----------

  async readMeta<T extends object>(name: string, fallback: T): Promise<T> {
    const raw = await this.readFile(`${META_DIR}/${name}.json`, { allowMeta: true });
    if (!raw) return structuredClone(fallback);
    try {
      return { ...structuredClone(fallback), ...JSON.parse(raw) };
    } catch {
      return structuredClone(fallback);
    }
  }

  async writeMeta(name: string, value: unknown) {
    await this.writeFile(`${META_DIR}/${name}.json`, JSON.stringify(value, null, 2), { allowMeta: true });
  }
}

async function isFile(abs: string) {
  return fs
    .stat(abs)
    .then((s) => s.isFile())
    .catch(() => false);
}
