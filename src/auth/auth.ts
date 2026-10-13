// Who is calling. Fail closed: a bearer token, a verified Access login of a listed owner, or (local development only) DEV_AUTH.
import { first, q, type Db } from "../db/db";
import { type Actor, sha256, uid } from "../core/ctx";
import { logChange } from "../core/log";
import { type JwksLoader, accessEmail, loadJwks } from "./access";

export type Config = {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Comma list of emails that may log in as the human owner. Empty = no human can log in. */
  OWNER_EMAILS?: string;
  /** "1" lets a loopback request to localhost act as dev@localhost. Never set in a deployment. */
  DEV_AUTH?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  /** Comma list of Origin repos (org/name) whose PRs are polled. */
  ORIGIN_REPOS?: string;
  ORIGIN_TOKEN?: string;
};

export type Auth = { actor: Actor; via: "token" | "access" | "dev" };

const ACTOR = "SELECT id, kind, name, email FROM actors";

export async function ensureActor(db: Db, kind: Actor["kind"], name: string, email: string | null): Promise<Actor> {
  const found = await first<Actor>(db, email ? q(`${ACTOR} WHERE lower(email) = ? ORDER BY kind <> ?`, email, kind) : q(`${ACTOR} WHERE name = ? AND kind = ?`, name, kind));
  if (found) return found;
  const actor: Actor = { id: uid(), kind, name, email };
  const now = new Date().toISOString();
  // Name is unique; a clash (an agent called "alex") gets the email's domain appended.
  const taken = await first(db, q("SELECT 1 FROM actors WHERE lower(name) = lower(?)", name));
  if (taken) actor.name = `${name} (${email ?? kind})`;
  await db.batch([
    q("INSERT INTO actors (id, kind, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", actor.id, kind, actor.name, email, now, now),
    logChange({ db, actor, now } as never, "actor", actor.id, "create"),
  ]);
  return actor;
}

/** The in-process actor for cron jobs and webhooks. */
export const systemActor = (db: Db) => ensureActor(db, "system", "logbook", null);

/** A login proves a person; it never becomes an agent or system actor that happens to hold the same email. */
const asHuman = (actor: Actor) => (actor.kind === "human" ? actor : null);

const cookie = (req: Request, name: string) =>
  req.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;

export async function authenticate(req: Request, db: Db, cfg: Config, opts: { local?: boolean; jwks?: JwksLoader } = {}): Promise<Auth | null> {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (bearer) {
    const now = new Date().toISOString();
    const row = await first<Actor & { token_id: string; last_used_at: string | null }>(
      db,
      q(
        `SELECT a.id, a.kind, a.name, a.email, k.id AS token_id, k.last_used_at FROM tokens k JOIN actors a ON a.id = k.actor_id
         WHERE k.hash = ? AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?) AND a.archived_at IS NULL`,
        await sha256(bearer),
        now,
      ),
    );
    if (!row) return null;
    // ponytail: last_used_at is stamped at most hourly so reads stay read-only.
    if (!row.last_used_at || Date.parse(now) - Date.parse(row.last_used_at) > 3_600_000) {
      await db.batch([q("UPDATE tokens SET last_used_at = ? WHERE id = ?", now, row.token_id)]);
    }
    return { actor: { id: row.id, kind: row.kind, name: row.name, email: row.email }, via: "token" };
  }
  const jwt = req.headers.get("cf-access-jwt-assertion") ?? cookie(req, "CF_Authorization");
  if (jwt && cfg.ACCESS_TEAM_DOMAIN && cfg.ACCESS_AUD) {
    const email = await accessEmail(jwt, cfg.ACCESS_TEAM_DOMAIN, cfg.ACCESS_AUD, opts.jwks ?? loadJwks);
    const owners = (cfg.OWNER_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    const actor = email && owners.includes(email) ? asHuman(await ensureActor(db, "human", email.split("@")[0]!, email)) : null;
    return actor && { actor, via: "access" };
  }
  const host = new URL(req.url).hostname;
  if (cfg.DEV_AUTH === "1" && opts.local && (host === "localhost" || host === "127.0.0.1")) {
    const actor = asHuman(await ensureActor(db, "human", "dev", "dev@localhost"));
    return actor && { actor, via: "dev" };
  }
  return null;
}

/** GitHub's X-Hub-Signature-256: hex HMAC-SHA256 of the raw body, compared in constant time. */
export async function githubSignatureOk(secret: string, body: string, header: string | null) {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const got = header.slice(7);
  if (got.length !== mac.length) return false;
  let diff = 0;
  for (let i = 0; i < mac.length; i++) diff |= mac.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
