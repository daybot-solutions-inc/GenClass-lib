// Record shop (Vue 3 templates + vue-router 4 in history mode + Pinia; fetch). Three Pinia stores are registered with
// rt.guard: route-driven and user edits are plain Pinia mutations (traced), everything that comes back from the
// network is written through the guarded handles. Each route loads its own data when it is entered (catalog by
// genre query, record by :id param, crate on visit). Latent bugs by flag: record pages fetched without aborting the
// previous request (productFetch=none: after a quick hop the page shows the record you left; check-id is a correct
// alternative that ignores stale answers), genre switches applied in arrival order (catalogGuard=none), "Add to
// crate" not locked while adding (addLock=false), crate badge bumped locally and never corrected on failure
// (badge=local-increment), debounced quantity edits cancelled when the crate page unmounts (qtyFlush=drop: the change
// the user saw is never sent).
import { createApp, defineComponent, computed, watch, onBeforeUnmount, onMounted } from "vue";
import { createRouter, createWebHistory, useRoute, useRouter } from "vue-router";
import { createPinia, defineStore, setActivePinia } from "pinia";
import { rt, flag } from "../_shared/genclass";

type Rec = { id: number; title: string; artist: string; genre: string; year: number; label: string; price: number; stock: number; tracks: string[] };
type Line = { id: number; productId: number; title: string; price: number; qty: number };
type CrateView = { items: Line[]; count: number; total: number };

const PRODUCT_FETCH = flag("productFetch", "abort") as "abort" | "none" | "check-id";
const CATALOG_GUARD = flag("catalogGuard", "latest") as "latest" | "none";
const ADD_LOCK = Boolean(flag("addLock", true));
const BADGE = flag("badge", "from-echo") as "from-echo" | "local-increment";
const QTY_FLUSH = flag("qtyFlush", "flush-on-leave") as "flush-on-leave" | "drop";
const QTY_DELAY = 800;
const GENRES = ["all", "jazz", "soul", "electronic", "rock", "folk"];

const money = (n: unknown) => `£${Number(n ?? 0).toFixed(2)}`;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const json = { "content-type": "application/json" };
const sumQty = (items: Line[]) => items.reduce((a, l) => a + Number(l.qty), 0);
const sumTotal = (items: Line[]) => Math.round(items.reduce((a, l) => a + Number(l.qty) * Number(l.price), 0) * 100) / 100;

const pinia = createPinia();
setActivePinia(pinia);
const useCatalog = defineStore("catalog", { state: () => ({ genre: "all", records: [] as Rec[], loading: false, error: "" }) });
const useRecord = defineStore("record", { state: () => ({ id: 0, current: null as Rec | null, loading: false, error: "" }) });
const useCrate = defineStore("crate", { state: () => ({ items: [] as Line[], count: 0, total: 0, adding: [] as number[], loading: false, notice: "", error: "" }) });

function guardStore<S extends object>(name: string, store: { $state: S; $patch(p: Partial<S>): void; $subscribe(cb: () => void, o?: { flush?: "sync" | "pre" | "post" }): () => void }) {
  let snap = clone(store.$state);
  store.$subscribe(() => (snap = clone(store.$state)), { flush: "sync" });
  return rt.guard<S>(name, { get: () => snap, set: (v) => store.$patch(clone(v)), subscribe: (fn) => store.$subscribe(() => fn(), { flush: "sync" }) });
}
const catalogStore = useCatalog();
const recordStore = useRecord();
const crateStore = useCrate();
const catalog = guardStore("catalog", catalogStore);
const record = guardStore("record", recordStore);
const crate = guardStore("crate", crateStore);

// -------------------------------------------------------------------------------------------- catalog
let catSeq = 0;
async function loadCatalog(genre: string) {
  const seq = ++catSeq;
  catalogStore.$patch({ genre, loading: true, error: "" });
  try {
    const r = await fetch(`/api/records?limit=50${genre !== "all" ? `&genre=${encodeURIComponent(genre)}` : ""}`);
    if (!r.ok) throw new Error(String(r.status));
    const body = (await r.json()) as { items: Rec[] };
    if (CATALOG_GUARD === "latest" && seq !== catSeq) return;
    catalog.update((s) => ({ ...s, records: body.items ?? [], loading: false }));
  } catch {
    if (CATALOG_GUARD === "latest" && seq !== catSeq) return;
    catalog.update((s) => ({ ...s, loading: false, error: "The record list couldn't be loaded." }));
  }
}

// --------------------------------------------------------------------------------------------- record
let recCtl: AbortController | null = null;
async function openRecord(id: number) {
  if (PRODUCT_FETCH === "abort") recCtl?.abort();
  const ctl = new AbortController();
  recCtl = ctl;
  recordStore.$patch({ id, loading: true, error: "" }); // the previous record stays on screen until this one arrives
  try {
    const r = await fetch(`/api/records/${id}`, PRODUCT_FETCH === "abort" ? { signal: ctl.signal } : {});
    if (!r.ok) throw new Error(String(r.status));
    const rec = (await r.json()) as Rec;
    if (PRODUCT_FETCH === "check-id" && recordStore.id !== id) return;
    record.update((s) => ({ ...s, current: rec, loading: false }));
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    if (PRODUCT_FETCH === "check-id" && recordStore.id !== id) return;
    record.update((s) => ({ ...s, loading: false, error: "This record couldn't be loaded. Go back and try again." }));
  }
}
function leaveRecord() {
  if (PRODUCT_FETCH === "abort") recCtl?.abort();
}

// ---------------------------------------------------------------------------------------------- crate
async function loadCrate() {
  crateStore.$patch({ loading: true });
  try {
    const r = await fetch("/api/crate");
    if (!r.ok) throw new Error(String(r.status));
    const v = (await r.json()) as CrateView;
    const busy = qtyTimers.size > 0 || qtyInflight > 0;
    crate.update((s) => (busy ? { ...s, loading: false } : { ...s, items: v.items, count: Number(v.count), total: Number(v.total), loading: false }));
  } catch {
    crate.update((s) => ({ ...s, loading: false, error: "Your crate couldn't be loaded." }));
  }
}

async function addToCrate(rec: Rec) {
  if (ADD_LOCK && crateStore.adding.includes(rec.id)) return;
  crateStore.$patch((s) => {
    s.adding.push(rec.id);
    s.error = "";
    s.notice = "";
    if (BADGE === "local-increment") s.count += 1;
  });
  try {
    const r = await fetch("/api/crate", { method: "POST", headers: json, body: JSON.stringify({ productId: rec.id, title: `${rec.artist} — ${rec.title}`, price: rec.price, qty: 1 }) });
    if (!r.ok) throw new Error(String(r.status));
    const v = (await r.json()) as CrateView;
    crate.update((s) => ({ ...s, items: v.items, count: BADGE === "from-echo" ? Number(v.count) : s.count, total: Number(v.total), adding: s.adding.filter((x) => x !== rec.id), notice: `${rec.title} is in your crate.` }));
  } catch {
    crate.update((s) => ({ ...s, adding: s.adding.filter((x) => x !== rec.id), error: `Couldn't add ${rec.title}. Try again.` }));
  }
}

const qtyTimers = new Map<number, ReturnType<typeof setTimeout>>();
let qtyInflight = 0;
let qtySeq = 0;
function bump(lineId: number, d: number) {
  crateStore.$patch((s) => {
    const l = s.items.find((x) => x.id === lineId);
    if (!l) return;
    l.qty = Math.max(1, l.qty + d);
    s.count = sumQty(s.items);
    s.total = sumTotal(s.items);
    s.error = "";
  });
  clearTimeout(qtyTimers.get(lineId));
  qtyTimers.set(lineId, setTimeout(() => (qtyTimers.delete(lineId), void sendQty(lineId)), QTY_DELAY));
}
async function sendQty(lineId: number) {
  const l = crateStore.items.find((x) => x.id === lineId);
  if (!l) return;
  const seq = ++qtySeq;
  qtyInflight++;
  try {
    const r = await fetch(`/api/crate/${lineId}`, { method: "PATCH", headers: json, body: JSON.stringify({ qty: l.qty }) });
    if (!r.ok) throw new Error(String(r.status));
    const v = (await r.json()) as CrateView;
    if (seq === qtySeq && qtyTimers.size === 0) crate.update((s) => ({ ...s, items: v.items, count: Number(v.count), total: Number(v.total) }));
  } catch {
    crate.update((s) => ({ ...s, error: "A quantity change wasn't saved." }));
  } finally {
    qtyInflight--;
  }
}
function leaveCrate() {
  for (const [lineId, t] of qtyTimers) {
    clearTimeout(t);
    qtyTimers.delete(lineId);
    if (QTY_FLUSH === "flush-on-leave") void sendQty(lineId);
  }
}
async function removeLine(lineId: number) {
  clearTimeout(qtyTimers.get(lineId));
  qtyTimers.delete(lineId);
  crateStore.$patch((s) => {
    s.items = s.items.filter((x) => x.id !== lineId);
    s.count = sumQty(s.items);
    s.total = sumTotal(s.items);
    s.error = "";
  });
  try {
    const r = await fetch(`/api/crate/${lineId}`, { method: "DELETE" });
    if (!r.ok) throw new Error(String(r.status));
  } catch {
    crate.update((s) => ({ ...s, error: "That record couldn't be removed." }));
    void loadCrate();
  }
}

// ------------------------------------------------------------------------------------------------ views
const Catalog = defineComponent({
  setup() {
    const route = useRoute();
    const router = useRouter();
    const genre = computed(() => String(route.query.genre ?? "all"));
    watch(genre, (g) => void loadCatalog(g), { immediate: true });
    const setGenre = (g: string) => void router.replace({ path: "/", query: g === "all" ? {} : { genre: g } });
    const adding = (id: number) => crateStore.adding.includes(id);
    return { cat: catalogStore, genre, setGenre, money, GENRES, adding, add: (r: Rec) => void addToCrate(r), ADD_LOCK };
  },
  template: `
    <section class="catalog">
      <label>Genre <select name="genre" aria-label="Genre" :value="genre" @change="setGenre($event.target.value)"><option v-for="g in GENRES" :key="g" :value="g">{{ g }}</option></select></label>
      <p v-if="cat.loading">Loading records…</p>
      <p v-if="cat.error" role="alert">{{ cat.error }}</p>
      <ul><li v-for="r in cat.records" :key="r.id" class="record-row"><router-link :to="'/record/' + r.id" class="record-link">{{ r.artist }} — {{ r.title }}</router-link> · {{ r.genre }} · {{ money(r.price) }}<span v-if="r.stock < 1"> · sold out</span> <button class="quick-add" :disabled="r.stock < 1 || (ADD_LOCK && adding(r.id))" @click="add(r)">Add</button></li></ul>
    </section>`,
});

const RecordPage = defineComponent({
  setup() {
    const route = useRoute();
    // a fresh visit starts blank; hopping between related records keeps the current one on screen while loading
    if (recordStore.current && recordStore.current.id !== Number(route.params.id)) recordStore.$patch({ current: null });
    watch(() => Number(route.params.id), (id) => id && void openRecord(id), { immediate: true });
    onBeforeUnmount(leaveRecord);
    const rec = recordStore;
    const related = computed(() => (rec.current ? catalogStore.records.filter((r) => r.genre === rec.current!.genre && r.id !== rec.current!.id).slice(0, 3) : []));
    const adding = computed(() => (rec.current ? crateStore.adding.includes(rec.current.id) : false));
    return { rec, related, adding, money, add: () => rec.current && void addToCrate(rec.current), ADD_LOCK };
  },
  template: `
    <section class="record">
      <router-link to="/" class="back">← All records</router-link>
      <p v-if="rec.loading">Loading record…</p>
      <p v-if="rec.error" role="alert">{{ rec.error }}</p>
      <article v-if="rec.current">
        <h2>{{ rec.current.artist }} — {{ rec.current.title }}</h2>
        <p class="meta">{{ rec.current.label }} · {{ rec.current.year }} · {{ rec.current.genre }}</p>
        <ol class="tracks"><li v-for="t in rec.current.tracks" :key="t">{{ t }}</li></ol>
        <p class="stock">{{ rec.current.stock > 0 ? rec.current.stock + (rec.current.stock === 1 ? " copy" : " copies") + " in the shop" : "Sold out" }}</p>
        <button v-if="!rec.loading" class="add-to-crate" :disabled="rec.current.stock < 1 || (ADD_LOCK && adding)" @click="add">{{ adding ? "Adding…" : "Add to crate · " + money(rec.current.price) }}</button>
        <div v-if="related.length" class="related"><h3>More {{ rec.current.genre }}</h3><router-link v-for="r in related" :key="r.id" :to="'/record/' + r.id" class="related-link">{{ r.artist }} — {{ r.title }}</router-link></div>
      </article>
    </section>`,
});

const CratePage = defineComponent({
  setup() {
    onMounted(() => void loadCrate());
    onBeforeUnmount(leaveCrate);
    return { c: crateStore, money, bump, removeLine };
  },
  template: `
    <section class="crate">
      <h2>Your crate</h2>
      <p v-if="c.loading">Checking your crate…</p>
      <p v-if="!c.items.length && !c.loading" class="empty">Nothing here yet.</p>
      <ul><li v-for="l in c.items" :key="l.id" class="crate-line">{{ l.title }} <button class="dec" :disabled="l.qty <= 1" @click="bump(l.id, -1)" aria-label="One fewer">−</button> {{ l.qty }} <button class="inc" @click="bump(l.id, 1)" aria-label="One more">+</button> {{ money(l.qty * l.price) }} <button class="remove" @click="removeLine(l.id)">Remove</button></li></ul>
      <p class="total">Total {{ money(c.total) }}</p>
    </section>`,
});

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: Catalog },
    { path: "/record/:id", component: RecordPage },
    { path: "/crate", component: CratePage },
  ],
});

const App = defineComponent({
  setup: () => ({ crate: crateStore }),
  template: `
    <div class="shop">
      <header><h1>Groove Cellar</h1><nav><router-link to="/" class="to-catalog">Browse</router-link> · <router-link to="/crate" class="to-crate">Crate ({{ crate.count }})</router-link></nav></header>
      <router-view />
      <p v-if="crate.notice" class="notice">{{ crate.notice }}</p>
      <p v-if="crate.error" role="alert">{{ crate.error }}</p>
    </div>`,
});

createApp(App).use(router).use(pinia).mount("#app");
void loadCrate();
