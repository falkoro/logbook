// The append-only change log. Every write batch ends with one logChange per touched row: a full-row
// snapshot taken in SQL after the write, so history can never drift from the data.
import { q, type Stmt } from "../db/db";
import type { Ctx } from "./ctx";

export const COLUMNS = {
  team: ["id", "key", "name", "next_number", "staging_url", "live_url", "created_at", "updated_at", "archived_at"],
  actor: ["id", "kind", "name", "email", "created_at", "updated_at", "archived_at"],
  state: ["id", "team_id", "name", "type", "color", "position", "created_at", "updated_at", "archived_at"],
  label: ["id", "team_id", "parent_id", "name", "color", "description", "is_group", "exclusive", "created_at", "updated_at", "archived_at"],
  doc: ["id", "team_id", "title", "body", "author_id", "created_at", "updated_at", "archived_at"],
  release: ["id", "team_id", "version", "status", "deployed_at", "notes_doc_id", "created_at", "updated_at", "archived_at"],
  issue: [
    "id", "team_id", "number", "title", "description", "state_id", "priority", "assignee_id", "creator_id", "parent_id", "release_id",
    "duplicate_of_id", "dedupe_key", "sort_order", "created_at", "updated_at", "started_at", "completed_at", "canceled_at", "archived_at",
  ],
  comment: ["id", "issue_id", "author_id", "body", "created_at", "updated_at", "archived_at"],
  attachment: ["id", "issue_id", "comment_id", "doc_id", "blob_key", "url", "name", "mime", "size", "author_id", "created_at", "updated_at", "archived_at"],
  decision: [
    "id", "team_id", "issue_id", "kind", "title", "question", "options", "recommendation", "asked_by_id", "status", "answer", "answered_by_id",
    "answered_at", "created_at", "updated_at",
  ],
  pr_link: ["id", "issue_id", "provider", "repo", "number", "url", "title", "state", "created_at", "updated_at"],
} as const;

export type Entity = keyof typeof COLUMNS;
export type Op = "create" | "update" | "archive" | "import";

export const TABLE: Record<Entity, string> = {
  team: "teams", actor: "actors", state: "states", label: "labels", doc: "docs", release: "releases", issue: "issues",
  comment: "comments", attachment: "attachments", decision: "decisions", pr_link: "pr_links",
};

export const logChange = (ctx: Ctx, entity: Entity, id: string, op: Op): Stmt => logWhere(ctx, entity, op, "id = ?", id);

/** Logs every row of `entity` matching `where` (set-based, for writes that touch many rows at once). */
export function logWhere(ctx: Ctx, entity: Entity, op: Op, where: string, ...params: unknown[]): Stmt {
  const t = TABLE[entity];
  const pairs = COLUMNS[entity].map((c) => `'${c}', ${t}.${c}`);
  if (entity === "issue") pairs.push(`'label_ids', json((SELECT json_group_array(label_id) FROM issue_labels WHERE issue_id = ${t}.id))`);
  return q(
    `INSERT INTO changes (entity, entity_id, op, actor_id, at, data) SELECT ?, id, ?, ?, ?, json_object(${pairs.join(", ")}) FROM ${t} WHERE ${where}`,
    entity, op, ctx.actor.id, ctx.now, ...params,
  );
}
