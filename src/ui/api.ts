// Talking to the server: every op is POST /api/<op>. Views read through useLoad and refetch whenever
// refresh() runs (after our own writes, and when the change feed moves).
import { useEffect, useState, useSyncExternalStore } from "react";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function send<T>(path: string, init: RequestInit = {}): Promise<T> {
  // X-Logbook forces a CORS preflight, so another site cannot write with the owner's Access cookie.
  const res = await fetch(path, { credentials: "same-origin", ...init, headers: { "x-logbook": "1", ...init.headers } });
  const body: any = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.error?.message ?? `HTTP ${res.status}`, res.status);
  return body as T;
}

export const call = <T = any>(op: string, input: object = {}) =>
  send<T>(`/api/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });

export function upload(file: File, issue?: string) {
  const form = new FormData();
  form.set("file", file);
  if (issue) form.set("issue", issue);
  return send<{ markdown: string }>("/api/upload", { method: "POST", body: form });
}

export const changes = (after: number) => send<{ last: number }>(`/api/changes?after=${after}`);

/** Follows cursors for `n` pages, so a refresh reloads everything already shown. */
export async function pages<T>(op: string, input: object, key: string, n: number) {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < n; i++) {
    const r: any = await call(op, cursor ? { ...input, cursor } : input);
    items.push(...r[key]);
    cursor = r.cursor;
    if (!cursor) break;
  }
  return { items, more: !!cursor };
}

let tick = 0;
const subs = new Set<() => void>();
export function refresh() {
  tick++;
  for (const f of subs) f();
}
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};

export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const t = useSyncExternalStore(subscribe, () => tick);
  const [state, setState] = useState<{ data?: T; error?: Error }>({});
  useEffect(() => {
    let live = true;
    load().then(
      (data) => live && setState({ data }),
      (error: Error) => live && setState((s) => ({ ...s, error })),
    );
    return () => void (live = false);
  }, [...deps, t]);
  return state;
}

let show = (msg: string) => console.error(msg);
export const onToast = (fn: (msg: string) => void) => void (show = fn);
export const toast = (msg: string) => show(msg);

/** Runs a write, refreshes every view, and shows a failure instead of throwing. */
export async function act<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    const r = await p;
    refresh();
    return r;
  } catch (e) {
    show((e as Error).message);
    return undefined;
  }
}

export function nav(to: string) {
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}

export type Team = { id: string; key: string; name: string; stagingUrl?: string | null; liveUrl?: string | null };
export type Me = { id: string; kind: "human" | "agent" | "system"; name: string; email: string | null };
export type IssueLite = {
  id: string;
  title: string;
  status: string;
  statusType: string;
  assignee: string | null;
  assigneeKind?: string | null;
  createdBy?: string | null;
  createdByKind?: string | null;
  priority?: { value: number; name: string };
  labels?: string[];
  release?: string | null;
  openDecisions?: number;
  updatedAt?: string;
};
export type Decision = {
  id: string;
  kind: "decide" | "review";
  title: string;
  question: string;
  options: string[];
  recommendation: string | null;
  status: "open" | "answered" | "withdrawn";
  answer: string | null;
  team: string;
  teamKey: string;
  issue: string | null;
  issueTitle: string | null;
  askedBy: string | null;
  askedByKind: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  createdAt: string;
};
export type Release = {
  id: string;
  team: string;
  teamKey: string;
  version: string;
  status: "planned" | "staging" | "live" | "rolled_back";
  deployedAt: string | null;
  notesDocId: string | null;
  issues: number;
  done: number;
  createdAt: string;
};
export type AppStat = Team & {
  open: number;
  inProgress: number;
  triage: number;
  urgent: number;
  doneThisWeek: number;
  openDecisions: number;
  live: { version: string; deployedAt: string | null } | null;
  next: { version: string; status: string } | null;
};

// Who is logged in rarely changes within a visit; components that only need to know whether you can answer share one request.
let mine: Promise<Me> | null = null;
export const getMe = () => (mine ??= call<Me>("me").catch((e) => ((mine = null), Promise.reject(e))));

/** The query string of the current address, read fresh on every render (the shell re-renders on navigation). */
export const param = (k: string) => new URLSearchParams(location.search).get(k);
