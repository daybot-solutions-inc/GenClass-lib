// Presentational components shared by every data layer (the compat DOM contract: compat/harness/scenarios.mjs).
import { useEffect, useState, type ReactNode } from "react";
import type { Detail, Item, Todo } from "./api";

export type NoteRow = { key: string; text: string; pending?: boolean };

/** #compat root; data-ready="1" once mounted (hydrated) and the scenario's initial data is in. */
export function Shell({ ready = true, children }: { ready?: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div id="compat" data-ssr="1" data-ready={mounted && ready ? "1" : "0"}>
      {children}
    </div>
  );
}

export const ErrorLine = ({ error }: { error?: string | null }) => (error ? <p data-testid="error">{error}</p> : null);

export function Typeahead({ q, onQ, results }: { q: string; onQ: (q: string) => void; results: string[] }) {
  return (
    <Shell>
      <h2>City search</h2>
      <input data-testid="q" value={q} onChange={(e) => onQ(e.target.value)} placeholder="Search cities" autoComplete="off" />
      <ul>
        {results.map((r) => (
          <li key={r} data-testid="result">
            {r}
          </li>
        ))}
      </ul>
    </Shell>
  );
}

export function CreateForm({ title, onTitle, onSubmit }: { title: string; onTitle: (t: string) => void; onSubmit: () => void }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <input data-testid="title" value={title} onChange={(e) => onTitle(e.target.value)} placeholder="New item" />
      <button data-testid="create" type="submit">
        Create
      </button>
    </form>
  );
}

export const ItemList = ({ items }: { items: Item[] }) => (
  <ul>
    {items.map((i) => (
      <li key={i.id} data-testid="item">
        {i.title}
      </li>
    ))}
  </ul>
);

export function Create(p: { ready: boolean; items: Item[]; title: string; onTitle: (t: string) => void; onSubmit: () => void; error?: string | null }) {
  return (
    <Shell ready={p.ready}>
      <h2>Items</h2>
      <CreateForm title={p.title} onTitle={p.onTitle} onSubmit={p.onSubmit} />
      <ItemList items={p.items} />
      <ErrorLine error={p.error} />
    </Shell>
  );
}

export function Panels({ onLoad, left, right }: { onLoad: () => void; left?: string[] | null; right?: string[] | null }) {
  return (
    <Shell>
      <button data-testid="load" onClick={onLoad}>
        Load both
      </button>
      <section>
        <h3>People</h3>
        <ul>{left?.map((r) => <li key={r} data-testid="left-row">{r}</li>)}</ul>
      </section>
      <section>
        <h3>Activity</h3>
        <ul>{right?.map((r) => <li key={r} data-testid="right-row">{r}</li>)}</ul>
      </section>
    </Shell>
  );
}

export function Todos({ ready, todos, onToggle, error }: { ready: boolean; todos: Todo[]; onToggle: (t: Todo) => void; error?: string | null }) {
  return (
    <Shell ready={ready}>
      <h2>Todos</h2>
      <ul>
        {todos.map((t) => (
          <li key={t.id} data-testid="todo">
            <label>
              <input type="checkbox" data-testid={`toggle-${t.id}`} checked={t.done} onChange={() => onToggle(t)} />
              {t.title}: {t.done ? "done" : "open"}
            </label>
          </li>
        ))}
      </ul>
      <ErrorLine error={error} />
    </Shell>
  );
}

export function Notes({ ready, notes, draft, onDraft, onAdd }: { ready: boolean; notes: NoteRow[]; draft: string; onDraft: (t: string) => void; onAdd: () => void }) {
  return (
    <Shell ready={ready}>
      <h2>Notes</h2>
      <input data-testid="note-text" value={draft} onChange={(e) => onDraft(e.target.value)} placeholder="Note" />
      <button data-testid="note-add" onClick={onAdd}>
        Add
      </button>
      <ul>
        {notes.map((n) => (
          <li key={n.key} data-testid="note">
            {n.text}
            {n.pending ? " (pending)" : ""}
          </li>
        ))}
      </ul>
    </Shell>
  );
}

export function Counter({ count, synced, onPlus }: { count: number; synced: number; onPlus: () => void }) {
  return (
    <Shell>
      <button data-testid="plus" onClick={onPlus}>
        +1
      </button>
      <p>
        Count <span data-testid="count">{count}</span>, saved <span data-testid="synced">{synced}</span>
      </p>
    </Shell>
  );
}

/** Scenario g: Start mounts the live panel. */
export function Live({ children }: { children: ReactNode }) {
  const [on, setOn] = useState(false);
  return (
    <Shell>
      <button data-testid="start" onClick={() => setOn(true)}>
        Start
      </button>
      {on ? children : null}
    </Shell>
  );
}

export function LivePanel({ tick, polls, details }: { tick: number; polls: number; details: (Detail | undefined)[] }) {
  return (
    <div>
      <p>
        Tick <span data-testid="tick">{tick}</span> after <span data-testid="polls">{polls}</span> polls
      </p>
      <ul>
        {details.map((d, i) =>
          d ? (
            <li key={d.id} data-testid="detail">
              {d.name}: {d.price}
            </li>
          ) : (
            <li key={`l${i}`}>loading</li>
          ),
        )}
      </ul>
    </div>
  );
}

export function Clean(p: { ready: boolean; items: Item[]; q: string; onQ: (q: string) => void; results: string[]; title: string; onTitle: (t: string) => void; onCreate: () => void }) {
  return (
    <Shell ready={p.ready}>
      <h2>Items</h2>
      <ItemList items={p.items} />
      <CreateForm title={p.title} onTitle={p.onTitle} onSubmit={p.onCreate} />
      <h2>Search</h2>
      <input data-testid="q" value={p.q} onChange={(e) => p.onQ(e.target.value)} placeholder="Search cities" autoComplete="off" />
      <ul>
        {p.results.map((r) => (
          <li key={r} data-testid="result">
            {r}
          </li>
        ))}
      </ul>
    </Shell>
  );
}
