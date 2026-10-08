// Election night results desk (Mithril 2 hyperscript, m.request over XHR, WebSocket; plain module state, no stores
// registered with GenClass: observe-only). District tallies stream in over the live topic and the visible page also
// polls as a fallback; clicking a district loads its detail; readers can follow districts. Latent bugs by flag:
// page responses applied in arrival order (pageSeq=blind: page 1 lands after you moved to page 3), detail answers
// applied whatever district is open now (detailSeq=blind), polling on setInterval (poll=interval: slow polls
// overlap), poll results that replace rows even when a push already brought newer numbers (merge=replace: tallies
// go backwards), optimistic follows never rolled back (follow=optimistic) and reconnects without a reload
// (reconnect=naive: tallies sent while the socket was down are never seen).
import m from "mithril";
import { flag } from "../_shared/genclass";
import { liveTopic } from "../_shared/w3-http";

type District = { id: number; name: string; region: string; reported: number; votesA: number; votesB: number; updatedAt?: string };
type Follow = { id: number; districtId: number };
const PAGE_SEQ = flag("pageSeq", "latest");
const DETAIL_SEQ = flag("detailSeq", "latest");
const POLL = flag("poll", "chain");
const MERGE = flag("merge", "newer-wins");
const FOLLOW = flag("follow", "wait");
const RECONNECT = flag("reconnect", "resync");
const PAGE = 6;

const S = { region: "all", page: 1, rows: [] as District[], total: 0, loading: true, detail: null as District | null, detailLoading: false, follows: {} as Record<number, number>, busy: [] as number[], called: 0, live: false, error: "", notice: "" };
const code = (e: any) => Number(e?.code ?? 0) || "offline";
const newer = (a?: string, b?: string) => Boolean(a && b && a > b);
const take = (local: District | undefined, incoming: District) => (MERGE === "newer-wins" && local && newer(local.updatedAt, incoming.updatedAt) ? local : incoming);
const pct = (d: District) => `${Math.min(100, d.reported)}% reported`;
const leader = (d: District) => (d.votesA === d.votesB ? "tied" : d.votesA > d.votesB ? `Rivera +${d.votesA - d.votesB}` : `Okafor +${d.votesB - d.votesA}`);

let pageSeq = 0;
async function loadPage(background = false) {
  const my = background ? pageSeq : ++pageSeq;
  const { region, page } = S;
  if (!background) S.loading = true;
  try {
    const body = await m.request<{ items: District[]; total: number }>({ url: "/api/districts", params: { page, limit: PAGE, ...(region === "all" ? {} : { region }) }, background: true });
    if ((background || PAGE_SEQ === "latest") && my !== pageSeq) return;
    if (background && (S.page !== page || S.region !== region)) return;
    const items = Array.isArray(body?.items) ? body.items : [];
    const local = new Map(S.rows.map((r) => [r.id, r]));
    S.rows = background ? items.map((d) => take(local.get(d.id), d)) : items;
    S.total = Number(body?.total ?? S.total);
    if (!background) S.error = "";
  } catch (e) {
    if (!background && my === pageSeq) S.error = `Results could not be loaded (${code(e)}).`;
  } finally {
    if (!background && my === pageSeq) S.loading = false;
    m.redraw();
  }
}

let detailSeq = 0;
async function openDetail(d: District) {
  const my = ++detailSeq;
  S.detail = d;
  S.detailLoading = true;
  try {
    const full = await m.request<District>({ url: `/api/districts/${d.id}`, background: true });
    if (DETAIL_SEQ === "latest" && my !== detailSeq) return;
    S.detail = take(S.detail?.id === full.id ? S.detail : undefined, full);
  } catch (e) {
    if (my === detailSeq) S.error = `${d.name} could not be loaded (${code(e)}).`;
  } finally {
    if (my === detailSeq) S.detailLoading = false;
    m.redraw();
  }
}

async function toggleFollow(d: District) {
  if (S.busy.includes(d.id)) return;
  const id = S.follows[d.id];
  S.busy = [...S.busy, d.id];
  S.error = "";
  if (FOLLOW === "optimistic") {
    if (id) delete S.follows[d.id];
    else S.follows[d.id] = -1;
  }
  try {
    if (id) {
      await m.request({ method: "DELETE", url: `/api/follows/${id}`, background: true });
      delete S.follows[d.id];
      S.notice = `Stopped following ${d.name}.`;
    } else {
      const f = await m.request<Follow>({ method: "POST", url: "/api/follows", body: { districtId: d.id }, background: true });
      S.follows[d.id] = f.id;
      S.notice = `Following ${d.name}: you'll get an alert when it's called.`;
    }
  } catch (e) {
    S.error = `${id ? "Unfollowing" : "Following"} ${d.name} failed (${code(e)}).`;
  } finally {
    S.busy = S.busy.filter((x) => x !== d.id);
    m.redraw();
  }
}

const App = {
  view() {
    const pages = Math.max(1, Math.ceil(S.total / PAGE));
    return m("main.elections", [
      m("header", [m("h1", "Election night"), m("p.called", `${S.called} races called · ${S.live ? "live" : "reconnecting…"}`)]),
      m(".toolbar", [
        m("label", ["Region ", m("select[name=region]", { onchange: (e: Event) => ((S.region = (e.target as HTMLSelectElement).value), (S.page = 1), void loadPage()) }, ["all", "North", "Central", "Coastal"].map((r) => m("option", { value: r, selected: r === S.region }, r === "all" ? "All regions" : r)))]),
        m("button.refresh[type=button]", { onclick: () => void loadPage() }, "Refresh"),
        S.loading ? m("span.muted", " Loading…") : null,
      ]),
      S.error ? m("p[role=alert]", S.error) : S.notice ? m("p.notice", S.notice) : null,
      m("table", m("tbody", S.rows.map((d) => m("tr.district", { key: d.id }, [
        m("td", d.name), m("td", d.region), m("td", pct(d)), m("td", `Rivera ${d.votesA}`), m("td", `Okafor ${d.votesB}`), m("td", leader(d)),
        m("td", m("button.open[type=button]", { onclick: () => void openDetail(d) }, "Details")),
        m("td", m("button.follow[type=button]", { disabled: S.busy.includes(d.id), onclick: () => void toggleFollow(d) }, S.follows[d.id] ? "Following" : "Follow")),
      ])))),
      m("nav.pages", Array.from({ length: pages }, (_, i) => m("button[type=button]", { class: S.page === i + 1 ? "current" : "", onclick: () => ((S.page = i + 1), void loadPage()) }, String(i + 1)))),
      S.detail ? m("aside.detail", [m("h2", S.detail.name), S.detailLoading ? m("p.muted", "Loading…") : m("p", `${pct(S.detail)} · Rivera ${S.detail.votesA} · Okafor ${S.detail.votesB} · ${leader(S.detail)}`)]) : null,
    ]);
  },
};
m.mount(document.getElementById("app")!, App);

// ------------------------------------------------------------------------------------------- live + polling
let everUp = false;
liveTopic(
  "districts",
  (msg) => {
    if (msg.type !== "updated" || !msg.item) return;
    const d = msg.item as District;
    S.rows = S.rows.map((r) => (r.id === d.id ? (MERGE === "newer-wins" && newer(r.updatedAt, d.updatedAt) ? r : d) : r));
    if (S.detail?.id === d.id && !S.detailLoading) S.detail = d;
    m.redraw();
  },
  (up) => {
    S.live = up;
    if (up && everUp && RECONNECT === "resync") void loadPage(true);
    if (up) everUp = true;
    m.redraw();
  },
);
liveTopic("counters/called", (msg) => {
  if (typeof msg.value === "number") S.called = msg.value;
  m.redraw();
});
void loadPage();
void m.request<Follow[]>({ url: "/api/follows", background: true }).then((fs) => (Array.isArray(fs) ? fs : []).forEach((f) => (S.follows[f.districtId] = f.id)), () => undefined).then(() => m.redraw());
void m.request<{ value: number }>({ url: "/api/counters/called", background: true }).then((c) => ((S.called = c.value), m.redraw()), () => undefined);
if (POLL === "interval") setInterval(() => void loadPage(true), 4000);
else {
  const loop = async () => {
    await loadPage(true);
    setTimeout(loop, 4000);
  };
  setTimeout(loop, 4000);
}
