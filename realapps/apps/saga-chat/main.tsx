// Support inbox for agents (React 19 + Redux with redux-saga + react-redux; the store goes through GenClass via
// genclassEnhancer). Sagas load the open conversations (polled), load a thread when the agent selects one, send
// replies optimistically, and keep a WebSocket open through an eventChannel with a reconnect loop. Unread counts
// per conversation and the inbox total are maintained by the reducer. Latent bugs by flag: thread loads run with
// takeEvery so a slow load for a previous conversation replaces the current thread (selectTake=every), own echoes
// deduplicated by id only so an echo that beats the POST response doubles the message (dedupe=id), the draft cleared
// only after the server answered so a double click sends it twice (clearDraft=on-success), no resync after a
// reconnect so messages pushed while offline are missing (reconnect=none), the unread total adjusted by deltas and
// not when conversations leave the open list (unread=incremental).
import { createRoot } from "react-dom/client";
import { legacy_createStore as createStore, applyMiddleware, compose, type StoreEnhancer } from "redux";
import { Provider, useDispatch, useSelector } from "react-redux";
import createSagaMiddleware, { eventChannel, type EventChannel } from "redux-saga";
import { all, call, cancelled, delay, fork, put, select, take, takeEvery, takeLatest } from "redux-saga/effects";
import { genclassEnhancer } from "@genclass/runtime/redux";
import { rt, flag } from "../_shared/genclass";

type Conv = { id: number; customer: string; subject: string; status: string; channel: string; unread: number };
type Msg = { id?: number; conversationId: number; from: "customer" | "agent"; author: string; text: string; clientId?: string; pending?: boolean };
interface S {
  conversations: Conv[];
  activeId: number;
  messages: Msg[];
  unreadTotal: number;
  draft: string;
  sending: number;
  loadingThread: boolean;
  connected: boolean;
  error: string;
}
type A =
  | { type: "convs/loaded"; list: Conv[] }
  | { type: "convs/select"; id: number }
  | { type: "convs/resolve"; id: number }
  | { type: "convs/resolved"; id: number }
  | { type: "thread/loading" }
  | { type: "thread/loaded"; id: number; items: Msg[] }
  | { type: "draft/changed"; text: string }
  | { type: "msg/send"; msg: Msg }
  | { type: "msg/sent"; clientId: string; msg: Msg }
  | { type: "msg/failed"; clientId: string }
  | { type: "msg/pushed"; msg: Msg }
  | { type: "socket/status"; connected: boolean }
  | { type: "error"; text: string };

const SELECT_TAKE = flag("selectTake", "latest") as "latest" | "every";
const DEDUPE = flag("dedupe", "clientId") as "clientId" | "id";
const CLEAR_DRAFT = flag("clearDraft", "on-send") as "on-send" | "on-success";
const RECONNECT = flag("reconnect", "resync") as "resync" | "none";
const UNREAD = flag("unread", "recount") as "recount" | "incremental";
const ME = "rita";

// --------------------------------------------------------------------------------------------- reducer
const init: S = { conversations: [], activeId: 0, messages: [], unreadTotal: 0, draft: "", sending: 0, loadingThread: false, connected: false, error: "" };
const recount = (s: S): S => (UNREAD === "recount" ? { ...s, unreadTotal: s.conversations.reduce((a, c) => a + c.unread, 0) } : s);

function seen(list: Msg[], m: Msg): boolean {
  return list.some((x) => (m.id !== undefined && x.id === m.id) || (DEDUPE === "clientId" && !!m.clientId && x.clientId === m.clientId));
}

function reducer(s: S = init, a: A): S {
  switch (a.type) {
    case "convs/loaded": {
      const conversations = a.list.map((c) => ({ ...c, unread: s.conversations.find((p) => p.id === c.id)?.unread ?? 0 }));
      return recount({ ...s, conversations, error: s.error.startsWith("Inbox") ? "" : s.error });
    }
    case "convs/select": {
      const c = s.conversations.find((x) => x.id === a.id);
      const conversations = s.conversations.map((x) => (x.id === a.id ? { ...x, unread: 0 } : x));
      const same = a.id === s.activeId;
      const next = { ...s, activeId: a.id, conversations, draft: same ? s.draft : "", messages: same ? s.messages : [] };
      return UNREAD === "recount" ? recount(next) : { ...next, unreadTotal: s.unreadTotal - (c?.unread ?? 0) };
    }
    case "convs/resolved":
      return recount({ ...s, conversations: s.conversations.filter((c) => c.id !== a.id) });
    case "thread/loading":
      return { ...s, loadingThread: true };
    case "thread/loaded":
      return { ...s, loadingThread: false, messages: [...a.items, ...s.messages.filter((m) => m.pending && m.conversationId === a.id && !seen(a.items, m))] };
    case "draft/changed":
      return { ...s, draft: a.text };
    case "msg/send":
      return { ...s, messages: [...s.messages, { ...a.msg, pending: true }], sending: s.sending + 1, draft: CLEAR_DRAFT === "on-send" ? "" : s.draft, error: "" };
    case "msg/sent": {
      const has = s.messages.some((m) => m.clientId === a.clientId && m.pending);
      const messages = a.msg.conversationId !== s.activeId ? s.messages : has ? s.messages.map((m) => (m.clientId === a.clientId && m.pending ? a.msg : m)) : seen(s.messages, a.msg) ? s.messages : [...s.messages, a.msg];
      return { ...s, messages, sending: s.sending - 1, draft: CLEAR_DRAFT === "on-success" && s.draft.trim() === a.msg.text ? "" : s.draft };
    }
    case "msg/failed":
      return { ...s, messages: s.messages.filter((m) => m.clientId !== a.clientId), sending: s.sending - 1, error: "Reply not sent, please try again" };
    case "msg/pushed": {
      const m = a.msg;
      if (m.conversationId === s.activeId) {
        if (seen(s.messages, m)) return s;
        // our own echo may arrive before the POST answers: it replaces the pending copy
        const i = DEDUPE === "clientId" && m.clientId ? s.messages.findIndex((x) => x.pending && x.clientId === m.clientId) : -1;
        if (i >= 0) return { ...s, messages: s.messages.map((x, j) => (j === i ? m : x)) };
        return { ...s, messages: [...s.messages, m] };
      }
      if (m.from !== "customer") return s;
      const conversations = s.conversations.map((c) => (c.id === m.conversationId ? { ...c, unread: c.unread + 1 } : c));
      return UNREAD === "recount" ? recount({ ...s, conversations }) : { ...s, conversations, unreadTotal: s.unreadTotal + 1 };
    }
    case "socket/status":
      return { ...s, connected: a.connected };
    case "error":
      return { ...s, error: a.text, loadingThread: false };
    default:
      return s;
  }
}

// ----------------------------------------------------------------------------------------------- sagas
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

function* loadConversations() {
  try {
    const list: Conv[] = yield call(api<Conv[]>, "/api/conversations?status=open&limit=50");
    yield put({ type: "convs/loaded", list });
    const active: number = yield select((s: S) => s.activeId);
    if (!active && list.length) yield put({ type: "convs/select", id: list[0]!.id });
  } catch {
    yield put({ type: "error", text: "Inbox could not be refreshed" });
  }
}

function* pollConversations() {
  for (;;) {
    yield delay(15000);
    yield call(loadConversations);
  }
}

function* loadThread(a: { type: "convs/select"; id: number }) {
  const ctl = new AbortController();
  yield put({ type: "thread/loading" });
  try {
    const r: { items: Msg[] } = yield call(api<{ items: Msg[] }>, `/api/messages?conversationId=${a.id}&limit=100`, { signal: ctl.signal });
    yield put({ type: "thread/loaded", id: a.id, items: r.items });
  } catch {
    yield put({ type: "error", text: "Conversation could not be loaded" });
  } finally {
    if ((yield cancelled()) as boolean) ctl.abort();
  }
}

function* sendMessage(a: { type: "msg/send"; msg: Msg }) {
  try {
    const saved: Msg = yield call(api<Msg>, "/api/messages", { method: "POST", body: JSON.stringify(a.msg) });
    yield put({ type: "msg/sent", clientId: a.msg.clientId!, msg: saved });
  } catch {
    yield put({ type: "msg/failed", clientId: a.msg.clientId! });
  }
}

function* resolveConversation(a: { type: "convs/resolve"; id: number }) {
  try {
    yield call(api, `/api/conversations/${a.id}`, { method: "PATCH", body: JSON.stringify({ status: "resolved" }) });
    yield put({ type: "convs/resolved", id: a.id });
    const next: Conv | undefined = yield select((s: S) => s.conversations[0]);
    if (next) yield put({ type: "convs/select", id: next.id });
  } catch {
    yield put({ type: "error", text: "Could not resolve the conversation" });
  }
}

type SocketEvent = { kind: "open" } | { kind: "closed" } | { kind: "message"; msg: Msg };
function socketChannel(ws: WebSocket): EventChannel<SocketEvent> {
  return eventChannel<SocketEvent>((emit) => {
    ws.onopen = () => emit({ kind: "open" });
    ws.onclose = () => emit({ kind: "closed" });
    ws.onmessage = (e) => {
      const ev = JSON.parse(String(e.data)) as { type: string; item?: Msg };
      if (ev.type === "created" && ev.item) emit({ kind: "message", msg: ev.item });
    };
    return () => ws.close();
  });
}

function* socketSaga() {
  let failures = 0;
  let opened = false;
  for (;;) {
    const chan: EventChannel<SocketEvent> = yield call(socketChannel, new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/messages`));
    try {
      for (;;) {
        const ev: SocketEvent = yield take(chan);
        if (ev.kind === "closed") break;
        if (ev.kind === "open") {
          yield put({ type: "socket/status", connected: true });
          if (opened && RECONNECT === "resync") {
            yield fork(loadConversations);
            const active: number = yield select((s: S) => s.activeId);
            if (active) yield fork(loadThread, { type: "convs/select", id: active });
          }
          opened = true;
          failures = 0;
        } else yield put({ type: "msg/pushed", msg: ev.msg });
      }
    } finally {
      chan.close();
    }
    yield put({ type: "socket/status", connected: false });
    failures++;
    yield delay(Math.min(8000, 500 * 2 ** failures));
  }
}

function* rootSaga() {
  yield all([
    fork(loadConversations),
    fork(pollConversations),
    SELECT_TAKE === "latest" ? takeLatest("convs/select", loadThread) : takeEvery("convs/select", loadThread),
    takeEvery("msg/send", sendMessage),
    takeEvery("convs/resolve", resolveConversation),
    fork(socketSaga),
  ]);
}

const sagas = createSagaMiddleware();
const store = createStore(reducer, compose(applyMiddleware(sagas), genclassEnhancer(rt, { name: "support" })) as StoreEnhancer);
sagas.run(rootSaga);

// --------------------------------------------------------------------------------------------------- UI
let nClient = 0;

function Inbox() {
  const s = useSelector((x: S) => x);
  const dispatch = useDispatch();
  const active = s.conversations.find((c) => c.id === s.activeId);
  const send = () => {
    const text = s.draft.trim();
    if (!text || !s.activeId) return;
    const clientId = `m${++nClient}-${Math.floor(Math.random() * 1e6)}`;
    dispatch({ type: "msg/send", msg: { conversationId: s.activeId, from: "agent", author: ME, text, clientId } });
  };
  return (
    <main className="inbox">
      <aside className="convs">
        <h2>
          Inbox ({s.unreadTotal} unread) <small>{s.connected ? "live" : "reconnecting…"}</small>
        </h2>
        <ul>
          {s.conversations.map((c) => (
            <li key={c.id} className={c.id === s.activeId ? "conv active" : "conv"}>
              <button className="select" onClick={() => dispatch({ type: "convs/select", id: c.id })}>
                {c.customer} · {c.subject} {c.unread > 0 && <b>({c.unread})</b>}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="thread">
        {s.error && <p role="alert">{s.error}</p>}
        {active && (
          <header>
            <h2>
              {active.customer} · {active.subject}
            </h2>
            <button className="resolve" onClick={() => dispatch({ type: "convs/resolve", id: active.id })}>
              Resolve
            </button>
          </header>
        )}
        {s.loadingThread && <p className="loading">Loading conversation…</p>}
        <ul className="messages">
          {s.messages.map((m, i) => (
            <li key={m.id ?? m.clientId ?? i} className={`msg ${m.from}${m.pending ? " pending" : ""}`}>
              {m.author}: {m.text} {m.pending && <em>sending…</em>}
            </li>
          ))}
        </ul>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input name="reply" value={s.draft} onChange={(e) => dispatch({ type: "draft/changed", text: e.target.value })} placeholder="Write a reply" />
          <button className="send" type="submit">
            Send
          </button>
        </form>
      </section>
    </main>
  );
}

createRoot(document.getElementById("app")!).render(
  <Provider store={store}>
    <Inbox />
  </Provider>,
);
