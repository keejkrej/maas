# maas — Memory as a Service

One long-term memory for all your AI tools, behind a single MCP endpoint.

The difference from a memory *database* (mem0 & co.): **you don't push records to a store, you talk to an agent.**
A memory agent runs on the server and owns your memory: a git repo of markdown in the
[Agent Memory Repo](https://github.com/AgentMemoryRepo/agentmemoryrepo) format (as in
[supermemoryai/memoryrepo](https://github.com/supermemoryai/memoryrepo)). Clients send it observations. The agent
decides what's worth keeping, where to file it, and how to reconcile it with what it already knows. Every change is a git commit.
Periodically it **dreams**: it merges duplicates, resolves contradictions, prunes stale entries and records patterns across sessions.

```
Claude Code ─┐                       ┌──────────── Cloud Run (1 instance) ─────────────┐
Cursor ──────┤   MCP (HTTP)          │  MCP tools ──► inbox journal (GCS)              │
Antigravity ─┼──────────────────────►│                    │                            │
Codex/Gemini ┘   remember / recall   │                    ▼                            │
                                     │   Memory agent (Gemini on Vertex AI)            │
                                     │     search · read · edit · commit               │
                                     │                    │                            │
                                     │   git repo of markdown ──► bundle in GCS        │
                                     │   (MEMORY.md, people/, projects/, sources/ …)   │
                                     └─────────────────────────────────────────────────┘
                       Cloud Scheduler ── nightly POST /dream
```

## MCP tools

| Tool | What it does |
|---|---|
| `memory_context` | Returns `MEMORY.md`, the short core memory. Clients call it at the start of a session. |
| `remember` | Sends an observation to the agent (it returns immediately; set `wait: true` to get back what changed). |
| `recall` | Asks the agent a question. It greps, follows `[[links]]`, and answers with the facts and their sources. |
| `forget` | Asks the agent to delete or correct something. |
| `memory_read` | Reads a memory file directly, or lists all files. |
| `memory_log` | Shows recent commits (what the agent did) and the queue status. |
| `dream` | Runs consolidation now. |

The server also sends MCP `instructions` that tell client agents when to call each tool.

## How a memory gets written

1. A client calls `remember("User prefers bun over pnpm for new projects…")`.
2. The observation is journaled in GCS, so a crash can't lose it, and the call returns.
3. The agent picks up the batch (bursts are debounced) and archives the raw text to `sources/<date>/<id>.md`.
   It searches the repo, finds `preferences/tooling.md`, **edits** the old pnpm line instead of appending a duplicate, and cites `[source: obs/<id>; added: …]`.
4. It commits (`prefer bun over pnpm for new JS projects`) and snapshots the repo to GCS. If you configured a git remote, it pushes there too.
5. After 25 observations (`MAAS_DREAM_EVERY`), and every night, it dreams.

## Deploy to Google Cloud (≈5 min)

You need the [gcloud CLI](https://cloud.google.com/sdk/docs/install) and a project with billing enabled.

```powershell
gcloud auth login
./deploy/deploy.ps1 -ProjectId <your-project-id> -Owner "<your name>"
```

The script is idempotent; re-run it to redeploy. It:
- enables the APIs it needs
- creates a versioned bucket `gs://<project>-maas`
- creates a service account that can only use Vertex AI and that bucket
- generates a random access token in Secret Manager
- deploys Cloud Run, building in the cloud, so no local Docker is needed
- schedules a nightly dream

At the end it prints your MCP URL, the token, and a viewer link.

**Why Cloud Run and not Firebase Functions:** the agent works in the background after a request returns and keeps one writer on the repo.
Cloud Run with `min=max=1` instance and always-on CPU fits that model. (Firebase Functions v2 run on Cloud Run anyway.)
Expected cost is roughly \$40–60/month for the always-on instance plus Gemini tokens.

**Options:** `-Region`, `-AgentModel` (default `gemini-3.5-flash`), `-DreamModel` (a stronger model is a good idea here), `-ModelLocation`
(default `global`), `-DreamSchedule`, `-GitRemote "https://<user>:<github-token>@github.com/<you>/my-memory.git"`.
With `-GitRemote` the agent also pushes every commit to a private repo, so you can browse your memory on GitHub or open it in Obsidian.

## Connect your tools

Replace `$URL` and `$TOKEN` with the values the deploy script printed.

**Claude Code**
```sh
claude mcp add --transport http --scope user maas $URL/mcp --header "Authorization: Bearer $TOKEN"
```

**Cursor** (`~/.cursor/mcp.json`) / **Windsurf** / **VS Code** (`mcp.json`, key `servers`)
```json
{ "mcpServers": { "maas": { "url": "$URL/mcp", "headers": { "Authorization": "Bearer $TOKEN" } } } }
```

**Antigravity** (`~/.gemini/antigravity/mcp_config.json`) / **Gemini CLI** (`~/.gemini/settings.json`)
```json
{ "mcpServers": { "maas": { "serverUrl": "$URL/mcp", "headers": { "Authorization": "Bearer $TOKEN" } } } }
```
Gemini CLI uses `"httpUrl"` instead of `"serverUrl"`.

**Codex CLI** (`~/.codex/config.toml`)
```toml
[mcp_servers.maas]
url = "$URL/mcp"
http_headers = { Authorization = "Bearer $TOKEN" }
```

**Clients that can't set headers:** use `$URL/mcp/$TOKEN` as the URL.
Add `?client=<name>` to any URL to label which tool an observation came from.

**Make agents actually use it.** Most clients follow the server instructions. For stronger habits, add a line to your global agent rules (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, Cursor rules):
> At the start of each task call `maas.memory_context`. Use `maas.recall` before asking me about preferences or past context. When you learn something durable about me, my projects or my preferences, call `maas.remember`.

## Watch it work

Open `$URL/view?key=$TOKEN` to see:
- the rendered `MEMORY.md`
- the file tree with backlinks
- every commit with its diff
- the inbox of pending observations
- the raw source behind every `obs/<id>` citation
- a **Dream now** button

## Run locally

```powershell
npm install
$env:GEMINI_API_KEY="<AI Studio key>"   # or: gcloud auth application-default login + GOOGLE_CLOUD_PROJECT
$env:MAAS_OWNER="Chris"; $env:MAAS_TOKEN="devtoken"
npm run dev                             # http://localhost:8080/view?key=devtoken
$env:MAAS_URL="http://localhost:8080/mcp"; npm run smoke -- --full
```

Locally, the repo lives in `.data/memory`. It's a normal git repo you can inspect with `git log -p`.

## Configuration

| Env var | Default | |
|---|---|---|
| `MAAS_TOKEN` | — | Access token. Required in production. |
| `MAAS_OWNER` | `Owner` | Whose memory this is. |
| `MAAS_GCS_BUCKET` / `MAAS_GCS_PREFIX` | — / `maas` | Durable storage for the repo bundle and the inbox. |
| `MAAS_GIT_REMOTE` | — | Optional git remote to push every commit to. |
| `GOOGLE_GENAI_USE_VERTEXAI` | `true` unless `GEMINI_API_KEY` is set | Use Vertex AI with the service account. |
| `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` | — / `global` | Vertex AI project and location. |
| `MAAS_AGENT_MODEL` / `MAAS_DREAM_MODEL` | `gemini-3.5-flash` | Models for ingest/recall and for dreaming. |
| `MAAS_DREAM_EVERY` | `25` | Auto-dream after N observations (`0` = off). |
| `MAAS_MAX_AGENT_STEPS` | `24` | Tool-call budget per agent run. |
| `MAAS_DEBUG` | — | Log every agent tool call. |

## Layout

```
src/index.ts         HTTP server: /mcp, /dream, /healthz, /view
src/mcp.ts           MCP tools + instructions
src/agent/agent.ts   memory agent: inbox journal, single-writer queue, ingest, recall, dream
src/agent/prompts.ts curation rules & memory format
src/agent/tools.ts   the agent's tools over the repo
src/repo.ts          git repo: read/search/write/commit, GCS bundle + remote persistence
src/llm.ts           Gemini tool-calling loop
src/web.ts           read-only viewer
deploy/deploy.ps1    one-shot GCP deploy
```
