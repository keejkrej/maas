# maas — Memory as a Service, for teams

One long-term memory shared by a team's AI tools, behind a single MCP endpoint. Every member connects with their own API key.

The difference from a memory *database* (mem0 & co.): **you don't push records to a store, you talk to an agent.**
A memory agent runs on the server and owns the team's memory: a folder of markdown in the
[Agent Memory Repo](https://github.com/AgentMemoryRepo/agentmemoryrepo) format (as in
[supermemoryai/memoryrepo](https://github.com/supermemoryai/memoryrepo)), with a full commit history.

Members' tools send it observations. The agent then:
- decides what's worth keeping and where to file it;
- reconciles it with what the team already knows;
- decides, per fact, whether it's **team knowledge** or **personal to that member**.

Every change is a commit with a diff. Periodically the agent **dreams**: it merges duplicates, resolves contradictions, prunes stale entries and records patterns across sessions.

```
alice: Claude Code ─┐                    ┌──────────── Firebase (scales to zero) ─────────────────┐
alice: Cursor ──────┤  MCP + alice's key │  api (HTTPS fn): auth → (team, member) → MCP tools     │
bob:   Antigravity ─┼───────────────────►│      remember → Firestore inbox ──trigger──► ingest fn │
bob:   Codex ───────┘  MCP + bob's key   │  memory agent (Ollama Cloud), one writer per team      │
                                         │  Firestore: MEMORY.md, projects/, people/, …           │
                                         │             private/alice/  private/bob/   commits/    │
                                         │  sweep (10 min) · nightlyDream (04:00)                 │
                                         └────────────────────────────────────────────────────────┘
```

## Teams, members, privacy

- **Team:** one memory. One deployment can host many teams.
- **Member:** has their own API key, shown once. Roles are `admin` (manages members and keys) or `member`. Keys are stored only as SHA-256 hashes.
- **Shared space:** everything outside `private/`. All members' agents read and write it. Facts carry `by: <member>` so you know who contributed what.
- **Personal space** (`private/<member>/`, with its own `MEMORY.md`): preferences, working style and personal context. Only that member's agents can see it.
- **Routing:** the agent decides team vs personal per fact. When unsure it chooses personal, because a personal fact can be shared later but a leak can't be undone. Clients can force a choice with `remember(..., scope: "team" | "personal")`.
- **Enforcement is in code, not just the prompt:**
  - Every agent run gets an access scope, and the file tools refuse any path outside it.
  - Raw observations are stored under their author and readable only by them.
  - Personal and shared changes are committed separately, and each member's history shows only commits they're allowed to see.
  - Dreaming runs once over the shared space, which can't see any private space, and once per member whose personal space changed.
  - See [scripts/acl-test.ts](scripts/acl-test.ts).
- **Revoking a member:** their key stops working (within ~15 s across instances). Their personal memory is kept; re-adding the same id restores it.

## MCP tools (per member)

| Tool | What it does |
|---|---|
| `memory_context` | Returns the team's `MEMORY.md` plus your personal `MEMORY.md`. Clients call it at session start. |
| `remember` | Sends an observation (`scope`: `auto` / `team` / `personal`). Returns immediately; set `wait: true` to get back what changed. |
| `recall` | Asks the agent a question. It searches team and personal memory and answers with the facts, who contributed them, and sources. |
| `forget` | Deletes or corrects something. |
| `memory_read` | Reads a file you can see, or lists them. |
| `memory_log` | Shows recent commits you can see, plus queue status. |
| `dream` | Queues consolidation now. |

The server also sends MCP `instructions` that tell client agents when to call each tool.

## Deploy to Firebase

Everything is serverless and scales to zero (no min instances), so an idle or lightly used deployment costs about **\$0/month** within the free tier. You pay Ollama Cloud for tokens.

> Firebase Functions require the **Blaze** (pay-as-you-go) plan, but this workload stays inside its free quotas: 2M invocations/month, Firestore 50k reads + 20k writes per day. Set a budget alert in the Google Cloud console if you want a hard warning.

1. **Create the project.** In the [Firebase console](https://console.firebase.google.com), add a project, upgrade it to Blaze, and create a **Firestore** database (Native mode, e.g. `eur3` or `europe-west1`).
2. **Install the CLI and log in:**
   ```powershell
   npm i -g firebase-tools
   firebase login
   firebase use --add          # pick your project; writes .firebaserc
   ```
3. **Set the secrets:**
   ```powershell
   firebase functions:secrets:set OLLAMA_API_KEY      # from https://ollama.com/settings/keys
   firebase functions:secrets:set MAAS_ADMIN_TOKEN    # any long random string; this is the server admin token
   ```
4. **Optional:** `copy .env.example .env` and choose models, region and time zone.
5. **Deploy:**
   ```powershell
   npm run deploy
   ```
   The output prints the `api` function URL, e.g. `https://api-abc123-ew.a.run.app`. That is your `$URL`.
6. **Create your team.** This prints **your member key** once:
   ```powershell
   $env:MAAS_URL="$URL"; $env:MAAS_TOKEN="<MAAS_ADMIN_TOKEN>"
   npm run admin -- team:create acme "Acme Inc" chris "Chris"
   ```

Deployed functions:

| Function | Trigger | Job |
|---|---|---|
| `api` | HTTPS | `/mcp`, `/api`, `/view/` |
| `ingest` | Firestore: new doc in `teams/{team}/inbox` | Runs the team's memory agent. A lease lock keeps one writer per team. |
| `sweep` | every 10 min | Retries and work left over after a timeout. |
| `nightlyDream` | 04:00 daily | Queues a dream for every team. |

Logs: `npm run logs`, or the Cloud console.

## Onboard teammates

From the viewer: **Team & keys → Add a member**. The key is shown once; send it to your teammate.

Or from the CLI, using your member key (team admin) or the server admin token:
```powershell
$env:MAAS_URL="$URL"; $env:MAAS_TOKEN="<your key>"
npm run admin -- member:add acme alice "Alice"          # prints alice's key + connection info
npm run admin -- member:add acme bob "Bob" admin
npm run admin -- members acme
npm run admin -- member:rotate acme alice               # members can also rotate their own key
npm run admin -- member:revoke acme alice
npm run admin -- export acme ./acme-memory              # markdown snapshot of what your key can see
# server admin token only:
npm run admin -- team:create design "Design Team" dana "Dana"
```

The same operations are available over HTTP. Authenticate with `Authorization: Bearer <key>`:
- `GET  /api/me` (any key)
- `GET  /api/teams`
- `POST /api/teams` (admin token only)
- `GET  /api/teams/:team`, `PATCH /api/teams/:team` (name)
- `POST /api/teams/:team/members`
- `POST /api/teams/:team/members/:id/rotate`
- `PATCH /api/teams/:team/members/:id` (role)
- `DELETE /api/teams/:team/members/:id`
- `POST /api/teams/:team/dream`
- `GET  /api/teams/:team/files`: markdown export. A member gets shared files plus their own personal files; the admin token gets shared files only.

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

Open `$URL/view/?key=$KEY`. You see what your key is allowed to see:
- the team's `MEMORY.md`, with team files and your personal files (shown in purple)
- backlinks
- commit history with diffs
- the inbox, recent agent runs and errors
- your own raw sources
- a **Dream now** button
- **Team & keys**

## Run locally

Locally, data goes to a JSON file (`.data/db.json`) instead of Firestore, and the worker runs in-process. You don't need Java, the emulator or a Firebase project.

```powershell
npm install
$env:OLLAMA_API_KEY="<key>"              # or MAAS_LLM_URL=http://localhost:11434 for a local Ollama
$env:MAAS_ADMIN_TOKEN="admintoken"
npm run dev
$env:MAAS_URL="http://localhost:8080"; $env:MAAS_TOKEN="admintoken"
npm run admin -- team:create acme "Acme" chris "Chris"; npm run admin -- member:add acme bob "Bob"
$env:MAAS_URL="http://localhost:8080/mcp"; $env:MAAS_TOKEN="<chris key>"; $env:MAAS_TOKEN_B="<bob key>"
npm run smoke -- --full                   # team vs personal routing + cross-member privacy
npm run acl-test                          # offline privacy-model tests
```

To run locally against a real Firestore, set `MAAS_STORE=firestore` and `GOOGLE_CLOUD_PROJECT=<project>` after `gcloud auth application-default login`.

## Configuration

| Env var | Default | |
|---|---|---|
| `OLLAMA_API_KEY` | — | Ollama Cloud API key. A secret on Firebase. |
| `MAAS_ADMIN_TOKEN` | — | Server admin token: create teams and manage any team. It can't act as a member on `/mcp`. A secret on Firebase. |
| `MAAS_LLM_URL` | `https://ollama.com` | Any Ollama-API endpoint, e.g. a self-hosted Ollama. |
| `MAAS_AGENT_MODEL` / `MAAS_DREAM_MODEL` | `gpt-oss:120b` | Models for ingest/recall and for dreaming. They need tool calling. |
| `MAAS_DREAM_EVERY` | `25` | Auto-dream after N observations per team (`0` = off). |
| `MAAS_MAX_AGENT_STEPS` | `24` | Tool-call budget per agent run. |
| `MAAS_STORE` | `firestore` on Firebase, else `local` | Storage backend. |
| `MAAS_DATA_DIR` | `.data` | Local store location. |
| `MAAS_REGION` / `MAAS_TIMEZONE` | `europe-west1` / `Europe/Berlin` | Deploy region; time zone of the nightly dream. |
| `MAAS_DEBUG` | — | Log every agent tool call. |

## Layout

```
src/functions.ts     Firebase entry: api (HTTPS), ingest (Firestore trigger), sweep, nightlyDream
src/server.ts        local dev entry (same app, in-process worker)
src/app.ts           HTTP: auth (member keys / admin token), /mcp, /api, /dream, /view
src/teams.ts         team registry: members, roles, hashed keys
src/access.ts        shared / private / sources zones and per-run access scopes
src/mcp.ts           MCP tools + instructions, bound to the calling member
src/agent/agent.ts   inbox, per-team lease lock, ingest, recall, dream, sweeper
src/agent/prompts.ts curation rules, team-vs-personal routing, memory format
src/agent/tools.ts   the agent's scoped file tools
src/store.ts         a team's markdown files + commit log (diffs) on the doc store
src/db.ts            doc store: Firestore, or a local JSON file for dev/tests
src/llm.ts           Ollama tool-calling loop
src/web.ts           member-scoped viewer + team & key management
scripts/admin.ts     admin CLI · scripts/smoke.ts MCP smoke test · scripts/acl-test.ts privacy tests
```
