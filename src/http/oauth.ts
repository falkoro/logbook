// MCP OAuth for connectors that only take a URL (claude.ai, Cowork): metadata, open client registration, an
// authorization-code flow with PKCE (S256) whose approve page sits behind Cloudflare Access, and rotating refresh tokens.
// Approving is the owner's act; the token always belongs to an agent named after the client, never to the owner.
import type { Context, Hono } from "hono";
import { type Actor, sha256, uid } from "../core/ctx";
import { newToken } from "../core/workspace";
import { first, q } from "../db/db";
import { type Config, authenticate, ensureActor } from "../auth/auth";
import type { Deps } from "./app";

const ACCESS_TTL = 3600; // seconds an access token lives; the client refreshes after that
const CODE_TTL = 300_000; // ms for the approve page and for the code it hands out

type Client = { id: string; name: string; redirect_uris: string };
type Code = { hash: string; client_id: string; human_id: string; agent_id: string | null; redirect_uri: string; challenge: string; expires_at: string };

const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const origin = (c: Context) => new URL(c.req.url).origin;
const s256 = async (v: string) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))))).replace(/[+/=]/g, (ch) => ({ "+": "-", "/": "_", "=": "" })[ch]!);

/** "Claude Code" → "claude-code": the agent a client acts as. */
export const agentName = (client: string) => client.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "mcp-client";

function redirectOk(u: unknown) {
  if (typeof u !== "string" || u.length > 2000) return false;
  try {
    const url = new URL(u);
    return !url.hash && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  } catch {
    return false;
  }
}

function page(status: number, title: string, body: string) {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Logbook</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#0f1115;color:#e6e6e6;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
main{max-width:28rem}h1{font-size:1.25rem}code{background:#222630;padding:0 .25em;border-radius:4px}button{font:inherit;padding:.5em 1.2em;border-radius:6px;border:1px solid #3a3f4b;background:#222630;color:inherit;margin-right:.5em;cursor:pointer}button[value=approve]{background:#3b5bdb;border-color:#3b5bdb}</style>
<main><h1>${esc(title)}</h1>${body}</main>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", "x-frame-options": "DENY", "cache-control": "no-store" },
  });
}

/** Back to the client's redirect_uri with the given query parameters. */
function back(uri: string, params: Record<string, string | undefined>) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: u.toString(), "cache-control": "no-store" } });
}

export function mountOauth(app: Hono<any>, deps: Deps) {
  const { db } = deps;
  const clientFor = async (id: unknown) => (typeof id === "string" ? first<Client>(db, q("SELECT id, name, redirect_uris FROM oauth_clients WHERE id = ?", id)) : null);

  /** The owner, logged in through Access (or DEV_AUTH locally). A bearer token never approves anything. */
  const owner = async (c: Context): Promise<Actor | Response> => {
    const auth = await authenticate(c.req.raw, db, deps.cfg as Config, { local: deps.isLocal?.(c.req.raw) });
    if (!auth) return page(401, "Log in first", "<p>Open Logbook in this browser, log in, then connect again.</p>");
    if (auth.via === "token" || auth.actor.kind !== "human") return page(403, "Only the owner can approve", "<p>An API token cannot approve a connection.</p>");
    return auth.actor;
  };

  const resource = (c: Context) => c.json({ resource: `${origin(c)}/mcp`, authorization_servers: [origin(c)], bearer_methods_supported: ["header"] });
  app.get("/.well-known/oauth-protected-resource", resource);
  app.get("/.well-known/oauth-protected-resource/mcp", resource);
  app.get("/.well-known/oauth-authorization-server", (c) => {
    const o = origin(c);
    return c.json({
      issuer: o,
      authorization_endpoint: `${o}/oauth/authorize`,
      token_endpoint: `${o}/oauth/token`,
      registration_endpoint: `${o}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });
  // Anything else under .well-known is a plain 404, never the UI's index.html.
  app.get("/.well-known/*", (c) => c.json({ error: "not_found" }, 404));

  // Dynamic client registration (RFC 7591), public clients only. Registering grants nothing: the owner still approves.
  // ponytail: registration is open and unbounded; add a per-IP limit or a sweep of never-approved clients if it gets abused.
  app.post("/oauth/register", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(redirectOk)) {
      return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris must be https URLs (http only for localhost)" }, 400);
    }
    const name = typeof body!.client_name === "string" && body!.client_name.trim() ? body!.client_name.trim().slice(0, 100) : "MCP client";
    const id = uid();
    const now = iso();
    await db.batch([q("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)", id, name, JSON.stringify(uris), now)]);
    return c.json(
      {
        client_id: id,
        client_id_issued_at: Math.floor(Date.parse(now) / 1000),
        client_name: name,
        redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
    );
  });

  app.get("/oauth/authorize", async (c) => {
    const who = await owner(c);
    if (who instanceof Response) return who;
    const p = c.req.query();
    const client = await clientFor(p.client_id);
    if (!client || !(JSON.parse(client.redirect_uris) as string[]).includes(p.redirect_uri ?? "")) {
      return page(400, "Unknown app", "<p>This connection request names an app or return address Logbook does not know. Start connecting again from the app.</p>");
    }
    if (p.response_type !== "code") return back(p.redirect_uri!, { error: "unsupported_response_type", state: p.state });
    if (p.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge ?? "")) {
      return back(p.redirect_uri!, { error: "invalid_request", error_description: "PKCE with S256 is required", state: p.state });
    }
    const nonce = newToken();
    await db.batch([
      q("DELETE FROM oauth_codes WHERE expires_at < ?", iso()),
      q(
        "INSERT INTO oauth_codes (hash, stage, client_id, human_id, redirect_uri, challenge, expires_at) VALUES (?, 'consent', ?, ?, ?, ?, ?)",
        await sha256(nonce),
        client.id,
        who.id,
        p.redirect_uri,
        p.code_challenge,
        iso(CODE_TTL),
      ),
    ]);
    const hidden = (k: string, v?: string) => (v === undefined ? "" : `<input type="hidden" name="${k}" value="${esc(v)}">`);
    return page(
      200,
      "Connect to Logbook?",
      `<p><b>${esc(client.name)}</b> wants to act in Logbook as agent <code>${esc(agentName(client.name))}</code>: read and change issues like any agent. It cannot answer your decisions.</p>
<p>It returns to <code>${esc(new URL(p.redirect_uri!).host)}</code>. You can revoke it any time under tokens.</p>
<form method="post" action="/oauth/authorize">${hidden("nonce", nonce)}${hidden("state", p.state)}<button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form>`,
    );
  });

  app.post("/oauth/authorize", async (c) => {
    const who = await owner(c);
    if (who instanceof Response) return who;
    // The nonce is bound to this owner and works once; the Origin check stops a cross-site form from posting it.
    if (c.req.header("origin") !== origin(c)) return page(403, "Refused", "<p>Approve from Logbook's own page.</p>");
    const form = await c.req.parseBody();
    const state = typeof form.state === "string" ? form.state : undefined;
    const nonceHash = await sha256(String(form.nonce ?? ""));
    const row = await first<Code>(db, q("SELECT * FROM oauth_codes WHERE hash = ? AND stage = 'consent' AND human_id = ? AND expires_at > ?", nonceHash, who.id, iso()));
    if (!row) return page(400, "This request expired", "<p>Start connecting again from the app.</p>");
    if (form.decision !== "approve") {
      await db.batch([q("DELETE FROM oauth_codes WHERE hash = ?", nonceHash)]);
      return back(row.redirect_uri, { error: "access_denied", state });
    }
    const client = (await clientFor(row.client_id))!;
    const agent = await ensureActor(db, "agent", agentName(client.name), null);
    const code = newToken();
    const codeHash = await sha256(code);
    await db.batch([q("UPDATE oauth_codes SET hash = ?, stage = 'code', agent_id = ?, expires_at = ? WHERE hash = ? AND stage = 'consent'", codeHash, agent.id, iso(CODE_TTL), nonceHash)]);
    if (!(await first(db, q("SELECT 1 FROM oauth_codes WHERE hash = ? AND stage = 'code'", codeHash)))) return page(400, "Already approved", "<p>This request was already used.</p>");
    return back(row.redirect_uri, { code, state });
  });

  app.post("/oauth/token", async (c) => {
    const ct = c.req.header("content-type") ?? "";
    const f = (ct.includes("application/json") ? await c.req.json().catch(() => ({})) : await c.req.parseBody()) as Record<string, string | undefined>;
    const fail = (error: string, description: string, status: 400 | 401 = 400) => c.json({ error, error_description: description }, status, { "cache-control": "no-store" });
    const client = await clientFor(f.client_id);
    if (!client) return fail("invalid_client", "Unknown client_id", 401);
    const grant = (access: string, refresh: string) => c.json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh }, 200, { "cache-control": "no-store" });

    if (f.grant_type === "authorization_code") {
      // Claim first, then check: a code is spent by its first exchange, right or wrong.
      const codeHash = await sha256(f.code ?? "");
      const claim = uid();
      await db.batch([q("UPDATE oauth_codes SET claim = ? WHERE hash = ? AND stage = 'code' AND claim IS NULL", claim, codeHash)]);
      const row = await first<Code>(db, q("SELECT * FROM oauth_codes WHERE hash = ? AND claim = ?", codeHash, claim));
      if (!row || row.expires_at <= iso() || row.client_id !== client.id || row.redirect_uri !== f.redirect_uri) return fail("invalid_grant", "Unknown, used or expired code, or a different redirect_uri");
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(f.code_verifier ?? "") || (await s256(f.code_verifier!)) !== row.challenge) return fail("invalid_grant", "code_verifier does not match");
      const access = newToken();
      const refresh = newToken();
      await db.batch([
        q(
          "INSERT INTO tokens (id, actor_id, name, hash, created_at, expires_at, client_id, refresh_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          uid(),
          row.agent_id,
          `${client.name} (OAuth)`,
          await sha256(access),
          iso(),
          iso(ACCESS_TTL * 1000),
          client.id,
          await sha256(refresh),
        ),
      ]);
      return grant(access, refresh);
    }

    if (f.grant_type === "refresh_token") {
      const old = await sha256(f.refresh_token ?? "");
      const row = await first<{ id: string }>(
        db,
        q("SELECT k.id FROM tokens k JOIN actors a ON a.id = k.actor_id WHERE k.refresh_hash = ? AND k.client_id = ? AND k.revoked_at IS NULL AND a.archived_at IS NULL", old, client.id),
      );
      if (!row) return fail("invalid_grant", "Unknown, used or revoked refresh_token");
      // Rotate both in place: the grant stays one tokens row, so revoking it ends the connection.
      const access = newToken();
      const refresh = newToken();
      const fresh = await sha256(refresh);
      await db.batch([q("UPDATE tokens SET hash = ?, refresh_hash = ?, expires_at = ? WHERE id = ? AND refresh_hash = ?", await sha256(access), fresh, iso(ACCESS_TTL * 1000), row.id, old)]);
      if (!(await first(db, q("SELECT 1 FROM tokens WHERE id = ? AND refresh_hash = ?", row.id, fresh)))) return fail("invalid_grant", "refresh_token was already used");
      return grant(access, refresh);
    }

    return fail("unsupported_grant_type", "Use authorization_code or refresh_token");
  });
}
