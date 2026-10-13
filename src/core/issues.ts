// Issues and comments: the Linear-MCP-shaped heart of the tracker.
import { z } from "zod";
import { first, q, type Stmt } from "../db/db";
import { type Ctx, Fail, PRIORITY, ftsQuery, since, uid } from "./ctx";
import { logChange } from "./log";
import { applyPatch, httpUrl, limit, markdown, op, patchOps } from "./registry";
import * as R from "./resolve";

const ISSUE_ROW = `SELECT i.*, t.key AS team_key, t.name AS team_name, s.name AS state_name, s.type AS state_type,
  a.name AS assignee_name, a.kind AS assignee_kind, c.name AS creator_name, c.kind AS creator_kind, pt.key || '-' || p.number AS parent_ident, dt.key || '-' || d.number AS dup_ident,
  r.version AS release_version,
  (SELECT count(*) FROM decisions dd WHERE dd.issue_id = i.id AND dd.status = 'open') AS open_decisions,
  (SELECT json_group_array(l.name) FROM issue_labels il JOIN labels l ON l.id = il.label_id WHERE il.issue_id = i.id) AS label_names,
  (SELECT l.name FROM issue_labels il JOIN labels l ON l.id = il.label_id JOIN labels g ON g.id = l.parent_id
    WHERE il.issue_id = i.id AND g.is_group = 1 AND g.name = 'Project' LIMIT 1) AS project_name
FROM issues i JOIN teams t ON t.id = i.team_id JOIN states s ON s.id = i.state_id
LEFT JOIN actors a ON a.id = i.assignee_id LEFT JOIN actors c ON c.id = i.creator_id
LEFT JOIN issues p ON p.id = i.parent_id LEFT JOIN teams pt ON pt.id = p.team_id
LEFT JOIN issues d ON d.id = i.duplicate_of_id LEFT JOIN teams dt ON dt.id = d.team_id
LEFT JOIN releases r ON r.id = i.release_id`;

type IssueRow = Record<string, unknown> & { id: string; team_key: string; number: number; title: string; label_names: string };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-$/, "");

export function shapeIssue(ctx: Ctx, r: IssueRow) {
  const id = `${r.team_key}-${r.number}`;
  return {
    id,
    uuid: r.id,
    title: r.title,
    description: r.description,
    priority: { value: r.priority as number, name: PRIORITY[r.priority as number] },
    url: `${ctx.baseUrl ?? ""}/issue/${id}`,
    gitBranchName: `${id.toLowerCase()}-${slug(r.title)}`,
    status: r.state_name,
    statusType: r.state_type,
    labels: JSON.parse(r.label_names) as string[],
    project: r.project_name ?? null,
    team: r.team_name,
    teamId: r.team_id,
    assignee: r.assignee_name ?? null,
    assigneeId: r.assignee_id ?? null,
    assigneeKind: r.assignee_kind ?? null,
    createdBy: r.creator_name ?? null,
    createdById: r.creator_id ?? null,
    createdByKind: r.creator_kind ?? null,
    parentId: r.parent_ident ?? null,
    duplicateOf: r.dup_ident ?? null,
    release: r.release_version ?? null,
    openDecisions: (r.open_decisions as number) ?? 0,
    dedupeKey: r.dedupe_key ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at ?? null,
    completedAt: r.completed_at ?? null,
    canceledAt: r.canceled_at ?? null,
    archivedAt: r.archived_at ?? null,
  };
}
export type Issue = ReturnType<typeof shapeIssue>;

export async function loadIssue(ctx: Ctx, id: string): Promise<Issue | null> {
  const r = await first<IssueRow>(ctx.db, q(`${ISSUE_ROW} WHERE i.id = ?`, id));
  return r && shapeIssue(ctx, r);
}

const FIELDS = [
  "id", "uuid", "title", "description", "priority", "url", "gitBranchName", "status", "statusType", "labels", "project", "team", "teamId",
  "assignee", "assigneeId", "assigneeKind", "createdBy", "createdById", "createdByKind", "parentId", "duplicateOf", "release", "openDecisions", "dedupeKey", "createdAt", "updatedAt",
  "startedAt", "completedAt", "canceledAt", "archivedAt",
] as const;
const fields = z.array(z.enum(FIELDS)).optional().describe("Fields to include in each result; `id` is always included. Omit for all");
const pick = <T extends Record<string, unknown>>(o: T, f?: readonly string[]) =>
  f?.length ? Object.fromEntries(Object.entries(o).filter(([k]) => k === "id" || f.includes(k))) : o;

/** Timestamps that follow a state change. */
function stateStamps(ctx: Ctx, from: string | null, to: string, startedAt: unknown) {
  const s: Record<string, string | null> = {};
  if (to === "started" && !startedAt) s.started_at = ctx.now;
  if (to === "completed" && from !== "completed") s.completed_at = ctx.now;
  if (to !== "completed" && from === "completed") s.completed_at = null;
  const canceled = (t: string | null) => t === "canceled" || t === "duplicate";
  if (canceled(to) && !canceled(from)) s.canceled_at = ctx.now;
  if (!canceled(to) && canceled(from)) s.canceled_at = null;
  return s;
}

export const commentStmts = (ctx: Ctx, issueId: string, body: string, authorId = ctx.actor.id): { id: string; stmts: Stmt[] } => {
  const id = uid();
  return {
    id,
    stmts: [
      q("INSERT INTO comments (id, issue_id, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", id, issueId, authorId, body, ctx.now, ctx.now),
      logChange(ctx, "comment", id, "create"),
    ],
  };
};

const linkStmts = (ctx: Ctx, issueId: string, links: { url: string; title: string }[]) =>
  links.flatMap((l) => {
    const id = uid();
    return [
      q(
        "INSERT INTO attachments (id, issue_id, url, name, author_id, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM issues WHERE id = ?)",
        id, issueId, l.url, l.title, ctx.actor.id, ctx.now, ctx.now, issueId,
      ),
      logChange(ctx, "attachment", id, "create"),
    ];
  });

const nullable = (s: z.ZodString) => s.nullable().optional();

const saveIssueInput = z.strictObject({
  id: z.string().optional().describe("Only for updating: the issue ID or identifier (e.g. ENG-123). Omit to create"),
  title: z.string().min(1).optional().describe("Issue title (required when creating)"),
  description: markdown("Content").optional(),
  patch: patchOps.optional(),
  team: z.string().optional().describe("Team key, name or ID (required when creating)"),
  state: z.string().optional().describe("State type, name, or ID"),
  priority: z.number().int().min(0).max(4).optional().describe("0=None, 1=Urgent, 2=High, 3=Medium, 4=Low"),
  assignee: nullable(z.string()).describe('User ID, name, email, or "me". Null to remove'),
  labels: z.array(z.string()).optional().describe("Label names or IDs. Replaces the full label set. Cannot be combined with addLabels/removeLabels"),
  addLabels: z.array(z.string()).optional().describe("Label names or IDs to add; in a single-choice group the new label replaces its sibling"),
  removeLabels: z.array(z.string()).optional().describe("Label names or IDs to remove (update only)"),
  project: nullable(z.string()).describe("Project name (a child of the Project label group). Null to remove"),
  parentId: nullable(z.string()).describe("Parent issue ID or identifier (e.g. ENG-123). Null to remove"),
  duplicateOf: nullable(z.string()).describe("Duplicate of issue ID/identifier; moves the issue to the team's duplicate state. Null to remove"),
  release: nullable(z.string()).describe("Release version (e.g. 1.4.0) or ID; created as planned if new. Null to remove"),
  links: z.array(z.strictObject({ url: httpUrl(), title: z.string().min(1) })).optional().describe("Link attachments to add [{url, title}]. Append-only"),
  dedupeKey: z.string().min(1).max(200).optional()
    .describe("Stable key for a recurring report (e.g. an error fingerprint). If an open issue in the team has it, a 'Seen again' comment is added there instead of a new issue"),
  archived: z.boolean().optional().describe("true archives the issue, false restores it (update only)"),
});

async function resolveLabelSet(ctx: Ctx, teamId: string, issueId: string | null, inp: z.infer<typeof saveIssueInput>) {
  const touched = inp.labels || inp.addLabels || inp.removeLabels || inp.project !== undefined;
  if (!touched) return null;
  if (inp.labels && (inp.addLabels || inp.removeLabels)) throw new Fail("labels cannot be combined with addLabels/removeLabels");
  let set = inp.labels ? await R.labels(ctx, teamId, inp.labels) : issueId ? await R.currentLabels(ctx, issueId) : [];
  if (inp.labels) R.checkExclusive(set);
  const add = await R.labels(ctx, teamId, inp.addLabels ?? []);
  if (inp.project) add.push(await R.project(ctx, teamId, inp.project));
  if (inp.project === null) set = set.filter((l) => l.group_name !== "Project");
  R.checkExclusive(add);
  for (const l of add) {
    set = set.filter((s) => s.id !== l.id && !(l.exclusive && l.parent_id && s.parent_id === l.parent_id));
    set.push(l);
  }
  const remove = new Set((await R.labels(ctx, teamId, inp.removeLabels ?? [])).map((l) => l.id));
  return set.filter((l) => !remove.has(l.id)).map((l) => l.id);
}

const openWithKey = (ctx: Ctx, teamId: string, key: string) =>
  first<{ id: string }>(
    ctx.db,
    q(
      `SELECT i.id FROM issues i JOIN states s ON s.id = i.state_id WHERE i.team_id = ? AND i.dedupe_key = ? AND i.archived_at IS NULL
       AND s.type NOT IN ('completed', 'canceled', 'duplicate') ORDER BY i.created_at LIMIT 1`,
      teamId, key,
    ),
  );

async function seenAgain(ctx: Ctx, issueId: string, description?: string) {
  const c = commentStmts(ctx, issueId, description?.trim() ? `Seen again:\n\n${description.trim()}` : "Seen again.");
  await ctx.db.batch([...c.stmts, q("UPDATE issues SET updated_at = ? WHERE id = ?", ctx.now, issueId), logChange(ctx, "issue", issueId, "update")]);
  return { ...(await loadIssue(ctx, issueId))!, deduped: true };
}

async function createIssue(ctx: Ctx, inp: z.infer<typeof saveIssueInput>) {
  if (!inp.team || !inp.title) throw new Fail("team and title are required when creating an issue");
  if (inp.patch || inp.removeLabels || inp.archived !== undefined) throw new Fail("patch, removeLabels and archived are only valid when updating");
  const team = await R.team(ctx, inp.team);
  if (inp.dedupeKey) {
    const hit = await openWithKey(ctx, team.id, inp.dedupeKey);
    if (hit) return seenAgain(ctx, hit.id, inp.description);
  }
  const dup = inp.duplicateOf ? await R.issue(ctx, inp.duplicateOf) : null;
  const st = inp.state
    ? await R.state(ctx, team.id, inp.state)
    : dup
      ? await R.stateOfType(ctx, team.id, "duplicate")
      : await R.stateOfType(ctx, team.id, "backlog", "unstarted", "triage");
  if (!st) throw new Fail(`Team ${team.key} has no ${dup ? "duplicate" : "backlog, unstarted or triage"} state`);
  const assignee = inp.assignee ? (await R.actor(ctx, inp.assignee)).id : null;
  const parent = inp.parentId ? (await R.issue(ctx, inp.parentId)).id : null;
  const rel = inp.release ? await R.release(ctx, team.id, inp.release) : null;
  const labelIds = (await resolveLabelSet(ctx, team.id, null, inp)) ?? [];
  const id = uid();
  const stamps = stateStamps(ctx, null, st.type, null);
  // Guarded so two racing reports with one dedupeKey create one issue; the loser becomes a "Seen again" below.
  await ctx.db.batch([
    ...(rel?.stmts ?? []),
    q(
      `INSERT INTO issues (id, team_id, number, title, description, state_id, priority, assignee_id, creator_id, parent_id, release_id,
         duplicate_of_id, dedupe_key, created_at, updated_at, started_at, completed_at, canceled_at)
       SELECT ?, t.id, t.next_number, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM teams t WHERE t.id = ? AND NOT EXISTS (
         SELECT 1 FROM issues i JOIN states s ON s.id = i.state_id WHERE i.team_id = t.id AND i.dedupe_key = ? AND i.archived_at IS NULL
         AND s.type NOT IN ('completed', 'canceled', 'duplicate'))`,
      id, inp.title, inp.description ?? "", st.id, inp.priority ?? 0, assignee, ctx.actor.id, parent, rel?.id ?? null, dup?.id ?? null,
      inp.dedupeKey ?? null, ctx.now, ctx.now, stamps.started_at ?? null, stamps.completed_at ?? null, stamps.canceled_at ?? null, team.id,
      inp.dedupeKey ?? null,
    ),
    q("UPDATE teams SET next_number = next_number + 1 WHERE id = ? AND EXISTS (SELECT 1 FROM issues WHERE id = ?)", team.id, id),
    q("INSERT INTO issue_labels (issue_id, label_id) SELECT ?, value FROM json_each(?) WHERE EXISTS (SELECT 1 FROM issues WHERE id = ?)", id, JSON.stringify(labelIds), id),
    ...linkStmts(ctx, id, inp.links ?? []),
    logChange(ctx, "issue", id, "create"),
  ]);
  const made = await loadIssue(ctx, id);
  if (made) return made;
  const hit = await openWithKey(ctx, team.id, inp.dedupeKey!);
  if (!hit) throw new Fail("Issue was not created; retry", 409, "conflict");
  return seenAgain(ctx, hit.id, inp.description);
}

async function updateIssue(ctx: Ctx, inp: z.infer<typeof saveIssueInput>) {
  const cur = await first<Record<string, unknown>>(
    ctx.db,
    q("SELECT i.*, s.type AS state_type FROM issues i JOIN states s ON s.id = i.state_id WHERE i.id = ?", (await R.issue(ctx, inp.id!)).id),
  );
  const id = cur!.id as string;
  const teamId = cur!.team_id as string;
  if (inp.team && (await R.team(ctx, inp.team)).id !== teamId) throw new Fail("Moving an issue to another team is not supported");
  if (inp.description !== undefined && inp.patch) throw new Fail("description and patch cannot be combined");
  const set: Record<string, unknown> = {};
  const pre: Stmt[] = [];
  if (inp.title !== undefined) set.title = inp.title;
  if (inp.description !== undefined) set.description = inp.description;
  if (inp.patch) set.description = applyPatch(cur!.description as string, inp.patch);
  if (inp.priority !== undefined) set.priority = inp.priority;
  if (inp.assignee !== undefined) set.assignee_id = inp.assignee === null ? null : (await R.actor(ctx, inp.assignee)).id;
  if (inp.parentId !== undefined) {
    set.parent_id = inp.parentId === null ? null : (await R.issue(ctx, inp.parentId)).id;
    if (set.parent_id === id) throw new Fail("An issue cannot be its own parent");
  }
  if (inp.release !== undefined) {
    const rel = inp.release === null ? null : await R.release(ctx, teamId, inp.release);
    set.release_id = rel?.id ?? null;
    pre.push(...(rel?.stmts ?? []));
  }
  if (inp.dedupeKey !== undefined) set.dedupe_key = inp.dedupeKey;
  if (inp.archived !== undefined) set.archived_at = inp.archived ? ((cur!.archived_at as string | null) ?? ctx.now) : null;
  let toState: R.State | null = inp.state ? await R.state(ctx, teamId, inp.state) : null;
  if (inp.duplicateOf !== undefined) {
    const dup = inp.duplicateOf === null ? null : await R.issue(ctx, inp.duplicateOf);
    if (dup?.id === id) throw new Fail("An issue cannot duplicate itself");
    set.duplicate_of_id = dup?.id ?? null;
    if (dup && !toState) toState = await R.stateOfType(ctx, teamId, "duplicate");
    if (dup && !toState) throw new Fail("This team has no duplicate state");
  }
  if (toState && toState.id !== cur!.state_id) {
    set.state_id = toState.id;
    Object.assign(set, stateStamps(ctx, cur!.state_type as string, toState.type, cur!.started_at));
  }
  const labelIds = await resolveLabelSet(ctx, teamId, id, inp);
  const stmts: Stmt[] = [...pre];
  const cols = Object.keys(set);
  stmts.push(q(`UPDATE issues SET ${[...cols, "updated_at"].map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, ...cols.map((c) => set[c]), ctx.now, id));
  if (labelIds) {
    stmts.push(
      q("DELETE FROM issue_labels WHERE issue_id = ?", id),
      q("INSERT INTO issue_labels (issue_id, label_id) SELECT ?, value FROM json_each(?)", id, JSON.stringify(labelIds)),
    );
  }
  stmts.push(...linkStmts(ctx, id, inp.links ?? []), logChange(ctx, "issue", id, inp.archived ? "archive" : "update"));
  await ctx.db.batch(stmts);
  return (await loadIssue(ctx, id))!;
}

const listIssuesInput = z.strictObject({
  team: z.string().optional().describe("Team key, name or ID. Omit for every team"),
  state: z.string().optional().describe("State type, name, or ID"),
  assignee: nullable(z.string()).describe('User ID, name, email, or "me". "null" or null for unassigned'),
  creator: z.string().optional().describe('User ID, name, email, or "me"'),
  label: z.string().optional().describe("Label name or ID"),
  project: z.string().optional().describe("Project name"),
  release: z.string().optional().describe("Release version or ID"),
  parentId: z.string().optional().describe("Parent issue ID or identifier"),
  priority: z.number().int().min(0).max(4).optional(),
  hasOpenDecision: z.boolean().optional().describe("true: only issues with a decision waiting on the captain; false: only issues without one"),
  query: z.string().optional().describe("Search title and description"),
  dedupeKey: z.string().optional(),
  createdAt: z.string().optional().describe("Created after: ISO-8601 date or duration (e.g. -P1D)"),
  updatedAt: z.string().optional().describe("Updated after: ISO-8601 date or duration (e.g. -P1D)"),
  includeArchived: z.boolean().optional(),
  orderBy: z.enum(["createdAt", "updatedAt"]).optional().describe("Sort, newest first (default updatedAt)"),
  limit: limit(),
  cursor: z.string().optional().describe("Next page cursor"),
  fields,
});

export async function listIssues(ctx: Ctx, inp: z.infer<typeof listIssuesInput>) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, ...p: unknown[]) => (where.push(sql), params.push(...p));
  if (!inp.includeArchived) add("i.archived_at IS NULL");
  if (inp.team) add("i.team_id = ?", (await R.team(ctx, inp.team)).id);
  if (inp.state) add("(s.id = ? OR lower(s.name) = lower(?) OR s.type = lower(?))", inp.state, inp.state, inp.state);
  if (inp.assignee === null || inp.assignee === "null") add("i.assignee_id IS NULL");
  else if (inp.assignee) add("i.assignee_id = ?", (await R.actor(ctx, inp.assignee)).id);
  if (inp.creator) add("i.creator_id = ?", (await R.actor(ctx, inp.creator)).id);
  if (inp.label) {
    add("EXISTS (SELECT 1 FROM issue_labels il JOIN labels l ON l.id = il.label_id WHERE il.issue_id = i.id AND (l.id = ? OR lower(l.name) = lower(?)))", inp.label, inp.label);
  }
  if (inp.project) {
    add(
      `EXISTS (SELECT 1 FROM issue_labels il JOIN labels l ON l.id = il.label_id JOIN labels g ON g.id = l.parent_id
        WHERE il.issue_id = i.id AND g.name = 'Project' AND lower(l.name) = lower(?))`,
      inp.project,
    );
  }
  if (inp.release) add("(r.id = ? OR r.version = ?)", inp.release, inp.release);
  if (inp.parentId) add("i.parent_id = ?", (await R.issue(ctx, inp.parentId)).id);
  if (inp.priority !== undefined) add("i.priority = ?", inp.priority);
  if (inp.dedupeKey) add("i.dedupe_key = ?", inp.dedupeKey);
  if (inp.hasOpenDecision !== undefined) {
    add(`${inp.hasOpenDecision ? "" : "NOT "}EXISTS (SELECT 1 FROM decisions dd WHERE dd.issue_id = i.id AND dd.status = 'open')`);
  }
  if (inp.query) {
    const m = ftsQuery(inp.query);
    if (m) add("i.rowid IN (SELECT rowid FROM issues_fts WHERE issues_fts MATCH ?)", m);
  }
  if (inp.createdAt) add("i.created_at >= ?", since(inp.createdAt, ctx.now));
  if (inp.updatedAt) add("i.updated_at >= ?", since(inp.updatedAt, ctx.now));
  const col = inp.orderBy === "createdAt" ? "i.created_at" : "i.updated_at";
  if (inp.cursor) {
    const [at, cid] = inp.cursor.split("|");
    if (!at || !cid) throw new Fail("Bad cursor");
    add(`(${col}, i.id) < (?, ?)`, at, cid);
  }
  const n = inp.limit ?? 50;
  const rows = await ctx.db.all<IssueRow>(
    q(`${ISSUE_ROW} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${col} DESC, i.id DESC LIMIT ?`, ...params, n + 1),
  );
  const page = rows.slice(0, n);
  const last = page.at(-1);
  return {
    issues: page.map((r) => pick(shapeIssue(ctx, r), inp.fields)),
    cursor: rows.length > n && last ? `${last[inp.orderBy === "createdAt" ? "created_at" : "updated_at"]}|${last.id}` : null,
  };
}

export const attachmentShape = (ctx: Ctx, a: Record<string, unknown>) => ({
  id: a.id,
  name: a.name,
  url: a.blob_key ? `${ctx.baseUrl ?? ""}/files/${a.id}` : a.url,
  mime: a.mime ?? null,
  size: a.size ?? null,
  documentId: a.doc_id ?? null,
  commentId: a.comment_id ?? null,
  createdAt: a.created_at,
});

export const issueOps = [
  op({
    name: "list_issues",
    description: 'List issues across every app, newest first. For issues assigned to me use "me" as the assignee.',
    input: listIssuesInput,
    run: listIssues,
  }),
  op({
    name: "get_issue",
    description: "Get one issue by ID or identifier (e.g. ENG-123), with attachments, PR links, sub-issues and decisions.",
    input: z.strictObject({ id: z.string().describe("Issue ID or identifier (e.g. ENG-123)"), fields }),
    async run(ctx, inp) {
      const ref = await R.issue(ctx, inp.id);
      const issue = (await loadIssue(ctx, ref.id))!;
      if (inp.fields?.length) return pick(issue, inp.fields);
      const [atts, prs, kids, decs] = await Promise.all([
        ctx.db.all(q("SELECT * FROM attachments WHERE issue_id = ? AND archived_at IS NULL ORDER BY created_at", ref.id)),
        ctx.db.all(q("SELECT provider, repo, number, url, title, state, updated_at FROM pr_links WHERE issue_id = ? ORDER BY updated_at DESC", ref.id)),
        ctx.db.all<IssueRow>(q(`${ISSUE_ROW} WHERE i.parent_id = ? AND i.archived_at IS NULL ORDER BY i.number`, ref.id)),
        ctx.db.all(q("SELECT id, kind, question, status, answer FROM decisions WHERE issue_id = ? ORDER BY created_at", ref.id)),
      ]);
      return {
        ...issue,
        attachments: atts.map((a) => attachmentShape(ctx, a)),
        pullRequests: prs,
        children: kids.map((k) => {
          const s = shapeIssue(ctx, k);
          return { id: s.id, title: s.title, status: s.status, statusType: s.statusType, assignee: s.assignee };
        }),
        decisions: decs,
      };
    },
  }),
  op({
    name: "save_issue",
    description:
      "Create or update an issue. With `id` it updates; otherwise it creates (team and title required). Use `assignee` (not assigneeId). " +
      "With `dedupeKey`, a matching open issue gets a 'Seen again' comment instead of a duplicate.",
    input: saveIssueInput,
    run: (ctx, inp) => (inp.id ? updateIssue(ctx, inp) : createIssue(ctx, inp)),
  }),
  op({
    name: "save_comment",
    description: "Create or update a comment on an issue. Pass `id` to edit; otherwise `issueId` (or `parentId` to reply in the same issue).",
    input: z.strictObject({
      id: z.string().optional().describe("Comment ID. If provided, updates the existing comment"),
      issueId: z.string().optional().describe("Issue ID or identifier (e.g. ENG-123)"),
      parentId: z.string().optional().describe("Comment ID being replied to; the reply lands on the same issue"),
      body: markdown("Comment").min(1),
    }),
    async run(ctx, inp) {
      if (inp.id) {
        const c = await first<{ author_id: string }>(ctx.db, q("SELECT author_id FROM comments WHERE id = ?", inp.id));
        if (!c) throw new Fail(`No comment ${inp.id}`, 404, "not_found");
        if (c.author_id !== ctx.actor.id && ctx.actor.kind !== "human") throw new Fail("Only the author can edit a comment", 403, "forbidden");
        await ctx.db.batch([q("UPDATE comments SET body = ?, updated_at = ? WHERE id = ?", inp.body, ctx.now, inp.id), logChange(ctx, "comment", inp.id, "update")]);
        return (await comments(ctx, [inp.id]))[0];
      }
      let issueId: string;
      if (inp.issueId) issueId = (await R.issue(ctx, inp.issueId)).id;
      else if (inp.parentId) {
        const p = await first<{ issue_id: string }>(ctx.db, q("SELECT issue_id FROM comments WHERE id = ?", inp.parentId));
        if (!p) throw new Fail(`No comment ${inp.parentId}`, 404, "not_found");
        issueId = p.issue_id;
      } else throw new Fail("issueId is required");
      const c = commentStmts(ctx, issueId, inp.body);
      await ctx.db.batch([...c.stmts, q("UPDATE issues SET updated_at = ? WHERE id = ?", ctx.now, issueId), logChange(ctx, "issue", issueId, "update")]);
      return (await comments(ctx, [c.id]))[0];
    },
  }),
  op({
    name: "list_comments",
    description: "List comments on an issue, oldest first, with the files attached to each.",
    input: z.strictObject({
      issueId: z.string().describe("Issue ID or identifier (e.g. ENG-123)"),
      limit: limit(),
      cursor: z.string().optional().describe("Next page cursor"),
    }),
    async run(ctx, inp) {
      const issueId = (await R.issue(ctx, inp.issueId)).id;
      const n = inp.limit ?? 50;
      const [at, cid] = inp.cursor?.split("|") ?? [];
      const rows = await ctx.db.all<{ id: string; created_at: string }>(
        q(
          `SELECT c.id, c.created_at FROM comments c WHERE c.issue_id = ? AND c.archived_at IS NULL ${inp.cursor ? "AND (c.created_at, c.id) > (?, ?)" : ""}
           ORDER BY c.created_at, c.id LIMIT ?`,
          issueId, ...(inp.cursor ? [at, cid] : []), n + 1,
        ),
      );
      const page = rows.slice(0, n);
      return {
        comments: await comments(ctx, page.map((r) => r.id)),
        cursor: rows.length > n ? `${page.at(-1)!.created_at}|${page.at(-1)!.id}` : null,
      };
    },
  }),
];

/** Comments by id, in the given order, with their authors and files (two queries, whatever the count). */
async function comments(ctx: Ctx, ids: string[]) {
  const json = JSON.stringify(ids);
  const [rows, atts] = await Promise.all([
    ctx.db.all<Record<string, unknown>>(
      q("SELECT c.*, a.name AS author_name, a.kind AS author_kind FROM comments c LEFT JOIN actors a ON a.id = c.author_id WHERE c.id IN (SELECT value FROM json_each(?))", json),
    ),
    ctx.db.all<Record<string, unknown>>(q("SELECT * FROM attachments WHERE comment_id IN (SELECT value FROM json_each(?)) AND archived_at IS NULL", json)),
  ]);
  const byId = new Map(rows.map((c) => [c.id, c]));
  return ids.map((id) => {
    const c = byId.get(id)!;
    return {
      id: c.id,
      body: c.body,
      author: c.author_name ?? null,
      authorKind: c.author_kind ?? null,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      attachments: atts.filter((a) => a.comment_id === id).map((a) => attachmentShape(ctx, a)),
    };
  });
}
