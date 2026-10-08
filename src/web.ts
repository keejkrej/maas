import express, { type Request, type Response, type Router } from "express";
import { memberAccess, privateRoot } from "./access.js";
import { commitVisibleTo, hub, type TeamMemory } from "./agent/agent.js";
import { activeMembers, registry, type Member } from "./teams.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function renderMd(md: string): string {
  const out: string[] = [];
  let inList = false;
  const inline = (s: string) =>
    esc(s)
      .replace(/\[\[([^\]]+)\]\]/g, (_, p) => `<a href="/view/file?path=${encodeURIComponent(p)}">[[${p}]]</a>`)
      .replace(/\[(source|added|updated|until|by):([^\]]*)\]/g, (m) => `<span class="meta">${m}</span>`)
      .replace(/obs\/([a-z0-9]{6,8})/g, (m, id) => `<a class="meta" href="/view/source?id=${id}">${m}</a>`)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  for (const line of md.split("\n")) {
    const h = line.match(/^(#{1,4})\s+(.*)/);
    const li = line.match(/^\s*[-*]\s+(.*)/);
    if (li) {
      if (!inList) out.push("<ul>"), (inList = true);
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) out.push("</ul>"), (inList = false);
    if (h) out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

interface Ctx {
  tm: TeamMemory;
  member: Member;
}

async function ctxOf(req: Request): Promise<Ctx> {
  const a = req.maas;
  if (a?.kind !== "member") throw new Error("unauthenticated");
  return { tm: await hub.get(a.team.id), member: a.member };
}

async function page({ tm, member }: Ctx, title: string, body: string) {
  const access = memberAccess(member.id);
  const files = await tm.repo.listFiles({ access });
  const mine = privateRoot(member.id) + "/";
  const shared = files.filter((f) => !f.startsWith("private/"));
  const personal = files.filter((f) => f.startsWith(mine));
  const meta = await tm.meta();
  const pending = tm.pendingObservations().length;
  const link = (f: string, label = f) => `<a href="/view/file?path=${encodeURIComponent(f)}">${esc(label)}</a>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} · maas</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;--fg:#1d1d1f;--mut:#6e6e73;--bd:#d2d2d7;--bg:#fff;--acc:#0b5cff;--priv:#8a4baf}
@media(prefers-color-scheme:dark){:root{--fg:#e8e8ed;--mut:#98989d;--bd:#3a3a3c;--bg:#151516;--acc:#6ea0ff;--priv:#c38ff0}}
body{margin:0;font:14px/1.55 ui-sans-serif,system-ui,sans-serif;color:var(--fg);background:var(--bg);display:grid;grid-template-columns:270px 1fr;min-height:100vh}
nav{border-right:1px solid var(--bd);padding:16px;overflow:auto;font-size:13px}
nav a{display:block;color:var(--fg);text-decoration:none;padding:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
nav a:hover{color:var(--acc)} nav h3{font-size:11px;text-transform:uppercase;color:var(--mut);margin:18px 0 6px}
nav .priv a{color:var(--priv)}
main{padding:24px 40px;max-width:920px} a{color:var(--acc)} .meta{color:var(--mut);font-size:12px;text-decoration:none}
pre{background:rgba(127,127,127,.1);padding:12px;border-radius:8px;overflow:auto;font-size:12px;white-space:pre-wrap}
.stat{color:var(--mut);font-size:12px} li{margin:3px 0} code{font-size:12px;background:rgba(127,127,127,.12);padding:1px 4px;border-radius:4px}
table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid var(--bd);padding:6px 8px;vertical-align:top;font-size:13px;text-align:left}
.d-add{color:#1a7f37}.d-del{color:#cf222e} .badge{font-size:11px;border:1px solid var(--bd);border-radius:10px;padding:0 6px;color:var(--mut)}
.badge.priv{color:var(--priv);border-color:var(--priv)}
button,input,select{font:inherit;padding:5px 10px;border-radius:6px;border:1px solid var(--bd);background:transparent;color:var(--fg)}
button{cursor:pointer} .key{font:13px ui-monospace,monospace;padding:10px;border:1px dashed var(--acc);border-radius:8px;word-break:break-all}
</style></head><body>
<nav><a href="/view"><b>🧠 ${esc(tm.team.name)}</b></a>
<div class="stat">signed in as <b>${esc(member.name)}</b> (${esc(member.id)}${member.role === "admin" ? ", admin" : ""}) · <a style="display:inline" href="/logout">log out</a><br>
${meta.totalObservations} observations · ${meta.totalDreams} dreams<br>agent: ${esc(tm.status.busy ?? "idle")}${pending ? ` · ${pending} pending` : ""}</div>
<h3>Views</h3><a href="/view">Team MEMORY.md</a><a href="/view/file?path=${encodeURIComponent(mine + "MEMORY.md")}">My MEMORY.md</a>
<a href="/view/log">History</a><a href="/view/inbox">Inbox</a><a href="/view/team">Team &amp; keys</a>
<h3>Team (${shared.length})</h3>${shared.map((f) => link(f)).join("")}
<h3>Personal — only you (${personal.length})</h3><div class="priv">${personal.map((f) => link(f, f.slice(mine.length))).join("") || '<span class="stat">empty</span>'}</div>
</nav><main>${body}</main></body></html>`;
}

const h =
  (fn: (req: Request, res: Response, ctx: Ctx) => Promise<void>) =>
  async (req: Request, res: Response) => {
    try {
      await fn(req, res, await ctxOf(req));
    } catch (e) {
      res.status(400).send(`<pre>${esc((e as Error).message)}</pre>`);
    }
  };

export function viewerRouter(): Router {
  const r = express.Router();

  r.get("/", h(async (_req, res, ctx) => {
    const md = (await ctx.tm.repo.readFile("MEMORY.md")) ?? "";
    res.send(await page(ctx, "MEMORY.md", `<div class="stat">MEMORY.md <span class="badge">team</span></div>${renderMd(md)}`));
  }));

  r.get("/file", h(async (req, res, ctx) => {
    const access = memberAccess(ctx.member.id);
    const p = String(req.query.path ?? "");
    const rel = await ctx.tm.repo.locate(p).catch(() => null);
    if (!rel || !access.canRead(rel)) return void res.send(await page(ctx, p, `<p>Not found: ${esc(p)}</p>`));
    const c = (await ctx.tm.repo.readFile(rel)) ?? "";
    const target = rel.replace(/\.md$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bl = [...new Set((await ctx.tm.repo.search(`\\[\\[${target}(\\.md)?\\]\\]`, { access })).map((b) => b.path))].filter((x) => x !== rel);
    const badge = rel.startsWith("private/") ? `<span class="badge priv">personal</span>` : `<span class="badge">team</span>`;
    res.send(
      await page(
        ctx,
        rel,
        `<div class="stat">${esc(rel)} ${badge}</div>${renderMd(c)}` +
          (bl.length ? `<h3>Backlinks</h3><ul>${bl.map((b) => `<li><a href="/view/file?path=${encodeURIComponent(b)}">${esc(b)}</a></li>`).join("")}</ul>` : "") +
          `<details><summary class="stat">raw</summary><pre>${esc(c)}</pre></details>`,
      ),
    );
  }));

  r.get("/source", h(async (req, res, ctx) => {
    const f = await ctx.tm.repo.findSource(String(req.query.id ?? ""));
    const ok = f && memberAccess(ctx.member.id).canRead(f);
    const body = !f
      ? `<p>No such observation.</p>`
      : ok
        ? `<div class="stat">${esc(f)}</div><pre>${esc((await ctx.tm.repo.readFile(f)) ?? "")}</pre>`
        : `<p>This observation was contributed by another member; raw observations are private to their author.</p>`;
    res.send(await page(ctx, "source", body));
  }));

  r.get("/log", h(async (_req, res, ctx) => {
    const log = await ctx.tm.visibleLog(ctx.member.id, 100);
    const rows = log
      .map((c) => {
        const files = c.files.filter((f) => !f.startsWith(".maas/"));
        const priv = files.some((f) => f.startsWith("private/") || f.startsWith("sources/"));
        return (
          `<tr><td><a href="/view/commit?sha=${c.sha}"><code>${c.sha}</code></a><br><span class="stat">${esc(c.date.slice(0, 16).replace("T", " "))}</span></td>` +
          `<td>${priv ? '<span class="badge priv">personal</span> ' : ""}${esc(c.message.split("\n")[0])}<br><span class="stat">${esc(files.join(", "))}</span></td></tr>`
        );
      })
      .join("");
    res.send(await page(ctx, "History", `<h2>History</h2><form method="post" action="/view/dream"><button>🌙 Dream now</button></form><br><table>${rows}</table>`));
  }));

  r.get("/commit", h(async (req, res, ctx) => {
    const sha = String(req.query.sha ?? "");
    const all = await ctx.tm.repo.log(500);
    const c = all.find((x) => x.sha.startsWith(sha) || sha.startsWith(x.sha));
    if (!c || !commitVisibleTo(c, ctx.member.id)) return void res.send(await page(ctx, "commit", `<p>Not found.</p>`));
    const diff = await ctx.tm.repo.show(c.sha, [".", ":(exclude).maas"]);
    const html = esc(diff)
      .split("\n")
      .map((l) => (l.startsWith("+") && !l.startsWith("+++") ? `<span class="d-add">${l}</span>` : l.startsWith("-") && !l.startsWith("---") ? `<span class="d-del">${l}</span>` : l))
      .join("\n");
    res.send(await page(ctx, `commit ${c.sha}`, `<pre>${html}</pre>`));
  }));

  r.get("/inbox", h(async (_req, res, ctx) => {
    const mine = ctx.tm.pendingObservations(ctx.member.id);
    const others = ctx.tm.pendingObservations().length - mine.length;
    const recent = ctx.tm.recentResults(ctx.member.id);
    res.send(
      await page(
        ctx,
        "Inbox",
        `<h2>Your pending observations (${mine.length})</h2>` +
          (mine.length ? `<table>${mine.map((o) => `<tr><td><code>obs/${o.id}</code><br><span class="stat">${esc(o.client ?? "")} · ${o.scope}</span></td><td>${esc(o.content)}</td></tr>`).join("")}</table>` : `<p class="stat">Nothing waiting.</p>`) +
          (others ? `<p class="stat">+ ${others} from teammates.</p>` : "") +
          (ctx.tm.status.lastError ? `<p class="d-del">Last error: ${esc(ctx.tm.status.lastError)}</p>` : "") +
          `<h2>Recent agent runs (since boot)</h2><table>${recent
            .map(
              (r) =>
                `<tr><td>${esc(r.member ?? "dream")}</td><td>${r.teamMessage ? `<b>team:</b> ${esc(r.teamMessage)}<br>` : ""}${r.personalMessage ? `<b>personal:</b> ${esc(r.personalMessage)}<br>` : ""}<span class="stat">${r.commits.map((c) => c.sha).join(", ")}</span></td></tr>`,
            )
            .join("")}</table>`,
      ),
    );
  }));

  r.post("/dream", h(async (_req, res, ctx) => {
    ctx.tm.dream(`requested by ${ctx.member.id} via viewer`, true).catch((e) => console.error("[dream]", e));
    res.redirect("/view/log");
  }));

  // ----- team & keys -----

  const teamPage = async (ctx: Ctx, notice = "") => {
    const team = ctx.tm.team;
    const isAdmin = ctx.member.role === "admin";
    const rows = activeMembers(team)
      .map(
        (m) =>
          `<tr><td><b>${esc(m.name)}</b><br><span class="stat">${esc(m.id)}</span></td><td>${m.role}</td><td><code>${esc(m.keyPrefix)}…</code></td><td class="stat">${m.createdAt.slice(0, 10)}</td><td>` +
          (m.id === ctx.member.id || isAdmin ? `<form method="post" action="/view/team/rotate" style="display:inline"><input type="hidden" name="id" value="${esc(m.id)}"><button>Rotate key</button></form> ` : "") +
          (isAdmin && m.id !== ctx.member.id
            ? `<form method="post" action="/view/team/role" style="display:inline"><input type="hidden" name="id" value="${esc(m.id)}"><input type="hidden" name="role" value="${m.role === "admin" ? "member" : "admin"}"><button>${m.role === "admin" ? "Make member" : "Make admin"}</button></form> ` +
              `<form method="post" action="/view/team/revoke" style="display:inline" onsubmit="return confirm('Revoke ${esc(m.id)}? Their key stops working immediately. Their personal memory is kept.')"><input type="hidden" name="id" value="${esc(m.id)}"><button>Revoke</button></form>`
            : "") +
          `</td></tr>`,
      )
      .join("");
    const add = isAdmin
      ? `<h3>Add a member</h3><form method="post" action="/view/team/add"><input name="id" placeholder="id (e.g. alice)" required pattern="[a-z0-9][a-z0-9-]*"> <input name="name" placeholder="Display name"> <select name="role"><option value="member">member</option><option value="admin">admin</option></select> <button>Create key</button></form>`
      : `<p class="stat">Ask a team admin to add members.</p>`;
    return page(ctx, "Team", `<h2>${esc(team.name)} <span class="stat">(${esc(team.id)})</span></h2>${notice}<table><tr><th>Member</th><th>Role</th><th>Key</th><th>Added</th><th></th></tr>${rows}</table>${add}`);
  };

  const keyNotice = (who: string, key: string) =>
    `<p>New API key for <b>${esc(who)}</b> — copy it now, it won't be shown again:</p><div class="key">${esc(key)}</div><br>`;

  r.get("/team", h(async (_req, res, ctx) => void res.send(await teamPage(ctx))));

  r.post("/team/add", h(async (req, res, ctx) => {
    if (ctx.member.role !== "admin") throw new Error("only team admins can add members");
    const out = await registry.addMember(ctx.tm.teamId, { id: String(req.body.id ?? "").trim(), name: req.body.name, role: req.body.role });
    res.send(await teamPage(ctx, keyNotice(out.member.name, out.key)));
  }));

  r.post("/team/rotate", h(async (req, res, ctx) => {
    const id = String(req.body.id ?? "");
    if (id !== ctx.member.id && ctx.member.role !== "admin") throw new Error("forbidden");
    const out = await registry.rotateKey(ctx.tm.teamId, id);
    if (id === ctx.member.id) res.clearCookie("maas_key");
    res.send(await teamPage(ctx, keyNotice(out.member.name, out.key) + (id === ctx.member.id ? `<p class="stat">Your old key no longer works; update your tools and log in again.</p>` : "")));
  }));

  r.post("/team/role", h(async (req, res, ctx) => {
    if (ctx.member.role !== "admin") throw new Error("forbidden");
    await registry.setRole(ctx.tm.teamId, String(req.body.id), req.body.role === "admin" ? "admin" : "member");
    res.redirect("/view/team");
  }));

  r.post("/team/revoke", h(async (req, res, ctx) => {
    if (ctx.member.role !== "admin") throw new Error("forbidden");
    await registry.revoke(ctx.tm.teamId, String(req.body.id));
    res.redirect("/view/team");
  }));

  return r;
}
