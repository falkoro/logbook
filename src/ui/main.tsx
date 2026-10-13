// The shell: the sidebar, the top bar, routes, keyboard, live polling, toasts and the search palette.
import { type CSSProperties, type ReactNode, StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { type AppStat, ApiError, type Me, type Team, call, changes, nav, onToast, refresh, useLoad } from "./api";
import { type Activity, Avatar, Err, Icon, type IconName, StateDot, ago, hue, useDebounced } from "./bits";
import { Decisions } from "./decisions";
import { Home } from "./home";
import { IssueList, IssueView, NewIssue } from "./issues";
import { Releases } from "./releases";
import { Crew, DocView, Docs, LogView, Settings } from "./views";
import "./styles.css";

const here = () => location.pathname + location.search;
const usePath = () => {
  const [path, setPath] = useState(here);
  useEffect(() => {
    const on = () => setPath(here());
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return path;
};

// Internal links navigate without a reload; files and the API stay real requests.
document.addEventListener("click", (e) => {
  const a = (e.target as Element).closest?.("a");
  const href = a?.getAttribute("href");
  if (!a || !href || a.target || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (!href.startsWith("/") || href.startsWith("//") || /^\/(files|api|mcp|openapi\.json|healthz)\b/.test(href)) return;
  e.preventDefault();
  if (href !== here()) nav(href);
});

// The change feed only tells us that something moved; every visible view then refetches.
function usePolling() {
  useEffect(() => {
    let after = Number.MAX_SAFE_INTEGER;
    let first = true;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const r = await changes(first ? Number.MAX_SAFE_INTEGER : after);
        if (!first && r.last !== after) refresh();
        after = r.last;
        first = false;
      } catch {
        // Offline or redeploying; the next tick tries again.
      }
    };
    void poll();
    const t = setInterval(poll, 5000);
    const vis = () => !document.hidden && void poll();
    document.addEventListener("visibilitychange", vis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);
}

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || !!t.closest("input, textarea, select, dialog"));

// Browser storage only remembers small conveniences (the chosen app, what you have seen); it may be unavailable.
export const stored = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

function App() {
  const path = usePath();
  const [team, setTeamState] = useState(() => stored.get("lb.team") ?? "");
  const setTeam = (k: string) => {
    setTeamState(k);
    stored.set("lb.team", k);
  };
  const [creating, setCreating] = useState(false);
  const [searching, setSearching] = useState(false);
  const [menu, setMenu] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const me = useLoad(() => call<Me>("me"), []);
  const overview = useLoad(() => call<{ teams: AppStat[] }>("overview"), []);
  usePolling();

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    onToast((m) => {
      setMsg(m);
      clearTimeout(t);
      t = setTimeout(() => setMsg(null), 6000);
    });
  }, []);

  // A new page starts at the top with the menu folded, and focus moves to it for screen readers.
  const mainRef = useRef<HTMLElement>(null);
  const [pathname = ""] = path.split("?");
  useEffect(() => {
    setMenu(false);
    scrollTo(0, 0);
  }, [pathname]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSearching(true);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (e.key === "/") {
        e.preventDefault();
        setSearching(true);
      } else if (e.key === "c") {
        e.preventDefault();
        setCreating(true);
      } else if (e.key === "j" || e.key === "k") {
        const rows = [...document.querySelectorAll<HTMLElement>("[data-row]")];
        if (!rows.length) return;
        const at = rows.indexOf(document.activeElement as HTMLElement);
        const next = e.key === "j" ? Math.min(at + 1, rows.length - 1) : Math.max(at - 1, 0);
        rows[at < 0 ? 0 : next]!.focus();
        e.preventDefault();
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);

  if (me.error instanceof ApiError && me.error.status === 401) {
    return (
      <main className="login">
        <Mark />
        <h1>Logbook</h1>
        <p className="muted">Sign in through Cloudflare Access to continue.</p>
        <button className="primary" onClick={() => location.reload()}>Reload</button>
      </main>
    );
  }

  const apps = overview.data?.teams ?? [];
  const teams: Team[] = apps;
  const app = apps.find((t) => t.key === team);
  const waiting = apps.filter((t) => !team || t.key === team).reduce((n, t) => n + t.openDecisions, 0);
  const [, route = "", id = ""] = pathname.split("/").map(decodeURIComponent);
  const views: Record<string, () => ReactNode> = {
    "": () => <Home team={team} me={me.data} apps={apps} setTeam={setTeam} />,
    decisions: () => <Decisions team={team} />,
    inbox: () => <Decisions team={team} />,
    look: () => <IssueList key="look" team={team} teams={teams} look />,
    issues: () => <IssueList key="issues" team={team} teams={teams} />,
    triage: () => <IssueList key="triage" team={team} teams={teams} triage />,
    issue: () => <IssueView key={id} ident={id} />,
    releases: () => <Releases team={team} apps={apps} />,
    docs: () => <Docs team={team} teams={teams} />,
    doc: () => <DocView key={id} id={id} />,
    log: () => <LogView team={team} />,
    crew: () => <Crew />,
    settings: () => <Settings me={me.data} teams={teams} />,
  };
  const current = (to: string) =>
    to === "/"
      ? pathname === "/"
      : pathname.startsWith(to) || (to === "/issues" && route === "issue") || (to === "/docs" && route === "doc") || (to === "/decisions" && route === "inbox");
  const link = (to: string, icon: IconName, label: string, extra?: ReactNode) => (
    <a href={to} aria-current={current(to) ? "page" : undefined}>
      <Icon name={icon} />
      <span className="label">{label}</span>
      {extra}
    </a>
  );
  const busy = apps.filter((t) => t.open > 0);
  // With "All apps" picked, a new issue starts in the app with the most open work.
  const busiest = [...busy].sort((a, b) => b.open - a.open)[0]?.key ?? "";
  const quiet = apps.filter((t) => t.open === 0);

  return (
    <div className="app">
      <a className="skip" href="#main">Skip to content</a>
      <aside className="side" data-open={menu || undefined}>
        <div className="side-top">
          <a href="/" className="brand" aria-label="Logbook, today">
            <Mark /> <span>Logbook</span>
          </a>
          <button className="menu-toggle" aria-expanded={menu} aria-controls="side-menu" onClick={() => setMenu(!menu)}>
            <Icon name="menu" /> Menu
          </button>
        </div>
        <div className="switcher">
          <label htmlFor="app-switch">App</label>
          <div className="select-wrap">
            <select id="app-switch" value={team} onChange={(e) => setTeam(e.target.value)}>
              <option value="">All apps</option>
              {apps.map((t) => (
                <option key={t.id} value={t.key}>
                  {t.name}
                </option>
              ))}
            </select>
            <Icon name="down" />
          </div>
          <p>
            {app ? (
              app.live ? <>Live: <span className="mono">v{app.live.version.replace(/^v/i, "")}</span></> : "Nothing live yet"
            ) : apps.length ? (
              `${apps.length} apps, ${busy.length} with open issues`
            ) : null}
          </p>
        </div>
        <div className="side-menu" id="side-menu">
          <nav aria-label="Captain">
            <h2>Captain</h2>
            {link("/", "home", "Today")}
            {link("/decisions", "decide", "Inbox", waiting > 0 && <span className="brass-n" aria-label={`${waiting} open`}>{waiting}</span>)}
            {link("/look", "look", "Captain look")}
          </nav>
          <nav aria-label="Work">
            <h2>Work</h2>
            {link("/issues", "issues", "Issues")}
            {link("/triage", "triage", "Triage")}
            {link("/releases", "releases", "Releases")}
            {link("/docs", "docs", "Docs")}
            {link("/log", "log", "Log")}
          </nav>
          <AppsGroup busy={busy} quiet={quiet} team={team} setTeam={setTeam} />
          <nav className="side-foot" aria-label="Logbook">
            {link("/crew", "crew", "Crew")}
            {link("/settings", "settings", "Settings")}
            {me.data && (
              <a className="me" href="/settings#profile">
                <Avatar name={me.data.name} kind={me.data.kind} />
                <span>
                  <b>{me.data.name}</b>
                  <small>{me.data.kind === "human" ? "Captain" : "Agent"}</small>
                </span>
              </a>
            )}
          </nav>
        </div>
      </aside>
      <div className="main-col">
        <header className="topbar">
          <button className="search" aria-label="Search issues and comments" onClick={() => setSearching(true)}>
            <Icon name="search" />
            <span>Search issues and comments</span>
            <kbd>Ctrl K</kbd>
          </button>
          <Bell me={me.data} />
          <button className="primary new" onClick={() => setCreating(true)}>
            <Icon name="plus" /> <span>New issue</span>
          </button>
        </header>
        <main id="main" className="main" ref={mainRef} tabIndex={-1}>
          <Err e={me.error ?? overview.error} />
          {(views[route] ?? (() => <p className="empty">This page does not exist. <a href="/">Back to Today</a></p>))()}
        </main>
      </div>
      {creating && <NewIssue team={team || busiest} teams={teams} close={() => setCreating(false)} />}
      {searching && <Palette team={team} close={() => setSearching(false)} />}
      {msg && (
        <div className="toast" role="status">
          <span>{msg}</span>
          <button className="ghost" aria-label="Close" onClick={() => setMsg(null)}>×</button>
        </div>
      )}
    </div>
  );
}

/** Apps with open issues first; the quiet ones fold behind a button. */
function AppsGroup({ busy, quiet, team, setTeam }: { busy: AppStat[]; quiet: AppStat[]; team: string; setTeam: (k: string) => void }) {
  const [more, setMore] = useState(false);
  const item = (t: AppStat) => (
    <a
      key={t.id}
      href="/issues"
      aria-current={team === t.key ? "true" : undefined}
      onClick={() => setTeam(t.key)}
    >
      <span className="app-dot" style={{ "--h": hue(t.key) } as CSSProperties} aria-hidden="true" />
      <span className="label">{t.name}</span>
      {t.open > 0 && <span className="n">{t.open}</span>}
    </a>
  );
  return (
    <nav aria-label="Apps">
      <h2>Apps</h2>
      {busy.map(item)}
      {more && quiet.map(item)}
      {!!quiet.length && (
        <button className="side-more" aria-expanded={more} onClick={() => setMore(!more)}>
          <Icon name={more ? "down" : "chevron"} />
          <span className="label">{more ? "Fewer apps" : `${quiet.length} more apps`}</span>
        </button>
      )}
    </nav>
  );
}

/** What others did lately. The dot means something happened since you last opened this. */
function Bell({ me }: { me?: Me }) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(() => Number(stored.get("lb.seen") ?? 0));
  const ref = useRef<HTMLDivElement>(null);
  const { data } = useLoad(() => call<{ events: Activity[] }>("list_activity", { limit: 40 }), []);
  const events = (data?.events ?? []).filter((e) => e.actor?.id !== me?.id).slice(0, 12);
  const newest = events[0]?.syncId ?? 0;
  const unread = newest > seen;
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("mousedown", away);
    addEventListener("keydown", esc);
    return () => {
      removeEventListener("mousedown", away);
      removeEventListener("keydown", esc);
    };
  }, [open]);
  const toggle = () => {
    if (!open && newest) {
      setSeen(newest);
      stored.set("lb.seen", String(newest));
    }
    setOpen(!open);
  };
  return (
    <div className="bell" ref={ref}>
      <button className="icon-btn" aria-expanded={open} aria-label={unread ? "Notifications, new" : "Notifications"} onClick={toggle}>
        <Icon name="bell" />
        {unread && <span className="unread" aria-hidden="true" />}
      </button>
      {open && (
        <div className="pop" role="region" aria-label="Notifications">
          <h2>Notifications</h2>
          {events.length ? (
            <ol>
              {events.map((e) => (
                <li key={e.syncId}>
                  <a href={e.issue ? `/issue/${e.issue.id}` : "/log"} onClick={() => setOpen(false)}>
                    <Avatar name={e.actor?.name ?? "?"} kind={e.actor?.kind} />
                    <span>
                      <b>{e.actor?.name ?? "Someone"}</b> {e.summary}
                      {e.issue && <small>{e.issue.title}</small>}
                    </span>
                    <time className="mono" dateTime={e.at}>{ago(e.at)}</time>
                  </a>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">Nothing from the crew yet.</p>
          )}
          <a className="all" href="/log" onClick={() => setOpen(false)}>Full log</a>
        </div>
      )}
    </div>
  );
}

/** A logbook page: ruled lines and the margin rule the log hangs from. */
const Mark = () => (
  <svg className="mark" viewBox="0 0 20 20" aria-hidden="true">
    <rect width="20" height="20" rx="5" />
    <path d="M6.5 4v12" className="margin" />
    <path d="M9 7h6.5M9 10h6.5M9 13h4" />
  </svg>
);

// Search snippets mark hits with **…** and elide with …; show the hits as <mark> and drop the ellipses.
const Snippet = ({ text }: { text: string }) => (
  <span className="snippet">{text.replace(/…/g, "").trim().split("**").map((s, i) => (i % 2 ? <mark key={i}>{s}</mark> : s))}</span>
);

function Palette({ team, close }: { team: string; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const q = useDebounced(query.trim(), 150);
  const { data, error } = useLoad(
    () => (q ? call("search", { query: q, limit: 20, ...(team && { team }) }) : Promise.resolve(null)),
    [q, team],
  );
  useEffect(() => ref.current?.showModal(), []);
  useEffect(() => setAt(0), [data]);
  const hits: { to: string; head: string; title: string; snippet?: string; type?: string }[] = [
    ...(data?.issues ?? []).map((i: any) => ({ to: `/issue/${i.id}`, head: i.id, title: i.title, snippet: i.snippet, type: i.statusType })),
    ...(data?.comments ?? []).map((c: any) => ({ to: `/issue/${c.issue}#${c.commentId}`, head: c.issue, title: c.issueTitle, snippet: c.snippet })),
  ];
  const go = (to: string) => {
    ref.current?.close();
    nav(to);
  };
  return (
    <dialog ref={ref} className="modal palette" aria-label="Search" onClose={close} onClick={(e) => e.target === ref.current && ref.current.close()}>
      <div className="palette-in">
        <Icon name="search" />
        <input
          autoFocus
          type="search"
          aria-label="Search"
          placeholder={team ? `Search in ${team}` : "Search issues and comments"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setAt((n) => Math.max(0, Math.min(hits.length - 1, n + (e.key === "ArrowDown" ? 1 : -1))));
            }
            if (e.key === "Enter" && hits[at]) go(hits[at].to);
            // A search field eats the first Escape to clear itself; close in one press instead.
            if (e.key === "Escape") {
              e.preventDefault();
              ref.current?.close();
            }
          }}
        />
      </div>
      <Err e={error} />
      <div className="hits">
        {hits.map((h, n) => (
          <a key={h.to} href={h.to} className="hit" aria-selected={n === at} onClick={(e) => (e.preventDefault(), go(h.to))}>
            {h.type ? <StateDot type={h.type} /> : <span className="sdot comment" role="img" aria-label="Comment" />}
            <span className="ident mono">{h.head}</span>
            <span className="htitle">
              {h.title}
              {h.snippet && <Snippet text={h.snippet} />}
            </span>
          </a>
        ))}
        {q && data && !hits.length && <p className="empty">Nothing found.</p>}
        {!q && <p className="muted hint">Type a word or an ID like ENG-12. Arrows pick, Enter opens.</p>}
      </div>
    </dialog>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
