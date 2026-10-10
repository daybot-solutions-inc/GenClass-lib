// The compat page (?s=<scenario a-h>): standalone components, signals, HttpClient subscriptions, written the common
// way: the typeahead subscribes per keystroke and sets whatever answer arrives (a: no switchMap), the create form has
// no in-flight guard (b). The other scenarios are correct. Rendered on the server, hydrated in the browser; data
// loads in the browser only (afterNextRender). GenClass does not discover Angular signals (README: not covered
// yet); it sees the network (fetch or XHR, by HttpClient backend) and user input.
import { Component, Injectable, afterNextRender, inject, signal, type OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';

type Item = { id: number; title: string };
type Panel = { version: number; rows: string[] };
type Todo = { id: number; title: string; done: boolean };
type Note = { id: number; text: string };
type Detail = { id: number; name: string; price: number };
type NoteRow = { key: string; text: string; pending?: boolean };
const DETAIL_IDS = [1, 2, 3, 4, 5, 6];

@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);
  search = (q: string) => this.http.get<{ q: string; results: string[] }>('/api/search', { params: { q } });
  items = () => this.http.get<{ items: Item[] }>('/api/items');
  createItem = (title: string) => this.http.post<Item>('/api/items', { title });
  left = () => this.http.get<Panel>('/api/left');
  right = () => this.http.get<Panel>('/api/right');
  todos = () => this.http.get<{ todos: Todo[] }>('/api/todos');
  toggleTodo = (id: number, done: boolean) => this.http.patch<Todo>(`/api/todos/${id}`, { done });
  notes = () => this.http.get<{ notes: Note[] }>('/api/notes');
  addNote = (text: string) => this.http.post<Note>('/api/notes', { text });
  increment = () => this.http.post<{ count: number }>('/api/counter/increment', {});
  status = () => this.http.get<{ tick: number }>('/api/status');
  detail = (id: number) => this.http.get<Detail>(`/api/detail/${id}`);
}

/** Offline outbox: rows that could not be sent are kept in order and sent again when the browser is back online. */
function createOutbox<T>(send: (row: T) => Promise<boolean>) {
  const queue: T[] = [];
  let flushing = false;
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (queue.length) {
        if (!(await send(queue[0]))) break;
        queue.shift();
      }
    } finally {
      flushing = false;
    }
  }
  const onOnline = () => void flush();
  window.addEventListener('online', onOnline);
  return {
    async submit(row: T) {
      if (queue.length || flushing) return void queue.push(row);
      if (!(await send(row))) queue.push(row);
    },
    dispose: () => window.removeEventListener('online', onOnline),
  };
}

@Component({
  selector: 'app-a',
  template: `<h2>City search</h2>
    <input data-testid="q" [value]="q()" (input)="onQ($any($event.target).value)" placeholder="Search cities" autocomplete="off" />
    <ul>
      @for (r of results(); track r) {
        <li data-testid="result">{{ r }}</li>
      }
    </ul>`,
})
class A {
  private api = inject(Api);
  q = signal('');
  results = signal<string[]>([]);
  onQ(v: string) {
    this.q.set(v);
    if (!v) return this.results.set([]);
    this.api.search(v).subscribe({ next: (r) => this.results.set(r.results), error: () => {} });
  }
}

@Component({
  selector: 'app-b',
  template: `<h2>Items</h2>
    <form (submit)="$event.preventDefault(); create()">
      <input data-testid="title" [value]="title()" (input)="title.set($any($event.target).value)" placeholder="New item" />
      <button data-testid="create" type="submit">Create</button>
    </form>
    <ul>
      @for (i of items() ?? []; track i.id) {
        <li data-testid="item">{{ i.title }}</li>
      }
    </ul>
    @if (error()) {
      <p data-testid="error">{{ error() }}</p>
    }`,
})
class B {
  private api = inject(Api);
  items = signal<Item[] | null>(null);
  title = signal('');
  error = signal<string | null>(null);
  constructor() {
    afterNextRender(() => this.api.items().subscribe((r) => this.items.set(r.items)));
  }
  create() {
    this.api.createItem(this.title()).subscribe({
      next: (item) => {
        this.items.update((xs) => [...(xs ?? []), item]);
        this.title.set('');
      },
      error: () => this.error.set('Could not create'),
    });
  }
}

@Component({
  selector: 'app-c',
  template: `<button data-testid="load" (click)="load()">Load both</button>
    <section>
      <h3>People</h3>
      <ul>
        @for (r of left() ?? []; track r) {
          <li data-testid="left-row">{{ r }}</li>
        }
      </ul>
    </section>
    <section>
      <h3>Activity</h3>
      <ul>
        @for (r of right() ?? []; track r) {
          <li data-testid="right-row">{{ r }}</li>
        }
      </ul>
    </section>`,
})
class C {
  private api = inject(Api);
  left = signal<string[] | null>(null);
  right = signal<string[] | null>(null);
  load() {
    this.api.left().subscribe((p) => this.left.set(p.rows));
    this.api.right().subscribe((p) => this.right.set(p.rows));
  }
}

@Component({
  selector: 'app-d',
  template: `<h2>Todos</h2>
    <ul>
      @for (t of todos() ?? []; track t.id) {
        <li data-testid="todo">
          <label>
            <input type="checkbox" [attr.data-testid]="'toggle-' + t.id" [checked]="t.done" (change)="toggle(t)" />
            {{ t.title }}: {{ t.done ? 'done' : 'open' }}
          </label>
        </li>
      }
    </ul>
    @if (error()) {
      <p data-testid="error">{{ error() }}</p>
    }`,
})
class D {
  private api = inject(Api);
  todos = signal<Todo[] | null>(null);
  error = signal<string | null>(null);
  constructor() {
    afterNextRender(() => this.api.todos().subscribe((r) => this.todos.set(r.todos)));
  }
  private patch(id: number, fn: (x: Todo) => Todo) {
    this.todos.update((ts) => ts!.map((x) => (x.id === id ? fn(x) : x)));
  }
  toggle(t: Todo) {
    const done = !t.done;
    this.patch(t.id, (x) => ({ ...x, done })); // optimistic
    this.api.toggleTodo(t.id, done).subscribe({
      next: (saved) => this.patch(t.id, () => saved),
      error: () => {
        this.patch(t.id, (x) => ({ ...x, done: t.done })); // roll back
        this.error.set(`Could not save "${t.title}"`);
      },
    });
  }
}

let noteSeq = 0;
@Component({
  selector: 'app-e',
  template: `<h2>Notes</h2>
    <input data-testid="note-text" [value]="draft()" (input)="draft.set($any($event.target).value)" placeholder="Note" />
    <button data-testid="note-add" (click)="add()">Add</button>
    <ul>
      @for (n of notes() ?? []; track n.key) {
        <li data-testid="note">{{ n.text }}{{ n.pending ? ' (pending)' : '' }}</li>
      }
    </ul>`,
})
class E implements OnDestroy {
  private api = inject(Api);
  notes = signal<NoteRow[] | null>(null);
  draft = signal('');
  private outbox: ReturnType<typeof createOutbox<NoteRow>> | null = null;
  constructor() {
    afterNextRender(() => {
      this.api.notes().subscribe((r) => this.notes.set(r.notes.map((n) => ({ key: `s${n.id}`, text: n.text }))));
      this.outbox = createOutbox<NoteRow>(async (row) => {
        try {
          const saved = await firstValueFrom(this.api.addNote(row.text));
          this.notes.update((ns) => ns!.map((n) => (n.key === row.key ? { key: `s${saved.id}`, text: saved.text } : n)));
          return true;
        } catch {
          return false;
        }
      });
    });
  }
  add() {
    const row = { key: `l${++noteSeq}`, text: this.draft(), pending: true };
    this.draft.set('');
    this.notes.update((ns) => [...(ns ?? []), row]);
    void this.outbox?.submit(row);
  }
  ngOnDestroy() {
    this.outbox?.dispose();
  }
}

@Component({
  selector: 'app-f',
  template: `<button data-testid="plus" (click)="plus()">+1</button>
    <p>Count <span data-testid="count">{{ count() }}</span>, saved <span data-testid="synced">{{ synced() }}</span></p>`,
})
class F {
  private api = inject(Api);
  count = signal(0);
  synced = signal(0);
  plus() {
    this.count.update((c) => c + 1);
    this.api.increment().subscribe((r) => this.synced.update((s) => Math.max(s, r.count)));
  }
}

@Component({
  selector: 'app-live',
  template: `<div>
    <p>Tick <span data-testid="tick">{{ tick() }}</span> after <span data-testid="polls">{{ polls() }}</span> polls</p>
    <ul>
      @for (id of ids; track id) {
        @if (details()[id]; as d) {
          <li data-testid="detail">{{ d.name }}: {{ d.price }}</li>
        } @else {
          <li>loading</li>
        }
      }
    </ul>
  </div>`,
})
class LivePanel implements OnDestroy {
  private api = inject(Api);
  ids = DETAIL_IDS;
  tick = signal(0);
  polls = signal(0);
  details = signal<Record<number, Detail>>({});
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor() {
    afterNextRender(() => {
      for (const id of DETAIL_IDS) this.api.detail(id).subscribe((d) => this.details.update((m) => ({ ...m, [id]: d })));
      this.poll();
    });
  }
  private poll() {
    this.api.status().subscribe((r) => {
      if (this.stopped) return;
      this.tick.set(r.tick);
      this.polls.update((p) => p + 1);
      if (r.tick < 8) this.timer = setTimeout(() => this.poll(), 250);
    });
  }
  ngOnDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}

@Component({
  selector: 'app-g',
  imports: [LivePanel],
  template: `<button data-testid="start" (click)="on.set(true)">Start</button>
    @if (on()) {
      <app-live />
    }`,
})
class G {
  on = signal(false);
}

@Component({
  selector: 'app-h',
  template: `<h2>Items</h2>
    <ul>
      @for (i of items() ?? []; track i.id) {
        <li data-testid="item">{{ i.title }}</li>
      }
    </ul>
    <form (submit)="$event.preventDefault(); create()">
      <input data-testid="title" [value]="title()" (input)="title.set($any($event.target).value)" placeholder="New item" />
      <button data-testid="create" type="submit">Create</button>
    </form>
    <h2>Search</h2>
    <input data-testid="q" [value]="q()" (input)="onQ($any($event.target).value)" placeholder="Search cities" autocomplete="off" />
    <ul>
      @for (r of results(); track r) {
        <li data-testid="result">{{ r }}</li>
      }
    </ul>`,
})
class H {
  private api = inject(Api);
  items = signal<Item[] | null>(null);
  title = signal('');
  q = signal('');
  results = signal<string[]>([]);
  constructor() {
    afterNextRender(() => this.api.items().subscribe((r) => this.items.set(r.items)));
  }
  onQ(v: string) {
    this.q.set(v);
    if (!v) return this.results.set([]);
    this.api.search(v).subscribe({ next: (r) => this.results.set(r.results), error: () => {} });
  }
  create() {
    this.api.createItem(this.title()).subscribe((item) => {
      this.items.update((xs) => [...(xs ?? []), item]);
      this.title.set('');
    });
  }
}

@Component({
  selector: 'app-page',
  imports: [A, B, C, D, E, F, G, H],
  template: `<div id="compat" data-ssr="1" [attr.data-ready]="ready() ? '1' : '0'">
    @switch (s) {
      @case ('a') { <app-a /> }
      @case ('b') { <app-b /> }
      @case ('c') { <app-c /> }
      @case ('d') { <app-d /> }
      @case ('e') { <app-e /> }
      @case ('f') { <app-f /> }
      @case ('g') { <app-g /> }
      @default { <app-h /> }
    }
  </div>`,
})
export class Page {
  s = inject(ActivatedRoute).snapshot.queryParamMap.get('s') ?? 'h';
  ready = signal(false);
  constructor() {
    afterNextRender(() => this.ready.set(true));
  }
}
