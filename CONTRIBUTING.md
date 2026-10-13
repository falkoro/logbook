# Contributing

Thanks for helping. Logbook is small on purpose: one tracker for every app, built for agents first, on infrastructure you own.

## Set up

You need [Bun](https://bun.sh).

```sh
bun install
bun run demo        # a filled demo workspace on http://localhost:8796
bun run dev:ui      # UI with hot reload, proxied to the server on 8796
bun run check       # types
bun test            # tests (bun:sqlite, no services needed)
```

`bun run dev` runs the Cloudflare Worker locally with wrangler instead of the Bun server.

## Where things live

[docs/design.md](docs/design.md) is the map: the data model, the rules the core enforces, and how the same code runs on Workers and on Bun.

- `src/core`: the ops registry (one zod schema per op) and every rule. If a rule can be enforced here, it is enforced here and nowhere else.
- `src/db`, `src/blobs`: the D1/SQLite and R2/disk adapters. Migrations in `migrations/` are shared.
- `src/http`: Hono routes, MCP, auth, hooks. `src/ui`: React.
- `entry/`: the Worker and the Bun server. `cli/`, `import/`: the CLI and the Linear importer.

## Rules of the road

- The MCP tools keep Linear's names and inputs. Adding a tool is fine; renaming or changing an existing one needs a very good reason, because agents that already use Linear switch over by changing a URL and a token.
- A merged PR never closes an issue; a release going live does. Only a human answers a decision. Nothing is hard-deleted through the API. Keep those.
- New behaviour comes with a test in `test/`. The suite runs in under a second; keep it that way.
- Small PRs over big ones. Say what changed and why in the description.
- Plain English in the UI and docs, sentence case, no exclamation marks.

## Reporting a problem

Open an issue with what happened, what you expected, and how to reproduce it. If it is a security problem, do not open an issue; follow [SECURITY.md](SECURITY.md) to report it privately.

## Conduct

Be kind, assume good intent, and keep it about the work. Maintainers may remove anything that is not.
