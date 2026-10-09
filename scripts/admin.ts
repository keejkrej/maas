/**
 * maas admin CLI — talks to the admin API.
 *
 *   $env:MAAS_URL="https://api-xxxx-ew.a.run.app"; $env:MAAS_TOKEN="<admin token or team-admin member key>"
 *   npm run admin -- teams
 *   npm run admin -- team:create acme "Acme Inc" chris "Chris"     # prints chris's key
 *   npm run admin -- members acme
 *   npm run admin -- member:add acme alice "Alice" [admin]          # prints alice's key
 *   npm run admin -- member:rotate acme alice
 *   npm run admin -- member:role acme alice admin|member
 *   npm run admin -- member:revoke acme alice
 *   npm run admin -- export acme [dir]                              # markdown snapshot to a local folder
 *   npm run admin -- dream acme
 *   npm run admin -- me
 */
const base = (process.env.MAAS_URL ?? "http://localhost:8080").replace(/\/(mcp)?\/?$/, "");
const token = process.env.MAAS_TOKEN;
if (!token) {
  console.error("Set MAAS_TOKEN to the admin token (or a team admin's member key).");
  process.exit(1);
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`${res.status}: ${(json as any).error ?? res.statusText}`);
    process.exit(1);
  }
  return json as any;
}

function printKey(out: any) {
  console.log(`\nMember : ${out.member.name} (${out.member.id}, ${out.member.role})`);
  console.log(`API key: ${out.key}\n`);
  console.log(`Give this to ${out.member.name}. It is shown only once. Connect with:`);
  console.log(`  MCP URL : ${base}/mcp   (header  Authorization: Bearer ${out.key})`);
  console.log(`  Viewer  : ${base}/view/?key=${out.key}\n`);
}

const [cmd, ...a] = process.argv.slice(2);
switch (cmd) {
  case "me":
    console.log(await call("GET", "/api/me"));
    break;
  case "teams":
    for (const t of await call("GET", "/api/teams"))
      console.log(`${t.id.padEnd(20)} ${t.name.padEnd(24)} ${t.members.filter((m: any) => !m.revokedAt).length} members`);
    break;
  case "team:create": {
    const [id, name, adminId, adminName] = a;
    if (!id || !adminId) throw new Error("usage: team:create <team-id> <name> <admin-id> [admin-name]");
    const out = await call("POST", "/api/teams", { id, name, admin: { id: adminId, name: adminName } });
    console.log(`Created team ${out.team.id}.`);
    printKey(out);
    break;
  }
  case "export": {
    // Writes the team's markdown (what this token may see) into a local folder.
    const [team, dir = `memory-${a[0]}`] = a;
    if (!team) throw new Error("usage: export <team-id> [dir]");
    const out = await call("GET", `/api/teams/${team}/files`);
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    for (const [rel, content] of Object.entries(out.files as Record<string, string>)) {
      const file = path.join(dir, ...rel.split("/"));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
    }
    console.log(`Exported ${Object.keys(out.files).length} files (head #${out.head}) to ${path.resolve(dir)}`);
    break;
  }
  case "members": {
    const t = await call("GET", `/api/teams/${a[0]}`);
    for (const m of t.members)
      console.log(`${m.id.padEnd(16)} ${m.name.padEnd(20)} ${m.role.padEnd(7)} ${m.keyPrefix}…  ${m.revokedAt ? "REVOKED " + m.revokedAt.slice(0, 10) : ""}`);
    break;
  }
  case "member:add":
    printKey(await call("POST", `/api/teams/${a[0]}/members`, { id: a[1], name: a[2], role: a[3] === "admin" ? "admin" : "member" }));
    break;
  case "member:rotate":
    printKey(await call("POST", `/api/teams/${a[0]}/members/${a[1]}/rotate`));
    break;
  case "member:role":
    console.log(await call("PATCH", `/api/teams/${a[0]}/members/${a[1]}`, { role: a[2] }));
    break;
  case "member:revoke":
    console.log(await call("DELETE", `/api/teams/${a[0]}/members/${a[1]}`));
    break;
  case "dream":
    console.log(await call("POST", `/api/teams/${a[0]}/dream`));
    break;
  default:
    console.log("commands: me | teams | team:create | members | export | member:add | member:rotate | member:role | member:revoke | dream");
}
