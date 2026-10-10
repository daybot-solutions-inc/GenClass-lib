"use client";
// Data layer "swr": SWR 2, idiomatic. Keys are URLs (a cannot show stale results by construction), creates use
// useSWRMutation with no in-flight guard (b: double submit), toggles use the bound mutate with optimisticData +
// rollbackOnError (d), the offline outbox revalidates the list after each sync (e), polling uses a refreshInterval
// function (g; dedupingInterval 0 so 250 ms polls are not deduplicated into one).
import { useEffect, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import useSWRMutation from "swr/mutation";
import * as api from "../api";
import * as V from "../views";

const get = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new api.HttpError(r.status);
  return (await r.json()) as T;
};
const post = <T,>(url: string, { arg }: { arg: unknown }) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(arg) }).then((r) => {
    if (!r.ok) throw new api.HttpError(r.status);
    return r.json() as Promise<T>;
  });

function A() {
  const [q, setQ] = useState("");
  const { data } = useSWR<{ results: string[] }>(q ? `/api/search?q=${encodeURIComponent(q)}` : null, get);
  return <V.Typeahead q={q} onQ={setQ} results={q ? (data?.results ?? []) : []} />;
}

function B() {
  const items = useSWR<{ items: api.Item[] }>("/api/items", get);
  const create = useSWRMutation("/api/items", post<api.Item>);
  const [title, setTitle] = useState("");
  const submit = () =>
    create.trigger({ title }).then(
      () => setTitle(""),
      () => {},
    );
  return <V.Create ready={!!items.data} items={items.data?.items ?? []} title={title} onTitle={setTitle} onSubmit={submit} error={create.error ? "Could not create" : null} />;
}

function C() {
  const [go, setGo] = useState(false);
  const left = useSWR<api.Panel>(go ? "/api/left" : null, get);
  const right = useSWR<api.Panel>(go ? "/api/right" : null, get);
  return <V.Panels onLoad={() => setGo(true)} left={left.data?.rows} right={right.data?.rows} />;
}

function D() {
  const { data, mutate } = useSWR<{ todos: api.Todo[] }>("/api/todos", get);
  const [error, setError] = useState<string | null>(null);
  const onToggle = (t: api.Todo) => {
    const done = !t.done;
    const next = (d?: { todos: api.Todo[] }) => ({ todos: (d?.todos ?? []).map((x) => (x.id === t.id ? { ...x, done } : x)) });
    mutate(
      async (cur) => {
        await api.toggleTodo(t.id, done);
        return next(cur);
      },
      { optimisticData: next, rollbackOnError: true, populateCache: false, revalidate: true },
    ).catch(() => setError(`Could not save "${t.title}"`));
  };
  return <V.Todos ready={!!data} todos={data?.todos ?? []} onToggle={onToggle} error={error} />;
}

let noteSeq = 0;
function E() {
  const notes = useSWR<{ notes: api.Note[] }>("/api/notes", get);
  const { mutate } = useSWRConfig();
  const [pending, setPending] = useState<V.NoteRow[]>([]);
  const [draft, setDraft] = useState("");
  const outbox = useRef<api.Outbox<V.NoteRow> | null>(null);
  useEffect(() => {
    const o = api.createOutbox<V.NoteRow>(async (row) => {
      try {
        await api.addNote(row.text);
        await mutate("/api/notes");
        setPending((p) => p.filter((x) => x.key !== row.key));
        return true;
      } catch {
        return false;
      }
    });
    outbox.current = o;
    return () => o.dispose();
  }, [mutate]);
  const add = () => {
    const row = { key: `l${++noteSeq}`, text: draft, pending: true };
    setDraft("");
    setPending((p) => [...p, row]);
    void outbox.current?.submit(row);
  };
  const rows: V.NoteRow[] = [...(notes.data?.notes ?? []).map((n) => ({ key: `s${n.id}`, text: n.text })), ...pending];
  return <V.Notes ready={!!notes.data} notes={rows} draft={draft} onDraft={setDraft} onAdd={add} />;
}

function F() {
  const [count, setCount] = useState(0);
  const [synced, setSynced] = useState(0);
  const inc = useSWRMutation("/api/counter/increment", post<{ count: number }>);
  const plus = () => {
    setCount((c) => c + 1);
    inc.trigger({}).then((r) => setSynced((s) => Math.max(s, r?.count ?? 0)));
  };
  return <V.Counter count={count} synced={synced} onPlus={plus} />;
}

function DetailRow({ id, onData }: { id: number; onData: (d: api.Detail) => void }) {
  const { data } = useSWR<api.Detail>(`/api/detail/${id}`, get);
  useEffect(() => void (data && onData(data)), [data, onData]);
  return null;
}
function LiveData() {
  const status = useSWR<{ tick: number }>("/api/status", get, { refreshInterval: (d) => ((d?.tick ?? 0) >= 8 ? 0 : 250), dedupingInterval: 0 });
  const tick = status.data?.tick ?? 0;
  const [polls, setPolls] = useState(0);
  const [details, setDetails] = useState<Record<number, api.Detail>>({});
  const onData = useRef((d: api.Detail) => setDetails((m) => (m[d.id] ? m : { ...m, [d.id]: d }))).current;
  useEffect(() => {
    if (tick) setPolls((p) => p + 1);
  }, [tick]);
  return (
    <>
      {api.DETAIL_IDS.map((id) => (
        <DetailRow key={id} id={id} onData={onData} />
      ))}
      <V.LivePanel tick={tick} polls={polls} details={api.DETAIL_IDS.map((id) => details[id])} />
    </>
  );
}
const G = () => (
  <V.Live>
    <LiveData />
  </V.Live>
);

function H() {
  const items = useSWR<{ items: api.Item[] }>("/api/items", get);
  const [q, setQ] = useState("");
  const results = useSWR<{ results: string[] }>(q ? `/api/search?q=${encodeURIComponent(q)}` : null, get);
  const create = useSWRMutation("/api/items", post<api.Item>);
  const [title, setTitle] = useState("");
  return (
    <V.Clean
      ready={!!items.data}
      items={items.data?.items ?? []}
      q={q}
      onQ={setQ}
      results={q ? (results.data?.results ?? []) : []}
      title={title}
      onTitle={setTitle}
      onCreate={() => void create.trigger({ title }).then(() => setTitle(""))}
    />
  );
}

const S: Record<string, () => React.ReactElement> = { a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H };
export default function SwrLayer({ s }: { s: string }) {
  const C = S[s] ?? H;
  return <C />;
}
