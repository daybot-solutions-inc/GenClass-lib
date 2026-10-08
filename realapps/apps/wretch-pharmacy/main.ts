// Prescription refills for a pharmacy chain's patient portal (plain TypeScript DOM code + wretch with middlewares;
// state in runtime atoms). A refill is two writes: the relative POST /prescriptions/:id/refill (uses one refill) and
// the history record. Latent bugs by flag: the wretch retry middleware applied to every method (retry=all) with the
// Idempotency-Key middleware placed inside the retry so each attempt gets a fresh key (idemKey=inside-retry) or no
// key at all (idemKey=none) — a refill that committed before the 5xx is taken twice; stock checks for the chosen
// pharmacy applied in arrival order (stockGuard=none: the previous pharmacy's stock is shown); a Confirm button that
// stays enabled while submitting (confirmGuard=none); and the "refills this year" counter kept by hand
// (countMode=incremental).
import wretch from "wretch";
import { retry } from "wretch/middlewares";
import { rt, flag } from "../_shared/genclass";

type Rx = { id: number; drug: string; label: string; qty: number; refillsLeft: number; autoRefill: boolean; prescriber: string; status: string };
type Stock = { id: number; drug: string; store: string; onHand: number };
type Refill = { id: number; rxId: number; drug: string; store: string; qty: number; createdAt?: string };

const RETRY = flag("retry", "reads-only") as "reads-only" | "all";
const IDEM = flag("idemKey", "outside-retry") as "outside-retry" | "inside-retry" | "none";
const STOCK_GUARD = flag("stockGuard", "abort") as "abort" | "none";
const CONFIRM_GUARD = flag("confirmGuard", "disable") as "disable" | "none";
const COUNT = flag("countMode", "derived") as "derived" | "incremental";

const STORES: Record<string, string> = { main: "Main St", north: "Northgate Mall", airport: "Airport Rd (24h)" };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const rx = rt.atom("rx", { items: [] as Rx[], loading: true, error: "" });
const refill = rt.atom("refill", { rxId: 0, store: "main", stock: null as null | number, checking: false, submitting: false, error: "", done: "" });
const history = rt.atom("history", { items: [] as Refill[], count: 0, loading: true });

// --------------------------------------------------------------------------------------------- client
type Mw = (next: (url: string, opts: any) => Promise<Response>) => (url: string, opts: any) => Promise<Response>;
/** Stamps an Idempotency-Key on writes that do not carry one. */
const idempotency: Mw = (next) => (url, opts) => {
  const method = String(opts.method ?? "GET").toUpperCase();
  if (method === "GET" || opts.headers?.["Idempotency-Key"]) return next(url, opts);
  return next(url, { ...opts, headers: { ...opts.headers, "Idempotency-Key": crypto.randomUUID() } });
};
const retrying = retry({
  delayTimer: 400,
  maxAttempts: 2,
  retryOnNetworkError: true,
  until: (res, err) => (err as Error | undefined)?.name === "AbortError" || (!!res && (res.ok || (res.status < 500 && res.status !== 429))),
  ...(RETRY === "reads-only" ? { skip: (_u: string, o: any) => String(o.method ?? "GET").toUpperCase() !== "GET" } : {}),
}) as unknown as Mw;
const chain = IDEM === "outside-retry" ? [idempotency, retrying] : IDEM === "inside-retry" ? [retrying, idempotency] : [retrying];
const api = wretch("/api").headers({ Accept: "application/json" }).middlewares(chain as any);

const status = (e: unknown) => (e as { status?: number })?.status ?? 0;

// --------------------------------------------------------------------------------------- prescriptions
async function loadRx() {
  try {
    const items = await api.get("/prescriptions").json<Rx[]>();
    rx.update((s) => ({ ...s, items, loading: false, error: "" }));
  } catch {
    rx.update((s) => ({ ...s, loading: false, error: "Your prescriptions could not be loaded." }));
  }
}

async function toggleAuto(id: number) {
  const cur = rx.get().items.find((r) => r.id === id);
  if (!cur) return;
  const next = !cur.autoRefill;
  const set = (v: boolean) => rx.update((s) => ({ ...s, items: s.items.map((r) => (r.id === id ? { ...r, autoRefill: v } : r)) }));
  set(next);
  try {
    const saved = await api.url(`/prescriptions/${id}`).patch({ autoRefill: next }).json<Rx>();
    rx.update((s) => ({ ...s, items: s.items.map((r) => (r.id === id ? { ...r, ...saved } : r)) }));
  } catch {
    set(cur.autoRefill);
    rx.update((s) => ({ ...s, error: "Auto-refill could not be changed right now." }));
  }
}

// ----------------------------------------------------------------------------------------------- stock
let stockCtl: AbortController | null = null;
async function checkStock() {
  const r = refill.get();
  const item = rx.get().items.find((x) => x.id === r.rxId);
  if (!item) return;
  if (STOCK_GUARD === "abort") stockCtl?.abort();
  const ctl = new AbortController();
  stockCtl = ctl;
  refill.update((s) => ({ ...s, checking: true, stock: null, error: "" }));
  try {
    const rows = await api.options({ signal: ctl.signal }).get(`/inventory?drug=${encodeURIComponent(item.drug)}&store=${r.store}`).json<Stock[]>();
    refill.update((s) => ({ ...s, checking: false, stock: rows.reduce((n, x) => n + Number(x.onHand ?? 0), 0) }));
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return;
    refill.update((s) => ({ ...s, checking: false, error: "We couldn't check stock at this pharmacy." }));
  }
}

function openRefill(id: number) {
  refill.set({ rxId: id, store: refill.get().store, stock: null, checking: false, submitting: false, error: "", done: "" });
  void checkStock();
}

function chooseStore(store: string) {
  refill.update((s) => ({ ...s, store, done: "" }));
  void checkStock();
}

async function confirmRefill() {
  const r = refill.get();
  const item = rx.get().items.find((x) => x.id === r.rxId);
  if (!item || item.refillsLeft <= 0) return;
  if (CONFIRM_GUARD === "disable" && r.submitting) return;
  refill.update((s) => ({ ...s, submitting: true, error: "", done: "" }));
  try {
    const saved = await api.url(`/prescriptions/${item.id}/refill`).post({}).json<Rx>();
    rx.update((s) => ({ ...s, items: s.items.map((x) => (x.id === item.id ? { ...x, ...saved } : x)) }));
    if (COUNT === "incremental") history.update((h) => ({ ...h, count: h.count + 1 }));
    const rec = await api.url("/refills").post({ rxId: item.id, drug: item.drug, store: r.store, qty: item.qty }).json<Refill>();
    history.update((h) => {
      const items = [rec, ...h.items];
      return { ...h, items, count: COUNT === "derived" ? items.length : h.count };
    });
    refill.update((s) => ({ ...s, submitting: false, done: `Refill requested — ${item.label} will be ready at ${STORES[r.store]}${(r.stock ?? 0) > 0 ? " today" : " in 2 days"}.` }));
  } catch (e) {
    const st = status(e);
    refill.update((s) => ({ ...s, submitting: false, error: st === 409 || st === 422 ? "This prescription can't be refilled online. Please call the pharmacy." : "The refill request did not go through. Please try again." }));
  }
}

// --------------------------------------------------------------------------------------------- history
let counted = false; // incremental mode: the counter is seeded from the first load only
async function loadHistory() {
  history.update((h) => ({ ...h, loading: true }));
  try {
    const items = await api.get("/refills?sort=-createdAt").json<Refill[]>();
    const seed = !counted;
    counted = true;
    history.update((h) => ({ ...h, items, loading: false, count: COUNT === "derived" || seed ? items.length : h.count }));
  } catch {
    history.update((h) => ({ ...h, loading: false }));
  }
}

// ---------------------------------------------------------------------------------------------- render
const root = document.getElementById("app")!;
root.innerHTML = `
  <header><h1>CareWell Pharmacy</h1><p class="who">Signed in as Jordan Ellis · DOB on file</p></header>
  <div class="rx-error"></div>
  <section class="prescriptions"><h2>My prescriptions</h2><ul class="rx-list"></ul></section>
  <section class="refill-slot"></section>
  <section class="history"><h2>Refill history · <span class="count">0</span> this year</h2><button type="button" class="reload-history">Refresh</button><ol class="history-list"></ol></section>`;
const $ = <T extends Element = HTMLElement>(s: string) => root.querySelector(s) as T;

function renderRx() {
  const s = rx.get();
  $(".rx-error").innerHTML = s.error ? `<p role="alert">${esc(s.error)}</p>` : "";
  $(".rx-list").innerHTML = s.loading
    ? `<li class="muted">Loading…</li>`
    : s.items
        .map(
          (r) => `<li class="rx" data-id="${r.id}"><strong>${esc(r.label)}</strong> · ${r.qty} tablets · ${esc(r.prescriber)} · <span class="left">${r.refillsLeft} refill(s) left</span>${r.status !== "active" ? ` · <em>${esc(r.status)}</em>` : ""}
            <button type="button" class="request-refill"${r.refillsLeft <= 0 ? " disabled" : ""}>Request refill</button>
            <button type="button" class="auto-refill">${r.autoRefill ? "Auto-refill: on" : "Auto-refill: off"}</button></li>`,
        )
        .join("");
}

function renderRefill() {
  const r = refill.get();
  const item = rx.get().items.find((x) => x.id === r.rxId);
  const slot = $(".refill-slot");
  if (!item) {
    slot.innerHTML = "";
    return;
  }
  if (!slot.querySelector(".refill-panel")) {
    slot.innerHTML = `<div class="refill-panel"><h2>Refill <span class="drug"></span></h2>
      <label>Pick up at <select name="store">${Object.entries(STORES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
      <p class="stock"></p><button type="button" class="confirm-refill">Confirm refill</button> <button type="button" class="cancel-refill">Cancel</button><div class="refill-msg"></div></div>`;
  }
  slot.querySelector(".drug")!.textContent = item.label;
  const sel = slot.querySelector<HTMLSelectElement>("select[name=store]")!;
  if (sel.value !== r.store) sel.value = r.store;
  slot.querySelector(".stock")!.textContent = r.checking ? "Checking stock…" : r.stock === null ? "" : r.stock > 0 ? `In stock at ${STORES[r.store]} (${r.stock} on hand)` : `Out of stock at ${STORES[r.store]} — usually ready in 2 days`;
  const btn = slot.querySelector<HTMLButtonElement>("button.confirm-refill")!;
  btn.disabled = (CONFIRM_GUARD === "disable" && r.submitting) || item.refillsLeft <= 0;
  btn.textContent = r.submitting ? "Submitting…" : "Confirm refill";
  slot.querySelector(".refill-msg")!.innerHTML = r.error ? `<p role="alert">${esc(r.error)}</p>` : r.done ? `<p class="ok">${esc(r.done)}</p>` : "";
}

function renderHistory() {
  const h = history.get();
  $(".count").textContent = String(h.count);
  $(".history-list").innerHTML = h.items.length ? h.items.map((x) => `<li>${esc(x.drug)} · ${x.qty} tablets · ${esc(STORES[x.store] ?? x.store)}</li>`).join("") : `<li class="muted">${h.loading ? "Loading…" : "No refills yet this year."}</li>`;
}

rx.subscribe(() => {
  renderRx();
  renderRefill();
});
refill.subscribe(renderRefill);
history.subscribe(renderHistory);

root.addEventListener("click", (e) => {
  const btn = (e.target as Element).closest("button");
  if (!btn) return;
  const id = Number(btn.closest<HTMLElement>("li.rx")?.dataset.id);
  if (btn.classList.contains("request-refill")) openRefill(id);
  else if (btn.classList.contains("auto-refill")) void toggleAuto(id);
  else if (btn.classList.contains("confirm-refill")) void confirmRefill();
  else if (btn.classList.contains("cancel-refill")) refill.update((s) => ({ ...s, rxId: 0 }));
  else if (btn.classList.contains("reload-history")) void loadHistory();
});
root.addEventListener("change", (e) => {
  const t = e.target as HTMLSelectElement;
  if (t.name === "store") chooseStore(t.value);
});

renderRx();
renderHistory();
void loadRx();
void loadHistory();
