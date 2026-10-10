// Data layer "apollo": Apollo Client 4 against the mock GraphQL endpoint (/graphql), idiomatic: queries keyed by
// variables (a cannot show stale results by construction), mutations with refetchQueries and no in-flight guard
// (b: double submit), optimisticResponse for the toggles (d: Apollo drops the optimistic layer on error), an offline
// outbox (e), pollInterval / stopPolling (g).
import { ApolloClient, HttpLink, InMemoryCache, gql } from "@apollo/client";
import { ApolloProvider, useApolloClient, useMutation, useQuery } from "@apollo/client/react";
import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import * as V from "../views";

/* eslint-disable @typescript-eslint/no-explicit-any */
const SEARCH = gql`query Search($q: String!) { search(q: $q) { q results } }`;
const ITEMS = gql`query Items { items { id title } }`;
const CREATE = gql`mutation CreateItem($title: String!) { createItem(title: $title) { id title } }`;
const LEFT = gql`query Left { left { id version rows } }`;
const RIGHT = gql`query Right { right { id version rows } }`;
const TODOS = gql`query Todos { todos { id title done } }`;
const TOGGLE = gql`mutation ToggleTodo($id: ID!, $done: Boolean!) { toggleTodo(id: $id, done: $done) { id title done } }`;
const NOTES = gql`query Notes { notes { id text } }`;
const ADD_NOTE = gql`mutation AddNote($text: String!) { addNote(text: $text) { id text } }`;
const INCREMENT = gql`mutation Increment { increment { id count } }`;
const STATUS = gql`query Status { status { id tick } }`;
const DETAIL = gql`query Detail($id: ID!) { detail(id: $id) { id name price } }`;

const client = new ApolloClient({ link: new HttpLink({ uri: "/graphql" }), cache: new InMemoryCache() });

function A() {
  const [q, setQ] = useState("");
  const { data } = useQuery<any>(SEARCH, { variables: { q }, skip: !q });
  return <V.Typeahead q={q} onQ={setQ} results={q ? (data?.search?.results ?? []) : []} />;
}

function B() {
  const items = useQuery<any>(ITEMS);
  const [create, { error }] = useMutation<any>(CREATE, { refetchQueries: ["Items"] });
  const [title, setTitle] = useState("");
  const submit = () =>
    create({ variables: { title } }).then(
      () => setTitle(""),
      () => {},
    );
  return <V.Create ready={!!items.data} items={items.data?.items ?? []} title={title} onTitle={setTitle} onSubmit={submit} error={error ? "Could not create" : null} />;
}

function C() {
  const [go, setGo] = useState(false);
  const left = useQuery<any>(LEFT, { skip: !go });
  const right = useQuery<any>(RIGHT, { skip: !go });
  return <V.Panels onLoad={() => setGo(true)} left={left.data?.left?.rows} right={right.data?.right?.rows} />;
}

function D() {
  const todos = useQuery<any>(TODOS);
  const [toggle] = useMutation<any>(TOGGLE);
  const [error, setError] = useState<string | null>(null);
  const onToggle = (t: api.Todo) =>
    toggle({
      variables: { id: t.id, done: !t.done },
      optimisticResponse: { toggleTodo: { __typename: "Todo", id: t.id, title: t.title, done: !t.done } },
    }).catch(() => setError(`Could not save "${t.title}"`));
  return <V.Todos ready={!!todos.data} todos={todos.data?.todos ?? []} onToggle={onToggle} error={error} />;
}

let noteSeq = 0;
function E() {
  const apollo = useApolloClient();
  const notes = useQuery<any>(NOTES);
  const [pending, setPending] = useState<V.NoteRow[]>([]);
  const [draft, setDraft] = useState("");
  const outbox = useRef<api.Outbox<V.NoteRow> | null>(null);
  useEffect(() => {
    const o = api.createOutbox<V.NoteRow>(async (row) => {
      try {
        await apollo.mutate({ mutation: ADD_NOTE, variables: { text: row.text }, refetchQueries: ["Notes"], awaitRefetchQueries: true });
        setPending((p) => p.filter((x) => x.key !== row.key));
        return true;
      } catch {
        return false;
      }
    });
    outbox.current = o;
    return () => o.dispose();
  }, [apollo]);
  const add = () => {
    const row = { key: `l${++noteSeq}`, text: draft, pending: true };
    setDraft("");
    setPending((p) => [...p, row]);
    void outbox.current?.submit(row);
  };
  const rows: V.NoteRow[] = [...(notes.data?.notes ?? []).map((n: api.Note) => ({ key: `s${n.id}`, text: n.text })), ...pending];
  return <V.Notes ready={!!notes.data} notes={rows} draft={draft} onDraft={setDraft} onAdd={add} />;
}

function F() {
  const [count, setCount] = useState(0);
  const [synced, setSynced] = useState(0);
  const [inc] = useMutation<any>(INCREMENT);
  const plus = () => {
    setCount((c) => c + 1);
    inc().then((r) => setSynced((s) => Math.max(s, r.data?.increment?.count ?? 0)));
  };
  return <V.Counter count={count} synced={synced} onPlus={plus} />;
}

function DetailRow({ id, onData }: { id: number; onData: (d: api.Detail) => void }) {
  const { data } = useQuery<any>(DETAIL, { variables: { id } });
  useEffect(() => void (data?.detail && onData({ id: Number(data.detail.id), name: data.detail.name, price: data.detail.price })), [data, onData]);
  return null;
}
function LiveData() {
  const status = useQuery<any>(STATUS, { pollInterval: 250 });
  const tick: number = status.data?.status?.tick ?? 0;
  const [polls, setPolls] = useState(0);
  const [details, setDetails] = useState<Record<number, api.Detail>>({});
  const onData = useRef((d: api.Detail) => setDetails((m) => (m[d.id] ? m : { ...m, [d.id]: d }))).current;
  const { stopPolling } = status;
  useEffect(() => {
    if (!tick) return;
    setPolls((p) => p + 1);
    if (tick >= 8) stopPolling();
  }, [tick, stopPolling]);
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
  const items = useQuery<any>(ITEMS);
  const [q, setQ] = useState("");
  const results = useQuery<any>(SEARCH, { variables: { q }, skip: !q });
  const [create] = useMutation<any>(CREATE, { refetchQueries: ["Items"], awaitRefetchQueries: true });
  const [title, setTitle] = useState("");
  return (
    <V.Clean
      ready={!!items.data}
      items={items.data?.items ?? []}
      q={q}
      onQ={setQ}
      results={q ? (results.data?.search?.results ?? []) : []}
      title={title}
      onTitle={setTitle}
      onCreate={() => void create({ variables: { title } }).then(() => setTitle(""))}
    />
  );
}

const S: Record<string, () => React.ReactElement> = { a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H };
export default function ApolloLayer({ s }: { s: string }) {
  const C = S[s] ?? H;
  return (
    <ApolloProvider client={client}>
      <C />
    </ApolloProvider>
  );
}
