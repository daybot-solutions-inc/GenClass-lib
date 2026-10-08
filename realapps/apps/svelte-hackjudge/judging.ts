// Hackathon judging (Svelte 5 runes + @tanstack/svelte-query, fetch, WebSocket). A judge scores projects (table,
// team, title) on three criteria from 1 to 5. The first score of a cell is POST /scores {judge, projectId, criterion,
// key} (key unique on the server), later changes are versioned PATCHes. All judges' scores live in the ["scores"]
// query (polled; registered with rt.guard, so the app's optimistic writes, echoes and rollbacks go through GenClass)
// and feed the leaderboard (projects by average). A live round doc (docs/round) locks scoring when the organisers
// close the round. Projects are paged by table number. Latent bugs by flag: changes of one score sent side by side
// (save=parallel: two quick changes land reordered and their answers are applied as they come), a 409 on the first
// POST treated as a failure (create=blind-post: the cell is cleared although the server has a score), the scores
// query refetched after every save and polled while saves are in flight (leaderboard=invalidate-each: an older
// list puts back a score the judge just changed), PATCHes without the version (scoreVersion=force: the last request
// to arrive wins) and a closed round not enforced (roundLock=ignore: scores keep changing after the round closed).
import { QueryClient, createQuery } from "@tanstack/svelte-query";
import { derived } from "svelte/store";
import { rt, flag } from "../_shared/genclass";
import { atomStore } from "../_shared/svelte-atom";
import { api, itemsOf, errText, HttpError, liveTopic } from "../_shared/w3-http";

export type Criterion = "impact" | "execution" | "design";
export type Project = { id: number; table: number; team: string; title: string; track: string };
export type Score = { id: number; judge: string; projectId: number; team: string; criterion: Criterion; value: number; key: string; version: number };
type Scores = { items: Score[]; total: number };
type Change = { p: Project; c: Criterion; value: number; before: Score | undefined };

const SAVE = flag("save", "serial") as "serial" | "parallel";
const CREATE = flag("create", "upsert-on-409") as "upsert-on-409" | "blind-post";
const IDLE_ONLY = flag("leaderboard", "invalidate-when-idle") === "invalidate-when-idle";
const IF_MATCH = flag("scoreVersion", "if-match") === "if-match";
export const ROUND_LOCK = flag("roundLock", "respect") === "respect";

export const ME = "Dana Okafor";
export const CRITERIA: [Criterion, string][] = [["impact", "Impact"], ["execution", "Execution"], ["design", "Design"]];
export const PER_PAGE = 6;
export const PAGES = 3;
const label = (c: Criterion) => CRITERIA.find(([k]) => k === c)?.[1] ?? c;

export const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 2000 } } });
const KEY = ["scores"];
const scores = rt.guard<Scores>("scores", {
  get: () => qc.getQueryData<Scores>(KEY) ?? { items: [], total: 0 },
  set: (v) => void qc.setQueryData<Scores>(KEY, v),
  subscribe: (fn) =>
    qc.getQueryCache().subscribe((e) => {
      if (e.type === "updated" && e.query.queryKey[0] === "scores" && e.action.type === "success") fn();
    }),
});
const judging = rt.atom("judging", { page: 1, round: "open", roundName: "", error: "", notice: "" });
export const ui = atomStore(judging);

/** Cells with a save on its way (the poll pauses while > 0 when it waits for idle). */
let saving = 0;
export const scoresQ = createQuery(
  {
    queryKey: KEY,
    queryFn: async () => {
      const body = await api<Scores>("/api/scores?limit=500");
      return { items: itemsOf<Score>(body), total: Number(body.total ?? 0) };
    },
    refetchInterval: () => (IDLE_ONLY && saving > 0 ? false : 8000),
  },
  qc,
);
export const projectsQ = createQuery(
  derived(ui, ($u) => ({
    queryKey: ["projects", $u.page],
    queryFn: async () => itemsOf<Project>(await api(`/api/projects?table__gte=${($u.page - 1) * PER_PAGE + 1}&table__lte=${$u.page * PER_PAGE}&sort=table&limit=${PER_PAGE}`)),
    staleTime: 60000,
  })),
  qc,
);

const keyOf = (pid: number, c: Criterion) => `${ME}|${pid}|${c}`;
const mineOf = (key: string) => scores.get().items.find((s) => s.key === key);
function put(s: Score) {
  scores.update((d) => {
    const i = d.items.findIndex((x) => x.key === s.key);
    const items = i < 0 ? [...d.items, s] : d.items.map((x, j) => (j === i ? s : x));
    return { ...d, items, total: items.length };
  });
}

async function patchScore(id: number, version: number, value: number): Promise<Score> {
  try {
    return await api<Score>(`/api/scores/${id}`, "PATCH", IF_MATCH ? { value, version } : { value }, IF_MATCH ? { "If-Match": String(version) } : {});
  } catch (e) {
    // our own earlier change got there first and bumped the version: apply this one on top of it
    const cur = e instanceof HttpError && e.status === 409 ? (e.body?.current as Score | undefined) : undefined;
    if (IF_MATCH && cur) return api<Score>(`/api/scores/${id}`, "PATCH", { value, version: cur.version }, { "If-Match": String(cur.version) });
    throw e;
  }
}

async function send(ch: Change): Promise<Score> {
  const key = keyOf(ch.p.id, ch.c);
  const cur = mineOf(key);
  if (cur && cur.id > 0) return patchScore(cur.id, cur.version, ch.value);
  try {
    return await api<Score>("/api/scores", "POST", { judge: ME, projectId: ch.p.id, team: ch.p.team, criterion: ch.c, value: ch.value, key });
  } catch (e) {
    if (CREATE === "upsert-on-409" && e instanceof HttpError && e.status === 409) {
      // an earlier attempt already created this score: update it instead
      const existing = itemsOf<Score>(await api(`/api/scores?key=${encodeURIComponent(key)}&limit=1`))[0];
      if (existing) return patchScore(existing.id, existing.version, ch.value);
    }
    throw e;
  }
}

let tempSeq = 0;
const wanted = new Map<string, Change>();
const busy = new Set<string>();

async function saveOne(ch: Change) {
  const key = keyOf(ch.p.id, ch.c);
  try {
    const saved = await send(ch);
    // serial: a newer change of this cell is queued, so keep what the judge picked and take only id and version
    const cur = mineOf(key);
    put(SAVE === "serial" && wanted.has(key) && cur ? { ...saved, value: cur.value } : saved);
  } catch (e) {
    scores.update((d) => {
      const items = d.items.flatMap((x) => (x.key !== key || x.value !== ch.value ? [x] : ch.before ? [ch.before] : []));
      return { ...d, items, total: items.length };
    });
    judging.update((u) => ({ ...u, notice: "", error: errText(e, `your ${label(ch.c)} score for ${ch.p.team}`) }));
  }
}

function settle() {
  if (IDLE_ONLY && saving > 0) return; // the last save to finish refreshes the leaderboard
  void qc.invalidateQueries({ queryKey: KEY });
}

async function drain(key: string) {
  busy.add(key);
  saving++;
  try {
    for (let ch = wanted.get(key); ch; ch = wanted.get(key)) {
      wanted.delete(key);
      await saveOne(ch);
    }
  } finally {
    busy.delete(key);
    saving--;
    settle();
  }
}

export function score(p: Project, c: Criterion, raw: string) {
  const value = Number(raw);
  if (!value) return;
  if (ROUND_LOCK && judging.get().round !== "open") {
    judging.update((u) => ({ ...u, notice: "", error: "Scoring is closed for this round." }));
    return;
  }
  const key = keyOf(p.id, c);
  const before = mineOf(key);
  if (IDLE_ONLY) void qc.cancelQueries({ queryKey: KEY });
  put({ ...(before ?? { id: -++tempSeq, judge: ME, projectId: p.id, team: p.team, criterion: c, key, version: 0 }), value });
  judging.update((u) => ({ ...u, error: "", notice: `${label(c)} for ${p.team}: ${value}` }));
  if (SAVE === "serial") {
    wanted.set(key, { p, c, value, before: wanted.get(key)?.before ?? before });
    if (!busy.has(key)) void drain(key);
    return;
  }
  saving++;
  void saveOne({ p, c, value, before }).finally(() => {
    saving--;
    settle();
  });
}

export function setPage(d: number) {
  judging.update((u) => ({ ...u, page: Math.min(PAGES, Math.max(1, u.page + d)), error: "" }));
}
export function refresh() {
  judging.update((u) => ({ ...u, error: "" }));
  void qc.invalidateQueries({ queryKey: KEY });
}

export function leaderboard(all: Score[]) {
  const by = new Map<number, { team: string; sum: number; n: number }>();
  for (const s of all) {
    const e = by.get(s.projectId) ?? { team: s.team, sum: 0, n: 0 };
    e.sum += Number(s.value);
    e.n++;
    by.set(s.projectId, e);
  }
  return [...by.entries()]
    .map(([id, e]) => ({ id, team: e.team, avg: e.sum / e.n, n: e.n }))
    .sort((a, b) => b.avg - a.avg || a.team.localeCompare(b.team))
    .slice(0, 5);
}

async function loadRound() {
  try {
    const d = await api<{ status: string; name: string }>("/api/docs/round");
    judging.update((u) => ({ ...u, round: d.status, roundName: d.name }));
  } catch (e) {
    judging.update((u) => ({ ...u, error: errText(e, "loading the round status") }));
  }
}
let everUp = false;
liveTopic(
  "docs/round",
  (m) => {
    if (m.item) judging.update((u) => ({ ...u, round: String(m.item.status), roundName: String(m.item.name ?? u.roundName) }));
  },
  (up) => {
    if (up && everUp) void loadRound();
    if (up) everUp = true;
  },
);
void loadRound();
