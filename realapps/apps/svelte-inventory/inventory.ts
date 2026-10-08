// Warehouse stock state and effects (axios over XHR; a runtime atom exposed as a Svelte store). Stock changes are
// relative, non-idempotent POST /items/:id/adjust {by}; a background poll keeps the table fresh while other staff
// sell and restock. Latent bugs by flag: poll results applied over local adjustments still in flight (poll=blind,
// which also ignores a changed search), every adjust echo applied even when newer ones are pending (echo=blind),
// low-stock badge only recomputed on full loads (badge=load-only), search responses applied in arrival order
// (searchGuard=none, worst with debounce 0), "Receive case" not locked while its request is in flight
// (receiveLock=false: a double click receives two cases).
import axios from "axios";
import { writable } from "svelte/store";
import { rt, flag } from "../_shared/genclass";
import { atomStore } from "../_shared/svelte-atom";

export type Item = { id: number; sku: string; name: string; stock: number; min: number; bin: string };

const POLL = flag("poll", "skip-if-pending") as "skip-if-pending" | "blind";
const ECHO = flag("echo", "pending-aware") as "pending-aware" | "blind";
const BADGE = flag("badge", "recompute") as "recompute" | "load-only";
const SEARCH_GUARD = flag("searchGuard", "reqid") as "reqid" | "none";
const DEBOUNCE = Number(flag("debounce", 250));
export const RECEIVE_LOCK = Boolean(flag("receiveLock", true));
const POLL_MS = 5000;
const CASE_PACK = 12;

const api = axios.create({ baseURL: "/api", timeout: 8000 });
const invAtom = rt.atom("inv", { items: [] as Item[], q: "", lowCount: 0, loading: false, error: "" });
export const inv = atomStore(invAtom);
/** Items whose "Receive case" request is in flight (UI only). */
export const receiving = writable<number[]>([]);

export const isLow = (it: Item) => it.stock <= it.min;
const countLow = (items: Item[]) => items.filter(isLow).length;
const badge = (prev: number, items: Item[]) => (BADGE === "recompute" ? countLow(items) : prev);
const replaceItem = (items: Item[], id: number, fn: (it: Item) => Item) => items.map((it) => (it.id === id ? fn(it) : it));

const pending = new Map<number, number>();
let adjustsSent = 0;
let searchSeq = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const inflightAdjusts = () => [...pending.values()].reduce((a, b) => a + b, 0);
const params = (q: string) => ({ ...(q ? { q } : {}), limit: 50 });

async function search(q: string) {
  const id = ++searchSeq;
  invAtom.update((s) => ({ ...s, loading: true, error: "" }));
  try {
    const r = await api.get<{ items: Item[] }>("/items", { params: params(q) });
    if (SEARCH_GUARD === "reqid" && id !== searchSeq) return;
    const items = r.data.items ?? [];
    invAtom.update((s) => ({ ...s, items, lowCount: countLow(items), loading: false }));
  } catch {
    if (SEARCH_GUARD === "reqid" && id !== searchSeq) return;
    invAtom.update((s) => ({ ...s, loading: false, error: "Couldn't load stock levels." }));
  }
}

export function setQuery(q: string) {
  invAtom.update((s) => ({ ...s, q }));
  if (DEBOUNCE <= 0) return void search(q);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void search(q), DEBOUNCE);
}

async function poll() {
  const q = invAtom.get().q;
  const sentBefore = adjustsSent;
  try {
    const r = await api.get<{ items: Item[] }>("/items", { params: params(q) });
    const items = r.data.items ?? [];
    if (POLL === "skip-if-pending") {
      // a newer search, or a local adjustment the response may not include yet: wait for the next tick
      if (invAtom.get().q !== q || inflightAdjusts() > 0 || adjustsSent !== sentBefore) return;
    }
    invAtom.update((s) => ({ ...s, items, lowCount: countLow(items) }));
  } catch {
    // the next tick will try again
  }
}

export async function adjust(id: number, by: number): Promise<void> {
  invAtom.update((s) => {
    const items = replaceItem(s.items, id, (it) => ({ ...it, stock: it.stock + by }));
    return { ...s, items, lowCount: badge(s.lowCount, items), error: "" };
  });
  pending.set(id, (pending.get(id) ?? 0) + 1);
  adjustsSent++;
  try {
    const r = await api.post<Item>(`/items/${id}/adjust`, { by });
    const left = Math.max(0, (pending.get(id) ?? 1) - 1);
    pending.set(id, left);
    if (ECHO === "pending-aware" && left > 0) return; // the last echo for this item carries every adjustment
    invAtom.update((s) => {
      const items = replaceItem(s.items, id, (it) => ({ ...it, stock: Number(r.data.stock ?? it.stock) }));
      return { ...s, items, lowCount: badge(s.lowCount, items) };
    });
  } catch {
    pending.set(id, Math.max(0, (pending.get(id) ?? 1) - 1));
    invAtom.update((s) => {
      const name = s.items.find((it) => it.id === id)?.name ?? "item";
      const items = replaceItem(s.items, id, (it) => ({ ...it, stock: it.stock - by }));
      return { ...s, items, lowCount: badge(s.lowCount, items), error: `Couldn't update ${name}; the change was undone.` };
    });
  }
}

export async function receive(id: number) {
  let busy = false;
  receiving.update((r) => {
    busy = r.includes(id);
    return busy ? r : [...r, id];
  });
  if (RECEIVE_LOCK && busy) return;
  try {
    await adjust(id, CASE_PACK);
  } finally {
    receiving.update((r) => r.filter((x) => x !== id));
  }
}

export function start() {
  void search("");
  pollTimer = setInterval(() => void poll(), POLL_MS);
}

export function stop() {
  if (pollTimer) clearInterval(pollTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
}
