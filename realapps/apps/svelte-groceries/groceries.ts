// Store + sync for the shared household grocery list (see App.svelte). Items stream over the live topic as the
// household adds and ticks things off. Ticking an item is optimistic (retried once after a 5xx), "+1" bumps the
// quantity (POST /items/:id/more: relative), new items show at once with a client id (POST /items), and "Clear
// checked" bulk-deletes ticked items (per-item results). Latent bugs by flag: ticks sent as a relative toggle
// (toggle=toggle-action: a retry after a 5xx that had committed flips the item back), the optimistic new item not
// reconciled with its live echo (add=append: it shows twice), bulk results ignored (clear=assume-all: items the server
// kept disappear), pushes applied in arrival order (live=blind) and a "left to buy" counter kept by hand that a failed
// tick never restores (left=incremental).
import { rt, flag } from "../_shared/genclass";
import { atomStore } from "../_shared/svelte-atom";
import { api, itemsOf, errText, HttpError, liveTopic } from "../_shared/w3-http";

export type Item = { id: number | string; clientId?: string; name: string; qty: number; checked: boolean; aisle: string; addedBy: string; version: number; pending?: boolean };
const TOGGLE = flag("toggle", "patch-absolute");
const ADD = flag("add", "reconcile");
const CLEAR = flag("clear", "per-item");
const LIVE = flag("live", "version-check");
const LEFT = flag("left", "derive");

const atom = rt.atom("groceries", { items: [] as Item[], left: 0, pending: [] as (number | string)[], adding: 0, draft: "", clearing: false, live: false, error: "", notice: "" });
export const groceries = atomStore(atom);
type G = ReturnType<typeof atom.get>;
const leftOf = (is: Item[]) => is.filter((i) => !i.checked).length;
const AISLES = ["produce", "bakery", "dairy", "pantry", "household"];
const ordered = (is: Item[]) => [...is].sort((a, b) => AISLES.indexOf(a.aisle) - AISLES.indexOf(b.aisle) || String(a.id).localeCompare(String(b.id)));
const settle = (g: G, items: Item[], delta: number): G => ({ ...g, items: ordered(items), left: LEFT === "derive" ? leftOf(items) : g.left + delta });
const pend = (id: number | string, on: boolean) => atom.update((g) => ({ ...g, pending: on ? [...g.pending, id] : g.pending.filter((x) => x !== id) }));

function upsert(g: G, it: Item): G {
  const i = g.items.findIndex((x) => x.id === it.id || (ADD === "reconcile" && it.clientId && x.clientId === it.clientId));
  if (i < 0) return settle(g, [...g.items, it], it.checked ? 0 : 1);
  const cur = g.items[i]!;
  if (!cur.pending && LIVE === "version-check" && Number(it.version) < Number(cur.version)) return g;
  const items = g.items.slice();
  items[i] = it;
  return settle(g, items, (cur.checked ? 1 : 0) - (it.checked ? 1 : 0));
}

export async function load() {
  try {
    const items = itemsOf<Item>(await api(`/api/items?limit=60`));
    atom.update((g) => ({ ...g, items: ordered([...items, ...g.items.filter((x) => x.pending)]), left: leftOf([...items, ...g.items.filter((x) => x.pending)]) }));
  } catch (e) {
    atom.update((g) => ({ ...g, error: errText(e, "loading the list") }));
  }
}

export async function tick(it: Item) {
  if (typeof it.id !== "number" || atom.get().pending.includes(it.id)) return;
  const want = !it.checked;
  pend(it.id, true);
  atom.update((g) => ({ ...settle(g, g.items.map((x) => (x.id === it.id ? { ...x, checked: want } : x)), want ? -1 : 1), error: "", notice: "" }));
  const send = () => (TOGGLE === "patch-absolute" ? api<Item>(`/api/items/${it.id}`, "PATCH", { checked: want }) : api<Item>(`/api/items/${it.id}/toggle`, "POST"));
  try {
    const saved = await send().catch((e) => (e instanceof HttpError && e.status > 0 && e.status < 500 ? Promise.reject(e) : send()));
    atom.update((g) => upsert(g, saved));
  } catch (e) {
    atom.update((g) => ({ ...(LEFT === "derive" ? settle(g, g.items.map((x) => (x.id === it.id ? { ...x, checked: !want } : x)), 0) : { ...g, items: g.items.map((x) => (x.id === it.id ? { ...x, checked: !want } : x)) }), error: errText(e, `ticking ${it.name}`) }));
  } finally {
    pend(it.id, false);
  }
}

export async function more(it: Item) {
  if (typeof it.id !== "number") return;
  try {
    const saved = await api<Item>(`/api/items/${it.id}/more`, "POST");
    atom.update((g) => upsert(g, saved));
  } catch (e) {
    atom.update((g) => ({ ...g, error: errText(e, `changing ${it.name}`) }));
  }
}

let cid = 0;
export async function add() {
  const name = atom.get().draft.trim();
  if (!name) return;
  const clientId = `c${++cid}`;
  const temp: Item = { id: clientId, clientId, name, qty: 1, checked: false, aisle: "pantry", addedBy: "you", version: 0, pending: true };
  atom.update((g) => ({ ...settle(g, [...g.items, temp], 1), draft: "", adding: g.adding + 1, error: "", notice: "" }));
  try {
    const { id: _t, pending: _p, ...body } = temp;
    const saved = await api<Item>(`/api/items`, "POST", body);
    atom.update((g) => (ADD === "reconcile" ? upsert(g, saved) : settle(g, g.items.map((x) => (x.id === clientId ? saved : x)), 0)));
  } catch (e) {
    atom.update((g) => ({ ...settle(g, g.items.filter((x) => x.id !== clientId), -1), draft: name, error: errText(e, `adding ${name}`) }));
  } finally {
    atom.update((g) => ({ ...g, adding: g.adding - 1 }));
  }
}

export async function clearChecked() {
  const g0 = atom.get();
  const ids = g0.items.filter((i) => i.checked && typeof i.id === "number").map((i) => i.id as number);
  if (!ids.length || g0.clearing) return;
  atom.update((g) => ({ ...g, clearing: true, error: "", notice: "" }));
  try {
    const r = await api<{ results: { id: number; ok: boolean }[] }>(`/api/items/bulk`, "POST", { ids, op: "delete" });
    const gone = new Set(CLEAR === "per-item" ? r.results.filter((x) => x.ok).map((x) => Number(x.id)) : ids);
    const failed = ids.length - r.results.filter((x) => x.ok).length;
    atom.update((g) => ({ ...settle(g, g.items.filter((i) => !gone.has(i.id as number)), 0), notice: `Cleared ${gone.size} item(s).`, error: CLEAR === "per-item" && failed ? `${failed} item(s) could not be cleared.` : "" }));
  } catch (e) {
    atom.update((g) => ({ ...g, error: errText(e, "clearing ticked items") }));
  } finally {
    atom.update((g) => ({ ...g, clearing: false }));
  }
}

export const setDraft = (v: string) => atom.update((g) => ({ ...g, draft: v }));

export function start(): () => void {
  let everUp = false;
  const off = liveTopic(
    "items",
    (m) => {
      if (m.type === "deleted") atom.update((g) => settle(g, g.items.filter((i) => i.id !== m.id), g.items.some((i) => i.id === m.id && !i.checked) ? -1 : 0));
      else if (m.item) atom.update((g) => upsert(g, m.item as Item));
    },
    (up) => {
      atom.update((g) => ({ ...g, live: up }));
      if (up && everUp) void load();
      if (up) everUp = true;
    },
  );
  void load();
  return off;
}
