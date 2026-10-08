// Spaced-repetition flashcards (React 19 + Jotai atoms in an explicit store; fetch). Due cards come in small batches;
// grading a card (Again / Good / Easy → POST /cards/:id/<grade>, a relative box change, plus a shared "reviewed today"
// counter) advances to the next card at once and the queue is topped up in the background when it runs low. The
// session atom is registered with rt.guard (async results go through it; the deck picker writes the Jotai store
// directly). Latent bugs by flag: top-ups that page through the due list while grading shrinks it (prefetch=next-page:
// cards are skipped) or refetch page 1 without dropping cards already queued or being graded (prefetch=page-1-blind:
// the same card twice), grade buttons shown before the answer is revealed (reveal=optional: a double click grades the
// next card too), a reviewed counter kept locally (reviewed=local: other devices' reviews never show), deck loads
// applied in arrival order (deckSeq=blind) and failed grades silently dropped instead of re-queued (gradeFail=drop).
import { createRoot } from "react-dom/client";
import { atom, createStore, Provider, useAtomValue } from "jotai";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText } from "../_shared/w3-http";

type Card = { id: number; deck: string; front: string; back: string; box: number; due: string };
type Grade = "again" | "good" | "easy";
interface Review {
  deck: string;
  queue: Card[];
  page: number;
  revealed: boolean;
  reviewed: number;
  pending: number[];
  loading: boolean;
  exhausted: boolean;
  error: string;
  notice: string;
}

const PREFETCH = flag("prefetch", "page-1-dedupe") as "page-1-dedupe" | "next-page" | "page-1-blind";
const REVEAL = flag("reveal", "required");
const REVIEWED = flag("reviewed", "server");
const DECK_SEQ = flag("deckSeq", "latest");
const GRADE_FAIL = flag("gradeFail", "requeue");
const BATCH = 4;

const store = createStore();
const reviewAtom = atom<Review>({ deck: "spanish", queue: [], page: 1, revealed: false, reviewed: 0, pending: [], loading: true, exhausted: false, error: "", notice: "" });
const currentAtom = atom((get) => get(reviewAtom).queue[0] ?? null);
const review = rt.guard<Review>("review", { get: () => store.get(reviewAtom), set: (v) => store.set(reviewAtom, v), subscribe: (fn) => store.sub(reviewAtom, fn) });

const fetchBatch = async (deck: string, page: number) => itemsOf<Card>(await api(`/api/cards?deck=${deck}&due=today&page=${page}&limit=${BATCH}`));
/** Cards graded Good/Easy this session (they are no longer due, even if a lagging list still says so). */
const graded = new Set<number>();

let deckSeq = 0;
async function openDeck(deck: string) {
  const my = ++deckSeq;
  store.set(reviewAtom, (r) => ({ ...r, deck, queue: [], page: 1, revealed: false, loading: true, exhausted: false, error: "", notice: "" }));
  try {
    const cards = await fetchBatch(deck, 1);
    if (DECK_SEQ === "latest" && my !== deckSeq) return;
    review.update((r) => ({ ...r, queue: cards.filter((c) => !graded.has(c.id)), page: 1, loading: false, exhausted: cards.length === 0 }));
  } catch (e) {
    if (my === deckSeq) review.update((r) => ({ ...r, loading: false, error: errText(e, `loading the ${deck} deck`) }));
  }
}

let topping = false;
async function topUp() {
  const r = review.get();
  if (topping || r.loading || (r.exhausted && r.queue.length > 0) || r.queue.length > 2) return;
  topping = true;
  const { deck } = r;
  const my = deckSeq;
  const page = PREFETCH === "next-page" ? r.page + 1 : 1;
  try {
    const cards = await fetchBatch(deck, page);
    review.update((x) => {
      if (x.deck !== deck || my !== deckSeq) return x;
      const fresh = PREFETCH === "page-1-dedupe" ? cards.filter((c) => !graded.has(c.id) && !x.pending.includes(c.id) && !x.queue.some((q) => q.id === c.id)) : cards;
      const exhausted = PREFETCH === "next-page" ? cards.length < BATCH : cards.length === 0;
      return { ...x, queue: [...x.queue, ...fresh], page, exhausted, notice: exhausted && !x.queue.length && !fresh.length ? `All caught up on ${deck}!` : x.notice };
    });
  } catch {
    /* the next grade tries again */
  } finally {
    topping = false;
  }
}

async function grade(kind: Grade) {
  const r = review.get();
  const card = r.queue[0];
  if (!card || (REVEAL === "required" && !r.revealed)) return;
  review.update((x) => ({ ...x, queue: kind === "again" ? [...x.queue.slice(1), card] : x.queue.slice(1), revealed: false, pending: [...x.pending, card.id], reviewed: REVIEWED === "local" ? x.reviewed + 1 : x.reviewed, error: "", notice: "" }));
  if (kind !== "again") graded.add(card.id);
  try {
    await api(`/api/cards/${card.id}/${kind}`, "POST");
    const c = await api<{ value: number }>(`/api/counters/reviewed/incr`, "POST", { by: 1 });
    if (REVIEWED === "server") review.update((x) => ({ ...x, reviewed: Math.max(x.reviewed, c.value) }));
  } catch (e) {
    graded.delete(card.id);
    review.update((x) => {
      const back = GRADE_FAIL === "requeue" && kind !== "again" && !x.queue.some((q) => q.id === card.id) ? { ...x, queue: [card, ...x.queue], revealed: false } : x;
      return { ...back, error: errText(e, `saving your answer for “${card.front}”`) };
    });
  } finally {
    review.update((x) => ({ ...x, pending: x.pending.filter((id) => id !== card.id) }));
    void topUp();
  }
}

const reveal = () => store.set(reviewAtom, (r) => ({ ...r, revealed: true }));
const skip = () => store.set(reviewAtom, (r) => (r.queue.length > 1 ? { ...r, queue: [...r.queue.slice(1), r.queue[0]!], revealed: false } : r));

function App() {
  const r = useAtomValue(reviewAtom);
  const card = useAtomValue(currentAtom);
  return (
    <main className="flashcards">
      <h1>Flashcards</h1>
      <label>
        Deck{" "}
        <select name="deck" value={r.deck} onChange={(e) => void openDeck(e.target.value)}>
          {["spanish", "anatomy", "capitals"].map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      <p className="stats">
        {r.reviewed} reviewed today · {r.queue.length} in this batch
      </p>
      {r.error ? <p role="alert">{r.error}</p> : r.notice ? <p className="notice">{r.notice}</p> : null}
      {r.loading ? (
        <p className="muted">Loading…</p>
      ) : card ? (
        <section className="card">
          <p className="front">{card.front}</p>
          {r.revealed ? (
            <p className="back">{card.back}</p>
          ) : (
            <button type="button" className="reveal" onClick={reveal}>
              Show answer
            </button>
          )}
          {r.revealed || REVEAL === "optional" ? (
            <div className="grades">
              {(["again", "good", "easy"] as Grade[]).map((g) => (
                <button key={g} type="button" onClick={() => void grade(g)}>
                  {g === "again" ? "Again" : g === "good" ? "Good" : "Easy"}
                </button>
              ))}
            </div>
          ) : null}
          <button type="button" className="skip" onClick={skip}>
            Skip
          </button>
        </section>
      ) : (
        <p className="done">Nothing due in {r.deck} right now.</p>
      )}
    </main>
  );
}

createRoot(document.getElementById("app")!).render(
  <Provider store={store}>
    <App />
  </Provider>,
);
void openDeck("spanish");
void api<{ value: number }>(`/api/counters/reviewed`).then((c) => review.update((r) => ({ ...r, reviewed: c.value })), () => undefined);
setInterval(() => void topUp(), 5000);
