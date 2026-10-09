import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { memberAccess } from "./access.js";
import * as agent from "./agent/agent.js";
import { config } from "./config.js";
import { buildMcpServer } from "./mcp.js";
import { HttpError, publicMember, publicTeam, registry, type Member, type Team } from "./teams.js";
import { viewerRouter } from "./web.js";

export const app = express();
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

export async function resolveAuth(token: string | undefined): Promise<Auth | null> {
  if (!token) return null;
  const admin = config.adminToken;
  if (admin && safeEqual(token, admin)) return { kind: "admin" };
  const id = await registry.authenticate(token);
  return id ? { kind: "member", team: id.team, member: id.member } : null;
}

function authenticate(req: Request, res: Response, next: NextFunction) {
  resolveAuth(tokenFrom(req))
    .then((auth) => {
      if (!auth) return void res.status(401).json({ error: "unauthorized: send your member API key as 'Authorization: Bearer <key>'" });
      req.maas = auth;
      next();
    })
    .catch(next);
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
    const server = buildMcpServer({ team: auth.team, member: auth.member, client });
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
  if (isServerAdmin(req)) return (await registry.list()).map(publicTeam);
  const a = req.maas as Extract<Auth, { kind: "member" }>;
  return [publicTeam(a.team)];
}));

app.post("/api/teams", authenticate, api(async (req, res) => {
  guard(isServerAdmin(req));
  const { id, name, admin } = req.body ?? {};
  if (!id || !admin?.id) throw new HttpError(400, "body must include id and admin: { id, name }");
  const out = await registry.createTeam({ id, name, admin });
  await agent.initTeamMemory(out.team);
  res.status(201);
  return { team: publicTeam(out.team), member: publicMember(out.member), key: out.key };
}));

app.get("/api/teams/:team", authenticate, api(async (req) => {
  guard(isTeamMember(req, req.params.team as string));
  return publicTeam(await registry.get(req.params.team as string));
}));

app.patch("/api/teams/:team", authenticate, api(async (req) => {
  const teamId = req.params.team as string;
  guard(isTeamAdmin(req, teamId));
  return publicTeam(await registry.updateTeam(teamId, { name: req.body?.name }));
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
  await registry.get(teamId);
  const item = await agent.requestDream(teamId, "requested via API", true);
  return { queued: item.id };
}));

/**
 * Markdown export. Members get the shared space + their own personal space;
 * the server admin token gets the shared space only (personal memory stays with its owner).
 */
app.get("/api/teams/:team/files", authenticate, api(async (req) => {
  const teamId = req.params.team as string;
  guard(isTeamMember(req, teamId));
  await registry.get(teamId);
  const store = await agent.readStore(teamId);
  const access = req.maas?.kind === "member" ? memberAccess(req.maas.member.id) : null;
  const paths = (await store.listFiles(access ? { access } : {})).filter((p) => (access ? true : !p.startsWith("private/")));
  const files: Record<string, string> = {};
  for (const p of paths) files[p] = (await store.readFile(p)) ?? "";
  return { team: teamId, head: await store.head(), files };
}));

// ---------- ops ----------

app.get("/healthz", api(async () => ({ ok: true, store: config.useFirestore ? "firestore" : "local", model: config.llm.agentModel })));

/** Admin: queue a dream for every team (the nightly schedule does this on Firebase). */
app.post("/dream", authenticate, api(async (req) => {
  guard(isServerAdmin(req));
  await agent.dreamAll("requested via API");
  return { queued: true, teams: (await registry.list()).length };
}));

// ---------- viewer (member key, stored in a cookie) ----------

app.get("/", (_req, res) => res.redirect("view"));
app.use(
  "/view",
  (req, res, next) => {
    (async () => {
      if (typeof req.query.key === "string" && (await resolveAuth(req.query.key))?.kind === "member") {
        res.cookie("maas_key", req.query.key, { httpOnly: true, secure: req.secure, sameSite: "lax", maxAge: 90 * 864e5 });
        const rest = new URLSearchParams(req.query as Record<string, string>);
        rest.delete("key");
        const qs = rest.toString();
        return res.redirect((req.path === "/" ? "./" : req.path.slice(1)) + (qs ? `?${qs}` : ""));
      }
      const auth = await resolveAuth(tokenFrom(req));
      if (auth?.kind !== "member") {
        return res.status(401).send(`<form style="font:16px system-ui;margin:20vh auto;width:340px" method="get">
        <p>🧠 maas — enter your member API key</p><input name="key" type="password" style="width:100%;padding:8px" autofocus></form>`);
      }
      req.maas = auth;
      next();
    })().catch(next);
  },
  viewerRouter(),
);
app.get("/logout", (_req, res) => {
  res.clearCookie("maas_key");
  res.redirect("view");
});
