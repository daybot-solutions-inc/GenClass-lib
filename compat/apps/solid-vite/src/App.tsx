// Data layer "signals": Solid signals and createResource, idiomatic. The typeahead is a resource keyed by the query
// signal (Solid resolves only the latest fetch, so a cannot show stale results by construction); the create form
// has no in-flight guard (b). GenClass does not discover Solid signals (README: not covered yet).
import { For, Show, createResource, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import * as api from "./api";

type NoteRow = { key: string; text: string; pending?: boolean };

function A() {
  const [q, setQ] = createSignal("");
  const [res] = createResource(q, (v) => api.search(v));
  const results = () => (q() ? (res.latest?.results ?? []) : []);
  return (
    <>
      <h2>City search</h2>
      <input data-testid="q" value={q()} onInput={(e) => setQ(e.currentTarget.value)} placeholder="Search cities" autocomplete="off" />
      <ul>
        <For each={results()}>{(r) => <li data-testid="result">{r}</li>}</For>
      </ul>
    </>
  );
}

function ItemList(p: { items: api.Item[] }) {
  return (
    <ul>
      <For each={p.items}>{(i) => <li data-testid="item">{i.title}</li>}</For>
    </ul>
  );
}

function CreateForm(p: { title: string; setTitle: (t: string) => void; onSubmit: () => void }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        p.onSubmit();
      }}
    >
      <input data-testid="title" value={p.title} onInput={(e) => p.setTitle(e.currentTarget.value)} placeholder="New item" />
      <button data-testid="create" type="submit">
        Create
      </button>
    </form>
  );
}

function B() {
  const [items, { mutate }] = createResource(() => api.items().then((r) => r.items));
  const [title, setTitle] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const submit = async () => {
    try {
      const item = await api.createItem(title());
      mutate((xs) => [...(xs ?? []), item]);
      setTitle("");
    } catch {
      setError("Could not create");
    }
  };
  return (
    <>
      <h2>Items</h2>
      <CreateForm title={title()} setTitle={setTitle} onSubmit={submit} />
      <ItemList items={items.latest ?? []} />
      <Show when={error()}>
        <p data-testid="error">{error()}</p>
      </Show>
    </>
  );
}

function C() {
  const [go, setGo] = createSignal(false);
  const [left] = createResource(go, () => api.left());
  const [right] = createResource(go, () => api.right());
  return (
    <>
      <button data-testid="load" onClick={() => setGo(true)}>
        Load both
      </button>
      <section>
        <h3>People</h3>
        <ul>
          <For each={left.latest?.rows ?? []}>{(r) => <li data-testid="left-row">{r}</li>}</For>
        </ul>
      </section>
      <section>
        <h3>Activity</h3>
        <ul>
          <For each={right.latest?.rows ?? []}>{(r) => <li data-testid="right-row">{r}</li>}</For>
        </ul>
      </section>
    </>
  );
}

function D() {
  const [todos, { mutate }] = createResource(() => api.todos().then((r) => r.todos));
  const [error, setError] = createSignal<string | null>(null);
  const patch = (id: number, fn: (x: api.Todo) => api.Todo) => mutate((ts) => ts!.map((x) => (x.id === id ? fn(x) : x)));
  const toggle = async (t: api.Todo) => {
    const done = !t.done;
    patch(t.id, (x) => ({ ...x, done })); // optimistic
    try {
      const saved = await api.toggleTodo(t.id, done);
      patch(t.id, () => saved);
    } catch {
      patch(t.id, (x) => ({ ...x, done: t.done })); // roll back
      setError(`Could not save "${t.title}"`);
    }
  };
  return (
    <>
      <h2>Todos</h2>
      <ul>
        <For each={todos.latest ?? []}>
          {(t) => (
            <li data-testid="todo">
              <label>
                <input type="checkbox" data-testid={`toggle-${t.id}`} checked={t.done} onChange={() => void toggle(t)} />
                {t.title}: {t.done ? "done" : "open"}
              </label>
            </li>
          )}
        </For>
      </ul>
      <Show when={error()}>
        <p data-testid="error">{error()}</p>
      </Show>
    </>
  );
}

let noteSeq = 0;
function E() {
  const [notes, setNotes] = createSignal<NoteRow[] | null>(null);
  const [draft, setDraft] = createSignal("");
  onMount(() => void api.notes().then((r) => setNotes(r.notes.map((n) => ({ key: `s${n.id}`, text: n.text })))));
  const outbox = api.createOutbox<NoteRow>(async (row) => {
    try {
      const saved = await api.addNote(row.text);
      setNotes((ns) => ns!.map((n) => (n.key === row.key ? { key: `s${saved.id}`, text: saved.text } : n)));
      return true;
    } catch {
      return false;
    }
  });
  onCleanup(() => outbox.dispose());
  const add = () => {
    const row = { key: `l${++noteSeq}`, text: draft(), pending: true };
    setDraft("");
    setNotes((ns) => [...(ns ?? []), row]);
    void outbox.submit(row);
  };
  return (
    <>
      <h2>Notes</h2>
      <input data-testid="note-text" value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} placeholder="Note" />
      <button data-testid="note-add" onClick={add}>
        Add
      </button>
      <ul>
        <For each={notes() ?? []}>
          {(n) => (
            <li data-testid="note">
              {n.text}
              {n.pending ? " (pending)" : ""}
            </li>
          )}
        </For>
      </ul>
    </>
  );
}

function F() {
  const [count, setCount] = createSignal(0);
  const [synced, setSynced] = createSignal(0);
  const plus = () => {
    setCount((c) => c + 1);
    api.increment().then((r) => setSynced((s) => Math.max(s, r.count)));
  };
  return (
    <>
      <button data-testid="plus" onClick={plus}>
        +1
      </button>
      <p>
        Count <span data-testid="count">{count()}</span>, saved <span data-testid="synced">{synced()}</span>
      </p>
    </>
  );
}

function LivePanel() {
  const [tick, setTick] = createSignal(0);
  const [polls, setPolls] = createSignal(0);
  const [details, setDetails] = createSignal<Record<number, api.Detail>>({});
  onMount(() => {
    for (const id of api.DETAIL_IDS) api.detail(id).then((d) => setDetails((m) => ({ ...m, [id]: d })));
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
    onCleanup(() => {
      stopped = true;
      clearTimeout(timer);
    });
  });
  return (
    <div>
      <p>
        Tick <span data-testid="tick">{tick()}</span> after <span data-testid="polls">{polls()}</span> polls
      </p>
      <ul>
        <For each={api.DETAIL_IDS}>
          {(id) => (
            <Show when={details()[id]} fallback={<li>loading</li>}>
              {(d) => (
                <li data-testid="detail">
                  {d().name}: {d().price}
                </li>
              )}
            </Show>
          )}
        </For>
      </ul>
    </div>
  );
}

function G() {
  const [on, setOn] = createSignal(false);
  return (
    <>
      <button data-testid="start" onClick={() => setOn(true)}>
        Start
      </button>
      <Show when={on()}>
        <LivePanel />
      </Show>
    </>
  );
}

function H() {
  const [items, { mutate }] = createResource(() => api.items().then((r) => r.items));
  const [q, setQ] = createSignal("");
  const [res] = createResource(q, (v) => api.search(v));
  const [title, setTitle] = createSignal("");
  const create = async () => {
    const item = await api.createItem(title());
    mutate((xs) => [...(xs ?? []), item]);
    setTitle("");
  };
  return (
    <>
      <h2>Items</h2>
      <ItemList items={items.latest ?? []} />
      <CreateForm title={title()} setTitle={setTitle} onSubmit={() => void create()} />
      <h2>Search</h2>
      <input data-testid="q" value={q()} onInput={(e) => setQ(e.currentTarget.value)} placeholder="Search cities" autocomplete="off" />
      <ul>
        <For each={q() ? (res.latest?.results ?? []) : []}>{(r) => <li data-testid="result">{r}</li>}</For>
      </ul>
    </>
  );
}

const S: Record<string, Component> = { a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H };

export default function App() {
  const s = new URLSearchParams(location.search).get("s") ?? "h";
  const [mounted, setMounted] = createSignal(false);
  onMount(() => setMounted(true));
  return (
    <div id="compat" data-ready={mounted() ? "1" : "0"}>
      <Dynamic component={S[s] ?? H} />
    </div>
  );
}
