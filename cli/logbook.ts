#!/usr/bin/env bun
// logbook <op> [json | --field value ...]   run any op; output is JSON
// logbook ops                              list the ops and what they do
// logbook upload <file> [--issue ENG-12]   upload a file, print its markdown link
// Needs LOGBOOK_URL and LOGBOOK_TOKEN. A --field value is parsed as JSON when it parses ("3", "true", "[...]"), else kept as text.
import { client } from "./client";

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "help" || cmd === "--help") {
  console.log((await Bun.file(import.meta.path).text()).split("\n").slice(1, 5).map((l) => l.slice(3)).join("\n"));
  process.exit(cmd ? 0 : 1);
}

function input(args: string[]): Record<string, unknown> {
  if (args.length === 1 && /^\s*[{[]/.test(args[0]!)) return JSON.parse(args[0]!);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const key = /^--(.+)$/.exec(args[i]!)?.[1];
    if (!key) throw new Error(`Expected --field value, got ${args[i]}`);
    const raw = args[++i] ?? "true";
    try {
      out[key] = JSON.parse(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

try {
  if (cmd === "ops") {
    const spec = (await (await fetch(`${process.env.LOGBOOK_URL?.replace(/\/+$/, "")}/openapi.json`)).json()) as any;
    for (const [path, item] of Object.entries<any>(spec.paths)) console.log(`${path.replace("/api/", "").padEnd(22)} ${item.post?.summary ?? ""}`);
  } else if (cmd === "upload") {
    const [file, ...more] = rest;
    if (!file) throw new Error("logbook upload <file> [--issue ENG-12]");
    const f = Bun.file(file);
    const bytes = Buffer.from(await f.arrayBuffer()).toString("base64");
    const out = await client()("upload_file", { name: file.split("/").pop(), content: bytes, mime: f.type.split(";")[0], ...input(more) });
    console.log(out.markdown);
  } else {
    console.log(JSON.stringify(await client()(cmd, input(rest)), null, 2));
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
