// Teams, states, labels, people, tokens and documents: the workspace around the issues.
import { z } from "zod";
import { first, q, type Stmt } from "../db/db";
import { type Ctx, Fail, sha256, since, uid } from "./ctx";
import { logChange } from "./log";
import { applyPatch, httpUrl, limit, markdown, op, patchOps } from "./registry";
import * as R from "./resolve";

const DEFAULT_STATES: [string, string, string][] = [
  ["Triage", "triage", "#fc7840"], ["Backlog", "backlog", "#bec2c8"], ["Todo", "unstarted", "#e2e2e2"], ["In Progress", "started", "#f2c94c"],
  ["In Review", "started", "#5e6ad2"], ["Done", "completed", "#5e6ad2"], ["Canceled", "canceled", "#95a2b3"], ["Duplicate", "duplicate", "#95a2b3"],
];

const teamShape = (t: Record<string, unknown>) => ({
  id: t.id, key: t.key, name: t.name, stagingUrl: t.staging_url ?? null, liveUrl: t.live_url ?? null,
  createdAt: t.created_at, updatedAt: t.updated_at, archivedAt: t.archived_at ?? null,
});

const docShape = (ctx: Ctx, d: Record<string, unknown>, withBody = true) => ({
  id: d.id,
  title: d.title,
  ...(withBody ? { content: d.body } : {}),
  team: d.team_name ?? null,
  teamId: d.team_id ?? null,
  creator: d.author_name ?? null,
  url: `${ctx.baseUrl ?? ""}/doc/${d.id}`,
  createdAt: d.created_at,
  updatedAt: d.updated_at,
  archivedAt: d.archived_at ?? null,
});
const DOC_ROW = "SELECT d.*, t.name AS team_name, a.name AS author_name FROM docs d LEFT JOIN teams t ON t.id = d.team_id LEFT JOIN actors a ON a.id = d.author_id";

export const loadDoc = async (ctx: Ctx, id: string) => {
  const d = await first(ctx.db, q(`${DOC_ROW} WHERE d.id = ?`, id));
  if (!d) throw new Fail(`No document ${JSON.stringify(id)}`, 404, "not_found");
  const issues = await ctx.db.all<{ ident: string }>(
    q("SELECT t.key || '-' || i.number AS ident FROM attachments a JOIN issues i ON i.id = a.issue_id JOIN teams t ON t.id = i.team_id WHERE a.doc_id = ? AND a.archived_at IS NULL", id),
  );
  return { ...docShape(ctx, d), issues: issues.map((i) => i.ident) };
};

/** Statements that create a doc; with `issueId` it is also attached to that issue. */
export function docStmts(ctx: Ctx, doc: { id?: string; title: string; body: string; teamId: string | null; issueId?: string | null }) {
  const id = doc.id ?? uid();
  const stmts: Stmt[] = [
    q("INSERT INTO docs (id, team_id, title, body, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, doc.teamId, doc.title, doc.body, ctx.actor.id, ctx.now, ctx.now),
    logChange(ctx, "doc", id, "create"),
  ];
  if (doc.issueId) stmts.push(...attachDocStmts(ctx, id, doc.issueId, doc.title));
  return { id, stmts };
}

const attachDocStmts = (ctx: Ctx, docId: string, issueId: string, title: string): Stmt[] => {
  const aid = uid();
  return [
    q(
      `INSERT INTO attachments (id, issue_id, doc_id, url, name, author_id, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM attachments WHERE doc_id = ? AND issue_id = ? AND archived_at IS NULL)`,
      aid, issueId, docId, `/doc/${docId}`, title, ctx.actor.id, ctx.now, ctx.now, docId, issueId,
    ),
    logChange(ctx, "attachment", aid, "create"),
  ];
};

export const newToken = () => `lb_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]!)}`;

export const workspaceOps = [
  op({
    name: "list_teams",
    description: "List teams (one per app).",
    input: z.strictObject({ query: z.string().optional().describe("Filter by key or name"), includeArchived: z.boolean().optional() }),
    async run(ctx, inp) {
      const rows = await ctx.db.all(
        q(
          `SELECT * FROM teams WHERE (? OR archived_at IS NULL) AND (? IS NULL OR lower(key) LIKE '%' || lower(?) || '%' OR lower(name) LIKE '%' || lower(?) || '%') ORDER BY name`,
          !!inp.includeArchived, inp.query ?? null, inp.query ?? null, inp.query ?? null,
        ),
      );
      return { teams: rows.map(teamShape) };
    },
  }),
  op({
    name: "save_team",
    who: "human",
    description: "Create or update a team. A new team gets Linear's default states (Triage, Backlog, Todo, In Progress, In Review, Done, Canceled, Duplicate).",
    input: z.strictObject({
      id: z.string().optional().describe("Team key, name or ID to update. Omit to create"),
      key: z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/).optional().describe("Issue prefix, e.g. ENG (required when creating)"),
      name: z.string().min(1).optional().describe("Team name (required when creating)"),
      stagingUrl: httpUrl().nullable().optional().describe("Where the app's staging runs, e.g. https://test.example.com. Null to clear"),
      liveUrl: httpUrl().nullable().optional().describe("Where the app runs in production, e.g. https://example.com. Null to clear"),
      archived: z.boolean().optional(),
    }),
    async run(ctx, inp) {
      if (inp.id) {
        const t = await R.team(ctx, inp.id);
        const set: Record<string, unknown> = {};
        if (inp.key) set.key = inp.key;
        if (inp.name) set.name = inp.name;
        if (inp.stagingUrl !== undefined) set.staging_url = inp.stagingUrl;
        if (inp.liveUrl !== undefined) set.live_url = inp.liveUrl;
        if (inp.archived !== undefined) set.archived_at = inp.archived ? ctx.now : null;
        const cols = Object.keys(set);
        await ctx.db.batch([
          q(`UPDATE teams SET ${[...cols, "updated_at"].map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, ...cols.map((c) => set[c]), ctx.now, t.id),
          logChange(ctx, "team", t.id, inp.archived ? "archive" : "update"),
        ]);
        return teamShape((await first(ctx.db, q("SELECT * FROM teams WHERE id = ?", t.id)))!);
      }
      if (!inp.key || !inp.name) throw new Fail("key and name are required when creating a team");
      const id = uid();
      const stmts: Stmt[] = [
        q(
          "INSERT INTO teams (id, key, name, staging_url, live_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          id, inp.key, inp.name, inp.stagingUrl ?? null, inp.liveUrl ?? null, ctx.now, ctx.now,
        ),
        logChange(ctx, "team", id, "create"),
      ];
      DEFAULT_STATES.forEach(([name, type, color], i) => {
        const sid = uid();
        stmts.push(
          q("INSERT INTO states (id, team_id, name, type, color, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", sid, id, name, type, color, i, ctx.now, ctx.now),
          logChange(ctx, "state", sid, "create"),
        );
      });
      await ctx.db.batch(stmts);
      return teamShape((await first(ctx.db, q("SELECT * FROM teams WHERE id = ?", id)))!);
    },
  }),
  op({
    name: "list_issue_statuses",
    description: "List the workflow states of a team.",
    input: z.strictObject({ team: z.string().describe("Team key, name or ID") }),
    async run(ctx, inp) {
      const t = await R.team(ctx, inp.team);
      const rows = await ctx.db.all(q("SELECT id, name, type, color, position FROM states WHERE team_id = ? AND archived_at IS NULL ORDER BY position", t.id));
      return { statuses: rows };
    },
  }),
  op({
    name: "list_issue_labels",
    description: "List labels: a team's own plus workspace-wide ones, or every label without a team. Children of a group show their group in `parent`.",
    input: z.strictObject({
      team: z.string().optional().describe("Team key, name or ID. Omit for every label"),
      name: z.string().optional().describe("Filter by name"),
      includeGroups: z.boolean().optional().describe("Include label groups, marked with isGroup"),
      includeArchived: z.boolean().optional(),
      limit: limit(),
    }),
    async run(ctx, inp) {
      const teamId = inp.team ? (await R.team(ctx, inp.team)).id : null;
      const rows = await ctx.db.all<Record<string, unknown>>(
        q(
          `SELECT l.*, g.name AS group_name, t.name AS team_name FROM labels l LEFT JOIN labels g ON g.id = l.parent_id LEFT JOIN teams t ON t.id = l.team_id
           WHERE (? IS NULL OR l.team_id IS NULL OR l.team_id = ?) AND (? OR l.archived_at IS NULL) AND (? OR l.is_group = 0)
           AND (? IS NULL OR lower(l.name) LIKE '%' || lower(?) || '%') ORDER BY g.name, l.name LIMIT ?`,
          teamId, teamId, !!inp.includeArchived, !!inp.includeGroups, inp.name ?? null, inp.name ?? null, inp.limit ?? 250,
        ),
      );
      return {
        labels: rows.map((l) => ({
          id: l.id, name: l.name, color: l.color, description: l.description, parent: l.group_name ?? null, team: l.team_name ?? null,
          isGroup: !!l.is_group, singleChoice: !!l.exclusive, archivedAt: l.archived_at ?? null,
        })),
      };
    },
  }),
  op({
    name: "save_issue_label",
    description: "Create or update a label. A group (isGroup) organises child labels and cannot be applied itself; groupType singleSelect allows one child per issue.",
    input: z.strictObject({
      id: z.string().optional().describe("Label ID to update. Omit to create"),
      name: z.string().min(1).optional().describe("Label name (required when creating)"),
      color: z.string().optional().describe("Hex color"),
      description: z.string().nullable().optional(),
      isGroup: z.boolean().optional(),
      groupType: z.enum(["singleSelect", "multiSelect"]).optional().describe("For groups: singleSelect allows one child per issue (default when creating a group)"),
      parent: z.string().nullable().optional().describe("Parent group name or ID. Null to remove from its group"),
      team: z.string().optional().describe("Team key, name or ID; omit for a workspace label (create only)"),
      teamId: z.string().optional().describe("Same as team, for Linear compatibility"),
      archived: z.boolean().optional(),
    }),
    async run(ctx, inp) {
      const teamRef = inp.team ?? inp.teamId;
      let parentId = inp.parent;
      if (inp.parent) {
        const g = await first<{ id: string }>(ctx.db, q("SELECT id FROM labels WHERE is_group = 1 AND archived_at IS NULL AND (id = ? OR lower(name) = lower(?))", inp.parent, inp.parent));
        if (!g) throw new Fail(`No label group ${JSON.stringify(inp.parent)}`, 404, "not_found");
        parentId = g.id;
      }
      if (inp.id) {
        const l = await first<{ id: string }>(ctx.db, q("SELECT id FROM labels WHERE id = ?", inp.id));
        if (!l) throw new Fail(`No label ${inp.id}`, 404, "not_found");
        const set: Record<string, unknown> = {};
        if (inp.name) set.name = inp.name;
        if (inp.color) set.color = inp.color;
        if (inp.description !== undefined) set.description = inp.description;
        if (inp.isGroup !== undefined) set.is_group = inp.isGroup ? 1 : 0;
        if (inp.groupType) set.exclusive = inp.groupType === "singleSelect" ? 1 : 0;
        if (parentId !== undefined) set.parent_id = parentId;
        if (inp.archived !== undefined) set.archived_at = inp.archived ? ctx.now : null;
        const cols = Object.keys(set);
        await ctx.db.batch([
          q(`UPDATE labels SET ${[...cols, "updated_at"].map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, ...cols.map((c) => set[c]), ctx.now, l.id),
          logChange(ctx, "label", l.id, inp.archived ? "archive" : "update"),
        ]);
        return { id: l.id };
      }
      if (!inp.name) throw new Fail("name is required when creating a label");
      const teamId = teamRef ? (await R.team(ctx, teamRef)).id : null;
      const id = uid();
      await ctx.db.batch([
        q(
          "INSERT INTO labels (id, team_id, parent_id, name, color, description, is_group, exclusive, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          id, teamId, parentId ?? null, inp.name, inp.color ?? null, inp.description ?? null, inp.isGroup ? 1 : 0,
          inp.isGroup && (inp.groupType ?? "singleSelect") === "singleSelect" ? 1 : 0, ctx.now, ctx.now,
        ),
        logChange(ctx, "label", id, "create"),
      ]);
      return { id, name: inp.name };
    },
  }),
  op({
    name: "list_users",
    description: "List people and agents, with when each last wrote something or used a token (lastActiveAt).",
    input: z.strictObject({ query: z.string().optional().describe("Filter by name or email"), kind: z.enum(["human", "agent", "system"]).optional() }),
    async run(ctx, inp) {
      const rows = await ctx.db.all(
        q(
          `SELECT id, kind, name, email, created_at AS createdAt, nullif(max(
             coalesce((SELECT at FROM changes WHERE actor_id = actors.id ORDER BY sync_id DESC LIMIT 1), ''),
             coalesce((SELECT max(last_used_at) FROM tokens WHERE actor_id = actors.id), '')), '') AS lastActiveAt
           FROM actors WHERE archived_at IS NULL AND (? IS NULL OR kind = ?)
           AND (? IS NULL OR lower(name) LIKE '%' || lower(?) || '%' OR lower(email) LIKE '%' || lower(?) || '%') ORDER BY kind, name`,
          inp.kind ?? null, inp.kind ?? null, inp.query ?? null, inp.query ?? null, inp.query ?? null,
        ),
      );
      return { users: rows };
    },
  }),
  op({ name: "me", description: "Who am I logged in as.", input: z.strictObject({}), run: async (ctx) => ctx.actor }),
  op({
    name: "save_profile",
    who: "human",
    description: "Change the name you are shown under. Your email, which your login maps to, stays.",
    input: z.strictObject({ name: z.string().trim().min(1).max(60).describe("Display name, e.g. Ada") }),
    async run(ctx, inp) {
      const taken = await first(ctx.db, q("SELECT 1 FROM actors WHERE lower(name) = lower(?) AND id <> ?", inp.name, ctx.actor.id));
      if (taken) throw new Fail(`The name ${JSON.stringify(inp.name)} is taken`, 409, "conflict");
      await ctx.db.batch([q("UPDATE actors SET name = ?, updated_at = ? WHERE id = ?", inp.name, ctx.now, ctx.actor.id), logChange(ctx, "actor", ctx.actor.id, "update")]);
      return { ...ctx.actor, name: inp.name };
    },
  }),
  op({
    name: "create_token",
    who: "human",
    description: "Create an API token for an agent (or a system job such as the importer). The token is shown once.",
    input: z.strictObject({
      name: z.string().min(1).describe("What uses it, e.g. claude-code-laptop"),
      actor: z.string().min(1).describe("Agent name it acts as; created if new"),
      kind: z.enum(["agent", "system"]).optional().describe("Kind of a new actor (default agent)"),
    }),
    async run(ctx, inp) {
      let a = await first<{ id: string; kind: string }>(ctx.db, q("SELECT id, kind FROM actors WHERE lower(name) = lower(?)", inp.actor));
      const stmts: Stmt[] = [];
      if (!a) {
        a = { id: uid(), kind: inp.kind ?? "agent" };
        stmts.push(q("INSERT INTO actors (id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", a.id, a.kind, inp.actor, ctx.now, ctx.now), logChange(ctx, "actor", a.id, "create"));
      }
      if (a.kind === "human") throw new Fail("Tokens are for agents and system jobs; humans log in through Access");
      const token = newToken();
      const id = uid();
      stmts.push(q("INSERT INTO tokens (id, actor_id, name, hash, created_at) VALUES (?, ?, ?, ?, ?)", id, a.id, inp.name, await sha256(token), ctx.now));
      await ctx.db.batch(stmts);
      return { id, name: inp.name, actor: inp.actor, token };
    },
  }),
  op({
    name: "list_tokens",
    who: "human",
    description: "List API tokens (never their values).",
    input: z.strictObject({ includeRevoked: z.boolean().optional() }),
    async run(ctx, inp) {
      return {
        tokens: await ctx.db.all(
          q(
            `SELECT k.id, k.name, a.name AS actor, a.kind, k.created_at AS createdAt, k.last_used_at AS lastUsedAt, k.revoked_at AS revokedAt
             FROM tokens k JOIN actors a ON a.id = k.actor_id WHERE ? OR k.revoked_at IS NULL ORDER BY k.created_at DESC`,
            !!inp.includeRevoked,
          ),
        ),
      };
    },
  }),
  op({
    name: "revoke_token",
    who: "human",
    description: "Revoke an API token. It stops working immediately.",
    input: z.strictObject({ id: z.string() }),
    async run(ctx, inp) {
      await ctx.db.batch([q("UPDATE tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?", ctx.now, inp.id)]);
      return { id: inp.id, revoked: true };
    },
  }),
  op({
    name: "list_documents",
    description: "List documents (release notes, specs, notes), newest first.",
    input: z.strictObject({
      query: z.string().optional().describe("Search title and content"),
      team: z.string().optional().describe("Team key, name or ID"),
      teamId: z.string().optional().describe("Same as team, for Linear compatibility"),
      updatedAt: z.string().optional().describe("Updated after: ISO-8601 date or duration (e.g. -P1D)"),
      includeArchived: z.boolean().optional(),
      limit: limit(),
    }),
    async run(ctx, inp) {
      const teamRef = inp.team ?? inp.teamId;
      const teamId = teamRef ? (await R.team(ctx, teamRef)).id : null;
      const words = inp.query?.match(/[\p{L}\p{N}_]+/gu) ?? [];
      const rows = await ctx.db.all(
        q(
          `${DOC_ROW} WHERE (? OR d.archived_at IS NULL) AND (? IS NULL OR d.team_id = ?) AND (? IS NULL OR d.updated_at >= ?)
           ${words.map(() => "AND (d.title LIKE '%' || ? || '%' OR d.body LIKE '%' || ? || '%')").join(" ")} ORDER BY d.updated_at DESC LIMIT ?`,
          !!inp.includeArchived, teamId, teamId, inp.updatedAt ? since(inp.updatedAt, ctx.now) : null, inp.updatedAt ? since(inp.updatedAt, ctx.now) : null,
          ...words.flatMap((w) => [w, w]), inp.limit ?? 50,
        ),
      );
      return { documents: rows.map((d) => docShape(ctx, d, false)) };
    },
  }),
  op({
    name: "get_document",
    description: "Get a document with its content and the issues it is attached to.",
    input: z.strictObject({ id: z.string() }),
    run: (ctx, inp) => loadDoc(ctx, inp.id),
  }),
  op({
    name: "save_document",
    description: "Create or update a document. Create needs a title; `team` and/or `issue` place it. Use `patch` to edit part of the content.",
    input: z.strictObject({
      id: z.string().optional().describe("Document ID to update. Omit to create"),
      title: z.string().min(1).optional(),
      content: markdown("Content").optional(),
      patch: patchOps.optional(),
      team: z.string().optional().describe("Team key, name or ID"),
      issue: z.string().optional().describe("Issue ID or identifier to attach the document to"),
      archived: z.boolean().optional(),
    }),
    async run(ctx, inp) {
      const issueRef = inp.issue ? await R.issue(ctx, inp.issue) : null;
      const teamId = inp.team ? (await R.team(ctx, inp.team)).id : (issueRef?.team_id ?? null);
      if (!inp.id) {
        if (!inp.title) throw new Fail("title is required when creating a document");
        if (inp.patch || inp.archived !== undefined) throw new Fail("patch and archived are only valid when updating");
        const d = docStmts(ctx, { title: inp.title, body: inp.content ?? "", teamId, issueId: issueRef?.id });
        await ctx.db.batch(d.stmts);
        return loadDoc(ctx, d.id);
      }
      const cur = await first<{ id: string; body: string; title: string }>(ctx.db, q("SELECT id, body, title FROM docs WHERE id = ?", inp.id));
      if (!cur) throw new Fail(`No document ${JSON.stringify(inp.id)}`, 404, "not_found");
      if (inp.content !== undefined && inp.patch) throw new Fail("content and patch cannot be combined");
      const set: Record<string, unknown> = {};
      if (inp.title) set.title = inp.title;
      if (inp.content !== undefined) set.body = inp.content;
      if (inp.patch) set.body = applyPatch(cur.body, inp.patch);
      if (inp.team) set.team_id = teamId;
      if (inp.archived !== undefined) set.archived_at = inp.archived ? ctx.now : null;
      const cols = Object.keys(set);
      await ctx.db.batch([
        q(`UPDATE docs SET ${[...cols, "updated_at"].map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, ...cols.map((c) => set[c]), ctx.now, cur.id),
        ...(issueRef ? attachDocStmts(ctx, cur.id, issueRef.id, inp.title ?? cur.title) : []),
        logChange(ctx, "doc", cur.id, inp.archived ? "archive" : "update"),
      ]);
      return loadDoc(ctx, cur.id);
    },
  }),
  op({
    name: "overview",
    description: "Where every app stands: open, in-progress and done-this-week counts per team, open decisions, and the latest and next release.",
    input: z.strictObject({}),
    async run(ctx) {
      const week = since("-P7D", ctx.now);
      const teams = await ctx.db.all<Record<string, unknown>>(
        q(
          `SELECT t.id, t.key, t.name, t.staging_url AS stagingUrl, t.live_url AS liveUrl,
             (SELECT count(*) FROM issues i JOIN states s ON s.id = i.state_id WHERE i.team_id = t.id AND i.archived_at IS NULL AND s.type IN ('triage', 'backlog', 'unstarted', 'started')) AS open,
             (SELECT count(*) FROM issues i JOIN states s ON s.id = i.state_id WHERE i.team_id = t.id AND i.archived_at IS NULL AND s.type = 'started') AS inProgress,
             (SELECT count(*) FROM issues i JOIN states s ON s.id = i.state_id WHERE i.team_id = t.id AND i.archived_at IS NULL AND s.type = 'triage') AS triage,
             (SELECT count(*) FROM issues i WHERE i.team_id = t.id AND i.archived_at IS NULL AND i.priority = 1 AND i.completed_at IS NULL AND i.canceled_at IS NULL) AS urgent,
             (SELECT count(*) FROM issues i WHERE i.team_id = t.id AND i.completed_at >= ?) AS doneThisWeek,
             (SELECT count(*) FROM decisions d WHERE d.team_id = t.id AND d.status = 'open') AS openDecisions,
             (SELECT json_object('version', r.version, 'deployedAt', r.deployed_at) FROM releases r WHERE r.team_id = t.id AND r.status = 'live' ORDER BY r.deployed_at DESC LIMIT 1) AS live,
             (SELECT json_object('version', r.version, 'status', r.status) FROM releases r WHERE r.team_id = t.id AND r.status IN ('planned', 'staging') AND r.archived_at IS NULL ORDER BY r.status = 'staging' DESC, r.created_at LIMIT 1) AS next
           FROM teams t WHERE t.archived_at IS NULL ORDER BY t.name`,
          week,
        ),
      );
      return {
        teams: teams.map((t) => ({ ...t, live: t.live ? JSON.parse(t.live as string) : null, next: t.next ? JSON.parse(t.next as string) : null })),
      };
    },
  }),
];

