import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { agent } from "./agent/agent.js";
import { config } from "./config.js";
import { buildMcpServer } from "./mcp.js";
import { viewerRouter } from "./web.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));

// ---------- auth ----------

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

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!config.authToken) return next(); // local dev without a token
  const t = tokenFrom(req);
  if (t && safeEqual(t, config.authToken)) return next();
  res.status(401).json({ error: "unauthorized" });
}

// ---------- MCP (stateless Streamable HTTP) ----------

async function handleMcp(req: Request, res: Response) {
  const client =
    (req.headers["x-maas-client"] as string) ||
    (typeof req.query.client === "string" ? req.query.client : "") ||
    (req.headers["user-agent"] ?? "unknown").split(" ")[0];
  const server = buildMcpServer(client);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[mcp] error", e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
}

const methodNotAllowed = (_req: Request, res: Response) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });

app.post("/mcp", requireAuth, handleMcp);
app.post("/mcp/:key", requireAuth, handleMcp); // for clients that can't set headers: https://host/mcp/<token>
app.get(["/mcp", "/mcp/:key"], methodNotAllowed);
app.delete(["/mcp", "/mcp/:key"], methodNotAllowed);

// ---------- ops ----------

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, busy: agent.status.busy, pending: agent.pendingObservations().length, lastError: agent.status.lastError });
});

/** Cloud Scheduler hits this to dream on a schedule. */
app.post("/dream", requireAuth, async (_req, res) => {
  agent.dream("scheduled").catch((e) => console.error("[dream]", e));
  res.json({ ok: true, started: true });
});

// ---------- viewer ----------

app.get("/", (_req, res) => res.redirect("/view"));
app.use(
  "/view",
  (req, res, next) => {
    // Visiting /view?key=<token> once stores the token in a cookie.
    if (typeof req.query.key === "string" && config.authToken && safeEqual(req.query.key, config.authToken)) {
      res.cookie("maas_key", req.query.key, { httpOnly: true, secure: req.secure, sameSite: "lax", maxAge: 90 * 864e5 });
      return res.redirect(req.baseUrl + req.path);
    }
    if (config.authToken && !tokenFrom(req)) {
      return res.status(401).send(`<form style="font:16px system-ui;margin:20vh auto;width:320px" method="get">
        <p>🧠 maas — enter your access token</p><input name="key" type="password" style="width:100%;padding:8px" autofocus></form>`);
    }
    next();
  },
  requireAuth,
  viewerRouter(),
);

// ---------- boot ----------

async function main() {
  if (!config.authToken) console.warn("[maas] MAAS_TOKEN is not set — the server is UNAUTHENTICATED (ok for local dev only)");
  await agent.start();
  app.listen(config.port, () => {
    console.log(`[maas] listening on :${config.port}  (MCP: /mcp, viewer: /view)  model=${config.llm.agentModel} vertex=${config.llm.useVertex}`);
  });
}

main().catch((e) => {
  console.error("[maas] fatal", e);
  process.exit(1);
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`[maas] ${sig} received, exiting`);
    // Pending observations are journaled in the blob store and will be recovered on next boot.
    process.exit(0);
  });
}
