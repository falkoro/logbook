import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disk } from "../src/blobs/disk";
import type { Actor, Ctx } from "../src/core/ctx";
import { OPS } from "../src/core/ops";
import { runOp } from "../src/core/registry";
import { type Db, q } from "../src/db/db";
import { sqlite } from "../src/db/sqlite";

export const CAPTAIN: Actor = { id: "a-captain", kind: "human", name: "Captain", email: "captain@example.com" };
export const AGENT: Actor = { id: "a-agent", kind: "agent", name: "firstmate", email: null };
export const SYSTEM: Actor = { id: "a-system", kind: "system", name: "importer", email: null };

/** A fresh in-memory workspace with the three actors and one team (ENG). */
export async function world(db: Db = sqlite(":memory:")) {
  const blobs = disk(mkdtempSync(join(tmpdir(), "logbook-test-")));
  const now = "2026-10-11T12:00:00.000Z";
  for (const a of [CAPTAIN, AGENT, SYSTEM]) {
    await db.batch([q("INSERT INTO actors (id, kind, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", a.id, a.kind, a.name, a.email, now, now)]);
  }
  const ctx = (actor: Actor): Ctx => ({ db, blobs, actor, now: new Date().toISOString() });
  const as = (actor: Actor) => (name: string, input: unknown = {}) => runOp(OPS, name, ctx(actor), input) as Promise<any>;
  const captain = as(CAPTAIN);
  await captain("save_team", { key: "ENG", name: "Engineering" });
  return { db, blobs, ctx, captain, agent: as(AGENT), system: as(SYSTEM) };
}
