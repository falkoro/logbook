// Releases: the next one large (progress, route to live, what blocks it), then everything that shipped before.
import { type CSSProperties, useState } from "react";
import { type AppStat, type Decision, type Release, act, call, useLoad } from "./api";
import { Err, Icon, Loading, PageHead, day, hue, plural } from "./bits";

const STATUS: Record<Release["status"], string> = { planned: "Planned", staging: "Staging", live: "Live", rolled_back: "Rolled back" };
const vee = (v: string) => `v${v.replace(/^v/i, "")}`;
const host = (url?: string | null) => (url ? url.replace(/^https?:\/\//, "").replace(/\/$/, "") : null);

const parts = (v: string) => v.replace(/^v/i, "").split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
/** Last deployed day first; within a day (or never deployed) by version, highest first. */
function newestFirst(a: Release, b: Release) {
  const when = (b.deployedAt ?? "").slice(0, 10).localeCompare((a.deployedAt ?? "").slice(0, 10));
  if (when) return when;
  const [x, y] = [parts(a.version), parts(b.version)];
  for (let n = 0; n < Math.max(x.length, y.length); n++) if ((y[n] ?? 0) !== (x[n] ?? 0)) return (y[n] ?? 0) - (x[n] ?? 0);
  return 0;
}

/** Per app the release that goes out next: one on staging first, else the oldest planned one. */
function nextPerApp(rs: Release[]) {
  const next = new Map<string, Release>();
  for (const r of [...rs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (r.status !== "planned" && r.status !== "staging") continue;
    const had = next.get(r.teamKey);
    if (!had || (r.status === "staging" && had.status !== "staging")) next.set(r.teamKey, r);
  }
  return [...next.values()];
}

export function Releases({ team, apps }: { team: string; apps: AppStat[] }) {
  const { data, error } = useLoad(() => call<{ releases: Release[] }>("list_releases", { limit: 100, ...(team && { team }) }), [team]);
  const all = data?.releases ?? [];
  const next = nextPerApp(all);
  const [showAll, setShowAll] = useState(false);
  const rest = all.filter((r) => !next.includes(r)).sort(newestFirst);
  const shown = showAll ? rest : rest.slice(0, 20);
  const app = apps.find((a) => a.key === team);
  return (
    <div className="page releases">
      <PageHead
        kicker={app?.name ?? "All apps"}
        title="Releases"
        sub="A release goes from planned via staging to live. Setting it live closes the issues in it and writes the release notes."
      />
      <Err e={error} />
      {!data && !error && <Loading />}
      {next.map((r) => (
        <NextRelease key={r.id} r={r} app={apps.find((a) => a.key === r.teamKey)} />
      ))}
      {data && !next.length && <p className="empty">No release is planned. Plan one below.</p>}

      <section className="card" aria-labelledby="earlier-h">
        <header className="card-head">
          <h2 id="earlier-h">Earlier releases</h2>
        </header>
        {rest.length ? (
          <table className="rel-table">
            <thead>
              <tr>
                {!team && <th scope="col">App</th>}
                <th scope="col">Version</th>
                <th scope="col">Status</th>
                <th scope="col">Deployed</th>
                <th scope="col">Issues done</th>
                <th scope="col">Release notes</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  {!team && (
                    <td data-label="App">
                      <span className="with-dot">
                        <span className="app-dot" style={{ "--h": hue(r.teamKey) } as CSSProperties} aria-hidden="true" />
                        {r.team}
                      </span>
                    </td>
                  )}
                  <th scope="row" className="mono" data-label="Version">{vee(r.version)}</th>
                  <td data-label="Status"><span className={`rstatus rs-${r.status}`}>{STATUS[r.status]}</span></td>
                  <td data-label="Deployed" className="mono">{r.deployedAt ? day(r.deployedAt) : "not yet"}</td>
                  <td data-label="Issues done" className="mono">{r.done} of {r.issues}</td>
                  <td data-label="Release notes">{r.notesDocId ? <a href={`/doc/${r.notesDocId}`}>Read the notes</a> : <span className="muted">none</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted pad-s">No earlier releases yet.</p>
        )}
        {rest.length > shown.length && (
          <button className="more" onClick={() => setShowAll(true)}>Show all {rest.length} releases</button>
        )}
      </section>

      <PlanRelease team={team} apps={apps} />
    </div>
  );
}

function NextRelease({ r, app }: { r: Release; app?: AppStat }) {
  const blocking = useLoad(() => call<{ decisions: Decision[] }>("list_decisions", { release: r.id, status: "open" }), [r.id]);
  const pct = r.issues ? Math.round((r.done / r.issues) * 100) : 0;
  const move = (status: Release["status"]) => {
    if (status === "live") {
      const left = r.issues - r.done;
      const msg = `Set ${r.team} ${vee(r.version)} live?${left ? ` ${plural(left, "unfinished issue moves", "unfinished issues move")} to Done.` : ""} Each issue gets a comment "Live in ${vee(r.version)}" and the release notes are written.`;
      if (!confirm(msg)) return;
    }
    void act(call("set_release_status", { release: r.id, status }));
  };
  const steps: { key: Release["status"]; name: string; where: string | null }[] = [
    { key: "planned", name: "Planned", where: plural(r.issues, "issue", "issues") },
    { key: "staging", name: "Staging", where: host(app?.stagingUrl) },
    { key: "live", name: "Live", where: host(app?.liveUrl) },
  ];
  const at = steps.findIndex((s) => s.key === r.status);
  const open = blocking.data?.decisions ?? [];
  return (
    <section className="next-rel" aria-labelledby={`nr-${r.id}`}>
      <div className="nr-head">
        <div>
          <p className="kicker">Next release · {r.team}</p>
          <h2 id={`nr-${r.id}`} className="mono">{vee(r.version)}</h2>
          <p className="muted">
            Planned on {day(r.createdAt)}
            {app?.live && <>, now live: <span className="mono">{vee(app.live.version)}</span></>}
          </p>
        </div>
        <div className="nr-actions">
          {r.status === "planned" && <button className="primary" onClick={() => move("staging")}>To staging</button>}
          {r.status === "staging" && <button className="primary" onClick={() => move("live")}>Set live</button>}
          {r.status === "staging" && <button onClick={() => move("planned")}>Back to planned</button>}
          <a className="btn" href={`/issues?release=${encodeURIComponent(r.version)}`}>Issues in this release</a>
        </div>
      </div>

      <div className="nr-progress">
        <div className="meter" role="progressbar" aria-label="Done" aria-valuemin={0} aria-valuemax={r.issues} aria-valuenow={r.done}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <p><b className="mono">{r.done}</b> of <b className="mono">{r.issues}</b> issues done</p>
      </div>

      <ol className="route" aria-label="Route to live">
        {steps.map((s, n) => (
          <li key={s.key} data-state={n < at ? "done" : n === at ? "now" : "todo"} aria-current={n === at ? "step" : undefined}>
            <span className="rdot" aria-hidden="true">{n < at ? <Icon name="check" /> : null}</span>
            <span className="rname">{s.name}</span>
            {s.where &&
              (s.key !== "planned" && (s.key === "staging" ? app?.stagingUrl : app?.liveUrl) ? (
                <a className="mono" href={(s.key === "staging" ? app?.stagingUrl : app?.liveUrl)!} target="_blank" rel="noopener noreferrer">{s.where}</a>
              ) : (
                <span className="mono">{s.where}</span>
              ))}
            {!s.where && s.key !== "planned" && <a className="muted" href="/settings#apps">set domain</a>}
          </li>
        ))}
      </ol>

      <div className="blocking">
        <h3>What blocks this release</h3>
        <Err e={blocking.error} />
        {blocking.data &&
          (open.length ? (
            <ul>
              {open.map((d) => (
                <li key={d.id}>
                  <a href={`/decisions?d=${d.id}`}>
                    <span className="brass-dot" aria-hidden="true" />
                    <span className="dm-title">{d.title}</span>
                    <span className="mono">{d.issue}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No open decisions on issues in this release.</p>
          ))}
      </div>
    </section>
  );
}

function PlanRelease({ team, apps }: { team: string; apps: AppStat[] }) {
  const [t, setT] = useState(team);
  const [version, setVersion] = useState("");
  const pick = t || team || apps[0]?.key || "";
  return (
    <section className="card plan" aria-labelledby="plan-h">
      <header className="card-head">
        <h2 id="plan-h">Plan a release</h2>
      </header>
      <form
        className="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (pick && version.trim() && (await act(call("save_release", { team: pick, version: version.trim() })))) setVersion("");
        }}
      >
        <select aria-label="App" value={pick} onChange={(e) => setT(e.target.value)}>
          {apps.map((a) => <option key={a.id} value={a.key}>{a.name}</option>)}
        </select>
        <input aria-label="Version" className="mono" placeholder="Version, e.g. 1.4.0" value={version} onChange={(e) => setVersion(e.target.value)} />
        <button className="primary" disabled={!version.trim() || !apps.length}>Plan</button>
      </form>
      <p className="muted">Then put issues in the release from their own page.</p>
    </section>
  );
}
