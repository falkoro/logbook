import type { Db } from "./db";

export const d1 = (db: D1Database): Db => ({
  async all(s) {
    return (await db.prepare(s.sql).bind(...s.params).all()).results as never[];
  },
  async batch(ss) {
    // ponytail: one D1 batch per mutation; split into chunks if a single mutation ever nears D1's per-invocation query limit.
    if (ss.length) await db.batch(ss.map((s) => db.prepare(s.sql).bind(...s.params)));
  },
});
