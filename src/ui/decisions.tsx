// Decisions: what waits on the captain, oldest first, and the form that answers it here or on its issue.
import { useEffect, useRef, useState } from "react";
import { type Decision, act, call, getMe, nav, param, useLoad } from "./api";
import { Avatar, Err, Loading, Md, PageHead, Tabs, ago, plural, since } from "./bits";

/**
 * The asker's recommendation names an option by number ("1. Because…", "Option 2, with A…"; "optie" is accepted too) or repeats it word for word.
 * What follows the number is the why. Anything else is advice that points at no option.
 */
export function readRecommendation(d: Pick<Decision, "options" | "recommendation">) {
  const r = d.recommendation?.trim();
  if (!r) return { pick: null, why: "" };
  const exact = d.options.findIndex((o) => o.trim() === r);
  if (exact >= 0) return { pick: exact, why: "" };
  const m = /^(?:optie|option)?\s*(\d+)\s*(?:[.,:)]\s*|$)/i.exec(r);
  const n = m ? Number(m[1]) - 1 : -1;
  if (m && n >= 0 && n < d.options.length) return { pick: n, why: r.slice(m[0].length).trim() };
  return { pick: null, why: r };
}

const REVIEW = ["Looks good", "Needs changes"];

/** Pick an option (the recommended one is marked), add a note, send. The answer also lands on the issue as a comment. */
export function DecisionForm({ d, onDone, onLater }: { d: Decision; onDone?: () => void; onLater?: () => void }) {
  const me = useLoad(getMe, []);
  const options = d.options.length ? d.options : d.kind === "review" ? REVIEW : [];
  const rec = readRecommendation({ ...d, options });
  const [pick, setPick] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const asker = d.askedBy ?? "the asker";
  const captain = me.data?.kind === "human";
  const ready = captain && !busy && (options.length ? pick !== null : !!note.trim());
  const send = async () => {
    if (!ready) return;
    const answer = [pick !== null ? options[pick] : "", note.trim()].filter(Boolean).join("\n\n");
    setBusy(true);
    const r = await act(call("answer_decision", { id: d.id, answer }));
    setBusy(false);
    if (r) onDone?.();
  };
  return (
    <form
      className="dform"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {!!options.length && (
        <fieldset className="opts">
          <legend>Your choice</legend>
          {options.map((o, i) => (
            <label key={i} className="opt" data-rec={i === rec.pick || undefined}>
              <input type="radio" name={`opt-${d.id}`} checked={pick === i} onChange={() => setPick(i)} />
              <span className="opt-n mono" aria-hidden="true">{i + 1}</span>
              <span className="opt-text">
                {o}
                {i === rec.pick && <span className="rec-tag">Recommended by {asker}</span>}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {rec.why && (
        <div className="why">
          <h3>{rec.pick === null ? `Advice from ${asker}` : `Why ${asker} recommends this`}</h3>
          <Md text={rec.why} />
        </div>
      )}
      <label className="field-label" htmlFor={`note-${d.id}`}>
        {options.length ? <>Note <span className="muted">(optional)</span></> : "Your answer"}
      </label>
      <textarea
        id={`note-${d.id}`}
        rows={3}
        value={note}
        placeholder={options.length ? "For example: agreed, except 5 and 13" : "Write your decision"}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void send()}
      />
      {me.data && !captain && <p className="muted">Only the captain can decide; you are signed in as {me.data.name}.</p>}
      <div className="actions">
        <button className="primary" disabled={!ready}>{busy ? "Sending" : "Send answer"}</button>
        {onLater && <button type="button" onClick={onLater}>Decide later</button>}
      </div>
    </form>
  );
}

/** The question as a heading, the full text under it, then the form or the answer. */
export function DecisionDetail({ d, onDone, onLater, onIssue }: { d: Decision; onDone?: () => void; onLater?: () => void; onIssue?: boolean }) {
  const withdraw = () => {
    const reason = prompt("Withdraw this decision? Reason (optional):");
    if (reason !== null) void act(call("withdraw_decision", { id: d.id, ...(reason.trim() && { reason: reason.trim() }) })).then((r) => r && onDone?.());
  };
  return (
    <article className={`decision ${d.status}`} aria-labelledby={`dq-${d.id}`}>
      <p className="kicker">
        {d.kind === "review" ? "For review" : "Decision"} · {d.team}
        {d.issue && !onIssue && (
          <>
            {" · "}
            <a className="mono" href={`/issue/${d.issue}`}>{d.issue}</a>
          </>
        )}
      </p>
      <h2 className="dq" id={`dq-${d.id}`}>{d.title}</h2>
      {d.issueTitle && !onIssue && <p className="about">About: {d.issueTitle}</p>}
      <p className="asked">
        <Avatar name={d.askedBy} kind={d.askedByKind} />
        <span>
          <b>{d.askedBy ?? "Someone"}</b> asked this {since(d.createdAt)}
        </span>
      </p>
      <div className="full"><Md text={d.question} /></div>
      {d.status === "open" ? (
        <>
          <DecisionForm d={d} onDone={onDone} onLater={onLater} />
          <button className="link-btn withdraw" onClick={withdraw}>No longer needed? Withdraw this decision</button>
        </>
      ) : (
        <div className="answered">
          <h3>{d.status === "answered" ? "Answer" : "Withdrawn"}</h3>
          {d.answer ? <Md text={d.answer} /> : <p className="muted">No reason given.</p>}
          <p className="muted">
            {d.status === "answered" ? `${d.answeredBy ?? "Someone"} answered ${since(d.answeredAt)}` : "No longer needed"}
          </p>
        </div>
      )}
    </article>
  );
}

type Tab = "open" | "answered" | "withdrawn";
const TABS: [Tab, string][] = [["open", "Open"], ["answered", "Answered"], ["withdrawn", "Withdrawn"]];

export function Decisions({ team }: { team: string }) {
  const tab = (param("tab") as Tab | null) ?? "open";
  const { data, error } = useLoad(
    () => call<{ decisions: Decision[] }>("list_decisions", { status: tab, limit: 100, ...(team && { team }) }),
    [tab, team],
  );
  const list = data?.decisions ?? [];
  const wanted = param("d") ?? location.hash.slice(1);
  const at = Math.max(0, list.findIndex((d) => d.id === wanted));
  const d = list[at];
  const detail = useRef<HTMLDivElement>(null);
  const go = (id: string | undefined, push = true) => {
    const to = `/decisions?${new URLSearchParams({ ...(tab !== "open" && { tab }), ...(id && { d: id }) })}`;
    if (push) nav(to);
    else {
      history.replaceState(null, "", to);
      dispatchEvent(new PopStateEvent("popstate"));
    }
  };
  // On a phone the chosen decision sits under the list; bring it into view when picked.
  useEffect(() => {
    if (wanted && matchMedia("(max-width: 899px)").matches) detail.current?.scrollIntoView({ block: "start" });
  }, [wanted]);
  const next = list[at + 1]?.id ?? list[0]?.id;
  return (
    <div className="page">
      <PageHead
        kicker="Captain"
        title="Inbox"
        sub={
          data &&
          (tab === "open"
            ? list.length
              ? `${plural(list.length, "decision waits", "decisions wait")} on you, oldest first.`
              : "Nothing is waiting on you."
            : tab === "answered"
              ? "What you decided, newest first. Each answer is also a comment on the issue."
              : "Decisions that were no longer needed.")
        }
      />
      <Tabs label="Which decisions" value={tab} onChange={(t) => nav(t === "open" ? "/decisions" : `/decisions?tab=${t}`)} items={TABS} />
      <Err e={error} />
      {!data && !error && <Loading />}
      {data && !list.length && (
        <p className="empty">
          {tab === "open" ? "Nothing to decide. When an agent needs you, the question appears here." : "Nothing here yet."}
        </p>
      )}
      {!!list.length && (
        <div className="dec-split">
          <nav className="dec-list" aria-label="Decisions">
            <ol>
              {list.map((x) => (
                <li key={x.id}>
                  <a href={`/decisions?${new URLSearchParams({ ...(tab !== "open" && { tab }), d: x.id })}`} aria-current={x.id === d?.id ? "true" : undefined}>
                    <span className="dl-title">{x.title}</span>
                    <span className="dl-meta">
                      <span className="mono">{x.issue ?? x.teamKey}</span>
                      <Avatar name={x.askedBy} kind={x.askedByKind} />
                      <time className="mono" dateTime={x.createdAt}>{ago(tab === "open" ? x.createdAt : (x.answeredAt ?? x.createdAt))}</time>
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          </nav>
          <div className="dec-detail" ref={detail}>
            {d && (
              <DecisionDetail
                key={d.id}
                d={d}
                onDone={() => go(next !== d.id ? next : undefined, false)}
                onLater={list.length > 1 ? () => go(next) : undefined}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
