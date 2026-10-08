// Newsletter admin console (nanostores map + computed with a hand-written DOM layer; fetch + AbortController). The
// editor signs in (short-lived bearer tokens, rotating refresh tokens), pages through subscribers with a cursor
// ("Load more"), narrows them by status and by a search box, adds a subscriber (one per email: a duplicate answers
// 409) and unsubscribes the ticked rows in one bulk PATCH with per-item results. The token is renewed a few seconds
// before it expires; when that renewal fails or is slow, the stats strip (three status counts polled in parallel)
// gets several 401s at once. The maps are registered with rt.guard: UI events write the nanostores directly (traced),
// network results go through the guarded handles. Latent bugs by flag: every 401 refreshes on its own
// (refresh=concurrent: the losers present an already-rotated refresh token and the editor is signed out), a filter or
// search change keeps the old cursor and selection (cursor=keep: "Load more" pages through the previous list and
// appends rows of the wrong status; "Unsubscribe" hits rows no longer shown), searches that don't abort the previous
// one (searchAbort=none: results for "an" replace those for "ana"), an Add button live while posting (addGuard=none:
// the second POST answers 409 "already subscribed") and bulk results ignored (bulk=assume-all: rows the server kept
// active show as unsubscribed).
import { computed, map } from "nanostores";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError, isAbort } from "../_shared/w3-http";

type Status = "active" | "bounced" | "unsubscribed";
type Sub = { id: number; name: string; email: string; status: Status };
type Filter = "subscribed" | "unsubscribed" | "all";
type Audience = { filter: Filter; q: string; rows: Sub[]; nextCursor: string | null; loading: boolean; loadingMore: boolean; selected: number[]; busy: boolean; adding: boolean; counts: Record<Status, number>; error: string; notice: string };
type Session = { signedIn: boolean; user: string; busy: boolean; error: string };

const REFRESH = flag("refresh", "single-flight");
const CURSOR = flag("cursor", "reset-on-filter");
const SEARCH_ABORT = flag("searchAbort", "abort");
const ADD_GUARD = flag("addGuard", "pending") === "pending";
const BULK = flag("bulk", "per-item");
const PAGE = 8;

const fresh = (): Audience => ({ filter: "subscribed", q: "", rows: [], nextCursor: null, loading: false, loadingMore: false, selected: [], busy: false, adding: false, counts: { active: 0, bounced: 0, unsubscribed: 0 }, error: "", notice: "" });
const $session = map<Session>({ signedIn: false, user: "", busy: false, error: "" });
const $audience = map<Audience>(fresh());
const $picked = computed($audience, (a) => a.rows.filter((r) => a.selected.includes(r.id)).length);
const session = rt.guard<Session>("session", { get: () => $session.get(), set: (v) => $session.set(v), subscribe: (fn) => $session.listen(() => fn()) });
const audience = rt.guard<Audience>("audience", { get: () => $audience.get(), set: (v) => $audience.set(v), subscribe: (fn) => $audience.listen(() => fn()) });
const inFilter = (f: Filter, s: Status) => f === "all" || (f === "unsubscribed" ? s === "unsubscribed" : s !== "unsubscribed");

// ------------------------------------------------------------------------------------------- session
let access = "";
let renewal = "";
let epoch = 0; // bumps on sign-in / sign-out: answers for an older session are dropped
let refreshing: Promise<void> | null = null;
let renewTimer: ReturnType<typeof setTimeout> | undefined;

/** Renew a few seconds before the access token expires (401s then only happen when a renewal fails or is slow). */
function scheduleRenewal(expiresIn: number) {
  clearTimeout(renewTimer);
  const mine = epoch;
  renewTimer = setTimeout(() => void (mine === epoch && renewal && renew().catch(() => undefined)), Math.max(2, expiresIn - 4) * 1000);
}

function signOut(reason: string) {
  epoch++;
  clearTimeout(renewTimer);
  access = renewal = "";
  session.set({ signedIn: false, user: "", busy: false, error: reason });
  audience.set(fresh());
  for (const el of root.querySelectorAll<HTMLInputElement>("input[name=q], form.add input")) el.value = "";
}

async function renewOnce(): Promise<void> {
  const used = renewal;
  try {
    const r = await api<{ token: string; refreshToken: string; expiresIn: number }>("/api/auth/refresh", "POST", { refreshToken: used });
    if (renewal !== used) return;
    [access, renewal] = [r.token, r.refreshToken];
    scheduleRenewal(Number(r.expiresIn));
  } catch (e) {
    if (e instanceof HttpError && e.status === 401 && $session.get().signedIn) signOut("Your session expired — sign in again.");
    throw e;
  }
}
function renew(): Promise<void> {
  if (REFRESH === "concurrent") return renewOnce();
  refreshing ??= renewOnce().finally(() => (refreshing = null));
  return refreshing;
}

async function call<T = any>(url: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const mine = epoch;
  const sentWith = access;
  const go = () => api<T>(url, method, body, { authorization: `Bearer ${access}` }, signal);
  try {
    return await go();
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 401 || mine !== epoch || !renewal) throw e;
    if (REFRESH === "concurrent" || access === sentWith) await renew();
    if (mine !== epoch) throw e;
    return go();
  }
}

async function signIn(username: string, password: string) {
  if ($session.get().busy) return;
  $session.set({ ...$session.get(), busy: true, error: "" });
  try {
    const r = await api<{ token: string; refreshToken: string; expiresIn: number; user: { username: string } }>("/api/auth/login", "POST", { username, password });
    epoch++;
    [access, renewal] = [r.token, r.refreshToken];
    scheduleRenewal(Number(r.expiresIn));
    session.set({ signedIn: true, user: r.user.username, busy: false, error: "" });
    void loadFirst();
    void loadCounts();
  } catch (e) {
    session.update((s) => ({ ...s, busy: false, error: errText(e, "signing in") }));
  }
}

// ------------------------------------------------------------------------------------------- list
const listUrl = (f: Filter, q: string, cursor: string) =>
  `/api/subscribers?sort=name&limit=${PAGE}&cursor=${encodeURIComponent(cursor)}${f === "subscribed" ? "&status__in=active,bounced" : f === "unsubscribed" ? "&status=unsubscribed" : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
let listSeq = 0;
let searchCtl: AbortController | null = null;

async function loadFirst() {
  const my = ++listSeq;
  const mine = epoch;
  if (SEARCH_ABORT === "abort") searchCtl?.abort();
  const ctl = (searchCtl = new AbortController());
  const { filter, q } = $audience.get();
  audience.update((a) => ({ ...a, loading: true, error: "" }));
  try {
    const body = await call<{ items: Sub[]; nextCursor: string | null }>(listUrl(filter, q, ""), "GET", undefined, SEARCH_ABORT === "abort" ? ctl.signal : undefined);
    if (mine !== epoch || (SEARCH_ABORT === "abort" && my !== listSeq)) return;
    const rows = itemsOf<Sub>(body);
    audience.update((a) => ({ ...a, rows, nextCursor: body.nextCursor ?? null, loading: false, selected: CURSOR === "keep" ? a.selected : a.selected.filter((id) => rows.some((r) => r.id === id)) }));
  } catch (e) {
    if (!isAbort(e) && mine === epoch && my === listSeq) audience.update((a) => ({ ...a, loading: false, error: errText(e, "loading subscribers") }));
  }
}

async function loadMore() {
  const a0 = $audience.get();
  if (a0.loadingMore || !a0.nextCursor) return;
  const my = listSeq;
  const mine = epoch;
  $audience.set({ ...a0, loadingMore: true, error: "" });
  try {
    const body = await call<{ items: Sub[]; nextCursor: string | null }>(listUrl(a0.filter, a0.q, a0.nextCursor));
    if (mine !== epoch) return;
    audience.update((a) => {
      if (CURSOR === "reset-on-filter" && my !== listSeq) return { ...a, loadingMore: false };
      const have = new Set(a.rows.map((r) => r.id));
      return { ...a, rows: [...a.rows, ...itemsOf<Sub>(body).filter((r) => !have.has(r.id))], nextCursor: body.nextCursor ?? null, loadingMore: false };
    });
  } catch (e) {
    if (mine === epoch) audience.update((a) => ({ ...a, loadingMore: false, error: errText(e, "loading more subscribers") }));
  }
}

let countSeq = 0;
async function loadCounts() {
  const mine = epoch;
  const my = ++countSeq;
  const statuses: Status[] = ["active", "bounced", "unsubscribed"];
  const got = await Promise.all(statuses.map((s) => call<{ total: number }>(`/api/subscribers?status=${s}&limit=1`).then((b) => Number(b.total ?? 0), () => null)));
  if (mine !== epoch || my !== countSeq) return;
  audience.update((a) => ({ ...a, counts: Object.fromEntries(statuses.map((s, i) => [s, got[i] ?? a.counts[s]])) as Record<Status, number> }));
}

// ------------------------------------------------------------------------------------------- writes
async function unsubscribeSelected() {
  const a0 = $audience.get();
  if (a0.busy || !a0.selected.length) return;
  const ids = a0.selected.slice();
  const mine = epoch;
  $audience.set({ ...a0, busy: true, error: "", notice: "" });
  try {
    const body = await call<{ results?: { id: number; ok: boolean; status: number }[] }>("/api/subscribers/bulk", "POST", { ids, op: "patch", patch: { status: "unsubscribed" } });
    if (mine !== epoch) return;
    const results = body.results ?? [];
    const done = new Set(BULK === "per-item" ? results.filter((r) => r.ok).map((r) => Number(r.id)) : ids);
    const failed = ids.length - done.size;
    audience.update((a) => ({
      ...a,
      rows: a.rows.map((r) => (done.has(r.id) ? { ...r, status: "unsubscribed" as Status } : r)).filter((r) => inFilter(a.filter, r.status)),
      selected: a.selected.filter((id) => !done.has(id)),
      busy: false,
      notice: done.size ? `Unsubscribed ${done.size} subscriber${done.size === 1 ? "" : "s"}.` : "",
      error: failed > 0 ? `${failed} of ${ids.length} couldn't be unsubscribed — try again.` : "",
    }));
    void loadCounts();
  } catch (e) {
    if (mine === epoch) audience.update((a) => ({ ...a, busy: false, error: errText(e, "unsubscribing") }));
  }
}

async function addSubscriber(email: string) {
  const a0 = $audience.get();
  if (!email || (ADD_GUARD && a0.adding)) return;
  const mine = epoch;
  $audience.set({ ...a0, adding: true, error: "", notice: "" });
  try {
    const sub = await call<Sub>("/api/subscribers", "POST", { email, name: email.split("@")[0]!.replace(/[._]/g, " "), status: "active" });
    if (mine !== epoch) return;
    emailInput.value = "";
    audience.update((a) => ({ ...a, rows: inFilter(a.filter, sub.status) && !a.rows.some((r) => r.id === sub.id) ? [sub, ...a.rows] : a.rows, adding: false, notice: `${sub.email} is subscribed.` }));
    void loadCounts();
  } catch (e) {
    if (mine !== epoch) return;
    const msg = e instanceof HttpError && e.status === 409 ? `${email} is already on the list.` : e instanceof HttpError && e.status === 422 ? "Enter an email address." : errText(e, `adding ${email}`);
    audience.update((a) => ({ ...a, adding: false, error: msg }));
  }
}

// ------------------------------------------------------------------------------------------- DOM
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const root = document.getElementById("app")!;
root.innerHTML = `<main class="newsletter">
  <form class="sign-in"><h1>Harbour Weekly · admin</h1><p class="why"></p>
    <input name="username" value="editor" aria-label="Username"> <input name="password" type="password" value="harbour-demo" aria-label="Password">
    <button type="submit" class="sign-in">Sign in</button></form>
  <section class="console" hidden>
    <header><h1>Subscribers</h1><span class="who"></span><p class="stats"></p></header>
    <div class="toolbar"><select name="status" aria-label="Status"><option value="subscribed">Subscribed</option><option value="unsubscribed">Unsubscribed</option><option value="all">Everyone</option></select>
      <input name="q" placeholder="Search name or email"> <button type="button" class="unsubscribe">Unsubscribe selected</button></div>
    <div class="msg"></div>
    <table><thead><tr><th></th><th>Name</th><th>Email</th><th>Status</th></tr></thead><tbody></tbody></table>
    <button type="button" class="more">Load more</button>
    <form class="add"><input name="email" placeholder="new@subscriber.com" aria-label="Email"> <button type="submit" class="add">Add subscriber</button></form>
  </section></main>`;
const $ = <T extends Element>(s: string) => root.querySelector(s) as T;
const emailInput = $<HTMLInputElement>("form.add input[name=email]");

function render() {
  const s = $session.get();
  const a = $audience.get();
  $<HTMLElement>("form.sign-in").hidden = s.signedIn;
  $<HTMLElement>("section.console").hidden = !s.signedIn;
  $("form.sign-in p.why").innerHTML = s.error ? `<span role="alert">${esc(s.error)}</span>` : "";
  $<HTMLButtonElement>("button.sign-in").disabled = s.busy;
  $("button.sign-in").textContent = s.busy ? "Signing in…" : "Sign in";
  $("span.who").textContent = s.user ? `signed in as ${s.user}` : "";
  $<HTMLSelectElement>("select[name=status]").value = a.filter;
  $("p.stats").textContent = `${a.counts.active} active · ${a.counts.bounced} bounced · ${a.counts.unsubscribed} unsubscribed`;
  $("div.msg").innerHTML = (a.error ? `<p role="alert">${esc(a.error)}</p>` : "") + (a.notice ? `<p class="notice">${esc(a.notice)}</p>` : "") + (a.loading ? `<p class="loading">Updating…</p>` : "");
  $("tbody").innerHTML = a.rows.length
    ? a.rows.map((r) => `<tr class="subscriber ${r.status}" data-id="${r.id}"><td><input type="checkbox" class="pick"${a.selected.includes(r.id) ? " checked" : ""} aria-label="Select ${esc(r.name)}"></td><td>${esc(r.name)}</td><td>${esc(r.email)}</td><td>${r.status}</td></tr>`).join("")
    : `<tr class="empty"><td colspan="4">${a.loading ? "Loading…" : "No subscribers match."}</td></tr>`;
  const more = $<HTMLButtonElement>("button.more");
  more.disabled = a.loadingMore || !a.nextCursor;
  more.textContent = a.loadingMore ? "Loading…" : a.nextCursor ? "Load more" : "End of list";
  const unsub = $<HTMLButtonElement>("button.unsubscribe");
  unsub.disabled = a.busy || a.selected.length === 0;
  unsub.textContent = a.busy ? "Unsubscribing…" : `Unsubscribe selected (${$picked.get()})`;
  const add = $<HTMLButtonElement>("form.add button.add");
  add.disabled = ADD_GUARD && a.adding;
  add.textContent = a.adding ? "Adding…" : "Add subscriber";
}
$session.listen(render);
$audience.listen(render);
render();

function listChanged(patch: Partial<Audience>) {
  const a = $audience.get();
  if (CURSOR === "reset-on-filter") {
    listSeq++;
    $audience.set({ ...a, ...patch, nextCursor: null, selected: [] });
  } else $audience.set({ ...a, ...patch });
  void loadFirst();
}

let debounce: ReturnType<typeof setTimeout> | undefined;
root.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target as HTMLFormElement;
  if (f.matches("form.sign-in")) void signIn($<HTMLInputElement>("input[name=username]").value.trim(), $<HTMLInputElement>("input[name=password]").value);
  else if (f.matches("form.add")) void addSubscriber(emailInput.value.trim().toLowerCase());
});
root.addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.matches("select[name=status]")) listChanged({ filter: t.value as Filter });
  else if (t.matches("input.pick")) {
    const id = Number(t.closest("tr")!.dataset.id);
    const a = $audience.get();
    $audience.set({ ...a, selected: a.selected.includes(id) ? a.selected.filter((x) => x !== id) : [...a.selected, id] });
  }
});
$("input[name=q]").addEventListener("input", (e) => {
  const q = (e.target as HTMLInputElement).value.trim();
  clearTimeout(debounce);
  debounce = setTimeout(() => listChanged({ q }), 300);
});
root.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.matches("button.more")) void loadMore();
  else if (t.matches("button.unsubscribe")) void unsubscribeSelected();
});
setInterval(() => {
  if ($session.get().signedIn) void loadCounts();
}, 6000);
