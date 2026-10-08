// Webhook delivery log for a payments platform (Hyperapp 2 actions/effects/subscriptions; fetch; app state is
// Hyperapp's own, nothing registered with GenClass: observe-only). Deliveries page by 8 with status/endpoint filters;
// a failed delivery can be redelivered (POST /deliveries/:id/redeliver: relative, counts attempts) or all failed ones
// on the page at once (POST /deliveries/bulk, per-item results). A delivery worker settles pending ones, so the page
// polls. Latent bugs by flag: page answers applied in arrival order (pageSeq=blind: the page you left comes back),
// redeliver buttons live while the request posts (redeliverGuard=none: two attempts), redeliveries automatically
// retried after a 5xx (redeliverRetry=auto-retry: a redelivery that went through before the error is sent twice),
// bulk results ignored (bulkResult=assume-all: rows that failed to queue show "pending") and polls on a plain
// interval (poll=interval: slow polls overlap and land out of order).
import { app, h, text } from "hyperapp";
import { flag } from "../_shared/genclass";
import { api, errText, HttpError } from "../_shared/w3-http";

type Delivery = { id: number; endpoint: string; event: string; status: string; code: number; attempts: number; at: string };
type S = { status: string; endpoint: string; page: number; rows: Delivery[]; count: number; loading: boolean; busy: number[]; bulkBusy: boolean; error: string; notice: string };
type Page = { results: Delivery[]; count: number };
const PAGE_SEQ = flag("pageSeq", "latest");
const REDELIVER_GUARD = flag("redeliverGuard", "pending") === "pending";
const REDELIVER_RETRY = flag("redeliverRetry", "none");
const BULK_RESULT = flag("bulkResult", "per-item");
const POLL = flag("poll", "chain");
const PER = 8;
const ENDPOINTS = ["https://hooks.acme.io/billing", "https://erp.example.com/ingest", "https://slack-relay.dev/notify"];
const host = (u: string) => u.replace(/^https:\/\//, "").split("/")[0];
const keyOf = (s: S) => `${s.status}|${s.endpoint}|${s.page}`;

// ------------------------------------------------------------------------------------------- effects
let seqN = 0;
let polling = false;
const fetchPage = (dispatch: (a: unknown, p?: unknown) => void, p: { url: string; seq: number; background: boolean; key: string }) => {
  if (p.background) polling = true;
  api<Page>(p.url)
    .then((body) => dispatch(GotPage, { body, ...p }))
    .catch((e) => dispatch(PageFailed, { e, ...p }))
    .finally(() => {
      if (p.background) polling = false;
    });
};
const redeliverFx = (dispatch: (a: unknown, p?: unknown) => void, d: Delivery) => {
  const send = () => api<Delivery>(`/api/deliveries/${d.id}/redeliver`, "POST");
  send()
    .catch((e) => (REDELIVER_RETRY === "auto-retry" && (!(e instanceof HttpError) || e.status >= 500) ? send() : Promise.reject(e)))
    .then((saved) => dispatch(Redelivered, saved), (e) => dispatch(RedeliverFailed, { d, e }));
};
const bulkFx = (dispatch: (a: unknown, p?: unknown) => void, ids: number[]) => {
  api<{ results: { id: number; ok: boolean }[] }>(`/api/deliveries/bulk`, "POST", { ids, op: "patch", patch: { status: "pending" } })
    .then((r) => dispatch(BulkDone, { ids, results: r.results ?? [] }), (e) => dispatch(BulkFailed, { ids, e }));
};

// ------------------------------------------------------------------------------------------- actions
const urlOf = (s: S) => `/api/deliveries?page=${s.page}&limit=${PER}${s.status === "all" ? "" : `&status=${s.status}`}${s.endpoint === "all" ? "" : `&endpoint=${encodeURIComponent(s.endpoint)}`}`;
const Load = (s: S) => [{ ...s, loading: true, error: "" }, [fetchPage, { url: urlOf(s), seq: ++seqN, background: false, key: keyOf(s) }]];
const Poll = (s: S) => (s.loading || (POLL === "chain" && polling) ? s : [s, [fetchPage, { url: urlOf(s), seq: seqN, background: true, key: keyOf(s) }]]);
const GotPage = (s: S, p: { body: Page; seq: number; background: boolean; key: string }) => {
  if ((p.background || PAGE_SEQ === "latest") && p.seq !== seqN) return s;
  if (p.background && p.key !== keyOf(s)) return s;
  const rows = (p.body.results ?? []).map((r) => (s.busy.includes(r.id) ? (s.rows.find((x) => x.id === r.id) ?? r) : r));
  return { ...s, rows, count: Number(p.body.count ?? rows.length), loading: p.background ? s.loading : false };
};
const PageFailed = (s: S, p: { e: unknown; seq: number; background: boolean }) => (p.background || p.seq !== seqN ? s : { ...s, loading: false, error: errText(p.e, "loading deliveries") });
const Filter = (s: S, patch: Partial<S>) => Load({ ...s, ...patch, page: 1, notice: "" });
const GoPage = (s: S, page: number) => Load({ ...s, page });
const Redeliver = (s: S, d: Delivery) => (REDELIVER_GUARD && s.busy.includes(d.id) ? s : [{ ...s, busy: [...s.busy, d.id], error: "", notice: "" }, [redeliverFx, d]]);
const Redelivered = (s: S, saved: Delivery) => ({ ...s, rows: s.rows.map((r) => (r.id === saved.id ? saved : r)), busy: s.busy.filter((x) => x !== saved.id), notice: `Redelivering ${saved.event} to ${host(saved.endpoint)} (attempt ${saved.attempts}).` });
const RedeliverFailed = (s: S, p: { d: Delivery; e: unknown }) => ({ ...s, busy: s.busy.filter((x) => x !== p.d.id), error: errText(p.e, `redelivering ${p.d.event}`) });
const RedeliverAll = (s: S) => {
  const ids = s.rows.filter((r) => r.status === "failed" && !s.busy.includes(r.id)).map((r) => r.id);
  if (!ids.length || s.bulkBusy) return s;
  return [{ ...s, bulkBusy: true, busy: [...s.busy, ...ids], error: "", notice: "" }, [bulkFx, ids]];
};
const BulkDone = (s: S, p: { ids: number[]; results: { id: number; ok: boolean }[] }) => {
  const ok = new Set(BULK_RESULT === "per-item" ? p.results.filter((r) => r.ok).map((r) => Number(r.id)) : p.ids);
  const failed = p.ids.length - p.results.filter((r) => r.ok).length;
  return {
    ...s,
    rows: s.rows.map((r) => (ok.has(r.id) ? { ...r, status: "pending" } : r)),
    busy: s.busy.filter((x) => !p.ids.includes(x)),
    bulkBusy: false,
    notice: `Queued ${ok.size} redeliver${ok.size === 1 ? "y" : "ies"}.`,
    error: BULK_RESULT === "per-item" && failed ? `${failed} deliver${failed === 1 ? "y" : "ies"} could not be queued.` : "",
  };
};
const BulkFailed = (s: S, p: { ids: number[]; e: unknown }) => ({ ...s, busy: s.busy.filter((x) => !p.ids.includes(x)), bulkBusy: false, error: errText(p.e, "redelivering the failed events") });

// one subscriber function for every interval (module level): Hyperapp compares subscribers by identity, so a
// function created per render would restart the interval on every state change
const intervalSub = (dispatch: (a: unknown) => void, p: { ms: number; action: unknown }) => {
  const iv = setInterval(() => dispatch(p.action), p.ms);
  return () => clearInterval(iv);
};
const every = (ms: number, action: unknown) => [intervalSub, { ms, action }];

// ------------------------------------------------------------------------------------------- view
const label = (d: Delivery) => (d.status === "succeeded" ? `✓ ${d.code}` : d.status === "pending" ? "pending…" : `✗ ${d.code || "timeout"}`);
const view = (s: S) => {
  const pages = Math.max(1, Math.ceil(s.count / PER));
  return h("main", { class: "webhooks" }, [
    h("h1", {}, text("Webhook deliveries")),
    h("nav", { class: "tabs" }, ["all", "failed", "succeeded"].map((st) => h("button", { type: "button", class: s.status === st ? "current" : "", onclick: [Filter, { status: st }] }, text(st === "all" ? "All" : st === "failed" ? "Failed" : "Succeeded")))),
    h("label", {}, [text("Endpoint "), h("select", { name: "endpoint", onchange: (st: S, ev: Event) => Filter(st, { endpoint: (ev.target as HTMLSelectElement).value }) }, [h("option", { value: "all", selected: s.endpoint === "all" }, text("All endpoints")), ...ENDPOINTS.map((e) => h("option", { value: e, selected: s.endpoint === e }, text(host(e))))])]),
    h("button", { type: "button", class: "redeliver-all", disabled: s.bulkBusy || !s.rows.some((r) => r.status === "failed"), onclick: RedeliverAll }, text(s.bulkBusy ? "Queuing…" : "Redeliver failed on this page")),
    s.error ? h("p", { role: "alert" }, text(s.error)) : s.notice ? h("p", { class: "notice" }, text(s.notice)) : text(""),
    s.loading ? h("p", { class: "muted" }, text("Loading…")) : text(""),
    h(
      "table",
      {},
      h(
        "tbody",
        {},
        s.rows.map((d) =>
          h("tr", { class: `delivery ${d.status}`, key: d.id }, [
            h("td", {}, text(d.event)),
            h("td", {}, text(host(d.endpoint))),
            h("td", {}, text(label(d))),
            h("td", {}, text(`${d.attempts} attempt${d.attempts === 1 ? "" : "s"}`)),
            h("td", {}, d.status === "failed" ? h("button", { type: "button", class: "redeliver", disabled: REDELIVER_GUARD && s.busy.includes(d.id), onclick: [Redeliver, d] }, text("Redeliver")) : text("")),
          ]),
        ),
      ),
    ),
    h("nav", { class: "pages" }, Array.from({ length: pages }, (_, i) => h("button", { type: "button", class: s.page === i + 1 ? "current" : "", onclick: [GoPage, i + 1] }, text(String(i + 1))))),
  ]);
};

const init: S = { status: "all", endpoint: "all", page: 1, rows: [], count: 0, loading: true, busy: [], bulkBusy: false, error: "", notice: "" };
app<S>({
  init: Load(init) as never,
  view,
  node: document.getElementById("app")!,
  subscriptions: () => [every(4000, Poll)],
} as never);
