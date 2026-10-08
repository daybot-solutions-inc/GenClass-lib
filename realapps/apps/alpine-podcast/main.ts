// Podcast player with an up-next queue (Alpine.js 3 component; the Alpine store mirrors a runtime atom; fetch).
// Episodes are browsed per show and queued (episodeId is unique server-side); the queue order is a `position` on
// each entry and moving an entry up swaps two positions (two PATCHes). The player saves listening progress while
// playing. Latent bugs by flag: a progress PATCH on every tick without waiting (progressSave=every-tick: an older
// position can land last), swaps run in parallel (reorder=parallel: quick moves leave duplicate positions), queue
// buttons live while posting (addGuard=none) and show lists applied in arrival order (showSeq=blind).
import Alpine from "alpinejs";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Episode = { id: number; show: string; title: string; minutes: number };
type Queued = { id: number; episodeId: number; title: string; show: string; position: number; progress: number };
const PROGRESS_SAVE = flag("progressSave", "latest-only");
const REORDER = flag("reorder", "serial");
const ADD_GUARD = flag("addGuard", "pending") === "pending";
const SHOW_SEQ = flag("showSeq", "latest");

const player = rt.atom("player", { show: "Field Notes", episodes: [] as Episode[], queue: [] as Queued[], playing: 0, progress: 0, busy: [] as number[], loading: true, error: "", notice: "" });
type P = ReturnType<typeof player.get>;
Alpine.store("player", { ...player.get() });
player.subscribe((v) => Object.assign(Alpine.store("player") as object, v));
const sorted = (q: Queued[]) => [...q].sort((a, b) => a.position - b.position || a.id - b.id);
const setQ = (fn: (q: Queued[]) => Queued[]) => player.update((s) => ({ ...s, queue: sorted(fn(s.queue)) }));
const busy = (id: number, on: boolean) => player.update((s) => ({ ...s, busy: on ? [...s.busy, id] : s.busy.filter((x) => x !== id) }));

let showSeq = 0;
async function openShow(show: string) {
  const my = ++showSeq;
  player.update((s) => ({ ...s, show, loading: true, error: "" }));
  try {
    const eps = itemsOf<Episode>(await api(`/api/episodes?show=${encodeURIComponent(show)}&limit=20`));
    if (SHOW_SEQ === "latest" && my !== showSeq) return;
    player.update((s) => ({ ...s, episodes: eps, loading: false }));
  } catch (e) {
    if (my === showSeq) player.update((s) => ({ ...s, loading: false, error: errText(e, "loading episodes") }));
  }
}

async function enqueue(ep: Episode) {
  const s = player.get();
  if (s.queue.some((q) => q.episodeId === ep.id)) return;
  if (ADD_GUARD && s.busy.includes(ep.id)) return;
  busy(ep.id, true);
  try {
    const position = s.queue.reduce((a, q) => Math.max(a, q.position), 0) + 1;
    const saved = await api<Queued>(`/api/queue`, "POST", { episodeId: ep.id, title: ep.title, show: ep.show, position, progress: 0 });
    setQ((q) => [...q.filter((x) => x.id !== saved.id), saved]);
    player.update((x) => ({ ...x, notice: `“${ep.title}” added to Up Next.`, error: "" }));
  } catch (e) {
    player.update((x) => ({ ...x, error: e instanceof HttpError && e.status === 409 ? `“${ep.title}” is already queued.` : errText(e, "queueing the episode") }));
  } finally {
    busy(ep.id, false);
  }
}

let chain: Promise<unknown> = Promise.resolve();
function moveUp(item: Queued) {
  const run = async () => {
    const q = sorted(player.get().queue);
    const i = q.findIndex((x) => x.id === item.id);
    if (i <= 0) return;
    const a = q[i]!;
    const b = q[i - 1]!;
    setQ((all) => all.map((x) => (x.id === a.id ? { ...x, position: b.position } : x.id === b.id ? { ...x, position: a.position } : x)));
    try {
      const [sa, sb] = await Promise.all([api<Queued>(`/api/queue/${a.id}`, "PATCH", { position: b.position }), api<Queued>(`/api/queue/${b.id}`, "PATCH", { position: a.position })]);
      setQ((all) => all.map((x) => (x.id === sa.id ? { ...x, position: sa.position } : x.id === sb.id ? { ...x, position: sb.position } : x)));
    } catch (e) {
      player.update((x) => ({ ...x, error: errText(e, "reordering the queue") }));
      void loadQueue();
    }
  };
  if (REORDER === "serial") chain = chain.then(run, run);
  else void run();
}

async function remove(item: Queued) {
  busy(item.episodeId, true);
  try {
    await api(`/api/queue/${item.id}`, "DELETE");
    setQ((q) => q.filter((x) => x.id !== item.id));
    if (player.get().playing === item.id) stopTicker();
  } catch (e) {
    player.update((x) => ({ ...x, error: errText(e, "removing the episode") }));
  } finally {
    busy(item.episodeId, false);
  }
}

async function loadQueue() {
  try {
    const q = itemsOf<Queued>(await api(`/api/queue?limit=30`));
    player.update((s) => ({ ...s, queue: sorted(q) }));
  } catch (e) {
    player.update((s) => ({ ...s, error: errText(e, "loading your queue") }));
  }
}

// ----------------------------------------------------------------------------------------------- player
let ticker: ReturnType<typeof setInterval> | undefined;
let progressInflight = false;
let progressDirty = false;
function saveProgress() {
  const { playing, progress } = player.get();
  if (!playing) return;
  if (PROGRESS_SAVE === "latest-only" && progressInflight) {
    progressDirty = true;
    return;
  }
  progressInflight = true;
  api<Queued>(`/api/queue/${playing}`, "PATCH", { progress })
    .then((saved) => setQ((q) => q.map((x) => (x.id === saved.id ? { ...x, progress: saved.progress } : x))))
    .catch(() => undefined)
    .finally(() => {
      progressInflight = false;
      if (progressDirty) {
        progressDirty = false;
        saveProgress();
      }
    });
}
function play(item: Queued) {
  stopTicker();
  player.update((s) => ({ ...s, playing: item.id, progress: item.progress, notice: `Playing “${item.title}”.` }));
  ticker = setInterval(() => {
    player.update((s) => ({ ...s, progress: s.progress + 15 }));
    saveProgress();
  }, 1000);
}
function stopTicker() {
  clearInterval(ticker);
  ticker = undefined;
  saveProgress();
  player.update((s) => ({ ...s, playing: 0 }));
}

const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
document.getElementById("app")!.innerHTML = `<div x-data>
  <h1>Podcasts</h1>
  <nav class="shows"><template x-for="sh in ['Field Notes', 'Byte Size', 'Kitchen Table']" :key="sh"><button type="button" :class="{ current: $store.player.show === sh }" @click="openShow(sh)" x-text="sh"></button></template></nav>
  <p role="alert" x-show="$store.player.error" x-text="$store.player.error"></p>
  <p class="notice" x-show="!$store.player.error && $store.player.notice" x-text="$store.player.notice"></p>
  <span class="muted" x-show="$store.player.loading">Loading…</span>
  <ul class="episodes"><template x-for="ep in $store.player.episodes" :key="ep.id"><li class="episode"><span x-text="ep.title + ' · ' + ep.minutes + ' min'"></span>
    <template x-if="!$store.player.queue.some(q => q.episodeId === ep.id)"><button type="button" class="enqueue" :disabled="guard && $store.player.busy.includes(ep.id)" @click="enqueue(ep)">Add to Up Next</button></template></li></template></ul>
  <section class="up-next"><h2>Up Next</h2>
    <p class="now" x-show="$store.player.playing">Now playing · <span x-text="fmt($store.player.progress)"></span> <button type="button" class="pause" @click="stopTicker()">Pause</button></p>
    <ol><template x-for="(q, i) in $store.player.queue" :key="q.id"><li class="queued"><span x-text="q.title + ' (' + q.show + ') · ' + fmt(q.progress)"></span>
      <button type="button" class="play" @click="play(q)">Play</button> <template x-if="i > 0"><button type="button" class="up" @click="moveUp(q)">Move up</button></template> <button type="button" class="remove" :disabled="$store.player.busy.includes(q.episodeId)" @click="remove(q)">Remove</button></li></template></ol></section>
</div>`;
Object.assign(window as any, { openShow, enqueue, moveUp, remove, play, stopTicker, fmt, guard: ADD_GUARD });
Alpine.start();
void openShow("Field Notes");
void loadQueue();
