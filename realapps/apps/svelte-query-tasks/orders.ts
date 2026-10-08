// Facilities work orders: TanStack Svelte Query cache + mutations (fetch). The ["workorders"] query is polled and
// registered with rt.guard, so the app's own cache writes (optimistic edits, rollbacks, inserts) go through GenClass
// while the query's fetches are traced. Latent bugs by flag: rollback to the snapshot taken when the mutation started
// (rollback=snapshot: undoes other edits made meanwhile) or no rollback (rollback=none: the list shows a change the
// server refused), optimistic writes made without cancelling the in-flight poll (cancelOnMutate=false: an older poll
// lands on top of the edit), invalidation after every settled mutation (invalidate=each: refetches race the next
// edit) or never (invalidate=none), "Log work order" not locked while creating (createLock=false: double submit).
import { QueryClient, createMutation, createQuery } from "@tanstack/svelte-query";
import { rt, flag } from "../_shared/genclass";
import { atomStore } from "../_shared/svelte-atom";

export type Status = "open" | "in-progress" | "done";
export type Priority = "low" | "normal" | "urgent";
export type WorkOrder = { id: number; title: string; location: string; priority: Priority; status: Status; assignee: string };
type Board = { items: WorkOrder[]; total: number; page?: number };

const ROLLBACK = flag("rollback", "per-item") as "per-item" | "snapshot" | "none";
const CANCEL = Boolean(flag("cancelOnMutate", true));
const INVALIDATE = flag("invalidate", "when-idle") as "when-idle" | "each" | "none";
export const CREATE_LOCK = Boolean(flag("createLock", true));
export const LOCATIONS = ["Boiler room", "Lobby", "Level 2 kitchen", "Car park", "Server room", "Roof"];
const NEXT_PRIORITY: Record<Priority, Priority> = { low: "normal", normal: "urgent", urgent: "urgent" };

export const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 2000 } } });
const KEY = ["workorders"];
const EMPTY: Board = { items: [], total: 0 };

const board = rt.guard<Board>("workorders", {
  get: () => qc.getQueryData<Board>(KEY) ?? EMPTY,
  set: (v) => void qc.setQueryData<Board>(KEY, v),
  subscribe: (fn) =>
    qc.getQueryCache().subscribe((e) => {
      if (e.type === "updated" && e.query.queryKey[0] === "workorders" && e.action.type === "success") fn();
    }),
});
const uiAtom = rt.atom("woForm", { tab: "active", draft: "", location: LOCATIONS[0]!, error: "" });
export const ui = atomStore(uiAtom);

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (r.status === 204 ? null : await r.json()) as T;
}

export const list = createQuery({ queryKey: KEY, queryFn: () => api<Board>("/api/workorders?limit=50&sort=-createdAt"), refetchInterval: 5000 }, qc);

const setItems = (b: Board, items: WorkOrder[]): Board => ({ ...b, items, total: items.length });
const fail = (msg: string) => uiAtom.update((u) => ({ ...u, error: msg }));

function settle() {
  if (INVALIDATE === "none") return;
  if (INVALIDATE === "when-idle" && qc.isMutating() > 1) return; // another edit is still on its way; let the last one refetch
  void qc.invalidateQueries({ queryKey: KEY });
}

async function beforeEdit() {
  if (CANCEL) await qc.cancelQueries({ queryKey: KEY });
  return board.get();
}

/** An optimistic field edit (status / priority) with the configured rollback. */
function fieldEdit<K extends "status" | "priority">(field: K, what: string) {
  return createMutation(
    {
      mutationFn: (v: { id: number; value: WorkOrder[K] }) => api<WorkOrder>(`/api/workorders/${v.id}`, { method: "PATCH", body: JSON.stringify({ [field]: v.value }) }),
      onMutate: async (v) => {
        const snapshot = await beforeEdit();
        const before = snapshot.items.find((o) => o.id === v.id)?.[field];
        board.update((b) => setItems(b, b.items.map((o) => (o.id === v.id ? { ...o, [field]: v.value } : o))));
        return { snapshot, before };
      },
      onError: (_e, v, ctx) => {
        if (ROLLBACK === "snapshot" && ctx) board.set(ctx.snapshot);
        else if (ROLLBACK === "per-item" && ctx?.before !== undefined) board.update((b) => setItems(b, b.items.map((o) => (o.id === v.id && o[field] === v.value ? { ...o, [field]: ctx.before } : o))));
        const title = board.get().items.find((o) => o.id === v.id)?.title ?? "the work order";
        fail(`Couldn't ${what} “${title}”.`);
      },
      onSuccess: (saved, v) => board.update((b) => setItems(b, b.items.map((o) => (o.id === v.id ? { ...o, ...saved } : o)))),
      onSettled: settle,
    },
    qc,
  );
}

export const statusEdit = fieldEdit("status", "update the status of");
export const priorityEdit = fieldEdit("priority", "escalate");

let tempSeq = 0;
export const createOrder = createMutation(
  {
    mutationFn: (v: { tempId: number; title: string; location: string }) => api<WorkOrder>("/api/workorders", { method: "POST", body: JSON.stringify({ title: v.title, location: v.location, priority: "normal", status: "open", assignee: "unassigned" }) }),
    onMutate: async (v) => {
      await beforeEdit();
      board.update((b) => setItems(b, [{ id: v.tempId, title: v.title, location: v.location, priority: "normal", status: "open", assignee: "unassigned" }, ...b.items]));
    },
    onError: (_e, v) => {
      if (ROLLBACK !== "none") board.update((b) => setItems(b, b.items.filter((o) => o.id !== v.tempId)));
      fail(`“${v.title}” wasn't logged. Try again.`);
    },
    onSuccess: (saved, v) => board.update((b) => setItems(b, b.items.some((o) => o.id === saved.id) ? b.items.filter((o) => o.id !== v.tempId) : b.items.map((o) => (o.id === v.tempId ? saved : o)))),
    onSettled: settle,
  },
  qc,
);

export const removeOrder = createMutation(
  {
    mutationFn: (v: { id: number }) => api<null>(`/api/workorders/${v.id}`, { method: "DELETE" }),
    onMutate: async (v) => {
      const snapshot = await beforeEdit();
      const idx = snapshot.items.findIndex((o) => o.id === v.id);
      board.update((b) => setItems(b, b.items.filter((o) => o.id !== v.id)));
      return { snapshot, item: snapshot.items[idx], idx };
    },
    onError: (_e, _v, ctx) => {
      if (ROLLBACK === "snapshot" && ctx) board.set(ctx.snapshot);
      else if (ROLLBACK === "per-item" && ctx?.item) board.update((b) => (b.items.some((o) => o.id === ctx.item!.id) ? b : setItems(b, [...b.items.slice(0, ctx.idx), ctx.item!, ...b.items.slice(ctx.idx)])));
      fail(`Couldn't delete “${ctx?.item?.title ?? "that work order"}”.`);
    },
    onSettled: settle,
  },
  qc,
);

// ------------------------------------------------------------------------------------------- UI actions
export function setDraft(v: string) {
  uiAtom.update((u) => ({ ...u, draft: v }));
}
export function setLocation(v: string) {
  uiAtom.update((u) => ({ ...u, location: v }));
}
export function setTab(v: string) {
  uiAtom.update((u) => ({ ...u, tab: v }));
}
/** Take the typed work order out of the form (null when there is nothing to send or a create is still running). */
export function takeDraft(pending: boolean): { tempId: number; title: string; location: string } | null {
  const u = uiAtom.get();
  const title = u.draft.trim();
  if (!title || (CREATE_LOCK && pending)) return null;
  uiAtom.update((x) => ({ ...x, draft: "", error: "" }));
  return { tempId: -++tempSeq, title, location: u.location };
}
export function clearError() {
  uiAtom.update((u) => (u.error ? { ...u, error: "" } : u));
}
export const nextPriority = (p: Priority) => NEXT_PRIORITY[p] ?? "urgent";
