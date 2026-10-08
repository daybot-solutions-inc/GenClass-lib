// Collaborative party playlist (React 19 + nanostores map stores read with @nanostores/react useStore; fetch +
// WebSocket). Guests search the catalog (typeahead), add songs (one copy per song: the server answers 409) and upvote
// tracks; the queue is ordered by votes and changes live as others vote, add and remove. Both stores are registered
// with rt.guard: async results go through the guarded handles, keystrokes set the query key directly. Latent bugs by
// flag: a request per keystroke applied in arrival order (search=every-key: results for "m" replace those for
// "mo"), the live "created" echo of your own add appended next to the POST answer (add=append: the song shows
// twice), upvotes not rolled back when they fail (vote=optimistic; vote=wait is slower but safe), pushes applied in
// arrival order (live=blind: an older vote count wins) and reconnects without a reload (reconnect=naive).
import { createRoot } from "react-dom/client";
import { map } from "nanostores";
import { useStore } from "@nanostores/react";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError, isAbort, liveTopic } from "../_shared/w3-http";

type Song = { id: number; title: string; artist: string; seconds: number };
type Track = { id: number; catalogId: number; title: string; artist: string; addedBy: string; votes: number; position: number; version: number };
type Party = { tracks: Track[]; voted: number[]; pending: number[]; adding: number[]; live: boolean; error: string; notice: string };
type Search = { q: string; results: Song[]; searching: boolean };

const SEARCH = flag("search", "debounce-abort");
const ADD = flag("add", "dedupe");
const VOTE = flag("vote", "optimistic-rollback") as "optimistic-rollback" | "optimistic" | "wait";
const LIVE = flag("live", "newer-wins");
const RECONNECT = flag("reconnect", "resync");
const ME = "you";

const $party = map<Party>({ tracks: [], voted: [], pending: [], adding: [], live: false, error: "", notice: "" });
const $search = map<Search>({ q: "", results: [], searching: false });
const party = rt.guard<Party>("party", { get: () => $party.get(), set: (v) => $party.set(v), subscribe: (fn) => $party.listen(() => fn()) });
const search = rt.guard<Search>("search", { get: () => $search.get(), set: (v) => $search.set(v), subscribe: (fn) => $search.listen(() => fn()) });

const ordered = (ts: Track[]) => [...ts].sort((a, b) => b.votes - a.votes || a.position - b.position || a.id - b.id);
function upsert(p: Party, t: Track, created = false): Party {
  const cur = p.tracks.find((x) => x.id === t.id);
  if (cur && LIVE === "newer-wins" && Number(t.version) < Number(cur.version)) return p;
  const tracks = cur && !(created && ADD === "append") ? p.tracks.map((x) => (x.id === t.id ? t : x)) : [...p.tracks, t];
  return { ...p, tracks: ordered(tracks) };
}
const mark = (key: "pending" | "adding", id: number, on: boolean) => party.update((p) => ({ ...p, [key]: on ? [...p[key], id] : p[key].filter((x) => x !== id) }));

// ------------------------------------------------------------------------------------------- search
let timer: ReturnType<typeof setTimeout> | undefined;
let ctl: AbortController | null = null;
let seq = 0;
async function runSearch(q: string) {
  const my = ++seq;
  ctl?.abort();
  ctl = SEARCH === "debounce-abort" ? new AbortController() : null;
  try {
    const results = itemsOf<Song>(await api(`/api/catalog?q=${encodeURIComponent(q)}&limit=6`, "GET", undefined, {}, ctl?.signal));
    search.update((s) => ({ ...s, results, searching: SEARCH === "debounce-abort" ? my !== seq : false }));
  } catch (e) {
    if (!isAbort(e)) search.update((s) => ({ ...s, searching: false }));
  }
}
function onQuery(q: string) {
  $search.set({ ...$search.get(), q, searching: Boolean(q.trim()) });
  clearTimeout(timer);
  if (!q.trim()) {
    ctl?.abort();
    $search.set({ ...$search.get(), results: [], searching: false });
    return;
  }
  if (SEARCH === "debounce-abort") timer = setTimeout(() => void runSearch(q.trim()), 250);
  else void runSearch(q.trim());
}

// ------------------------------------------------------------------------------------------- playlist
async function load() {
  try {
    const tracks = itemsOf<Track>(await api(`/api/tracks?limit=50`));
    party.update((p) => ({ ...p, tracks: ordered(tracks) }));
  } catch (e) {
    party.update((p) => ({ ...p, error: errText(e, "loading the playlist") }));
  }
}

async function add(song: Song) {
  const p = $party.get();
  if (p.adding.includes(song.id) || p.tracks.some((t) => t.catalogId === song.id)) return;
  mark("adding", song.id, true);
  try {
    const position = p.tracks.reduce((a, t) => Math.max(a, t.position), 0) + 1;
    const saved = await api<Track>(`/api/tracks`, "POST", { catalogId: song.id, title: song.title, artist: song.artist, addedBy: ME, votes: 0, position });
    party.update((x) => ({ ...upsert(x, saved), notice: `Added “${saved.title}”.`, error: "" }));
  } catch (e) {
    party.update((x) => ({ ...x, error: e instanceof HttpError && e.status === 409 ? `“${song.title}” is already on the playlist.` : errText(e, "adding the song") }));
  } finally {
    mark("adding", song.id, false);
  }
}

async function vote(t: Track) {
  const p = $party.get();
  if (p.pending.includes(t.id) || p.voted.includes(t.id)) return;
  mark("pending", t.id, true);
  if (VOTE !== "wait") party.update((x) => ({ ...x, voted: [...x.voted, t.id], tracks: ordered(x.tracks.map((y) => (y.id === t.id ? { ...y, votes: y.votes + 1 } : y))), error: "" }));
  try {
    const saved = await api<Track>(`/api/tracks/${t.id}/upvote`, "POST");
    party.update((x) => ({ ...upsert(x, saved), voted: x.voted.includes(t.id) ? x.voted : [...x.voted, t.id] }));
  } catch (e) {
    party.update((x) => {
      const back = VOTE === "optimistic-rollback" ? { ...x, voted: x.voted.filter((id) => id !== t.id), tracks: ordered(x.tracks.map((y) => (y.id === t.id ? { ...y, votes: y.votes - 1 } : y))) } : x;
      return { ...back, error: errText(e, "your vote") };
    });
  } finally {
    mark("pending", t.id, false);
  }
}

async function remove(t: Track) {
  if ($party.get().pending.includes(t.id)) return;
  mark("pending", t.id, true);
  try {
    await api(`/api/tracks/${t.id}`, "DELETE");
    party.update((x) => ({ ...x, tracks: x.tracks.filter((y) => y.id !== t.id), notice: `Removed “${t.title}”.` }));
  } catch (e) {
    party.update((x) => ({ ...x, error: errText(e, "removing the song") }));
  } finally {
    mark("pending", t.id, false);
  }
}

// ------------------------------------------------------------------------------------------- view
function App() {
  const p = useStore($party);
  const s = useStore($search);
  const onList = new Set(p.tracks.map((t) => t.catalogId));
  return (
    <main className="party">
      <h1>Friday party playlist</h1>
      <p className="conn">{p.live ? "live" : "reconnecting…"} · {p.tracks.length} songs</p>
      <section className="finder">
        <input name="q" placeholder="Search songs or artists" value={s.q} onChange={(e) => onQuery(e.target.value)} />
        {s.searching ? <span className="muted"> searching…</span> : null}
        <ul className="results">
          {s.results.map((r) => (
            <li key={r.id} className="result">
              {r.title} — {r.artist}{" "}
              {onList.has(r.id) ? (
                <em>on the list</em>
              ) : (
                <button type="button" className="add" disabled={p.adding.includes(r.id)} onClick={() => void add(r)}>
                  Add
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
      {p.error ? <p role="alert">{p.error}</p> : p.notice ? <p className="notice">{p.notice}</p> : null}
      <ol className="queue">
        {p.tracks.map((t, i) => (
          <li key={`${t.id}-${i}`} className={`track${t.addedBy === ME ? " mine" : ""}`}>
            {t.title} — {t.artist} · {t.votes} votes · added by {t.addedBy}{" "}
            <button type="button" className="vote" disabled={p.voted.includes(t.id) || p.pending.includes(t.id)} onClick={() => void vote(t)}>
              {p.voted.includes(t.id) ? "Voted" : "▲ Upvote"}
            </button>
            {t.addedBy === ME ? (
              <button type="button" className="remove" disabled={p.pending.includes(t.id)} onClick={() => void remove(t)}>
                Remove
              </button>
            ) : null}
          </li>
        ))}
      </ol>
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
let everUp = false;
liveTopic(
  "tracks",
  (m) => {
    if (m.type === "deleted") party.update((p) => ({ ...p, tracks: p.tracks.filter((t) => t.id !== Number(m.id)) }));
    else if (m.item) party.update((p) => upsert(p, m.item as Track, m.type === "created"));
  },
  (up) => {
    party.update((p) => ({ ...p, live: up }));
    if (up && everUp && RECONNECT === "resync") void load();
    if (up) everUp = true;
  },
);
void load();
