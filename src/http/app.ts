// The HTTP surface, identical on Workers and Bun: REST ops, the change feed, MCP, webhooks, files and the UI.
import { Hono } from "hono";
import { z } from "zod";
import { type Config, authenticate, githubSignatureOk, systemActor } from "../auth/auth";
import type { Blobs } from "../blobs/blobs";
import { type Actor, type Ctx, Fail } from "../core/ctx";
import { OPS } from "../core/ops";
import { githubPr, syncPrs } from "../core/prs";
import { runOp } from "../core/registry";
import { storeFile } from "../core/workflow";
import { first, q, type Db } from "../db/db";
import { handleMcp } from "./mcp";
import { mountOauth } from "./oauth";

export type Deps = {
  db: Db;
  blobs: Blobs;
  cfg: Config;
  /** Static UI (Workers assets or a folder); omitted in tests. */
  assets?: (req: Request) => Promise<Response>;
  /** Whether the TCP peer is this machine (self-host only; DEV_AUTH needs it). */
  isLocal?: (req: Request) => boolean;
};

type Env = { Variables: { ctx: Ctx; via: string } };

// Files that are safe to show inline; anything else downloads, so an uploaded HTML or SVG page never runs on our origin.
const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|text\/plain|video\/(mp4|webm)|audio\/(mpeg|ogg|wav))$/;

export function makeApp(deps: Deps) {
  const app = new Hono<Env>();
  const ctxFor = (actor: Actor, req: Request): Ctx => ({ db: deps.db, blobs: deps.blobs, actor, now: new Date().toISOString(), baseUrl: new URL(req.url).origin });

  app.onError((e, c) => {
    if (e instanceof Fail) return c.json({ error: { code: e.code, message: e.message } }, e.status as 400);
    console.error(e);
    return c.json({ error: { code: "internal", message: "Something went wrong on our side" } }, 500);
  });

  app.get("/healthz", (c) => c.text("ok"));
  app.get("/openapi.json", (c) => c.json(openapi()));
  mountOauth(app, deps);

  // Everything below needs a caller. Cookie logins (the UI) must also send X-Logbook on writes: a custom header
  // forces a CORS preflight, so another site cannot post with the owner's cookie.
  const authed = async (c: any, next: () => Promise<void>) => {
    const auth = await authenticate(c.req.raw, deps.db, deps.cfg, { local: deps.isLocal?.(c.req.raw) });
    if (!auth) {
      // Points MCP clients at the OAuth metadata, so a connector that only has the URL can sign in.
      const meta = `${new URL(c.req.url).origin}/.well-known/oauth-protected-resource`;
      return c.json({ error: { code: "unauthorized", message: "Log in through Cloudflare Access or send a Bearer token" } }, 401, { "www-authenticate": `Bearer resource_metadata="${meta}"` });
    }
    if (auth.via !== "token" && c.req.method !== "GET" && c.req.header("x-logbook") !== "1") throw new Fail("Missing X-Logbook header", 403, "forbidden");
    c.set("ctx", ctxFor(auth.actor, c.req.raw));
    c.set("via", auth.via);
    await next();
  };
  app.use("/api/*", authed);
  app.use("/mcp", authed);
  app.use("/files/*", authed);

  app.get("/api/changes", async (c) => c.json(await runOp(OPS, "list_changes", c.get("ctx"), { after: Number(c.req.query("after") ?? 0), limit: 1000 })));

  app.post("/api/upload", async (c) => {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new Fail("Send the file as multipart field `file`");
    const issue = form.get("issue");
    return c.json(await storeFile(c.get("ctx"), { name: file.name || "file", mime: file.type || null, bytes: await file.arrayBuffer(), issue: typeof issue === "string" && issue ? issue : undefined }));
  });

  app.post("/api/:op", async (c) => {
    const body = c.req.header("content-type")?.includes("application/json") ? await c.req.json().catch(() => { throw new Fail("Body is not valid JSON"); }) : {};
    return c.json(await runOp(OPS, c.req.param("op"), c.get("ctx"), body));
  });

  app.get("/files/:id", async (c) => {
    const a = await first<{ blob_key: string | null; name: string; mime: string | null }>(deps.db, q("SELECT blob_key, name, mime FROM attachments WHERE id = ?", c.req.param("id")));
    const blob = a?.blob_key ? await deps.blobs.get(a.blob_key) : null;
    if (!a || !blob) throw new Fail("No such file", 404, "not_found");
    const inline = !!a.mime && INLINE.test(a.mime);
    return new Response(blob.body, {
      headers: {
        "content-type": inline ? a.mime! : "application/octet-stream",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
        "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  });

  app.post("/mcp", async (c) => {
    const msg = await c.req.json().catch(() => null);
    if (!msg || Array.isArray(msg)) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Send one JSON-RPC message" } }, 400);
    const reply = await handleMcp(c.get("ctx"), msg);
    return reply ? c.json(reply) : c.body(null, 202);
  });
  app.get("/mcp", (c) => c.body(null, 405));

  app.post("/hooks/github", async (c) => {
    const raw = await c.req.text();
    if (!(await githubSignatureOk(deps.cfg.GITHUB_WEBHOOK_SECRET ?? "", raw, c.req.header("x-hub-signature-256") ?? null))) throw new Fail("Bad signature", 401, "unauthorized");
    if (c.req.header("x-github-event") !== "pull_request") return c.json({ ignored: true });
    const pr = githubPr(JSON.parse(raw));
    if (!pr) return c.json({ ignored: true });
    return c.json({ linked: await syncPrs(ctxFor(await systemActor(deps.db), c.req.raw), [pr]) });
  });

  app.all("*", async (c) => (deps.assets ? deps.assets(c.req.raw) : c.notFound()));
  return app;
}

function openapi() {
  const paths: Record<string, unknown> = {};
  for (const o of OPS.values()) {
    const { $schema: _, ...schema } = z.toJSONSchema(o.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    paths[`/api/${o.name}`] = {
      post: {
        operationId: o.name,
        summary: o.description,
        ...(o.who && o.who !== "any" ? { "x-who": o.who } : {}),
        requestBody: { required: true, content: { "application/json": { schema } } },
        responses: { "200": { description: "OK" }, "4XX": { description: "{ error: { code, message } }" } },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Logbook", version: "0.1.0", description: "Every operation is POST /api/<name> with a JSON body. Send Authorization: Bearer <token>." },
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    security: [{ bearer: [] }],
    paths,
  };
}
