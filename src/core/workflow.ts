// Releases, the captain inbox (decisions), search, the change feed and file uploads.
import { z } from "zod";
import { first, q, type Stmt } from "../db/db";
import { type Ctx, Fail, ftsQuery, uid } from "./ctx";
import { attachmentShape, commentStmts } from "./issues";
import { logChange, logWhere } from "./log";
import { limit, markdown, op } from "./registry";
import * as R from "./resolve";
import { docStmts } from "./workspace";

const RELEASE_ROW = `SELECT r.*, t.key AS team_key, t.name AS team_name,
  (SELECT count(*) FROM issues i WHERE i.release_id = r.id AND i.archived_at IS NULL) AS issue_count,
  (SELECT count(*) FROM issues i JOIN states s ON s.id = i.state_id WHERE i.release_id = r.id AND i.archived_at IS NULL AND s.type = 'completed') AS done_count
FROM releases r JOIN teams t ON t.id = r.team_id`;

const releaseShape = (r: Record<string, unknown>) => ({
  id: r.id, team: r.team_name, teamKey: r.team_key, version: r.version, status: r.status, deployedAt: r.deployed_at ?? null,
  notesDocId: r.notes_doc_id ?? null, issues: r.issue_count, done: r.done_count, createdAt: r.created_at, updatedAt: r.updated_at,
});

async function findRelease(ctx: Ctx, ref: string, team?: string) {
  const teamId = team ? (await R.team(ctx, team)).id : null;
  const rows = await ctx.db.all<Record<string, unknown>>(q(`${RELEASE_ROW} WHERE (r.id = ? OR r.version = ?) AND (? IS NULL OR r.team_id = ?)`, ref, ref, teamId, teamId));
  if (!rows.length) throw new Fail(`No release ${JSON.stringify(ref)}`, 404, "not_found");
  if (rows.length > 1) throw new Fail(`Release ${JSON.stringify(ref)} exists in several teams; pass team`);
  return rows[0]!;
}

const vee = (v: string) => (/^v/i.test(v) ? v : `v${v}`);

/**
 * Going live is the one rule that closes issues: every attached issue that is not done moves to the
 * team's first completed state, every attached issue that shipped gets a "Live in vX" comment,
 * deployed_at is stamped and release notes are written (or rewritten) as a document.
 */
async function setStatus(ctx: Ctx, rel: Record<string, unknown>, status: string) {
  if (rel.status === status) return;
  const id = rel.id as string;
  const stmts: Stmt[] = [];
  if (status === "live") {
    const done = await R.stateOfType(ctx, rel.team_id as string, "completed");
    if (!done) throw new Fail(`Team ${rel.team_key} has no completed state`);
    const attached = await ctx.db.all<{ id: string; ident: string; title: string; type: string }>(
      q(
        `SELECT i.id, t.key || '-' || i.number AS ident, i.title, s.type FROM issues i JOIN teams t ON t.id = i.team_id JOIN states s ON s.id = i.state_id
         WHERE i.release_id = ? AND i.archived_at IS NULL ORDER BY i.number`,
        id,
      ),
    );
    const shipped = attached.filter((i) => i.type !== "canceled" && i.type !== "duplicate");
    const comments = shipped.map((i) => ({ id: uid(), issue: i.id }));
    const json = JSON.stringify(comments);
    const v = vee(rel.version as string);
    const notes = `# ${rel.team_name} ${v}\n\nLive since ${ctx.now.slice(0, 10)}.\n\n${shipped.map((i) => `- ${i.ident} ${i.title}`).join("\n") || "_No issues attached._"}\n`;
    stmts.push(
      q(
        `UPDATE issues SET state_id = ?, completed_at = ?, updated_at = ? WHERE release_id = ? AND archived_at IS NULL
         AND state_id IN (SELECT id FROM states WHERE type NOT IN ('completed', 'canceled', 'duplicate'))`,
        done.id, ctx.now, ctx.now, id,
      ),
      q(
        `INSERT INTO comments (id, issue_id, author_id, body, created_at, updated_at)
         SELECT json_extract(value, '$.id'), json_extract(value, '$.issue'), ?, ?, ?, ? FROM json_each(?)`,
        ctx.actor.id, `Live in ${v}.`, ctx.now, ctx.now, json,
      ),
      logWhere(ctx, "comment", "create", "id IN (SELECT json_extract(value, '$.id') FROM json_each(?))", json),
      q("UPDATE issues SET updated_at = ? WHERE id IN (SELECT json_extract(value, '$.issue') FROM json_each(?))", ctx.now, json),
      logWhere(ctx, "issue", "update", "release_id = ? AND archived_at IS NULL", id),
    );
    if (rel.notes_doc_id) {
      stmts.push(q("UPDATE docs SET body = ?, updated_at = ? WHERE id = ?", notes, ctx.now, rel.notes_doc_id), logChange(ctx, "doc", rel.notes_doc_id as string, "update"));
    } else {
      const d = docStmts(ctx, { title: `${rel.team_name} ${v} release notes`, body: notes, teamId: rel.team_id as string });
      stmts.push(...d.stmts, q("UPDATE releases SET notes_doc_id = ? WHERE id = ?", d.id, id));
    }
  }
  stmts.push(
    q("UPDATE releases SET status = ?, deployed_at = CASE WHEN ? = 'live' THEN ? ELSE deployed_at END, updated_at = ? WHERE id = ?", status, status, ctx.now, ctx.now, id),
    logChange(ctx, "release", id, "update"),
  );
  await ctx.db.batch(stmts);
}

const loadRelease = async (ctx: Ctx, id: string) => releaseShape((await first(ctx.db, q(`${RELEASE_ROW} WHERE r.id = ?`, id)))!);

const DECISION_ROW = `SELECT d.*, t.key AS team_key, t.name AS team_name, it.key || '-' || i.number AS issue_ident, i.title AS issue_title,
  a.name AS asked_by, a.kind AS asked_by_kind, b.name AS answered_by
FROM decisions d JOIN teams t ON t.id = d.team_id LEFT JOIN issues i ON i.id = d.issue_id LEFT JOIN teams it ON it.id = i.team_id
LEFT JOIN actors a ON a.id = d.asked_by_id LEFT JOIN actors b ON b.id = d.answered_by_id`;

/**
 * A decision's question in one sentence, for lists and headings: the asker's own title, else the last sentence of the
 * text that ends in a question mark, else its first line. Markdown marks are dropped; nothing is cut short.
 */
export function shortQuestion(question: string, title?: string | null): string {
  if (title?.trim()) return title.trim();
  const plain = question.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`#>]+/g, "");
  // A sentence ends at . ! or ? followed by a space, so "Mag 1.6.63 op test.example.com?" stays one sentence.
  const sentences = plain
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim().replace(/^([-•]|\d+[.)])\s+/, ""))
    .filter(Boolean);
  return sentences.filter((s) => s.length > 3 && s.endsWith("?")).at(-1) ?? sentences[0] ?? "";
}

const decisionShape = (d: Record<string, unknown>) => ({
  id: d.id, kind: d.kind, title: shortQuestion(d.question as string, d.title as string | null), question: d.question, options: JSON.parse(d.options as string) as string[], recommendation: d.recommendation ?? null,
  status: d.status, answer: d.answer ?? null, team: d.team_name, teamKey: d.team_key, issue: d.issue_ident ?? null, issueTitle: d.issue_title ?? null,
  askedBy: d.asked_by ?? null, askedByKind: d.asked_by_kind ?? null, answeredBy: d.answered_by ?? null, answeredAt: d.answered_at ?? null, createdAt: d.created_at,
});
const loadDecision = async (ctx: Ctx, id: string) => {
  const d = await first(ctx.db, q(`${DECISION_ROW} WHERE d.id = ?`, id));
  if (!d) throw new Fail(`No decision ${JSON.stringify(id)}`, 404, "not_found");
  return decisionShape(d);
};

export const MAX_FILE = 25 * 1024 * 1024;

/** Stores a file and records it as an attachment (optionally on an issue, comment or document). */
export async function storeFile(ctx: Ctx, f: { name: string; mime: string | null; bytes: ArrayBuffer; issue?: string; comment?: string; document?: string }) {
  if (f.bytes.byteLength > MAX_FILE) throw new Fail("Files are limited to 25 MB", 413, "too_large");
  const issueId = f.issue ? (await R.issue(ctx, f.issue)).id : null;
  const id = uid();
  const key = `files/${id}`;
  await ctx.blobs.put(key, f.bytes, f.mime);
  await ctx.db.batch([
    q(
      "INSERT INTO attachments (id, issue_id, comment_id, doc_id, blob_key, name, mime, size, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, issueId, f.comment ?? null, f.document ?? null, key, f.name, f.mime, f.bytes.byteLength, ctx.actor.id, ctx.now, ctx.now,
    ),
    logChange(ctx, "attachment", id, "create"),
  ]);
  const a = attachmentShape(ctx, (await first(ctx.db, q("SELECT * FROM attachments WHERE id = ?", id)))!);
  const img = f.mime?.startsWith("image/");
  return { ...a, markdown: `${img ? "!" : ""}[${f.name.replace(/[[\]]/g, "")}](/files/${id})` };
}

export const workflowOps = [
  op({
    name: "list_releases",
    description: "List releases, newest first, with how many attached issues are done.",
    input: z.strictObject({
      team: z.string().optional().describe("Team key, name or ID"),
      status: z.enum(["planned", "staging", "live", "rolled_back"]).optional(),
      limit: limit(),
    }),
    async run(ctx, inp) {
      const teamId = inp.team ? (await R.team(ctx, inp.team)).id : null;
      const rows = await ctx.db.all(
        q(`${RELEASE_ROW} WHERE r.archived_at IS NULL AND (? IS NULL OR r.team_id = ?) AND (? IS NULL OR r.status = ?) ORDER BY COALESCE(r.deployed_at, r.created_at) DESC LIMIT ?`,
          teamId, teamId, inp.status ?? null, inp.status ?? null, inp.limit ?? 50),
      );
      return { releases: rows.map(releaseShape) };
    },
  }),
  op({
    name: "save_release",
    description: "Create a release (team + version) or rename one (id + version). Pass status to move it, as set_release_status does.",
    input: z.strictObject({
      id: z.string().optional().describe("Release ID to update"),
      team: z.string().optional().describe("Team key, name or ID (required when creating)"),
      version: z.string().min(1).optional().describe("e.g. 1.6.62"),
      status: z.enum(["planned", "staging", "live", "rolled_back"]).optional(),
    }),
    async run(ctx, inp) {
      let rel: Record<string, unknown>;
      if (inp.id) {
        rel = await findRelease(ctx, inp.id, inp.team);
        if (inp.version && inp.version !== rel.version) {
          await ctx.db.batch([q("UPDATE releases SET version = ?, updated_at = ? WHERE id = ?", inp.version, ctx.now, rel.id), logChange(ctx, "release", rel.id as string, "update")]);
          rel = await findRelease(ctx, rel.id as string);
        }
      } else {
        if (!inp.team || !inp.version) throw new Fail("team and version are required when creating a release");
        const t = await R.team(ctx, inp.team);
        const r = await R.release(ctx, t.id, inp.version);
        if (r.stmts.length) await ctx.db.batch(r.stmts);
        rel = await findRelease(ctx, r.id);
      }
      if (inp.status) await setStatus(ctx, rel, inp.status);
      return loadRelease(ctx, rel.id as string);
    },
  }),
  op({
    name: "set_release_status",
    description:
      "Move a release: planned → staging → live | rolled_back. Going live moves every attached issue that is not done to Done, " +
      'comments "Live in vX" on each, stamps deployedAt and writes release notes.',
    input: z.strictObject({
      release: z.string().describe("Release ID or version"),
      team: z.string().optional().describe("Team key, name or ID; needed when the version exists in several teams"),
      status: z.enum(["planned", "staging", "live", "rolled_back"]),
    }),
    async run(ctx, inp) {
      const rel = await findRelease(ctx, inp.release, inp.team);
      await setStatus(ctx, rel, inp.status);
      return loadRelease(ctx, rel.id as string);
    },
  }),
  op({
    name: "ask_decision",
    description:
      "Ask the captain to decide (kind decide) or look at something (kind review). It lands in the captain inbox; only a human can answer. " +
      "Give options and your recommendation.",
    input: z.strictObject({
      title: z.string().trim().min(1).max(200).optional().describe("The question in one short sentence, shown as its heading (e.g. \"Ship 1.4 on Friday?\")"),
      question: markdown("The question, with enough context to answer without opening anything else").min(1),
      issue: z.string().optional().describe("Issue ID or identifier this is about"),
      team: z.string().optional().describe("Team key, name or ID (required without issue)"),
      kind: z.enum(["decide", "review"]).optional().describe("decide (default): pick an option. review: look at something and confirm"),
      options: z.array(z.string().min(1)).max(10).optional(),
      recommendation: z.string().optional(),
    }),
    async run(ctx, inp) {
      const issue = inp.issue ? await R.issue(ctx, inp.issue) : null;
      const teamId = inp.team ? (await R.team(ctx, inp.team)).id : issue?.team_id;
      if (!teamId) throw new Fail("team or issue is required");
      const id = uid();
      await ctx.db.batch([
        q(
          "INSERT INTO decisions (id, team_id, issue_id, kind, title, question, options, recommendation, asked_by_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          id, teamId, issue?.id ?? null, inp.kind ?? "decide", inp.title ?? null, inp.question, JSON.stringify(inp.options ?? []), inp.recommendation ?? null, ctx.actor.id, ctx.now, ctx.now,
        ),
        logChange(ctx, "decision", id, "create"),
      ]);
      return loadDecision(ctx, id);
    },
  }),
  op({
    name: "list_decisions",
    description: "List decisions; by default the open ones waiting on the captain, oldest first.",
    input: z.strictObject({
      status: z.enum(["open", "answered", "withdrawn", "all"]).optional(),
      team: z.string().optional(),
      issue: z.string().optional(),
      release: z.string().optional().describe("Release ID or version: only decisions on issues in that release (pass team with a version)"),
      limit: limit(),
    }),
    async run(ctx, inp) {
      const status = inp.status ?? "open";
      const teamId = inp.team ? (await R.team(ctx, inp.team)).id : null;
      const issueId = inp.issue ? (await R.issue(ctx, inp.issue)).id : null;
      const releaseId = inp.release ? ((await findRelease(ctx, inp.release, inp.team)).id as string) : null;
      const rows = await ctx.db.all(
        q(
          `${DECISION_ROW} WHERE (? = 'all' OR d.status = ?) AND (? IS NULL OR d.team_id = ?) AND (? IS NULL OR d.issue_id = ?)
           AND (? IS NULL OR i.release_id = ?)
           ORDER BY CASE WHEN d.status = 'open' THEN d.created_at END ASC, d.updated_at DESC LIMIT ?`,
          status, status, teamId, teamId, issueId, issueId, releaseId, releaseId, inp.limit ?? 50,
        ),
      );
      return { decisions: rows.map(decisionShape) };
    },
  }),
  op({
    name: "answer_decision",
    who: "human",
    description: "Answer an open decision (captain only). The answer is also posted on the linked issue.",
    input: z.strictObject({ id: z.string(), answer: markdown("The decision").min(1) }),
    async run(ctx, inp) {
      const d = await loadDecision(ctx, inp.id);
      if (d.status !== "open") throw new Fail(`This decision is already ${d.status}`, 409, "conflict");
      const stmts: Stmt[] = [
        q("UPDATE decisions SET status = 'answered', answer = ?, answered_by_id = ?, answered_at = ?, updated_at = ? WHERE id = ? AND status = 'open'", inp.answer, ctx.actor.id, ctx.now, ctx.now, inp.id),
        logChange(ctx, "decision", inp.id, "update"),
      ];
      const issueId = (await first<{ issue_id: string | null }>(ctx.db, q("SELECT issue_id FROM decisions WHERE id = ?", inp.id)))?.issue_id;
      if (issueId) {
        const quoted = (d.question as string).split("\n").map((l) => `> ${l}`).join("\n");
        stmts.push(...commentStmts(ctx, issueId, `**Decision:** ${inp.answer}\n\n${quoted}`).stmts, logChange(ctx, "issue", issueId, "update"));
      }
      await ctx.db.batch(stmts);
      return loadDecision(ctx, inp.id);
    },
  }),
  op({
    name: "withdraw_decision",
    description: "Withdraw an open decision that is no longer needed.",
    input: z.strictObject({ id: z.string(), reason: z.string().optional() }),
    async run(ctx, inp) {
      const d = await loadDecision(ctx, inp.id);
      if (d.status !== "open") throw new Fail(`This decision is already ${d.status}`, 409, "conflict");
      await ctx.db.batch([
        q("UPDATE decisions SET status = 'withdrawn', answer = ?, updated_at = ? WHERE id = ? AND status = 'open'", inp.reason ?? null, ctx.now, inp.id),
        logChange(ctx, "decision", inp.id, "update"),
      ]);
      return loadDecision(ctx, inp.id);
    },
  }),
  op({
    name: "search",
    description: "Full-text search over issues and comments in every app. An exact identifier (ENG-12) comes first.",
    input: z.strictObject({ query: z.string().min(1), team: z.string().optional(), limit: limit(100) }),
    async run(ctx, inp) {
      const teamId = inp.team ? (await R.team(ctx, inp.team)).id : null;
      const n = inp.limit ?? 20;
      const exact = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(inp.query.trim()) ? await R.issue(ctx, inp.query).catch(() => null) : null;
      const m = ftsQuery(inp.query);
      const [issues, comments] = m
        ? await Promise.all([
            ctx.db.all(
              q(
                `SELECT t.key || '-' || i.number AS id, i.title, s.name AS status, s.type AS statusType, snippet(issues_fts, -1, '**', '**', '…', 16) AS snippet
                 FROM issues_fts JOIN issues i ON i.rowid = issues_fts.rowid JOIN teams t ON t.id = i.team_id JOIN states s ON s.id = i.state_id
                 WHERE issues_fts MATCH ? AND i.archived_at IS NULL AND (? IS NULL OR i.team_id = ?) ORDER BY rank LIMIT ?`,
                m, teamId, teamId, n,
              ),
            ),
            ctx.db.all(
              q(
                `SELECT t.key || '-' || i.number AS issue, i.title AS issueTitle, c.id AS commentId, snippet(comments_fts, 0, '**', '**', '…', 16) AS snippet
                 FROM comments_fts JOIN comments c ON c.rowid = comments_fts.rowid JOIN issues i ON i.id = c.issue_id JOIN teams t ON t.id = i.team_id
                 WHERE comments_fts MATCH ? AND c.archived_at IS NULL AND (? IS NULL OR i.team_id = ?) ORDER BY rank LIMIT ?`,
                m, teamId, teamId, n,
              ),
            ),
          ])
        : [[], []];
      if (exact) {
        const id = R.ident(exact);
        const rest = (issues as { id: string }[]).filter((i) => i.id !== id);
        return { issues: [{ id, title: exact.title, status: null, statusType: exact.state_type, snippet: null }, ...rest], comments };
      }
      return { issues, comments };
    },
  }),
  op({
    name: "list_changes",
    description: "The change feed: every write after `after` (a syncId), oldest first, each with a full snapshot of the row.",
    input: z.strictObject({ after: z.number().int().min(0).optional(), limit: limit(1000) }),
    async run(ctx, inp) {
      const rows = await ctx.db.all<Record<string, unknown>>(
        q("SELECT sync_id, entity, entity_id, op, actor_id, at, data FROM changes WHERE sync_id > ? ORDER BY sync_id LIMIT ?", inp.after ?? 0, inp.limit ?? 500),
      );
      const last = (await first<{ s: number | null }>(ctx.db, q("SELECT max(sync_id) AS s FROM changes")))?.s ?? 0;
      return {
        changes: rows.map((r) => ({ syncId: r.sync_id, entity: r.entity, entityId: r.entity_id, op: r.op, actorId: r.actor_id, at: r.at, data: JSON.parse(r.data as string) })),
        last,
      };
    },
  }),
  op({
    name: "upload_file",
    description: "Upload a file (base64, max 25 MB), optionally attached to an issue. Returns a markdown link to paste into a description or comment.",
    input: z.strictObject({
      name: z.string().min(1).max(200),
      content: z.base64().describe("File content, base64"),
      mime: z.string().optional().describe("e.g. image/png"),
      issue: z.string().optional().describe("Issue ID or identifier to attach it to"),
    }),
    run: (ctx, inp) =>
      storeFile(ctx, { name: inp.name, mime: inp.mime ?? null, bytes: Uint8Array.from(atob(inp.content), (c) => c.charCodeAt(0)).buffer, issue: inp.issue }),
  }),
];
