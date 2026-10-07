import type { World, WorldDef } from "../core.ts";
import { now } from "../core.ts";

export const COLUMNS = [
  { id: "backlog", title: "Backlog" },
  { id: "doing", title: "In progress" },
  { id: "review", title: "Review" },
  { id: "done", title: "Done" },
] as const;
export type ColumnId = (typeof COLUMNS)[number]["id"];

export interface Card {
  id: string;
  title: string;
  column: ColumnId;
  rank: number;
  version: number;
  updatedBy: string;
  updatedAt: number;
  tag: string;
}

interface BoardState {
  cards: Record<string, Card>;
  moves: { t: number; card: string; column: ColumnId; by: string; version: number }[];
  lastUserCard: string | null;
}

export const BOARD_SEED: [string, string, ColumnId, string][] = [
  ["c1", "Set up CI cache", "backlog", "infra"],
  ["c2", "Rate-limit the login endpoint", "backlog", "security"],
  ["c3", "Dark mode tokens", "doing", "design"],
  ["c4", "Fix flaky checkout test", "doing", "bug"],
  ["c5", "Migration for order totals", "review", "backend"],
  ["c6", "Upgrade to React 19", "review", "frontend"],
  ["c7", "Audit log export", "backlog", "backend"],
  ["c8", "Onboarding email copy", "done", "growth"],
  ["c9", "Image CDN cutover", "doing", "infra"],
  ["c10", "Connection pooling", "backlog", "backend"],
];

export const TEAMMATES = ["Ana", "Kofi", "Mei"];

function moveCard(w: World<BoardState>, id: string, column: ColumnId, by: string): Card {
  const s = w.state;
  const card = s.cards[id];
  const maxRank = Math.max(0, ...Object.values(s.cards).filter((c) => c.column === column && c.id !== id).map((c) => c.rank));
  card.column = column;
  card.rank = maxRank + 1;
  card.version += 1;
  card.updatedBy = by;
  card.updatedAt = now();
  s.moves.push({ t: card.updatedAt, card: id, column, by, version: card.version });
  w.publish("card.moved", { card: { ...card } });
  return card;
}

function otherColumn(w: World<BoardState>, from: ColumnId): ColumnId {
  const i = COLUMNS.findIndex((c) => c.id === from);
  const options = COLUMNS.filter((_, j) => j !== i && Math.abs(j - i) <= 2).map((c) => c.id);
  return w.scriptRng.pick(options);
}

export function teammateMove(w: World<BoardState>, args: { card?: string; column?: ColumnId; recent?: boolean } = {}) {
  const s = w.state;
  const ids = Object.keys(s.cards);
  const id = args.card ?? (args.recent && s.lastUserCard ? s.lastUserCard : w.scriptRng.pick(ids));
  const card = s.cards[id];
  if (!card) return null;
  const column = args.column && args.column !== card.column ? args.column : otherColumn(w, card.column);
  return moveCard(w, id, column, w.scriptRng.pick(TEAMMATES));
}

export const boardWorld: WorldDef<BoardState> = {
  demo: "board",
  create: () => {
    const t = now();
    const cards: Record<string, Card> = {};
    const ranks: Record<string, number> = {};
    for (const [id, title, column, tag] of BOARD_SEED) {
      ranks[column] = (ranks[column] ?? 0) + 1;
      cards[id] = { id, title, column, rank: ranks[column], version: 1, updatedBy: "seed", updatedAt: t, tag };
    }
    return { cards, moves: [], lastUserCard: null };
  },
  start: (w) => {
    const every = Number(w.params.teamEveryMs ?? 9000);
    if (every > 0) {
      const next = () => {
        teammateMove(w);
        w.script(w.scriptRng.exp(every) + 1500, next);
      };
      w.script(w.scriptRng.exp(every) + 3000, next);
    }
  },
  action: (w, name, args) => {
    if (name === "teammateMove") return teammateMove(w, args ?? {});
    return undefined;
  },
  routes: [
    {
      method: "GET",
      pattern: /^\/board$/,
      key: () => "board",
      handle: (w) => ({
        status: 200,
        json: { columns: COLUMNS, cards: Object.values(w.state.cards), at: now() },
        work: 20,
      }),
    },
    {
      method: "POST",
      pattern: /^\/cards\/([\w-]+)\/move$/,
      key: () => "board/move",
      handle: (w, req) => {
        const id = req.params[0];
        const card = w.state.cards[id];
        const column = (req.body as { column?: ColumnId } | undefined)?.column;
        if (!card) return { status: 404, json: { error: "Card not found" } };
        if (!column || !COLUMNS.some((c) => c.id === column)) return { status: 400, json: { error: "Unknown column" } };
        w.state.lastUserCard = id;
        const moved = moveCard(w, id, column, "you");
        return { status: 200, json: { card: { ...moved } }, effect: `${id} → ${column} (v${moved.version})` };
      },
    },
    {
      method: "GET",
      pattern: /^\/board\/events$/,
      key: () => "board/events",
      stream: true,
    },
  ],
  snapshot: (w) => ({
    cards: Object.fromEntries(Object.values(w.state.cards).map((c) => [c.id, { column: c.column, version: c.version, updatedBy: c.updatedBy }])),
    moves: w.state.moves,
  }),
};
