#!/usr/bin/env bun
// Linear -> Logbook. Reads one Linear workspace over GraphQL and upserts it through import_rows, parents first.
// Rows keep their Linear ids, so running it again updates in place: a dry run and rehearsals first, the final
// import on flip day. Run once per workspace (one LINEAR_API_KEY each).
//
//   LINEAR_API_KEY=… LOGBOOK_URL=… LOGBOOK_TOKEN=<system token> bun import/linear.ts [options]
//     --dry-run            read Linear (and Logbook, when LOGBOOK_URL is set) and print the report; write nothing
//     --alias a@x=b@y      import Linear user a@x as Logbook user b@y (repeatable)
//     --team-key OLD=NEW   import a team under another key when OLD is taken (repeatable)
//     --sample N           issues whose comments are compared after the import (default 50)
//
// Mapping: Linear releases become releases; version labels ("Versie/v1.2.0") do too, but only in a workspace without
// Linear releases (where they are the only record of what shipped; elsewhere they are roadmap targets). Labels are
// always kept. Projects become
// children of the single-choice "Project" label group; open issues labelled "Captain beslist" / "Captain look"
// become open decide / review decisions; Linear-hosted files are copied in (cached under import/out/) and links to
// them, to Linear issues and to Linear documents are rewritten. Whatever does not map is listed under "problems".
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { type Call, client } from "../cli/client";

const { values: opt } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    alias: { type: "string", multiple: true, default: [] },
    "team-key": { type: "string", multiple: true, default: [] },
    sample: { type: "string", default: "50" },
  },
});
const pairs = (list: string[]) => new Map(list.map((p) => p.split("=", 2) as [string, string]));
const alias = new Map([...pairs(opt.alias)].map(([a, b]) => [a.toLowerCase(), b.toLowerCase()]));
const teamKeys = pairs(opt["team-key"]);
const dry = opt["dry-run"];
const KEY = process.env.LINEAR_API_KEY;
if (!KEY) throw new Error("Set LINEAR_API_KEY");

type Row = Record<string, unknown>;
type Ref = { id: string } | null;
const problems: string[] = [];
const ids = (r: Ref) => r?.id ?? null;
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);
const DONE = new Set(["completed", "canceled", "duplicate"]);

// ---- Linear ----

async function gql<T = any>(query: string, variables: object = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { authorization: KEY!, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json().catch(() => null)) as any;
    const limited = res.status === 429 || body?.errors?.some((e: any) => e.extensions?.code === "RATELIMITED");
    if ((limited || res.status >= 500) && attempt < 5) {
      await Bun.sleep(2000 * 2 ** attempt);
      continue;
    }
    if (!res.ok || body?.errors) throw new Error(`Linear: ${JSON.stringify(body?.errors ?? res.status)}`);
    return body.data;
  }
}

async function all<T = any>(field: string, nodes: string, args = "includeArchived: true"): Promise<T[]> {
  const out: T[] = [];
  let after: string | null = null;
  do {
    const data: any = await gql(
      `query($after: String) { ${field}(first: 100, after: $after, ${args}) { pageInfo { hasNextPage endCursor } nodes { ${nodes} } } }`,
      { after },
    );
    out.push(...data[field].nodes);
    after = data[field].pageInfo.hasNextPage ? data[field].pageInfo.endCursor : null;
  } while (after);
  return out;
}

const STAMPS = "createdAt updatedAt archivedAt";
console.error("Reading Linear…");
const { organization: org } = await gql(`{ organization { name urlKey } }`);
const L = {
  users: await all("users", `id name email active ${STAMPS}`, "includeArchived: true, includeDisabled: true"),
  teams: await all("teams", `id key name ${STAMPS}`),
  states: await all("workflowStates", `id name type color position team { id } ${STAMPS}`),
  labels: await all("issueLabels", `id name color description isGroup parent { id } team { id } ${STAMPS}`),
  projects: await all("projects", `id name color description ${STAMPS}`),
  docs: await all("documents", `id title content slugId creator { id } ${STAMPS}`),
  releases: await all("releases", `id version createdAt updatedAt completedAt pipeline { name } stage { type }`),
  issues: await all(
    "issues",
    `id number title description priority sortOrder labelIds team { id } state { id type } assignee { id } creator { id } parent { id }
     project { id } releases(first: 20) { nodes { id } } startedAt completedAt canceledAt ${STAMPS}`,
  ),
  relations: await all("issueRelations", "type issue { id } relatedIssue { id }"),
  comments: await all("comments", `id body issue { id } user { id } botActor { name } ${STAMPS}`),
  attachments: await all("attachments", `id title url issue { id } creator { id } ${STAMPS}`),
};

// ---- what Logbook already has (merges and clashes) ----

let call: Call | null = null;
try {
  call = client();
} catch (e) {
  if (!dry) throw e;
}
const have = call
  ? {
      users: (await call("list_users")).users as Row[],
      teams: (await call("list_teams", { includeArchived: true })).teams as Row[],
      labels: (await call("list_issue_labels", { includeGroups: true, includeArchived: true, limit: 250 })).labels as Row[],
    }
  : { users: [], teams: [], labels: [] };

// ---- actors ----

const actorOf = new Map<string, string>();
const actorName = new Map<string, string>(have.users.map((u) => [u.id as string, u.name as string]));
const takenNames = new Set(have.users.map((u) => (u.name as string).toLowerCase()));
const byEmail = new Map(have.users.filter((u) => u.email).map((u) => [(u.email as string).toLowerCase(), u]));
const actorRows: Row[] = [];
const stamps = (x: any) => ({ created_at: x.createdAt, updated_at: x.updatedAt ?? x.createdAt, archived_at: x.archivedAt ?? null });

function addActor(id: string, kind: string, name: string, email: string | null, x: any) {
  const hit = (email && byEmail.get(email)) || have.users.find((u) => email === null && u.kind === kind && (u.name as string).toLowerCase() === name.toLowerCase());
  if (hit) return actorOf.set(id, hit.id as string);
  if (takenNames.has(name.toLowerCase())) name = `${name} (${email ?? kind})`;
  takenNames.add(name.toLowerCase());
  actorOf.set(id, id);
  actorName.set(id, name);
  actorRows.push({ id, kind, name, email, ...stamps(x) });
}
for (const u of L.users) {
  const bot = /@linear\.linear\.app$/i.test(u.email ?? "");
  const email = bot ? null : (alias.get(u.email.toLowerCase()) ?? u.email.toLowerCase());
  addActor(u.id, bot ? "system" : "human", u.name, email, { ...u, archivedAt: u.archivedAt ?? (u.active ? null : u.updatedAt) });
}
const actor = (r: Ref) => (r ? (actorOf.get(r.id) ?? (problems.push(`Unknown Linear user ${r.id}; left empty`), null)) : null);
const botActor = (name: string, at: any) => {
  const id = `bot-${hash(name)}`;
  if (!actorOf.has(id)) addActor(id, "system", `${name} (bot)`, null, at);
  return actorOf.get(id)!;
};

// ---- teams, states ----

const teamRows: Row[] = [];
const teamKey = new Map<string, string>();
for (const t of L.teams) {
  const key = teamKeys.get(t.key) ?? t.key;
  const clash = have.teams.find((x) => x.key === key && x.id !== t.id);
  if (clash) problems.push(`FATAL: team key ${key} is taken by "${clash.name}"; rerun with --team-key ${t.key}=<NEW>`);
  teamKey.set(t.id, key);
  teamRows.push({ id: t.id, key, name: t.name, ...stamps(t) });
}
const stateRows = L.states.map((s) => ({ id: s.id, team_id: s.team.id, name: s.name, type: s.type, color: s.color, position: s.position, ...stamps(s) }));
const stateName = new Map(L.states.map((s) => [s.id, s.name]));

// ---- labels and projects ----

const labelOf = new Map<string, string>();
const labelName = new Map<string, string>();
const wsLabel = (name: string, parent: string | null) =>
  have.labels.find((l) => l.team === null && (l.name as string).toLowerCase() === name.toLowerCase() && (l.parent ?? null) === parent);
const issuesByLabel = new Map<string, any[]>();
for (const i of L.issues) for (const l of i.labelIds) issuesByLabel.set(l, [...(issuesByLabel.get(l) ?? []), i]);
const labelRows: Row[] = [];
const linearLabel = new Map(L.labels.map((l) => [l.id, l]));
for (const l of [...L.labels].sort((a, b) => Number(b.isGroup) - Number(a.isGroup))) {
  const parent = l.parent ? linearLabel.get(l.parent.id) : null;
  const merged = !l.team && wsLabel(l.name, parent?.name ?? null);
  labelOf.set(l.id, merged ? (merged.id as string) : l.id);
  labelName.set(l.id, l.name);
  if (merged) continue;
  // Linear lets an issue carry one label per group; keep that unless the data says otherwise.
  const children = L.labels.filter((c) => c.parent?.id === l.id).map((c) => c.id);
  const multi = l.isGroup && L.issues.some((i) => i.labelIds.filter((x: string) => children.includes(x)).length > 1);
  if (multi) problems.push(`Label group ${l.name} has issues with two of its labels; imported as multi-choice`);
  labelRows.push({
    id: l.id, team_id: ids(l.team), parent_id: parent ? labelOf.get(parent.id) : null, name: l.name, color: l.color, description: l.description,
    is_group: l.isGroup ? 1 : 0, exclusive: l.isGroup && !multi ? 1 : 0, ...stamps(l),
  });
}
const projectGroup = (wsLabel("Project", null)?.id as string | undefined) ?? "project-group";
if (L.projects.length && !wsLabel("Project", null)) {
  const at = L.projects[0];
  labelRows.push({ id: projectGroup, team_id: null, parent_id: null, name: "Project", is_group: 1, exclusive: 1, ...stamps({ ...at, archivedAt: null }) });
}
for (const p of L.projects) {
  const merged = wsLabel(p.name, "Project");
  labelOf.set(p.id, merged ? (merged.id as string) : p.id);
  labelName.set(p.id, p.name);
  if (!merged) labelRows.push({ id: p.id, team_id: null, parent_id: projectGroup, name: p.name, color: p.color, description: p.description, is_group: 0, exclusive: 0, ...stamps(p) });
}

// ---- releases ----
// A version released in a production pipeline is live. A staging-only version went live with the first production
// release at or above it; anything newer than the last production release is still on staging. Each issue gets the
// earliest version it shipped in.

const ver = (v: string) => v.replace(/^v/i, "").split(/[^0-9]+/).map(Number);
const cmpVer = (a: string, b: string) => {
  const [x, y] = [ver(a), ver(b)];
  for (let k = 0; k < Math.max(x.length, y.length); k++) if ((x[k] ?? 0) !== (y[k] ?? 0)) return (x[k] ?? 0) - (y[k] ?? 0);
  return 0;
};
const relById = new Map(L.releases.map((r) => [r.id, r]));
const prod = L.releases.filter((r) => /prod/i.test(r.pipeline?.name ?? "") && r.stage?.type === "completed").sort((a, b) => cmpVer(a.version, b.version));
const releaseRows = new Map<string, Row>();
const releaseVersion = new Map<string, string>();
function release(version: string, teamId: string, at: any, status: string, deployedAt: string | null) {
  const k = `${teamId}|${version}`;
  if (!releaseRows.has(k)) {
    const id = `rel-${hash(k)}`;
    releaseRows.set(k, { id, team_id: teamId, version, status, deployed_at: deployedAt, created_at: at.createdAt, updated_at: at.updatedAt ?? at.createdAt });
    releaseVersion.set(id, version);
  }
  return releaseRows.get(k)!.id as string;
}
function nativeRelease(r: any, teamId: string) {
  const live = prod.find((p) => cmpVer(p.version, r.version) >= 0);
  const done = L.releases.filter((x) => x.version === r.version && x.stage?.type === "completed");
  const status = live ? "live" : done.length ? "staging" : r.stage?.type === "canceled" ? "rolled_back" : "planned";
  return release(r.version, teamId, r, status, live?.completedAt ?? null);
}
const versionGroup = new Set(L.releases.length ? [] : L.labels.filter((l) => l.isGroup && /^vers(ie|ion)s?$/i.test(l.name)).map((l) => l.id));
function labelRelease(l: any, teamId: string) {
  const tagged = issuesByLabel.get(l.id) ?? [];
  const shipped = tagged.length > 0 && tagged.every((i) => DONE.has(i.state.type));
  const deployed = shipped ? (tagged.map((i) => i.completedAt).filter(Boolean).sort().at(-1) ?? null) : null;
  return release(l.name, teamId, l, shipped ? "live" : "planned", deployed);
}

// ---- files (Linear-hosted uploads) ----

const UPLOAD = /https:\/\/uploads\.linear\.app\/[^\s)\]"'<>]+/g;
type File = { id: string; src: string; name: string; owner: Row; ok?: boolean; mime?: string | null };
const files = new Map<string, File>();
const fileFor = (src: string, owner: Row, id = `lf-${hash(src)}`) => {
  if (!files.has(src)) files.set(src, { id, src, name: decodeURIComponent(src.split(/[?#]/)[0]!.split("/").pop() || "file"), owner });
  return files.get(src)!;
};
for (const a of L.attachments) if (a.issue && /^https:\/\/uploads\.linear\.app\//.test(a.url)) fileFor(a.url, { issue_id: a.issue.id, author_id: actor(a.creator), ...stamps(a) }, a.id);
const scan = (text: string | null, owner: Row) => { for (const m of text?.match(UPLOAD) ?? []) fileFor(m, owner); };
for (const i of L.issues) scan(i.description, { issue_id: i.id, author_id: actor(i.creator), ...stamps(i) });
for (const c of L.comments) if (c.issue) scan(c.body, { issue_id: c.issue.id, author_id: actor(c.user), ...stamps(c) });
for (const d of L.docs) scan(d.content, { doc_id: d.id, author_id: actor(d.creator), ...stamps(d) });

const cache = `import/out/${org.urlKey}/files`;
const MAX = 25 * 1024 * 1024;
if (!dry) {
  await mkdir(cache, { recursive: true });
  const queue = [...files.values()];
  console.error(`Copying ${queue.length} Linear files…`);
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        const path = `${cache}/${f.id}`;
        const meta = Bun.file(`${path}.json`);
        // A cached refusal is reported again, so every run lists every file left on Linear.
        let why: string | undefined;
        if (await meta.exists()) ({ ok: f.ok, mime: f.mime, why } = await meta.json());
        else {
          const res = await fetch(f.src, { headers: { authorization: KEY! } }).catch(() => null);
          const bytes = res?.ok ? await res.arrayBuffer() : null;
          f.ok = !!bytes && bytes.byteLength <= MAX;
          f.mime = res?.headers.get("content-type")?.split(";")[0] ?? null;
          why = f.ok ? undefined : bytes ? `over 25 MB: ${bytes.byteLength} bytes` : `HTTP ${res?.status ?? "error"}`;
          if (f.ok) await Bun.write(path, bytes!);
          if (bytes) await Bun.write(`${path}.json`, JSON.stringify({ ok: f.ok, mime: f.mime, why }));
        }
        if (!f.ok) problems.push(`File not copied (${why ?? "over 25 MB"}), link left pointing at Linear: ${f.src}`);
      }
    }),
  );
}

// ---- markdown: files, issue links and doc links point into Logbook ----

const identOf = new Map(L.issues.map((i) => [i.id, `${teamKey.get(i.team.id)}-${i.number}`]));
const docBySlug = new Map(L.docs.map((d) => [d.slugId, d.id]));
const oldKeys = new Map(L.teams.map((t) => [t.key, teamKey.get(t.id)!]));
const issueLink = new RegExp(`https://linear\\.app/${org.urlKey}/issue/([A-Z][A-Z0-9]*)-(\\d+)(?:/[\\w-]*)?`, "g");
const docLink = new RegExp(`https://linear\\.app/${org.urlKey}/document/(?:[\\w-]*-)?([0-9a-f]+)\\b`, "g");
const rewrite = (text: string | null) =>
  (text ?? "")
    .replace(UPLOAD, (u) => (files.get(u)?.ok ? `/files/${files.get(u)!.id}` : u))
    .replace(issueLink, (u, k, n) => (oldKeys.has(k) ? `/issue/${oldKeys.get(k)}-${n}` : u))
    .replace(docLink, (u, slug) => (docBySlug.has(slug) ? `/doc/${docBySlug.get(slug)}` : u));

// ---- rows ----

const docRows = L.docs.map((d) => ({ id: d.id, team_id: null, title: d.title, body: rewrite(d.content), author_id: actor(d.creator), ...stamps(d) }));
const dupOf = new Map(L.relations.filter((r) => r.type === "duplicate").map((r) => [r.issue.id, r.relatedIssue.id]));
const onlyTeam = L.teams.length === 1 ? L.teams[0].id : null;
const issueRows = L.issues.map((i) => {
  const native = i.releases.nodes.map((r: Ref) => relById.get(r!.id)).filter(Boolean).sort((a: any, b: any) => cmpVer(a.version, b.version));
  const versionLabels = i.labelIds.map((id: string) => linearLabel.get(id)).filter((l: any) => l?.parent && versionGroup.has(l.parent.id));
  if (versionLabels.length > 1) problems.push(`${identOf.get(i.id)} has ${versionLabels.length} version labels; release set from the first`);
  const release_id = native.length ? nativeRelease(native[0], i.team.id) : versionLabels.length ? labelRelease(versionLabels[0], i.team.id) : null;
  return {
    id: i.id, team_id: i.team.id, number: i.number, title: i.title, description: rewrite(i.description), state_id: i.state.id, priority: i.priority,
    assignee_id: actor(i.assignee), creator_id: actor(i.creator), parent_id: ids(i.parent), release_id, duplicate_of_id: dupOf.get(i.id) ?? null,
    sort_order: i.sortOrder, started_at: i.startedAt, completed_at: i.completedAt, canceled_at: i.canceledAt, ...stamps(i),
    label_ids: [...new Set([...i.labelIds.map((l: string) => labelOf.get(l) ?? l), ...(i.project ? [labelOf.get(i.project.id)!] : [])])],
  };
});
// Releases nobody is attached to still show up (single-team workspaces only: there is no issue to take the team from).
for (const r of L.releases) if (onlyTeam) nativeRelease(r, onlyTeam);
for (const l of L.labels) if (onlyTeam && l.parent && versionGroup.has(l.parent.id)) labelRelease(l, onlyTeam);
if (!onlyTeam && L.releases.length) problems.push("Releases without issues are skipped in a multi-team workspace");

const issueIds = new Set(L.issues.map((i) => i.id));
const commentRows: Row[] = [];
let skippedComments = 0;
for (const c of L.comments) {
  if (!c.issue || !issueIds.has(c.issue.id)) {
    skippedComments++;
    continue;
  }
  const author_id = c.user ? actor(c.user) : c.botActor?.name ? botActor(c.botActor.name, c) : null;
  commentRows.push({ id: c.id, issue_id: c.issue.id, author_id, body: rewrite(c.body), ...stamps(c) });
}
if (skippedComments) problems.push(`${skippedComments} comments are not on an imported issue (project or document comments); skipped`);

const attachmentRows: Row[] = [];
for (const a of L.attachments) {
  const copied = files.get(a.url);
  if (!a.issue || !issueIds.has(a.issue.id) || (copied?.id === a.id && (dry || copied?.ok))) continue;
  const url = rewrite(a.url);
  if (!/^(https?:\/\/|\/(files|doc|issue)\/)/.test(url)) {
    problems.push(`Attachment link is not http(s), skipped: ${a.url}`);
    continue;
  }
  attachmentRows.push({ id: a.id, issue_id: a.issue.id, url, name: a.title || url, author_id: actor(a.creator), ...stamps(a) });
}
const fileRows = [...files.values()].filter((f) => dry || f.ok).map((f) => ({ id: f.id, url: null, name: f.name.slice(0, 200), mime: f.mime ?? null, ...f.owner, src: f.src }));

const flag = (name: string) => L.labels.filter((l) => l.name.toLowerCase() === name).map((l) => l.id);
const [decide, review] = [flag("captain beslist"), flag("captain look")];
const decisionRows = L.issues
  .filter((i) => !i.archivedAt && !DONE.has(i.state.type))
  .flatMap((i) =>
    ([["decide", decide], ["review", review]] as const)
      .filter(([, labels]) => i.labelIds.some((l: string) => labels.includes(l)))
      .map(([kind]) => ({
        id: `dec-${hash(`${i.id}|${kind}`)}`, team_id: i.team.id, issue_id: i.id, kind, question: i.title, options: "[]",
        asked_by_id: actor(i.creator), status: "open", created_at: i.createdAt, updated_at: i.updatedAt,
      })),
  );

// ---- report ----

const count = <T>(xs: T[], key: (x: T) => string) => Object.entries(xs.reduce<Record<string, number>>((m, x) => ((m[key(x)] = (m[key(x)] ?? 0) + 1), m), {}));
const rels = [...releaseRows.values()];
console.log(`# ${org.name} (${org.urlKey})${dry ? " — dry run, nothing written" : ""}\n`);
for (const t of teamRows) {
  const mine = issueRows.filter((i) => i.team_id === t.id);
  console.log(`## ${t.key} ${t.name}: ${mine.length} issues (${mine.filter((i) => i.archived_at).length} archived)`);
  console.log(`  states:   ${count(mine, (i) => stateName.get(i.state_id)!).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  console.log(`  releases: ${rels.filter((r) => r.team_id === t.id).length} (${count(rels.filter((r) => r.team_id === t.id), (r) => r.status as string).map(([k, n]) => `${k} ${n}`).join(", ")})`);
  const lab = count(mine.flatMap((i) => i.label_ids), (l) => [...labelOf].find(([, v]) => v === l)?.[0] ?? l).map(([id, n]) => `${labelName.get(id) ?? id} ${n}`);
  console.log(`  labels:   ${lab.join(", ")}`);
}
const live = rels.filter((r) => r.status === "live").sort((a, b) => String(a.deployed_at).localeCompare(String(b.deployed_at)) || cmpVer(a.version as string, b.version as string)).at(-1);
console.log(`\nactors ${actorRows.length} new (${actorRows.map((a) => `${a.name} <${a.email ?? a.kind}>`).join(", ") || "none"}), ${actorOf.size - actorRows.length} matched`);
console.log(`labels ${labelRows.filter((r) => !have.labels.some((l) => l.id === r.id)).length} new, ${[...labelOf].filter(([k, v]) => k !== v).length} merged into existing; projects ${L.projects.length}`);
console.log(`docs ${docRows.length}, comments ${commentRows.length}, link attachments ${attachmentRows.length}, files ${fileRows.length}`);
console.log(`releases ${rels.length}, latest live ${live?.version ?? "none"}; decisions ${decisionRows.length} open (${decisionRows.filter((d) => d.kind === "decide").length} decide, ${decisionRows.filter((d) => d.kind === "review").length} review)`);
console.log(`\nproblems (${problems.length}):${problems.length ? "" : " none"}`);
for (const p of [...new Set(problems)]) console.log(`  - ${p}`);
if (problems.some((p) => p.startsWith("FATAL"))) process.exit(1);
if (dry) process.exit(0);

// ---- write, parents first ----

async function send(entity: string, rows: Row[]) {
  let batch: Row[] = [];
  let size = 0;
  const flush = async () => {
    if (batch.length) await call!("import_rows", { entity, rows: batch });
    batch = [];
    size = 0;
  };
  for (const raw of rows) {
    const { src, ...row } = raw as Row & { src?: string };
    if (src) row.content = Buffer.from(await Bun.file(`${cache}/${row.id}`).arrayBuffer()).toString("base64");
    const n = JSON.stringify(row).length;
    if (batch.length === 100 || (batch.length && size + n > 8_000_000)) await flush();
    batch.push(row);
    size += n;
  }
  await flush();
  console.error(`  ${entity}: ${rows.length}`);
}
console.error("Writing…");
await send("actor", actorRows);
await send("team", teamRows);
await send("state", stateRows);
await send("label", labelRows);
await send("doc", docRows);
await send("release", [...releaseRows.values()]);
await send("issue", issueRows);
await send("comment", commentRows);
await send("attachment", [...attachmentRows, ...fileRows]);
await send("decision", decisionRows);

// ---- reconcile: every issue field by field, comments on a sample ----

const want = new Map(
  issueRows.map((i) => [
    identOf.get(i.id)!,
    {
      title: i.title, description: i.description, status: stateName.get(i.state_id), priority: i.priority, assignee: i.assignee_id ? actorName.get(i.assignee_id) : null,
      labels: i.label_ids.map((l) => labelName.get([...labelOf].find(([, v]) => v === l)?.[0] ?? l) ?? l).sort(), parentId: i.parent_id ? (identOf.get(i.parent_id) ?? null) : null,
      release: i.release_id ? releaseVersion.get(i.release_id) : null, archived: !!i.archived_at,
    },
  ]),
);
const got = new Map<string, any>();
for (const t of teamRows) {
  let cursor: string | null = null;
  do {
    const page: any = await call!("list_issues", { team: t.key, includeArchived: true, limit: 250, cursor: cursor ?? undefined });
    for (const i of page.issues) {
      got.set(i.id, {
        title: i.title, description: i.description, status: i.status, priority: i.priority.value, assignee: i.assignee,
        labels: [...i.labels].sort(), parentId: i.parentId, release: i.release, archived: !!i.archivedAt,
      });
    }
    cursor = page.cursor;
  } while (cursor);
}
const diffs: string[] = [];
for (const [ident, w] of want) {
  const g = got.get(ident);
  if (!g) diffs.push(`${ident}: missing in Logbook`);
  else for (const k of Object.keys(w) as (keyof typeof w)[]) if (JSON.stringify(w[k]) !== JSON.stringify(g[k])) diffs.push(`${ident} ${k}: Linear ${JSON.stringify(w[k])?.slice(0, 80)} vs Logbook ${JSON.stringify(g[k])?.slice(0, 80)}`);
}
for (const ident of got.keys()) if (!want.has(ident)) diffs.push(`${ident}: in Logbook, not in Linear`);
const sample = [...want.keys()].sort(() => Math.random() - 0.5).slice(0, Number(opt.sample));
for (const ident of sample) {
  const uuid = L.issues.find((i) => identOf.get(i.id) === ident)!.id;
  const expected = commentRows.filter((c) => c.issue_id === uuid && !c.archived_at).map((c) => c.body);
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page: any = await call!("list_comments", { issueId: ident, limit: 250, cursor: cursor ?? undefined });
    seen.push(...page.comments.map((c: any) => c.body));
    cursor = page.cursor;
  } while (cursor);
  if (JSON.stringify(expected.sort()) !== JSON.stringify(seen.sort())) diffs.push(`${ident} comments: Linear ${expected.length} vs Logbook ${seen.length}`);
}
console.log(`\n## Reconciliation: ${want.size} issues compared field by field, comments on ${sample.length} sampled issues`);
console.log(diffs.length ? diffs.slice(0, 50).map((d) => `  - ${d}`).join("\n") + (diffs.length > 50 ? `\n  … ${diffs.length - 50} more` : "") : "  all match");
process.exit(diffs.length ? 1 : 0);
