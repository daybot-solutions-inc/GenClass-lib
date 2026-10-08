// Hiring pipeline board (SolidJS with solid-js/html, @tanstack/solid-query, fetch). Candidates are versioned on the
// server; a move is an optimistic PATCH {stage} guarded by If-Match, and the board polls so other recruiters' moves
// show up. The ["candidates"] cache is registered with rt.guard (optimistic moves, rollbacks and conflict fixes go
// through GenClass; query fetches are traced). Latent bugs by flag: moves sent without a version
// (conflict=none: last writer wins over another recruiter's move), the card's version not taken from the response
// (versionEcho=stale: the next move of the same card conflicts with the user's own previous move), polls left
// running during a move (poll=replace: an older poll puts the card back in its old column), no rollback when a move
// fails (rollback=none), card buttons not locked while its move is pending (moveLock=false).
import html from "solid-js/html";
import { render } from "solid-js/web";
import { For, Show, createSignal } from "solid-js";
import { QueryClient, useMutation, useQuery } from "@tanstack/solid-query";
import { rt, flag } from "../_shared/genclass";
import { atomSignal } from "../_shared/solid-atom";

type Stage = "applied" | "screen" | "interview" | "offer" | "hired" | "rejected";
type Candidate = { id: number; name: string; role: string; stage: Stage; source: string; version: number };
type Pipeline = { items: Candidate[]; total: number; page?: number };
type Move = { id: number; to: Stage; from: Stage; version: number };

const CONFLICT = flag("conflict", "if-match") as "if-match" | "none";
const VERSION_ECHO = flag("versionEcho", "from-response") as "from-response" | "stale";
const POLL = flag("poll", "pause") as "pause" | "replace";
const ROLLBACK = flag("rollback", "revert") as "revert" | "none";
const MOVE_LOCK = Boolean(flag("moveLock", true));

const STAGES: [Stage, string][] = [
  ["applied", "Applied"],
  ["screen", "Phone screen"],
  ["interview", "Interview"],
  ["offer", "Offer"],
  ["hired", "Hired"],
];
const ORDER = STAGES.map(([s]) => s);
const label = (s: Stage) => STAGES.find(([k]) => k === s)?.[1] ?? s;
const KEY = ["candidates"];
const EMPTY: Pipeline = { items: [], total: 0 };

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 1000 } } });
const pipeline = rt.guard<Pipeline>("pipeline", {
  get: () => qc.getQueryData<Pipeline>(KEY) ?? EMPTY,
  set: (v) => void qc.setQueryData<Pipeline>(KEY, v),
  subscribe: (fn) =>
    qc.getQueryCache().subscribe((e) => {
      if (e.type === "updated" && e.query.queryKey[0] === "candidates" && e.action.type === "success") fn();
    }),
});
const notes = rt.atom("boardNotes", { notice: "", error: "" });
const [moving, setMoving] = createSignal<number[]>([]);

const patchCard = (p: Pipeline, id: number, fn: (c: Candidate) => Candidate): Pipeline => ({ ...p, items: p.items.map((c) => (c.id === id ? fn(c) : c)) });

async function fetchPipeline(): Promise<Pipeline> {
  const r = await fetch("/api/candidates?limit=50");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as Pipeline;
}

class Conflict extends Error {
  constructor(readonly current: Candidate) {
    super("version conflict");
  }
}

async function sendMove(m: Move): Promise<Candidate> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const body: Record<string, unknown> = { stage: m.to };
  if (CONFLICT === "if-match") {
    headers["If-Match"] = String(m.version);
    body.version = m.version;
  }
  const r = await fetch(`/api/candidates/${m.id}`, { method: "PATCH", headers, body: JSON.stringify(body) });
  if (r.status === 409) {
    const b = (await r.json()) as { current?: Candidate };
    if (b.current) throw new Conflict(b.current);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as Candidate;
}

function Board() {
  const n = atomSignal(notes);
  const query = useQuery(
    () => ({
      queryKey: KEY,
      queryFn: fetchPipeline,
      refetchInterval: () => (POLL === "pause" && qc.isMutating() > 0 ? false : 4000),
    }),
    () => qc,
  );
  const move = useMutation(
    () => ({
      mutationFn: sendMove,
      onMutate: async (m: Move) => {
        if (POLL === "pause") await qc.cancelQueries({ queryKey: KEY });
        setMoving((xs) => [...xs, m.id]);
        pipeline.update((p) => patchCard(p, m.id, (c) => ({ ...c, stage: m.to })));
      },
      onSuccess: (saved: Candidate, m: Move) => {
        notes.update((x) => ({ ...x, notice: `${saved.name} moved to ${label(m.to)}.` }));
        pipeline.update((p) => patchCard(p, m.id, (c) => ({ ...c, stage: saved.stage, version: VERSION_ECHO === "from-response" ? saved.version : c.version })));
      },
      onError: (e: Error, m: Move) => {
        if (e instanceof Conflict) {
          // someone else moved this candidate first: show where they really are now
          pipeline.update((p) => patchCard(p, m.id, () => e.current));
          notes.update((x) => ({ ...x, notice: "", error: `${e.current.name} was moved to ${label(e.current.stage)} by another recruiter. Your move was not applied.` }));
          return;
        }
        if (ROLLBACK === "revert") pipeline.update((p) => patchCard(p, m.id, (c) => (c.stage === m.to ? { ...c, stage: m.from } : c)));
        notes.update((x) => ({ ...x, notice: "", error: "The move couldn't be saved. Check your connection and try again." }));
      },
      onSettled: (_d: unknown, _e: unknown, m: Move) => {
        setMoving((xs) => xs.filter((x) => x !== m.id));
        if (POLL === "pause" && qc.isMutating() <= 1) void qc.invalidateQueries({ queryKey: KEY });
      },
    }),
    () => qc,
  );

  const cards = () => (query.data?.items ?? []).filter((c) => c.stage !== "rejected");
  const shift = (c: Candidate, d: number) => {
    if (MOVE_LOCK && moving().includes(c.id)) return;
    const i = ORDER.indexOf(c.stage);
    const to = d === 0 ? "rejected" : ORDER[i + d];
    if (!to) return;
    notes.set({ notice: "", error: "" });
    move.mutate({ id: c.id, from: c.stage, to: to as Stage, version: c.version });
  };
  const locked = (c: Candidate) => MOVE_LOCK && moving().includes(c.id);

  return html`<main class="pipeline">
    <header>
      <h1>Hiring pipeline</h1>
      <p class="sync">${() => (query.isFetching ? "Syncing…" : `${cards().length} active candidates`)}</p>
    </header>
    <${Show} when=${() => query.isError && !query.data}><p role="alert">The pipeline couldn't be loaded.</p><//>
    <${Show} when=${() => n().error}><p role="alert">${() => n().error}</p><//>
    <${Show} when=${() => n().notice}><p class="notice">${() => n().notice}</p><//>
    <div class="columns">
      <${For} each=${STAGES}>${([stage, title]: [Stage, string]) => html`<section class="column" data-stage=${stage}>
        <h2>${title} (${() => cards().filter((c) => c.stage === stage).length})</h2>
        <ul>
          <${For} each=${() => cards().filter((c) => c.stage === stage)}>${(c: Candidate) => html`<li class="card">
            <strong>${c.name}</strong> · ${c.role} · <small>${`via ${c.source}`}</small>
            <button class="prev" aria-label="Move back" disabled=${() => c.stage === "applied" || locked(c)} onClick=${() => shift(c, -1)}>←</button>
            <button class="next" aria-label="Move forward" disabled=${() => c.stage === "hired" || locked(c)} onClick=${() => shift(c, 1)}>→</button>
            <button class="reject" disabled=${() => c.stage === "hired" || locked(c)} onClick=${() => shift(c, 0)}>Reject</button>
          </li>`}<//>
        </ul>
      </section>`}<//>
    </div>
  </main>`;
}

render(() => html`<${Board} />`, document.getElementById("app")!);
