// Small pieces every view uses.
import { type CSSProperties, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { type IssueLite, toast, upload } from "./api";
import { plainMd, renderMd } from "./md";

export const PRIORITY = ["No priority", "Urgent", "High", "Medium", "Low"];

export const Md = ({ text }: { text: string }) => <div className="md" dangerouslySetInnerHTML={{ __html: renderMd(text) }} />;

export const Err = ({ e }: { e?: Error }) => (e ? <p className="err" role="alert">{e.message}</p> : null);

export const Loading = () => <p className="muted pad">Loading</p>;

const MONTH = { month: "short", day: "numeric" } as const;

/** A short age for a column: "now", "5 min", "3 h", "2 d", or a date. */
export function ago(iso?: string | null) {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d`;
  return new Date(iso).toLocaleDateString(undefined, { ...MONTH, year: s > 86400 * 300 ? "numeric" : undefined });
}

/** For use inside a sentence: "just now", "5 minutes ago", "yesterday" or "on 3 Oct". */
export function since(iso?: string | null) {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  const n = (v: number, one: string, many: string) => `${v} ${v === 1 ? one : many} ago`;
  if (s < 60) return "just now";
  if (s < 3600) return n(Math.floor(s / 60), "minute", "minutes");
  if (s < 86400) return n(Math.floor(s / 3600), "hour", "hours");
  if (s < 86400 * 2) return "yesterday";
  if (s < 86400 * 30) return n(Math.floor(s / 86400), "day", "days");
  return `on ${new Date(iso).toLocaleDateString(undefined, { ...MONTH, year: s > 86400 * 300 ? "numeric" : undefined })}`;
}

export const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

export function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function Prio({ value }: { value: number }) {
  if (value === 1) return <span className="prio urgent" role="img" aria-label="Urgent" title="Urgent">!</span>;
  return (
    <span className={`prio p${value}`} role="img" aria-label={PRIORITY[value]} title={PRIORITY[value]}>
      <i />
      <i />
      <i />
    </span>
  );
}

/** A status as a coloured dot and its own name; the colour follows the status type. */
export const Status = ({ type, name }: { type: string; name?: string }) => (
  <span className={`status st-${type}`}>
    <span className="sdot" aria-hidden="true" />
    {name ?? type}
  </span>
);
export const StateDot = ({ type, name }: { type: string; name?: string }) => <span className={`sdot st-${type}`} role="img" aria-label={name ?? type} title={name ?? type} />;

export const hue = (name: string) => [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

/** People are round with their initials; agents and system jobs are a rounded square with their first letter. */
export function Avatar({ name, kind, size }: { name: string | null; kind?: string | null; size?: "lg" }) {
  if (!name) return null;
  const bot = !!kind && kind !== "human";
  const letters = bot
    ? name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 1).toUpperCase()
    : name.split(/[\s._()@-]+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <span className={`av${bot ? " bot" : ""}${size ? ` ${size}` : ""}`} title={name} aria-hidden="true" style={{ "--h": hue(name) } as CSSProperties}>
      {letters}
    </span>
  );
}

/** A person with their role underneath: "Captain" for people, "Agent" for the crew. */
export const Who = ({ name, kind }: { name: string | null; kind?: string | null }) => (
  <span className="who">
    <Avatar name={name} kind={kind} />
    <span>
      <b>{name ?? "Someone"}</b>
      {kind && <small>{kind === "human" ? "Captain" : kind === "agent" ? "Agent" : "System"}</small>}
    </span>
  </span>
);

export const Label = ({ name }: { name: string }) => (
  <span className="lab" style={{ "--h": hue(name) } as CSSProperties}>
    {name}
  </span>
);

/** The brass tag for something that waits on the captain. */
export const Brass = ({ children }: { children: ReactNode }) => <span className="brass-tag">{children}</span>;

const PATHS = {
  home: "M2.5 7.25 8 2.75l5.5 4.5V13a.75.75 0 0 1-.75.75H9.5V10h-3v3.75H3.25A.75.75 0 0 1 2.5 13V7.25Z",
  decide: "M8 1.75 9.6 5l3.65.5-2.65 2.55.63 3.6L8 9.95 4.77 11.65l.63-3.6L2.75 5.5 6.4 5 8 1.75Z",
  look: "M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8Zm6.25 2a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  issues: "M6 4h7.5M6 8h7.5M6 12h7.5M2.75 4h.01M2.75 8h.01M2.75 12h.01",
  triage: "M2.25 3.25h11.5L9.5 8.5v4.25l-3 1.5V8.5L2.25 3.25Z",
  releases: "M3.5 14.25V2M3.5 2.75h8.75l-2 3.25 2 3.25H3.5",
  docs: "M4 1.75h5.25l3 3v9c0 .28-.22.5-.5.5H4a.5.5 0 0 1-.5-.5v-11.5c0-.28.22-.5.5-.5ZM9 1.75V5h3.25M6 8.25h4M6 10.75h4",
  log: "M1.75 8h2.5l1.75-4.5 3 9 1.75-4.5h3.5",
  crew: "M6 7.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Zm-4 6.5c0-2.2 1.8-4 4-4s4 1.8 4 4M10.5 7.25a2 2 0 1 0 0-4M11.25 9.9c1.65.4 2.75 1.9 2.75 3.85",
  settings: "M2.5 4.75h5.5M11.5 4.75h2M2.5 11.25h2M8 11.25h5.5M9.75 3v3.5M6.25 9.5V13",
  search: "M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Zm3.25 7.75L13.5 13.5",
  bell: "M4 11.25V7a4 4 0 1 1 8 0v4.25l1.25 1.25H2.75L4 11.25ZM6.5 14h3",
  plus: "M8 3v10M3 8h10",
  copy: "M5.75 5.75h7.5v7.5h-7.5zM3 10.25V3.5c0-.28.22-.5.5-.5h6.75",
  link: "M6.75 9.25a2.6 2.6 0 0 0 3.7 0l2.1-2.1a2.6 2.6 0 0 0-3.7-3.7l-.6.6M9.25 6.75a2.6 2.6 0 0 0-3.7 0l-2.1 2.1a2.6 2.6 0 0 0 3.7 3.7l.6-.6",
  branch: "M5 2v12M11 6.5a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5Zm0 0c0 3.25-6 2-6 5.5",
  check: "M3 8.5 6.5 12 13 4.5",
  chevron: "M6 3.5 10.5 8 6 12.5",
  down: "M3.5 6 8 10.5 12.5 6",
  menu: "M2.5 4.5h11M2.5 8h11M2.5 11.5h11",
  arrow: "M3 8h10M9 4l4 4-4 4",
} as const;
export type IconName = keyof typeof PATHS;
export const Icon = ({ name }: { name: IconName }) => (
  <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
    <path d={PATHS[name]} />
  </svg>
);

export const copy = (text: string, what = text) =>
  navigator.clipboard.writeText(text).then(
    () => toast(`${what[0]!.toUpperCase()}${what.slice(1)} copied`),
    () => toast("Could not copy; select the text instead"),
  );

/** One line of the activity log. On an issue's own page the identifier reads as "this issue". */
export type Activity = {
  syncId: number;
  at: string;
  actor: { id: string; name: string; kind: string } | null;
  entity: string;
  op: string;
  issue: { id: string; title: string } | null;
  summary: string;
  changes: { field: string; from?: unknown; to?: unknown }[];
  body?: string;
};

const show = (v: unknown) => (v == null || v === false ? "none" : Array.isArray(v) ? v.join(", ") || "none" : v === true ? "yes" : String(v));

export function Entry({ e, here }: { e: Activity; here?: string }) {
  const t = new Date(e.at);
  const parts = e.issue ? e.summary.split(e.issue.id) : [e.summary];
  return (
    <li className={here ? "entry here" : "entry"} data-entity={e.entity}>
      <Avatar name={e.actor?.name ?? "?"} kind={e.actor?.kind} />
      <div className="entry-body">
        <p className="what">
          <b className="by">{e.actor?.name ?? "Someone"}</b>{" "}
          {parts.map((p, n) => (
            <span key={n}>
              {n > 0 && e.issue && (here === e.issue.id ? "this issue" : <a className="mono" href={`/issue/${e.issue.id}`}>{e.issue.id}</a>)}
              {p}
            </span>
          ))}
        </p>
        {e.issue && here !== e.issue.id && <p className="about">{e.issue.title}</p>}
        {e.entity === "issue" && e.changes.length > 1 && (
          <ul className="diff">
            {e.changes.map((c) => (
              <li key={c.field}>
                <span>{c.field}</span> {"from" in c && c.from !== undefined ? <><s>{show(c.from)}</s> → {show(c.to)}</> : "edited"}
              </li>
            ))}
          </ul>
        )}
        {e.body && <Quote text={plainMd(e.body)} />}
      </div>
      <time className="mono" dateTime={e.at} title={t.toLocaleString(undefined)}>
        {here ? ago(e.at) : t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
      </time>
    </li>
  );
}

/** A comment in the log. A long one folds behind its first words instead of being cut off. */
function Quote({ text }: { text: string }) {
  if (text.length <= 320) return <blockquote>{text}</blockquote>;
  const words = text.split(/\s+/);
  return (
    <details className="quote">
      <summary>
        <span className="closed-only">{words.slice(0, 30).join(" ")} <span className="more-words">and {words.length - 30} more words</span></span>
        <span className="open-only more-words">Show less</span>
      </summary>
      <blockquote>{text}</blockquote>
    </details>
  );
}

const dayName = (d: Date) => {
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
};

/** Entries grouped under a heading per day, newest day first. */
export function Log({ events, here }: { events: Activity[]; here?: string }) {
  const days: [string, Activity[]][] = [];
  for (const e of events) {
    const d = dayName(new Date(e.at));
    if (days.at(-1)?.[0] !== d) days.push([d, []]);
    days.at(-1)![1].push(e);
  }
  return (
    <div className="log">
      {days.map(([d, es]) => (
        <section key={d}>
          <h3 className="day">{d}</h3>
          <ol>{es.map((e) => <Entry key={e.syncId} e={e} here={here} />)}</ol>
        </section>
      ))}
    </div>
  );
}

/** One issue on a line (or a few on a phone): priority, ID, status, title, labels, an open decision, release, maker and age. */
export function IssueRow({ i }: { i: IssueLite }) {
  return (
    <a className="irow" data-row href={`/issue/${i.id}`}>
      <Prio value={i.priority?.value ?? 0} />
      <span className="ident mono">{i.id}</span>
      <Status type={i.statusType} name={i.status} />
      <span className="ititle">{i.title}</span>
      <span className="imeta">
        {!!i.openDecisions && <Brass>Decision</Brass>}
        {i.labels?.map((l) => <Label key={l} name={l} />)}
        {i.release && <span className="rel mono">v{i.release.replace(/^v/i, "")}</span>}
        {i.createdBy && <Avatar name={i.createdBy} kind={i.createdByKind} />}
        {i.updatedAt && <time className="when mono" dateTime={i.updatedAt}>{ago(i.updatedAt)}</time>}
      </span>
    </a>
  );
}

/** An input that saves on blur or Enter; `wrap` makes it a growing textarea for long text such as titles. */
export function Inline({ value, onSave, wrap, ...rest }: { value: string; onSave: (v: string) => void; wrap?: boolean } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancel = useRef(false);
  const props = {
    value: draft ?? value,
    onFocus: () => setDraft(value),
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: () => {
      const v = draft?.replace(/\s+/g, " ").trim();
      if (!cancel.current && v != null && v !== value) onSave(v);
      cancel.current = false;
      setDraft(null);
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.currentTarget.blur();
      }
      if (e.key === "Escape") {
        cancel.current = true;
        e.currentTarget.blur();
      }
    },
  };
  return wrap ? <textarea rows={1} className={rest.className} aria-label={rest["aria-label"]} {...props} /> : <input {...rest} {...props} />;
}

/** A markdown textarea; pasted, dropped or picked files are uploaded and linked at the cursor. */
export function MdEditor(p: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  onCancel?: () => void;
  issue?: string;
  placeholder?: string;
  label?: string;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(0);
  async function add(files?: FileList | null) {
    for (const f of Array.from(files ?? [])) {
      setBusy((n) => n + 1);
      try {
        const { markdown } = await upload(f, p.issue);
        const el = ref.current!;
        const at = el.selectionEnd;
        p.onChange(`${el.value.slice(0, at)}${markdown}\n${el.value.slice(at)}`);
      } catch (e) {
        toast(`${f.name}: ${(e as Error).message}`);
      } finally {
        setBusy((n) => n - 1);
      }
    }
  }
  return (
    <div className="editor">
      <textarea
        ref={ref}
        value={p.value}
        autoFocus={p.autoFocus}
        placeholder={p.placeholder}
        aria-label={p.label ?? "Markdown text"}
        onChange={(e) => p.onChange(e.target.value)}
        onPaste={(e) => {
          if (!e.clipboardData.files.length) return;
          e.preventDefault();
          void add(e.clipboardData.files);
        }}
        onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          void add(e.dataTransfer.files);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) p.onSubmit?.();
          if (e.key === "Escape" && p.onCancel) {
            e.preventDefault();
            p.onCancel();
          }
        }}
      />
      <div className="editor-foot">
        <label className="attach">
          {busy ? "Uploading" : "Add file"}
          <input type="file" multiple className="visually-hidden" onChange={(e) => void add(e.target.files).then(() => (e.target.value = ""))} />
        </label>
        <span className="muted">Markdown; paste or drop files{p.onSubmit ? <>, <kbd>Ctrl</kbd><kbd>↵</kbd> sends</> : ""}</span>
      </div>
    </div>
  );
}

/** A row of tabs that are plain buttons with aria-pressed: they filter what is below, they don't move focus. */
export function Tabs<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: [T, string][]; label: string }) {
  return (
    <div className="tabs" role="group" aria-label={label}>
      {items.map(([v, name]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
          {name}
        </button>
      ))}
    </div>
  );
}

/** The page heading: an optional kicker, the title in Archivo and a line underneath. */
export const PageHead = ({ kicker, title, sub, children }: { kicker?: ReactNode; title: ReactNode; sub?: ReactNode; children?: ReactNode }) => (
  <header className="phead">
    <div>
      {kicker && <p className="kicker">{kicker}</p>}
      <h1>{title}</h1>
      {sub && <p className="sub">{sub}</p>}
    </div>
    {children && <div className="phead-tools">{children}</div>}
  </header>
);
