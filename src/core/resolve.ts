// Name → row lookups shared by every op. Accept what Linear's MCP accepts (ID, name, key, email, "me", "ENG-12").
import { first, q, type Stmt } from "../db/db";
import { type Actor, type Ctx, Fail, uid } from "./ctx";
import { logChange } from "./log";

export type Team = { id: string; key: string; name: string };
export type State = { id: string; team_id: string; name: string; type: string; position: number };
export type Label = { id: string; name: string; parent_id: string | null; exclusive: number; group_name: string | null };
export type IssueRef = { id: string; team_id: string; number: number; key: string; state_type: string; title: string; description: string };

const ISSUE_KEY = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;
export const DONE_TYPES = ["completed", "canceled", "duplicate"];

export async function team(ctx: Ctx, ref: string): Promise<Team> {
  const t = await first<Team>(
    ctx.db,
    q("SELECT id, key, name FROM teams WHERE id = ? OR lower(key) = lower(?) OR lower(name) = lower(?) ORDER BY archived_at IS NOT NULL LIMIT 1", ref, ref, ref),
  );
  if (!t) throw new Fail(`No team ${JSON.stringify(ref)}`, 404, "not_found");
  return t;
}

export async function state(ctx: Ctx, teamId: string, ref: string): Promise<State> {
  const s = await first<State>(
    ctx.db,
    q(
      `SELECT id, team_id, name, type, position FROM states WHERE team_id = ? AND archived_at IS NULL AND (id = ? OR lower(name) = lower(?) OR type = lower(?))
       ORDER BY id = ? DESC, lower(name) = lower(?) DESC, position LIMIT 1`,
      teamId, ref, ref, ref, ref, ref,
    ),
  );
  if (!s) throw new Fail(`No state ${JSON.stringify(ref)} in this team`, 404, "not_found");
  return s;
}

/** First state of the first present type, by position. */
export async function stateOfType(ctx: Ctx, teamId: string, ...types: string[]): Promise<State | null> {
  const rows = await ctx.db.all<State>(
    q("SELECT id, team_id, name, type, position FROM states WHERE team_id = ? AND archived_at IS NULL ORDER BY position", teamId),
  );
  for (const t of types) {
    const s = rows.find((r) => r.type === t);
    if (s) return s;
  }
  return null;
}

export async function actor(ctx: Ctx, ref: string): Promise<Actor> {
  if (ref.toLowerCase() === "me") return ctx.actor;
  const a = await first<Actor>(
    ctx.db,
    q("SELECT id, kind, name, email FROM actors WHERE id = ? OR lower(email) = lower(?) OR lower(name) = lower(?) LIMIT 1", ref, ref, ref),
  );
  if (!a) throw new Fail(`No user ${JSON.stringify(ref)}`, 404, "not_found");
  return a;
}

const ISSUE_SELECT = `SELECT i.id, i.team_id, i.number, t.key, s.type AS state_type, i.title, i.description
  FROM issues i JOIN teams t ON t.id = i.team_id JOIN states s ON s.id = i.state_id`;

export async function issue(ctx: Ctx, ref: string): Promise<IssueRef> {
  const m = ISSUE_KEY.exec(ref.trim());
  const row = m
    ? await first<IssueRef>(ctx.db, q(`${ISSUE_SELECT} WHERE lower(t.key) = lower(?) AND i.number = ?`, m[1], Number(m[2])))
    : await first<IssueRef>(ctx.db, q(`${ISSUE_SELECT} WHERE i.id = ?`, ref));
  if (!row) throw new Fail(`No issue ${JSON.stringify(ref)}`, 404, "not_found");
  return row;
}

export const ident = (r: { key: string; number: number }) => `${r.key}-${r.number}`;

const LABEL_SELECT = `SELECT l.id, l.name, l.parent_id, COALESCE(g.exclusive, 0) AS exclusive, g.name AS group_name
  FROM labels l LEFT JOIN labels g ON g.id = l.parent_id`;

/**
 * Labels usable on an issue in `teamId`: the team's own and workspace-wide ones, never a group.
 * "Group/Child" picks a child when a bare name is ambiguous. An unknown name is an error, never auto-created.
 */
export async function labels(ctx: Ctx, teamId: string, refs: string[]): Promise<Label[]> {
  if (!refs.length) return [];
  const pool = await ctx.db.all<Label & { team_id: string | null }>(
    q(`${LABEL_SELECT} WHERE l.archived_at IS NULL AND l.is_group = 0 AND (l.team_id IS NULL OR l.team_id = ?)`, teamId),
  );
  const out = new Map<string, Label>();
  for (const ref of refs) {
    let hits = pool.filter((l) => l.id === ref);
    if (!hits.length) {
      const slash = ref.lastIndexOf("/");
      const [grp, name] = slash > 0 ? [ref.slice(0, slash), ref.slice(slash + 1)] : [null, ref];
      hits = pool.filter(
        (l) => l.name.toLowerCase() === name.toLowerCase() && (grp === null || l.group_name?.toLowerCase() === grp.toLowerCase()),
      );
      if (grp === null && hits.length === 0) hits = pool.filter((l) => l.name.toLowerCase() === ref.toLowerCase());
      // Prefer the team's own label over a workspace one of the same name.
      if (hits.length > 1) {
        const own = hits.filter((l) => l.team_id === teamId);
        if (own.length === 1) hits = own;
      }
    }
    if (hits.length === 0) throw new Fail(`No label ${JSON.stringify(ref)} (create it with save_issue_label first)`, 404, "not_found");
    if (hits.length > 1) {
      throw new Fail(`Label ${JSON.stringify(ref)} is ambiguous; use one of ${hits.map((h) => JSON.stringify(`${h.group_name}/${h.name}`)).join(", ")}`);
    }
    out.set(hits[0]!.id, hits[0]!);
  }
  return [...out.values()];
}

/** Fails when a set holds two children of one exclusive group. */
export function checkExclusive(set: Label[]) {
  const seen = new Map<string, Label>();
  for (const l of set) {
    if (!l.exclusive || !l.parent_id) continue;
    const other = seen.get(l.parent_id);
    if (other) throw new Fail(`Labels ${JSON.stringify(other.name)} and ${JSON.stringify(l.name)} are both in the single-choice group ${JSON.stringify(l.group_name)}`);
    seen.set(l.parent_id, l);
  }
}

export const currentLabels = (ctx: Ctx, issueId: string) =>
  ctx.db.all<Label>(q(`${LABEL_SELECT} JOIN issue_labels il ON il.label_id = l.id WHERE il.issue_id = ?`, issueId));

/** The single-choice "Project" label group: Linear projects map onto its children. */
export async function project(ctx: Ctx, teamId: string, name: string): Promise<Label> {
  const [l] = await labels(ctx, teamId, [`Project/${name}`]).catch(() => {
    throw new Fail(`No project ${JSON.stringify(name)} (projects are children of the "Project" label group)`, 404, "not_found");
  });
  return l!;
}

/** A team's release by id or version; created as planned when it does not exist yet. */
export async function release(ctx: Ctx, teamId: string, ref: string): Promise<{ id: string; stmts: Stmt[] }> {
  const r = await first<{ id: string }>(ctx.db, q("SELECT id FROM releases WHERE team_id = ? AND (id = ? OR version = ?)", teamId, ref, ref));
  if (r) return { id: r.id, stmts: [] };
  const id = uid();
  return {
    id,
    stmts: [
      q("INSERT INTO releases (id, team_id, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", id, teamId, ref, ctx.now, ctx.now),
      logChange(ctx, "release", id, "create"),
    ],
  };
}
