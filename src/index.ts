import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hub } from "./agent/agent.js";
import { config } from "./config.js";
import { buildMcpServer } from "./mcp.js";
import { HttpError, publicMember, publicTeam, registry, type Member, type Team } from "./teams.js";
import { viewerRouter } from "./web.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));

// ---------- auth ----------

export type Auth = { kind: "admin" } | { kind: "member"; team: Team; member: Member };
declare module "express-serve-static-core" {
  interface Request {
    maas?: Auth;
  }
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function tokenFrom(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  if (typeof req.headers["x-api-key"] === "string") return req.headers["x-api-key"];
  if (typeof req.params?.key === "string") return req.params.key;
  if (typeof req.query.key === "string") return req.query.key;
  const cookie = req.headers.cookie?.match(/(?:^|;\s*)maas_key=([^;]+)/);
  return cookie ? decodeURIComponent(cookie[1]) : undefined;
}

export function resolveAuth(token: string | undefined): Auth | null {
  if (!token) return null;
  if (config.adminToken && safeEqual(token, config.adminToken)) return { kind: "admin" };
  const id = registry.authenticate(token);
  return id ? { kind: "member", team: id.team, member: id.member } : null;
}

function authenticate(req: Request, res: Response, next: NextFunction) {
  const auth = resolveAuth(tokenFrom(req));
  if (!auth) return void res.status(401).json({ error: "unauthorized: send your member API key as 'Authorization: Bearer <key>'" });
  req.maas = auth;
  next();
}

function requireMember(req: Request, res: Response, next: NextFunction) {
  if (req.maas?.kind !== "member")
    return void res.status(403).json({ error: "this endpoint needs a member API key (the admin token can't act as a member)" });
  next();
}

const isServerAdmin = (req: Request) => req.maas?.kind === "admin";
const isTeamAdmin = (req: Request, teamId: string) =>
  isServerAdmin(req) || (req.maas?.kind === "member" && req.maas.team.id === teamId && req.maas.member.role === "admin");
const isTeamMember = (req: Request, teamId: string) => isServerAdmin(req) || (req.maas?.kind === "member" && req.maas.team.id === teamId);

function guard(ok: boolean) {
  if (!ok) throw new HttpError(403, "forbidden");
}

const api =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response) =>
    fn(req, res)
      .then((body) => {
        if (!res.headersSent) res.json(body);
      })
      .catch((e) => {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) console.error("[api]", e);
        res.status(status).json({ error: e.message });
      });

// ---------- MCP (stateless Streamable HTTP), one identity per member key ----------

async function handleMcp(req: Request, res: Response) {
  const auth = req.maas as Extract<Auth, { kind: "member" }>;
  const client =
    (req.headers["x-maas-client"] as string) ||
    (typeof req.query.client === "string" ? req.query.client : "") ||
    (req.headers["user-agent"] ?? "unknown").split(" ")[0];
  try {
    const tm = await hub.get(auth.team.id);
    const server = buildMcpServer({ tm, member: auth.member, client });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[mcp] error", e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
}

const methodNotAllowed = (_req: Request, res: Response) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });

app.post("/mcp", authenticate, requireMember, handleMcp);
app.post("/mcp/:key", authenticate, requireMember, handleMcp); // for clients that can't set headers
app.get(["/mcp", "/mcp/:key"], methodNotAllowed);
app.delete(["/mcp", "/mcp/:key"], methodNotAllowed);

// ---------- team admin API ----------

app.get("/api/me", authenticate, api(async (req) => {
  const a = req.maas!;
  return a.kind === "admin" ? { admin: true } : { team: { id: a.team.id, name: a.team.name }, member: publicMember(a.member) };
}));

app.get("/api/teams", authenticate, api(async (req) => {
  if (isServerAdmin(req)) return registry.list().map(publicTeam);
  const a = req.maas as Extract<Auth, { kind: "member" }>;
  return [publicTeam(a.team)];
}));

app.post("/api/teams", authenticate, api(async (req, res) => {
  guard(isServerAdmin(req));
  const { id, name, gitRemote, admin } = req.body ?? {};
  if (!id || !admin?.id) throw new HttpError(400, "body must include id and admin: { id, name }");
  const out = await registry.createTeam({ id, name, gitRemote, admin });
  await hub.get(out.team.id); // initialise the repo
  res.status(201);
  return { team: publicTeam(out.team), member: publicMember(out.member), key: out.key };
}));

app.get("/api/teams/:team", authenticate, api(async (req) => {
  guard(isTeamMember(req, req.params.team as string));
  return publicTeam(registry.get(req.params.team as string));
}));

app.patch("/api/teams/:team", authenticate, api(async (req) => {
  const teamId = req.params.team as string;
  guard(isTeamAdmin(req, teamId));
  const team = await registry.updateTeam(teamId, { name: req.body?.name, gitRemote: req.body?.gitRemote });
  if (req.body?.gitRemote !== undefined) {
    const tm = await hub.get(teamId);
    await tm.repo.syncRemote();
    await tm.repo.persist();
  }
  return publicTeam(team);
}));

app.post("/api/teams/:team/members", authenticate, api(async (req, res) => {
  const teamId = req.params.team as string;
  guard(isTeamAdmin(req, teamId));
  const { id, name, role } = req.body ?? {};
  if (!id) throw new HttpError(400, "body must include id (and optionally name, role)");
  const out = await registry.addMember(teamId, { id, name, role });
  res.status(201);
  return { member: publicMember(out.member), key: out.key };
}));

app.post("/api/teams/:team/members/:member/rotate", authenticate, api(async (req) => {
  const teamId = req.params.team as string;
  const memberId = req.params.member as string;
  const self = req.maas?.kind === "member" && req.maas.team.id === teamId && req.maas.member.id === memberId;
  guard(self || isTeamAdmin(req, teamId));
  const out = await registry.rotateKey(teamId, memberId);
  return { member: publicMember(out.member), key: out.key };
}));

app.patch("/api/teams/:team/members/:member", authenticate, api(async (req) => {
  const teamId = req.params.team as string;
  guard(isTeamAdmin(req, teamId));
  const role = req.body?.role;
  if (role !== "admin" && role !== "member") throw new HttpError(400, "role must be 'admin' or 'member'");
  return publicMember(await registry.setRole(teamId, req.params.member as string, role));
}));

app.delete("/api/teams/:team/members/:member", authenticate, api(async (req) => {
  const teamId = req.params.team as string;
  guard(isTeamAdmin(req, teamId));
  return publicMember(await registry.revoke(teamId, req.params.member as string));
}));

app.post("/api/teams/:team/dream", authenticate, api(async (req) => {
  const teamId = req.params.team as string;
  guard(isTeamAdmin(req, teamId));
  (await hub.get(teamId)).dream("requested via API", true).catch((e) => console.error("[dream]", e));
  return { started: true };
}));

// ---------- ops ----------

app.get("/healthz", api(async () => ({ ok: true, teams: registry.list().length })));

/** Cloud Scheduler hits this nightly (admin token) to dream every team. */
app.post("/dream", authenticate, api(async (req) => {
  guard(isServerAdmin(req));
  hub.dreamAll("scheduled").catch((e) => console.error("[dream]", e));
  return { started: true, teams: registry.list().length };
}));

// ---------- viewer (member key, stored in a cookie) ----------

app.get("/", (_req, res) => res.redirect("/view"));
app.use(
  "/view",
  (req, res, next) => {
    if (typeof req.query.key === "string" && resolveAuth(req.query.key)?.kind === "member") {
      res.cookie("maas_key", req.query.key, { httpOnly: true, secure: req.secure, sameSite: "lax", maxAge: 90 * 864e5 });
      return res.redirect(req.baseUrl + req.path);
    }
    const auth = resolveAuth(tokenFrom(req));
    if (auth?.kind !== "member") {
      return res.status(401).send(`<form style="font:16px system-ui;margin:20vh auto;width:340px" method="get">
        <p>🧠 maas — enter your member API key</p><input name="key" type="password" style="width:100%;padding:8px" autofocus></form>`);
    }
    req.maas = auth;
    next();
  },
  viewerRouter(),
);
app.get("/logout", (_req, res) => {
  res.clearCookie("maas_key");
  res.redirect("/view");
});

// ---------- boot ----------

async function main() {
  if (!config.adminToken) console.warn("[maas] MAAS_ADMIN_TOKEN is not set — team creation via the API is disabled");
  await hub.start();
  app.listen(config.port, () => {
    console.log(`[maas] listening on :${config.port}  (MCP: /mcp, API: /api, viewer: /view)  model=${config.llm.agentModel} vertex=${config.llm.useVertex}`);
  });
}

main().catch((e) => {
  console.error("[maas] fatal", e);
  process.exit(1);
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`[maas] ${sig} received, exiting`);
    // Pending observations are journaled in the blob store and recovered on next boot.
    process.exit(0);
  });
}
