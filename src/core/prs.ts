// Pull request links. A PR never changes an issue's state: only a release going live does (src/core/workflow.ts).
import { z } from "zod";
import { q, type Stmt } from "../db/db";
import { type Ctx, uid } from "./ctx";
import { logChange } from "./log";
import { httpUrl, op } from "./registry";
import * as R from "./resolve";

export type PrState = "draft" | "open" | "merged" | "closed";
export type Pr = { provider: "origin" | "github"; repo: string; number: number; url: string; title: string; state: PrState; text: string };
type Link = Omit<Pr, "text"> & { issueId: string };

/** Issue keys like ENG-12 (any case, so branch names count). */
export const issueKeys = (text: string) => [...new Set([...text.matchAll(/\b([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,7})\b/g)].map((m) => `${m[1]!.toUpperCase()}-${Number(m[2])}`))];

/** Inserts new links and updates changed ones; unchanged links write nothing. */
export async function upsertLinks(ctx: Ctx, links: Link[]) {
  links = links.filter((l) => /^https?:\/\//i.test(l.url));
  if (!links.length) return 0;
  const existing = await ctx.db.all<Record<string, unknown>>(
    q("SELECT * FROM pr_links WHERE issue_id IN (SELECT value FROM json_each(?))", JSON.stringify([...new Set(links.map((l) => l.issueId))])),
  );
  const byKey = new Map(existing.map((e) => [`${e.issue_id}|${e.provider}|${e.repo}|${e.number}`, e]));
  const stmts: Stmt[] = [];
  for (const l of links) {
    const e = byKey.get(`${l.issueId}|${l.provider}|${l.repo}|${l.number}`);
    if (!e) {
      const id = uid();
      stmts.push(
        q("INSERT INTO pr_links (id, issue_id, provider, repo, number, url, title, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          id, l.issueId, l.provider, l.repo, l.number, l.url, l.title, l.state, ctx.now, ctx.now),
        logChange(ctx, "pr_link", id, "create"),
      );
    } else if (e.state !== l.state || e.title !== l.title || e.url !== l.url) {
      stmts.push(
        q("UPDATE pr_links SET state = ?, title = ?, url = ?, updated_at = ? WHERE id = ?", l.state, l.title, l.url, ctx.now, e.id),
        logChange(ctx, "pr_link", e.id as string, "update"),
      );
    }
  }
  if (stmts.length) await ctx.db.batch(stmts);
  return stmts.length / 2;
}

/** Links each PR to every existing issue its title, body or branch names. */
export async function syncPrs(ctx: Ctx, prs: Pr[]) {
  const wanted = prs.map((p) => ({ p, keys: issueKeys(p.text) }));
  const all = [...new Set(wanted.flatMap((w) => w.keys))];
  if (!all.length) return 0;
  const found = await ctx.db.all<{ id: string; ident: string }>(
    q("SELECT i.id, upper(t.key) || '-' || i.number AS ident FROM issues i JOIN teams t ON t.id = i.team_id WHERE upper(t.key) || '-' || i.number IN (SELECT value FROM json_each(?))", JSON.stringify(all)),
  );
  const ids = new Map(found.map((f) => [f.ident, f.id]));
  return upsertLinks(ctx, wanted.flatMap(({ p, keys }) => keys.filter((k) => ids.has(k)).map((k) => ({ ...p, text: undefined, issueId: ids.get(k)! }))));
}

/** Origin has no webhooks: the cron (Worker) or a timer (self-host) polls each repo's latest PRs.
 *  `repos` is org/name entries, or "*" for every repo the key can see that was pushed in the last day.
 *  Origin refuses a Cursor API key itself; like the origin CLI, each poll exchanges it for a short-lived access token. */
export async function pollOrigin(ctx: Ctx, repos: string[], apiKey: string, fetcher: typeof fetch = fetch) {
  const ex = await fetcher("https://api2.cursor.sh/auth/exchange_user_api_key", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: "{}",
  });
  const token = ex.ok ? ((await ex.json()) as { accessToken?: string }).accessToken : undefined;
  if (!token) throw new Error(`Origin: exchanging the Cursor API key failed (HTTP ${ex.status})`);
  if (repos.includes("*")) repos = [...new Set([...repos.filter((r) => r !== "*"), ...(await activeOriginRepos(token, ctx.now, fetcher))])];
  let linked = 0;
  const failed: string[] = [];
  for (const repo of repos) {
    const res = await fetcher(`https://api.cursor.com/v1/origin/repos/${repo}/pulls?state=all&pageSize=50`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!res.ok) {
      failed.push(`${repo}: HTTP ${res.status}`);
      continue;
    }
    const body = (await res.json()) as { pullRequests?: Record<string, any>[] };
    const prs = (body.pullRequests ?? []).map(
      (p): Pr => ({
        provider: "origin",
        repo,
        number: Number(p.number),
        url: p.webUrl,
        title: p.title ?? "",
        state: p.merged ? "merged" : p.state === "closed" ? "closed" : p.draft ? "draft" : "open",
        text: `${p.title ?? ""}\n${p.body ?? ""}\n${p.head?.ref ?? ""}`,
      }),
    );
    linked += await syncPrs(ctx, prs);
  }
  if (failed.length) throw new Error(`Origin ${failed.join(", ")} (linked ${linked} from the rest)`);
  return linked;
}

/** Opening or merging a PR pushes, so a repo not pushed in the last day has nothing new.
 *  ponytail: a PR closed unmerged in a repo idle for a day is missed until that repo's next push. */
async function activeOriginRepos(token: string, now: string, fetcher: typeof fetch) {
  const call = async (method: string, body: object): Promise<any> => {
    const res = await fetcher(`https://api.origin.cursor.com/origin.v1.OriginService/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "connect-protocol-version": "1" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Origin ${method}: HTTP ${res.status}`);
    return res.json();
  };
  const since = Date.parse(now) - 86_400_000;
  const out: string[] = [];
  for (const n of (await call("GetAuthorizedNamespaces", {})).namespaces ?? []) {
    const namespace = n.namespace?.namespace;
    let pageToken = "";
    while (namespace) {
      const page = await call("ListHostedRepos", { namespace, pageToken });
      for (const r of page.repositories ?? []) if (Date.parse(r.lastPushedAt ?? "") >= since) out.push(`${r.org}/${r.name}`);
      pageToken = page.nextPageToken ?? "";
      if (!pageToken) break;
    }
  }
  return out;
}

/** A GitHub `pull_request` webhook payload (signature already checked by the caller). */
export function githubPr(payload: any): Pr | null {
  const p = payload?.pull_request;
  if (!p || !payload.repository?.full_name) return null;
  return {
    provider: "github",
    repo: payload.repository.full_name,
    number: p.number,
    url: p.html_url,
    title: p.title ?? "",
    state: p.merged ? "merged" : p.state === "closed" ? "closed" : p.draft ? "draft" : "open",
    text: `${p.title ?? ""}\n${p.body ?? ""}\n${p.head?.ref ?? ""}`,
  };
}

export const prOps = [
  op({
    name: "link_pr",
    description: "Link a pull request to an issue, or update its state. Merging a PR never closes the issue; the release going live does.",
    input: z.strictObject({
      issue: z.string().describe("Issue ID or identifier (e.g. ENG-123)"),
      provider: z.enum(["origin", "github"]),
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).describe("org/name"),
      number: z.number().int().positive(),
      url: httpUrl(),
      title: z.string().optional(),
      state: z.enum(["draft", "open", "merged", "closed"]),
    }),
    async run(ctx, inp) {
      const issue = await R.issue(ctx, inp.issue);
      const { issue: _, ...pr } = inp;
      await upsertLinks(ctx, [{ ...pr, title: pr.title ?? "", issueId: issue.id }]);
      return { issue: R.ident(issue), ...pr };
    },
  }),
];
