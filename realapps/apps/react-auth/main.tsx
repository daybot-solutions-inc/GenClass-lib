// Ops dashboard behind a login (React 19 + axios with request/response interceptors, state in runtime atoms read
// with useAtom). Access tokens are short-lived and refresh tokens rotate (an old refresh token is rejected). The
// dashboard fires several requests in parallel, so a token expiry yields several 401s at once. Latent bugs by
// flag: every 401 starts its own refresh (refresh=per-request: concurrent refreshes with the same rotating refresh
// token, the losers get 401 and the app signs the user out), the original request is not retried after a
// refresh (retryOriginal=false: panels and user actions fail although the session was renewed).
import { createRoot } from "react-dom/client";
import { useEffect, useState, type ReactNode } from "react";
import axios, { type AxiosError, type InternalAxiosRequestConfig } from "axios";
import { useAtom } from "@genclass/runtime/react";
import { rt, flag } from "../_shared/genclass";

type Panel = "projects" | "invoices" | "notifications";
type Project = { id: number; name: string; status: string; progress: number };
type Invoice = { id: number; customer: string; amount: number; status: "pending" | "approved" };
type Note = { id: number; text: string; read: boolean };
const REFRESH = flag("refresh", "single-flight") as "single-flight" | "per-request";
const RETRY_ORIGINAL = Boolean(flag("retryOriginal", true));
const AUTO_MS = Number(flag("autoRefreshMs", 10000));

const auth = rt.atom("auth", { status: "signed-out" as "signed-out" | "signed-in", user: "", token: "", refreshToken: "", busy: false, refreshes: 0, error: "" });
const emptyDash = { invoiceFilter: "all", projects: [] as Project[], invoices: [] as Invoice[], notifications: [] as Note[], unread: 0, pending: [] as number[], errors: {} as Record<string, string> };
const dash = rt.atom("dash", emptyDash);
let session = 0;
// what the browser's password manager would autofill after the first successful sign-in
let saved = { username: "", password: "" };

// ------------------------------------------------------------------------------------------------- http
const api = axios.create({ baseURL: "/api", timeout: 8000 });

api.interceptors.request.use((cfg) => {
  const t = auth.get().token;
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

function signOut(reason: string) {
  session++;
  auth.set({ status: "signed-out", user: "", token: "", refreshToken: "", busy: false, refreshes: 0, error: reason });
  dash.set(emptyDash);
}

async function doRefresh(): Promise<string> {
  const refreshToken = auth.get().refreshToken;
  try {
    const r = await axios.post<{ token: string; refreshToken: string }>("/api/auth/refresh", { refreshToken }, { timeout: 8000 });
    auth.update((a) => (a.status === "signed-in" ? { ...a, token: r.data.token, refreshToken: r.data.refreshToken, refreshes: a.refreshes + 1 } : a));
    return r.data.token;
  } catch (e) {
    if ((e as AxiosError).response?.status === 401 && auth.get().status === "signed-in") signOut("Your session expired. Please sign in again.");
    throw e;
  }
}

let refreshing: Promise<string> | null = null;
function refreshAccessToken(): Promise<string> {
  if (REFRESH === "single-flight" && refreshing) return refreshing;
  const p = doRefresh().finally(() => {
    if (refreshing === p) refreshing = null;
  });
  refreshing = p;
  return p;
}

api.interceptors.response.use(undefined, async (err: AxiosError) => {
  const cfg = err.config as (InternalAxiosRequestConfig & { _retry?: boolean }) | undefined;
  if (err.response?.status !== 401 || !cfg || cfg._retry || !auth.get().refreshToken) throw err;
  cfg._retry = true;
  const token = await refreshAccessToken();
  if (!RETRY_ORIGINAL) throw err;
  cfg.headers.Authorization = `Bearer ${token}`;
  return api(cfg);
});

// ------------------------------------------------------------------------------------------------- data
async function loadPanel(p: Panel) {
  const mine = session;
  const status = dash.get().invoiceFilter;
  try {
    const r = await api.get<{ data: unknown[] }>(`/${p}`, p === "invoices" && status !== "all" ? { params: { status } } : undefined);
    const items = Array.isArray(r.data?.data) ? r.data.data : [];
    if (mine !== session) return;
    if (p === "invoices" && dash.get().invoiceFilter !== status) return; // the filter changed meanwhile
    dash.update((d) => ({ ...d, [p]: items, ...(p === "notifications" ? { unread: (items as Note[]).filter((n) => !n.read).length } : {}), errors: { ...d.errors, [p]: "" } }));
  } catch {
    if (mine !== session) return;
    dash.update((d) => ({ ...d, errors: { ...d.errors, [p]: `Could not load ${p}` } }));
  }
}

const loadAll = () => Promise.all((["projects", "invoices", "notifications"] as Panel[]).map(loadPanel));

async function signIn(username: string, password: string) {
  if (auth.get().busy || !username.trim()) return;
  auth.update((a) => ({ ...a, busy: true, error: "" }));
  try {
    const r = await axios.post<{ token: string; refreshToken: string; user: { username: string } }>("/api/auth/login", { username: username.trim(), password }, { timeout: 8000 });
    session++;
    saved = { username: username.trim(), password };
    auth.set({ status: "signed-in", user: r.data.user.username, token: r.data.token, refreshToken: r.data.refreshToken, busy: false, refreshes: 0, error: "" });
    void loadAll();
  } catch (e) {
    auth.update((a) => ({ ...a, busy: false, error: (e as AxiosError).response?.status === 422 ? "Enter your username and password" : "Sign-in failed, try again" }));
  }
}

async function approve(inv: Invoice) {
  if (dash.get().pending.includes(inv.id)) return;
  const mine = session;
  dash.update((d) => ({ ...d, pending: [...d.pending, inv.id] }));
  try {
    const r = await api.patch<Invoice>(`/invoices/${inv.id}`, { status: "approved" });
    if (mine !== session) return;
    dash.update((d) => ({ ...d, invoices: d.invoices.map((x) => (x.id === inv.id ? r.data : x)), pending: d.pending.filter((x) => x !== inv.id) }));
  } catch {
    if (mine !== session) return;
    dash.update((d) => ({ ...d, pending: d.pending.filter((x) => x !== inv.id), errors: { ...d.errors, invoices: `Could not approve invoice ${inv.id}` } }));
  }
}

async function markRead(n: Note) {
  if (n.read) return;
  const mine = session;
  dash.update((d) => ({ ...d, notifications: d.notifications.map((x) => (x.id === n.id ? { ...x, read: true } : x)), unread: d.unread - 1 }));
  try {
    await api.post(`/notifications/${n.id}/read`);
  } catch {
    if (mine !== session) return;
    dash.update((d) => ({ ...d, notifications: d.notifications.map((x) => (x.id === n.id ? { ...x, read: false } : x)), unread: d.unread + 1, errors: { ...d.errors, notifications: "Could not mark as read" } }));
  }
}

// --------------------------------------------------------------------------------------------------- UI
function SignIn() {
  const [a] = useAtom(auth);
  const [username, setUsername] = useState(saved.username);
  const [password, setPassword] = useState(saved.password);
  return (
    <form
      className="sign-in"
      onSubmit={(e) => {
        e.preventDefault();
        void signIn(username, password);
      }}
    >
      <h1>Sign in</h1>
      {a.error && <p role="alert">{a.error}</p>}
      <input name="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" autoComplete="username" />
      <input name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoComplete="current-password" />
      <button className="sign-in" type="submit" disabled={a.busy}>
        {a.busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

const TITLE: Record<Panel, string> = { projects: "Projects", invoices: "Invoices", notifications: "Inbox" };

function Dashboard() {
  const [a] = useAtom(auth);
  const [d, setD] = useAtom(dash);
  useEffect(() => {
    const h = setInterval(() => void loadAll(), AUTO_MS);
    return () => clearInterval(h);
  }, []);
  const panel = (p: Panel, body: ReactNode) => (
    <section className={`panel ${p}`}>
      <h2>
        {TITLE[p]}{" "}
        <button className="reload-panel" aria-label={`Reload ${TITLE[p]}`} onClick={() => void loadPanel(p)}>
          ↻
        </button>
      </h2>
      {d.errors[p] && <p role="alert">{d.errors[p]}</p>}
      {body}
    </section>
  );
  return (
    <main className="dashboard">
      <header>
        <span className="who">Signed in as {a.user}</span>
        <span className="badge">{d.unread} unread</span>
        <button className="refresh-dash" onClick={() => void loadAll()}>
          Refresh all
        </button>
        <button className="sign-out" onClick={() => signOut("")}>
          Sign out
        </button>
      </header>
      {panel(
        "projects",
        <ul>
          {d.projects.map((p) => (
            <li key={p.id} className="project">
              {p.name} · {p.status} · {p.progress}%
            </li>
          ))}
        </ul>,
      )}
      {panel(
        "invoices",
        <>
          <select
            name="invoiceStatus"
            value={d.invoiceFilter}
            onChange={(e) => {
              const v = e.target.value;
              setD((x) => ({ ...x, invoiceFilter: v }));
              void loadPanel("invoices");
            }}
          >
            <option value="all">All invoices</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
          </select>
          <ul>
            {d.invoices.map((i) => (
              <li key={i.id} className="invoice">
                {i.customer} · ${i.amount} · {i.status}
                {i.status === "pending" && (
                  <button className="approve" disabled={d.pending.includes(i.id)} onClick={() => void approve(i)}>
                    Approve
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>,
      )}
      {panel(
        "notifications",
        <ul>
          {d.notifications.map((n) => (
            <li key={n.id} className={n.read ? "note" : "note unread"}>
              {n.text}
              {!n.read && (
                <button className="mark-read" onClick={() => void markRead(n)}>
                  Mark read
                </button>
              )}
            </li>
          ))}
        </ul>,
      )}
    </main>
  );
}

function App() {
  const [a] = useAtom(auth);
  return a.status === "signed-in" ? <Dashboard /> : <SignIn />;
}

createRoot(document.getElementById("app")!).render(<App />);
