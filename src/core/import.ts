// Raw upserts for the Linear importer: rows keep their ids (so a re-import updates), history is written as it was,
// and no rule fires. The database's own constraints (NOT NULL, CHECK, foreign keys) validate every row.
// A system token can write history as anyone, but never gains rights: an existing actor's kind and email are never
// changed (an agent's token must not become a human's, and the email is what an Access login maps to), only a human
// can write an answered decision, import never touches one the captain already answered, and links pass the same
// http(s) check as save_issue and link_pr. An attachment row may carry its file (base64 `content`); it is stored under
// the attachment's own id, so a re-import overwrites the same file instead of adding a copy.
import { z } from "zod";
import { q, type Stmt } from "../db/db";
import { Fail } from "./ctx";
import { COLUMNS, type Entity, TABLE, logChange } from "./log";
import { httpUrl, op } from "./registry";
import { MAX_FILE } from "./workflow";

const cell = z.union([z.string(), z.number(), z.null()]);
const rowSchema = (entity: Entity) =>
  z.strictObject({
    ...Object.fromEntries(COLUMNS[entity].map((c) => [c, cell.optional()])),
    id: z.string().min(1),
    ...(entity === "issue" ? { label_ids: z.array(z.string()).optional() } : {}),
    ...(entity === "attachment"
      ? { url: z.union([httpUrl(), z.string().regex(/^\/(files|doc|issue)\/[\w-]+$/)]).nullable().optional(), content: z.base64().optional() }
      : {}),
    ...(entity === "pr_link" ? { url: httpUrl().optional() } : {}),
  });

const entities = Object.keys(COLUMNS) as [Entity, ...Entity[]];

export const importOps = [
  op({
    name: "import_rows",
    who: "importer",
    description:
      "Upsert raw rows by id, written as they were (no rules fire, numbers and timestamps kept). Order parents first: team, actor, state, label (groups first), doc, release, issue, comment, attachment, decision, pr_link.",
    input: z.strictObject({ entity: z.enum(entities), rows: z.array(z.record(z.string(), z.unknown())).min(1).max(100) }),
    async run(ctx, inp) {
      const schema = rowSchema(inp.entity);
      const t = TABLE[inp.entity];
      const stmts: Stmt[] = [];
      const teams = new Set<string>();
      const files: [string, ArrayBuffer, string | null][] = [];
      for (const raw of inp.rows) {
        const parsed = schema.safeParse(raw);
        if (!parsed.success) throw new Fail(`Invalid input for ${inp.entity} row ${String(raw.id)}:\n${z.prettifyError(parsed.error)}`);
        const { label_ids, content, ...row } = parsed.data as Record<string, unknown> & { label_ids?: string[]; content?: string };
        if (content !== undefined) {
          const bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0)).buffer;
          if (bytes.byteLength > MAX_FILE) throw new Fail(`File ${String(row.id)} is over 25 MB`, 413, "too_large");
          Object.assign(row, { blob_key: `files/${row.id}`, size: bytes.byteLength });
          files.push([`files/${row.id}`, bytes, (row.mime as string | null) ?? null]);
        }
        if (inp.entity === "decision" && ctx.actor.kind !== "human" && (row.status === "answered" || row.answered_by_id || row.answer)) {
          throw new Fail("Only a human can import an answered decision", 403, "forbidden");
        }
        const cols = Object.keys(row);
        const keep = inp.entity === "actor" ? ["id", "kind", "email"] : ["id"];
        // Linear still shows a decision open after the captain answered it here; a re-import must not reopen or reword it.
        const guard = inp.entity === "decision" ? ` WHERE ${t}.status <> 'answered'` : "";
        stmts.push(
          q(
            `INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
             ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => !keep.includes(c)).map((c) => `${c} = excluded.${c}`).join(", ") || "id = id"}${guard}`,
            ...cols.map((c) => row[c]),
          ),
        );
        if (label_ids) {
          stmts.push(
            q("DELETE FROM issue_labels WHERE issue_id = ?", row.id),
            q("INSERT INTO issue_labels (issue_id, label_id) SELECT ?, value FROM json_each(?)", row.id, JSON.stringify(label_ids)),
          );
        }
        if (typeof row.team_id === "string" && inp.entity === "issue") teams.add(row.team_id);
        stmts.push(logChange(ctx, inp.entity, row.id as string, "import"));
      }
      // Numbering carries on after the highest imported number.
      for (const team of teams) {
        stmts.push(q("UPDATE teams SET next_number = max(next_number, (SELECT COALESCE(max(number), 0) + 1 FROM issues WHERE team_id = ?)) WHERE id = ?", team, team));
      }
      for (const [key, bytes, mime] of files) await ctx.blobs.put(key, bytes, mime);
      // The database is the validator here, so its refusal is the caller's error, not ours.
      await ctx.db.batch(stmts).catch((e: Error) => {
        throw new Fail(`Import of ${inp.entity} rows failed (nothing written): ${e.message}`);
      });
      return { entity: inp.entity, upserted: inp.rows.length };
    },
  }),
];
