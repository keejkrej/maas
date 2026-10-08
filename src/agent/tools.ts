import type { AgentTool } from "../llm.js";
import { repo, SOURCES_DIR } from "../repo.js";

const str = (description: string) => ({ type: "string", description });

/** Read-only tools: used by recall and by the writer agents. */
export function readTools(): AgentTool[] {
  return [
    {
      name: "list_files",
      description: "List files in the memory repo (excluding raw sources). Optionally restrict to a folder.",
      parameters: { type: "object", properties: { folder: str("Optional folder, e.g. 'people'") } },
      async run({ folder }) {
        const files = await repo.listFiles({ under: folder || undefined });
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
      description: "Read a file from the memory repo. Accepts paths like 'people/priya.md' or wiki links like '[[people/priya]]'.",
      parameters: { type: "object", properties: { path: str("Repo-relative path") }, required: ["path"] },
      async run({ path }) {
        const c = await repo.readFile(path);
        if (c === null) return `File not found: ${path}`;
        return c
          .split("\n")
          .map((l, i) => `${String(i + 1).padStart(4)}| ${l}`)
          .join("\n");
      },
    },
    {
      name: "search",
      description:
        "Case-insensitive regex search over all memory files (like grep -rni). Use several short searches with synonyms rather than one long one. Returns path:line: text.",
      parameters: {
        type: "object",
        properties: {
          pattern: str("Regex or keyword, e.g. 'priya|pune'"),
          include_sources: { type: "boolean", description: "Also search raw source observations (default false)" },
        },
        required: ["pattern"],
      },
      async run({ pattern, include_sources }) {
        const hits = await repo.search(pattern, { includeSources: !!include_sources });
        if (!hits.length) return "No matches.";
        return hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join("\n");
      },
    },
    {
      name: "read_source",
      description:
        "Open the raw observation behind a citation like [source: obs/<id>]. Use it to check provenance or resolve contradictions.",
      parameters: { type: "object", properties: { id: str("Observation id, e.g. 'obs/k3x9q2' or 'k3x9q2'") }, required: ["id"] },
      async run({ id }) {
        const bare = String(id).replace(/^obs\//, "").trim();
        const files = await repo.listFiles({ under: SOURCES_DIR, includeSources: true }).catch(() => []);
        const match = files.find((f) => f.endsWith(`/${bare}.md`));
        if (!match) return `No source found for ${id}`;
        return (await repo.readFile(match)) ?? `No source found for ${id}`;
      },
    },
  ];
}

/** Write tools for the ingest and dream agents. Changes stay uncommitted until the run finishes. */
export function writeTools(): AgentTool[] {
  return [
    {
      name: "write_file",
      description: "Create or fully overwrite a markdown file in the memory repo. Prefer edit_file for small changes to existing files.",
      parameters: {
        type: "object",
        properties: { path: str("Repo-relative path ending in .md"), content: str("Full file content") },
        required: ["path", "content"],
      },
      async run({ path, content }) {
        const { rel } = repo.resolve(path);
        if (rel.split("/")[0] === SOURCES_DIR) return "Error: sources/ is read-only";
        await repo.writeFile(rel, content);
        return `Wrote ${rel}`;
      },
    },
    {
      name: "edit_file",
      description:
        "Replace an exact snippet in a file. old_text must match exactly once (copy it from read_file without the line-number prefix). Use an empty new_text to delete lines.",
      parameters: {
        type: "object",
        properties: { path: str("Repo-relative path"), old_text: str("Exact text to replace"), new_text: str("Replacement text") },
        required: ["path", "old_text", "new_text"],
      },
      async run({ path, old_text, new_text }) {
        const { rel } = repo.resolve(path);
        if (rel.split("/")[0] === SOURCES_DIR) return "Error: sources/ is read-only";
        const c = await repo.readFile(rel);
        if (c === null) return `Error: file not found: ${rel}`;
        const count = c.split(old_text).length - 1;
        if (count === 0) return `Error: old_text not found in ${rel}. Re-read the file and copy the text exactly.`;
        if (count > 1) return `Error: old_text matches ${count} times in ${rel}; include more context.`;
        let next = c.replace(old_text, () => new_text);
        if (new_text === "") next = next.replace(/\n{3,}/g, "\n\n");
        await repo.writeFile(rel, next);
        return `Edited ${rel}`;
      },
    },
    {
      name: "append_entry",
      description: "Append one or more bullet lines to a file (creating it with a '# Title' heading if needed). Handy for adding facts.",
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
        const { rel } = repo.resolve(path);
        if (rel.split("/")[0] === SOURCES_DIR) return "Error: sources/ is read-only";
        const existing = await repo.readFile(rel);
        const base = existing ?? `# ${title || rel.replace(/\.md$/, "").split("/").pop()}\n\n`;
        await repo.writeFile(rel, base.replace(/\n*$/, "\n") + String(lines).trim() + "\n");
        return `Appended to ${rel}${existing === null ? " (new file — remember to link it from MEMORY.md or a parent file)" : ""}`;
      },
    },
    {
      name: "move_file",
      description: "Rename/move a file. You must update [[links]] that point to it yourself.",
      parameters: { type: "object", properties: { from: str("Current path"), to: str("New path") }, required: ["from", "to"] },
      async run({ from, to }) {
        const c = await repo.readFile(from);
        if (c === null) return `Error: file not found: ${from}`;
        const dst = repo.resolve(to).rel;
        await repo.writeFile(dst, c);
        await repo.deleteFile(repo.resolve(from).rel);
        return `Moved ${from} -> ${dst}`;
      },
    },
    {
      name: "delete_file",
      description: "Delete a file from the memory repo (e.g. after merging it elsewhere). Fix links that pointed to it.",
      parameters: { type: "object", properties: { path: str("Repo-relative path") }, required: ["path"] },
      async run({ path }) {
        const { rel } = repo.resolve(path);
        if (rel === "MEMORY.md") return "Error: MEMORY.md cannot be deleted";
        if (rel.split("/")[0] === SOURCES_DIR) return "Error: sources/ is read-only";
        await repo.deleteFile(rel);
        return `Deleted ${rel}`;
      },
    },
  ];
}

/** Terminal tool that ends a writer run with a commit message. */
export function commitTool(): AgentTool {
  return {
    name: "commit",
    description:
      "Finish your work. Provide a short commit message describing what changed in memory (or starting with 'no-op:' if nothing was worth saving).",
    parameters: { type: "object", properties: { message: str("Commit message, imperative mood, <= 72 chars first line") }, required: ["message"] },
    terminal: true,
    async run({ message }) {
      return String(message || "update memory").trim();
    },
  };
}
