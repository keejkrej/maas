import type { Request, Response, Router } from "express";
import express from "express";
import { agent } from "./agent/agent.js";
import { config } from "./config.js";
import { repo } from "./repo.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Very small markdown renderer: headings, bullets, [[wiki links]], metadata dimmed. */
function renderMd(md: string): string {
  const out: string[] = [];
  let inList = false;
  const inline = (s: string) =>
    esc(s)
      .replace(/\[\[([^\]]+)\]\]/g, (_, p) => `<a href="/view/file?path=${encodeURIComponent(p)}">[[${p}]]</a>`)
      .replace(/\[(source|added|updated|until):([^\]]*)\]/g, (m) => `<span class="meta">${m}</span>`)
      .replace(/obs\/([a-z0-9]{6})/g, (m, id) => `<a class="meta" href="/view/source?id=${id}">${m}</a>`)
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

async function page(title: string, body: string) {
  const files = await repo.listFiles();
  const meta = await agent.meta();
  const pending = agent.pendingObservations().length;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} · maas</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;--fg:#1d1d1f;--mut:#6e6e73;--bd:#d2d2d7;--bg:#fff;--acc:#0b5cff}
@media(prefers-color-scheme:dark){:root{--fg:#e8e8ed;--mut:#98989d;--bd:#3a3a3c;--bg:#151516;--acc:#6ea0ff}}
body{margin:0;font:14px/1.55 ui-sans-serif,system-ui,sans-serif;color:var(--fg);background:var(--bg);display:grid;grid-template-columns:260px 1fr;min-height:100vh}
nav{border-right:1px solid var(--bd);padding:16px;overflow:auto;font-size:13px}
nav a{display:block;color:var(--fg);text-decoration:none;padding:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
nav a:hover{color:var(--acc)} nav h3{font-size:11px;text-transform:uppercase;color:var(--mut);margin:18px 0 6px}
main{padding:24px 40px;max-width:900px} a{color:var(--acc)} .meta{color:var(--mut);font-size:12px;text-decoration:none}
pre{background:rgba(127,127,127,.1);padding:12px;border-radius:8px;overflow:auto;font-size:12px}
.stat{color:var(--mut);font-size:12px} li{margin:3px 0} code{font-size:12px;background:rgba(127,127,127,.12);padding:1px 4px;border-radius:4px}
table{border-collapse:collapse;width:100%} td{border-bottom:1px solid var(--bd);padding:6px 8px;vertical-align:top;font-size:13px}
.d-add{color:#1a7f37}.d-del{color:#cf222e}
button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid var(--bd);background:transparent;color:var(--fg);cursor:pointer}
</style></head><body>
<nav><a href="/view"><b>🧠 maas · ${esc(config.ownerName)}</b></a>
<div class="stat">${meta.totalObservations} observations · ${meta.totalDreams} dreams<br>agent: ${esc(agent.status.busy ?? "idle")}${pending ? ` · ${pending} pending` : ""}</div>
<h3>Views</h3><a href="/view">MEMORY.md</a><a href="/view/log">History</a><a href="/view/inbox">Inbox</a>
<h3>Files (${files.length})</h3>${files.map((f) => `<a href="/view/file?path=${encodeURIComponent(f)}">${esc(f)}</a>`).join("")}
</nav><main>${body}</main></body></html>`;
}

export function viewerRouter(): Router {
  const r = express.Router();

  r.get("/", async (_req, res) => {
    const md = (await repo.readFile("MEMORY.md")) ?? "";
    res.send(await page("MEMORY.md", `<div class="stat">MEMORY.md</div>${renderMd(md)}`));
  });

  r.get("/file", async (req: Request, res: Response) => {
    const p = String(req.query.path ?? "");
    let c: string | null = null;
    try {
      c = await repo.readFile(p);
    } catch {}
    const backlinks = c === null ? [] : await repo.search(`\\[\\[${p.replace(/\.md$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.md)?\\]\\]`);
    const bl = [...new Set(backlinks.map((b) => b.path))].filter((x) => x !== p);
    res.send(
      await page(
        p,
        c === null
          ? `<p>Not found: ${esc(p)}</p>`
          : `<div class="stat">${esc(p)}</div>${renderMd(c)}` +
              (bl.length ? `<h3>Backlinks</h3><ul>${bl.map((b) => `<li><a href="/view/file?path=${encodeURIComponent(b)}">${esc(b)}</a></li>`).join("")}</ul>` : "") +
              `<details><summary class="stat">raw</summary><pre>${esc(c)}</pre></details>`,
      ),
    );
  });

  r.get("/source", async (req, res) => {
    const id = String(req.query.id ?? "").replace(/[^a-z0-9]/gi, "");
    const files = await repo.listFiles({ under: "sources", includeSources: true }).catch(() => [] as string[]);
    const f = files.find((x) => x.endsWith(`/${id}.md`));
    const c = f ? await repo.readFile(f) : null;
    res.send(await page(`obs/${id}`, c ? `<div class="stat">${esc(f!)}</div><pre>${esc(c)}</pre>` : `<p>No source obs/${esc(id)}</p>`));
  });

  r.get("/log", async (_req, res) => {
    const log = await repo.log(100);
    const rows = log
      .map(
        (c) =>
          `<tr><td><a href="/view/commit?sha=${c.sha}"><code>${c.sha}</code></a><br><span class="stat">${esc(c.date.slice(0, 16).replace("T", " "))}</span></td>` +
          `<td>${esc(c.message.split("\n")[0])}<br><span class="stat">${esc(c.files.filter((f) => !f.startsWith(".maas/")).join(", "))}</span></td></tr>`,
      )
      .join("");
    res.send(
      await page(
        "History",
        `<h2>History</h2><form method="post" action="/view/dream"><button>🌙 Dream now</button></form><br><table>${rows}</table>`,
      ),
    );
  });

  r.get("/commit", async (req, res) => {
    let diff = "";
    try {
      diff = await repo.show(String(req.query.sha ?? ""));
    } catch (e) {
      diff = (e as Error).message;
    }
    const html = esc(diff)
      .split("\n")
      .map((l) => (l.startsWith("+") && !l.startsWith("+++") ? `<span class="d-add">${l}</span>` : l.startsWith("-") && !l.startsWith("---") ? `<span class="d-del">${l}</span>` : l))
      .join("\n");
    res.send(await page(`commit ${req.query.sha}`, `<pre>${html}</pre>`));
  });

  r.get("/inbox", async (_req, res) => {
    const pending = agent.pendingObservations();
    const recent = agent.recentResults();
    res.send(
      await page(
        "Inbox",
        `<h2>Pending (${pending.length})</h2>` +
          (pending.length ? `<table>${pending.map((o) => `<tr><td><code>obs/${o.id}</code><br><span class="stat">${esc(o.client ?? "")}</span></td><td>${esc(o.content)}</td></tr>`).join("")}</table>` : `<p class="stat">Nothing waiting.</p>`) +
          (agent.status.lastError ? `<p class="d-del">Last error: ${esc(agent.status.lastError)}</p>` : "") +
          `<h2>Recent agent runs (since boot)</h2><table>${recent.map((r) => `<tr><td><code>${r.commit?.sha ?? "—"}</code></td><td>${esc(r.message)}<br><span class="stat">${r.observationIds.map((i) => "obs/" + i).join(", ")}</span></td></tr>`).join("")}</table>`,
      ),
    );
  });

  r.post("/dream", async (_req, res) => {
    agent.dream("viewer").catch((e) => console.error("[dream]", e));
    res.redirect("/view/log");
  });

  return r;
}
