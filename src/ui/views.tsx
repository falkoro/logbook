// Docs, Log, Crew and Settings.
import { type CSSProperties, useEffect, useState } from "react";
import { type Me, type Team, act, call, nav, param, refresh, useLoad } from "./api";
import { type Activity, Avatar, Err, Icon, Loading, Log, Md, MdEditor, PageHead, ago, copy, hue, since, useDebounced } from "./bits";

export function LogView({ team }: { team: string }) {
  const actor = param("actor") ?? "";
  const [n, setN] = useState(1);
  useEffect(() => setN(1), [team, actor]);
  const users = useLoad(() => call("list_users"), []);
  const { data, error } = useLoad(async () => {
    const events: Activity[] = [];
    let before: number | null = null;
    for (let i = 0; i < n; i++) {
      const r: { events: Activity[]; next: number | null } = await call("list_activity", {
        limit: 100,
        full: true,
        ...(team && { team }),
        ...(actor && { actor }),
        ...(before != null && { before }),
      });
      events.push(...r.events);
      before = r.next;
      if (before == null) break;
    }
    return { events, more: before != null };
  }, [team, actor, n]);
  return (
    <div className="page narrow">
      <PageHead kicker="Work" title="Log" sub="Every change by people and agents, newest first.">
        <select aria-label="Who" value={actor} onChange={(e) => nav(e.target.value ? `/log?actor=${encodeURIComponent(e.target.value)}` : "/log")}>
          <option value="">Everyone</option>
          {users.data?.users.map((u: any) => <option key={u.id} value={u.name}>{u.name}</option>)}
        </select>
      </PageHead>
      <Err e={error} />
      {!data && !error && <Loading />}
      {data && (data.events.length ? <Log events={data.events} /> : <p className="empty">Nothing logged yet{actor && ` by ${actor}`}.</p>)}
      {data?.more && <button className="more" onClick={() => setN(n + 1)}>Older entries</button>}
    </div>
  );
}

export function Docs({ team, teams }: { team: string; teams: Team[] }) {
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim());
  const { data, error } = useLoad(() => call("list_documents", { limit: 100, ...(team && { team }), ...(q && { query: q }) }), [team, q]);
  const create = async () => {
    const title = prompt("Document title:")?.trim();
    if (!title) return;
    const d = await act(call("save_document", { title, content: "", ...((team || teams[0]) && { team: team || teams[0]!.key }) }));
    if (d) nav(`/doc/${d.id}?edit`);
  };
  return (
    <div className="page">
      <PageHead kicker="Work" title="Docs" sub="Specs, release notes and everything worth keeping next to the work.">
        <button className="primary" onClick={create}><Icon name="plus" /> New doc</button>
      </PageHead>
      <div className="filters">
        <label className="filter-search">
          <Icon name="search" />
          <input type="search" aria-label="Search docs" placeholder="Search docs" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      <Err e={error} />
      {!data && !error && <Loading />}
      <div className="llist card">
        {data?.documents.map((d: any) => (
          <a key={d.id} className="lrow" data-row href={`/doc/${d.id}`}>
            <Icon name="docs" />
            <span className="ltitle">{d.title}</span>
            {d.team && <span className="muted">{d.team}</span>}
            <Avatar name={d.creator} />
            <time className="mono muted" dateTime={d.updatedAt}>{ago(d.updatedAt)}</time>
          </a>
        ))}
        {data && !data.documents.length && <p className="empty">{q ? "No docs found." : "No docs yet."}</p>}
      </div>
    </div>
  );
}

export function DocView({ id }: { id: string }) {
  const { data: d, error } = useLoad(() => call("get_document", { id }), [id]);
  const [draft, setDraft] = useState<{ title: string; content: string } | null>(null);
  // A document created from the list opens straight in edit mode.
  useEffect(() => {
    if (d && location.search === "?edit") {
      history.replaceState(null, "", location.pathname);
      setDraft({ title: d.title, content: d.content });
    }
  }, [!!d]);
  if (!d) return error ? <Err e={error} /> : <Loading />;
  const save = async () => {
    if (draft && (await act(call("save_document", { id, title: draft.title.trim() || d.title, content: draft.content })))) setDraft(null);
  };
  return (
    <article className="page doc">
      <nav className="crumbs" aria-label="Breadcrumbs">
        <ol>
          <li><a href="/docs">Docs</a></li>
          {d.team && <li>{d.team}</li>}
        </ol>
        {d.archivedAt && <span className="pill">archived</span>}
      </nav>
      {draft ? (
        <>
          <input className="title-input" aria-label="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <MdEditor autoFocus label="Content" value={draft.content} onChange={(content) => setDraft({ ...draft, content })} onSubmit={save} onCancel={() => setDraft(null)} />
          <div className="actions">
            <button className="primary" onClick={save}>Save</button>
            <button onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <h1 className="doc-title">{d.title}</h1>
          <p className="muted">{d.creator ?? "Someone"}, updated {since(d.updatedAt)}</p>
          <div className="card doc-body">{d.content ? <Md text={d.content} /> : <p className="muted">Empty.</p>}</div>
          <div className="actions">
            <button onClick={() => setDraft({ title: d.title, content: d.content })}>Edit</button>
            <button className="ghost" onClick={() => act(call("save_document", { id, archived: !d.archivedAt }))}>{d.archivedAt ? "Restore" : "Archive"}</button>
          </div>
        </>
      )}
      {!!d.issues.length && (
        <p className="muted">
          Belongs to {d.issues.map((i: string, n: number) => <span key={i}>{n ? ", " : ""}<a className="mono" href={`/issue/${i}`}>{i}</a></span>)}
        </p>
      )}
    </article>
  );
}

export function Crew() {
  const users = useLoad(() => call("list_users"), []);
  const role = (k: string) => (k === "human" ? "Captain" : k === "agent" ? "Agent" : "System");
  return (
    <div className="page narrow">
      <PageHead kicker="Logbook" title="Crew" sub="Everyone who writes here. Agents join when you give them a token or approve a connector." />
      <Err e={users.error} />
      {!users.data && !users.error && <Loading />}
      <ul className="crew">
        {users.data?.users.map((u: any) => {
          const fresh = u.lastActiveAt && Date.now() - Date.parse(u.lastActiveAt) < 15 * 60_000;
          return (
            <li key={u.id}>
              <a className="card crew-card" href={`/log?actor=${encodeURIComponent(u.name)}`}>
                <Avatar name={u.name} kind={u.kind} size="lg" />
                <span className="crew-who">
                  <b>{u.name}</b>
                  <small>{role(u.kind)}{u.email && ` · ${u.email}`}</small>
                </span>
                <span className="crew-when">
                  {fresh && <span className="live-dot" aria-hidden="true" />}
                  {u.lastActiveAt ? `active ${since(u.lastActiveAt)}` : "not active yet"}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const CopyLine = ({ text, what }: { text: string; what?: string }) => (
  <div className="copyline">
    <code>{text}</code>
    <button className="ghost" onClick={() => copy(text, what)}><Icon name="copy" /> Copy</button>
  </div>
);

export function Settings({ me, teams }: { me?: Me; teams: Team[] }) {
  const [revoked, setRevoked] = useState(false);
  const tokens = useLoad(() => call("list_tokens", { includeRevoked: revoked }), [revoked]);
  const [form, setForm] = useState({ name: "", actor: "", kind: "agent" });
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [teamForm, setTeamForm] = useState({ key: "", name: "" });
  const [name, setName] = useState<string | null>(null);
  const mcp = `${location.origin}/mcp`;
  useEffect(() => {
    const at = location.hash ? document.getElementById(location.hash.slice(1)) : null;
    at?.scrollIntoView();
  }, []);
  return (
    <div className="page narrow settings">
      <PageHead kicker="Logbook" title="Settings" sub={me && <>Signed in as {me.name}{me.email && ` (${me.email})`}.</>} />

      {me?.kind === "human" && (
        <section className="card" id="profile" aria-labelledby="profile-h">
          <h2 id="profile-h">Your name</h2>
          <p className="muted">This is how the crew and the log see you. The e-mail address you sign in with stays the same.</p>
          <form
            className="inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (name?.trim() && (await act(call("save_profile", { name: name.trim() })))) {
                setName(null);
                refresh();
              }
            }}
          >
            <input aria-label="Name" maxLength={60} value={name ?? me.name} onChange={(e) => setName(e.target.value)} />
            <button className="primary" disabled={!name?.trim() || name.trim() === me.name}>Save</button>
          </form>
        </section>
      )}

      <section className="card" aria-labelledby="connect-h">
        <h2 id="connect-h">Connect an agent</h2>
        <div className="ways">
          <article>
            <h3>claude.ai and Cowork</h3>
            <p>Add a custom connector with this URL. There is no client ID or secret: you approve it here once and it joins the crew as an agent named after the app.</p>
            <CopyLine text={mcp} what="MCP URL" />
          </article>
          <article>
            <h3>Claude Code and other MCP clients</h3>
            <p>Create a token below and add the server with it:</p>
            <CopyLine text={`claude mcp add --transport http logbook ${mcp} --header "Authorization: Bearer <token>"`} what="command" />
          </article>
          <article>
            <h3>Scripts</h3>
            <p>
              Every MCP tool is also <code>POST {location.origin}/api/&lt;tool&gt;</code> with the same token. The <a href="/openapi.json">OpenAPI spec</a> lists them all.
            </p>
          </article>
        </div>
      </section>

      <section className="card" aria-labelledby="tokens-h">
        <h2 id="tokens-h">Tokens and connections</h2>
        {created && (
          <div className="token-once" role="status">
            <p>Copy the token for <b>{created.name}</b> now. It will not be shown again.</p>
            <div className="inline-form">
              <input readOnly className="mono" aria-label="Token" value={created.token} onFocus={(e) => e.target.select()} />
              <button onClick={() => copy(created.token, "token")}><Icon name="copy" /> Copy</button>
              <button className="ghost" onClick={() => setCreated(null)}>Done</button>
            </div>
          </div>
        )}
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const t = await act(call("create_token", form));
            if (t) {
              setCreated(t);
              setForm({ name: "", actor: "", kind: "agent" });
            }
          }}
        >
          <input aria-label="Token name" placeholder="What uses it, e.g. claude-code-laptop" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input aria-label="Acts as" placeholder="Acts as, e.g. claude" required value={form.actor} onChange={(e) => setForm({ ...form, actor: e.target.value })} />
          <select aria-label="Kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="agent">Agent</option>
            <option value="system">System job</option>
          </select>
          <button className="primary">Create token</button>
        </form>
        <Err e={tokens.error} />
        <div className="llist">
          {tokens.data?.tokens.map((t: any) => (
            <div key={t.id} className={`lrow${t.revokedAt ? " dim" : ""}`}>
              <Avatar name={t.actor} kind={t.kind} />
              <span className="ltitle">{t.name}</span>
              <span className="muted">acts as {t.actor}</span>
              <span className="muted">{t.lastUsedAt ? `used ${since(t.lastUsedAt)}` : "never used"}</span>
              {t.revokedAt ? (
                <span className="pill">revoked</span>
              ) : (
                <button className="ghost danger" onClick={() => confirm(`Revoke ${t.name}? It stops working immediately.`) && act(call("revoke_token", { id: t.id }))}>
                  Revoke
                </button>
              )}
            </div>
          ))}
          {tokens.data && !tokens.data.tokens.length && <p className="empty">No tokens yet.</p>}
        </div>
        <label className="check">
          <input type="checkbox" checked={revoked} onChange={(e) => setRevoked(e.target.checked)} /> Show revoked tokens
        </label>
      </section>

      <section className="card" id="apps" aria-labelledby="apps-h">
        <h2 id="apps-h">Apps</h2>
        <p className="muted">One per product. The key prefixes every issue ID, like ENG-12. The domains show on the route of every release.</p>
        <ul className="app-settings">
          {teams.map((t) => <AppRow key={t.id} t={t} />)}
        </ul>
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act(call("save_team", teamForm))) setTeamForm({ key: "", name: "" });
          }}
        >
          <input aria-label="Key" className="mono" placeholder="KEY" pattern="[A-Z][A-Z0-9]{0,9}" title="1 to 10 capital letters or digits, starting with a letter" required
            value={teamForm.key} onChange={(e) => setTeamForm({ ...teamForm, key: e.target.value.toUpperCase() })} />
          <input aria-label="Name" placeholder="Name" required value={teamForm.name} onChange={(e) => setTeamForm({ ...teamForm, name: e.target.value })} />
          <button className="primary">Add app</button>
        </form>
      </section>
    </div>
  );
}

function AppRow({ t }: { t: Team }) {
  const [urls, setUrls] = useState({ stagingUrl: t.stagingUrl ?? "", liveUrl: t.liveUrl ?? "" });
  const changed = urls.stagingUrl !== (t.stagingUrl ?? "") || urls.liveUrl !== (t.liveUrl ?? "");
  return (
    <li>
      <form
        className="app-row"
        onSubmit={(e) => {
          e.preventDefault();
          void act(call("save_team", { id: t.id, stagingUrl: urls.stagingUrl.trim() || null, liveUrl: urls.liveUrl.trim() || null }));
        }}
      >
        <span className="with-dot app-name">
          <span className="app-dot" style={{ "--h": hue(t.key) } as CSSProperties} aria-hidden="true" />
          <b>{t.name}</b> <span className="mono muted">{t.key}</span>
        </span>
        <label className="url-field">
          <span>Staging</span>
          <input type="url" className="mono" placeholder="https://test.example.com" value={urls.stagingUrl} onChange={(e) => setUrls({ ...urls, stagingUrl: e.target.value })} />
        </label>
        <label className="url-field">
          <span>Live</span>
          <input type="url" className="mono" placeholder="https://example.com" value={urls.liveUrl} onChange={(e) => setUrls({ ...urls, liveUrl: e.target.value })} />
        </label>
        <button disabled={!changed}>Save</button>
      </form>
    </li>
  );
}
