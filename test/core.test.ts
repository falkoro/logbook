import { describe, expect, test } from "bun:test";
import { applyPatch } from "../src/core/registry";
import { shortQuestion } from "../src/core/workflow";
import { COLUMNS, TABLE } from "../src/core/log";
import { issueKeys, pollOrigin, syncPrs } from "../src/core/prs";
import { q } from "../src/db/db";
import { AGENT, world } from "./helpers";

describe("schema", () => {
  test("the change-log column lists match the tables", async () => {
    const { db } = await world();
    for (const [entity, cols] of Object.entries(COLUMNS)) {
      const real = (await db.all<{ name: string }>(q(`SELECT name FROM pragma_table_info('${TABLE[entity as keyof typeof TABLE]}')`))).map((r) => r.name);
      expect([...cols].sort() as string[]).toEqual(real.sort());
    }
  });
});

describe("issues", () => {
  test("create numbers per team, defaults to Backlog, and logs a snapshot with labels", async () => {
    const w = await world();
    await w.captain("save_issue_label", { name: "Bug" });
    const a = await w.agent("save_issue", { team: "ENG", title: "First", labels: ["bug"] });
    const b = await w.agent("save_issue", { team: "engineering", title: "Second", priority: 2, assignee: "me" });
    expect([a.id, b.id]).toEqual(["ENG-1", "ENG-2"]);
    expect(a.status).toBe("Backlog");
    expect(a.labels).toEqual(["Bug"]);
    expect(b.priority).toEqual({ value: 2, name: "High" });
    expect(b.assignee).toBe("firstmate");
    const log = await w.db.all<{ data: string }>(q("SELECT data FROM changes WHERE entity = 'issue' AND entity_id = ?", a.uuid));
    expect(JSON.parse(log[0]!.data).label_ids).toHaveLength(1);
  });

  test("list_issue_labels: a team sees its own and workspace labels; no team lists every label", async () => {
    const w = await world();
    await w.captain("save_team", { key: "ACME", name: "Acme" });
    await w.captain("save_issue_label", { name: "Bug" });
    await w.captain("save_issue_label", { name: "Checkout", team: "ENG" });
    await w.captain("save_issue_label", { name: "Feed", team: "ACME" });
    const names = async (inp: object) => (await w.agent("list_issue_labels", inp)).labels.map((l: any) => l.name).sort();
    expect(await names({})).toEqual(["Bug", "Checkout", "Feed"]);
    expect(await names({ team: "ENG" })).toEqual(["Bug", "Checkout"]);
  });

  test("dedupeKey comments 'Seen again' on the open issue instead of filing a new one", async () => {
    const w = await world();
    const first = await w.agent("save_issue", { team: "ENG", title: "TypeError in checkout", dedupeKey: "err:abc" });
    const again = await w.agent("save_issue", { team: "ENG", title: "TypeError in checkout", description: "stack…", dedupeKey: "err:abc" });
    expect(again.id).toBe(first.id);
    expect(again.deduped).toBe(true);
    const { comments } = await w.agent("list_comments", { issueId: first.id });
    expect(comments[0].body).toBe("Seen again:\n\nstack…");
    // Once the first is done, the same key files a new issue.
    await w.agent("save_issue", { id: first.id, state: "Done" });
    expect((await w.agent("save_issue", { team: "ENG", title: "again", dedupeKey: "err:abc" })).id).toBe("ENG-2");
  });

  test("labels: unknown names fail, single-choice groups replace on add and reject two at once", async () => {
    const w = await world();
    await w.captain("save_issue_label", { name: "Size", isGroup: true });
    await w.captain("save_issue_label", { name: "S", parent: "Size" });
    await w.captain("save_issue_label", { name: "L", parent: "Size" });
    const i = await w.agent("save_issue", { team: "ENG", title: "x", labels: ["S"] });
    expect((await w.agent("save_issue", { id: i.id, addLabels: ["L"] })).labels).toEqual(["L"]);
    await expect(w.agent("save_issue", { id: i.id, labels: ["S", "L"] })).rejects.toThrow(/single-choice/);
    await expect(w.agent("save_issue", { id: i.id, addLabels: ["Nope"] })).rejects.toThrow(/No label/);
  });

  test("state changes stamp timestamps; duplicateOf moves to the duplicate state; patch edits the description", async () => {
    const w = await world();
    const a = await w.agent("save_issue", { team: "ENG", title: "a", description: "one two three" });
    const started = await w.agent("save_issue", { id: a.id, state: "started", patch: [{ op: "replace", old_string: "two", new_string: "2" }] });
    expect(started.startedAt).toBeTruthy();
    expect(started.description).toBe("one 2 three");
    const b = await w.agent("save_issue", { team: "ENG", title: "b" });
    const dup = await w.agent("save_issue", { id: b.id, duplicateOf: a.id });
    expect([dup.statusType, dup.duplicateOf, !!dup.canceledAt]).toEqual(["duplicate", "ENG-1", true]);
  });

  test("list_issues filters and pages", async () => {
    const w = await world();
    for (let n = 0; n < 5; n++) await w.agent("save_issue", { team: "ENG", title: `issue ${n} payment`, priority: n % 2 });
    const p1 = await w.agent("list_issues", { limit: 2, fields: ["title"] });
    const p2 = await w.agent("list_issues", { limit: 2, cursor: p1.cursor });
    const p3 = await w.agent("list_issues", { limit: 2, cursor: p2.cursor });
    expect([...p1.issues, ...p2.issues, ...p3.issues].map((i: any) => i.id).sort()).toEqual(["ENG-1", "ENG-2", "ENG-3", "ENG-4", "ENG-5"]);
    expect(p3.cursor).toBeNull();
    expect(Object.keys(p1.issues[0])).toEqual(["id", "title"]);
    expect((await w.agent("list_issues", { priority: 1 })).issues).toHaveLength(2);
    expect((await w.agent("list_issues", { query: "paym" })).issues).toHaveLength(5);
    expect((await w.agent("list_issues", { assignee: null, state: "backlog" })).issues).toHaveLength(5);
  });
});

describe("releases", () => {
  test("going live closes open attached issues, comments on shipped ones and writes notes", async () => {
    const w = await world();
    const open = await w.agent("save_issue", { team: "ENG", title: "open one", release: "1.0.0" });
    const done = await w.agent("save_issue", { team: "ENG", title: "done one", release: "1.0.0", state: "Done" });
    const dropped = await w.agent("save_issue", { team: "ENG", title: "dropped", release: "1.0.0", state: "Canceled" });
    const rel = await w.agent("set_release_status", { release: "1.0.0", status: "live" });
    expect([rel.status, !!rel.deployedAt, rel.issues, rel.done]).toEqual(["live", true, 3, 2]);
    expect((await w.agent("get_issue", { id: open.id })).statusType).toBe("completed");
    for (const i of [open, done]) expect((await w.agent("list_comments", { issueId: i.id })).comments.map((c: any) => c.body)).toEqual(["Live in v1.0.0."]);
    expect((await w.agent("list_comments", { issueId: dropped.id })).comments).toHaveLength(0);
    const notes = await w.agent("get_document", { id: rel.notesDocId });
    expect(notes.content).toContain("- ENG-1 open one");
    expect(notes.content).not.toContain("dropped");
  });
});

describe("decisions", () => {
  test("agents ask, only a human answers, and the answer lands on the issue", async () => {
    const w = await world();
    const i = await w.agent("save_issue", { team: "ENG", title: "pick a db" });
    const d = await w.agent("ask_decision", { issue: i.id, question: "D1 or Postgres?", options: ["D1", "Postgres"], recommendation: "D1" });
    expect((await w.captain("list_decisions")).decisions.map((x: any) => x.id)).toEqual([d.id]);
    await expect(w.agent("answer_decision", { id: d.id, answer: "D1" })).rejects.toThrow(/human/);
    const a = await w.captain("answer_decision", { id: d.id, answer: "D1" });
    expect([a.status, a.answeredBy]).toEqual(["answered", "Captain"]);
    expect((await w.agent("list_comments", { issueId: i.id })).comments[0].body).toStartWith("**Decision:** D1");
    await expect(w.captain("answer_decision", { id: d.id, answer: "again" })).rejects.toThrow(/already answered/);
  });
});

describe("captain view", () => {
  test("a decision has a one-line question: the asker's title, else the last question in the text", async () => {
    expect(shortQuestion("Release 1.6.63 is ready.\n\n1. Keep it?\n2. Ship.\n\nMay 1.6.63 go to test.example.com?")).toBe("May 1.6.63 go to test.example.com?");
    expect(shortQuestion("The channel is not verified. Only you can do it.")).toBe("The channel is not verified.");
    const w = await world();
    const i = await w.agent("save_issue", { team: "ENG", title: "pick a db" });
    const d = await w.agent("ask_decision", { issue: i.id, title: "D1 or Postgres?", question: "Long context.\n\nWhich one?" });
    expect(d.title).toBe("D1 or Postgres?");
    expect((await w.agent("ask_decision", { issue: i.id, question: "Long context. Which one?" })).title).toBe("Which one?");
  });

  test("issues show and filter on open decisions; decisions filter on a release", async () => {
    const w = await world();
    const [a, b] = [await w.agent("save_issue", { team: "ENG", title: "a", release: "1.0.0" }), await w.agent("save_issue", { team: "ENG", title: "b" })];
    const d = await w.agent("ask_decision", { issue: a.id, question: "Ship?" });
    await w.agent("ask_decision", { issue: b.id, question: "Later?" });
    const waiting = await w.agent("list_issues", { team: "ENG", hasOpenDecision: true, release: "1.0.0", fields: ["openDecisions"] });
    expect(waiting.issues).toEqual([{ id: a.id, openDecisions: 1 }]);
    expect((await w.agent("list_decisions", { release: "1.0.0", team: "ENG" })).decisions.map((x: any) => x.id)).toEqual([d.id]);
    await w.captain("answer_decision", { id: d.id, answer: "yes" });
    expect((await w.agent("get_issue", { id: a.id })).openDecisions).toBe(0);
  });

  test("an app keeps its staging and live URLs, and the captain can rename themself", async () => {
    const w = await world();
    const t = await w.captain("save_team", { id: "ENG", stagingUrl: "https://test.example.com", liveUrl: "https://example.com" });
    expect([t.stagingUrl, t.liveUrl]).toEqual(["https://test.example.com", "https://example.com"]);
    expect((await w.agent("overview")).teams[0].liveUrl).toBe("https://example.com");
    await expect(w.captain("save_team", { id: "ENG", liveUrl: "javascript:alert(1)" })).rejects.toThrow();
    await expect(w.agent("save_profile", { name: "Ada" })).rejects.toThrow(/human/);
    await expect(w.captain("save_profile", { name: "firstmate" })).rejects.toThrow(/taken/);
    expect((await w.captain("save_profile", { name: " Ada " })).name).toBe("Ada");
  });
});

describe("activity", () => {
  test("reads as who did what, with names in the diffs, filters by issue and actor, and skips bookkeeping writes", async () => {
    const w = await world();
    await w.captain("save_issue_label", { name: "Bug" });
    const i = await w.agent("save_issue", { team: "ENG", title: "flaky login" });
    await w.agent("save_issue", { id: i.id, state: "started", assignee: "me", addLabels: ["Bug"] });
    await w.captain("save_comment", { issueId: i.id, body: "seen it too" });
    await w.agent("save_issue", { team: "ENG", title: "other" });
    const mine = (await w.captain("list_activity", { issue: i.id })).events;
    expect(mine.map((e: any) => e.summary)).toEqual(["commented on ENG-1", "updated ENG-1: status, assignee, labels", "created ENG-1"]);
    expect(mine[1].changes).toEqual([
      { field: "status", from: "Backlog", to: "In Progress" },
      { field: "assignee", from: null, to: "firstmate" },
      { field: "labels", from: [], to: ["Bug"] },
    ]);
    expect(mine[0]).toMatchObject({ actor: { name: "Captain", kind: "human" }, body: "seen it too", issue: { id: "ENG-1", title: "flaky login" } });
    const agent = await w.captain("list_activity", { actor: "firstmate", limit: 2 });
    expect(agent.events.map((e: any) => e.summary)).toEqual(["created ENG-2", "updated ENG-1: status, assignee, labels"]);
    const since = await w.captain("list_activity", { after: agent.next });
    expect(since.events.map((e: any) => e.summary)).toEqual(["commented on ENG-1", "created ENG-2"]);
    expect((await w.captain("list_users", { kind: "agent" })).users[0].lastActiveAt).toBeTruthy();
  });

  test("speaks Dutch on request, names a decision by its short question, and can return bodies in full", async () => {
    const w = await world();
    const i = await w.agent("save_issue", { team: "ENG", title: "pick a db" });
    await w.agent("save_issue", { id: i.id, state: "started" });
    const long = "word ".repeat(120).trim();
    await w.captain("save_comment", { issueId: i.id, body: long });
    const d = await w.agent("ask_decision", { issue: i.id, title: "D1 or Postgres?", question: `${"Context. ".repeat(60)}Which one?` });
    await w.captain("answer_decision", { id: d.id, answer: "D1" });
    const nl = (await w.captain("list_activity", { issue: i.id, lang: "nl", full: true })).events;
    expect(nl.map((e: any) => e.summary)).toEqual([
      "reageerde op ENG-1",
      "besloot over “D1 or Postgres?”: D1",
      "vroeg “D1 or Postgres?” op ENG-1",
      "reageerde op ENG-1",
      "zette ENG-1 op In Progress",
      "maakte ENG-1 aan",
    ]);
    expect(nl[0].body).toMatch(/^\*\*Decision:\*\* D1/);
    expect(nl[3].body).toBe(long);
    expect((await w.captain("list_activity", { issue: i.id })).events[3].body.length).toBeLessThan(long.length);
  });
});

describe("pull requests", () => {
  test("keys come from title, body and branch; linking never changes the issue state", async () => {
    const w = await world();
    const i = await w.agent("save_issue", { team: "ENG", title: "x" });
    expect(issueKeys("fix: thing (ENG-1)\nbranch eng-22-foo")).toEqual(["ENG-1", "ENG-22"]);
    const pr = { provider: "origin" as const, repo: "acme/shop", number: 7, url: "https://x/7", title: "t", text: "eng-1-x" };
    expect(await syncPrs(w.ctx(AGENT), [{ ...pr, state: "open" }])).toBe(1);
    expect(await syncPrs(w.ctx(AGENT), [{ ...pr, state: "open" }])).toBe(0);
    expect(await syncPrs(w.ctx(AGENT), [{ ...pr, state: "merged" }])).toBe(1);
    const got = await w.agent("get_issue", { id: i.id });
    expect(got.pullRequests.map((p: any) => p.state)).toEqual(["merged"]);
    expect(got.statusType).toBe("backlog");
  });

  test("pollOrigin exchanges the API key and reads PRs with the access token", async () => {
    const w = await world();
    const i = await w.agent("save_issue", { team: "ENG", title: "x" });
    const seen: string[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
      if (url.includes("exchange_user_api_key")) return Response.json({ accessToken: "tok", refreshToken: "r" });
      return Response.json({ pullRequests: [{ number: "9", webUrl: "https://x/9", title: `Fix ${i.id}`, state: "closed", merged: true }] });
    }) as unknown as typeof fetch;
    expect(await pollOrigin(w.ctx(AGENT), ["acme/shop"], "crsr_key", fetcher)).toBe(1);
    expect(seen).toEqual([
      "https://api2.cursor.sh/auth/exchange_user_api_key Bearer crsr_key",
      "https://api.cursor.com/v1/origin/repos/acme/shop/pulls?state=all&pageSize=50 Bearer tok",
    ]);
    expect((await w.agent("get_issue", { id: i.id })).pullRequests.map((p: any) => p.state)).toEqual(["merged"]);
    const refused = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    await expect(pollOrigin(w.ctx(AGENT), ["a/b"], "bad", refused)).rejects.toThrow(/exchanging the Cursor API key failed \(HTTP 401\)/);
  });

  test('pollOrigin "*" polls every repo pushed in the last day, and one failing repo does not stop the rest', async () => {
    const w = await world();
    const i = await w.agent("save_issue", { team: "ENG", title: "x" });
    const ctx = w.ctx(AGENT);
    const ago = (h: number) => new Date(Date.parse(ctx.now) - h * 3_600_000).toISOString();
    const polled: string[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      if (url.includes("exchange_user_api_key")) return Response.json({ accessToken: "tok" });
      if (url.endsWith("/GetAuthorizedNamespaces")) return Response.json({ namespaces: [{ namespace: { namespace: "acme" } }] });
      if (url.endsWith("/ListHostedRepos")) {
        const page = JSON.parse(String(init.body)).pageToken;
        return Response.json(
          page
            ? { repositories: [{ org: "acme", name: "broken", lastPushedAt: ago(2) }], nextPageToken: "" }
            : { repositories: [{ org: "acme", name: "shop", lastPushedAt: ago(1) }, { org: "acme", name: "idle", lastPushedAt: ago(48) }], nextPageToken: "p2" },
        );
      }
      const repo = /repos\/([^/]+\/[^/]+)\/pulls/.exec(url)![1]!;
      polled.push(repo);
      if (repo === "acme/broken") return new Response("gone", { status: 404 });
      return Response.json({ pullRequests: [{ number: "3", webUrl: "https://x/3", title: `Fix ${i.id}`, state: "open" }] });
    }) as unknown as typeof fetch;
    await expect(pollOrigin(ctx, ["*"], "crsr_key", fetcher)).rejects.toThrow("Origin acme/broken: HTTP 404 (linked 1 from the rest)");
    expect(polled.sort()).toEqual(["acme/broken", "acme/shop"]);
    expect((await w.agent("get_issue", { id: i.id })).pullRequests.map((p: any) => p.repo)).toEqual(["acme/shop"]);
  });
});

describe("import", () => {
  test("upserts by id without rules, keeps numbers and moves numbering on; agents cannot import", async () => {
    const w = await world();
    const team = (await w.captain("list_teams")).teams[0];
    const st = (await w.captain("list_issue_statuses", { team: "ENG" })).statuses.find((s: any) => s.type === "completed");
    const row = { id: "lin-1", team_id: team.id, number: 41, title: "old", state_id: st.id, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z" };
    await expect(w.agent("import_rows", { entity: "issue", rows: [row] })).rejects.toThrow(/human or system/);
    await w.system("import_rows", { entity: "issue", rows: [row] });
    await w.system("import_rows", { entity: "issue", rows: [{ ...row, title: "renamed" }] });
    expect((await w.agent("get_issue", { id: "ENG-41" })).title).toBe("renamed");
    expect((await w.agent("save_issue", { team: "ENG", title: "next" })).id).toBe("ENG-42");
    await expect(w.system("import_rows", { entity: "issue", rows: [{ ...row, id: "lin-2", number: 43, state_id: "missing" }] })).rejects.toThrow();
  });
});

test("an imported attachment can carry its file, stored under its own id", async () => {
  const w = await world();
  const i = await w.agent("save_issue", { team: "ENG", title: "x" });
  const row = { id: "lin-f1", issue_id: i.uuid, name: "shot.png", mime: "image/png", content: btoa("png!"), created_at: "2025-01-01", updated_at: "2025-01-01" };
  await w.system("import_rows", { entity: "attachment", rows: [row] });
  await w.system("import_rows", { entity: "attachment", rows: [row] });
  const blob = await w.blobs.get("files/lin-f1");
  expect(new TextDecoder().decode(blob!.body instanceof ArrayBuffer ? blob!.body : await new Response(blob!.body).arrayBuffer())).toBe("png!");
  expect(await w.db.all(q("SELECT blob_key, size FROM attachments WHERE issue_id = ?", i.uuid))).toEqual([{ blob_key: "files/lin-f1", size: 4 }]);
});

test("applyPatch refuses ambiguous anchors", () => {
  expect(applyPatch("a b a", [{ op: "insert_after", anchor: "b", text: "!" }])).toBe("a b! a");
  expect(() => applyPatch("a b a", [{ op: "replace", old_string: "a", new_string: "x" }])).toThrow(/more than once/);
  expect(applyPatch("[x] keep [y]", [{ op: "replace_range", from: "[x]", to: "[y]", new_string: "" }])).toBe("[y]");
});

describe("security", () => {
  test("a system import never turns an existing actor human, nor answers a decision", async () => {
    const w = await world();
    await w.system("import_rows", { entity: "actor", rows: [{ id: AGENT.id, kind: "human", name: "firstmate", created_at: "2025-01-01", updated_at: "2025-01-01" }] });
    expect((await w.db.all<{ kind: string }>(q("SELECT kind FROM actors WHERE id = ?", AGENT.id)))[0]!.kind).toBe("agent");
    const team = (await w.captain("list_teams")).teams[0];
    const d = { id: "d1", team_id: team.id, question: "q", status: "answered", answer: "yes", created_at: "2025-01-01", updated_at: "2025-01-01" };
    await expect(w.system("import_rows", { entity: "decision", rows: [d] })).rejects.toThrow(/Only a human/);
    await w.system("import_rows", { entity: "actor", rows: [{ id: AGENT.id, kind: "agent", name: "firstmate", email: "owner@example.com", created_at: "2025-01-01", updated_at: "2025-01-01" }] });
    expect((await w.db.all<{ email: string | null }>(q("SELECT email FROM actors WHERE id = ?", AGENT.id)))[0]!.email).toBeNull();
  });

  test("a re-import never reopens or rewords a decision the captain answered", async () => {
    const w = await world();
    const team = (await w.captain("list_teams")).teams[0];
    await w.system("import_rows", { entity: "decision", rows: [{ id: "d1", team_id: team.id, question: "Ship it?", status: "open", created_at: "2025-01-01", updated_at: "2025-01-01" }] });
    await w.captain("answer_decision", { id: "d1", answer: "yes" });
    await w.system("import_rows", { entity: "decision", rows: [{ id: "d1", team_id: team.id, question: "Delete prod?", status: "open", created_at: "2025-01-01", updated_at: "2025-01-02" }] });
    const [row] = await w.db.all<{ question: string; status: string }>(q("SELECT question, status FROM decisions WHERE id = 'd1'"));
    expect(row).toEqual({ question: "Ship it?", status: "answered" });
  });

  test("imported links pass the same http(s) check", async () => {
    const w = await world();
    const i = await w.agent("save_issue", { team: "ENG", title: "x" });
    const at = { created_at: "2025-01-01", updated_at: "2025-01-01" };
    await expect(w.system("import_rows", { entity: "attachment", rows: [{ id: "x1", issue_id: i.uuid, url: "javascript:alert(1)", name: "x", ...at }] })).rejects.toThrow(/Invalid input/);
    await expect(w.system("import_rows", { entity: "pr_link", rows: [{ id: "p1", issue_id: i.uuid, provider: "github", repo: "a/b", number: 1, url: "data:text/html,x", state: "open", ...at }] })).rejects.toThrow(/Invalid input/);
    await w.system("import_rows", { entity: "attachment", rows: [{ id: "x2", issue_id: i.uuid, url: "/files/x2", name: "x", ...at }, { id: "x3", issue_id: i.uuid, url: "https://example.com/a", name: "a", ...at }] });
  });

  test("links must be http(s)", async () => {
    const w = await world();
    await expect(w.agent("save_issue", { team: "ENG", title: "x", links: [{ url: "javascript:alert(1)", title: "x" }] })).rejects.toThrow(/Invalid input/);
    const i = await w.agent("save_issue", { team: "ENG", title: "x" });
    await expect(w.agent("link_pr", { issue: i.id, provider: "github", repo: "a/b", number: 1, url: "javascript:alert(1)", state: "open" })).rejects.toThrow(/Invalid input/);
  });
});
