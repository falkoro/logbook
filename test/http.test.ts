import { describe, expect, test } from "bun:test";
import { accessEmail } from "../src/auth/access";
import { authenticate } from "../src/auth/auth";
import { q } from "../src/db/db";
import { makeApp } from "../src/http/app";
import { world } from "./helpers";

async function setup(extra: Record<string, string> = {}) {
  const w = await world();
  const { token } = await w.captain("create_token", { name: "test", actor: "crew" });
  const app = makeApp({ db: w.db, blobs: w.blobs, cfg: { DEV_AUTH: "1", GITHUB_WEBHOOK_SECRET: "s3cret", ...extra }, isLocal: () => true });
  const call = (path: string, init: RequestInit & { json?: unknown } = {}, auth: string | null = token) =>
    app.request(`http://localhost${path}`, {
      method: init.method ?? (init.json !== undefined || init.body ? "POST" : "GET"),
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      headers: { ...(init.json !== undefined ? { "content-type": "application/json" } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(init.headers as object) },
    });
  return { w, app, call, token };
}

const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, params });

describe("auth", () => {
  test("no credentials, a bad token or a revoked token get 401", async () => {
    const { w, app, call, token } = await setup();
    expect((await app.request("http://logbook.example/api/list_issues", { method: "POST" })).status).toBe(401);
    expect((await call("/api/list_issues", { json: {} }, "lb_nope")).status).toBe(401);
    const { tokens } = await w.captain("list_tokens");
    await w.captain("revoke_token", { id: tokens[0].id });
    expect((await call("/api/list_issues", { json: {} }, token)).status).toBe(401);
  });

  test("DEV_AUTH works only for a local peer on localhost, and cookie-style logins need X-Logbook to write", async () => {
    const { w, call } = await setup();
    const remote = makeApp({ db: w.db, blobs: w.blobs, cfg: { DEV_AUTH: "1" }, isLocal: () => false });
    expect((await remote.request("http://localhost/api/me", { method: "POST" })).status).toBe(401);
    expect((await call("/api/me", { json: {} }, null)).status).toBe(403);
    const ok = await call("/api/me", { json: {}, headers: { "x-logbook": "1" } }, null);
    expect(((await ok.json()) as any).kind).toBe("human");
  });

  test("Access JWTs: valid owner email in, others out", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1" };
    const b64 = (b: ArrayBuffer | string) => Buffer.from(typeof b === "string" ? b : new Uint8Array(b)).toString("base64url");
    const sign = async (claims: object) => {
      const head = `${b64(JSON.stringify({ alg: "RS256", kid: "k1" }))}.${b64(JSON.stringify(claims))}`;
      return `${head}.${b64(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(head)))}`;
    };
    const team = "t.cloudflareaccess.com";
    const jwks = async () => ({ keys: [jwk] });
    const good = { aud: ["aud1"], iss: `https://${team}`, exp: Date.now() / 1000 + 60, email: "Captain@Example.com" };
    expect(await accessEmail(await sign(good), team, "aud1", jwks)).toBe("captain@example.com");
    expect(await accessEmail(await sign({ ...good, aud: ["other"] }), team, "aud1", jwks)).toBeNull();
    expect(await accessEmail(await sign({ ...good, exp: 1 }), team, "aud1", jwks)).toBeNull();
    const [h, , sig] = (await sign(good)).split(".");
    expect(await accessEmail(`${h}.${b64(JSON.stringify({ ...good, email: "attacker@evil.com" }))}.${sig}`, team, "aud1", jwks)).toBeNull();

    const w = await world();
    const cfg = { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: "aud1", OWNER_EMAILS: "captain@example.com" };
    const req = async (claims: object) => new Request("https://logbook.example/api/me", { headers: { cookie: `x=1; CF_Authorization=${await sign(claims)}` } });
    const me = await authenticate(await req(good), w.db, cfg, { jwks });
    expect([me?.via, me?.actor.kind, me?.actor.name]).toEqual(["access", "human", "Captain"]);
    expect(await authenticate(await req({ ...good, email: "someone@else.com" }), w.db, cfg, { jwks })).toBeNull();
    // An owner email held by an agent row never logs in as that agent.
    await w.db.batch([q("UPDATE actors SET email = 'owner2@example.com' WHERE id = 'a-agent'")]);
    expect(await authenticate(await req({ ...good, email: "owner2@example.com" }), w.db, { ...cfg, OWNER_EMAILS: "owner2@example.com" }, { jwks })).toBeNull();
  });
});

describe("rest", () => {
  test("ops run with JSON bodies; failures come back as { error }", async () => {
    const { call } = await setup();
    const made = await call("/api/save_issue", { json: { team: "ENG", title: "from REST" } });
    expect(((await made.json()) as any).id).toBe("ENG-1");
    const bad = await call("/api/save_issue", { json: { team: "NOPE", title: "x" } });
    expect([bad.status, ((await bad.json()) as any).error.code]).toEqual([404, "not_found"]);
    const human = await call("/api/answer_decision", { json: { id: "x", answer: "y" } });
    expect(human.status).toBe(403);
    const changes = (await (await call("/api/changes?after=0")).json()) as any;
    expect(changes.changes.some((c: any) => c.entity === "issue")).toBe(true);
  });

  test("uploaded HTML is served as a sandboxed download, images inline", async () => {
    const { app, call } = await setup();
    const up = async (name: string, type: string) => {
      const form = new FormData();
      form.set("file", new File(["<script>alert(1)</script>"], name, { type }));
      return (await (await call("/api/upload", { body: form })).json()) as any;
    };
    const html = await up("x.html", "text/html");
    const res = await call(`/files/${html.id}`);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toStartWith("attachment");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    const png = await up("a.png", "image/png");
    expect(png.markdown).toBe(`![a.png](/files/${png.id})`);
    expect((await call(`/files/${png.id}`)).headers.get("content-type")).toBe("image/png");
    expect((await app.request(`http://logbook.example/files/${png.id}`)).status).toBe(401);
  });
});

describe("mcp", () => {
  test("initialize, list tools for the caller, call tools, report tool errors", async () => {
    const { call } = await setup();
    const init = (await (await call("/mcp", { json: rpc(1, "initialize", { protocolVersion: "2025-06-18" }) })).json()) as any;
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect((await call("/mcp", { json: { jsonrpc: "2.0", method: "notifications/initialized" } })).status).toBe(202);
    const tools = (await (await call("/mcp", { json: rpc(2, "tools/list") })).json()) as any;
    const names = tools.result.tools.map((t: any) => t.name);
    expect(names).toContain("save_issue");
    expect(names).not.toContain("answer_decision");
    expect(tools.result.tools.find((t: any) => t.name === "save_issue").inputSchema.properties.title.type).toBe("string");
    const made = (await (await call("/mcp", { json: rpc(3, "tools/call", { name: "save_issue", arguments: { team: "ENG", title: "via mcp" } }) })).json()) as any;
    expect(made.result.structuredContent.id).toBe("ENG-1");
    const bad = (await (await call("/mcp", { json: rpc(4, "tools/call", { name: "get_issue", arguments: { id: "ENG-99" } }) })).json()) as any;
    expect([bad.result.isError, bad.result.content[0].text]).toEqual([true, 'No issue "ENG-99"']);
  });
});

describe("github webhook", () => {
  test("refuses a bad signature and links on a good one", async () => {
    const { w, app } = await setup();
    await w.agent("save_issue", { team: "ENG", title: "x" });
    const body = JSON.stringify({ repository: { full_name: "a/b" }, pull_request: { number: 3, html_url: "https://github.com/a/b/pull/3", title: "Fix ENG-1", state: "open", head: { ref: "x" } } });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("s3cret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = `sha256=${Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))).toString("hex")}`;
    const post = (s: string) => app.request("http://localhost/hooks/github", { method: "POST", body, headers: { "x-github-event": "pull_request", "x-hub-signature-256": s } });
    expect((await post("sha256=00")).status).toBe(401);
    expect(((await (await post(sig)).json()) as any).linked).toBe(1);
    expect((await w.agent("get_issue", { id: "ENG-1" })).pullRequests[0].url).toBe("https://github.com/a/b/pull/3");
  });
});

test("openapi lists every op", async () => {
  const { app } = await setup();
  const doc = (await (await app.request("http://localhost/openapi.json")).json()) as any;
  expect(Object.keys(doc.paths)).toContain("/api/save_issue");
});

describe("oauth", () => {
  const CB = "https://claude.ai/api/mcp/auth_callback";
  const VERIFIER = "verifier-0123456789-abcdefghijklmnopqrstuvwxyz";
  const challengeOf = async (v: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))).toString("base64url");
  const form = (o: Record<string, string>) => ({ body: new URLSearchParams(o).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const authorizeUrl = async (clientId: string, extra: Record<string, string> = {}) =>
    `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CB, code_challenge: await challengeOf(VERIFIER), code_challenge_method: "S256", state: "xyz", ...extra })}`;

  /** Register "Claude", open the approve page as the owner, approve; returns the client and the code. */
  async function connect(call: Awaited<ReturnType<typeof setup>>["call"], name = "Claude") {
    const reg = await call("/oauth/register", { json: { client_name: name, redirect_uris: [CB] } }, null);
    expect(reg.status).toBe(201);
    const clientId = ((await reg.json()) as any).client_id as string;
    const consent = await call(await authorizeUrl(clientId), {}, null);
    expect(consent.status).toBe(200);
    const nonce = (await consent.text()).match(/name="nonce" value="([^"]+)"/)![1]!;
    const ok = await call("/oauth/authorize", { ...form({ nonce, state: "xyz", decision: "approve" }), headers: { ...form({}).headers, origin: "http://localhost" } }, null);
    expect(ok.status).toBe(302);
    const back = new URL(ok.headers.get("location")!);
    expect([back.origin + back.pathname, back.searchParams.get("state")]).toEqual([CB, "xyz"]);
    return { clientId, code: back.searchParams.get("code")!, nonce };
  }
  const exchange = (call: Awaited<ReturnType<typeof setup>>["call"], p: Record<string, string>) => call("/oauth/token", form(p), null);

  test("metadata, and a 401 from /mcp points at it", async () => {
    const { app, call } = await setup();
    const res = (await (await call("/.well-known/oauth-protected-resource", {}, null)).json()) as any;
    expect(res).toMatchObject({ resource: "http://localhost/mcp", authorization_servers: ["http://localhost"] });
    expect((await call("/.well-known/oauth-protected-resource/mcp", {}, null)).status).toBe(200);
    const as = (await (await call("/.well-known/oauth-authorization-server", {}, null)).json()) as any;
    expect(as).toMatchObject({ issuer: "http://localhost", token_endpoint: "http://localhost/oauth/token", registration_endpoint: "http://localhost/oauth/register", code_challenge_methods_supported: ["S256"] });
    expect((await call("/.well-known/openid-configuration", {}, null)).status).toBe(404);
    const denied = await app.request("https://logbook.example/mcp", { method: "POST" });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://logbook.example/.well-known/oauth-protected-resource"');
  });

  test("register, approve as the owner, call /mcp as agent claude, refresh rotates, revoke ends it", async () => {
    const { w, call } = await setup();
    expect((await call("/oauth/register", { json: { client_name: "Evil", redirect_uris: ["http://evil.example/cb"] } }, null)).status).toBe(400);
    expect((await call("/oauth/register", { json: { redirect_uris: ["http://127.0.0.1:3000/cb"] } }, null)).status).toBe(201);
    const { clientId, code } = await connect(call);
    const tok = (await (await exchange(call, { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: CB, code_verifier: VERIFIER })).json()) as any;
    expect(tok).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    const me = (await (await call("/api/me", { json: {} }, tok.access_token)).json()) as any;
    expect([me.kind, me.name]).toEqual(["agent", "claude"]);
    const made = (await (await call("/mcp", { json: rpc(1, "tools/call", { name: "save_issue", arguments: { team: "ENG", title: "via oauth" } }) }, tok.access_token)).json()) as any;
    expect(made.result.structuredContent.id).toBe("ENG-1");
    expect(((await (await exchange(call, { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: CB, code_verifier: VERIFIER })).json()) as any).error).toBe("invalid_grant");

    const next = (await (await exchange(call, { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: clientId })).json()) as any;
    expect(next.refresh_token).not.toBe(tok.refresh_token);
    expect((await call("/api/me", { json: {} }, tok.access_token)).status).toBe(401);
    expect((await call("/api/me", { json: {} }, next.access_token)).status).toBe(200);
    expect(((await (await exchange(call, { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: clientId })).json()) as any).error).toBe("invalid_grant");

    const { tokens } = await w.captain("list_tokens");
    const grant = tokens.find((t: any) => t.name === "Claude (OAuth)");
    expect(tokens.filter((t: any) => t.name === "Claude (OAuth)").length).toBe(1);
    await w.captain("revoke_token", { id: grant.id });
    expect((await call("/api/me", { json: {} }, next.access_token)).status).toBe(401);
    expect(((await (await exchange(call, { grant_type: "refresh_token", refresh_token: next.refresh_token, client_id: clientId })).json()) as any).error).toBe("invalid_grant");
  });

  test("an expired access token is refused, and its refresh token still renews it", async () => {
    const { w, call } = await setup();
    const { clientId, code } = await connect(call);
    const tok = (await (await exchange(call, { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: CB, code_verifier: VERIFIER })).json()) as any;
    await w.db.batch([q("UPDATE tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE client_id = ?", clientId)]);
    expect((await call("/api/me", { json: {} }, tok.access_token)).status).toBe(401);
    const next = (await (await exchange(call, { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: clientId })).json()) as any;
    expect((await call("/api/me", { json: {} }, next.access_token)).status).toBe(200);
  });

  test("a wrong verifier burns the code; a wrong redirect_uri or client is refused", async () => {
    const { call } = await setup();
    let { clientId, code } = await connect(call);
    const bad = await exchange(call, { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: CB, code_verifier: "x".repeat(43) });
    expect([bad.status, ((await bad.json()) as any).error]).toEqual([400, "invalid_grant"]);
    expect(((await (await exchange(call, { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: CB, code_verifier: VERIFIER })).json()) as any).error).toBe("invalid_grant");

    ({ clientId, code } = await connect(call));
    expect(((await (await exchange(call, { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: "https://claude.com/api/mcp/auth_callback", code_verifier: VERIFIER })).json()) as any).error).toBe("invalid_grant");

    ({ code } = await connect(call));
    const other = await connect(call, "Other");
    expect(((await (await exchange(call, { grant_type: "authorization_code", code, client_id: other.clientId, redirect_uri: CB, code_verifier: VERIFIER })).json()) as any).error).toBe("invalid_grant");
    expect((await exchange(call, { grant_type: "authorization_code", code, client_id: "nope", redirect_uri: CB, code_verifier: VERIFIER })).status).toBe(401);
  });

  test("authorize refuses unknown return addresses, missing PKCE, non-owners and cross-site approvals", async () => {
    const { w, call } = await setup();
    const clientId = ((await (await call("/oauth/register", { json: { client_name: "Claude", redirect_uris: [CB] } }, null)).json()) as any).client_id;
    const elsewhere = await call(await authorizeUrl(clientId, { redirect_uri: "https://evil.example/cb" }), {}, null);
    expect([elsewhere.status, elsewhere.headers.get("location")]).toEqual([400, null]);
    expect((await call(await authorizeUrl("nope"), {}, null)).status).toBe(400);
    for (const extra of [{ code_challenge: "" }, { code_challenge_method: "plain" }] as Record<string, string>[]) {
      const res = await call(await authorizeUrl(clientId, extra), {}, null);
      expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    }

    const remote = makeApp({ db: w.db, blobs: w.blobs, cfg: { DEV_AUTH: "1" }, isLocal: () => false });
    expect((await remote.request(`http://localhost${await authorizeUrl(clientId)}`)).status).toBe(401);
    expect((await call(await authorizeUrl(clientId))).status).toBe(403); // an agent's bearer token cannot approve

    const nonce = (await (await call(await authorizeUrl(clientId), {}, null)).text()).match(/name="nonce" value="([^"]+)"/)![1]!;
    const approve = form({ nonce, state: "xyz", decision: "approve" });
    expect((await call("/oauth/authorize", approve, null)).status).toBe(403);
    expect((await call("/oauth/authorize", { ...approve, headers: { ...approve.headers, origin: "https://evil.example" } }, null)).status).toBe(403);
    expect((await call("/oauth/authorize", { ...approve, headers: { ...approve.headers, origin: "http://localhost" } })).status).toBe(403);
    const deny = await call("/oauth/authorize", { ...form({ nonce, state: "xyz", decision: "deny" }), headers: { ...approve.headers, origin: "http://localhost" } }, null);
    expect(new URL(deny.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
    expect((await call("/oauth/authorize", { ...approve, headers: { ...approve.headers, origin: "http://localhost" } }, null)).status).toBe(400);
  });
});
