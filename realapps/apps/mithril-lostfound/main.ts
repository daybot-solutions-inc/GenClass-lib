// Lost-and-found desk of a transit agency (Mithril 2 hyperscript, m.request over XHR; state in runtime atoms, m.redraw
// on change). The clerk logs items handed in at the counter (POST /items: category, description and station are
// required, 422 otherwise), searches the register (debounced ?q=, newest first) and pages back with "Older items"
// (cursor pagination: ?cursor=<last id> → nextCursor). When an owner turns up the item is marked claimed (versioned
// PATCH: other stations hand items over too) and a handover record is filed (POST /handovers, retried once after a
// 5xx or a network error). Other stations log items all the time, so the first page polls for new ones. Latent bugs
// by flag: search answers applied in arrival order (searchSeq=blind: the results of an earlier query come back),
// the "Older items" cursor kept across searches (cursor=keep: the next page continues the previous query's position,
// showing duplicates or nothing), claims sent without the version (claim=force: an item another station already
// handed over is handed over again), the Log button live while posting (logGuard=none: a double click logs the item
// twice) and handover retries without an Idempotency-Key (handoverRetry=blind: a handover stored before a 5xx is filed
// twice).
import m from "mithril";
import { rt, flag } from "../_shared/genclass";

type Item = { id: number; category: string; description: string; station: string; status: string; createdAt: string; version: number };
type Page = { data: Item[]; nextCursor?: string | null };
const SEARCH_SEQ = flag("searchSeq", "latest");
const CURSOR = flag("cursor", "reset-on-search");
const CLAIM = flag("claim", "if-match");
const LOG_GUARD = flag("logGuard", "pending") === "pending";
const HANDOVER_RETRY = flag("handoverRetry", "idempotency-key");
const PER = 6;
const CATEGORIES = ["Umbrella", "Phone", "Wallet", "Keys", "Bag", "Glasses", "Clothing"];
const STATIONS = ["Central", "Harbour", "Northgate", "Airport"];

const desk = rt.atom("desk", { q: "", rows: [] as Item[], nextCursor: null as string | null, loading: true, older: false, pending: [] as number[], handedOver: 0, error: "", notice: "" });
const log = rt.atom("log", { category: "", description: "", station: "Central", saving: false });
desk.subscribe(() => m.redraw());
log.subscribe(() => m.redraw());
const code = (e: any) => Number(e?.code ?? 0) || "offline";
const matches = (it: Item, q: string) => !q || `${it.category}|${it.description}|${it.station}`.toLowerCase().includes(q.toLowerCase());
const pend = (id: number, on: boolean) => desk.update((d) => ({ ...d, pending: on ? [...d.pending, id] : d.pending.filter((x) => x !== id) }));
const place = (it: Item) => desk.update((d) => ({ ...d, rows: d.rows.map((r) => (r.id === it.id ? it : r)) }));
const list = (q: string, cursor: string) => m.request<Page>({ url: "/api/items", params: { ...(q ? { q } : {}), sort: "-createdAt", limit: PER, cursor }, background: true });

let seq = 0;
async function search() {
  const my = ++seq;
  const q = desk.get().q;
  desk.update((d) => ({ ...d, loading: true, error: "" }));
  try {
    const body = await list(q, "");
    if (SEARCH_SEQ === "latest" && my !== seq) return;
    desk.update((d) => ({
      ...d,
      rows: Array.isArray(body?.data) ? body.data : [],
      nextCursor: CURSOR === "reset-on-search" ? (body?.nextCursor ?? null) : (d.nextCursor ?? body?.nextCursor ?? null),
      loading: false,
    }));
  } catch (e) {
    if (my === seq) desk.update((d) => ({ ...d, loading: false, error: `The register could not be searched (${code(e)}).` }));
  }
}

async function older() {
  const d0 = desk.get();
  if (!d0.nextCursor || d0.older) return;
  const my = seq;
  desk.update((d) => ({ ...d, older: true, error: "" }));
  try {
    const body = await list(d0.q, d0.nextCursor);
    if (SEARCH_SEQ === "latest" && my !== seq) return void desk.update((d) => ({ ...d, older: false }));
    desk.update((d) => ({ ...d, rows: [...d.rows, ...(body?.data ?? [])], nextCursor: body?.nextCursor ?? null, older: false }));
  } catch (e) {
    desk.update((d) => ({ ...d, older: false, error: `Older items could not be loaded (${code(e)}).` }));
  }
}

/** New items logged at other stations (and items handed over there) show up on the first page. */
async function pollHead() {
  const d0 = desk.get();
  if (d0.loading || d0.older) return;
  const my = seq;
  try {
    const head = (await list(d0.q, ""))?.data ?? [];
    if (my !== seq || desk.get().q !== d0.q) return;
    desk.update((d) => {
      const fresh = head.filter((h) => !d.rows.some((r) => r.id === h.id));
      const rows = d.rows.map((r) => (d.pending.includes(r.id) ? r : (head.find((h) => h.id === r.id) ?? r)));
      return { ...d, rows: [...fresh, ...rows] };
    });
  } catch {
    /* next poll */
  }
}

let keyN = 0;
async function handOver(it: Item) {
  if (desk.get().pending.includes(it.id)) return;
  pend(it.id, true);
  desk.update((d) => ({ ...d, error: "", notice: "" }));
  try {
    let saved: Item;
    try {
      saved = await m.request<Item>({ method: "PATCH", url: `/api/items/${it.id}`, body: CLAIM === "if-match" ? { status: "claimed", version: it.version } : { status: "claimed" }, background: true });
    } catch (e: any) {
      const cur = code(e) === 409 ? (e?.response?.current as Item | undefined) : undefined;
      if (!cur) throw e;
      place(cur);
      desk.update((d) => ({ ...d, error: `LF-${it.id} (${it.description}) was already handed over at another station.` }));
      return;
    }
    place(saved);
    const key = HANDOVER_RETRY === "idempotency-key" ? `handover-${it.id}-${++keyN}` : "";
    const post = () => m.request({ method: "POST", url: "/api/handovers", body: { itemId: it.id, desk: "Central", category: it.category }, headers: key ? { "Idempotency-Key": key } : {}, background: true });
    await post().catch((e) => (code(e) === "offline" || Number(e?.code) >= 500 ? post() : Promise.reject(e)));
    desk.update((d) => ({ ...d, handedOver: d.handedOver + 1, notice: `LF-${it.id} (${it.description}) handed to its owner.` }));
  } catch (e) {
    desk.update((d) => ({ ...d, error: `The handover of LF-${it.id} failed (${code(e)}).` }));
  } finally {
    pend(it.id, false);
  }
}

async function logItem(ev: Event) {
  ev.preventDefault();
  const f = log.get();
  if (LOG_GUARD && f.saving) return;
  log.update((x) => ({ ...x, saving: true }));
  desk.update((d) => ({ ...d, error: "", notice: "" }));
  try {
    const saved = await m.request<Item>({ method: "POST", url: "/api/items", body: { category: f.category, description: f.description.trim(), station: f.station, status: "unclaimed" }, background: true });
    log.update((x) => ({ ...x, description: "", saving: false }));
    desk.update((d) => ({ ...d, rows: matches(saved, d.q) ? [saved, ...d.rows.filter((r) => r.id !== saved.id)] : d.rows, notice: `Logged LF-${saved.id}: ${saved.description}.` }));
  } catch (e: any) {
    const missing = code(e) === 422 ? Object.keys(e?.response?.errors ?? {}) : [];
    log.update((x) => ({ ...x, saving: false }));
    desk.update((d) => ({ ...d, error: missing.length ? `Please fill in: ${missing.join(", ")}.` : `The item was not logged (${code(e)}).` }));
  }
}

let debounce: ReturnType<typeof setTimeout> | undefined;
function onQuery(e: Event) {
  const q = (e.target as HTMLInputElement).value.trim();
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    desk.update((d) => ({ ...d, q, notice: "" }));
    void search();
  }, 300);
}

const field = (k: "category" | "description" | "station") => (e: Event) => log.update((x) => ({ ...x, [k]: (e.target as HTMLInputElement).value }));
const App = {
  view() {
    const d = desk.get();
    const f = log.get();
    return m("main.lostfound", [
      m("h1", "Lost and found · Central station"),
      m("p.muted", `Handed over this shift: ${d.handedOver}`),
      m("form.log", { onsubmit: (e: Event) => void logItem(e) }, [
        m("h2", "Log a found item"),
        m("select[name=category]", { value: f.category, onchange: field("category") }, [m("option", { value: "" }, "Category…"), ...CATEGORIES.map((c) => m("option", { value: c }, c))]),
        m("input[name=description][placeholder=Description]", { value: f.description, oninput: field("description") }),
        m("select[name=station]", { value: f.station, onchange: field("station") }, STATIONS.map((s) => m("option", { value: s }, s))),
        m("button.log[type=submit]", { disabled: LOG_GUARD && f.saving }, f.saving ? "Logging…" : "Log item"),
      ]),
      d.error ? m("p[role=alert]", d.error) : d.notice ? m("p.notice", d.notice) : null,
      m("input[name=q][placeholder=Search the register]", { oninput: onQuery }),
      d.loading ? m("p.muted", "Searching…") : !d.rows.length ? m("p.muted", "Nothing found.") : null,
      m("ul.items", d.rows.map((it) => m("li.item", { class: it.status }, [
        m("strong", `LF-${it.id}`), ` · ${it.category} · ${it.description} · found at ${it.station} · ${it.createdAt.slice(0, 10)} · `,
        it.status === "unclaimed" ? m("button.handover[type=button]", { disabled: d.pending.includes(it.id), onclick: () => void handOver(it) }, "Hand over") : m("em", "claimed"),
      ]))),
      d.nextCursor ? m("button.older[type=button]", { disabled: d.older || d.loading, onclick: () => void older() }, d.older ? "Loading…" : "Older items") : null,
    ]);
  },
};
m.mount(document.getElementById("app")!, App);
void search();
setInterval(() => void pollHead(), 6000);
