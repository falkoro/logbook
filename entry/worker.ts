// Cloudflare: D1 + R2 + static assets; a cron polls Origin for PR links.
import { type Config, systemActor } from "../src/auth/auth";
import { r2 } from "../src/blobs/blobs";
import { pollOrigin } from "../src/core/prs";
import { d1 } from "../src/db/d1";
import { makeApp } from "../src/http/app";

type Env = Config & { DB: D1Database; FILES: R2Bucket; ASSETS: Fetcher };

const apps = new WeakMap<Env, ReturnType<typeof makeApp>>();
const appFor = (env: Env) => {
  let app = apps.get(env);
  if (!app) apps.set(env, (app = makeApp({ db: d1(env.DB), blobs: r2(env.FILES), cfg: env, assets: (r) => env.ASSETS.fetch(r) })));
  return app;
};

export default {
  fetch: (req, env, ectx) => appFor(env).fetch(req, env, ectx),
  scheduled(_event, env, ectx) {
    const repos = (env.ORIGIN_REPOS ?? "").split(",").map((r) => r.trim()).filter(Boolean);
    if (!repos.length || !env.ORIGIN_TOKEN) return;
    ectx.waitUntil(
      (async () => {
        const db = d1(env.DB);
        const actor = await systemActor(db);
        await pollOrigin({ db, blobs: r2(env.FILES), actor, now: new Date().toISOString() }, repos, env.ORIGIN_TOKEN!);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
