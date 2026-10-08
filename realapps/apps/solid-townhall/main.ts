// All-hands town hall Q&A (Solid 1.9 + solid-js/html; a runtime atom mirrored into a signal; fetch + WebSocket).
// Employees ask questions (shown at once with a client id, then POST /questions) and upvote others' (POST
// /questions/:id/upvote: relative, one vote per person); questions and votes stream in live and the host marks them
// answered. Latent bugs by flag: the optimistic question not reconciled with its live echo (ask=append: it shows
// twice when the push beats the POST answer), votes not rolled back when they fail (vote=optimistic), vote buttons
// that stay live until the answer comes back (voteGuard=none: a double click votes twice), pushes and answers
// applied in arrival order (live=blind: an older vote count wins) and reconnects without a reload (reconnect=naive).
import html from "solid-js/html";
import { render } from "solid-js/web";
import { For, Show, createMemo } from "solid-js";
import { rt, flag } from "../_shared/genclass";
import { atomSignal } from "../_shared/solid-atom";
import { api, itemsOf, errText, liveTopic } from "../_shared/w3-http";

type Q = { id: number | string; clientId?: string; text: string; author: string; votes: number; answered: boolean; version: number; createdAt?: string; pending?: boolean };
const ASK = flag("ask", "reconcile");
const VOTE = flag("vote", "optimistic-rollback");
const VOTE_GUARD = flag("voteGuard", "once") === "once";
const LIVE = flag("live", "version-check");
const RECONNECT = flag("reconnect", "resync");
const ME = "you";

const hall = rt.atom("townhall", { questions: [] as Q[], voted: [] as (number | string)[], pending: [] as (number | string)[], tab: "top", draft: "", asking: false, live: false, error: "", notice: "" });
type H = ReturnType<typeof hall.get>;

/** A question from the server (POST answer or push) merged in: matched by id, or by client id for our own. */
function upsert(h: H, q: Q): H {
  const i = h.questions.findIndex((x) => x.id === q.id || (ASK === "reconcile" && q.clientId && x.clientId === q.clientId));
  if (i < 0) return { ...h, questions: [...h.questions, q] };
  const cur = h.questions[i]!;
  if (LIVE === "version-check" && !cur.pending && Number(q.version) < Number(cur.version)) return h;
  const questions = h.questions.slice();
  questions[i] = q;
  return { ...h, questions };
}

async function load() {
  try {
    const qs = itemsOf<Q>(await api(`/api/questions?limit=60`));
    hall.update((h) => ({ ...h, questions: [...qs, ...h.questions.filter((x) => x.pending && !qs.some((y) => y.clientId && y.clientId === x.clientId))] }));
  } catch (e) {
    hall.update((h) => ({ ...h, error: errText(e, "loading questions") }));
  }
}

let cid = 0;
async function ask(ev: Event) {
  ev.preventDefault();
  const h0 = hall.get();
  const text = h0.draft.trim();
  if (!text || h0.asking) return;
  const clientId = `c${++cid}`;
  const temp: Q = { id: clientId, clientId, text, author: ME, votes: 0, answered: false, version: 0, pending: true };
  hall.update((h) => ({ ...h, questions: [...h.questions, temp], draft: "", asking: true, error: "", notice: "" }));
  try {
    const saved = await api<Q>(`/api/questions`, "POST", { text, author: ME, votes: 0, answered: false, clientId });
    hall.update((h) => {
      // append: the temporary entry is swapped for the saved one in place, even if the push already added it
      const next = ASK === "reconcile" ? upsert(h, saved) : { ...h, questions: h.questions.map((x) => (x.id === clientId ? saved : x)) };
      return { ...next, notice: "Your question is in the queue." };
    });
  } catch (e) {
    hall.update((h) => ({ ...h, questions: h.questions.filter((x) => x.id !== clientId), draft: text, error: errText(e, "posting your question") }));
  } finally {
    hall.update((h) => ({ ...h, asking: false }));
  }
}

async function vote(q: Q) {
  const h0 = hall.get();
  if (typeof q.id !== "number" || h0.voted.includes(q.id)) return;
  if (VOTE_GUARD && h0.pending.includes(q.id)) return;
  hall.update((h) => ({ ...h, voted: VOTE_GUARD ? [...h.voted, q.id] : h.voted, pending: [...h.pending, q.id], questions: h.questions.map((x) => (x.id === q.id ? { ...x, votes: x.votes + 1 } : x)), error: "" }));
  try {
    const saved = await api<Q>(`/api/questions/${q.id}/upvote`, "POST");
    hall.update((h) => ({ ...upsert(h, saved), voted: h.voted.includes(q.id) ? h.voted : [...h.voted, q.id] }));
  } catch (e) {
    hall.update((h) => {
      const back = VOTE === "optimistic-rollback" ? { ...h, voted: h.voted.filter((id) => id !== q.id), questions: h.questions.map((x) => (x.id === q.id ? { ...x, votes: x.votes - 1 } : x)) } : h;
      return { ...back, error: errText(e, "your vote") };
    });
  } finally {
    hall.update((h) => ({ ...h, pending: h.pending.filter((id) => id !== q.id) }));
  }
}

function App() {
  const h = atomSignal(hall);
  const shown = createMemo(() => {
    const s = h();
    const open = s.questions.filter((q) => (s.tab === "answered" ? q.answered : !q.answered));
    return s.tab === "newest" ? [...open].sort((a, b) => String(b.createdAt ?? "~").localeCompare(String(a.createdAt ?? "~"))) : [...open].sort((a, b) => b.votes - a.votes || String(a.createdAt ?? "~").localeCompare(String(b.createdAt ?? "~")));
  });
  return html`<main class="townhall">
    <h1>All-hands Q&A</h1>
    <p class="status">${() => `${h().questions.filter((q) => !q.answered).length} open questions · ${h().live ? "live" : "reconnecting…"}`}</p>
    <form class="ask" onSubmit=${(e: Event) => void ask(e)}>
      <textarea name="question" placeholder="Ask the leadership team…" value=${() => h().draft} onInput=${(e: Event) => hall.update((x) => ({ ...x, draft: (e.currentTarget as HTMLTextAreaElement).value }))}></textarea>
      <button type="submit" disabled=${() => h().asking}>${() => (h().asking ? "Posting…" : "Ask")}</button>
    </form>
    <${Show} when=${() => h().error}><p role="alert">${() => h().error}</p><//>
    <${Show} when=${() => !h().error && h().notice}><p class="notice">${() => h().notice}</p><//>
    <nav class="tabs">${["top", "newest", "answered"].map((t) => html`<button type="button" class=${() => (h().tab === t ? "current" : "")} onClick=${() => hall.update((x) => ({ ...x, tab: t }))}>${t === "top" ? "Top" : t === "newest" ? "Newest" : "Answered"}</button>`)}</nav>
    <ul class="questions"><${For} each=${shown}>${(q: Q) => html`<li class="question">
      <span class="votes">${q.votes}</span> ${q.text} <em>— ${q.author}${q.pending ? " (posting…)" : ""}</em>
      <${Show} when=${() => !q.answered}><button type="button" class="vote" disabled=${() => typeof q.id !== "number" || h().voted.includes(q.id) || (VOTE_GUARD && h().pending.includes(q.id))} onClick=${() => void vote(q)}>${() => (h().voted.includes(q.id) ? "Voted" : "▲ Upvote")}</button><//></li>`}<//></ul>
  </main>`;
}

render(() => html`<${App} />`, document.getElementById("app")!);
let everUp = false;
liveTopic(
  "questions",
  (m) => {
    if (m.type === "deleted") hall.update((h) => ({ ...h, questions: h.questions.filter((q) => q.id !== m.id) }));
    else if (m.item) hall.update((h) => upsert(h, m.item as Q));
  },
  (up) => {
    hall.update((h) => ({ ...h, live: up }));
    if (up && everUp && RECONNECT === "resync") void load();
    if (up) everUp = true;
  },
);
void load();
