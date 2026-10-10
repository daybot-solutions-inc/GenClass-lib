// REST client for the compat mock backend (same origin). Shared by the fetch-based layers.

export type Item = { id: number; title: string };
export type Panel = { version: number; rows: string[] };
export type Todo = { id: number; title: string; done: boolean };
export type Note = { id: number; text: string };
export type Detail = { id: number; name: string; price: number };

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

async function http<T>(url: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(url, { ...init, headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) } });
  if (!r.ok) throw new HttpError(r.status);
  return (await r.json()) as T;
}

export const search = (q: string) => http<{ q: string; results: string[] }>(`/api/search?q=${encodeURIComponent(q)}`);
export const items = () => http<{ items: Item[] }>("/api/items");
export const createItem = (title: string) => http<Item>("/api/items", { method: "POST", body: JSON.stringify({ title }) });
export const left = () => http<Panel>("/api/left");
export const right = () => http<Panel>("/api/right");
export const todos = () => http<{ todos: Todo[] }>("/api/todos");
export const toggleTodo = (id: number, done: boolean) => http<Todo>(`/api/todos/${id}`, { method: "PATCH", body: JSON.stringify({ done }) });
export const notes = () => http<{ notes: Note[] }>("/api/notes");
export const addNote = (text: string) => http<Note>("/api/notes", { method: "POST", body: JSON.stringify({ text }) });
export const increment = () => http<{ count: number }>("/api/counter/increment", { method: "POST", body: "{}" });
export const status = () => http<{ tick: number }>("/api/status");
export const detail = (id: number) => http<Detail>(`/api/detail/${id}`);

export const DETAIL_IDS = [1, 2, 3, 4, 5, 6];

/** A network failure (offline), as opposed to an HTTP error answer. */
export const isNetworkError = (e: unknown) => e instanceof TypeError;

/**
 * An offline outbox: rows that could not be sent are kept in order and sent again, one at a time, when the browser
 * comes back online. `send` resolves true when the row reached the server.
 */
export interface Outbox<T> {
  submit(row: T): Promise<void>;
  dispose(): void;
}
export function createOutbox<T>(send: (row: T) => Promise<boolean>): Outbox<T> {
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
  window.addEventListener("online", onOnline);
  return {
    /** Send now, or queue behind rows still waiting. */
    async submit(row: T) {
      if (queue.length || flushing) {
        queue.push(row);
        return;
      }
      if (!(await send(row))) queue.push(row);
    },
    dispose: () => window.removeEventListener("online", onOnline),
  };
}
