// Insurance claims desk (Preact 10 + @preact/signals mirroring runtime atoms; fetch). An adjuster works a queue,
// ticks the claim lines they accept (each tick saves the claim's line array with a versioned PATCH) and approves or
// refers the claim. Latent bugs by flag: line saves fired in parallel (lineSave=parallel) and without the version
// (versionCheck=false: a second tick built from a stale array silently drops the first), approve/refer clickable
// while a save runs (decideGuard=none), an approved total kept by hand (approvedTotal=increment) and queue lists
// applied in arrival order (listSeq=blind).
import { render } from "preact";
import { rt, flag } from "../_shared/genclass";
import { atomSignal } from "../_shared/preact-atom";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Line = { desc: string; amount: number; ok: boolean };
type Claim = { id: number; ref: string; holder: string; status: string; lines: Line[]; version: number };
const LINE_SAVE = flag("lineSave", "queue");
const VERSION_CHECK = Boolean(flag("versionCheck", true));
const DECIDE_GUARD = flag("decideGuard", "disable") === "disable";
const APPROVED_TOTAL = flag("approvedTotal", "derive");
const LIST_SEQ = flag("listSeq", "latest");

const claims = rt.atom("claims", { queue: "open", items: [] as Claim[], loading: true, error: "" });
const claim = rt.atom("claim", { id: 0, ref: "", holder: "", status: "", lines: [] as Line[], approved: 0, version: 0, saving: false, error: "", notice: "" });
type C = ReturnType<typeof claim.get>;
const sumOk = (ls: Line[]) => ls.reduce((a, l) => a + (l.ok ? l.amount : 0), 0);
const money = (n: number) => `$${n.toLocaleString("en-US")}`;
const claimsSig = atomSignal(claims);
const claimSig = atomSignal(claim);

let listSeq = 0;
async function loadQueue(queue: string) {
  const seq = ++listSeq;
  claims.update((s) => ({ ...s, queue, loading: true, error: "" }));
  try {
    const items = itemsOf<Claim>(await api(`/api/claims?limit=30${queue === "all" ? "" : `&status=${queue}`}`));
    if (LIST_SEQ === "latest" && seq !== listSeq) return;
    claims.update((s) => ({ ...s, items, loading: false }));
  } catch (e) {
    if (seq === listSeq) claims.update((s) => ({ ...s, loading: false, error: errText(e, "loading the queue") }));
  }
}

function adopt(c: Claim): Partial<C> {
  return { id: c.id, ref: c.ref, holder: c.holder, status: c.status, lines: c.lines, version: c.version, approved: sumOk(c.lines) };
}
async function openClaim(id: number) {
  claim.update((c) => ({ ...c, id, lines: [], approved: 0, error: "", notice: "" }));
  try {
    const c = await api<Claim>(`/api/claims/${id}`);
    if (claim.get().id === id) claim.update((x) => ({ ...x, ...adopt(c) }));
  } catch (e) {
    if (claim.get().id === id) claim.update((x) => ({ ...x, error: errText(e, "opening the claim") }));
  }
}

let queue: Promise<unknown> = Promise.resolve();
let saving = 0;
function toggleLine(i: number) {
  const c0 = claim.get();
  const line = c0.lines[i];
  if (!line) return;
  const lines = c0.lines.map((l, j) => (j === i ? { ...l, ok: !l.ok } : l));
  claim.update((c) => ({ ...c, lines, approved: APPROVED_TOTAL === "derive" ? sumOk(lines) : c.approved + (line.ok ? -line.amount : line.amount) }));
  const send = () => saveLines(c0.id, LINE_SAVE === "queue" ? claim.get().lines : lines);
  if (LINE_SAVE === "queue") queue = queue.then(send, send);
  else void send();
}

async function saveLines(id: number, lines: Line[], status?: string) {
  saving++;
  claim.update((c) => ({ ...c, saving: true, error: "" }));
  try {
    const body: Record<string, unknown> = { lines, ...(status ? { status } : {}) };
    if (VERSION_CHECK) body.version = claim.get().version;
    const saved = await api<Claim>(`/api/claims/${id}`, "PATCH", body);
    if (claim.get().id === id) claim.update((c) => ({ ...c, version: saved.version, status: saved.status, ...(status ? { lines: saved.lines, approved: sumOk(saved.lines), notice: `${saved.ref} ${status === "closed" ? `approved for ${money(sumOk(saved.lines))}` : "referred for review"}.` } : {}) }));
    claims.update((s) => ({ ...s, items: s.items.map((x) => (x.id === id ? saved : x)) }));
  } catch (e) {
    const cur = e instanceof HttpError && e.status === 409 ? (e.body?.current as Claim | undefined) : undefined;
    if (claim.get().id === id) claim.update((c) => ({ ...c, ...(cur ? adopt(cur) : {}), error: cur ? "This claim changed elsewhere; reloaded the latest lines." : errText(e, "saving the claim") }));
  } finally {
    saving--;
    claim.update((c) => ({ ...c, saving: saving > 0 }));
  }
}
function decide(status: "closed" | "review") {
  if (DECIDE_GUARD && claim.get().saving) return;
  const id = claim.get().id;
  const run = () => saveLines(id, claim.get().lines, status);
  queue = queue.then(run, run);
}

const QUEUES: [string, string][] = [["open", "Open"], ["review", "Review"], ["closed", "Closed"], ["all", "All"]];
function App() {
  const s = claimsSig.value;
  const c = claimSig.value;
  return (
    <div class="claims">
      <header><h1>Claims desk</h1><nav class="queues">{QUEUES.map(([k, l]) => <button key={k} class={s.queue === k ? "current" : ""} onClick={() => void loadQueue(k)}>{l}</button>)}</nav>{s.loading && <span class="muted">Loading…</span>}</header>
      {s.error && <p role="alert">{s.error}</p>}
      <ul class="queue">{s.items.map((x) => <li key={x.id} class="claim">{x.ref} · {x.holder} · {x.status} <button class="open" onClick={() => void openClaim(x.id)}>Open</button></li>)}</ul>
      {c.id !== 0 && (
        <section class="claim">
          <h2>{c.ref} — {c.holder} <small>{c.status}</small></h2>
          <ul class="lines">{c.lines.map((l, i) => <li key={l.desc}><label><input type="checkbox" class="line-ok" checked={l.ok} disabled={c.status === "closed"} onChange={() => toggleLine(i)} /> {l.desc} {money(l.amount)}</label></li>)}</ul>
          <p class="approved">Approved so far: {money(c.approved)}</p>
          {c.status !== "closed" && c.lines.length > 0 && (
            <p><button class="approve" disabled={DECIDE_GUARD && c.saving} onClick={() => decide("closed")}>Approve claim</button> <button class="refer" disabled={DECIDE_GUARD && c.saving} onClick={() => decide("review")}>Refer</button></p>
          )}
          {c.saving && <p class="muted">Saving…</p>}
          {c.error ? <p role="alert">{c.error}</p> : c.notice ? <p class="notice">{c.notice}</p> : null}
        </section>
      )}
    </div>
  );
}

render(<App />, document.getElementById("app")!);
void loadQueue("open");
