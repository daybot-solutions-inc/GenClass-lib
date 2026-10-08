// Caption QA labelling tool (React 19 + Jotai atoms in an explicit store; fetch). Annotators sign in (short-lived
// access token, rotating refresh token), claim machine-generated image captions from the unassigned queue (versioned
// PATCH assignee=you), judge them Accurate / Partly / Wrong (PATCH label + status=done, then the team's shared
// "labelled" counter is bumped) or skip them (release back to the queue). The queue pages forward by cursor (keyset on
// id: `id__gt=<last id seen>`) with "Load more"; a 4 s poll refreshes the queue, your claimed tasks and the counter in
// parallel, and other annotators claim tasks all the time. The session and board atoms are registered with rt.guard
// (async results are written through it, UI flags write the Jotai store directly). Latent bugs by flag: every 401
// starts its own refresh (refresh=concurrent: the poll's two parallel 401s spend the rotating refresh token twice, the
// second refresh is rejected and the annotator is kicked out), claims sent without the version (claim=force: a task
// another annotator just claimed is taken over), pages fetched by offset (queue=offset: claims shrink the list so
// "Load more" skips tasks, releases grow it so a task shows twice), label buttons live while the save posts
// (labelGuard=none: a double click sends a second, stale PATCH) and a labelled counter kept locally
// (counter=local: other annotators' work never shows, failed saves are counted anyway).
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { atom, createStore, Provider, useAtomValue } from "jotai";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Task = { id: number; caption: string; image: string; assignee: string; label: string; status: "open" | "claimed" | "done"; version: number };
type ListRes = { items: Task[]; total: number };
interface Session {
  status: "signed-out" | "signed-in";
  user: string;
  busy: boolean;
  error: string;
}
interface Board {
  queue: Task[];
  mine: Task[];
  cursor: number;
  pages: number;
  hasMore: boolean;
  labeled: number;
  doneByMe: number;
  pending: number[];
  loading: boolean;
  loadingMore: boolean;
  error: string;
  notice: string;
}

const REFRESH = flag("refresh", "single-flight");
const CLAIM = flag("claim", "if-match");
const QUEUE = flag("queue", "cursor");
const LABEL_GUARD = flag("labelGuard", "pending") === "pending";
const COUNTER = flag("counter", "server");
const PAGE = 5;
const LABELS = ["Accurate", "Partly", "Wrong"];
const UNASSIGNED = "/api/tasks?status=open&assignee__empty=true&sort=id";

const store = createStore();
const emptyBoard: Board = { queue: [], mine: [], cursor: 0, pages: 1, hasMore: false, labeled: 0, doneByMe: 0, pending: [], loading: true, loadingMore: false, error: "", notice: "" };
const sessionAtom = atom<Session>({ status: "signed-out", user: "", busy: false, error: "" });
const boardAtom = atom<Board>(emptyBoard);
const session = rt.guard<Session>("session", { get: () => store.get(sessionAtom), set: (v) => store.set(sessionAtom, v), subscribe: (fn) => store.sub(sessionAtom, fn) });
const board = rt.guard<Board>("board", { get: () => store.get(boardAtom), set: (v) => store.set(boardAtom, v), subscribe: (fn) => store.sub(boardAtom, fn) });
const short = (s: string) => (s.length > 32 ? `${s.slice(0, 30)}…` : s);

// ------------------------------------------------------------------------------------------------ session
// credentials live in memory only; `remembered` is what the browser's password manager fills in again
let access = "";
let renewal = "";
let epoch = 0;
let remembered = { username: "", password: "" };
/** Tasks labelled or released this session: a lagging poll must not bring them back into "Your tasks". */
const finished = new Set<number>();

function kickOut(reason: string) {
  epoch++;
  access = renewal = "";
  session.set({ status: "signed-out", user: "", busy: false, error: reason });
  board.set(emptyBoard);
}

async function renew(): Promise<void> {
  const r = await api<{ token: string; refreshToken: string }>("/api/auth/refresh", "POST", { refreshToken: renewal });
  access = r.token;
  renewal = r.refreshToken;
}
let renewing: Promise<void> | null = null;
const refreshAccess = (): Promise<void> => (REFRESH === "concurrent" ? renew() : (renewing ??= renew().finally(() => (renewing = null))));

/** Authenticated request: a 401 renews the access token once and retries. */
async function call<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const my = epoch;
  const sent = access;
  try {
    return await api<T>(url, method, body, { authorization: `Bearer ${sent}` });
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 401 || my !== epoch) throw e;
    // single-flight: a request that went out with an already replaced token just retries with the new one
    if (REFRESH === "concurrent" || access === sent) {
      try {
        await refreshAccess();
      } catch (re) {
        if (re instanceof HttpError && re.status === 401 && my === epoch) kickOut("Your session expired — please sign in again.");
        throw re;
      }
    }
    if (my !== epoch) throw e;
    return api<T>(url, method, body, { authorization: `Bearer ${access}` });
  }
}

async function signIn(username: string, password: string) {
  if (store.get(sessionAtom).busy || !username.trim()) return;
  store.set(sessionAtom, (s) => ({ ...s, busy: true, error: "" }));
  try {
    const r = await api<{ token: string; refreshToken: string; user: { username: string } }>("/api/auth/login", "POST", { username: username.trim(), password });
    epoch++;
    access = r.token;
    renewal = r.refreshToken;
    remembered = { username: username.trim(), password };
    session.set({ status: "signed-in", user: r.user.username, busy: false, error: "" });
    board.set(emptyBoard);
    void refreshQueue();
    void loadMine();
    void loadCounter();
  } catch (e) {
    session.update((s) => ({ ...s, busy: false, error: e instanceof HttpError && e.status === 422 ? "Enter your username and password." : errText(e, "signing in") }));
  }
}

// -------------------------------------------------------------------------------------------------- queue
/** Reload the first pages (as many tasks as are shown); tasks past that range stay as they are. */
async function refreshQueue() {
  const my = epoch;
  const n = Math.max(PAGE, board.get().queue.length);
  try {
    const r = await call<ListRes>(`${UNASSIGNED}&limit=${n}`);
    const fresh = itemsOf<Task>(r);
    if (my !== epoch) return;
    board.update((b) => {
      const ids = new Set(fresh.map((t) => t.id));
      const last = fresh.length ? fresh[fresh.length - 1]!.id : 0;
      const more = r.total > fresh.length;
      const tail = more ? b.queue.filter((t) => t.id > last && !ids.has(t.id)) : [];
      const queue = [...fresh, ...tail].filter((t) => !b.mine.some((m) => m.id === t.id));
      return { ...b, queue, cursor: queue.length ? queue[queue.length - 1]!.id : 0, hasMore: more, loading: false };
    });
  } catch (e) {
    if (my === epoch && board.get().loading) board.update((b) => ({ ...b, loading: false, error: errText(e, "loading the queue") }));
  }
}

async function loadMore() {
  const b = board.get();
  if (b.loadingMore || b.loading || !b.hasMore) return;
  const my = epoch;
  store.set(boardAtom, (x) => ({ ...x, loadingMore: true, error: "" }));
  const url = QUEUE === "offset" ? `${UNASSIGNED}&offset=${b.pages * PAGE}&limit=${PAGE}` : `${UNASSIGNED}&id__gt=${b.cursor}&limit=${PAGE}`;
  try {
    const r = await call<ListRes>(url);
    const page = itemsOf<Task>(r);
    if (my !== epoch) return;
    board.update((x) => {
      const add = QUEUE === "offset" ? page : page.filter((t) => !x.queue.some((q) => q.id === t.id));
      const queue = [...x.queue, ...add];
      const more = QUEUE === "offset" ? (x.pages + 1) * PAGE < r.total : r.total > page.length;
      return { ...x, queue, pages: x.pages + 1, cursor: queue.length ? queue[queue.length - 1]!.id : x.cursor, hasMore: more, loadingMore: false };
    });
  } catch (e) {
    if (my === epoch) board.update((x) => ({ ...x, loadingMore: false, error: errText(e, "loading more tasks") }));
  }
}

async function loadMine() {
  const my = epoch;
  try {
    const mine = itemsOf<Task>(await call<ListRes>(`/api/tasks?assignee=${encodeURIComponent(session.get().user)}&status=claimed&limit=20`));
    if (my !== epoch) return;
    board.update((b) => ({ ...b, mine: mine.filter((t) => !finished.has(t.id)).map((t) => (b.pending.includes(t.id) ? (b.mine.find((m) => m.id === t.id) ?? t) : t)) }));
  } catch {
    /* the next poll tries again */
  }
}

async function loadCounter() {
  const my = epoch;
  try {
    const c = await api<{ value: number }>("/api/counters/labeled");
    if (my === epoch) board.update((b) => ({ ...b, labeled: COUNTER === "local" && b.labeled ? b.labeled : Math.max(b.labeled, c.value) }));
  } catch {
    /* keep the last value */
  }
}

// ------------------------------------------------------------------------------------------------ actions
const pend = (id: number, on: boolean) => board.update((b) => ({ ...b, pending: on ? [...b.pending, id] : b.pending.filter((x) => x !== id) }));

async function claim(t: Task) {
  if (board.get().pending.includes(t.id)) return;
  const my = epoch;
  const me = session.get().user;
  store.set(boardAtom, (b) => ({ ...b, pending: [...b.pending, t.id], error: "", notice: "" }));
  try {
    const saved = await call<Task>(`/api/tasks/${t.id}`, "PATCH", CLAIM === "force" ? { assignee: me, status: "claimed" } : { assignee: me, status: "claimed", version: t.version });
    if (my !== epoch) return;
    board.update((b) => ({ ...b, queue: b.queue.filter((q) => q.id !== t.id), mine: [...b.mine.filter((m) => m.id !== saved.id), saved], notice: `Claimed “${short(t.caption)}”.` }));
  } catch (e) {
    if (my !== epoch) return;
    const cur = e instanceof HttpError && e.status === 409 ? (e.body?.current as Task | undefined) : undefined;
    board.update((b) => ({
      ...b,
      queue: cur ? (cur.assignee ? b.queue.filter((q) => q.id !== t.id) : b.queue.map((q) => (q.id === t.id ? cur : q))) : b.queue,
      error: cur?.assignee ? `${cur.assignee} already claimed “${short(t.caption)}”.` : errText(e, "claiming the task"),
    }));
  } finally {
    if (my === epoch) pend(t.id, false);
  }
}

async function label(t: Task, value: string) {
  if (LABEL_GUARD && board.get().pending.includes(t.id)) return;
  const my = epoch;
  store.set(boardAtom, (b) => ({ ...b, pending: [...b.pending, t.id], labeled: COUNTER === "local" ? b.labeled + 1 : b.labeled, error: "", notice: "" }));
  try {
    await call<Task>(`/api/tasks/${t.id}`, "PATCH", { label: value.toLowerCase(), status: "done", version: t.version });
    if (my !== epoch) return;
    finished.add(t.id);
    board.update((b) => ({ ...b, mine: b.mine.filter((m) => m.id !== t.id), doneByMe: b.doneByMe + 1, notice: `Marked “${short(t.caption)}” as ${value}.` }));
    if (COUNTER === "server") {
      const c = await api<{ value: number }>("/api/counters/labeled/incr", "POST", { by: 1 });
      if (my === epoch) board.update((b) => ({ ...b, labeled: Math.max(b.labeled, c.value) }));
    }
  } catch (e) {
    if (my !== epoch) return;
    const changed = e instanceof HttpError && e.status === 409;
    board.update((b) => ({ ...b, error: changed ? `“${short(t.caption)}” was changed elsewhere — reload your tasks.` : errText(e, "saving the label") }));
    if (changed) void loadMine();
  } finally {
    if (my === epoch) pend(t.id, false);
  }
}

async function release(t: Task) {
  if (board.get().pending.includes(t.id)) return;
  const my = epoch;
  store.set(boardAtom, (b) => ({ ...b, pending: [...b.pending, t.id], error: "", notice: "" }));
  try {
    await call<Task>(`/api/tasks/${t.id}`, "PATCH", { assignee: "", status: "open", version: t.version });
    if (my !== epoch) return;
    finished.add(t.id);
    board.update((b) => ({ ...b, mine: b.mine.filter((m) => m.id !== t.id), notice: `Released “${short(t.caption)}” back to the queue.` }));
  } catch (e) {
    if (my === epoch) board.update((b) => ({ ...b, error: errText(e, "releasing the task") }));
  } finally {
    if (my === epoch) pend(t.id, false);
  }
}

// ----------------------------------------------------------------------------------------------------- UI
function SignIn() {
  const s = useAtomValue(sessionAtom);
  const [username, setUsername] = useState(remembered.username);
  const [password, setPassword] = useState(remembered.password);
  return (
    <form className="sign-in" onSubmit={(e) => (e.preventDefault(), void signIn(username, password))}>
      <h1>Caption QA · sign in</h1>
      {s.error && <p role="alert">{s.error}</p>}
      <input name="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" autoComplete="username" />
      <input name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoComplete="current-password" />
      <button className="sign-in" type="submit" disabled={s.busy}>
        {s.busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

function Workbench() {
  const s = useAtomValue(sessionAtom);
  const b = useAtomValue(boardAtom);
  useEffect(() => {
    const h = setInterval(() => void Promise.all([refreshQueue(), loadMine(), COUNTER === "server" ? loadCounter() : null]), 4000);
    return () => clearInterval(h);
  }, []);
  return (
    <main className="labeling">
      <header>
        <h1>Caption QA</h1>
        <span className="who">Signed in as {s.user}</span>
        <span className="stats">
          {b.labeled} captions labelled by the team · {b.doneByMe} by you this session
        </span>
        <button type="button" className="sign-out" onClick={() => kickOut("")}>
          Sign out
        </button>
      </header>
      {b.error ? <p role="alert">{b.error}</p> : b.notice ? <p className="notice">{b.notice}</p> : null}
      <section className="yours">
        <h2>Your tasks ({b.mine.length})</h2>
        <ul>
          {b.mine.map((t) => (
            <li key={t.id} className="mine" data-id={t.id}>
              <span className="caption">“{t.caption}”</span> <span className="image">{t.image}</span>
              <span className="labels">
                {LABELS.map((l) => (
                  <button key={l} type="button" disabled={LABEL_GUARD && b.pending.includes(t.id)} onClick={() => void label(t, l)}>
                    {l}
                  </button>
                ))}
              </span>
              <button type="button" className="skip" disabled={b.pending.includes(t.id)} onClick={() => void release(t)}>
                Skip
              </button>
            </li>
          ))}
        </ul>
        {!b.mine.length && <p className="muted">Claim a task from the queue to start labelling.</p>}
      </section>
      <section className="queue">
        <h2>Unassigned</h2>
        {b.loading ? (
          <p className="muted">Loading…</p>
        ) : (
          <ul>
            {b.queue.map((t) => (
              <li key={t.id} className="task" data-id={t.id}>
                <span className="caption">“{t.caption}”</span> <span className="image">{t.image}</span>{" "}
                <button type="button" className="claim" disabled={b.pending.includes(t.id)} onClick={() => void claim(t)}>
                  Claim
                </button>
              </li>
            ))}
          </ul>
        )}
        {!b.loading && !b.queue.length && <p className="muted">The queue is empty — nice work.</p>}
        {b.hasMore && (
          <button type="button" className="load-more" disabled={b.loadingMore} onClick={() => void loadMore()}>
            {b.loadingMore ? "Loading…" : "Load more"}
          </button>
        )}
      </section>
    </main>
  );
}

function App() {
  const s = useAtomValue(sessionAtom);
  return s.status === "signed-in" ? <Workbench /> : <SignIn />;
}

createRoot(document.getElementById("app")!).render(
  <Provider store={store}>
    <App />
  </Provider>,
);
