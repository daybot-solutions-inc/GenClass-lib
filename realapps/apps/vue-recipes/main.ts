// Weekly meal planner (Vue 3 runtime templates + fetch; state in runtime atoms bridged with useAtom). The week plan
// is a shared, versioned document (the partner edits it too); a recipe search typeahead feeds "assign to the
// selected day", and the shopping list is the union of the planned meals' ingredients. Latent bugs by flag: search
// responses applied in arrival order (searchSeq=blind), conflicts resolved by re-sending the local plan over the
// partner's (planSave=overwrite), assignments sent while another save is in flight with the old version
// (assignGuard=none: our own second write conflicts) and a shopping list maintained incrementally (shopping=incremental).
import { createApp, defineComponent, computed } from "vue";
import { rt, flag } from "../_shared/genclass";
import { useAtom } from "../_shared/vue-atom";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Recipe = { id: number; title: string; tag: string; ingredients: string[]; minutes: number };
type Plan = Record<string, number>;
const SEARCH_SEQ = flag("searchSeq", "latest");
const PLAN_SAVE = flag("planSave", "refetch");
const ASSIGN_GUARD = flag("assignGuard", "pending");
const SHOPPING = flag("shopping", "derive");
const POLL_MS = Number(flag("pollMs", 5000));
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const planner = rt.atom("planner", { plan: {} as Plan, version: 0, catalog: [] as Recipe[], shopping: [] as string[], day: "tue", saving: false, error: "", notice: "" });
const search = rt.atom("search", { q: "", results: [] as Recipe[], loading: false });
type P = ReturnType<typeof planner.get>;

function shoppingFor(plan: Plan, catalog: Recipe[]) {
  const out: string[] = [];
  for (const d of DAYS) for (const g of catalog.find((r) => r.id === plan[d])?.ingredients ?? []) if (!out.includes(g)) out.push(g);
  return out;
}
function adoptPlan(s: P, doc: Plan & { version: number }, initial = false): P {
  const plan: Plan = {};
  for (const d of DAYS) plan[d] = Number(doc[d] ?? 0);
  return { ...s, plan, version: doc.version, shopping: SHOPPING === "derive" || initial ? shoppingFor(plan, s.catalog) : s.shopping };
}

let searchSeq = 0;
let debounce: ReturnType<typeof setTimeout> | undefined;
async function runSearch(q: string) {
  const seq = ++searchSeq;
  search.update((s) => ({ ...s, loading: true }));
  try {
    const results = itemsOf<Recipe>(await api(`/api/recipes?limit=20${q ? `&q=${encodeURIComponent(q)}` : ""}`));
    if (SEARCH_SEQ === "latest" && seq !== searchSeq) return;
    search.update((s) => ({ ...s, results, loading: false }));
  } catch {
    if (seq === searchSeq) search.update((s) => ({ ...s, loading: false }));
  }
}
function typed(q: string) {
  search.update((s) => ({ ...s, q }));
  clearTimeout(debounce);
  debounce = setTimeout(() => void runSearch(q.trim()), 250);
}

let saving = 0;
async function setDay(day: string, recipeId: number) {
  if (ASSIGN_GUARD === "pending" && saving > 0) return;
  const before = planner.get();
  saving++;
  const r = before.catalog.find((x) => x.id === recipeId);
  planner.update((s) => ({ ...s, saving: true, error: "", notice: "", plan: { ...s.plan, [day]: recipeId }, shopping: SHOPPING === "derive" ? shoppingFor({ ...s.plan, [day]: recipeId }, s.catalog) : [...new Set([...s.shopping, ...(r?.ingredients ?? [])])] }));
  try {
    let doc: Plan & { version: number };
    try {
      doc = await api(`/api/docs/plan`, "PATCH", { [day]: recipeId, version: before.version });
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 409 && PLAN_SAVE === "overwrite")) throw e;
      const cur = e.body?.current ?? {};
      doc = await api(`/api/docs/plan`, "PATCH", { ...planner.get().plan, version: cur.version });
    }
    planner.update((s) => ({ ...adoptPlan(s, doc), notice: r ? `${r.title} planned for ${day[0]!.toUpperCase()}${day.slice(1)}.` : `${day} cleared.` }));
  } catch (e) {
    const conflict = e instanceof HttpError && e.status === 409;
    planner.update((s) => ({ ...s, plan: before.plan, shopping: SHOPPING === "derive" ? shoppingFor(before.plan, s.catalog) : s.shopping, error: conflict ? "Your partner changed the plan — reloaded it, please try again." : errText(e, "saving the plan") }));
    if (conflict) void pullPlan();
  } finally {
    saving--;
    planner.update((s) => ({ ...s, saving: saving > 0 }));
  }
}

async function pullPlan(initial = false) {
  if (saving > 0) return;
  try {
    const doc = await api<Plan & { version: number }>(`/api/docs/plan`);
    if (saving > 0) return;
    if (doc.version !== planner.get().version || initial) planner.update((s) => adoptPlan(s, doc, initial));
  } catch (e) {
    if (initial) planner.update((s) => ({ ...s, error: errText(e, "loading the plan") }));
  }
}

const App = defineComponent({
  setup() {
    const p = useAtom(planner);
    const s = useAtom(search);
    const titleOf = (id: number) => p.value.catalog.find((r) => r.id === id)?.title ?? "—";
    const minutes = computed(() => DAYS.reduce((a, d) => a + (p.value.catalog.find((r) => r.id === p.value.plan[d])?.minutes ?? 0), 0));
    const pick = (day: string) => planner.update((x) => ({ ...x, day, notice: "" }));
    return { guard: ASSIGN_GUARD === "pending", p, s, DAYS, titleOf, minutes, pick, typed, assign: (id: number) => void setDay(p.value.day, id), clearDay: () => void setDay(p.value.day, 0), label: (d: string) => d[0]!.toUpperCase() + d.slice(1) };
  },
  template: `<div class="planner">
    <h1>This week's dinners</h1><p class="muted">{{ minutes }} min of cooking planned</p>
    <nav class="days"><template v-for="d in DAYS" :key="d"><button type="button" class="day" :class="{ current: p.day === d }" @click="pick(d)">{{ label(d) }}</button></template>
      <button type="button" class="clear-day" v-if="p.plan[p.day]" :disabled="p.saving" @click="clearDay">Clear {{ label(p.day) }}</button></nav>
    <table class="week"><tr v-for="d in DAYS" :key="d" :class="{ current: p.day === d }"><th>{{ label(d) }}</th><td>{{ titleOf(p.plan[d]) }}</td></tr></table>
    <p v-if="p.error" role="alert">{{ p.error }}</p><p v-else-if="p.notice" class="notice">{{ p.notice }}</p>
    <section class="search"><input name="q" placeholder="Find a recipe" :value="s.q" @input="typed($event.target.value)"> <span v-if="s.loading" class="muted">Searching…</span>
      <ul><li v-for="r in s.results" :key="r.id" class="recipe">{{ r.title }} <small>{{ r.tag }} · {{ r.minutes }} min</small>
        <button type="button" class="assign" :disabled="guard && p.saving" @click="assign(r.id)">Plan for {{ label(p.day) }}</button></li></ul></section>
    <section class="shopping"><h2>Shopping list ({{ p.shopping.length }})</h2><ul><li v-for="g in p.shopping" :key="g">{{ g }}</li></ul></section>
  </div>`,
});

createApp(App).mount("#app");

(async () => {
  try {
    const catalog = itemsOf<Recipe>(await api(`/api/recipes?limit=50`));
    planner.update((s) => ({ ...s, catalog }));
    search.update((s) => ({ ...s, results: catalog.slice(0, 8) }));
  } catch (e) {
    planner.update((s) => ({ ...s, error: errText(e, "loading recipes") }));
  }
  await pullPlan(true);
  setInterval(() => void pullPlan(), POLL_MS);
})();
