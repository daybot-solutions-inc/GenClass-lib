// Household grocery cart (Vue 3 templates + Pinia + fetch). Both Pinia stores are registered with rt.guard: the
// user's own edits are plain Pinia mutations (traced), while everything that comes back from the network is
// written through the guarded handles, so GenClass sees (and can hold) those writes. Every cart write answers with
// the FULL cart, which the app applies as the new truth. Latent bugs by flag: echoes of older overlapping writes
// applied blindly (echo=blind), totals not recomputed on the server-echo path (totals=local-only), one PATCH per
// click instead of a debounced one (qtySend=each), unguarded "Add" (addGuard=false), double checkout
// (checkout=none; checkout=idem-key relies on the server replaying the order instead of disabling the button).
import { createApp, defineComponent, computed, reactive } from "vue";
import { createPinia, defineStore, setActivePinia } from "pinia";
import { rt, flag } from "../_shared/genclass";

type Line = { id: number; productId: number; name: string; price: number; qty: number };
type Product = { id: number; name: string; price: number; unit: string; aisle: string };
type CartView = { items: Line[]; count: number; total: number };

const ECHO = flag("echo", "latest") as "latest" | "blind";
const TOTALS = flag("totals", "everywhere") as "everywhere" | "local-only";
const QTY_SEND = flag("qtySend", "debounce") as "debounce" | "each";
const ADD_GUARD = Boolean(flag("addGuard", true));
const CHECKOUT = flag("checkout", "disable") as "disable" | "none" | "idem-key";

const FREE_SHIPPING = 40;
const SHIPPING = 4.99;
const cents = (n: number) => Math.round(n * 100) / 100;
const money = (n: unknown) => `$${Number(n ?? 0).toFixed(2)}`;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function totalsOf(items: Line[]) {
  let subtotal = 0;
  let count = 0;
  for (const l of items) {
    subtotal += Number(l.price) * Number(l.qty);
    count += Number(l.qty);
  }
  subtotal = cents(subtotal);
  const shipping = subtotal === 0 || subtotal >= FREE_SHIPPING ? 0 : SHIPPING;
  return { subtotal, count, shipping, total: cents(subtotal + shipping) };
}

const pinia = createPinia();
setActivePinia(pinia);

const useCatalog = defineStore("catalog", {
  state: () => ({ products: [] as Product[], aisle: "all", loading: false, error: "" }),
});

const useCart = defineStore("cart", {
  state: () => ({
    items: [] as Line[],
    count: 0,
    subtotal: 0,
    shipping: 0,
    total: 0,
    placing: false,
    lastOrder: "",
    error: "",
  }),
  actions: {
    bump(lineId: number, d: number) {
      this.$patch((s) => {
        const l = s.items.find((x) => x.id === lineId);
        if (!l) return;
        l.qty = Math.max(1, l.qty + d);
        Object.assign(s, totalsOf(s.items));
        s.error = "";
      });
      queueQty(lineId);
    },
    drop(lineId: number) {
      cancelQty(lineId);
      this.$patch((s) => {
        s.items = s.items.filter((x) => x.id !== lineId);
        Object.assign(s, totalsOf(s.items));
        s.error = "";
      });
      void write("DELETE", `/api/cart/${lineId}`);
    },
    add(p: Product) {
      if (ADD_GUARD && requests.adding.includes(p.id)) return;
      requests.adding.push(p.id);
      this.error = "";
      void write("POST", "/api/cart", { productId: p.id, name: p.name, price: p.price, qty: 1 }, p.id);
    },
  },
});

// ------------------------------------------------------------------------------------- GenClass registration
function guardStore<S extends object>(name: string, store: { $state: S; $patch(p: Partial<S>): void; $subscribe(cb: () => void, o?: { flush?: "sync" | "pre" | "post" }): () => void }) {
  let snap = clone(store.$state);
  store.$subscribe(() => (snap = clone(store.$state)), { flush: "sync" });
  return rt.guard<S>(name, {
    get: () => snap,
    set: (v) => store.$patch(clone(v)),
    subscribe: (fn) => store.$subscribe(() => fn(), { flush: "sync" }),
  });
}

const catalogStore = useCatalog();
const cartStore = useCart();
const catalog = guardStore("catalog", catalogStore);
const cart = guardStore("cart", cartStore);

// ------------------------------------------------------------------------------------------- server sync
/** Request status for the UI (spinners, disabled buttons); not app data. */
const requests = reactive({ pending: 0, adding: [] as number[] });
let writeSeq = 0;
const qtyTimers = new Map<number, ReturnType<typeof setTimeout>>();

/** Is this echo still the newest information we will get (no newer write sent, no unsent local edit)? */
const fresh = (seq: number) => ECHO === "blind" || (seq === writeSeq && qtyTimers.size === 0);

function withEcho(s: typeof cartStore.$state, view: CartView) {
  const items = Array.isArray(view.items) ? view.items : s.items;
  if (TOTALS === "everywhere") return { ...s, items, ...totalsOf(items) };
  // the echo already carries the server's count; subtotal/shipping/total stay as they were
  return { ...s, items, count: Number(view.count ?? s.count) };
}

async function write(method: string, url: string, body?: unknown, productId?: number) {
  const seq = ++writeSeq;
  requests.pending++;
  const done = () => {
    requests.pending = Math.max(0, requests.pending - 1);
    if (productId !== undefined) requests.adding = requests.adding.filter((x) => x !== productId);
  };
  try {
    const r = await fetch(url, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!r.ok) throw new Error(String(r.status));
    const view = (await r.json()) as CartView;
    done();
    if (fresh(seq)) cart.update((s) => withEcho(s, view));
  } catch {
    done();
    cart.update((s) => ({ ...s, error: method === "POST" ? "Couldn't add that item. Try again." : "Couldn't update your cart." }));
    void refresh();
  }
}

function queueQty(lineId: number) {
  if (QTY_SEND === "each") return void sendQty(lineId);
  cancelQty(lineId);
  qtyTimers.set(
    lineId,
    setTimeout(() => {
      qtyTimers.delete(lineId);
      sendQty(lineId);
    }, 450),
  );
}

function cancelQty(lineId: number) {
  const t = qtyTimers.get(lineId);
  if (t) clearTimeout(t);
  qtyTimers.delete(lineId);
}

function sendQty(lineId: number) {
  const l = cartStore.items.find((x) => x.id === lineId);
  if (l) void write("PATCH", `/api/cart/${lineId}`, { qty: l.qty });
}

async function refresh() {
  const seq = writeSeq;
  try {
    const r = await fetch("/api/cart");
    if (!r.ok) throw new Error(String(r.status));
    const view = (await r.json()) as CartView;
    const apply = ECHO === "blind" || (fresh(seq) && requests.pending === 0);
    if (apply) cart.update((s) => withEcho(s, view));
  } catch {
    cart.update((s) => ({ ...s, error: "Couldn't sync the cart." }));
  }
}

async function loadCatalog() {
  catalogStore.loading = true;
  try {
    const r = await fetch("/api/products?limit=50");
    if (!r.ok) throw new Error(String(r.status));
    const data = (await r.json()) as Product[];
    catalog.update((c) => ({ ...c, products: data, loading: false, error: "" }));
  } catch {
    catalog.update((c) => ({ ...c, loading: false, error: "Products are unavailable right now." }));
  }
}

let checkoutKey: string | null = null;

async function checkout() {
  const s0 = cartStore.$state;
  if (CHECKOUT === "disable" && s0.placing) return;
  if (!s0.items.length) return;
  const key = CHECKOUT === "idem-key" ? (checkoutKey ??= crypto.randomUUID()) : null;
  const lines = s0.items.map((l) => ({ productId: l.productId, qty: l.qty, price: l.price }));
  const ids = s0.items.map((l) => l.id);
  cartStore.$patch({ placing: true, error: "", lastOrder: "" });
  try {
    const r = await fetch("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
      body: JSON.stringify({ lines, total: s0.total, status: "placed" }),
    });
    if (!r.ok) throw new Error(String(r.status));
    const order = (await r.json()) as { id: number; total: number };
    checkoutKey = null;
    await fetch("/api/cart/bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids, op: "delete" }) });
    cart.update((s) => ({ ...s, placing: false, lastOrder: `Order #${order.id} placed (${money(order.total)})` }));
    await refresh();
  } catch {
    cart.update((s) => ({ ...s, placing: false, error: "Checkout failed. Your card was not charged." }));
  }
}

// ------------------------------------------------------------------------------------------------------ UI
const App = defineComponent({
  setup() {
    const shown = computed(() => (catalogStore.aisle === "all" ? catalogStore.products : catalogStore.products.filter((p) => p.aisle === catalogStore.aisle)));
    const aisles = computed(() => ["all", ...new Set(catalogStore.products.map((p) => p.aisle))]);
    return { c: cartStore, cat: catalogStore, req: requests, shown, aisles, money, refresh, checkout, ADD_GUARD, LOCK: CHECKOUT === "disable" };
  },
  template: `
    <div class="shop">
      <header>
        <h1>Household groceries</h1>
        <p><span class="badge">{{ c.count }} in cart</span> <button class="sync" @click="refresh">Sync</button> <span v-if="req.pending" class="saving">Saving…</span></p>
      </header>
      <section class="catalog">
        <label>Aisle
          <select name="aisle" v-model="cat.aisle">
            <option v-for="a in aisles" :key="a" :value="a">{{ a }}</option>
          </select>
        </label>
        <p v-if="cat.loading">Loading products…</p>
        <p v-if="cat.error" role="alert">{{ cat.error }}</p>
        <ul>
          <li v-for="p in shown" :key="p.id" class="product">
            {{ p.name }} · {{ money(p.price) }}/{{ p.unit }}
            <button class="add" :disabled="ADD_GUARD && req.adding.includes(p.id)" @click="c.add(p)">Add</button>
          </li>
        </ul>
      </section>
      <section class="cart">
        <h2>Cart</h2>
        <p v-if="!c.items.length" class="empty">Your cart is empty.</p>
        <ul>
          <li v-for="l in c.items" :key="l.id" class="line">
            <span class="name">{{ l.name }}</span> <button class="dec" :disabled="l.qty <= 1" @click="c.bump(l.id, -1)" aria-label="Fewer">−</button> <span class="qty">{{ l.qty }}</span> <button class="inc" @click="c.bump(l.id, 1)" aria-label="More">+</button> <span class="amount">{{ money(l.qty * l.price) }}</span> <button class="remove" @click="c.drop(l.id)">Remove</button>
          </li>
        </ul>
        <dl class="totals">
          <dt>Subtotal</dt><dd>{{ money(c.subtotal) }}</dd>
          <dt>Delivery</dt><dd>{{ c.shipping ? money(c.shipping) : "Free" }}</dd>
          <dt>Total</dt><dd class="total">{{ money(c.total) }}</dd>
        </dl>
        <button class="checkout" :disabled="!c.items.length || (LOCK && c.placing)" @click="checkout">{{ c.placing ? "Placing order…" : "Place order" }}</button>
        <p v-if="c.lastOrder" class="confirm">{{ c.lastOrder }}</p>
        <p v-if="c.error" role="alert">{{ c.error }}</p>
      </section>
    </div>`,
});

createApp(App).use(pinia).mount("#app");
void loadCatalog();
void refresh();
