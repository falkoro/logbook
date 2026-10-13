// MCP over plain HTTP: stateless JSON-RPC on POST /mcp (tools only). Tool names and inputs follow Linear's MCP.
import { z } from "zod";
import { type Ctx, Fail } from "../core/ctx";
import { OPS } from "../core/ops";
import { allowed, runOp } from "../core/registry";

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS =
  "Logbook is the issue tracker for every app (one team per app, identifiers like ENG-123). Tools follow Linear's MCP: list_issues, get_issue, " +
  "save_issue, save_comment, list_comments, list_issue_statuses, list_issue_labels. Ask the captain with ask_decision instead of guessing. " +
  "A merged PR never closes an issue; set_release_status live does. Send Markdown with literal newlines.";

const schemas = new Map<string, unknown>();
const schemaOf = (name: string) => {
  if (!schemas.has(name)) {
    const { $schema: _, ...s } = z.toJSONSchema(OPS.get(name)!.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    schemas.set(name, s);
  }
  return schemas.get(name);
};

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

/** One JSON-RPC message in, the reply out (null for a notification, which gets 202). */
export async function handleMcp(ctx: Ctx, msg: Rpc): Promise<object | null> {
  if (msg.id === undefined || msg.id === null) return null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return ok({
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "logbook", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: [...OPS.values()].filter((o) => allowed(o, ctx)).map((o) => ({ name: o.name, description: o.description, inputSchema: schemaOf(o.name) })),
      });
    case "tools/call": {
      const name = msg.params?.name;
      if (typeof name !== "string" || !OPS.has(name)) return err(-32602, `Unknown tool: ${name}`);
      try {
        const out = await runOp(OPS, name, ctx, msg.params?.arguments ?? {});
        return ok({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out });
      } catch (e) {
        if (e instanceof Fail) return ok({ content: [{ type: "text", text: e.message }], isError: true });
        throw e;
      }
    }
    default:
      return err(-32601, `Method not found: ${msg.method}`);
  }
}
