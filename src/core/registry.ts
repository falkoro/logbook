// One registry, every surface: REST (/api/<name>), MCP (tools/call <name>), the CLI and the importer all run ops from here.
import { z } from "zod";
import { type Ctx, Fail } from "./ctx";

/** any: every authenticated actor. human: the captain only. importer: a human or a system token, never an agent. */
export type Who = "any" | "human" | "importer";

export type OpDef<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  input: S;
  who?: Who;
  run(ctx: Ctx, input: z.infer<S>): Promise<unknown>;
};

export const op = <S extends z.ZodType>(def: OpDef<S>): OpDef => def as unknown as OpDef;

export function allowed(def: OpDef, ctx: Ctx): boolean {
  const who = def.who ?? "any";
  return who === "any" || ctx.actor.kind === "human" || (who === "importer" && ctx.actor.kind === "system");
}

export async function runOp(ops: Map<string, OpDef>, name: string, ctx: Ctx, raw: unknown) {
  const def = ops.get(name);
  if (!def) throw new Fail(`Unknown operation: ${name}`, 404, "not_found");
  if (!allowed(def, ctx)) throw new Fail(`${name} needs a ${def.who === "human" ? "human" : "human or system"} login`, 403, "forbidden");
  const parsed = def.input.safeParse(raw ?? {});
  if (!parsed.success) throw new Fail(`Invalid input for ${name}:\n${z.prettifyError(parsed.error)}`);
  return def.run(ctx, parsed.data);
}

/** Only http(s): a stored `javascript:` link would run in the UI. */
export const httpUrl = () => z.url({ protocol: /^https?$/ });

// Shared input pieces, worded like Linear's MCP so agents carry over unchanged.
export const limit = (max = 250) => z.number().int().min(1).max(max).optional().describe(`Max results (default 50, max ${max})`);
export const markdown = (what: string) => z.string().describe(`${what} as Markdown. Use literal newlines, not escape sequences`);
export const patchOps = z
  .array(
    z.discriminatedUnion("op", [
      z.strictObject({ op: z.literal("replace"), old_string: z.string().min(1), new_string: z.string(), replace_all: z.boolean().optional() }),
      z.strictObject({ op: z.literal("insert_before"), anchor: z.string().min(1), text: z.string().min(1) }),
      z.strictObject({ op: z.literal("insert_after"), anchor: z.string().min(1), text: z.string().min(1) }),
      z.strictObject({ op: z.literal("prepend"), text: z.string().min(1) }),
      z.strictObject({ op: z.literal("append"), text: z.string().min(1) }),
      z.strictObject({ op: z.literal("replace_range"), from: z.string().min(1), to: z.string().min(1), new_string: z.string() }),
    ]),
  )
  .min(1)
  .max(50)
  .describe("Partial edits applied in order, atomically. Every anchor must match exactly once. Update only, instead of the full text");

export function applyPatch(text: string, ops: z.infer<typeof patchOps>): string {
  const show = (s: string) => JSON.stringify(s.slice(0, 80));
  // The single match of `needle` at or after `from`.
  const once = (needle: string, from = 0) => {
    const at = text.indexOf(needle, from);
    if (at < 0) throw new Fail(`Patch anchor not found: ${show(needle)}`);
    if (text.indexOf(needle, at + 1) >= 0) throw new Fail(`Patch anchor matches more than once: ${show(needle)}`);
    return at;
  };
  for (const p of ops) {
    if (p.op === "prepend") text = p.text + text;
    else if (p.op === "append") text = text + p.text;
    else if (p.op === "replace" && p.replace_all) {
      if (!text.includes(p.old_string)) throw new Fail(`Patch anchor not found: ${show(p.old_string)}`);
      text = text.split(p.old_string).join(p.new_string);
    } else if (p.op === "replace") {
      const at = once(p.old_string);
      text = text.slice(0, at) + p.new_string + text.slice(at + p.old_string.length);
    } else if (p.op === "insert_before") {
      const at = once(p.anchor);
      text = text.slice(0, at) + p.text + text.slice(at);
    } else if (p.op === "insert_after") {
      const at = once(p.anchor) + p.anchor.length;
      text = text.slice(0, at) + p.text + text.slice(at);
    } else {
      const start = once(p.from);
      const end = once(p.to, start + p.from.length);
      text = text.slice(0, start) + p.new_string + text.slice(end);
    }
  }
  return text;
}
