// Subtitle editor (Vue 3 templates + @tanstack/vue-query + axios). The cues of an episode are listed in 30-second
// windows (`start__gte=..&start__lt=..&sort=start`, previous/next window) and polled, since collaborators work on
// other cues at the same time. Editing a cue autosaves after a pause (versioned PATCH {text, version}); timing is
// nudged with relative actions (POST /cues/:id/nudge {by: ±100}). The ["cues"] cache is registered with rt.guard
// (the app's window loads, echoes and nudges go through GenClass; query fetches are traced). Latent bugs by flag:
// the autosave answer written back into the editor (echo=blind: what was typed while it was on its way is lost),
// autosaves of one cue sent side by side (save=parallel: the second one 409s on our own first save and is reported
// as someone else's change), window jumps that don't cancel the previous window or the poll in flight
// (windowSeq=blind: an older window lands under the new header), no debounce (debounce=0: a save per keystroke) and
// nudge buttons live while a nudge is on its way (nudgeGuard=none: a double click moves the cue twice, answers
// applied in arrival order).
import { createApp, defineComponent, computed, ref } from "vue";
import { QueryClient, VueQueryPlugin, useQuery } from "@tanstack/vue-query";
import axios from "axios";
import { rt, flag } from "../_shared/genclass";
import { useAtom } from "../_shared/vue-atom";

type Cue = { id: number; n: number; start: number; end: number; speaker: string; text: string; version: number };
type CueWindow = { from: number; items: Cue[] };

const KEEP_TYPING = flag("echo", "keep-newer-typing") === "keep-newer-typing";
const SAVE = flag("save", "serial") as "serial" | "parallel";
const LATEST = flag("windowSeq", "latest") === "latest";
const DEBOUNCE = Number(flag("debounce", 600));
const NUDGE_GUARD = flag("nudgeGuard", "pending") === "pending";
const WINDOW = 30000;
const LENGTH = 180000;

const http = axios.create({ baseURL: "/api", timeout: 10000 });
const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 2000 } } });
const KEY = ["cues"];
const cues = rt.guard<CueWindow>("cues", {
  get: () => qc.getQueryData<CueWindow>(KEY) ?? { from: 0, items: [] },
  set: (v) => void qc.setQueryData<CueWindow>(KEY, v),
  subscribe: (fn) =>
    qc.getQueryCache().subscribe((e) => {
      if (e.type === "updated" && e.query.queryKey[0] === "cues" && e.action.type === "success") fn();
    }),
});
const editor = rt.atom("editor", { from: 0, editing: null as number | null, label: "", status: "", error: "" });
/** Autosaves on their way (shown as "Saving…"). */
const saving = ref(0);
/** Unsaved text per cue id (what is in the editor). */
const drafts = rt.atom("drafts", {} as Record<string, string>);
const draftOf = (id: number) => drafts.get()[String(id)] ?? "";
const setDraft = (id: number, v: string) => drafts.update((d) => ({ ...d, [String(id)]: v }));

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const fmt = (ms: number) => `${pad(Math.floor(ms / 60000))}:${pad(Math.floor((ms % 60000) / 1000))}.${pad(Math.max(0, ms) % 1000, 3)}`;
const statusOf = (e: unknown) => (axios.isAxiosError(e) ? (e.response?.status ?? 0) : 0);
const conflictOf = (e: unknown) => (statusOf(e) === 409 ? ((e as { response: { data: { current?: Cue } } }).response.data.current ?? null) : null);
const errMsg = (e: unknown, what: string) => (statusOf(e) === 0 ? `Network problem — ${what} didn't go through.` : `${what[0]!.toUpperCase()}${what.slice(1)} failed (${statusOf(e)}).`);
const cueById = (id: number) => cues.get().items.find((c) => c.id === id);
const patchCue = (id: number, fn: (c: Cue) => Cue) => cues.update((w) => ({ ...w, items: w.items.map((c) => (c.id === id ? fn(c) : c)) }));

async function fetchWindow(from: number, signal?: AbortSignal): Promise<CueWindow> {
  const { data } = await http.get<{ items: Cue[] }>("/cues", { params: { start__gte: from, start__lt: from + WINDOW, sort: "start", limit: 50 }, signal });
  const have = qc.getQueryData<CueWindow>(KEY);
  // keep what we already know to be newer (a save or nudge answered while this list was on its way)
  const items = (data.items ?? []).map((c) => {
    const mine = have && have.from === from ? have.items.find((x) => x.id === c.id) : undefined;
    return mine && mine.version > c.version ? mine : c;
  });
  return { from, items };
}

// ------------------------------------------------------------------------------------------ autosave
async function sendText(id: number, text: string) {
  const cur = cueById(id);
  if (!cur) return;
  saving.value++;
  if (editor.get().error) editor.update((e) => ({ ...e, error: "" }));
  try {
    let saved: Cue;
    try {
      saved = (await http.patch<Cue>(`/cues/${id}`, { text, version: cur.version })).data;
    } catch (err) {
      const current = conflictOf(err);
      if (!current) throw err;
      if (current.text !== cur.text) {
        patchCue(id, (c) => ({ ...c, ...current })); // a collaborator rewrote this line: show theirs, keep the draft
        throw err;
      }
      saved = (await http.patch<Cue>(`/cues/${id}`, { text, version: current.version })).data; // only the timing moved
    }
    patchCue(id, (c) => ({ ...c, text: saved.text, start: saved.start, end: saved.end, version: Math.max(c.version, saved.version) }));
    if (editor.get().editing === id) {
      if (!KEEP_TYPING) setDraft(id, saved.text);
      editor.update((e) => ({ ...e, status: !KEEP_TYPING || draftOf(id) === saved.text ? "All changes saved" : e.status }));
    }
  } catch (err) {
    editor.update((e) => ({ ...e, status: "", error: conflictOf(err) ? `Someone else changed cue ${cur.n} — your text isn't saved yet.` : errMsg(err, `saving cue ${cur.n}`) }));
  } finally {
    saving.value--;
  }
}

const queued = new Map<number, string>();
const busy = new Set<number>();
let timer: ReturnType<typeof setTimeout> | undefined;

async function autosave() {
  timer = undefined;
  const e = editor.get();
  const id = e.editing;
  const cue = id === null ? undefined : cueById(id);
  if (id === null || !cue || cue.text === draftOf(id)) return;
  if (SAVE === "parallel") return sendText(id, draftOf(id));
  queued.set(id, draftOf(id)); // serial: one save per cue at a time, the latest text goes next
  if (busy.has(id)) return;
  busy.add(id);
  try {
    for (let t = queued.get(id); t !== undefined; t = queued.get(id)) {
      queued.delete(id);
      await sendText(id, t);
    }
  } finally {
    busy.delete(id);
  }
}
function typed(v: string) {
  const id = editor.get().editing;
  if (id === null) return;
  setDraft(id, v);
  editor.update((e) => ({ ...e, status: "Unsaved changes" }));
  clearTimeout(timer);
  timer = setTimeout(() => void autosave(), DEBOUNCE);
}
function flush() {
  if (timer === undefined) return;
  clearTimeout(timer);
  void autosave();
}

// -------------------------------------------------------------------------------------------- nudges
const nudging = ref<number[]>([]);
async function nudge(c: Cue, by: number) {
  if (NUDGE_GUARD && nudging.value.includes(c.id)) return;
  if (c.start + by < 0) return; // a cue can't start before the video does
  nudging.value = [...nudging.value, c.id];
  editor.update((e) => ({ ...e, error: "" }));
  try {
    const { data } = await http.post<Cue>(`/cues/${c.id}/nudge`, { by });
    patchCue(c.id, (x) => ({ ...x, start: data.start, version: Math.max(x.version, data.version) }));
  } catch (err) {
    editor.update((e) => ({ ...e, error: errMsg(err, `moving cue ${c.n}`) }));
  } finally {
    const i = nudging.value.indexOf(c.id);
    if (i >= 0) nudging.value = [...nudging.value.slice(0, i), ...nudging.value.slice(i + 1)];
  }
}

async function go(delta: number) {
  const from = Math.min(LENGTH - WINDOW, Math.max(0, editor.get().from + delta * WINDOW));
  if (from === editor.get().from) return;
  flush();
  drafts.set({});
  editor.update((e) => ({ ...e, from, editing: null, label: "", status: "", error: "" }));
  if (LATEST) return void qc.refetchQueries({ queryKey: KEY }); // cancels the window (or poll) still on its way
  try {
    cues.set(await fetchWindow(from));
  } catch (err) {
    editor.update((e) => ({ ...e, error: errMsg(err, "loading the cues") }));
  }
}

const App = defineComponent({
  setup() {
    const u = useAtom(editor);
    const d = useAtom(drafts);
    const q = useQuery({ queryKey: KEY, queryFn: ({ signal }: { signal: AbortSignal }) => fetchWindow(editor.get().from, LATEST ? signal : undefined), refetchInterval: 5000 });
    const list = computed(() => q.data.value?.items ?? []);
    // the previous window stays on screen (dimmed) until the requested one arrives
    const pending = computed(() => !!q.data.value && q.data.value.from !== u.value.from);
    return {
      u,
      list,
      saving,
      draft: computed(() => (u.value.editing === null ? "" : (d.value[String(u.value.editing)] ?? ""))),
      pending,
      fetching: q.isFetching,
      failed: q.isError,
      fmt,
      nudging,
      NUDGE_GUARD,
      WINDOW,
      LENGTH,
      typed,
      nudge,
      go,
      edit: (c: Cue) => {
        flush();
        drafts.set({ [String(c.id)]: c.text });
        editor.update((e) => ({ ...e, editing: c.id, label: `Cue ${c.n} · ${c.speaker}`, status: "", error: "" }));
      },
      done: () => {
        flush();
        drafts.set({});
        editor.update((e) => ({ ...e, editing: null, label: "", status: "" }));
      },
    };
  },
  template: `
    <div class="subtitles">
      <header>
        <h1>Harbour Lights · S1E3 · English subtitles</h1>
        <p class="where">{{ fmt(u.from) }} – {{ fmt(u.from + WINDOW) }} of {{ fmt(LENGTH) }}{{ fetching ? " · syncing…" : "" }}</p>
      </header>
      <nav class="windows">
        <button class="prev-window" :disabled="u.from <= 0" @click="go(-1)">Previous 30 s</button>
        <button class="next-window" :disabled="u.from + WINDOW >= LENGTH" @click="go(1)">Next 30 s</button>
      </nav>
      <p v-if="u.error" role="alert">{{ u.error }}</p>
      <p v-if="failed && !list.length" role="alert">Cues couldn't be loaded.</p>
      <section v-if="u.editing !== null" class="editor">
        <h2>{{ u.label }}</h2>
        <form class="cue-editor" @submit.prevent>
          <textarea name="text" aria-label="Cue text" :value="draft" @input="typed($event.target.value)"></textarea>
          <p class="save-state">{{ saving > 0 ? "Saving…" : u.status }}</p>
          <button type="button" class="done" @click="done">Done</button>
        </form>
      </section>
      <p v-if="pending || (!list.length && fetching)" class="loading">Loading {{ fmt(u.from) }} – {{ fmt(u.from + WINDOW) }}…</p>
      <ol class="cues" :class="{ stale: pending }">
        <li v-for="c in list" :key="c.id" class="cue" :class="{ editing: c.id === u.editing }">
          <span class="time">{{ fmt(c.start) }} → {{ fmt(c.end) }}</span>
          <strong>{{ c.speaker }}</strong>: {{ c.text }}
          <button class="edit" @click="edit(c)">Edit</button>
          <button class="nudge earlier" :disabled="c.start < 100 || (NUDGE_GUARD && nudging.includes(c.id))" @click="nudge(c, -100)">Earlier</button>
          <button class="nudge later" :disabled="NUDGE_GUARD && nudging.includes(c.id)" @click="nudge(c, 100)">Later</button>
        </li>
      </ol>
    </div>`,
});

createApp(App).use(VueQueryPlugin, { queryClient: qc }).mount("#app");
