// Team wiki editor (Vue 3 templates + fetch; state in a runtime atom bridged with useAtom). Writers open a page,
// edit its body and save with the version they started from; a 409 opens a conflict panel (keep mine / take theirs).
// Teammates edit pages all the time and the page list polls. Latent bugs by flag: conflicts auto-resolved
// (conflict=overwrite: their edit is lost; conflict=take-theirs: my draft is dropped silently), page loads applied
// whatever page is open by then (openSeq=blind), Save live while saving (saveGuard=none) and the base version
// refreshed from the list poll without the body (baseVersion=from-poll: a save overwrites a change I never saw).
import { createApp, defineComponent } from "vue";
import { rt, flag } from "../_shared/genclass";
import { useAtom } from "../_shared/vue-atom";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Page = { id: number; title: string; space: string; body: string; editedBy: string; version: number };
const CONFLICT = flag("conflict", "prompt");
const OPEN_SEQ = flag("openSeq", "latest");
const SAVE_GUARD = flag("saveGuard", "pending") === "pending";
const BASE_VERSION = flag("baseVersion", "at-open");

const wiki = rt.atom("wiki", { list: [] as Page[], openId: 0, pageId: 0, title: "", draft: "", baseVersion: 0, theirs: null as Page | null, saving: false, loading: false, error: "", notice: "" });

async function poll() {
  try {
    const list = itemsOf<Page>(await api(`/api/pages?limit=30`));
    wiki.update((w) => {
      const open = list.find((p) => p.id === w.pageId);
      return { ...w, list, baseVersion: BASE_VERSION === "from-poll" && open && !w.saving ? open.version : w.baseVersion };
    });
  } catch {
    /* keep the last list */
  }
}

async function open(id: number) {
  wiki.update((w) => ({ ...w, openId: id, loading: true, theirs: null, error: "", notice: "" }));
  try {
    const p = await api<Page>(`/api/pages/${id}`);
    if (OPEN_SEQ === "latest" && wiki.get().openId !== id) return;
    wiki.update((w) => ({ ...w, pageId: p.id, title: p.title, draft: p.body, baseVersion: p.version, loading: false }));
  } catch (e) {
    if (wiki.get().openId === id) wiki.update((w) => ({ ...w, loading: false, error: errText(e, "opening the page") }));
  }
}

async function save(body?: string, version?: number) {
  const w0 = wiki.get();
  if (SAVE_GUARD && w0.saving) return;
  if (!w0.pageId) return;
  wiki.update((w) => ({ ...w, saving: true, error: "", notice: "" }));
  const text = body ?? w0.draft;
  try {
    const p = await api<Page>(`/api/pages/${w0.pageId}`, "PATCH", { body: text, editedBy: "you", version: version ?? w0.baseVersion });
    wiki.update((w) => ({ ...w, baseVersion: p.version, theirs: null, list: w.list.map((x) => (x.id === p.id ? p : x)), notice: `Saved “${p.title}”.` }));
  } catch (e) {
    const cur = e instanceof HttpError && e.status === 409 ? (e.body?.current as Page | undefined) : undefined;
    if (!cur) {
      wiki.update((w) => ({ ...w, error: errText(e, "saving the page") }));
    } else if (CONFLICT === "overwrite") {
      wiki.update((w) => ({ ...w, saving: false }));
      return save(text, cur.version);
    } else if (CONFLICT === "take-theirs") {
      wiki.update((w) => ({ ...w, draft: cur.body, title: cur.title, baseVersion: cur.version, notice: "Page refreshed." }));
    } else {
      wiki.update((w) => ({ ...w, theirs: cur, error: `${cur.editedBy} changed this page while you were editing.` }));
    }
  } finally {
    wiki.update((w) => ({ ...w, saving: false }));
  }
}
function keepMine() {
  const t = wiki.get().theirs;
  if (t) void save(wiki.get().draft, t.version);
}
function takeTheirs() {
  const t = wiki.get().theirs;
  if (t) wiki.update((w) => ({ ...w, draft: t.body, title: t.title, baseVersion: t.version, theirs: null, error: "" }));
}

const App = defineComponent({
  setup() {
    const w = useAtom(wiki);
    return { w, guard: SAVE_GUARD, open, keepMine, takeTheirs, save: () => void save(), edit: (v: string) => wiki.update((x) => ({ ...x, draft: v })) };
  },
  template: `<div class="wiki">
    <h1>Team wiki</h1>
    <ul class="pages"><li v-for="p in w.list" :key="p.id" class="page" :class="{ current: p.id === w.pageId }">{{ p.title }} <small>{{ p.space }} · last edit {{ p.editedBy }}</small> <button type="button" class="open" @click="open(p.id)">Open</button></li></ul>
    <p v-if="w.loading" class="muted">Opening…</p>
    <section v-if="w.pageId" class="editor">
      <h2>{{ w.title }}</h2>
      <textarea name="body" :value="w.draft" @input="edit($event.target.value)"></textarea>
      <button type="button" class="save" :disabled="guard && w.saving" @click="save">{{ w.saving ? "Saving…" : "Save" }}</button>
      <p v-if="w.error" role="alert">{{ w.error }}</p><p v-else-if="w.notice" class="notice">{{ w.notice }}</p>
      <div v-if="w.theirs" class="conflict"><p>Their version: {{ w.theirs.body }}</p>
        <button type="button" class="keep-mine" @click="keepMine">Keep mine</button> <button type="button" class="take-theirs" @click="takeTheirs">Take theirs</button></div>
    </section>
  </div>`,
});
createApp(App).mount("#app");
void poll();
setInterval(() => void poll(), 4000);
