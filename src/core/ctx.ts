import type { Blobs } from "../blobs/blobs";
import type { Db } from "../db/db";

export type ActorKind = "human" | "agent" | "system";
export type Actor = { id: string; kind: ActorKind; name: string; email: string | null };

/** Everything an op needs. `now` is fixed per request so one mutation stamps one time everywhere. */
export type Ctx = { db: Db; blobs: Blobs; actor: Actor; now: string; baseUrl?: string };

/** An error the caller caused: shown to them as-is (HTTP status, MCP isError). */
export class Fail extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid") {
    super(message);
  }
}

export const uid = () => crypto.randomUUID();

export const sha256 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

export const PRIORITY = ["No priority", "Urgent", "High", "Medium", "Low"] as const;

/** "2026-10-01", a full ISO time, or a duration back from now ("-P1D", "-PT6H", "P2W"). */
export function since(v: string, now: string): string {
  const m = /^-?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(v);
  if (m && v.length > 1) {
    const ms = ((+(m[1] ?? 0) * 7 + +(m[2] ?? 0)) * 24 * 60 + +(m[3] ?? 0) * 60 + +(m[4] ?? 0)) * 60_000;
    return new Date(Date.parse(now) - ms).toISOString();
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Fail(`Not a date or duration: ${v}`);
  return new Date(t).toISOString();
}

/** Turns free text into a safe FTS5 query: every word must appear, as a prefix. */
export function ftsQuery(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}_]+/gu);
  return words?.length ? words.map((w) => `"${w}"*`).join(" ") : null;
}
