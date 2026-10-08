// Self-order kiosk for a burger restaurant (plain TypeScript DOM code + fetch; state in runtime atoms). Menu by
// category, a modifier dialog (size, extras), a cart with promo codes, and "Place order" with a gateway timeout.
// Latent bugs by flag: cart totals maintained incrementally (totals=incremental: quantity buttons add the menu price
// instead of the configured line price, and the promo discount is frozen at the moment the code was applied),
// a timed-out order retried through the generic JSON helper without its Idempotency-Key (orderRetry=no-key: two
// orders when the first had reached the kitchen), a short order timeout (orderTimeoutMs), a "Place order" button
// that stays enabled while submitting (submitGuard=false) and promo checks applied in arrival order
// (promoGuard=none: an older code's answer replaces the newer one).
import { rt, flag } from "../_shared/genclass";

type Size = { id: string; label: string; delta: number };
type Extra = { id: string; label: string; price: number };
type Item = { id: number; category: string; name: string; price: number; soldOut: boolean; sizes?: Size[]; extras?: Extra[] };
type Line = { key: string; itemId: number; name: string; size: string; extras: string[]; unit: number; qty: number };
type Promo = { code: string; percent: number; minSpend: number };

const TOTALS = flag("totals", "derived") as "derived" | "incremental";
const ORDER_RETRY = flag("orderRetry", "same-key") as "same-key" | "no-key" | "off";
const ORDER_TIMEOUT = Number(flag("orderTimeoutMs", 6000));
const SUBMIT_GUARD = Boolean(flag("submitGuard", true));
const PROMO_GUARD = flag("promoGuard", "latest") as "latest" | "none";
const TAX = 0.08875;

const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${n.toFixed(2)}`;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const menu = rt.atom("menu", { category: "all", items: [] as Item[], loading: true, error: "", notice: "" });
const cart = rt.atom("cart", { lines: [] as Line[], count: 0, subtotal: 0, discount: 0, tax: 0, total: 0, promo: null as Promo | null, promoMsg: "", checking: false });
const order = rt.atom("order", { placing: false, number: 0, error: "" });
const modal = rt.atom("modal", { itemId: 0, size: "", extras: [] as string[] });

// ------------------------------------------------------------------------------------------------- totals
const discountOf = (subtotal: number, p: Promo | null) => (p && subtotal >= p.minSpend ? r2((subtotal * p.percent) / 100) : 0);
function derive(c: ReturnType<typeof cart.get>) {
  const subtotal = r2(c.lines.reduce((s, l) => s + l.unit * l.qty, 0));
  const discount = discountOf(subtotal, c.promo);
  const tax = r2((subtotal - discount) * TAX);
  return { ...c, subtotal, discount, tax, total: r2(subtotal - discount + tax), count: c.lines.reduce((n, l) => n + l.qty, 0) };
}
/** incremental bookkeeping: adjust the running subtotal by `delta`, keep the discount from when the code was applied */
function bump(c: ReturnType<typeof cart.get>, delta: number, dq: number) {
  const subtotal = r2(c.subtotal + delta);
  const tax = r2((subtotal - c.discount) * TAX);
  return { ...c, subtotal, tax, total: r2(subtotal - c.discount + tax), count: c.count + dq };
}

function addLine(item: Item, size: string, extras: string[]) {
  const sz = item.sizes?.find((s) => s.id === size);
  const ex = (item.extras ?? []).filter((e) => extras.includes(e.id));
  const unit = r2(item.price + (sz?.delta ?? 0) + ex.reduce((s, e) => s + e.price, 0));
  const key = [item.id, sz?.id ?? "", ...ex.map((e) => e.id).sort()].join("|");
  const name = `${sz && item.sizes!.length > 1 ? `${sz.label} ` : ""}${item.name}${ex.length ? ` + ${ex.map((e) => e.label).join(", ")}` : ""}`;
  cart.update((c) => {
    const has = c.lines.some((l) => l.key === key);
    const lines = has ? c.lines.map((l) => (l.key === key ? { ...l, qty: l.qty + 1 } : l)) : [...c.lines, { key, itemId: item.id, name, size: sz?.id ?? "", extras: ex.map((e) => e.id), unit, qty: 1 }];
    return TOTALS === "derived" ? derive({ ...c, lines }) : bump({ ...c, lines }, unit, 1);
  });
}

function changeQty(key: string, dq: number) {
  const line = cart.get().lines.find((l) => l.key === key);
  if (!line) return;
  const qty = Math.max(0, line.qty + dq);
  const base = menu.get().items.find((i) => i.id === line.itemId)?.price ?? line.unit;
  cart.update((c) => {
    const lines = qty ? c.lines.map((l) => (l.key === key ? { ...l, qty } : l)) : c.lines.filter((l) => l.key !== key);
    if (TOTALS === "derived") return derive({ ...c, lines });
    // the +/− buttons were written before sizes and extras existed
    return bump({ ...c, lines }, qty ? base * (qty - line.qty) : -line.unit * line.qty, qty - line.qty);
  });
}

/** Re-check price and availability with the kitchen before the line goes into the order. */
async function confirmAdd(itemId: number, size: string, extras: string[]) {
  const local = menu.get().items.find((i) => i.id === itemId);
  if (!local) return;
  try {
    const r = await fetch(`/api/menu/${itemId}`);
    if (!r.ok) throw new Error(String(r.status));
    const fresh = (await r.json()) as Item;
    menu.update((m) => ({ ...m, items: m.items.map((i) => (i.id === itemId ? { ...i, ...fresh } : i)) }));
    if (fresh.soldOut) {
      menu.update((m) => ({ ...m, notice: `Sorry, ${fresh.name} just sold out.` }));
      return;
    }
    addLine({ ...local, ...fresh }, size, extras);
  } catch {
    addLine(local, size, extras); // the kitchen is slow to answer: trust the menu we have
  }
}

// -------------------------------------------------------------------------------------------------- promo
let promoSeq = 0;
async function applyPromo(code: string) {
  const mine = ++promoSeq;
  const c = code.trim().toUpperCase();
  if (!c) return;
  cart.update((x) => ({ ...x, checking: true, promoMsg: "" }));
  try {
    const r = await fetch(`/api/promos?code=${encodeURIComponent(c)}`);
    if (!r.ok) throw new Error(String(r.status));
    const found = ((await r.json()) as Promo[])[0];
    if (PROMO_GUARD === "latest" && mine !== promoSeq) return;
    cart.update((x) => {
      if (!found) return { ...x, checking: false, promo: null, promoMsg: `"${c}" is not a valid code.` };
      const next = { ...x, checking: false, promo: found, promoMsg: `${found.code}: ${found.percent}% off orders over ${money(found.minSpend)}.` };
      if (TOTALS === "derived") return derive(next);
      const discount = discountOf(x.subtotal, found);
      const tax = r2((x.subtotal - discount) * TAX);
      return { ...next, discount, tax, total: r2(x.subtotal - discount + tax) };
    });
  } catch {
    if (PROMO_GUARD === "latest" && mine !== promoSeq) return;
    cart.update((x) => ({ ...x, checking: false, promoMsg: "Promo codes can't be checked right now." }));
  }
}

// -------------------------------------------------------------------------------------------------- order
function postJSON(url: string, body: unknown) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function placeOrder() {
  const c = cart.get();
  if (!c.lines.length || (SUBMIT_GUARD && order.get().placing)) return;
  const body = { lines: c.lines.map(({ itemId, size, extras, qty, unit }) => ({ itemId, size, extras, qty, unit })), promo: c.promo?.code ?? null, total: c.total, status: "received", pickup: "counter" };
  const key = crypto.randomUUID();
  const send = () => fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body), signal: AbortSignal.timeout(ORDER_TIMEOUT) });
  order.set({ placing: true, number: 0, error: "" });
  try {
    let r: Response;
    try {
      r = await send();
    } catch (e) {
      if ((e as Error).name !== "TimeoutError" || ORDER_RETRY === "off") throw e;
      r = ORDER_RETRY === "same-key" ? await send() : await postJSON("/api/orders", body);
    }
    if (!r.ok) throw new Error(String(r.status));
    const saved = (await r.json()) as { id: number };
    order.set({ placing: false, number: saved.id, error: "" });
    void loadBoard();
  } catch (e) {
    const timeout = (e as Error).name === "TimeoutError";
    order.set({ placing: false, number: 0, error: timeout ? "The kitchen isn't answering. Please ask a team member before trying again." : "Your order could not be sent. Please try again." });
  }
}

function newOrder() {
  cart.set({ lines: [], count: 0, subtotal: 0, discount: 0, tax: 0, total: 0, promo: null, promoMsg: "", checking: false });
  order.set({ placing: false, number: 0, error: "" });
  promoInput.value = "";
}

// -------------------------------------------------------------------------------------------------- loads
let menuBusy = false;
async function loadMenu() {
  if (menuBusy) return;
  menuBusy = true;
  try {
    const r = await fetch("/api/menu");
    if (!r.ok) throw new Error(String(r.status));
    const items = (await r.json()) as Item[];
    menu.update((m) => ({ ...m, items, loading: false, error: "" }));
  } catch {
    menu.update((m) => ({ ...m, loading: false, error: m.items.length ? "" : "The menu is unavailable. Please order at the counter." }));
  } finally {
    menuBusy = false;
  }
}

let boardBusy = false;
async function loadBoard() {
  if (boardBusy) return;
  boardBusy = true;
  try {
    const r = await fetch("/api/orders?sort=-createdAt&limit=5");
    if (!r.ok) return;
    const list = (await r.json()) as { id: number; status: string }[];
    root.querySelector(".board ol")!.innerHTML = list.map((o) => `<li>#${o.id} · ${esc(o.status)}</li>`).join("") || `<li>No orders yet.</li>`;
  } catch {
    /* the board is decoration */
  } finally {
    boardBusy = false;
  }
}

// ------------------------------------------------------------------------------------------------- render
const root = document.getElementById("app")!;
root.innerHTML = `
  <header><h1>Patty Shack — Order here</h1></header>
  <nav class="tabs">${["all", "burgers", "sides", "drinks", "desserts"].map((c) => `<button type="button" class="tab" data-cat="${c}">${c === "all" ? "Full menu" : c[0]!.toUpperCase() + c.slice(1)}</button>`).join("")}</nav>
  <div class="menu-error"></div><ul class="menu"></ul>
  <div class="modal" role="dialog"></div>
  <aside class="cart"><h2>Your order (<span class="count">0</span>)</h2><ul class="lines"></ul>
    <form class="promo-form"><input name="promo" placeholder="Promo code" autocomplete="off"> <button type="submit" class="apply-promo">Apply</button></form><p class="promo-msg"></p>
    <dl class="totals"></dl><button type="button" class="place-order">Place order</button><div class="order-msg"></div></aside>
  <section class="board"><h2>Now preparing</h2><ol></ol></section>`;
const promoInput = root.querySelector<HTMLInputElement>("input[name=promo]")!;

function renderMenu() {
  const m = menu.get();
  root.querySelectorAll<HTMLElement>("button.tab").forEach((b) => b.classList.toggle("active", b.dataset.cat === m.category));
  root.querySelector(".menu-error")!.innerHTML = m.error ? `<p role="alert">${esc(m.error)}</p>` : m.notice ? `<p class="notice">${esc(m.notice)}</p>` : "";
  root.querySelector(".menu")!.innerHTML = m.loading
    ? `<li>Loading menu…</li>`
    : m.items.filter((i) => m.category === "all" || i.category === m.category).map((i) => `<li class="menu-item ${i.sizes?.length ? "sized" : i.extras?.length ? "extras" : "simple"}" data-id="${i.id}"><strong>${esc(i.name)}</strong> ${money(i.price)} ${i.soldOut ? `<em>Sold out</em>` : `<button type="button" class="add">Add</button>`}</li>`).join("");
}

function renderModal() {
  const md = modal.get();
  const el = root.querySelector<HTMLElement>(".modal")!;
  const item = menu.get().items.find((i) => i.id === md.itemId);
  el.classList.toggle("open", !!item);
  if (!item) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `<h2>${esc(item.name)}</h2>
    ${item.sizes?.length ? `<label>Size <select name="size">${item.sizes.map((s) => `<option value="${s.id}"${s.id === md.size ? " selected" : ""}>${esc(s.label)}${s.delta ? ` (+${money(s.delta)})` : ""}</option>`).join("")}</select></label>` : ""}
    ${(item.extras ?? []).map((e) => `<label><input type="checkbox" class="extra" value="${e.id}"${md.extras.includes(e.id) ? " checked" : ""}> ${esc(e.label)} +${money(e.price)}</label>`).join(" ")}
    <p><button type="button" class="confirm-add">Add to order</button> <button type="button" class="cancel">Cancel</button></p>`;
}

function renderCart() {
  const c = cart.get();
  const o = order.get();
  root.querySelector(".count")!.textContent = String(c.count);
  root.querySelector(".lines")!.innerHTML = c.lines.map((l) => `<li class="cart-line" data-key="${esc(l.key)}">${esc(l.name)} × ${l.qty} ${money(r2(l.unit * l.qty))} <button type="button" class="dec">−</button><button type="button" class="inc">+</button> <button type="button" class="remove">Remove</button></li>`).join("") || `<li class="muted">Your order is empty.</li>`;
  root.querySelector(".promo-msg")!.textContent = c.checking ? "Checking code…" : c.promoMsg;
  root.querySelector(".totals")!.innerHTML = `<dt>Subtotal</dt><dd>${money(c.subtotal)}</dd>${c.discount ? `<dt>Promo</dt><dd>−${money(c.discount)}</dd>` : ""}<dt>Tax</dt><dd>${money(c.tax)}</dd><dt>Total</dt><dd class="total">${money(c.total)}</dd>`;
  const btn = root.querySelector<HTMLButtonElement>(".place-order")!;
  btn.disabled = !c.lines.length || (SUBMIT_GUARD && o.placing) || o.number > 0;
  btn.textContent = o.placing ? "Sending to kitchen…" : "Place order";
  root.querySelector(".order-msg")!.innerHTML = o.error
    ? `<p role="alert">${esc(o.error)}</p>`
    : o.number
      ? `<div class="confirmation"><p>Thank you! Your order number is <strong>${o.number}</strong>. Pay at the counter.</p><button type="button" class="new-order">Start a new order</button></div>`
      : "";
}

menu.subscribe(() => {
  renderMenu();
  renderModal();
});
modal.subscribe(renderModal);
cart.subscribe(renderCart);
order.subscribe(renderCart);

root.addEventListener("click", (e) => {
  const t = e.target as Element;
  const btn = t.closest("button");
  if (!btn) return;
  if (btn.classList.contains("tab")) menu.update((m) => ({ ...m, category: btn.dataset.cat!, notice: "" }));
  else if (btn.classList.contains("add")) {
    const item = menu.get().items.find((i) => i.id === Number(btn.closest<HTMLElement>("li")!.dataset.id));
    if (!item || item.soldOut) return;
    // nothing to choose: straight into the order
    if (!item.sizes?.length && !item.extras?.length) void confirmAdd(item.id, "", []);
    else modal.set({ itemId: item.id, size: item.sizes?.[0]?.id ?? "", extras: [] });
  } else if (btn.classList.contains("confirm-add")) {
    const md = modal.get();
    modal.set({ itemId: 0, size: "", extras: [] });
    void confirmAdd(md.itemId, md.size, md.extras);
  } else if (btn.classList.contains("cancel")) modal.set({ itemId: 0, size: "", extras: [] });
  else if (btn.classList.contains("inc") || btn.classList.contains("dec") || btn.classList.contains("remove")) {
    const key = btn.closest<HTMLElement>("li.cart-line")!.dataset.key!;
    const line = cart.get().lines.find((l) => l.key === key);
    if (line) changeQty(key, btn.classList.contains("inc") ? 1 : btn.classList.contains("dec") ? -1 : -line.qty);
  } else if (btn.classList.contains("place-order")) void placeOrder();
  else if (btn.classList.contains("new-order")) newOrder();
});
root.addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.name === "size") modal.update((m) => ({ ...m, size: t.value }));
  else if (t.classList.contains("extra")) modal.update((m) => ({ ...m, extras: t.checked ? [...m.extras, t.value] : m.extras.filter((x) => x !== t.value) }));
});
root.querySelector(".promo-form")!.addEventListener("submit", (e) => {
  e.preventDefault();
  void applyPromo(promoInput.value);
});

renderMenu();
renderCart();
void loadMenu();
void loadBoard();
setInterval(() => void loadMenu(), 15000);
setInterval(() => void loadBoard(), 5000);
