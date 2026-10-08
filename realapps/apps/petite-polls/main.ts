// Team polls (petite-vue templates; fetch + WebSocket; state in a runtime atom mirrored into a petite-vue reactive
// scope). Votes are relative, non-idempotent POST /options/:id/vote; counts stream in over a WebSocket as colleagues
// vote, and the HTTP echo of your own vote races the pushed update for the same option. Latent bugs by flag: no
// single-vote guard (voteGuard=none: a double click or a second click on your choice counts twice), echoes and
// pushes applied in arrival order (echo=blind: an older count overwrites a newer one), the poll total kept as a
// running count that pushes don't touch (totals=incremental: it drifts from the option counts), reconnect without
// reloading the counts missed while the socket was down (reconnect=naive).
import { createApp, reactive } from "petite-vue";
import { rt, flag } from "../_shared/genclass";

type Poll = { id: number; title: string; closes: string };
type Option = { id: number; pollId: number; label: string; key: string; votes: number; updatedAt?: string };

const VOTE_GUARD = flag("voteGuard", "one-per-poll") as "one-per-poll" | "none";
const ECHO = flag("echo", "newest") as "newest" | "blind";
const TOTALS = flag("totals", "derive") as "derive" | "incremental";
const RECONNECT = flag("reconnect", "resync") as "resync" | "naive";

const store = rt.atom("polls", { polls: [] as Poll[], current: 0, options: [] as Option[], total: 0, mine: {} as Record<string, number>, draft: "", live: false, error: "", notice: "" });
const s = reactive({ ...store.get() });
store.subscribe((v) => Object.assign(s, v));

const sumVotes = (os: Option[]) => os.reduce((a, o) => a + Number(o.votes || 0), 0);
const voting = new Set<number>(); // polls with a vote request in flight
let loadSeq = 0;

/** Keep an option unless the incoming copy is older (by server timestamp). */
function merge(cur: Option, inc: Option): Option {
  if (ECHO === "newest" && cur.updatedAt && inc.updatedAt && inc.updatedAt < cur.updatedAt) return cur;
  return { ...cur, ...inc, votes: Number(inc.votes) };
}
function withOptions(st: ReturnType<typeof store.get>, options: Option[], delta = 0) {
  return { ...st, options, total: TOTALS === "derive" ? sumVotes(options) : st.total + delta };
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  return (await r.json()) as T;
}

async function loadOptions(pollId: number) {
  const seq = ++loadSeq;
  try {
    const body = await getJson<{ items: Option[] }>(`/api/options?pollId=${pollId}&limit=50`);
    if (seq !== loadSeq || store.get().current !== pollId) return;
    const items = Array.isArray(body.items) ? body.items : [];
    store.update((st) => ({ ...st, options: items, total: sumVotes(items), error: "" }));
  } catch {
    if (seq === loadSeq) store.update((st) => ({ ...st, error: "Couldn't load this poll's results." }));
  }
}

function open(pollId: number) {
  if (store.get().current === pollId) return;
  store.update((st) => ({ ...st, current: pollId, options: [], total: 0, draft: "", notice: "", error: "" }));
  void loadOptions(pollId);
}

async function vote(o: Option) {
  const st = store.get();
  const key = String(o.pollId);
  const prev = st.mine[key];
  if (VOTE_GUARD === "one-per-poll" && (voting.has(o.pollId) || prev === o.id)) return;
  voting.add(o.pollId);
  // optimistic: move my vote
  store.update((x) => {
    const options = x.options.map((y) => (y.id === o.id ? { ...y, votes: y.votes + 1 } : prev !== undefined && y.id === prev ? { ...y, votes: Math.max(0, y.votes - 1) } : y));
    return { ...withOptions(x, options, prev !== undefined && prev !== o.id ? 0 : 1), mine: { ...x.mine, [key]: o.id }, error: "", notice: "" };
  });
  try {
    if (prev !== undefined && prev !== o.id) {
      const old = await getJson<Option>(`/api/options/${prev}/unvote`, { method: "POST" });
      store.update((x) => withOptions(x, x.options.map((y) => (y.id === old.id ? merge(y, old) : y))));
    }
    const saved = await getJson<Option>(`/api/options/${o.id}/vote`, { method: "POST" });
    store.update((x) => ({ ...withOptions(x, x.options.map((y) => (y.id === saved.id ? merge(y, saved) : y))), notice: `Your vote for “${saved.label}” is in.` }));
  } catch {
    store.update((x) => {
      const mine = { ...x.mine };
      if (prev === undefined) delete mine[key];
      else mine[key] = prev;
      return { ...x, mine, error: "Your vote didn't go through. Refresh the poll and try again." };
    });
    void loadOptions(o.pollId);
  } finally {
    voting.delete(o.pollId);
  }
}

async function suggest() {
  const st = store.get();
  const label = st.draft.trim();
  if (!label || !st.current) return;
  store.update((x) => ({ ...x, draft: "", error: "", notice: "" }));
  try {
    const created = await getJson<Option>("/api/options", { method: "POST", body: JSON.stringify({ pollId: st.current, label, key: `${st.current}|${label.toLowerCase()}`, votes: 0 }) });
    store.update((x) => (x.current !== created.pollId || x.options.some((y) => y.id === created.id) ? x : withOptions(x, [...x.options, created])));
  } catch (e) {
    const clash = (e as { status?: number }).status === 409;
    store.update((x) => ({ ...x, error: clash ? `“${label}” is already an option.` : "Couldn't add your option." }));
  }
}

// --------------------------------------------------------------------------------------------- live
let opened = 0;
function connect() {
  const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/options`);
  ws.onopen = () => {
    opened++;
    store.update((x) => ({ ...x, live: true }));
    if (opened > 1 && RECONNECT === "resync") void loadOptions(store.get().current);
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as { type: string; item?: Option };
    const it = m.item;
    if (!it || it.pollId !== store.get().current) return;
    store.update((x) => {
      if (m.type === "created") return x.options.some((y) => y.id === it.id) ? x : withOptions(x, [...x.options, it]);
      if (m.type !== "updated") return x;
      // a pushed count replaces the option; the running total (incremental) only follows my own votes
      const options = x.options.map((y) => (y.id === it.id ? merge(y, it) : y));
      return TOTALS === "derive" ? withOptions(x, options) : { ...x, options };
    });
  };
  ws.onclose = () => {
    store.update((x) => ({ ...x, live: false }));
    setTimeout(connect, 1500);
  };
}

// ------------------------------------------------------------------------------------------------ UI
document.getElementById("app")!.innerHTML = `
<main class="polls">
  <header><h1>Team polls</h1><p class="conn">{{ s.live ? "Live results" : "Reconnecting…" }}</p></header>
  <nav class="tabs"><button v-for="p in s.polls" :key="p.id" class="poll-tab" :class="{ active: p.id === s.current }" @click="open(p.id)">{{ p.title }}</button></nav>
  <section v-if="poll()" class="poll">
    <h2>{{ poll().title }}</h2>
    <p class="meta">{{ s.total }} {{ s.total === 1 ? "vote" : "votes" }} · closes {{ poll().closes }}</p>
    <ul>
      <li v-for="o in s.options" :key="o.id" class="option">
        <button class="vote" :class="{ mine: s.mine[String(s.current)] === o.id }" @click="vote(o)">{{ o.label }}</button>
        <span class="count">{{ o.votes }}</span> <span class="bar">{{ bar(o) }}</span><span v-if="s.mine[String(s.current)] === o.id"> (your vote)</span>
      </li>
    </ul>
    <form class="suggest" @submit.prevent="suggest()">
      <input name="suggestion" placeholder="Suggest another option" :value="s.draft" @input="setDraft($event.target.value)">
      <button class="add-option" type="submit">Add option</button>
    </form>
  </section>
  <p v-if="s.notice" class="notice">{{ s.notice }}</p>
  <p v-if="s.error" role="alert">{{ s.error }}</p>
</main>`;

createApp({
  s,
  poll: () => s.polls.find((p: Poll) => p.id === s.current),
  bar: (o: Option) => {
    const share = s.total > 0 ? Math.round((10 * o.votes) / Math.max(s.total, sumVotes(s.options))) : 0;
    return "■".repeat(Math.max(0, Math.min(10, share))) + "□".repeat(Math.max(0, 10 - Math.min(10, share)));
  },
  open,
  vote,
  suggest,
  setDraft: (v: string) => store.update((x) => ({ ...x, draft: v })),
}).mount("#app");

async function boot(attempt = 0) {
  try {
    const polls = await getJson<Poll[]>("/api/polls");
    store.update((x) => ({ ...x, polls, error: "" }));
    if (polls[0]) open(polls[0].id);
  } catch {
    store.update((x) => ({ ...x, error: "Polls are unavailable right now. Retrying…" }));
    if (attempt < 6) setTimeout(() => void boot(attempt + 1), 1000 * 2 ** Math.min(attempt, 3));
  }
}
void boot();
connect();
