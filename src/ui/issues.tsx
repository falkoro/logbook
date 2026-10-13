// Issues per app (tabs and collapsible status groups), the issue page and the new-issue dialog.
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { type Decision, type IssueLite, type Team, act, call, getMe, nav, pages, param, useLoad } from "./api";
import {
  type Activity, Avatar, Brass, Entry, Err, Icon, Inline, IssueRow, Label, Loading, Md, MdEditor, PRIORITY, PageHead, StateDot, Tabs, Who,
  copy, day, hue, since, useDebounced,
} from "./bits";
import { DecisionDetail } from "./decisions";
import { safeUrl } from "./md";

type Tab = "open" | "triage" | "captain" | "done";
const TABS: [Tab, string][] = [["open", "Open"], ["triage", "Triage"], ["captain", "Captain decides"], ["done", "Done"]];
const OPEN: [type: string, name: string][] = [["started", "In Progress"], ["unstarted", "Todo"], ["backlog", "Backlog"]];
const GROUPS: Record<Tab, [string, string][]> = {
  open: OPEN,
  triage: [["triage", "Triage"]],
  captain: [...OPEN, ["triage", "Triage"]],
  done: [["completed", "Done"], ["canceled", "Canceled"], ["duplicate", "Duplicate"]],
};
const FIELDS = ["title", "priority", "status", "statusType", "labels", "assignee", "createdBy", "createdByKind", "release", "openDecisions", "updatedAt"];
const LOOK = "Captain look";

export function IssueList({ team, teams, triage, look }: { team: string; teams: Team[]; triage?: boolean; look?: boolean }) {
  const base = look ? "/look" : "/issues";
  const asked = param("tab");
  const tab: Tab = triage ? "triage" : (TABS.find(([t]) => t === asked)?.[0] ?? "open");
  const [assignee, setAssignee] = useState("");
  const [label, setLabel] = useState("");
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim());
  const users = useLoad(() => call("list_users"), []);
  const labels = useLoad(() => call("list_issue_labels", team ? { team } : {}), [team]);
  const app = teams.find((t) => t.key === team);
  const release = look || triage ? null : param("release");
  const filters = {
    ...(release && { release }),
    ...(team && { team }),
    ...(assignee && { assignee }),
    ...((look || label) && { label: look ? LOOK : label }),
    ...(q && { query: q }),
    ...(tab === "captain" && { hasOpenDecision: true }),
  };
  const go = (t: Tab) => {
    const qs = new URLSearchParams({ ...(t !== "open" && { tab: t }), ...(release && { release }) }).toString();
    nav(t === "triage" && !look && !release ? "/triage" : `${base}${qs ? `?${qs}` : ""}`);
  };
  return (
    <div className="page">
      <PageHead
        kicker={release ? <>{app?.name ?? "All apps"} · release <span className="mono">v{release.replace(/^v/i, "")}</span> · <a href="/issues">all issues</a></> : (app?.name ?? "All apps")}
        title={look ? "Captain look" : triage ? "Triage" : "Issues"}
        sub={
          look
            ? "Images and screenshots you need to see before work can go on."
            : triage
              ? "Just in: not yet reviewed or planned."
              : "Everything that is open, grouped by status."
        }
      />
      <Tabs label="Which issues" value={tab} onChange={go} items={TABS} />
      <div className="filters">
        <label className="filter-search">
          <Icon name="search" />
          <input type="search" aria-label="Filter by text" placeholder="Filter by text" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <select aria-label="Assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">Anyone</option>
          <option value="me">Me</option>
          <option value="null">Nobody</option>
          {users.data?.users.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        {!look && (
          <select aria-label="Label" value={label} onChange={(e) => setLabel(e.target.value)}>
            <option value="">Any label</option>
            {labels.data?.labels.map((l: any) => <option key={l.id} value={l.id}>{l.parent ? `${l.parent} / ${l.name}` : l.name}</option>)}
          </select>
        )}
      </div>
      <div className="groups">
        {GROUPS[tab].map(([type, name]) => (
          <Group key={`${tab}-${type}`} type={type} name={name} filters={filters} startOpen={tab !== "done" || type === "completed"} />
        ))}
      </div>
      <p className="hint">
        <span><kbd>j</kbd><kbd>k</kbd> move through the list</span> <span><kbd>↵</kbd> open</span> <span><kbd>c</kbd> new issue</span> <span><kbd>/</kbd> search</span>
      </p>
    </div>
  );
}

// Each group pages on its own, so a thousand done issues never push the open ones off the first page.
function Group({ type, name, filters, startOpen }: { type: string; name: string; filters: object; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [n, setN] = useState(1);
  const key = JSON.stringify(filters);
  useEffect(() => setN(1), [key]);
  const { data, error } = useLoad(
    () => (open ? pages<IssueLite>("list_issues", { ...filters, state: type, limit: 50, fields: FIELDS }, "issues", n) : Promise.resolve(null)),
    [key, type, n, open],
  );
  const id = `g-${type}`;
  return (
    <section className="group" data-open={open || undefined}>
      <h2>
        <button aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
          <Icon name={open ? "down" : "chevron"} />
          <StateDot type={type} name={name} />
          <span>{name}</span>
          <span className="gn">{data ? `${data.items.length}${data.more ? "+" : ""}` : ""}</span>
        </button>
      </h2>
      {open && (
        <div id={id} className="group-body">
          <Err e={error} />
          {!data && !error && <Loading />}
          {data?.items.map((i) => <IssueRow key={i.id} i={i} />)}
          {data && !data.items.length && <p className="empty">No issues.</p>}
          {data?.more && <button className="more" onClick={() => setN(n + 1)}>Load more</button>}
        </div>
      )}
    </section>
  );
}

type Attachment = { id: string; name: string; url: string; mime: string | null; size: number | null; documentId: string | null };
type Issue = IssueLite & {
  uuid: string;
  description: string;
  priority: { value: number; name: string };
  labels: string[];
  team: string;
  teamId: string;
  assigneeId: string | null;
  createdBy: string | null;
  parentId: string | null;
  duplicateOf: string | null;
  release: string | null;
  gitBranchName: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  attachments: Attachment[];
  pullRequests: { provider: string; repo: string; number: number; url: string; title: string; state: string }[];
  children: IssueLite[];
};
type Comment = { id: string; body: string; author: string | null; authorKind: string | null; createdAt: string; attachments: Attachment[] };

export function IssueView({ ident }: { ident: string }) {
  const { data: i, error } = useLoad(() => call<Issue>("get_issue", { id: ident }), [ident]);
  const parent = useLoad(() => (i?.parentId ? call<IssueLite>("get_issue", { id: i.parentId, fields: ["title"] }) : Promise.resolve(null)), [i?.parentId]);
  const decisions = useLoad(() => call<{ decisions: Decision[] }>("list_decisions", { issue: ident, status: "open" }), [ident]);
  const [later, setLater] = useState<string[]>([]);
  useEffect(() => {
    if (i) document.title = `${i.id} ${i.title} · Logbook`;
    return () => void (document.title = "Logbook");
  }, [i?.id, i?.title]);
  if (!i) return error ? <Err e={error} /> : <Loading />;
  const save = (patch: object) => act(call("save_issue", { id: i.id, ...patch }));
  const open = decisions.data?.decisions ?? [];
  return (
    <div className="page issue">
      <nav className="crumbs" aria-label="Breadcrumbs">
        <ol>
          <li><a href="/issues">{i.team}</a></li>
          {i.parentId && (
            <li>
              <a href={`/issue/${i.parentId}`}>
                <span className="mono">{i.parentId}</span> {parent.data?.title}
              </a>
            </li>
          )}
          <li aria-current="page" className="mono">{i.id}</li>
        </ol>
        {i.archivedAt && <span className="pill">archived</span>}
      </nav>
      <Inline wrap className="title-input" aria-label="Title" value={i.title} onSave={(v) => v && save({ title: v })} />
      <div className={`issue-grid${open.length ? " has-dec" : ""}`}>
        {!!open.length && (
          <div className="issue-decisions">
            {open.map((d) =>
            later.includes(d.id) ? (
              <p key={d.id} className="later">
                <Brass>Decision</Brass> {d.title} <button className="link-btn" onClick={() => setLater(later.filter((x) => x !== d.id))}>Decide now</button>
              </p>
            ) : (
              <div key={d.id} className="issue-decision">
                <DecisionDetail d={d} onIssue onLater={() => setLater([...later, d.id])} />
              </div>
            ),
            )}
          </div>
        )}
        <div className="issue-main">
          <Description i={i} save={save} />
          {!!i.children.length && (
            <Section title="Sub-issues">
              {i.children.map((c) => <IssueRow key={c.id} i={c} />)}
            </Section>
          )}
          {!!i.pullRequests.length && (
            <Section title="Pull requests">
              {i.pullRequests.map((p) => (
                <a key={`${p.provider}${p.repo}${p.number}`} className="lrow" href={safeUrl(p.url) ?? "#"} target="_blank" rel="noopener noreferrer">
                  <span className={`pill pr ${p.state}`}>{p.state}</span>
                  <span className="mono">{p.repo}#{p.number}</span>
                  <span className="ltitle">{p.title}</span>
                </a>
              ))}
            </Section>
          )}
          {!!i.attachments.length && (
            <Section title="Attachments">
              {i.attachments.map((a) => <AttachmentRow key={a.id} a={a} />)}
            </Section>
          )}
          <History issue={i.id} />
        </div>
        <Props i={i} save={save} />
      </div>
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="isec">
    <h2>{title}</h2>
    <div className="llist">{children}</div>
  </section>
);

function AttachmentRow({ a }: { a: Attachment }) {
  const href = a.documentId ? `/doc/${a.documentId}` : safeUrl(a.url);
  const image = a.mime?.startsWith("image/") && href;
  return (
    <a className="lrow" href={href ?? "#"} target={a.documentId ? undefined : "_blank"} rel="noopener noreferrer">
      {image ? <img className="thumb" src={href} alt="" loading="lazy" /> : <span className="mono">{a.documentId ? "doc" : a.mime ? "file" : "link"}</span>}
      <span className="ltitle">{a.name}</span>
      {a.size != null && <span className="mono muted">{Math.max(1, Math.round(a.size / 1024))} KB</span>}
    </a>
  );
}

function Description({ i, save }: { i: Issue; save: (p: object) => Promise<unknown> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const done = async () => {
    if (draft !== null && (await save({ description: draft }))) setDraft(null);
  };
  if (draft === null) {
    return (
      <section className="isec desc">
        <h2 className="visually-hidden">Description</h2>
        {i.description ? <Md text={i.description} /> : <p className="muted">No description yet.</p>}
        <button className="link-btn" onClick={() => setDraft(i.description)}>Edit description</button>
      </section>
    );
  }
  return (
    <section className="isec desc">
      <MdEditor autoFocus label="Description" value={draft} onChange={setDraft} issue={i.id} onSubmit={done} onCancel={() => setDraft(null)} />
      <div className="actions">
        <button className="primary" onClick={done}>Save</button>
        <button onClick={() => setDraft(null)}>Cancel</button>
      </div>
    </section>
  );
}

/** Comments and every change to the issue, oldest first, ending in the comment box. */
function History({ issue }: { issue: string }) {
  const [n, setN] = useState(1);
  const comments = useLoad(() => pages<Comment>("list_comments", { issueId: issue, limit: 100 }, "comments", n), [issue, n]);
  const log = useLoad(() => call<{ events: Activity[] }>("list_activity", { issue, limit: 200, full: true }), [issue]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    if (await act(call("save_comment", { issueId: issue, body }))) setBody("");
    setBusy(false);
  };
  const cs = comments.data?.items ?? [];
  // While newer comments are still unloaded, newer changes wait too, so the timeline never skips ahead.
  const until = comments.data?.more ? cs.at(-1)?.createdAt : undefined;
  const items = [
    ...cs.map((c) => ({ at: c.createdAt, key: c.id, node: <CommentItem key={c.id} c={c} /> })),
    ...(log.data?.events ?? [])
      .filter((e) => e.entity !== "comment" && (!until || e.at <= until))
      .map((e) => ({ at: e.at, key: `e${e.syncId}`, node: <Entry key={`e${e.syncId}`} e={e} here={issue} /> })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <section className="isec history">
      <h2>Activity</h2>
      <Err e={comments.error ?? log.error} />
      <ol className="timeline">{items.map((x) => x.node)}</ol>
      {comments.data?.more && <button className="more" onClick={() => setN(n + 1)}>Newer comments</button>}
      <div className="composer">
        <MdEditor value={body} onChange={setBody} label="Comment" onSubmit={send} issue={issue} placeholder="Write a comment" />
        <div className="actions">
          <button className="primary" disabled={!body.trim() || busy} onClick={send}>Post comment</button>
        </div>
      </div>
    </section>
  );
}

function CommentItem({ c }: { c: Comment }) {
  return (
    <li id={c.id} className="comment">
      <Avatar name={c.author ?? "?"} kind={c.authorKind} />
      <div className="ccard">
        <header>
          <b>{c.author ?? "Someone"}</b>
          {c.authorKind && c.authorKind !== "human" && <span className="pill">{c.authorKind === "agent" ? "agent" : "system"}</span>}
          <time className="mono" dateTime={c.createdAt} title={new Date(c.createdAt).toLocaleString(undefined)}>{since(c.createdAt)}</time>
        </header>
        <Md text={c.body} />
        {c.attachments.map((a) => <AttachmentRow key={a.id} a={a} />)}
      </div>
    </li>
  );
}

const Field = ({ label, children, id }: { label: string; children: ReactNode; id?: string }) => (
  <div className="field">
    <dt>{id ? <label htmlFor={id}>{label}</label> : label}</dt>
    <dd>{children}</dd>
  </div>
);

function Props({ i, save }: { i: Issue; save: (p: object) => Promise<unknown> }) {
  const statuses = useLoad(() => call("list_issue_statuses", { team: i.teamId }), [i.teamId]);
  const users = useLoad(() => call("list_users"), []);
  const labels = useLoad(() => call("list_issue_labels", { team: i.teamId }), [i.teamId]);
  const releases = useLoad(() => call("list_releases", { team: i.teamId, limit: 100 }), [i.teamId]);
  const stateId = statuses.data?.statuses.find((s: any) => s.name === i.status)?.id ?? "";
  const creator = users.data?.users.find((u: any) => u.name === i.createdBy);
  return (
    <aside className="props" aria-label="Properties">
      <dl>
        <Field label="Status" id="p-status">
          <span className="with-dot">
            <StateDot type={i.statusType} name={i.status} />
            <select id="p-status" value={stateId} onChange={(e) => save({ state: e.target.value })}>
              {!stateId && <option value="">{i.status}</option>}
              {statuses.data?.statuses.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </span>
        </Field>
        <Field label="Priority" id="p-prio">
          <select id="p-prio" value={i.priority.value} onChange={(e) => save({ priority: Number(e.target.value) })}>
            {PRIORITY.map((p, v) => <option key={v} value={v}>{p}</option>)}
          </select>
        </Field>
        <Field label="App">
          <span className="with-dot">
            <span className="app-dot" style={{ "--h": hue(i.id.split("-")[0]!) } as CSSProperties} aria-hidden="true" />
            {i.team}
          </span>
        </Field>
        <Field label="Parent" id="p-parent">
          <Inline id="p-parent" className="mono" value={i.parentId ?? ""} placeholder="None, e.g. ENG-12" onSave={(v) => save({ parentId: v || null })} />
          {i.parentId && <a href={`/issue/${i.parentId}`}>Open {i.parentId}</a>}
        </Field>
        <Field label="Release" id="p-release">
          <Inline id="p-release" className="mono" value={i.release ?? ""} placeholder="None" list="release-versions" onSave={(v) => save({ release: v || null })} />
          <datalist id="release-versions">
            {releases.data?.releases.map((r: any) => <option key={r.id} value={r.version} />)}
          </datalist>
        </Field>
        <Field label="Labels" id="p-label">
          {!!i.labels.length && (
            <div className="chips">
              {i.labels.map((l) => (
                <span className="chip-x" key={l}>
                  <Label name={l} />
                  <button className="x" aria-label={`Remove label ${l}`} onClick={() => save({ removeLabels: [l] })}>×</button>
                </span>
              ))}
            </div>
          )}
          <select id="p-label" value="" onChange={(e) => e.target.value && save({ addLabels: [e.target.value] })}>
            <option value="">Add label</option>
            {labels.data?.labels
              .filter((l: any) => !i.labels.includes(l.name))
              .map((l: any) => <option key={l.id} value={l.id}>{l.parent ? `${l.parent} / ${l.name}` : l.name}</option>)}
          </select>
        </Field>
        <Field label="Assignee" id="p-assignee">
          <select id="p-assignee" value={i.assigneeId ?? ""} onChange={(e) => save({ assignee: e.target.value || null })}>
            <option value="">Nobody</option>
            {users.data?.users.map((u: any) => <option key={u.id} value={u.id}>{u.name}{u.kind === "human" ? "" : ` (${u.kind})`}</option>)}
          </select>
        </Field>
        <Field label="Created by">
          <Who name={i.createdBy} kind={i.createdByKind ?? creator?.kind} />
        </Field>
        <Field label="Branch">
          <button className="branch mono" title="Copy the branch name" onClick={() => copy(i.gitBranchName, "branch name")}>
            <Icon name="branch" />
            <span>{i.gitBranchName}</span>
          </button>
        </Field>
        <Field label="Created">
          <time className="mono" dateTime={i.createdAt} title={new Date(i.createdAt).toLocaleString(undefined)}>{day(i.createdAt)}</time>
          <span className="muted">Updated {since(i.updatedAt)}</span>
        </Field>
      </dl>
      <div className="prop-tools">
        <button className="ghost" onClick={() => copy(i.id)}><Icon name="copy" /> Copy ID</button>
        <button className="ghost" onClick={() => copy(`${location.origin}/issue/${i.id}`, "link")}><Icon name="link" /> Copy link</button>
        <button className="ghost" onClick={() => save({ archived: !i.archivedAt })}>{i.archivedAt ? "Restore issue" : "Archive issue"}</button>
      </div>
    </aside>
  );
}

export function NewIssue({ team, teams, close }: { team: string; teams: Team[]; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [t, setT] = useState(team || teams[0]?.key || "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(0);
  const me = useLoad(getMe, []);
  useEffect(() => {
    ref.current?.showModal();
    // showModal focuses the first control (the app picker); the title is where typing should start.
    titleRef.current?.focus();
  }, []);
  const create = async () => {
    if (!title.trim() || !t) return;
    const r = await act(call("save_issue", { team: t, title: title.trim(), description, priority }));
    if (r) {
      close();
      nav(`/issue/${r.id}`);
    }
  };
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-label="New issue"
      onClose={close}
      onCancel={(e) => (title || description) && !confirm("Discard this issue?") && e.preventDefault()}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <header>
          <h2>New issue</h2>
          <select aria-label="App" value={t} onChange={(e) => setT(e.target.value)}>
            {teams.map((x) => <option key={x.id} value={x.key}>{x.name}</option>)}
          </select>
        </header>
        {!teams.length && <p className="err">Add an app in Settings first.</p>}
        <input ref={titleRef} className="title-input" aria-label="Title" required placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <MdEditor label="Description" value={description} onChange={setDescription} onSubmit={create} placeholder="Description (Markdown)" />
        <footer>
          <select aria-label="Priority" value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
            {PRIORITY.map((p, v) => <option key={v} value={v}>{p}</option>)}
          </select>
          {me.data && <span className="muted">as {me.data.name}</span>}
          <span className="spacer" />
          <button type="button" onClick={() => ref.current?.close()}>Cancel</button>
          <button className="primary" disabled={!title.trim() || !t}>Create issue</button>
        </footer>
      </form>
    </dialog>
  );
}

