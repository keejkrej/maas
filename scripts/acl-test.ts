/**
 * Offline test of the team privacy model (no LLM needed):
 *   npx tsx scripts/acl-test.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { memberAccess, privateDreamAccess, sharedDreamAccess, zoneOf } from "../src/access.js";
import { commitVisibleTo } from "../src/agent/agent.js";
import { readTools, writeTools } from "../src/agent/tools.js";
import { MemoryRepo } from "../src/repo.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "maas-acl-"));
const repo = new MemoryRepo(path.join(dir, "memory"), "test/bundle", () => undefined);
await repo.init({ "MEMORY.md": "# Memory: Test\n\n## Index\n- [[projects/payments]]\n" });
await repo.writeFile("projects/payments.md", "# Payments\n- Uses Postgres [by: alice]\n");
await repo.writeFile("private/alice/MEMORY.md", "# Alice\n- Prefers tabs\n");
await repo.writeFile("private/bob/MEMORY.md", "# Bob\n- Secret project codename: HUMMINGBIRD\n");
await repo.writeFile("sources/bob/2026-10-08/abcd1234.md", "bob raw observation HUMMINGBIRD");
await repo.commit("seed");

const tool = (tools: any[], name: string) => tools.find((t) => t.name === name)!;
let passed = 0;
const ok = async (label: string, fn: () => Promise<void> | void) => {
  await fn();
  passed++;
  console.log(`  ✓ ${label}`);
};

console.log("zones");
await ok("zoneOf", () => {
  assert.equal(zoneOf("MEMORY.md").kind, "shared");
  assert.deepEqual(zoneOf("private/bob/x.md"), { kind: "private", member: "bob" });
  assert.deepEqual(zoneOf("sources/bob/d/x.md"), { kind: "source", member: "bob" });
  assert.equal(zoneOf(".maas/state.json").kind, "meta");
});

console.log("alice's agent (member access)");
const A = memberAccess("alice");
const ar = readTools(repo, A);
const aw = writeTools(repo, A);
await ok("lists shared + own private only", async () => {
  const out = await tool(ar, "list_files").run({});
  assert.match(out, /projects\/payments\.md/);
  assert.match(out, /private\/alice\/MEMORY\.md/);
  assert.doesNotMatch(out, /private\/bob/);
});
await ok("cannot read bob's private file", async () => {
  assert.match(await tool(ar, "read_file").run({ path: "private/bob/MEMORY.md" }), /outside your access/);
  assert.match(await tool(ar, "read_file").run({ path: "[[private/bob/MEMORY]]" }), /outside your access/);
});
await ok("path traversal is rejected", async () => {
  await assert.rejects(() => tool(ar, "read_file").run({ path: "../../etc/passwd" }));
  await assert.rejects(() => tool(ar, "read_file").run({ path: "private/alice/../../.git/config" }));
});
await ok("search never returns bob's content (even with sources)", async () => {
  assert.equal(await tool(ar, "search").run({ pattern: "HUMMINGBIRD", include_sources: true }), "No matches.");
});
await ok("cannot open bob's raw source", async () => {
  assert.match(await tool(ar, "read_source").run({ id: "obs/abcd1234" }), /private/);
});
await ok("cannot write/delete/move into bob's space or sources", async () => {
  assert.match(await tool(aw, "write_file").run({ path: "private/bob/evil.md", content: "x" }), /may not write/);
  assert.match(await tool(aw, "edit_file").run({ path: "private/bob/MEMORY.md", old_text: "Bob", new_text: "X" }), /may not write/);
  assert.match(await tool(aw, "delete_file").run({ path: "private/bob/MEMORY.md" }), /may not write/);
  assert.match(await tool(aw, "move_file").run({ from: "private/bob/MEMORY.md", to: "leak.md" }), /may not write/);
  assert.match(await tool(aw, "write_file").run({ path: "sources/alice/x.md", content: "x" }), /read-only/);
  assert.match(await tool(aw, "write_file").run({ path: ".maas/state.json", content: "x" }).catch((e: Error) => e.message), /not allowed/);
});
await ok("can write shared and own private", async () => {
  assert.match(await tool(aw, "append_entry").run({ path: "private/alice/prefs.md", lines: "- Likes dark mode" }), /Appended/);
  assert.match(await tool(aw, "edit_file").run({ path: "projects/payments.md", old_text: "Uses Postgres", new_text: "Uses Postgres 17" }), /Edited/);
});

console.log("dream scopes");
const S = sharedDreamAccess();
await ok("shared dream sees no private files", async () => {
  const out = await tool(readTools(repo, S), "list_files").run({});
  assert.doesNotMatch(out, /private\//);
  assert.match(await tool(writeTools(repo, S), "write_file").run({ path: "private/alice/x.md", content: "x" }), /may not write/);
});
await ok("bob's private dream can read shared but only write private/bob", async () => {
  const P = privateDreamAccess("bob");
  assert.match(await tool(readTools(repo, P), "read_file").run({ path: "projects/payments.md" }), /Postgres/);
  assert.match(await tool(writeTools(repo, P), "edit_file").run({ path: "projects/payments.md", old_text: "17", new_text: "18" }), /may not write/);
  assert.match(await tool(readTools(repo, P), "read_file").run({ path: "private/alice/MEMORY.md" }), /outside your access/);
});

console.log("split commits & history visibility");
await ok("personal and shared changes land in separate commits", async () => {
  const personal = await repo.commit("personal(alice): prefs", (rel) => rel.startsWith("private/alice/"));
  const shared = await repo.commit("payments: postgres 17");
  assert.deepEqual(personal?.files, ["private/alice/prefs.md"]);
  assert.deepEqual(shared?.files, ["projects/payments.md"]);
  assert.equal(commitVisibleTo(personal!, "bob"), false);
  assert.equal(commitVisibleTo(personal!, "alice"), true);
  assert.equal(commitVisibleTo(shared!, "bob"), true);
  assert.equal(await repo.commit("nothing", () => true), null);
});
await ok("diffSince over the shared space excludes private changes", async () => {
  await repo.writeFile("private/bob/MEMORY.md", "# Bob\n- changed\n");
  await repo.commit("bob change");
  const diff = await repo.diffSince(null, [".", ":(exclude)private", ":(exclude)sources", ":(exclude).maas"]);
  assert.match(diff, /Postgres 17/);
  assert.doesNotMatch(diff, /HUMMINGBIRD|changed|tabs/);
});

await fs.rm(dir, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
