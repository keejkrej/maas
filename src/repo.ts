import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { blobs } from "./storage.js";

const exec = promisify(execFile);

/** Directories inside the repo that the agent does not browse by default. */
export const SOURCES_DIR = "sources";
export const META_DIR = ".maas";
const HIDDEN = new Set([".git", META_DIR]);
const BUNDLE_KEY = "repo/memory.bundle";

export interface CommitInfo {
  sha: string;
  message: string;
  date: string;
  files: string[];
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function seedMemory(owner: string) {
  return `# Memory: ${owner}

This file is the entry point to ${owner}'s memory. It is loaded at the start of every session,
so it stays short: only what every session needs, plus links to topic files.

## Core facts

## Index
`;
}

/**
 * The memory repo: a git repository of markdown, maintained by the memory agent.
 * All writes go through the agent's serial queue, so there is exactly one writer.
 */
export class MemoryRepo {
  readonly dir = config.repoDir;

  async git(args: string[], opts: { allowFail?: boolean } = {}): Promise<string> {
    try {
      const { stdout } = await exec(
        "git",
        ["-c", "user.name=maas-memory-agent", "-c", "user.email=agent@maas.local", "-c", "core.quotepath=off", ...args],
        { cwd: this.dir, maxBuffer: 32 * 1024 * 1024 },
      );
      return stdout;
    } catch (e: any) {
      if (opts.allowFail) return "";
      throw new Error(`git ${args.join(" ")} failed: ${e?.stderr || e?.message}`);
    }
  }

  /** Restore from remote/bundle or create a fresh repo. */
  async init() {
    await fs.mkdir(path.dirname(this.dir), { recursive: true });
    const hasGit = await fs
      .stat(path.join(this.dir, ".git"))
      .then(() => true)
      .catch(() => false);

    if (!hasGit) {
      if (config.gitRemote && (await this.tryClone(config.gitRemote))) {
        console.log(`[repo] cloned from git remote`);
      } else if (blobs.kind === "gcs" && (await this.tryRestoreBundle())) {
        console.log(`[repo] restored from GCS bundle`);
      } else {
        await fs.mkdir(this.dir, { recursive: true });
        await this.git(["init", "-b", "main"]);
        await this.writeFile("MEMORY.md", seedMemory(config.ownerName));
        await this.commit("init: create memory repo");
        await this.persist();
        console.log(`[repo] initialised new memory repo at ${this.dir}`);
      }
    }
    if (config.gitRemote) {
      await this.git(["remote", "remove", "origin"], { allowFail: true });
      await this.git(["remote", "add", "origin", config.gitRemote]);
    }
  }

  private async tryClone(url: string) {
    try {
      await exec("git", ["clone", url, this.dir]);
      // An empty remote clones fine but has no commits; seed it.
      const head = await this.git(["rev-parse", "--verify", "HEAD"], { allowFail: true });
      if (!head.trim()) {
        await this.git(["checkout", "-B", "main"]);
        await this.writeFile("MEMORY.md", seedMemory(config.ownerName));
        await this.commit("init: create memory repo");
        await this.persist();
      }
      return true;
    } catch (e) {
      console.warn(`[repo] clone failed, falling back:`, (e as Error).message);
      await fs.rm(this.dir, { recursive: true, force: true });
      return false;
    }
  }

  private async tryRestoreBundle() {
    const tmp = path.join(os.tmpdir(), `maas-restore-${Date.now()}.bundle`);
    if (!(await blobs.getFile(BUNDLE_KEY, tmp))) return false;
    await exec("git", ["clone", "-b", "main", tmp, this.dir]);
    await this.git(["remote", "remove", "origin"], { allowFail: true });
    await fs.rm(tmp, { force: true });
    return true;
  }

  /** Push the current state to durable storage. Called after every commit. */
  async persist() {
    if (config.gitRemote) {
      await this.git(["push", "-u", "origin", "HEAD:main"]).catch((e) =>
        console.error(`[repo] push failed:`, e.message),
      );
    }
    if (blobs.kind === "gcs") {
      const tmp = path.join(os.tmpdir(), `maas-${Date.now()}.bundle`);
      await this.git(["bundle", "create", tmp, "main"]);
      await blobs.putFile(BUNDLE_KEY, tmp);
      await fs.rm(tmp, { force: true });
    }
  }

  // ---------- paths ----------

  /** Normalise and validate a repo-relative path. Throws on escape attempts or hidden dirs. */
  resolve(rel: string, opts: { allowMeta?: boolean } = {}): { rel: string; abs: string } {
    let clean = rel.replace(/\\/g, "/").replace(/^\/+/, "").trim();
    if (clean.startsWith("[[") && clean.endsWith("]]")) clean = clean.slice(2, -2);
    const norm = path.posix.normalize(clean);
    if (!norm || norm === "." || norm.startsWith("..")) throw new Error(`Invalid path: ${rel}`);
    const top = norm.split("/")[0];
    if (top === ".git" || (top === META_DIR && !opts.allowMeta)) throw new Error(`Path not allowed: ${rel}`);
    return { rel: norm, abs: path.join(this.dir, ...norm.split("/")) };
  }

  // ---------- reads ----------

  async readFile(rel: string, opts: { allowMeta?: boolean } = {}): Promise<string | null> {
    const { abs } = this.resolve(rel, opts);
    try {
      return await fs.readFile(abs, "utf8");
    } catch {
      // Allow [[wiki-links]] without the .md extension.
      if (!abs.endsWith(".md")) {
        try {
          return await fs.readFile(abs + ".md", "utf8");
        } catch {}
      }
      return null;
    }
  }

  async exists(rel: string) {
    return (await this.readFile(rel)) !== null;
  }

  /** All files (repo-relative, posix), excluding .git/.maas and optionally sources/. */
  async listFiles(opts: { includeSources?: boolean; under?: string } = {}): Promise<string[]> {
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
        if (!relDir && HIDDEN.has(e.name)) continue;
        if (!relDir && e.name === SOURCES_DIR && !opts.includeSources) continue;
        if (e.isDirectory()) await walk(path.join(absDir, e.name), rel);
        else out.push(rel);
      }
    };
    const start = opts.under ? this.resolve(opts.under) : { rel: "", abs: this.dir };
    await walk(start.abs, start.rel);
    return out.sort();
  }

  /** Case-insensitive regex (falls back to literal) search across the repo. */
  async search(
    pattern: string,
    opts: { includeSources?: boolean; limit?: number } = {},
  ): Promise<{ path: string; line: number; text: string }[]> {
    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const limit = opts.limit ?? 80;
    const hits: { path: string; line: number; text: string }[] = [];
    for (const f of await this.listFiles({ includeSources: opts.includeSources })) {
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

  // ---------- writes (only called from inside the agent's serial queue) ----------

  async writeFile(rel: string, content: string, opts: { allowMeta?: boolean } = {}) {
    const { abs } = this.resolve(rel, opts);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content.endsWith("\n") ? content : content + "\n", "utf8");
  }

  async deleteFile(rel: string) {
    const { abs } = this.resolve(rel);
    await fs.rm(abs, { force: true });
    // Clean up empty parent dirs.
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
    await this.git(["reset", "--hard", "HEAD"], { allowFail: true });
    await this.git(["clean", "-fd"], { allowFail: true });
  }

  async changedFiles(): Promise<string[]> {
    const out = await this.git(["status", "--porcelain", "-uall"]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3).trim());
  }

  /** Stage everything and commit. Returns null when there is nothing to commit. */
  async commit(message: string): Promise<CommitInfo | null> {
    await this.git(["add", "-A"]);
    const staged = await this.git(["diff", "--cached", "--name-only"]);
    const files = staged.split("\n").filter(Boolean);
    if (!files.length) return null;
    await this.git(["commit", "-q", "-m", message]);
    const sha = (await this.git(["rev-parse", "--short", "HEAD"])).trim();
    return { sha, message, date: new Date().toISOString(), files };
  }

  async log(limit = 20): Promise<CommitInfo[]> {
    const sep = "\u001f";
    const out = await this.git(
      ["log", `-n${limit}`, `--pretty=format:%x1e%h${sep}%aI${sep}%B`, "--name-only"],
      { allowFail: true },
    );
    return out
      .split("\u001e")
      .filter((c) => c.trim())
      .map((chunk) => {
        const [sha, date, rest] = chunk.split(sep);
        // %B is followed by a blank line then file names.
        const parts = (rest ?? "").replace(/\n+$/, "").split("\n\n");
        const files = parts.length > 1 ? parts.pop()!.split("\n").filter(Boolean) : [];
        return { sha, date, message: parts.join("\n\n").trim(), files };
      });
  }

  async show(sha: string): Promise<string> {
    if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new Error("bad sha");
    return this.git(["show", "--stat", "--patch", "--format=%h %aI%n%n%B", sha]);
  }

  // ---------- meta state (inside the repo so it persists with it) ----------

  async readMeta<T>(name: string, fallback: T): Promise<T> {
    const raw = await this.readFile(`${META_DIR}/${name}.json`, { allowMeta: true });
    if (!raw) return fallback;
    try {
      return { ...fallback, ...JSON.parse(raw) };
    } catch {
      return fallback;
    }
  }

  async writeMeta(name: string, value: unknown) {
    await this.writeFile(`${META_DIR}/${name}.json`, JSON.stringify(value, null, 2), { allowMeta: true });
  }
}

export { today };
export const repo = new MemoryRepo();
