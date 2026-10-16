// Self-hosted: one Bun process, a SQLite file and a files folder under LOGBOOK_DATA (default ./data).
// Put it behind a Cloudflare Tunnel with the same Access app, or keep it on 127.0.0.1.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Config, systemActor } from "../src/auth/auth";
import { disk } from "../src/blobs/disk";
import { pollOrigin } from "../src/core/prs";
import { sqlite } from "../src/db/sqlite";
import { makeApp } from "../src/http/app";

const cfg = process.env as Config;
const data = resolve(process.env.LOGBOOK_DATA ?? "data");
mkdirSync(join(data, "files"), { recursive: true });
const db = sqlite(join(data, "logbook.sqlite"));
const blobs = disk(join(data, "files"));
const dist = resolve(import.meta.dir, "../dist");

async function assets(req: Request) {
  const path = resolve(dist, `.${new URL(req.url).pathname}`);
  const file = Bun.file(path);
  if (path.startsWith(`${dist}/`) && (await file.exists())) return new Response(file);
  return new Response(Bun.file(join(dist, "index.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
}

const local = new WeakSet<Request>();
// In Docker a published port arrives from the bridge, never loopback; docker-compose.yml sets this and publishes on 127.0.0.1 only.
const anyPeer = process.env.LOCAL_ANY_PEER === "1";
const app = makeApp({ db, blobs, cfg, assets, isLocal: (r) => local.has(r) });

const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8796),
  fetch(req, srv) {
    const ip = srv.requestIP(req)?.address;
    if (anyPeer || ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") local.add(req);
    return app.fetch(req);
  },
});
console.log(`logbook on http://${server.hostname}:${server.port} (data in ${data})`);

const repos = (cfg.ORIGIN_REPOS ?? "").split(",").map((r) => r.trim()).filter(Boolean);
if (repos.length && cfg.ORIGIN_TOKEN) {
  const poll = async () => {
    try {
      await pollOrigin({ db, blobs, actor: await systemActor(db), now: new Date().toISOString() }, repos, cfg.ORIGIN_TOKEN!);
    } catch (e) {
      console.error("origin poll:", e);
    }
  };
  setInterval(poll, 5 * 60_000);
  void poll();
}
