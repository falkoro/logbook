// Self-hosted storage: one SQLite file. Applies migrations/*.sql itself, tracked in the same table name D1 uses.
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db";

export function sqlite(path: string, migrationsDir = join(import.meta.dir, "../../migrations")): Db {
  const raw = new Database(path, { create: true });
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  raw.exec("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const done = new Set(raw.query<{ name: string }, []>("SELECT name FROM d1_migrations").all().map((r) => r.name));
  for (const name of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    raw.transaction(() => {
      raw.exec(readFileSync(join(migrationsDir, name), "utf8"));
      raw.query("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
    })();
  }
  return {
    async all(s) {
      return raw.query(s.sql).all(...s.params) as never[];
    },
    async batch(ss) {
      raw.transaction(() => {
        for (const s of ss) raw.query(s.sql).run(...s.params);
      })();
    },
  };
}
