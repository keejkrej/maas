import { type Access, privateRoot, SOURCES_DIR, zoneOf } from "../access.js";
import type { AgentTool } from "../llm.js";
import type { TeamStore } from "../store.js";

const str = (description: string) => ({ type: "string", description });

function denyRead(access: Access, rel: string) {
  return access.canRead(rel) ? null : `Error: ${rel} is outside your access (${access.label}).`;
}
function denyWrite(access: Access, rel: string) {
  if (zoneOf(rel).kind === "source") return "Error: sources/ is read-only.";
  return access.canWrite(rel) ? null : `Error: you may not write ${rel} (${access.label}).`;
}

/** Read-only tools, scoped to `access`. */
export function readTools(repo: TeamStore, access: Access): AgentTool[] {
  return [
    {
      name: "list_files",
      description: "List memory files you can see (excluding raw sources), with entry counts. Optionally restrict to a folder.",
      parameters: { type: "object", properties: { folder: str("Optional folder, e.g. 'projects' or 'private/alice'") } },
      async run({ folder }) {
        const files = await repo.listFiles({ access, under: folder || undefined });
        if (!files.length) return "(no files)";
        const lines = await Promise.all(
          files.map(async (f) => {
            const c = (await repo.readFile(f)) ?? "";
            return `${f}  (${c.split("\n").filter((l) => l.trim().startsWith("-")).length} entries)`;
          }),
        );
        return lines.join("\n");
      },
    },
    {
      name: "read_file",
      description: "Read a memory file. Accepts paths like 'people/priya.md' or wiki links like '[[people/priya]]'.",
      parameters: { type: "object", properties: { path: str("Repo-relative path") }, required: ["path"] },
      async run({ path }) {
        const rel = await repo.locate(path);
        if (!rel) return `File not found: ${path}`;
        const denied = denyRead(access, rel);
        if (denied) return denied;
        const c = (await repo.readFile(rel)) ?? "";
        return c
          .split("\n")
          .map((l, i) => `${String(i + 1).padStart(4)}| ${l}`)
          .join("\n");
      },
    },
    {
      name: "search",
      description:
        "Case-insensitive regex search over the memory files you can see (like grep -rni). Use several short searches with synonyms rather than one long one.",
      parameters: {
        type: "object",
        properties: {
          pattern: str("Regex or keyword, e.g. 'priya|pune'"),
          include_sources: { type: "boolean", description: "Also search raw observations you have access to (default false)" },
        },
        required: ["pattern"],
      },
      async run({ pattern, include_sources }) {
        const hits = await repo.search(pattern, { access, includeSources: !!include_sources });
        if (!hits.length) return "No matches.";
        return hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join("\n");
      },
    },
    {
      name: "read_source",
      description: "Open the raw observation behind a citation like [source: obs/<id>]. Only works for observations you have access to.",
      parameters: { type: "object", properties: { id: str("Observation id, e.g. 'obs/k3x9q2'") }, required: ["id"] },
      async run({ id }) {
        const m = access.member;
        if (!m || !access.canRead(`${SOURCES_DIR}/${m}/x`)) return "Raw observations are not available in this run (they are private to their author).";
        const s = await repo.getSource(m, id);
        if (!s) return `No source found for ${id} among your own observations (other members' observations are private).`;
        return `id: obs/${s.id}\nby: ${s.member}\nkind: ${s.kind}\nscope: ${s.scope}\nreceived: ${s.receivedAt}${s.context ? `\ncontext: ${s.context}` : ""}\n\n${s.content}`;
      },
    },
  ];
}

/** Write tools for ingest and dream runs. Changes stay uncommitted until the run finishes. */
export function writeTools(repo: TeamStore, access: Access): AgentTool[] {
  return [
    {
      name: "write_file",
      description: "Create or fully overwrite a markdown file. Prefer edit_file for small changes to existing files.",
      parameters: {
        type: "object",
        properties: { path: str("Repo-relative path ending in .md"), content: str("Full file content") },
        required: ["path", "content"],
      },
      async run({ path, content }) {
        const rel = repo.resolve(path);
        const denied = denyWrite(access, rel);
        if (denied) return denied;
        repo.writeFile(rel, content);
        return `Wrote ${rel}`;
      },
    },
    {
      name: "edit_file",
      description:
        "Replace an exact snippet in a file. old_text must match exactly once (copy it from read_file without the line-number prefix). Use empty new_text to delete.",
      parameters: {
        type: "object",
        properties: { path: str("Repo-relative path"), old_text: str("Exact text to replace"), new_text: str("Replacement text") },
        required: ["path", "old_text", "new_text"],
      },
      async run({ path, old_text, new_text }) {
        const rel = await repo.locate(path);
        if (!rel) return `Error: file not found: ${path}`;
        const denied = denyWrite(access, rel);
        if (denied) return denied;
        const c = (await repo.readFile(rel)) ?? "";
        const count = c.split(old_text).length - 1;
        if (count === 0) return `Error: old_text not found in ${rel}. Re-read the file and copy the text exactly.`;
        if (count > 1) return `Error: old_text matches ${count} times in ${rel}; include more context.`;
        let next = c.replace(old_text, () => new_text);
        if (new_text === "") next = next.replace(/\n{3,}/g, "\n\n");
        repo.writeFile(rel, next);
        return `Edited ${rel}`;
      },
    },
    {
      name: "append_entry",
      description: "Append bullet line(s) to a file, creating it with a '# Title' heading if needed.",
      parameters: {
        type: "object",
        properties: {
          path: str("Repo-relative path"),
          lines: str("Bullet line(s) to append, each starting with '- '"),
          title: str("Heading to use if the file is new"),
        },
        required: ["path", "lines"],
      },
      async run({ path, lines, title }) {
        const rel = repo.resolve(path);
        const denied = denyWrite(access, rel);
        if (denied) return denied;
        const existing = await repo.readFile(rel);
        const base = existing ?? `# ${title || rel.replace(/\.md$/, "").split("/").pop()}\n\n`;
        repo.writeFile(rel, base.replace(/\n*$/, "\n") + String(lines).trim() + "\n");
        return `Appended to ${rel}${existing === null ? " (new file — link it from the relevant MEMORY.md index or a parent file)" : ""}`;
      },
    },
    {
      name: "move_file",
      description: "Rename/move a file. Update [[links]] that point to it yourself.",
      parameters: { type: "object", properties: { from: str("Current path"), to: str("New path") }, required: ["from", "to"] },
      async run({ from, to }) {
        const src = await repo.locate(from);
        if (!src) return `Error: file not found: ${from}`;
        const dst = repo.resolve(to);
        const denied = denyWrite(access, src) ?? denyWrite(access, dst);
        if (denied) return denied;
        repo.writeFile(dst, (await repo.readFile(src)) ?? "");
        repo.deleteFile(src);
        return `Moved ${src} -> ${dst}`;
      },
    },
    {
      name: "delete_file",
      description: "Delete a file (e.g. after merging it elsewhere). Fix links that pointed to it.",
      parameters: { type: "object", properties: { path: str("Repo-relative path") }, required: ["path"] },
      async run({ path }) {
        const rel = await repo.locate(path);
        if (!rel) return `Error: file not found: ${path}`;
        if (rel === "MEMORY.md") return "Error: MEMORY.md cannot be deleted";
        const denied = denyWrite(access, rel);
        if (denied) return denied;
        repo.deleteFile(rel);
        return `Deleted ${rel}`;
      },
    },
  ];
}

/**
 * Terminal tool for ingest runs. Separate messages for shared and personal changes, because they are
 * committed separately and teammates can see shared commit messages but not personal ones.
 */
export function ingestCommitTool(): AgentTool {
  return {
    name: "commit",
    description:
      "Finish. Give a commit message for the shared team changes and, separately, one for personal changes. " +
      "team_message must not reveal anything personal. Use 'no-op: <reason>' when nothing was saved in that space.",
    parameters: {
      type: "object",
      properties: {
        team_message: str("Commit message for changes outside private/ (or 'no-op: …')"),
        personal_message: str("Commit message for changes in your private/ space (or 'no-op: …')"),
      },
      required: ["team_message", "personal_message"],
    },
    terminal: true,
    async run({ team_message, personal_message }) {
      return JSON.stringify({ team: String(team_message || "no-op"), personal: String(personal_message || "no-op") });
    },
  };
}

/** Terminal tool for dream runs (single scope). */
export function commitTool(): AgentTool {
  return {
    name: "commit",
    description: "Finish. Provide a short commit message describing what changed (or 'no-op: …' if nothing needed changing).",
    parameters: { type: "object", properties: { message: str("Commit message, <= 72 chars first line") }, required: ["message"] },
    terminal: true,
    async run({ message }) {
      return String(message || "update memory").trim();
    },
  };
}

export { privateRoot };
