# Logbook: design

## Why

Several products, each in its own paid tracker workspace, and no single view of where everything stands.
Logbook is one tracker for every app, built for agents first (they do most of the issue work), on
infrastructure you own, with no seats.

The same code runs on Cloudflare (Workers + D1 + R2) or self-hosted (one Bun process, a SQLite file and a
data folder).

## Users

One human, the owner (the captain), plus agents. Agents authenticate with named bearer tokens; the captain
through Cloudflare Access. No per-app permissions.

## Data model (SQLite; D1 and bun:sqlite run the same migrations)

`teams` (one per app; key + `next_number`), `actors` (human | agent | system), `tokens` (hashed),
`states` (per team, typed: triage, backlog, unstarted, started, completed, canceled, duplicate),
`labels` (optional group; exclusive groups), `issues` (team + number, markdown, state, priority 0-4,
assignee, creator, parent, release, duplicate_of, dedupe_key, timestamps), `issue_labels`,
`comments`, `docs`, `attachments` (blob in R2/disk, or an external link), `releases`
(planned → staging → live | rolled_back), `decisions` (the captain inbox: decide | review,
question, options, recommendation, open → answered | withdrawn), `pr_links`, and the append-only
`changes` log (`sync_id` only goes up; every write lands there with a full-row snapshot).

Left out: cycles, projects, milestones, estimates, SLAs, custom fields. A Linear project becomes a
child of the workspace label group "Project" (single choice per issue).

Imported rows keep their Linear UUID as their id, so a re-import updates instead of duplicating.

## Rules (enforced in `src/core`, never in the UI)

- Every write goes through one batch that writes the row(s) and their `changes` entries atomically.
- Only a human can **answer** a decision. Agents can ask and withdraw.
- Nothing is hard-deleted through the API; issues and docs are archived.
- `save_issue` with a `dedupeKey` that matches an open issue in the same team comments "seen again"
  on that issue instead of creating a new one.
- A release going **live** moves every attached issue that is not done to the team's first
  completed state, comments "Live in vX.Y.Z" on every attached issue that is not canceled or a
  duplicate, stamps `deployed_at`, and writes release notes as a doc. Issues that were already done get the comment too, so every
  issue records when it shipped.
- A merged PR never closes an issue; the release going live does.
- Import writes history as it was: no rules fire. Only a human or a system token may import, an
  import never changes an actor's kind or email, and it never reopens or rewords an answered decision.
- A login (Access or dev) only ever maps to a **human** actor; an owner email held by an agent or
  system actor cannot log in.

## Architecture

```
src/core     business logic and the ops registry (one zod schema per op)
src/db       Db adapter: d1.ts | sqlite.ts       migrations/*.sql shared
src/blobs    Blobs adapter: r2.ts | disk.ts
src/auth     Access JWT (owner) | bearer tokens (agents) | dev mode on localhost only
src/http     Hono: POST /api/<op>, GET /api/changes, POST /mcp, /hooks/github, /files/<id>, UI
src/ui       React + Vite static build
entry/       worker.ts (D1 + R2 + cron) | server.ts (SQLite file + disk + timer)
cli/         logbook CLI over the same ops
import/      Linear importer (GraphQL → import_rows), dry-run reconciliation report
```

REST, MCP, CLI, webhooks and the importer all call the same ops. MCP tool names and inputs follow
Linear's MCP (`list_issues`, `get_issue`, `save_issue`, `save_comment`, …) so an agent switches over
with a URL and token swap. New: `ask_decision`, `list_decisions`, `answer_decision`,
`save_release`, `set_release_status`, `link_pr`, `search`, `overview` (the one-dashboard numbers per app).

Near-live UI without Durable Objects: the visible tab polls `/api/changes?after=<sync_id>`.

PR links: Origin has no webhooks, so a cron (Worker) or timer (self-host) polls
`GET /v1/origin/repos/{org}/{repo}/pulls` for each repo in `ORIGIN_REPOS` (`*` = every repo the key
can see that was pushed in the last day, so the whole estate without polling idle repos); GitHub uses an
HMAC-checked webhook. Issue keys are read from PR title, body and branch.

Auth on Cloudflare: one Access application on the hostname with a bypass for `/api`, `/mcp`,
`/hooks` and `/files`; the app itself verifies either the Access JWT (header or `CF_Authorization`
cookie) or a bearer token on every request and refuses everything else (fail closed).

Connectors that only take a URL (claude.ai, Cowork) sign in with MCP OAuth (`src/http/oauth.ts`):
a 401 from `/mcp` names `/.well-known/oauth-protected-resource`, which points at the
authorization-server metadata; the client registers itself (`POST /oauth/register`, public clients,
https or localhost redirect URIs) and runs the code flow with PKCE S256. `GET /oauth/authorize` sits
behind Access: the owner sees "<client> wants to act as agent <name>" and approves (a one-time nonce
bound to the owner plus an `Origin` check stop a cross-site approve). The grant is one `tokens` row for
an agent named after the client (`Claude` → `claude`), never the owner, so it cannot answer decisions:
a 1-hour access token and a rotating refresh token, both stored hashed; `revoke_token` ends it.
Codes live 5 minutes and work once.

## Import from Linear

Importer (`import/linear.ts`) reads a workspace over GraphQL: teams, states, labels, users, all
issues (archived too), comments, documents, attachments. Keeps ids, numbers, timestamps, authors and
parents, so a re-import updates in place. Linear-hosted files are copied in (≤ 25 MB each; larger ones
stay a link to Linear) and Linear links in markdown are rewritten to `/files/…`, `/issue/KEY-N` and
`/doc/…`.

Releases: Linear's native releases become releases. A version is **live** once a release pipeline
named like `prod` completed it; a staging-only version counts as live from the first production
release at or above it. Each issue gets the earliest version it shipped in. Version labels
(group `Versie`/`Version`) become releases only in a workspace without native releases, where they are
roadmap targets otherwise; the labels are always kept. Open `Captain beslist` / `Captain look` issues
become open decisions (`decide` / `review`).

The run ends with a reconciliation: every issue compared field by field (title, description, status,
priority, assignee, labels, parent, release, archived) plus the comments of 50 sampled issues; any
difference exits 1. `--dry-run` reports without writing.

Switching over: stop whatever writes to Linear, run the final import, point each agent at Logbook's MCP URL
with its own token, and keep a JSON export. You can roll back until you revoke the Linear keys. Files over 25 MB
are uploaded by hand (`wrangler r2 object put <bucket>/files/<id>` plus an import row with `blob_key`).

## Testing

`bun test`: the core suite runs against bun:sqlite and against a local D1 (wrangler's
`getPlatformProxy`), plus HTTP/MCP/auth tests through `app.request()`.
