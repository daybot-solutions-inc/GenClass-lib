// Translation editor (Vue 3 templates + Pinia stores registered with rt.guard; fetch). A translator picks a locale,
// opens a string, optionally asks for a machine suggestion, edits the draft and saves it (versioned PATCH); a
// reviewer edits French strings meanwhile. Latent bugs by flag: a slow suggestion overwriting what the translator
// already typed (suggest=always), locale lists applied in arrival order (localeSeq=blind), Save live while saving
// (saveGuard=none), conflicts resolved by re-sending over the reviewer's text (conflict=overwrite) and a progress
// counter stored in state and bumped only by our own saves (progress=stored).
import { createApp, defineComponent, computed } from "vue";
import { createPinia, defineStore, setActivePinia } from "pinia";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Str = { id: number; key: string; locale: string; en: string; text: string; reviewed: boolean; version: number };
const SUGGEST = flag("suggest", "if-untouched");
const LOCALE_SEQ = flag("localeSeq", "latest");
const SAVE_GUARD = flag("saveGuard", "pending") === "pending";
const CONFLICT = flag("conflict", "reload");
const PROGRESS = flag("progress", "getter");

const pinia = createPinia();
setActivePinia(pinia);
const useCatalog = defineStore("catalog", { state: () => ({ locale: "fr", items: [] as Str[], translated: 0, loading: true, error: "" }) });
const useEditor = defineStore("editor", { state: () => ({ id: 0, draft: "", touched: false, saving: false, suggesting: false, error: "", notice: "" }) });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function guardStore<S extends object>(name: string, store: { $state: S; $patch(p: Partial<S>): void; $subscribe(cb: () => void, o?: { flush?: "sync" | "pre" | "post" }): () => void }) {
  let snap = clone(store.$state);
  store.$subscribe(() => (snap = clone(store.$state)), { flush: "sync" });
  return rt.guard<S>(name, { get: () => snap, set: (v) => store.$patch(clone(v)), subscribe: (fn) => store.$subscribe(() => fn(), { flush: "sync" }) });
}
const catStore = useCatalog();
const edStore = useEditor();
const catalog = guardStore("catalog", catStore);
const editor = guardStore("editor", edStore);
const countDone = (xs: Str[]) => xs.filter((x) => x.text).length;
const setItems = (items: Str[], bump = 0) => catalog.update((c) => ({ ...c, items, translated: PROGRESS === "getter" ? countDone(items) : c.translated + bump }));

let seq = 0;
async function loadLocale(locale: string) {
  const my = ++seq;
  catalog.update((c) => ({ ...c, locale, loading: true, error: "" }));
  editor.update((e) => ({ ...e, id: 0, draft: "", touched: false, notice: "" }));
  try {
    const items = itemsOf<Str>(await api(`/api/strings?locale=${locale}&limit=40`));
    if (LOCALE_SEQ === "latest" && my !== seq) return;
    catalog.update((c) => ({ ...c, items, translated: countDone(items), loading: false }));
  } catch (e) {
    if (my === seq) catalog.update((c) => ({ ...c, loading: false, error: errText(e, "loading strings") }));
  }
}

function open(s: Str) {
  editor.update((e) => ({ ...e, id: s.id, draft: s.text, touched: false, error: "", notice: "" }));
}
async function suggest() {
  const e0 = editor.get();
  const s = catalog.get().items.find((x) => x.id === e0.id);
  if (!s) return;
  editor.update((e) => ({ ...e, suggesting: true }));
  try {
    const [hit] = itemsOf<{ text: string }>(await api(`/api/suggestions?locale=${s.locale}&key=${encodeURIComponent(s.key)}`));
    editor.update((e) => (e.id !== s.id || (SUGGEST === "if-untouched" && e.touched) || !hit ? e : { ...e, draft: hit.text }));
  } catch (err) {
    editor.update((e) => ({ ...e, error: errText(err, "fetching a suggestion") }));
  } finally {
    editor.update((e) => ({ ...e, suggesting: false }));
  }
}
async function save() {
  const e0 = editor.get();
  if (SAVE_GUARD && e0.saving) return;
  const s = catalog.get().items.find((x) => x.id === e0.id);
  if (!s) return;
  editor.update((e) => ({ ...e, saving: true, error: "", notice: "" }));
  try {
    let saved: Str;
    try {
      saved = await api<Str>(`/api/strings/${s.id}`, "PATCH", { text: e0.draft, version: s.version });
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 409 && CONFLICT === "overwrite")) throw err;
      saved = await api<Str>(`/api/strings/${s.id}`, "PATCH", { text: e0.draft, version: err.body?.current?.version });
    }
    const was = catalog.get().items.find((x) => x.id === saved.id);
    setItems(catalog.get().items.map((x) => (x.id === saved.id ? saved : x)), was && !was.text && saved.text ? 1 : 0);
    editor.update((e) => ({ ...e, touched: false, notice: `Saved ${saved.key}.` }));
  } catch (err) {
    const cur = err instanceof HttpError && err.status === 409 ? (err.body?.current as Str | undefined) : undefined;
    if (cur) {
      setItems(catalog.get().items.map((x) => (x.id === cur.id ? cur : x)));
      editor.update((e) => ({ ...e, error: `A reviewer changed ${cur.key} to “${cur.text}”. Your draft is kept; save again to replace it.` }));
    } else editor.update((e) => ({ ...e, error: errText(err, "saving the translation") }));
  } finally {
    editor.update((e) => ({ ...e, saving: false }));
  }
}
async function poll() {
  const c = catalog.get();
  if (c.loading) return;
  try {
    const items = itemsOf<Str>(await api(`/api/strings?locale=${c.locale}&limit=40`));
    if (catalog.get().locale === c.locale && !catalog.get().loading) catalog.update((x) => ({ ...x, items, translated: PROGRESS === "getter" ? countDone(items) : x.translated }));
  } catch {
    /* next poll */
  }
}

const App = defineComponent({
  setup() {
    const c = catStore;
    const e = edStore;
    const current = computed(() => c.items.find((x) => x.id === e.id));
    const type = (v: string) => edStore.$patch({ draft: v, touched: true });
    return { c, e, current, type, guard: SAVE_GUARD, open, loadLocale, suggest: () => void suggest(), save: () => void save() };
  },
  template: `<div class="translate">
    <h1>Translations</h1>
    <label>Locale <select name="locale" :value="c.locale" @change="loadLocale($event.target.value)"><option value="fr">French</option><option value="de">German</option><option value="es">Spanish</option></select></label>
    <span class="progress">{{ c.translated }} / {{ c.items.length }} translated</span> <span v-if="c.loading" class="muted">Loading…</span>
    <p v-if="c.error" role="alert">{{ c.error }}</p>
    <ul class="strings"><li v-for="s in c.items" :key="s.id" class="string" :class="{ missing: !s.text }"><code>{{ s.key }}</code> {{ s.en }} → <em>{{ s.text || "—" }}</em> <button type="button" class="edit" @click="open(s)">Edit</button></li></ul>
    <form v-if="current" class="editor" @submit.prevent="save">
      <p><code>{{ current.key }}</code> · {{ current.en }}</p>
      <textarea name="draft" :value="e.draft" @input="type($event.target.value)"></textarea>
      <button type="button" class="suggest" :disabled="e.suggesting" @click="suggest">{{ e.suggesting ? "Suggesting…" : "Suggest" }}</button>
      <button type="submit" class="save" :disabled="guard && e.saving">Save</button>
      <p v-if="e.error" role="alert">{{ e.error }}</p><p v-else-if="e.notice" class="notice">{{ e.notice }}</p>
    </form>
  </div>`,
});
createApp(App).use(pinia).mount("#app");
void loadLocale("fr");
setInterval(() => void poll(), 5000);
