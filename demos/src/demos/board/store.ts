// Board store: Zustand, registered with GenClass through its middleware.
// Latent bugs (deliberate, realistic):
//   - live events are applied as they arrive, with no version check (out-of-order events win);
//   - a failed move restores the whole board snapshot taken before the move, discarding everything that
//     arrived in the meantime.
import { create, type StateCreator } from "zustand";
import { genclass } from "@genclass/runtime/zustand";
import type { Runtime } from "@genclass/runtime";
import { api } from "../../shared/api.ts";

export type ColumnId = "backlog" | "doing" | "review" | "done";

export interface Card {
  id: string;
  title: string;
  column: ColumnId;
  rank: number;
  version: number;
  updatedBy: string;
  updatedAt: number;
  tag: string;
  pending?: boolean;
}

export interface BoardEvent {
  seq: number;
  type: "card.moved";
  card: Card;
}

export interface BoardState {
  cards: Record<string, Card>;
  columns: { id: ColumnId; title: string }[];
  loaded: boolean;
  live: boolean;
  notice: string | null;
  lastEvent: string | null;
  load(): Promise<void>;
  move(id: string, column: ColumnId): Promise<void>;
  applyEvent(ev: BoardEvent): void;
  setLive(live: boolean): void;
  dismiss(): void;
}

function topRank(cards: Record<string, Card>, column: ColumnId, except: string): number {
  return Math.max(0, ...Object.values(cards).filter((c) => c.column === column && c.id !== except).map((c) => c.rank));
}

export function createBoardStore(gc: Runtime) {
  const creator: StateCreator<BoardState> = (set, get) => ({
      cards: {},
      columns: [],
      loaded: false,
      live: false,
      notice: null,
      lastEvent: null,

      async load() {
        const res = await fetch(api("board"));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { columns: { id: ColumnId; title: string }[]; cards: Card[] };
        set({ columns: data.columns, cards: Object.fromEntries(data.cards.map((c) => [c.id, c])), loaded: true });
      },

      async move(id, column) {
        const before = get().cards;
        const card = before[id];
        if (!card || card.column === column) return;
        set((s) => ({ cards: { ...s.cards, [id]: { ...card, column, rank: topRank(s.cards, column, id) + 1, pending: true } } }));
        try {
          const res = await fetch(api(`cards/${id}/move`), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ column }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const { card: saved } = (await res.json()) as { card: Card };
          set((s) => ({ cards: { ...s.cards, [id]: { ...saved, pending: false } } }));
        } catch {
          set({ cards: before, notice: `Couldn’t move “${card.title}”. It was put back.` });
        }
      },

      applyEvent(ev) {
        if (ev.type !== "card.moved") return;
        set((s) => ({
          cards: { ...s.cards, [ev.card.id]: { ...ev.card, pending: false } },
          lastEvent: ev.card.updatedBy === "you" ? s.lastEvent : `${ev.card.updatedBy} moved “${ev.card.title}”`,
        }));
      },

      setLive(live) {
        set({ live });
      },

      dismiss() {
        set({ notice: null });
      },
  });
  return create<BoardState>()(genclass(gc, "board")(creator));
}

export type BoardStore = ReturnType<typeof createBoardStore>;
