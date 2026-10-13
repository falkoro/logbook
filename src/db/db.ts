// The one storage seam. D1 (Cloudflare) and bun:sqlite (self-hosted) both implement it; core never sees which.
export type Param = string | number | null;
export type Stmt = { sql: string; params: Param[] };
export type Row = Record<string, unknown>;

export interface Db {
  all<T = Row>(s: Stmt): Promise<T[]>;
  /** Runs every statement in one transaction: all land or none do. */
  batch(s: Stmt[]): Promise<void>;
}

const norm = (v: unknown): Param => (v === undefined || v === null ? null : typeof v === "boolean" ? (v ? 1 : 0) : (v as Param));

export const q = (sql: string, ...params: unknown[]): Stmt => ({ sql, params: params.map(norm) });

export const first = async <T = Row>(db: Db, s: Stmt): Promise<T | null> => (await db.all<T>(s))[0] ?? null;
