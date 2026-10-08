# maas — Memory as a Service, for teams

One long-term memory shared by a team's AI tools, behind a single MCP endpoint. Every member connects with their own API key.

The difference from a memory *database* (mem0 & co.): **you don't push records to a store, you talk to an agent.**
A memory agent runs on the server and owns the team's memory, which is a git repo of markdown in the
[Agent Memory Repo](https://github.com/AgentMemoryRepo/agentmemoryrepo) format (as in
[supermemoryai/memoryrepo](https://github.com/supermemoryai/memoryrepo)).

Members' tools send it observations. The agent then:
- decides what's worth keeping and where to file it;
- reconciles it with what the team already knows;
- decides, per fact, whether it's **team knowledge** or **personal to that member**.

Every change is a git commit. Periodically the agent **dreams**: it merges duplicates, resolves contradictions, prunes stale entries and records patterns across sessions.

```
alice: Claude Code ─┐                    ┌──────────── Cloud Run ─────────────────────────────┐
alice: Cursor ──────┤  MCP + alice's key │  auth → (team, member)                             │
bob:   Antigravity ─┼───────────────────►│  inbox journal (GCS) → team's memory agent         │
bob:   Codex ───────┘  MCP + bob's key   │     (Gemini on Vertex AI, single writer per team)  │
                                         │  team repo:  MEMORY.md, projects/, people/, …      │
                                         │              private/alice/   private/bob/        │
                                         │              sources/alice/   sources/bob/        │
                                         │  → git bundle in GCS (+ optional git remote)       │
                                         └────────────────────────────────────────────────────┘
```

## Teams, members, privacy

- **Team:** one memory repo. One deployment can host many teams.
- **Member:** has their own API key, shown once. Roles are `admin` (manages members and keys) or `member`. Keys are stored only as SHA-256 hashes.
- **Shared space:** everything outside `private/`. All members' agents read and write it. Facts carry `by: <member>` so you know who contributed what.
- **Personal space** (`private/<member>/`, with its own `MEMORY.md`): preferences, working style and personal context. Only that member's agents can see it.
- **Routing:** the agent decides team vs personal per fact. When unsure it chooses personal, because a personal fact can be shared later but a leak can't be undone. Clients can force a choice with `remember(..., scope: "team" | "personal")`.
- **Enforcement is in code, not just the prompt:**
  - Every agent run gets an access scope, and the repo tools refuse any path outside it.
  - Raw observations (`sources/<member>/`) are readable only by their author.
  - Personal and shared changes are committed separately, and each member's history shows only commits they're allowed to see.
  - Dreaming runs once over the shared space, which can't see any private space, and once per member whose personal space changed.
  - See [scripts/acl-test.ts](scripts/acl-test.ts).
- **Revoking a member:** their key stops working immediately. Their personal memory is kept; re-adding the same id restores it.

## MCP tools (per member)

| Tool | What it does |
|---|---|
| `memory_context` | Returns the team's `MEMORY.md` plus your personal `MEMORY.md`. Clients call it at session start. |
| `remember` | Sends an observation (`scope`: `auto` / `team` / `personal`). Returns immediately; set `wait: true` to get back what changed. |
| `recall` | Asks the agent a question. It searches team and personal memory and answers with the facts, who contributed them, and sources. |
| `forget` | Deletes or corrects something. |
| `memory_read` | Reads a file you can see, or lists them. |
| `memory_log` | Shows recent commits you can see, plus queue status. |
| `dream` | Runs consolidation now. |

The server also sends MCP `instructions` that tell client agents when to call each tool.

## Deploy to Google Cloud (≈5 min)

You need the [gcloud CLI](https://cloud.google.com/sdk/docs/install) and a project with billing enabled.

```powershell
gcloud auth login
./deploy/deploy.ps1 -ProjectId <project> -Team acme -TeamName "Acme Inc" -AdminId chris -AdminName "Chris"
```

The script is idempotent; re-run it to redeploy. It:
- enables the APIs it needs
- creates a versioned bucket `gs://<project>-maas`
- creates a service account that can only use Vertex AI and that bucket
- generates a server **admin token** in Secret Manager
- deploys Cloud Run, building in the cloud, so no local Docker is needed
- schedules a nightly dream
- creates your team, with you as its first admin, and prints **your member key** once

**Why Cloud Run and not Firebase Functions:** the agents work in the background after a request returns, with one writer per team repo.
Cloud Run with a single always-on instance fits that model. (Firebase Functions v2 run on Cloud Run anyway.)
Expected cost is roughly \$80–110/month for the always-on 2 vCPU instance, plus Gemini tokens.

**Options:** `-Region`, `-AgentModel` (default `gemini-3.5-flash`), `-DreamModel` (a stronger model is a good idea here), `-ModelLocation`, `-DreamSchedule`, `-TimeZone`.

## Onboard teammates

From the viewer: **Team & keys → Add a member**. The key is shown once; send it to your teammate.

Or from the CLI, using your member key (team admin) or the server admin token:
```powershell
$env:MAAS_URL="https://<service>.run.app"; $env:MAAS_TOKEN="<your key>"
npm run admin -- member:add acme alice "Alice"          # prints alice's key + connection info
npm run admin -- member:add acme bob "Bob" admin
npm run admin -- members acme
npm run admin -- member:rotate acme alice               # members can also rotate their own key
npm run admin -- member:revoke acme alice
npm run admin -- team:remote acme "https://<user>:<token>@github.com/acme/memory.git"   # mirror the repo to GitHub
# server admin token only:
npm run admin -- team:create design "Design Team" dana "Dana"
```

The same operations are available over HTTP. Authenticate with `Authorization: Bearer <key>`:
- `GET  /api/me` (any key)
- `GET  /api/teams`
- `POST /api/teams` (admin token only)
- `GET  /api/teams/:team`, `PATCH /api/teams/:team`
- `POST /api/teams/:team/members`
- `POST /api/teams/:team/members/:id/rotate`
- `PATCH /api/teams/:team/members/:id` (role)
- `DELETE /api/teams/:team/members/:id`
- `POST /api/teams/:team/dream`

## Connect your tools

Each member uses **their own key**. Replace `$URL` and `$KEY` below.

**Claude Code**
```sh
claude mcp add --transport http --scope user maas $URL/mcp --header "Authorization: Bearer $KEY"
```

**Cursor** (`~/.cursor/mcp.json`) / **Windsurf** / **VS Code** (`mcp.json`, key `servers`)
```json
{ "mcpServers": { "maas": { "url": "$URL/mcp", "headers": { "Authorization": "Bearer $KEY" } } } }
```

**Antigravity** (`~/.gemini/antigravity/mcp_config.json`) / **Gemini CLI** (`~/.gemini/settings.json`)
```json
{ "mcpServers": { "maas": { "serverUrl": "$URL/mcp", "headers": { "Authorization": "Bearer $KEY" } } } }
```
Gemini CLI uses `"httpUrl"` instead of `"serverUrl"`.

**Codex CLI** (`~/.codex/config.toml`)
```toml
[mcp_servers.maas]
url = "$URL/mcp"
http_headers = { Authorization = "Bearer $KEY" }
```

**Clients that can't set headers:** use `$URL/mcp/$KEY` as the URL.
Add `?client=<name>` to any URL to label which tool an observation came from.

**Make agents actually use it.** Most clients follow the server instructions. For stronger habits, add a line to your global agent rules (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, Cursor rules):
> At the start of each task call `maas.memory_context`. Use `maas.recall` before asking me about preferences, team conventions or past decisions. When you learn something durable, call `maas.remember`.

## Watch it work

Open `$URL/view?key=$KEY`. You see what your key is allowed to see:
- the team's `MEMORY.md`, with team files and your personal files (shown in purple)
- backlinks
- commit history with diffs
- the inbox
- your own raw sources
- a **Dream now** button
- **Team & keys**

## Run locally

```powershell
npm install
$env:GEMINI_API_KEY="<AI Studio key>"     # or: gcloud auth application-default login + GOOGLE_CLOUD_PROJECT
$env:MAAS_ADMIN_TOKEN="admintoken"
npm run dev
$env:MAAS_URL="http://localhost:8080"; $env:MAAS_TOKEN="admintoken"
npm run admin -- team:create acme "Acme" chris "Chris"; npm run admin -- member:add acme bob "Bob"
$env:MAAS_URL="http://localhost:8080/mcp"; $env:MAAS_TOKEN="<chris key>"; $env:MAAS_TOKEN_B="<bob key>"
npm run smoke -- --full                   # team vs personal routing + cross-member privacy
npx tsx scripts/acl-test.ts               # offline privacy-model tests
```

Locally, each team's repo lives in `.data/teams/<team>/memory`. It's a normal git repo you can inspect with `git log -p`.

## Configuration

| Env var | Default | |
|---|---|---|
| `MAAS_ADMIN_TOKEN` | — | Server admin token: create teams and manage any team. It can't act as a member on `/mcp`. |
| `MAAS_GCS_BUCKET` / `MAAS_GCS_PREFIX` | — / `maas` | Durable storage: registry, inbox journals, repo bundles. |
| `MAAS_DATA_DIR` | `.data` | Local working copies of the team repos. |
| `GOOGLE_GENAI_USE_VERTEXAI` | `true` unless `GEMINI_API_KEY` is set | Use Vertex AI with the service account. |
| `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` | — / `global` | Vertex AI project and location. |
| `MAAS_AGENT_MODEL` / `MAAS_DREAM_MODEL` | `gemini-3.5-flash` | Models for ingest/recall and for dreaming. |
| `MAAS_DREAM_EVERY` | `25` | Auto-dream after N observations per team (`0` = off). |
| `MAAS_MAX_AGENT_STEPS` | `24` | Tool-call budget per agent run. |
| `MAAS_DEBUG` | — | Log every agent tool call. |

## Layout

```
src/index.ts         HTTP: auth (member keys / admin token), /mcp, /api, /dream, /view
src/teams.ts         team registry: members, roles, hashed keys
src/access.ts        shared / private / sources zones and per-run access scopes
src/mcp.ts           MCP tools + instructions, bound to the calling member
src/agent/agent.ts   per-team memory agent (inbox, single-writer queue, ingest, recall, dream) + hub
src/agent/prompts.ts curation rules, team-vs-personal routing, memory format
src/agent/tools.ts   the agent's scoped tools over the repo
src/repo.ts          git repo: scoped read/search, split commits, GCS bundle + remote persistence
src/llm.ts           Gemini tool-calling loop
src/web.ts           member-scoped viewer + team & key management
scripts/admin.ts     admin CLI · scripts/smoke.ts MCP smoke test · scripts/acl-test.ts privacy tests
deploy/deploy.ps1    one-shot GCP deploy + team bootstrap
```
