// One-page checkout for an outdoor-gear shop (plain TypeScript DOM code + fetch, state in runtime atoms).
// Cart lines are edited optimistically and the server answers every cart write with the full cart. Latent bugs by
// flag: out-of-order cart echoes applied as they arrive (cartEcho=arrival) or only the newest-issued write's echo
// applied even when the server processed the writes in another order (cartEcho=latest), relative quantity writes (qtyWrite=inc),
// an order summary refreshed only from click handlers (summary=on-click), profile prefill clobbering typing
// (prefill=always), a "Place order" button that stays enabled while submitting (disableSubmit=false), no
// Idempotency-Key (idempotencyKey=false) and a timeout retry that goes through the generic JSON helper without
// the key (timeoutRetry=fresh: duplicate orders when the first attempt had committed).
import { rt, flag } from "../_shared/genclass";

type Line = { id: number; productId: string; name: string; price: number; qty: number };
type CartView = { items: Line[]; count: number; total: number };
type Product = { id: string; name: string; price: number; blurb: string };
type Rate = { id: string; label: string; fee: number };
type Order = { id: number; items: { productId: string; qty: number; price: number }[]; total: number; method: string; createdAt?: string };
type Form = { name: string; street: string; city: string; zip: string };

const DISABLE = Boolean(flag("disableSubmit", true));
const IDEM = Boolean(flag("idempotencyKey", true));
const RETRY = flag("timeoutRetry", "same-key") as "same-key" | "fresh" | "off";
const ORDER_TIMEOUT = Number(flag("orderTimeoutMs", 8000));
const SUMMARY = flag("summary", "derived") as "derived" | "on-click";
const QTY = flag("qtyWrite", "patch") as "patch" | "inc";
const ECHO = flag("cartEcho", "settle") as "settle" | "latest" | "arrival";
const PREFILL = flag("prefill", "if-untouched") as "if-untouched" | "always";

const TAX_RATE = 0.0825;
const r2 = (x: number) => Math.round(x * 100) / 100;
const money = (x: number | undefined) => (typeof x === "number" ? `$${x.toFixed(2)}` : "$—");
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const cart = rt.atom("cart", { items: [] as Line[], count: 0, subtotal: 0, loading: true, error: "" });
let saving = 0; // cart writes in flight (drives the "Saving…" hint only)
const checkout = rt.atom("checkout", {
  form: { name: "", street: "", city: "", zip: "" } as Form,
  touched: false,
  method: "standard",
  rates: [] as Rate[],
  summary: { subtotal: 0, shipping: 0, tax: 0, total: 0 },
  submitting: false,
  error: "",
  placed: null as null | { id: number; total: number; items: number },
});
const orders = rt.atom("orders", { recent: [] as Order[], loading: false });
let products: Product[] = [];

// ------------------------------------------------------------------------------------------------ http
class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}
async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new HttpError(r.status);
  return (await r.json()) as T;
}
/** The app's generic JSON writer (used all over the codebase). */
function postJSON(url: string, body: unknown, method = "POST"): Promise<Response> {
  return fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

// ---------------------------------------------------------------------------------------------- summary
function computeSummary() {
  const c = checkout.get();
  const subtotal = cart.get().subtotal;
  const shipping = subtotal > 0 ? c.rates.find((x) => x.id === c.method)?.fee ?? 0 : 0;
  const tax = r2(subtotal * TAX_RATE);
  checkout.update((x) => ({ ...x, summary: { subtotal, shipping, tax, total: r2(subtotal + shipping + tax) } }));
}
if (SUMMARY === "derived") cart.subscribe(() => computeSummary());

// ------------------------------------------------------------------------------------------------- cart
function applyCart(view: CartView) {
  cart.update((c) => ({ ...c, items: view.items, count: view.count, subtotal: view.total, loading: false }));
}

let cartSeq = 0; // cart writes issued
let overlapped = false; // a write started while another was in flight since the cart last settled

async function loadCart() {
  const at = cartSeq;
  cart.update((c) => ({ ...c, loading: true }));
  try {
    const view = await getJSON<CartView>("/api/cart");
    // a write issued meanwhile will settle the cart itself
    if (ECHO === "settle" && (cartSeq !== at || saving > 0)) cart.update((c) => ({ ...c, loading: false }));
    else applyCart(view);
  } catch {
    cart.update((c) => ({ ...c, loading: false, error: "We couldn't load your cart." }));
  }
  if (SUMMARY === "on-click") computeSummary();
}

async function cartWrite(method: string, url: string, body?: unknown) {
  const seq = ++cartSeq;
  if (saving > 0) overlapped = true;
  saving++;
  cart.update((c) => ({ ...c, error: "" }));
  try {
    const r = body === undefined ? await fetch(url, { method }) : await postJSON(url, body, method);
    if (!r.ok) throw new HttpError(r.status);
    const view = (await r.json()) as CartView;
    if (ECHO === "settle") {
      // keep the optimistic cart until the last write lands; overlapping writes are reconciled with one reload
      if (saving > 1) return;
      if (overlapped) {
        overlapped = false;
        void loadCart();
        return;
      }
    } else if (ECHO === "latest" && seq !== cartSeq) return; // only the newest write's echo describes our cart
    applyCart(view);
  } catch {
    cart.update((c) => ({ ...c, error: "Your cart couldn't be updated. Showing the latest saved cart." }));
    void loadCart();
  } finally {
    saving = Math.max(0, saving - 1);
    renderCart();
  }
}

function localQty(id: number, qty: number) {
  cart.update((c) => {
    const items = qty > 0 ? c.items.map((l) => (l.id === id ? { ...l, qty } : l)) : c.items.filter((l) => l.id !== id);
    return { ...c, items, count: items.reduce((n, l) => n + l.qty, 0), subtotal: r2(items.reduce((s, l) => s + l.price * l.qty, 0)) };
  });
}

function changeQty(id: number, delta: number) {
  const line = cart.get().items.find((l) => l.id === id);
  if (!line) return;
  const next = line.qty + delta;
  localQty(id, next);
  if (next <= 0) void cartWrite("DELETE", `/api/cart/${id}`);
  else if (QTY === "inc") void cartWrite("POST", `/api/cart/${id}/${delta > 0 ? "inc" : "dec"}`, {});
  else void cartWrite("PATCH", `/api/cart/${id}`, { qty: next });
  if (SUMMARY === "on-click") computeSummary();
}

function removeLine(id: number) {
  localQty(id, 0);
  void cartWrite("DELETE", `/api/cart/${id}`);
  if (SUMMARY === "on-click") computeSummary();
}

function addProduct(pid: string) {
  const p = products.find((x) => x.id === pid);
  if (!p) return;
  void cartWrite("POST", "/api/cart", { productId: p.id, name: p.name, price: p.price, qty: 1 });
  if (SUMMARY === "on-click") computeSummary();
}

// ------------------------------------------------------------------------------------------------ order
const validForm = (f: Form) => f.name.trim() && f.street.trim() && f.city.trim() && /^\d{5}$/.test(f.zip.trim());

async function postOrder(body: unknown, key: string): Promise<Order> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (IDEM) headers["Idempotency-Key"] = key;
  const send = () => fetch("/api/orders", { method: "POST", headers, body: JSON.stringify(body), ...(RETRY !== "off" ? { signal: AbortSignal.timeout(ORDER_TIMEOUT) } : {}) });
  let r: Response;
  try {
    r = await send();
  } catch (e) {
    if (RETRY === "off" || (e as DOMException)?.name !== "TimeoutError") throw e;
    // the gateway is slow: try once more
    r = RETRY === "same-key" ? await send() : await postJSON("/api/orders", body);
  }
  if (!r.ok) throw new HttpError(r.status);
  return (await r.json()) as Order;
}

async function placeOrder() {
  const c = checkout.get();
  if (DISABLE && c.submitting) return;
  const lines = cart.get().items;
  if (!lines.length) return;
  if (!validForm(c.form)) {
    checkout.update((x) => ({ ...x, error: "Please enter your full name, street, city and a 5-digit ZIP code." }));
    return;
  }
  const body = { items: lines.map((l) => ({ productId: l.productId, qty: l.qty, price: l.price })), shipTo: { ...c.form }, method: c.method, total: c.summary.total };
  const key = crypto.randomUUID();
  checkout.update((x) => ({ ...x, submitting: true, error: "", placed: null }));
  try {
    const order = await postOrder(body, key);
    checkout.update((x) => ({ ...x, submitting: false, placed: { id: order.id, total: order.total, items: order.items.length } }));
    // the cart is emptied by the client after a successful order
    const ids = lines.map((l) => l.id);
    cart.update((x) => ({ ...x, items: [], count: 0, subtotal: 0 }));
    if (SUMMARY === "on-click") computeSummary();
    await postJSON("/api/cart/bulk", { ids, op: "delete" }).catch(() => undefined);
    void loadCart();
    void loadOrders();
  } catch (e) {
    const msg = e instanceof HttpError && e.status < 500 ? "Your order could not be placed. Please review your details." : "We couldn't reach the payment service. Your card was not charged — please try again.";
    checkout.update((x) => ({ ...x, submitting: false, error: msg }));
  }
}

async function loadOrders() {
  orders.update((o) => ({ ...o, loading: true }));
  try {
    const d = await getJSON<{ items: Order[] }>("/api/orders?sort=-createdAt&limit=5");
    orders.set({ recent: d.items, loading: false });
  } catch {
    orders.update((o) => ({ ...o, loading: false }));
  }
}

// ----------------------------------------------------------------------------------------------- render
const root = document.getElementById("app")!;
root.innerHTML = `
  <header><h1>Fernhill Outfitters</h1><p class="crumbs">Cart · Shipping · Payment</p></header>
  <main class="checkout">
    <section class="cart-panel"><h2>Your cart (<span class="count">0</span>)</h2><p class="cart-status"></p><div class="cart-error"></div><ul class="lines"></ul></section>
    <section class="recs"><h2>Frequently bought together</h2><ul class="rec-list"></ul></section>
    <section class="shipping"><h2>Shipping address</h2>
      <form class="ship-form" novalidate>
        <label>Full name <input name="name" autocomplete="name"></label>
        <label>Street <input name="street" autocomplete="street-address"></label>
        <label>City <input name="city" autocomplete="address-level2"></label>
        <label>ZIP <input name="zip" inputmode="numeric" maxlength="5"></label>
        <label>Delivery <select name="method"></select></label>
      </form>
    </section>
    <aside class="summary"><h2>Order summary</h2><dl class="totals"></dl>
      <button type="button" class="place-order">Place order</button><div class="order-error"></div><div class="confirmation"></div></aside>
    <section class="orders"><h2>Recent orders</h2><button type="button" class="refresh-orders">Refresh</button><ul class="order-list"></ul></section>
  </main>`;
const q = <T extends Element = HTMLElement>(s: string) => root.querySelector(s) as T;
const form = q<HTMLFormElement>(".ship-form");

function renderCart() {
  const c = cart.get();
  q(".count").textContent = String(c.count);
  q(".cart-status").textContent = c.loading ? "Loading your cart…" : c.items.length ? (saving ? "Saving…" : "") : "Your cart is empty.";
  q(".cart-error").innerHTML = c.error ? `<p role="alert">${esc(c.error)}</p>` : "";
  q(".lines").innerHTML = c.items
    .map((l) => `<li class="line" data-id="${l.id}"><span class="name">${esc(l.name)}</span> <button type="button" class="dec" aria-label="Decrease">−</button> <span class="qty">${l.qty}</span> <button type="button" class="inc" aria-label="Increase">+</button> <span class="price">${money(r2(l.price * l.qty))}</span> <button type="button" class="remove">Remove</button></li>`)
    .join("");
}

function renderCheckout() {
  const c = checkout.get();
  const s = c.summary;
  q(".totals").innerHTML = `<dt>Subtotal</dt><dd>${money(s.subtotal)}</dd><dt>Shipping</dt><dd>${money(s.shipping)}</dd><dt>Tax</dt><dd>${money(s.tax)}</dd><dt>Total</dt><dd class="total">${money(s.total)}</dd>`;
  const btn = q<HTMLButtonElement>(".place-order");
  btn.disabled = (DISABLE && c.submitting) || cart.get().items.length === 0;
  btn.textContent = c.submitting ? "Placing order…" : "Place order";
  q(".order-error").innerHTML = c.error ? `<p role="alert">${esc(c.error)}</p>` : "";
  q(".confirmation").innerHTML = c.placed ? `<p class="thanks">Thanks! Order #${c.placed.id} is confirmed — ${money(c.placed.total)} for ${c.placed.items} item(s).</p><button type="button" class="continue-shopping">Continue shopping</button>` : "";
  const sel = q<HTMLSelectElement>("select[name=method]");
  if (sel.options.length !== c.rates.length) sel.innerHTML = c.rates.map((r) => `<option value="${esc(r.id)}">${esc(r.label)} (${money(r.fee)})</option>`).join("");
  if (sel.value !== c.method && c.rates.length) sel.value = c.method;
}

function renderOrders() {
  const o = orders.get();
  q(".order-list").innerHTML = o.recent.length ? o.recent.map((x) => `<li>Order #${x.id} · ${x.items.length} item(s) · ${money(x.total)} · ${esc(x.method)}</li>`).join("") : `<li class="muted">${o.loading ? "Loading…" : "No orders yet."}</li>`;
}

cart.subscribe(() => {
  renderCart();
  renderCheckout();
});
checkout.subscribe(renderCheckout);
orders.subscribe(renderOrders);

// ----------------------------------------------------------------------------------------------- events
q(".lines").addEventListener("click", (e) => {
  const btn = (e.target as Element).closest("button");
  const li = btn?.closest("li.line") as HTMLElement | null;
  if (!btn || !li) return;
  const id = Number(li.dataset.id);
  if (btn.classList.contains("inc")) changeQty(id, +1);
  else if (btn.classList.contains("dec")) changeQty(id, -1);
  else if (btn.classList.contains("remove")) removeLine(id);
});
q(".rec-list").addEventListener("click", (e) => {
  const btn = (e.target as Element).closest("button.add") as HTMLElement | null;
  if (btn) addProduct(btn.dataset.pid!);
});
form.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.name in checkout.get().form) checkout.update((c) => ({ ...c, touched: true, error: "", form: { ...c.form, [t.name]: t.value } }));
});
form.addEventListener("change", (e) => {
  const t = e.target as HTMLSelectElement;
  if (t.name !== "method") return;
  checkout.update((c) => ({ ...c, method: t.value }));
  computeSummary();
});
form.addEventListener("submit", (e) => e.preventDefault());
q(".place-order").addEventListener("click", () => void placeOrder());
q(".confirmation").addEventListener("click", (e) => {
  if ((e.target as Element).closest("button.continue-shopping")) checkout.update((c) => ({ ...c, placed: null }));
});
q(".refresh-orders").addEventListener("click", () => void loadOrders());

// ------------------------------------------------------------------------------------------------- boot
async function boot() {
  void loadCart();
  void loadOrders();
  getJSON<Product[]>("/api/products")
    .then((ps) => {
      products = ps;
      q(".rec-list").innerHTML = ps.map((p) => `<li><strong>${esc(p.name)}</strong> ${money(p.price)} <small>${esc(p.blurb)}</small> <button type="button" class="add" data-pid="${esc(p.id)}">Add</button></li>`).join("");
    })
    .catch(() => (q(".rec-list").innerHTML = `<li class="muted">Recommendations unavailable.</li>`));
  try {
    const rates = await getJSON<Rate[]>("/api/rates");
    checkout.update((c) => ({ ...c, rates }));
  } catch {
    checkout.update((c) => ({ ...c, rates: [{ id: "standard", label: "Standard", fee: 4.95 }] }));
  }
  computeSummary();
  try {
    const p = await getJSON<Form & { method?: string }>("/api/docs/profile");
    if (PREFILL === "always" || !checkout.get().touched) {
      const f: Form = { name: p.name, street: p.street, city: p.city, zip: p.zip };
      for (const [k, v] of Object.entries(f)) (form.elements.namedItem(k) as HTMLInputElement).value = v;
      checkout.update((c) => ({ ...c, form: f, method: p.method ?? c.method }));
      computeSummary();
    }
  } catch {
    /* guest checkout: empty form */
  }
}
renderCart();
renderCheckout();
renderOrders();
void boot();
