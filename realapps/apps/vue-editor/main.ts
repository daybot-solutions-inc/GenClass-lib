// Team notes editor (Vue 3 templates + axios over XMLHttpRequest, state in runtime atoms bridged to Vue).
// Debounced autosave PUTs the note and applies the server's echo. Latent bugs by flag: overlapping saves
// (save=overlap), applying the echo over newer typing (echo=blind), no optimistic-concurrency version
// (versionCheck=false: last writer wins over a teammate's edit).
import { createApp, defineComponent, computed } from "vue";
import axios from "axios";
import { rt, flag } from "../_shared/genclass";
import { useAtom } from "../_shared/vue-atom";

type Note = { id: number; title: string; body: string; version: number };
const SAVE = flag("save", "serialize") as "serialize" | "overlap";
const ECHO = flag("echo", "if-unchanged") as "if-unchanged" | "blind" | "version-only";
const VCHECK = Boolean(flag("versionCheck", true));
const DEBOUNCE = Number(flag("debounce", 600));

const api = axios.create({ baseURL: "/api", timeout: 8000 });
const list = rt.atom("list", { notes: [] as Note[], loading: false });
const editor = rt.atom("editor", { id: 0, title: "", body: "", version: 0, dirty: false, saving: false, error: "" });

async function loadList() {
  list.update((s) => ({ ...s, loading: true }));
  try {
    const r = await api.get<Note[]>("/notes");
    list.set({ notes: r.data, loading: false });
  } catch {
    list.update((s) => ({ ...s, loading: false }));
  }
}

async function open(id: number) {
  editor.set({ id, title: "", body: "", version: 0, dirty: false, saving: false, error: "" });
  try {
    const r = await api.get<Note>(`/notes/${id}`);
    editor.update((e) => (e.id === id ? { ...e, title: r.data.title, body: r.data.body, version: r.data.version } : e));
  } catch (err) {
    editor.update((e) => ({ ...e, error: "Could not open the note" }));
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<unknown> | null = null;
let again = false;

async function save() {
  if (SAVE === "serialize" && inflight) {
    again = true;
    return;
  }
  const e = editor.get();
  if (!e.id) return;
  const sent = { title: e.title, body: e.body };
  editor.update((x) => ({ ...x, saving: true }));
  const p = api
    .put<Note>(`/notes/${e.id}`, VCHECK ? { ...sent, version: e.version } : sent)
    .then((r) => {
      editor.update((cur) => {
        if (cur.id !== r.data.id) return cur;
        if (ECHO === "blind") return { ...cur, title: r.data.title, body: r.data.body, version: r.data.version, dirty: false, saving: false };
        if (ECHO === "version-only") return { ...cur, version: r.data.version, saving: false, dirty: cur.body !== sent.body || cur.title !== sent.title };
        const same = cur.body === sent.body && cur.title === sent.title;
        return same ? { ...cur, title: r.data.title, body: r.data.body, version: r.data.version, dirty: false, saving: false } : { ...cur, version: r.data.version, saving: false };
      });
      list.update((s) => ({ ...s, notes: s.notes.map((n) => (n.id === r.data.id ? r.data : n)) }));
    })
    .catch((err) => {
      if (err?.response?.status === 409) {
        const cur = err.response.data?.current as Note | undefined;
        editor.update((x) => ({ ...x, saving: false, error: "Someone else changed this note", ...(cur ? { version: cur.version } : {}) }));
      } else editor.update((x) => ({ ...x, saving: false, error: "Save failed" }));
    })
    .finally(() => {
      if (inflight === p) inflight = null;
      if (again) {
        again = false;
        void save();
      }
    });
  inflight = p;
}

function edit(field: "title" | "body", v: string) {
  editor.update((e) => ({ ...e, [field]: v, dirty: true, error: "" }));
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void save(), DEBOUNCE);
}

async function createNote() {
  try {
    const r = await api.post<Note>("/notes", { title: "Untitled", body: "" });
    list.update((s) => ({ ...s, notes: [...s.notes, r.data] }));
    void open(r.data.id);
  } catch {
    editor.update((e) => ({ ...e, error: "Could not create a note" }));
  }
}

async function remove() {
  const id = editor.get().id;
  if (!id) return;
  try {
    await api.delete(`/notes/${id}`);
    list.update((s) => ({ ...s, notes: s.notes.filter((n) => n.id !== id) }));
    editor.set({ id: 0, title: "", body: "", version: 0, dirty: false, saving: false, error: "" });
  } catch {
    editor.update((e) => ({ ...e, error: "Delete failed" }));
  }
}

const App = defineComponent({
  setup() {
    const l = useAtom(list);
    const e = useAtom(editor);
    const status = computed(() => (e.value.saving ? "Saving…" : e.value.dirty ? "Unsaved changes" : e.value.id ? "Saved" : ""));
    return { l, e, status, open, edit, createNote, remove, reload: loadList };
  },
  template: `
    <div class="notes">
      <aside>
        <button class="new-note" @click="createNote">New note</button>
        <button class="reload" @click="reload">Reload</button>
        <p v-if="l.loading">Loading notes…</p>
        <ul><li v-for="n in l.notes" :key="n.id"><a href="#" class="note-item" @click.prevent="open(n.id)">{{ n.title }}</a></li></ul>
      </aside>
      <main v-if="e.id">
        <input name="title" :value="e.title" @input="edit('title', $event.target.value)" aria-label="Title" />
        <textarea name="body" :value="e.body" @input="edit('body', $event.target.value)" aria-label="Note"></textarea>
        <p class="status">{{ status }}</p>
        <p v-if="e.error" role="alert">{{ e.error }}</p>
        <button class="delete-note" @click="remove">Delete</button>
      </main>
    </div>`,
});

createApp(App).mount("#app");
void loadList();
