// Team kanban board in React 19 + Zustand. Moves are optimistic; teammates' moves (and the echo of your own)
// arrive on a live EventSource stream.
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppContext } from "../../shared/demo-def.ts";
import { api } from "../../shared/api.ts";
import { createBoardStore, type BoardEvent, type BoardStore, type Card, type ColumnId } from "./store.ts";
import "./app.css";

const PEOPLE: Record<string, number> = { you: 230, Ana: 330, Kofi: 160, Mei: 25, seed: 210 };

function Avatar({ who }: { who: string }) {
  const hue = PEOPLE[who] ?? 200;
  return (
    <span className="kb-avatar" style={{ ["--h" as string]: hue }} title={who === "you" ? "You" : who}>
      {who === "seed" ? "·" : who === "you" ? "Y" : who[0]}
    </span>
  );
}

function CardView({ card, cols, onMove }: { card: Card; cols: ColumnId[]; onMove: (id: string, to: ColumnId) => void }) {
  const i = cols.indexOf(card.column);
  return (
    <article
      className={`kb-card${card.pending ? " pending" : ""}`}
      data-card={card.id}
      data-pending={card.pending ? "true" : "false"}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", card.id);
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      <div className="kb-card-top">
        <span className="kb-tag" data-tag={card.tag}>
          {card.tag}
        </span>
        <span className="kb-ver">v{card.version}</span>
      </div>
      <div className="kb-title">{card.title}</div>
      <div className="kb-card-foot">
        <Avatar who={card.updatedBy} />
        {card.pending && <span className="kb-sync">syncing</span>}
        <span className="kb-moves">
          <button type="button" aria-label="Move left" data-testid={`mv-left-${card.id}`} disabled={i <= 0} onClick={() => onMove(card.id, cols[i - 1])}>
            ‹
          </button>
          <button type="button" aria-label="Move right" data-testid={`mv-right-${card.id}`} disabled={i >= cols.length - 1} onClick={() => onMove(card.id, cols[i + 1])}>
            ›
          </button>
        </span>
      </div>
    </article>
  );
}

function Board({ useBoard }: { useBoard: BoardStore }) {
  const cards = useBoard((s) => s.cards);
  const columns = useBoard((s) => s.columns);
  const loaded = useBoard((s) => s.loaded);
  const live = useBoard((s) => s.live);
  const notice = useBoard((s) => s.notice);
  const lastEvent = useBoard((s) => s.lastEvent);
  const [over, setOver] = useState<ColumnId | null>(null);

  useEffect(() => {
    const { load, applyEvent, setLive } = useBoard.getState();
    void load().catch(() => {});
    const es = new EventSource(api("board/events"));
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.onmessage = (e) => applyEvent(JSON.parse(e.data) as BoardEvent);
    return () => es.close();
  }, [useBoard]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => useBoard.getState().dismiss(), 4000);
    return () => clearTimeout(t);
  }, [notice, useBoard]);

  const colIds = useMemo(() => columns.map((c) => c.id), [columns]);
  const byCol = useMemo(() => {
    const m: Record<string, Card[]> = {};
    for (const c of Object.values(cards)) (m[c.column] ??= []).push(c);
    for (const k of Object.keys(m)) m[k].sort((a, b) => a.rank - b.rank);
    return m;
  }, [cards]);
  const move = (id: string, to: ColumnId) => void useBoard.getState().move(id, to);

  return (
    <div className="kb">
      <header className="kb-head">
        <div>
          <div className="kb-title-main">Sprint 14 · Platform</div>
          <div className="kb-sub">{lastEvent ?? "Your team is working on this board"}</div>
        </div>
        <div className="kb-head-right">
          <span className="kb-people">
            <Avatar who="Ana" />
            <Avatar who="Kofi" />
            <Avatar who="Mei" />
          </span>
          <span className={`kb-live${live ? " on" : ""}`} data-testid="live">
            <i /> {live ? "Live" : "Connecting…"}
          </span>
        </div>
      </header>
      {!loaded ? (
        <div className="kb-loading">Loading board…</div>
      ) : (
        <div className="kb-cols">
          {columns.map((col) => (
            <section
              key={col.id}
              className={`kb-col${over === col.id ? " over" : ""}`}
              data-testid={`col-${col.id}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(col.id);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const id = e.dataTransfer.getData("text/plain");
                if (id) move(id, col.id);
              }}
            >
              <div className="kb-col-head">
                <span>{col.title}</span>
                <span className="kb-n">{byCol[col.id]?.length ?? 0}</span>
              </div>
              <div className="kb-stack">
                {(byCol[col.id] ?? []).map((c) => (
                  <CardView key={c.id} card={c} cols={colIds} onMove={move} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      {notice && (
        <div className="kb-notice" role="status" data-testid="notice">
          {notice}
        </div>
      )}
    </div>
  );
}

export function mountBoard({ gc, el }: AppContext): void {
  const useBoard = createBoardStore(gc);
  createRoot(el).render(<Board useBoard={useBoard} />);
}
