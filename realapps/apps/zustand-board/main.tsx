// Sprint board (React 19 + Zustand with the GenClass middleware, fetch, live updates over a WebSocket). Cards move
// between columns optimistically (PATCH with If-Match on a versioned resource); teammates' moves arrive as pushes.
// Latent bugs by flag: pushes applied blindly (push=blind: an older push, e.g. the echo of my own previous move,
// moves a card back) or without a version check (push=ignore-pending), optimistic moves kept after a failure
// (rollback=keep), conflicts resolved by overwriting the teammate's move (conflict=force), per-column counts not
// maintained for pushed changes (counts=skip-on-push).
import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import { create } from "zustand";
import { genclass } from "@genclass/runtime/zustand";
import { rt, flag } from "../_shared/genclass";

type Col = "todo" | "doing" | "done";
type Card = { id: number; title: string; column: Col; owner: string; points: number; version: number };
const COLS: Col[] = ["todo", "doing", "done"];
const PUSH = flag("push", "version-check") as "version-check" | "blind" | "ignore-pending";
const ROLLBACK = flag("rollback", "restore") as "restore" | "keep";
const CONFLICT = flag("conflict", "adopt") as "adopt" | "force";
const COUNTS = flag("counts", "recount") as "recount" | "skip-on-push";
const ME = "sam";

interface BoardState {
  cards: Card[];
  counts: Record<Col, number>;
  pending: Record<string, number>;
  mineOnly: boolean;
  connected: boolean;
  loading: boolean;
  draft: string;
  adding: boolean;
  notice: string;
  error: string;
}

const tally = (cards: Card[]): Record<Col, number> => ({
  todo: cards.filter((c) => c.column === "todo").length,
  doing: cards.filter((c) => c.column === "doing").length,
  done: cards.filter((c) => c.column === "done").length,
});

const useBoard = create<BoardState>()(
  genclass(rt, "board")(() => ({
    cards: [] as Card[],
    counts: { todo: 0, doing: 0, done: 0 },
    pending: {} as Record<string, number>,
    mineOnly: false,
    connected: false,
    loading: false,
    draft: "",
    adding: false,
    notice: "",
    error: "",
  })),
);
const set = useBoard.setState;
const get = useBoard.getState;

function upsert(cards: Card[], card: Card): Card[] {
  return cards.some((c) => c.id === card.id) ? cards.map((c) => (c.id === card.id ? card : c)) : [...cards, card];
}

function settle(id: number) {
  set((s) => {
    const n = (s.pending[id] ?? 1) - 1;
    const pending = { ...s.pending };
    if (n > 0) pending[id] = n;
    else delete pending[id];
    return { pending };
  });
}

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const r = await fetch(`/api${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : null) as T };
}

// ------------------------------------------------------------------------------------------------ actions
async function load() {
  set({ loading: true });
  try {
    const r = await api<Card[]>("/cards");
    if (r.status !== 200 || !Array.isArray(r.body)) throw new Error(`HTTP ${r.status}`);
    set((s) => {
      // cards with a move in flight keep their local column until the move settles
      const cards = r.body.map((c) => (s.pending[c.id] ? s.cards.find((x) => x.id === c.id) ?? c : c));
      return { cards, counts: tally(cards), loading: false, error: "" };
    });
  } catch {
    set({ loading: false, error: "Could not load the board" });
  }
}

async function patchColumn(card: Card, to: Col, version: number): Promise<void> {
  const r = await api<Card | { error: string; current: Card }>(`/cards/${card.id}`, { method: "PATCH", headers: { "If-Match": String(version) }, body: JSON.stringify({ column: to }) });
  if (r.status === 409) {
    const current = (r.body as { current: Card }).current;
    if (CONFLICT === "force") return patchColumn(card, to, current.version);
    set((s) => {
      const cards = upsert(s.cards, current);
      return { cards, counts: tally(cards), notice: `“${card.title}” was moved by someone else` };
    });
    return;
  }
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const saved = r.body as Card;
  set((s) => {
    const cards = upsert(s.cards, saved);
    return { cards, counts: tally(cards) };
  });
}

export async function move(id: number, dir: 1 | -1) {
  const card = get().cards.find((c) => c.id === id);
  if (!card) return;
  const from = card.column;
  const to = COLS[COLS.indexOf(from) + dir];
  if (!to) return;
  set((s) => ({
    cards: s.cards.map((c) => (c.id === id ? { ...c, column: to } : c)),
    counts: { ...s.counts, [from]: s.counts[from] - 1, [to]: s.counts[to] + 1 },
    pending: { ...s.pending, [id]: (s.pending[id] ?? 0) + 1 },
    notice: "",
  }));
  try {
    await patchColumn(card, to, card.version);
  } catch {
    set((s) => {
      if (ROLLBACK === "keep") return { error: `Could not move “${card.title}”` };
      const cur = s.cards.find((c) => c.id === id);
      if (!cur || cur.column !== to) return { error: `Could not move “${card.title}”` };
      return {
        cards: s.cards.map((c) => (c.id === id ? { ...c, column: from } : c)),
        counts: { ...s.counts, [to]: s.counts[to] - 1, [from]: s.counts[from] + 1 },
        error: `Could not move “${card.title}”`,
      };
    });
  } finally {
    settle(id);
  }
}

export async function addCard() {
  const s0 = get();
  const title = s0.draft.trim();
  if (!title || s0.adding) return;
  set({ adding: true, error: "" });
  try {
    const r = await api<Card>("/cards", { method: "POST", body: JSON.stringify({ title, column: "todo", owner: ME, points: 1 }) });
    if (r.status !== 201 && r.status !== 200) throw new Error(`HTTP ${r.status}`);
    set((s) => {
      const cards = upsert(s.cards, r.body);
      return { cards, counts: tally(cards), adding: false, draft: s.draft.trim() === title ? "" : s.draft };
    });
  } catch {
    set({ adding: false, error: "Could not add the card" });
  }
}

// ------------------------------------------------------------------------------------------------- live
type Push = { type: "created" | "updated" | "deleted"; id: number; item: Card | null };

function onPush(ev: Push) {
  set((s) => {
    if (ev.type === "deleted") {
      const cards = s.cards.filter((c) => c.id !== ev.id);
      return { cards, counts: COUNTS === "recount" ? tally(cards) : s.counts };
    }
    const item = ev.item;
    if (!item) return s;
    const local = s.cards.find((c) => c.id === item.id);
    if (local && PUSH === "version-check" && (item.version <= local.version || s.pending[item.id])) return s;
    if (local && PUSH === "ignore-pending" && s.pending[item.id]) return s;
    const cards = upsert(s.cards, item);
    return { cards, counts: COUNTS === "recount" ? tally(cards) : s.counts };
  });
}

function connect(resync: boolean) {
  const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/cards`);
  ws.onopen = () => {
    set({ connected: true });
    if (resync) void load();
  };
  ws.onmessage = (e) => onPush(JSON.parse(e.data as string) as Push);
  ws.onclose = () => {
    set({ connected: false });
    setTimeout(() => connect(true), 1500);
  };
}

// --------------------------------------------------------------------------------------------------- UI
function Column({ col }: { col: Col }) {
  const s = useBoard();
  const cards = s.cards.filter((c) => c.column === col && (!s.mineOnly || c.owner === ME));
  return (
    <section className={`column ${col}`}>
      <h2>
        {col === "todo" ? "To do" : col === "doing" ? "In progress" : "Done"} <span className="count">{s.counts[col]}</span>
      </h2>
      <ul>
        {cards.map((c) => (
          <li key={c.id} className={s.pending[c.id] ? "card saving" : "card"}>
            {col !== "todo" && (
              <button className="left" aria-label={`Move ${c.title} left`} onClick={() => void move(c.id, -1)}>
                ←
              </button>
            )}
            <span className="title">{c.title}</span> <span className="owner">{c.owner}</span> <span className="pts">{c.points} pts</span>
            {col !== "done" && (
              <button className="right" aria-label={`Move ${c.title} right`} onClick={() => void move(c.id, 1)}>
                →
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Board() {
  const s = useBoard();
  useEffect(() => {
    void load();
    connect(false);
  }, []);
  return (
    <main className="board">
      <header>
        <h1>Sprint 19</h1>
        <span className="live">{s.connected ? "Live" : "Reconnecting…"}</span>
        <label>
          <input type="checkbox" name="mine" checked={s.mineOnly} onChange={(e) => set({ mineOnly: e.target.checked })} /> Only my cards
        </label>
        <button className="reload" onClick={() => void load()}>
          {s.loading ? "Loading…" : "Reload"}
        </button>
      </header>
      {s.error && <p role="alert">{s.error}</p>}
      {s.notice && <p className="notice">{s.notice}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void addCard();
        }}
      >
        <input name="cardTitle" value={s.draft} onChange={(e) => set({ draft: e.target.value })} placeholder="New card" aria-label="New card title" />
        <button className="add-card" type="submit" disabled={s.adding}>
          Add card
        </button>
      </form>
      <div className="columns">
        {COLS.map((c) => (
          <Column key={c} col={c} />
        ))}
      </div>
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<Board />);
