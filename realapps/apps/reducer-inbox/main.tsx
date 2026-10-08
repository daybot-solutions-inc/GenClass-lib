// Inbox with multi-select bulk actions (React 19; a useReducer-style hook over useGenClassState: a pure reducer
// and dispatch, effects as plain async functions). Bulk archive / label / mark-read go through POST
// /messages/bulk, which answers per id (some ids can fail). Latent bugs by flag: treating a partial failure as a
// full success (bulk=assume-all: failed messages vanish from the list, server still has them in the inbox), the
// unread counter not updated by bulk paths (unread=skip-on-bulk), a slow folder load overwriting the folder the
// user switched to (folderGuard=false), double bulk requests (disableBulk=false).
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useRef } from "react";
import { useGenClassState } from "@genclass/runtime/react";
import { flag } from "../_shared/genclass";

type Folder = "inbox" | "archive";
type Msg = { id: number; from: string; subject: string; folder: Folder; label: string; unread: boolean; seq: number };
type Op = "archive" | "restore" | "label" | "read";
const BULK = flag("bulk", "per-id") as "per-id" | "assume-all";
const UNREAD = flag("unread", "recount") as "recount" | "skip-on-bulk";
const FOLDER_GUARD = Boolean(flag("folderGuard", true));
const DISABLE_BULK = Boolean(flag("disableBulk", true));
const POLL_MS = Number(flag("pollMs", 10000));

interface Inbox {
  folder: Folder;
  messages: Msg[];
  selected: number[];
  unread: number;
  openId: number;
  loading: boolean;
  busy: boolean;
  notice: string;
  error: string;
}
const initial: Inbox = { folder: "inbox", messages: [], selected: [], unread: 0, openId: 0, loading: false, busy: false, notice: "", error: "" };

type Action =
  | { type: "folder"; folder: Folder }
  | { type: "loaded"; folder: Folder; messages: Msg[]; raced: boolean }
  | { type: "loadFailed" }
  | { type: "toggle"; id: number }
  | { type: "selectAll"; on: boolean }
  | { type: "bulkStart" }
  | { type: "bulkDone"; op: Op; ok: number[]; failed: number }
  | { type: "bulkFailed"; op: Op }
  | { type: "open"; id: number }
  | { type: "readFailed"; id: number };

const VERB: Record<Op, string> = { archive: "archived", restore: "moved to Inbox", label: "labelled", read: "marked read" };
const countUnread = (ms: Msg[]) => ms.filter((m) => m.unread).length;

function reducer(s: Inbox, a: Action): Inbox {
  switch (a.type) {
    case "folder":
      return { ...s, folder: a.folder, messages: [], selected: [], openId: 0, loading: true, notice: "", error: "" };
    case "loaded": {
      if (FOLDER_GUARD && a.folder !== s.folder) return s; // the user switched folders meanwhile
      if (a.raced) return { ...s, loading: false }; // a bulk action changed the list meanwhile
      const ids = new Set(a.messages.map((m) => m.id));
      return { ...s, messages: a.messages, selected: s.selected.filter((id) => ids.has(id)), unread: a.folder === "inbox" ? countUnread(a.messages) : s.unread, loading: false };
    }
    case "loadFailed":
      return { ...s, loading: false, error: "Could not load messages" };
    case "toggle":
      return { ...s, selected: s.selected.includes(a.id) ? s.selected.filter((x) => x !== a.id) : [...s.selected, a.id] };
    case "selectAll":
      return { ...s, selected: a.on ? s.messages.map((m) => m.id) : [] };
    case "bulkStart":
      return { ...s, busy: true, notice: "", error: "" };
    case "bulkDone": {
      const ok = new Set(a.ok);
      const hit = s.messages.filter((m) => ok.has(m.id));
      let messages = s.messages;
      let unread = s.unread;
      if (a.op === "archive" || a.op === "restore") {
        messages = s.messages.filter((m) => !ok.has(m.id));
        if (UNREAD === "recount") unread += (a.op === "archive" ? -1 : 1) * countUnread(hit);
      } else if (a.op === "label") messages = s.messages.map((m) => (ok.has(m.id) ? { ...m, label: "work" } : m));
      else {
        messages = s.messages.map((m) => (ok.has(m.id) ? { ...m, unread: false } : m));
        if (UNREAD === "recount" && s.folder === "inbox") unread -= countUnread(hit);
      }
      const n = a.ok.length;
      return {
        ...s,
        messages,
        unread,
        busy: false,
        selected: s.selected.filter((id) => !ok.has(id)),
        notice: n ? `${n} message${n > 1 ? "s" : ""} ${VERB[a.op]}` : "",
        error: a.failed ? `${a.failed} message${a.failed > 1 ? "s" : ""} could not be ${VERB[a.op]}` : "",
      };
    }
    case "bulkFailed":
      return { ...s, busy: false, error: `Messages could not be ${VERB[a.op]}` };
    case "open": {
      const m = s.messages.find((x) => x.id === a.id);
      if (!m) return s;
      return { ...s, openId: a.id, messages: m.unread ? s.messages.map((x) => (x.id === a.id ? { ...x, unread: false } : x)) : s.messages, unread: m.unread && s.folder === "inbox" ? s.unread - 1 : s.unread };
    }
    case "readFailed": {
      const m = s.messages.find((x) => x.id === a.id);
      if (!m || m.unread) return s;
      return { ...s, messages: s.messages.map((x) => (x.id === a.id ? { ...x, unread: true } : x)), unread: s.folder === "inbox" ? s.unread + 1 : s.unread, error: "Could not mark the message read" };
    }
  }
}

/** useReducer, backed by a GenClass atom so async dispatches go through its pipeline. */
function useInboxReducer() {
  const [state, setState] = useGenClassState<Inbox>("inbox", initial);
  const dispatch = useCallback((a: Action) => setState((s) => reducer(s, a)), [setState]);
  const ref = useRef(state);
  ref.current = state;
  return [state, dispatch, ref] as const;
}

// ---------------------------------------------------------------------------------------------- effects
type Dispatch = (a: Action) => void;
type Ref = { current: Inbox };
let bulkSeq = 0; // bulk actions started so far (a list load that overlaps one is out of date)

async function load(dispatch: Dispatch, ref: Ref, folder: Folder) {
  const seq = bulkSeq;
  try {
    const r = await fetch(`/api/messages?folder=${folder}&sort=-seq&limit=50`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = (await r.json()) as { results: Msg[] };
    dispatch({ type: "loaded", folder, messages: body.results ?? [], raced: seq !== bulkSeq || ref.current.busy });
  } catch {
    dispatch({ type: "loadFailed" });
  }
}

async function bulk(dispatch: Dispatch, ref: Ref, op: Op) {
  const s = ref.current;
  const ids = s.selected;
  if (!ids.length || (DISABLE_BULK && s.busy)) return;
  const patch = op === "archive" ? { folder: "archive" } : op === "restore" ? { folder: "inbox" } : op === "label" ? { label: "work" } : { unread: false };
  bulkSeq++;
  dispatch({ type: "bulkStart" });
  try {
    const r = await fetch("/api/messages/bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids, op: "patch", patch }) });
    if (r.status !== 200 && r.status !== 207) throw new Error(`HTTP ${r.status}`);
    const { results } = (await r.json()) as { results: { id: number; ok: boolean; status: number }[] };
    if (BULK === "per-id") {
      const ok = results.filter((x) => x.ok).map((x) => x.id);
      dispatch({ type: "bulkDone", op, ok, failed: results.length - ok.length });
    } else dispatch({ type: "bulkDone", op, ok: ids, failed: 0 });
  } catch {
    dispatch({ type: "bulkFailed", op });
  }
}

async function openMessage(dispatch: Dispatch, ref: Ref, id: number) {
  const m = ref.current.messages.find((x) => x.id === id);
  dispatch({ type: "open", id });
  if (!m?.unread) return;
  try {
    const r = await fetch(`/api/messages/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ unread: false }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch {
    dispatch({ type: "readFailed", id });
  }
}

// --------------------------------------------------------------------------------------------------- UI
function InboxApp() {
  const [s, dispatch, ref] = useInboxReducer();
  useEffect(() => {
    void load(dispatch, ref, "inbox");
    const h = setInterval(() => {
      if (!ref.current.busy) void load(dispatch, ref, ref.current.folder);
    }, POLL_MS);
    return () => clearInterval(h);
  }, [dispatch, ref]);
  const switchTo = (f: Folder) => {
    dispatch({ type: "folder", folder: f });
    void load(dispatch, ref, f);
  };
  const open = s.messages.find((m) => m.id === s.openId);
  const allOn = s.messages.length > 0 && s.selected.length === s.messages.length;
  const bulkDisabled = !s.selected.length || (DISABLE_BULK && s.busy);
  return (
    <main className="inbox">
      <nav className="folders">
        <button className={s.folder === "inbox" ? "on" : ""} onClick={() => switchTo("inbox")}>
          Inbox {s.unread > 0 && <b className="unread-count">{s.unread}</b>}
        </button>
        <button className={s.folder === "archive" ? "on" : ""} onClick={() => switchTo("archive")}>
          Archive
        </button>
      </nav>
      <div className="toolbar">
        <input type="checkbox" className="select-all" checked={allOn} onChange={() => dispatch({ type: "selectAll", on: !allOn })} aria-label="Select all" />
        {s.folder === "inbox" ? (
          <button className="archive" disabled={bulkDisabled} onClick={() => void bulk(dispatch, ref, "archive")}>
            Archive
          </button>
        ) : (
          <button className="archive" disabled={bulkDisabled} onClick={() => void bulk(dispatch, ref, "restore")}>
            Move to Inbox
          </button>
        )}
        <button className="label-work" disabled={bulkDisabled} onClick={() => void bulk(dispatch, ref, "label")}>
          Label: work
        </button>
        <button className="mark-read" disabled={bulkDisabled} onClick={() => void bulk(dispatch, ref, "read")}>
          Mark read
        </button>
        <span className="sel">{s.selected.length} selected</span>
        {s.busy && <span className="busy">Working…</span>}
        {s.loading && <span className="loading">Loading…</span>}
      </div>
      {s.error && <p role="alert">{s.error}</p>}
      {s.notice && <p className="notice">{s.notice}</p>}
      <ul>
        {s.messages.map((m) => (
          <li key={m.id} className={m.unread ? "msg unread" : "msg"}>
            <input type="checkbox" className="select" checked={s.selected.includes(m.id)} onChange={() => dispatch({ type: "toggle", id: m.id })} aria-label={`Select ${m.subject}`} />
            <span className="from">{m.from}</span>
            <button className="subject" onClick={() => void openMessage(dispatch, ref, m.id)}>
              {m.unread ? "● " : ""}
              {m.subject}
            </button>
            {m.label && <span className="label">{m.label}</span>}
          </li>
        ))}
      </ul>
      {!s.messages.length && !s.loading && <p className="empty">No messages.</p>}
      {open && (
        <article className="reader">
          <h2>{open.subject}</h2>
          <p>From {open.from}</p>
        </article>
      )}
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<InboxApp />);
