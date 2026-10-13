// Cloudflare Access JWT check: RS256 signature against the team's JWKS, audience, issuer, expiry.
type Jwks = { keys: (JsonWebKey & { kid?: string })[] };
export type JwksLoader = (teamDomain: string) => Promise<Jwks>;

let cache: { team: string; at: number; jwks: Jwks } | null = null;

// ponytail: module-level cache per isolate, 10 minutes; an unknown kid refetches at most once a minute.
export const loadJwks: JwksLoader = async (team) => {
  if (cache && cache.team === team && Date.now() - cache.at < 600_000) return cache.jwks;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`certs ${res.status}`);
  cache = { team, at: Date.now(), jwks: (await res.json()) as Jwks };
  return cache.jwks;
};

const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const parse = (s: string) => JSON.parse(new TextDecoder().decode(b64(s)));

/** The verified email in an Access JWT, or null for anything missing, malformed, forged or expired. */
export async function accessEmail(token: string, team: string, aud: string, jwks: JwksLoader = loadJwks, now = Date.now()): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || !team || !aud) return null;
  try {
    const header = parse(parts[0]!);
    const claims = parse(parts[1]!);
    if (header.alg !== "RS256") return null;
    let key = (await jwks(team)).keys.find((k) => k.kid === header.kid);
    if (!key && cache && Date.now() - cache.at > 60_000) {
      cache = null;
      key = (await jwks(team)).keys.find((k) => k.kid === header.kid);
    }
    if (!key) return null;
    const pub = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub, b64(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`)))) return null;
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const sec = now / 1000;
    if (!auds.includes(aud) || claims.iss !== `https://${team}`) return null;
    if (typeof claims.exp !== "number" || claims.exp <= sec || (typeof claims.nbf === "number" && claims.nbf > sec + 60)) return null;
    return typeof claims.email === "string" && claims.email ? claims.email.toLowerCase() : null;
  } catch {
    return null;
  }
}
