// Today: what waits on you, how the work stands, and every app at a glance.
import type { CSSProperties } from "react";
import { type AppStat, type Decision, type Me, type Release, call, useLoad } from "./api";
import { Avatar, Err, Icon, ago, day, hue, plural } from "./bits";

const greeting = () => {
  const h = new Date().getHours();
  return h < 6 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

const vee = (v: string) => `v${v.replace(/^v/i, "")}`;
const STATUS: Record<Release["status"], string> = { planned: "Planned", staging: "Staging", live: "Live", rolled_back: "Rolled back" };

export function Home({ team, me, apps, setTeam }: { team: string; me?: Me; apps: AppStat[]; setTeam: (k: string) => void }) {
  const open = useLoad(() => call<{ decisions: Decision[] }>("list_decisions", { status: "open", limit: 4, ...(team && { team }) }), [team]);
  const rels = useLoad(() => call<{ releases: Release[] }>("list_releases", { limit: 4, ...(team && { team }) }), [team]);
  const shown = apps.filter((t) => !team || t.key === team);
  const sum = (k: keyof AppStat) => shown.reduce((n, t) => n + ((t[k] as number) ?? 0), 0);
  const waiting = sum("openDecisions");
  const openN = sum("open");
  const urgent = sum("urgent");
  const triage = sum("triage");
  const rest = Math.max(0, openN - urgent - triage);
  const busy = shown.filter((t) => t.open > 0);
  const quiet = shown.filter((t) => t.open === 0);
  const first = me?.name.split(/[\s(]/)[0];
  return (
    <div className="page home">
      <header className="phead">
        <div>
          <p className="kicker">{new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</p>
          <h1>{greeting()}{first ? `, ${first}` : ""}</h1>
          <p className="sub">{team ? `You are looking at ${shown[0]?.name ?? team}.` : `All ${plural(apps.length, "app", "apps")} at a glance.`}</p>
        </div>
      </header>

      <section className="waits" aria-labelledby="waits-h">
        <div className="waits-main">
          <h2 id="waits-h">Waiting on you</h2>
          <p className="big">
            <span className="num">{waiting}</span>
            <span>{waiting === 1 ? "open decision" : "open decisions"}</span>
          </p>
          <p className="waits-sub">{waiting ? "The crew is waiting on your answer before it can go on." : "Nothing is holding the crew up."}</p>
          {waiting > 0 && (
            <a className="brass-btn" href="/decisions">
              Open inbox <Icon name="arrow" />
            </a>
          )}
        </div>
        <div className="waits-rel">
          <h3>Latest releases</h3>
          <Err e={rels.error} />
          {rels.data && (rels.data.releases.length ? (
            <ol className="tl">
              {rels.data.releases.map((r) => (
                <li key={r.id} data-status={r.status}>
                  <span className="tl-dot" aria-hidden="true" />
                  <span className="tl-v mono">{r.teamKey} {vee(r.version)}</span>
                  <span className="tl-s">{STATUS[r.status]}</span>
                  <span className="tl-d mono">{r.deployedAt ? day(r.deployedAt) : `${r.done} of ${r.issues} done`}</span>
                </li>
              ))}
            </ol>
          ) : <p>No releases yet.</p>)}
          <a href="/releases">All releases</a>
        </div>
      </section>

      <div className="stat-cards">
        <a className="card stat" href="/issues">
          <h2>Open issues</h2>
          <p className="num">{openN}</p>
          <ul className="split">
            <li><span className="sw urgent" aria-hidden="true" />{urgent} urgent</li>
            <li><span className="sw triage" aria-hidden="true" />{triage} triage</li>
            <li><span className="sw rest" aria-hidden="true" />{rest} other</li>
          </ul>
          {openN > 0 && (
            <span className="bar" aria-hidden="true">
              <i className="urgent" style={{ flexGrow: urgent }} />
              <i className="triage" style={{ flexGrow: triage }} />
              <i className="rest" style={{ flexGrow: rest }} />
            </span>
          )}
        </a>
        <a className="card stat" href="/issues">
          <h2>In progress</h2>
          <p className="num">{sum("inProgress")}</p>
          <p className="muted">What the crew is working on right now.</p>
        </a>
        <a className="card stat" href="/log">
          <h2>Done this week</h2>
          <p className="num">{sum("doneThisWeek")}</p>
          <p className="muted">Completed in the last seven days.</p>
        </a>
      </div>

      <section className="card" aria-labelledby="oldest-h">
        <header className="card-head">
          <h2 id="oldest-h">Oldest open decisions</h2>
          {waiting > 4 && <a href="/decisions">All {waiting} decisions</a>}
        </header>
        <Err e={open.error} />
        {open.data && (open.data.decisions.length ? (
          <ol className="dec-mini">
            {open.data.decisions.map((d) => (
              <li key={d.id}>
                <a href={`/decisions?d=${d.id}`}>
                  <span className="brass-dot" aria-hidden="true" />
                  <span className="dm-title">{d.title}</span>
                  <span className="dm-meta">
                    <span className="mono">{d.issue ?? d.teamKey}</span>
                    <Avatar name={d.askedBy} kind={d.askedByKind} />
                    <time className="mono" dateTime={d.createdAt}>{ago(d.createdAt)}</time>
                  </span>
                </a>
              </li>
            ))}
          </ol>
        ) : <p className="muted pad-s">No open decisions.</p>)}
      </section>

      <section className="card" aria-labelledby="apps-h">
        <header className="card-head">
          <h2 id="apps-h">Apps</h2>
        </header>
        {busy.length ? (
          <table className="apps-table">
            <thead>
              <tr>
                <th scope="col">App</th>
                <th scope="col">Open</th>
                <th scope="col">In progress</th>
                <th scope="col">Triage</th>
                <th scope="col">Urgent</th>
                <th scope="col">Live</th>
              </tr>
            </thead>
            <tbody>
              {busy.map((t) => (
                <tr key={t.id}>
                  <th scope="row">
                    <a href="/issues" onClick={() => setTeam(t.key)}>
                      <span className="app-dot" style={{ "--h": hue(t.key) } as CSSProperties} aria-hidden="true" />
                      {t.name}
                      <span className="mono key">{t.key}</span>
                    </a>
                    {t.openDecisions > 0 && <a className="brass-tag" href="/decisions" onClick={() => setTeam(t.key)}>{plural(t.openDecisions, "decision", "decisions")}</a>}
                  </th>
                  <td data-label="Open">{t.open}</td>
                  <td data-label="In progress">{t.inProgress}</td>
                  <td data-label="Triage">{t.triage}</td>
                  <td data-label="Urgent" className={t.urgent ? "hot" : undefined}>{t.urgent}</td>
                  <td data-label="Live" className="mono">{t.live ? vee(t.live.version) : "not yet"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted pad-s">No app has open issues.</p>
        )}
        {!!quiet.length && (
          <div className="quiet">
            <h3>No open issues</h3>
            <ul className="keys">
              {quiet.map((t) => (
                <li key={t.id}>
                  <a className="key-chip mono" href="/issues" title={t.name} onClick={() => setTeam(t.key)}>
                    {t.key}
                    <span className="visually-hidden">, {t.name}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
