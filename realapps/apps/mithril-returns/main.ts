// Outdoor retailer returns desk (Mithril 2 hyperscript, m.request over XHR; state in runtime atoms, m.redraw on change).
// A clerk scans a parcel's RMA code (lookup, then a versioned PATCH marks it received), grades its condition (PATCH →
// inspected) and issues the refund (POST /refunds, retried once after a 5xx, then the RMA is marked refunded). Returns
// are listed by status, six per page; other clerks receive parcels too. Latent bugs by flag: scan lookups applied in
// arrival order (scanSeq=blind: the panel shows the previous parcel), refunds retried without an Idempotency-Key
// (refundKey=none: a refund stored before a 5xx is paid twice), refund buttons live while posting (refundGuard=none),
// tab/page answers applied in arrival order (tabSeq=blind) and the "refunded today" total bumped at click time and
// never corrected (refundedTotal=incremental).
import m from "mithril";
import { rt, flag } from "../_shared/genclass";

type Rma = { id: number; rma: string; customer: string; item: string; sku: string; price: number; reason: string; status: string; condition: string; version: number };
type Refund = { id?: number; rmaId: number; amount: number };
const SCAN_SEQ = flag("scanSeq", "latest");
const REFUND_KEY = flag("refundKey", "idempotency-key");
const REFUND_GUARD = flag("refundGuard", "pending") === "pending";
const TAB_SEQ = flag("tabSeq", "latest");
const REFUNDED = flag("refundedTotal", "derive");
const PER = 6;
const RATE: Record<string, number> = { new: 1, opened: 0.8, damaged: 0 };
const TABS = ["all", "awaiting", "received", "inspected", "refunded"];

const desk = rt.atom("desk", { tab: "all", page: 1, rows: [] as Rma[], total: 0, loading: true, pending: [] as number[], refunds: [] as Refund[], refunded: 0, error: "", notice: "" });
const scan = rt.atom("scan", { code: "", match: null as Rma | null, looking: false });
desk.subscribe(() => m.redraw());
scan.subscribe(() => m.redraw());
const code = (e: any) => Number(e?.code ?? 0) || "offline";
const sum = (rs: Refund[]) => rs.reduce((a, r) => a + r.amount, 0);
const amountOf = (r: Rma) => Math.round(r.price * (RATE[r.condition] ?? 0));
const pend = (id: number, on: boolean) => desk.update((d) => ({ ...d, pending: on ? [...d.pending, id] : d.pending.filter((x) => x !== id) }));
/** A changed RMA: kept in place while it still belongs to the tab, dropped otherwise. */
const place = (rows: Rma[], tab: string, r: Rma) => (tab === "all" || r.status === tab ? rows.map((x) => (x.id === r.id ? r : x)) : rows.filter((x) => x.id !== r.id));
const patch = (r: Rma, body: Record<string, unknown>) => m.request<Rma>({ method: "PATCH", url: `/api/rmas/${r.id}`, body: { ...body, version: r.version }, background: true });

let tabSeq = 0;
async function loadTab() {
  const my = ++tabSeq;
  const { tab, page } = desk.get();
  desk.update((d) => ({ ...d, loading: true, error: "" }));
  try {
    const body = await m.request<{ data: Rma[]; meta: { total: number } }>({ url: "/api/rmas", params: { ...(tab === "all" ? { sort: "status" } : { status: tab }), page, limit: PER }, background: true });
    if (TAB_SEQ === "latest" && my !== tabSeq) return;
    desk.update((d) => ({ ...d, rows: Array.isArray(body?.data) ? body.data : [], total: Number(body?.meta?.total ?? 0), loading: false }));
  } catch (e) {
    if (my === tabSeq) desk.update((d) => ({ ...d, loading: false, error: `Returns could not be loaded (${code(e)}).` }));
  }
}

let scanSeq = 0;
async function lookup(ev: Event) {
  ev.preventDefault();
  const want = scan.get().code.trim().toUpperCase();
  if (!want) return;
  const my = ++scanSeq;
  scan.update((s) => ({ ...s, looking: true }));
  try {
    const body = await m.request<{ data: Rma[] }>({ url: "/api/rmas", params: { rma: want }, background: true });
    if (SCAN_SEQ === "latest" && my !== scanSeq) return;
    let r = (body?.data ?? [])[0] ?? null;
    if (r && r.status === "awaiting") {
      r = await patch(r, { status: "received" });
      desk.update((d) => ({ ...d, rows: place(d.rows, d.tab, r!), notice: `${r!.rma} received from ${r!.customer}.`, error: "" }));
    }
    if (SCAN_SEQ === "latest" && my !== scanSeq) return;
    scan.update((s) => ({ ...s, match: r, looking: false }));
    if (!r) desk.update((d) => ({ ...d, error: `No return found for ${want}.` }));
  } catch (e) {
    if (my === scanSeq) scan.update((s) => ({ ...s, looking: false }));
    desk.update((d) => ({ ...d, error: `Scanning ${want} failed (${code(e)}).` }));
  }
}

async function update(r: Rma, body: Record<string, unknown>, done: (x: Rma) => string) {
  if (desk.get().pending.includes(r.id)) return;
  pend(r.id, true);
  desk.update((d) => ({ ...d, error: "", notice: "" }));
  try {
    const saved = await patch(r, body);
    desk.update((d) => ({ ...d, rows: place(d.rows, d.tab, saved), notice: done(saved) }));
  } catch (e) {
    const cur = code(e) === 409 ? ((e as any)?.response?.current as Rma | undefined) : undefined;
    desk.update((d) => ({ ...d, rows: cur ? place(d.rows, d.tab, cur) : d.rows, error: cur ? `${r.rma} was handled by another clerk.` : `${r.rma} could not be updated (${code(e)}).` }));
  } finally {
    pend(r.id, false);
  }
}

let keyN = 0;
async function refund(r: Rma) {
  if (REFUND_GUARD && desk.get().pending.includes(r.id)) return;
  const amount = amountOf(r);
  pend(r.id, true);
  desk.update((d) => ({ ...d, error: "", notice: "", ...(REFUNDED === "incremental" ? { refunded: d.refunded + amount } : {}) }));
  const key = REFUND_KEY === "idempotency-key" ? `refund-${r.id}-${++keyN}` : "";
  const post = () => m.request<Refund>({ method: "POST", url: "/api/refunds", body: { rmaId: r.id, amount, rma: r.rma }, headers: key ? { "Idempotency-Key": key } : {}, background: true });
  try {
    const paid = await post().catch((e) => (Number(e?.code ?? 0) === 0 || Number(e?.code) >= 500 ? post() : Promise.reject(e)));
    desk.update((d) => ({ ...d, refunds: [...d.refunds, paid], refunded: REFUNDED === "derive" ? sum([...d.refunds, paid]) : d.refunded }));
    const saved = await patch(r, { status: "refunded" });
    desk.update((d) => ({ ...d, rows: place(d.rows, d.tab, saved), notice: `Refunded $${amount} to ${r.customer} for ${r.rma}.` }));
  } catch (e) {
    desk.update((d) => ({ ...d, error: `The refund for ${r.rma} failed (${code(e)}).` }));
  } finally {
    pend(r.id, false);
  }
}

function go(patchUi: { tab?: string; page?: number }) {
  desk.update((d) => ({ ...d, ...patchUi, notice: "" }));
  void loadTab();
}

const App = {
  view() {
    const d = desk.get();
    const s = scan.get();
    const pages = Math.max(1, Math.ceil(d.total / PER));
    return m("main.returns", [
      m("h1", "Returns desk"),
      m("p.refunded", `Refunded today: $${d.refunded}`),
      m("form.scan", { onsubmit: (e: Event) => void lookup(e) }, [
        m("input[name=scan][placeholder=Scan or type RMA code]", { value: s.code, oninput: (e: Event) => scan.update((x) => ({ ...x, code: (e.target as HTMLInputElement).value.toUpperCase(), match: null })) }),
        m("button[type=submit]", s.looking ? "Looking up…" : "Look up"),
      ]),
      s.match ? m("p.match", `${s.match.rma} · ${s.match.customer} · ${s.match.item} · ${s.match.status}`) : null,
      d.error ? m("p[role=alert]", d.error) : d.notice ? m("p.notice", d.notice) : null,
      m("nav.tabs", TABS.map((t) => m("button[type=button]", { class: d.tab === t ? "current" : "", onclick: () => go({ tab: t, page: 1 }) }, t[0]!.toUpperCase() + t.slice(1)))),
      d.loading ? m("p.muted", "Loading…") : null,
      m("table", m("tbody", d.rows.map((r) => m("tr.rma", { key: r.id }, [
        m("td", r.rma), m("td", r.customer), m("td", `${r.item} ($${r.price})`), m("td", r.reason),
        m("td", r.status === "awaiting"
          ? m("button.receive[type=button]", { disabled: d.pending.includes(r.id), onclick: () => void update(r, { status: "received" }, (x) => `${x.rma} received.`) }, "Receive")
          : r.status === "received"
            ? m("select.condition", { disabled: d.pending.includes(r.id), onchange: (e: Event) => void update(r, { condition: (e.target as HTMLSelectElement).value, status: "inspected" }, (x) => `${x.rma} graded ${x.condition}.`) }, [m("option", { value: "" }, "Condition…"), ...Object.keys(RATE).map((c) => m("option", { value: c }, c))])
            : r.status === "inspected"
              ? m("button.refund[type=button]", { disabled: REFUND_GUARD && d.pending.includes(r.id), onclick: () => void refund(r) }, `Refund $${amountOf(r)}`)
              : `${r.status} (${r.condition || "n/a"})`),
      ])))),
      m("nav.pages", Array.from({ length: pages }, (_, i) => m("button[type=button]", { class: d.page === i + 1 ? "current" : "", onclick: () => go({ page: i + 1 }) }, String(i + 1)))),
    ]);
  },
};
m.mount(document.getElementById("app")!, App);
void loadTab();
void m.request<{ data: Refund[] }>({ url: "/api/refunds", params: { limit: 50 }, background: true }).then((b) => desk.update((d) => ({ ...d, refunds: b?.data ?? [], refunded: sum(b?.data ?? []) })), () => undefined);
setInterval(() => !desk.get().loading && !desk.get().pending.length && void loadTab(), 7000);
