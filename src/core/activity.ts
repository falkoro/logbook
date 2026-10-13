// The readable activity feed: the change log as "who did what", each write diffed against the row's previous snapshot.
import { z } from "zod";
import { q } from "../db/db";
import { PRIORITY } from "./ctx";
import { limit, op } from "./registry";
import * as R from "./resolve";
import { shortQuestion } from "./workflow";

// Bookkeeping columns: a change that only touches these (a comment bumping its issue's updated_at) is not activity.
const QUIET = new Set(["updated_at", "created_at", "sort_order", "started_at", "completed_at", "canceled_at", "next_number", "number", "dedupe_key"]);
const ISSUE_CHILDREN = ["comment", "pr_link", "decision", "attachment"];

type Change = { field: string; from: unknown; to: unknown };
type Names = {
  actors: Map<string, { name: string; kind: string }>; states: Map<string, string>; releases: Map<string, string>; labels: Map<string, string>; issues: Map<string, string>;
  cut: (v: unknown) => unknown;
};

const clip = (v: unknown) => (typeof v === "string" && v.length > 280 ? `${v.slice(0, 279)}…` : v);
const whole = (v: unknown) => v;
const field = (k: string) => ({ state_id: "status", assignee_id: "assignee", release_id: "release", parent_id: "parent", label_ids: "labels", duplicate_of_id: "duplicateOf", archived_at: "archived" })[k]
  ?? k.replace(/_id$/, "").replace(/_(\w)/g, (_, c: string) => c.toUpperCase());

function value(k: string, v: unknown, n: Names): unknown {
  if (v == null) return null;
  if (k === "state_id") return n.states.get(v as string) ?? v;
  if (k === "assignee_id" || k.endsWith("by_id") || k === "author_id" || k === "creator_id") return n.actors.get(v as string)?.name ?? v;
  if (k === "release_id") return n.releases.get(v as string) ?? v;
  if (k === "parent_id" || k === "duplicate_of_id") return n.issues.get(v as string) ?? v;
  if (k === "label_ids") return (JSON.parse(typeof v === "string" ? v : JSON.stringify(v)) as string[]).map((id) => n.labels.get(id) ?? id).sort();
  if (k === "priority") return PRIORITY[v as number] ?? v;
  if (k === "archived_at") return true;
  return n.cut(v);
}

function diff(prev: Record<string, unknown> | null, cur: Record<string, unknown>, n: Names): Change[] {
  if (!prev) return [];
  const out: Change[] = [];
  for (const k of Object.keys(cur)) {
    if (QUIET.has(k) || JSON.stringify(prev[k] ?? null) === JSON.stringify(cur[k] ?? null)) continue;
    const from = value(k, prev[k], n), to = value(k, cur[k], n);
    if (k === "archived_at") out.push({ field: "archived", from: from ?? false, to: to ?? false });
    else out.push({ field: field(k), from: k === "description" || k === "body" ? undefined : from, to: k === "description" || k === "body" ? undefined : to });
  }
  return out;
}

const ask = (d: Record<string, unknown>) => shortQuestion(String(d.question ?? ""), d.title as string | null);

/** One line a person or agent can read: "moved ENG-12 to In Progress". */
function summarize(entity: string, opName: string, d: Record<string, unknown>, changes: Change[], issue: string | null): string {
  const on = issue ? ` ${issue}` : "";
  switch (entity) {
    case "issue": {
      if (opName === "create" || opName === "import") return `created${on}`;
      if (opName === "archive") return `archived${on}`;
      if (changes.length !== 1) return `updated${on}: ${changes.map((c) => c.field).join(", ")}`;
      const [c] = changes as [Change];
      switch (c.field) {
        case "status": return `moved${on} to ${c.to}`;
        case "assignee": return c.to ? `assigned${on} to ${c.to}` : `unassigned${on}`;
        case "priority": return `set${on} to ${c.to} priority`;
        case "labels": {
          const was = new Set(c.from as string[]), now = new Set(c.to as string[]);
          const parts = [...[...now].filter((l) => !was.has(l)).map((l) => `+${l}`), ...[...was].filter((l) => !now.has(l)).map((l) => `−${l}`)];
          return `labelled${on} ${parts.join(" ")}`;
        }
        case "title": return `renamed${on} to “${c.to}”`;
        case "description": return `edited the description of${on}`;
        case "release": return c.to ? `put${on} in ${c.to}` : `took${on} out of its release`;
        case "parent": return c.to ? `made${on} a sub-issue of ${c.to}` : `detached${on} from its parent`;
        case "archived": return c.to ? `archived${on}` : `restored${on}`;
        default: return `changed ${c.field} on${on}`;
      }
    }
    case "comment": return opName === "archive" ? `deleted a comment on${on}` : opName === "update" ? `edited a comment on${on}` : `commented on${on}`;
    case "attachment": return `attached ${d.name ?? "a file"} to${on}`;
    case "pr_link": return opName === "update" ? `${d.repo}#${d.number} is ${d.state}` : `linked ${d.repo}#${d.number} to${on}`;
    case "decision":
      if (d.status === "answered" && opName !== "create") return `answered “${ask(d)}”: ${clip(d.answer)}`;
      if (d.status === "withdrawn" && opName !== "create") return `withdrew “${ask(d)}”`;
      return `asked “${ask(d)}”${issue ? ` on${on}` : ""}`;
    case "release": {
      const s = changes.find((c) => c.field === "status");
      return s ? `set ${d.version} to ${s.to}` : opName === "update" ? `updated release ${d.version}` : `planned release ${d.version}`;
    }
    case "doc": return `${opName === "update" ? "edited" : opName === "archive" ? "archived" : "wrote"} “${d.title}”`;
    default: return `${opName === "create" ? "added" : opName === "archive" ? "archived" : "updated"} ${entity} ${d.name ?? d.key ?? ""}`.trim();
  }
}

const NL_FIELD: Record<string, string> = {
  status: "status", assignee: "toegewezen", priority: "prioriteit", labels: "labels", title: "titel", description: "beschrijving",
  release: "release", parent: "parent", archived: "archief", duplicateOf: "duplicaat",
};
const NL_PRIORITY: Record<string, string> = { "No priority": "geen", Urgent: "urgent", High: "hoog", Medium: "normaal", Low: "laag" };
const NL_ENTITY: Record<string, string> = { team: "app", actor: "bemanningslid", label: "label", state: "status", token: "token" };

/** The same line in Dutch, for `list_activity` with `lang: "nl"`: "zette ENG-12 op In Progress". Status names stay as the team calls them. */
function summarizeNl(entity: string, opName: string, d: Record<string, unknown>, changes: Change[], issue: string | null): string {
  const on = issue ? ` ${issue}` : "";
  switch (entity) {
    case "issue": {
      if (opName === "create" || opName === "import") return `maakte${on} aan`;
      if (opName === "archive") return `archiveerde${on}`;
      if (changes.length !== 1) return `wijzigde${on}: ${changes.map((c) => NL_FIELD[c.field] ?? c.field).join(", ")}`;
      const [c] = changes as [Change];
      switch (c.field) {
        case "status": return `zette${on} op ${c.to}`;
        case "assignee": return c.to ? `wees${on} toe aan ${c.to}` : `haalde de toewijzing van${on} weg`;
        case "priority": return `gaf${on} prioriteit ${NL_PRIORITY[c.to as string] ?? c.to}`;
        case "labels": {
          const was = new Set(c.from as string[]), now = new Set(c.to as string[]);
          const parts = [...[...now].filter((l) => !was.has(l)).map((l) => `+${l}`), ...[...was].filter((l) => !now.has(l)).map((l) => `−${l}`)];
          return `wijzigde de labels van${on}: ${parts.join(" ")}`;
        }
        case "title": return `hernoemde${on} naar “${c.to}”`;
        case "description": return `bewerkte de beschrijving van${on}`;
        case "release": return c.to ? `zette${on} in release ${c.to}` : `haalde${on} uit de release`;
        case "parent": return c.to ? `maakte${on} een sub-issue van ${c.to}` : `maakte${on} los van de parent`;
        case "archived": return c.to ? `archiveerde${on}` : `zette${on} terug uit het archief`;
        default: return `wijzigde ${NL_FIELD[c.field] ?? c.field} van${on}`;
      }
    }
    case "comment": return opName === "archive" ? `verwijderde een reactie op${on}` : opName === "update" ? `bewerkte een reactie op${on}` : `reageerde op${on}`;
    case "attachment": return `voegde ${d.name ?? "een bestand"} toe aan${on}`;
    case "pr_link": return opName === "update" ? `${d.repo}#${d.number} is ${d.state}` : `koppelde ${d.repo}#${d.number} aan${on}`;
    case "decision":
      if (d.status === "answered" && opName !== "create") return `besloot over “${ask(d)}”: ${d.answer}`;
      if (d.status === "withdrawn" && opName !== "create") return `trok “${ask(d)}” in`;
      return `vroeg “${ask(d)}”${issue ? ` op${on}` : ""}`;
    case "release": {
      const s = changes.find((c) => c.field === "status");
      return s ? `zette ${d.version} op ${s.to}` : opName === "update" ? `werkte release ${d.version} bij` : `plande release ${d.version}`;
    }
    case "doc": return `${opName === "update" ? "bewerkte" : opName === "archive" ? "archiveerde" : "schreef"} “${d.title}”`;
    default: {
      const what = `${NL_ENTITY[entity] ?? entity} ${d.name ?? d.key ?? ""}`.trim();
      return opName === "create" ? `voegde ${what} toe` : opName === "archive" ? `archiveerde ${what}` : `wijzigde ${what}`;
    }
  }
}

export const activityOps = [
  op({
    name: "list_activity",
    description:
      "What happened, newest first: one readable event per write with who did it, a one-line summary and the changed fields (from → to). " +
      "Filter by actor, issue or team. Page back with `before`, or pass `after` (a syncId) to get everything since then, oldest first.",
    input: z.strictObject({
      actor: z.string().optional().describe("Actor name, email, ID or 'me'"),
      issue: z.string().optional().describe("Issue ID or identifier (e.g. ENG-123): its own changes plus comments, PRs, decisions and files on it"),
      team: z.string().optional().describe("Team key, name or ID"),
      before: z.number().int().optional().describe("Only events with a syncId below this (paging back)"),
      after: z.number().int().optional().describe("Only events with a syncId above this, oldest first (catching up)"),
      includeImports: z.boolean().optional().describe("Include rows written by imports (default false)"),
      lang: z.enum(["en", "nl"]).optional().describe("Language of the summaries (default en)"),
      full: z.boolean().optional().describe("Comment bodies and changed values in full instead of clipped at 280 characters"),
      limit: limit(200),
    }),
    async run(ctx, inp) {
      const actorId = inp.actor ? (await R.actor(ctx, inp.actor)).id : null;
      const issueId = inp.issue ? (await R.issue(ctx, inp.issue)).id : null;
      const teamId = inp.team ? (await R.team(ctx, inp.team)).id : null;
      const n = inp.limit ?? 50;
      // An issue's history uses the (entity, entity_id) index; the team filter scans newest-first until the page fills.
      // ponytail: team filter is a scan, add a team_id column to changes if team pages get slow.
      const rows = await ctx.db.all<Record<string, any>>(
        q(
          `SELECT c.sync_id, c.entity, c.entity_id, c.op, c.at, c.actor_id, c.data,
             (SELECT p.data FROM changes p WHERE p.entity = c.entity AND p.entity_id = c.entity_id AND p.sync_id < c.sync_id ORDER BY p.sync_id DESC LIMIT 1) AS prev,
             i.id AS issue_uuid, t.key || '-' || i.number AS ident, i.title AS issue_title
           FROM changes c
           LEFT JOIN issues i ON i.id = CASE WHEN c.entity = 'issue' THEN c.entity_id WHEN c.entity IN ('comment', 'pr_link', 'decision', 'attachment') THEN json_extract(c.data, '$.issue_id') END
           LEFT JOIN teams t ON t.id = i.team_id
           WHERE (? OR c.op != 'import')
             AND (? IS NULL OR c.actor_id = ?)
             AND (? IS NULL OR (c.entity IN ('issue', ${ISSUE_CHILDREN.map(() => "?").join(", ")}) AND c.entity_id IN (
               SELECT ? UNION ALL SELECT id FROM comments WHERE issue_id = ? UNION ALL SELECT id FROM pr_links WHERE issue_id = ?
               UNION ALL SELECT id FROM decisions WHERE issue_id = ? UNION ALL SELECT id FROM attachments WHERE issue_id = ?)))
             AND (? IS NULL OR coalesce(i.team_id, json_extract(c.data, '$.team_id')) = ?)
             AND (? IS NULL OR c.sync_id < ?) AND (? IS NULL OR c.sync_id > ?)
           ORDER BY c.sync_id ${inp.after != null ? "ASC" : "DESC"} LIMIT ?`,
          inp.includeImports ? 1 : 0, actorId, actorId, issueId, ...ISSUE_CHILDREN, issueId, issueId, issueId, issueId, issueId,
          teamId, teamId, inp.before ?? null, inp.before ?? null, inp.after ?? null, inp.after ?? null, n,
        ),
      );
      const parsed = rows.map((r) => ({ r, cur: JSON.parse(r.data) as Record<string, unknown>, prev: r.prev ? (JSON.parse(r.prev) as Record<string, unknown>) : null }));
      const refIds = [...new Set(parsed.flatMap(({ cur, prev }) => [cur.parent_id, prev?.parent_id, cur.duplicate_of_id, prev?.duplicate_of_id]).filter(Boolean))];
      const [actors, states, releases, labels, issues] = await Promise.all([
        ctx.db.all<{ id: string; name: string; kind: string }>(q("SELECT id, name, kind FROM actors")),
        ctx.db.all<{ id: string; name: string }>(q("SELECT id, name FROM states")),
        ctx.db.all<{ id: string; version: string }>(q("SELECT id, version FROM releases")),
        ctx.db.all<{ id: string; name: string }>(q("SELECT id, name FROM labels")),
        ctx.db.all<{ id: string; ident: string }>(
          q("SELECT i.id, t.key || '-' || i.number AS ident FROM issues i JOIN teams t ON t.id = i.team_id WHERE i.id IN (SELECT value FROM json_each(?))", JSON.stringify(refIds)),
        ),
      ]);
      const names: Names = {
        actors: new Map(actors.map((a) => [a.id, a])),
        states: new Map(states.map((s) => [s.id, s.name])),
        releases: new Map(releases.map((r) => [r.id, r.version])),
        labels: new Map(labels.map((l) => [l.id, l.name])),
        issues: new Map(issues.map((i) => [i.id, i.ident])),
        cut: inp.full ? whole : clip,
      };
      const say = inp.lang === "nl" ? summarizeNl : summarize;
      const events = [];
      for (const { r, cur, prev } of parsed) {
        const changes = r.op === "update" || r.op === "archive" ? diff(prev, cur, names) : [];
        if (r.op === "update" && !changes.length) continue;
        const a = r.actor_id ? names.actors.get(r.actor_id) : undefined;
        events.push({
          syncId: r.sync_id as number,
          at: r.at as string,
          actor: a ? { id: r.actor_id as string, name: a.name, kind: a.kind } : null,
          entity: r.entity as string,
          entityId: r.entity_id as string,
          op: r.op as string,
          issue: r.ident ? { id: r.ident as string, uuid: r.issue_uuid as string, title: r.issue_title as string } : null,
          summary: say(r.entity, r.op, cur, changes, (r.ident as string | null) ?? null),
          changes,
          ...(r.entity === "comment" && r.op !== "archive" ? { body: names.cut(cur.body) } : {}),
        });
      }
      const last = rows.at(-1)?.sync_id as number | undefined;
      return { events, next: rows.length === n ? (last ?? null) : null };
    },
  }),
];
