// Station departures board (nanostores map/computed with a hand-written DOM layer; fetch + AbortController +
// WebSocket; the stores are not registered with GenClass: observe-only). The next departures load six at a time
// ("Show later trains"), a destination search narrows the board, platform/status changes stream in live and departed
// trains drop off. Riders can ask for a platform alert on a train (POST /alerts, one per train). Latent bugs by flag:
// later trains fetched by offset while departed trains keep shifting the list (more=offset: a train is skipped or
// shown twice; more=window refetches the whole window), searches that don't abort the previous one (searchSeq=blind:
// results for "k" replace those for "kin"), pushes applied in arrival order (live=blind), reconnects without a reload
// (reconnect=naive: departures that left while offline stay on the board) and alert buttons live while posting
// (alertGuard=none: the second POST answers 409).
import { map, computed } from "nanostores";
import { flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError, isAbort, liveTopic } from "../_shared/w3-http";

type Dep = { id: number; train: string; dest: string; time: string; platform: string; status: string; updatedAt?: string };
const MORE = flag("more", "window");
const SEARCH_SEQ = flag("searchSeq", "abort");
const LIVE = flag("live", "newer-wins");
const RECONNECT = flag("reconnect", "resync");
const ALERT_GUARD = flag("alertGuard", "pending") === "pending";
const PAGE = 6;

const $board = map({ q: "", rows: [] as Dep[], total: 0, loading: true, loadingMore: false, alerts: {} as Record<number, number>, busy: [] as number[], live: false, error: "", notice: "" });
const $hasMore = computed($board, (b) => b.rows.length < b.total);
const set = (patch: Partial<ReturnType<typeof $board.get>>) => $board.set({ ...$board.get(), ...patch });
const byTime = (rs: Dep[]) => [...rs].sort((a, b) => a.time.localeCompare(b.time) || a.id - b.id);
const qs = (q: string, extra: string) => `/api/departures?sort=time${q ? `&q=${encodeURIComponent(q)}` : ""}${extra}`;

let ctl: AbortController | null = null;
let seq = 0;
async function loadFirst(q = $board.get().q) {
  const my = ++seq;
  if (SEARCH_SEQ === "abort") ctl?.abort();
  ctl = new AbortController();
  set({ loading: true, error: "" });
  try {
    const body = await api<{ items: Dep[]; total: number }>(qs(q, `&limit=${PAGE}`), "GET", undefined, {}, SEARCH_SEQ === "abort" ? ctl.signal : undefined);
    if (SEARCH_SEQ === "abort" && my !== seq) return;
    set({ rows: byTime(itemsOf<Dep>(body)), total: Number(body.total ?? 0), loading: false });
  } catch (e) {
    if (!isAbort(e) && my === seq) set({ loading: false, error: errText(e, "loading departures") });
  }
}

async function loadMore() {
  const b = $board.get();
  if (b.loadingMore || b.loading) return;
  const my = seq;
  set({ loadingMore: true, error: "" });
  try {
    const extra = MORE === "window" ? `&limit=${b.rows.length + PAGE}` : `&offset=${b.rows.length}&limit=${PAGE}`;
    const body = await api<{ items: Dep[]; total: number }>(qs(b.q, extra));
    if (my !== seq) return set({ loadingMore: false });
    const items = itemsOf<Dep>(body);
    set({ rows: MORE === "window" ? byTime(items) : [...$board.get().rows, ...items], total: Number(body.total ?? 0), loadingMore: false });
  } catch (e) {
    set({ loadingMore: false, error: errText(e, "loading later trains") });
  }
}

async function toggleAlert(d: Dep) {
  const b = $board.get();
  if (ALERT_GUARD && b.busy.includes(d.id)) return;
  const id = b.alerts[d.id];
  set({ busy: [...b.busy, d.id], error: "", notice: "" });
  try {
    const alerts = { ...$board.get().alerts };
    if (id) {
      await api(`/api/alerts/${id}`, "DELETE");
      delete alerts[d.id];
      set({ alerts, notice: `Alert for ${d.train} cancelled.` });
    } else {
      const a = await api<{ id: number }>(`/api/alerts`, "POST", { trainId: d.id, train: d.train });
      alerts[d.id] = a.id;
      set({ alerts, notice: `We'll text you when ${d.train} to ${d.dest} gets a platform change.` });
    }
  } catch (e) {
    set({ error: e instanceof HttpError && e.status === 409 ? `You already have an alert for ${d.train}.` : errText(e, `setting the alert for ${d.train}`) });
  } finally {
    set({ busy: $board.get().busy.filter((x) => x !== d.id) });
  }
}

// ------------------------------------------------------------------------------------------- DOM
const root = document.getElementById("app")!;
root.innerHTML = `<main class="departures"><h1>Union Station · departures</h1><p class="status"></p>
  <input name="q" placeholder="Destination or train"> <div class="msg"></div><ul class="board"></ul><button type="button" class="more">Show later trains</button></main>`;
const q = <T extends Element>(s: string) => root.querySelector(s) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
$board.subscribe((b) => {
  q("p.status").textContent = `${b.loading ? "Updating…" : `${b.rows.length} of ${b.total} departures`} · ${b.live ? "live" : "reconnecting…"}`;
  q("div.msg").innerHTML = b.error ? `<p role="alert">${esc(b.error)}</p>` : b.notice ? `<p class="notice">${esc(b.notice)}</p>` : "";
  q("ul.board").innerHTML = b.rows
    .map((d) => `<li class="departure ${d.status.split(" ")[0]}" data-id="${d.id}"><strong>${d.time}</strong> ${esc(d.train)} → ${esc(d.dest)} · platform ${esc(d.platform)} · ${esc(d.status)}
      <button type="button" class="alert"${ALERT_GUARD && b.busy.includes(d.id) ? " disabled" : ""}>${b.alerts[d.id] ? "Alert on" : "Alert me"}</button></li>`)
    .join("");
  const more = q<HTMLButtonElement>("button.more");
  more.disabled = b.loadingMore || !$hasMore.get();
  more.textContent = b.loadingMore ? "Loading…" : "Show later trains";
});
let debounce: ReturnType<typeof setTimeout> | undefined;
q("input[name=q]").addEventListener("input", (e) => {
  const v = (e.target as HTMLInputElement).value.trim();
  set({ q: v });
  clearTimeout(debounce);
  debounce = setTimeout(() => void loadFirst(v), 250);
});
root.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.matches("button.more")) void loadMore();
  else if (t.matches("li.departure button.alert")) {
    const d = $board.get().rows.find((x) => x.id === Number(t.closest("li")!.dataset.id));
    if (d) void toggleAlert(d);
  }
});

let everUp = false;
liveTopic(
  "departures",
  (m) => {
    const b = $board.get();
    if (m.type === "deleted") set({ rows: b.rows.filter((d) => d.id !== Number(m.id)), total: Math.max(0, b.total - 1) });
    else if (m.type === "created") set({ total: b.total + 1 });
    else if (m.item) {
      const d = m.item as Dep;
      set({ rows: b.rows.map((x) => (x.id !== d.id ? x : LIVE === "newer-wins" && x.updatedAt && d.updatedAt && d.updatedAt < x.updatedAt ? x : d)) });
    }
  },
  (up) => {
    set({ live: up });
    if (up && everUp && RECONNECT === "resync") void loadFirst();
    if (up) everUp = true;
  },
);
void loadFirst("");
void api(`/api/alerts?limit=50`).then((body) => set({ alerts: Object.fromEntries(itemsOf<{ id: number; trainId: number }>(body).map((a) => [a.trainId, a.id])) }), () => undefined);
