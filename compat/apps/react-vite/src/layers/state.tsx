// Data layer "state": plain fetch + useState/useEffect, written the way a lot of React code is: no request
// ordering guard in the typeahead (a), no submit guard on the create form (b). The other scenarios are correct.
// GenClass sees the network and user input only (React state is invisible to it).
import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import * as V from "../views";

function A() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<string[]>([]);
  useEffect(() => {
    if (!q) return setResults([]);
    api.search(q).then((r) => setResults(r.results), () => {});
  }, [q]);
  return <V.Typeahead q={q} onQ={setQ} results={results} />;
}

function B() {
  const [items, setItems] = useState<api.Item[] | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void api.items().then((r) => setItems(r.items)), []);
  const submit = async () => {
    try {
      const item = await api.createItem(title);
      setItems((xs) => [...(xs ?? []), item]);
      setTitle("");
    } catch {
      setError("Could not create");
    }
  };
  return <V.Create ready={items !== null} items={items ?? []} title={title} onTitle={setTitle} onSubmit={submit} error={error} />;
}

function C() {
  const [left, setLeft] = useState<string[] | null>(null);
  const [right, setRight] = useState<string[] | null>(null);
  const load = () => {
    api.left().then((p) => setLeft(p.rows));
    api.right().then((p) => setRight(p.rows));
  };
  return <V.Panels onLoad={load} left={left} right={right} />;
}

function D() {
  const [todos, setTodos] = useState<api.Todo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void api.todos().then((r) => setTodos(r.todos)), []);
  const toggle = async (t: api.Todo) => {
    const done = !t.done;
    setTodos((ts) => ts!.map((x) => (x.id === t.id ? { ...x, done } : x))); // optimistic
    try {
      const saved = await api.toggleTodo(t.id, done);
      setTodos((ts) => ts!.map((x) => (x.id === saved.id ? saved : x)));
    } catch {
      setTodos((ts) => ts!.map((x) => (x.id === t.id ? { ...x, done: t.done } : x))); // roll back
      setError(`Could not save "${t.title}"`);
    }
  };
  return <V.Todos ready={todos !== null} todos={todos ?? []} onToggle={toggle} error={error} />;
}

let noteSeq = 0;
function E() {
  const [notes, setNotes] = useState<V.NoteRow[] | null>(null);
  const [draft, setDraft] = useState("");
  useEffect(() => void api.notes().then((r) => setNotes(r.notes.map((n) => ({ key: `s${n.id}`, text: n.text })))), []);
  const outbox = useRef<api.Outbox<V.NoteRow> | null>(null);
  useEffect(() => {
    const o = api.createOutbox<V.NoteRow>(async (row) => {
      try {
        const saved = await api.addNote(row.text);
        setNotes((ns) => ns!.map((n) => (n.key === row.key ? { key: `s${saved.id}`, text: saved.text } : n)));
        return true;
      } catch {
        return false;
      }
    });
    outbox.current = o;
    return () => o.dispose();
  }, []);
  const add = () => {
    const row = { key: `l${++noteSeq}`, text: draft, pending: true };
    setDraft("");
    setNotes((ns) => [...(ns ?? []), row]);
    void outbox.current?.submit(row);
  };
  return <V.Notes ready={notes !== null} notes={notes ?? []} draft={draft} onDraft={setDraft} onAdd={add} />;
}

function F() {
  const [count, setCount] = useState(0);
  const [synced, setSynced] = useState(0);
  const plus = () => {
    setCount((c) => c + 1);
    api.increment().then((r) => setSynced((s) => Math.max(s, r.count)));
  };
  return <V.Counter count={count} synced={synced} onPlus={plus} />;
}

function LiveData() {
  const [tick, setTick] = useState(0);
  const [polls, setPolls] = useState(0);
  const [details, setDetails] = useState<Record<number, api.Detail>>({});
  useEffect(() => {
    for (const id of api.DETAIL_IDS) api.detail(id).then((d) => setDetails((m) => ({ ...m, [id]: d })));
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const r = await api.status();
      if (stopped) return;
      setTick(r.tick);
      setPolls((p) => p + 1);
      if (r.tick < 8) timer = setTimeout(poll, 250);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  return <V.LivePanel tick={tick} polls={polls} details={api.DETAIL_IDS.map((id) => details[id])} />;
}
const G = () => (
  <V.Live>
    <LiveData />
  </V.Live>
);

function H() {
  const [items, setItems] = useState<api.Item[] | null>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  useEffect(() => void api.items().then((r) => setItems(r.items)), []);
  useEffect(() => {
    if (!q) return setResults([]);
    api.search(q).then((r) => setResults(r.results), () => {});
  }, [q]);
  const create = async () => {
    const item = await api.createItem(title);
    setItems((xs) => [...(xs ?? []), item]);
    setTitle("");
  };
  return <V.Clean ready={items !== null} items={items ?? []} q={q} onQ={setQ} results={results} title={title} onTitle={setTitle} onCreate={create} />;
}

const S: Record<string, () => React.ReactElement> = { a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H };
export default function StateLayer({ s }: { s: string }) {
  const C = S[s] ?? H;
  return <C />;
}
