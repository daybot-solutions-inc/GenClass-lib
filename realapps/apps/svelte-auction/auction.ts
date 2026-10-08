// Store + sync for the charity points auction (see App.svelte). Lots stream over the live topic; a bid is a
// versioned PATCH setting the new amount and leader (a 409 means someone bid first). Latent bugs by flag: pushes and
// echoes applied in arrival order (live=blind), bid buttons live while the bid posts (bidGuard=none), bids sent
// without the version (bidMode=no-version: an absolute bid computed from a stale amount lowers the price), reconnect
// without reloading (reconnect=naive) and reserved points adjusted by hand (reserved=manual).
import { rt, flag } from "../_shared/genclass";
import { atomStore } from "../_shared/svelte-atom";
import { api, itemsOf, errText, HttpError, liveTopic } from "../_shared/w3-http";

export type Lot = { id: number; title: string; bid: number; leader: string; open: boolean; version: number };
const LIVE = flag("live", "version-check");
export const BID_GUARD = flag("bidGuard", "pending") === "pending";
const BID_MODE = flag("bidMode", "if-match");
const RECONNECT = flag("reconnect", "resync");
const RESERVED = flag("reserved", "derive");
export const ME = "you";

const atom = rt.atom("auction", { lots: [] as Lot[], reserved: 0, view: "all", pending: [] as number[], live: false, error: "", notice: "" });
export const auction = atomStore(atom);
type A = ReturnType<typeof atom.get>;
const reservedOf = (ls: Lot[]) => ls.filter((l) => l.leader === ME).reduce((a, l) => a + l.bid, 0);

function upsert(s: A, lot: Lot): A {
  const cur = s.lots.find((l) => l.id === lot.id);
  if (cur && LIVE === "version-check" && Number(lot.version) < Number(cur.version)) return s;
  const lots = cur ? s.lots.map((l) => (l.id === lot.id ? lot : l)) : [...s.lots, lot];
  let reserved = reservedOf(lots);
  if (RESERVED === "manual") reserved = s.reserved + (lot.leader === ME && cur?.leader !== ME ? lot.bid : 0) - (cur?.leader === ME && lot.leader !== ME ? cur.bid : 0);
  return { ...s, lots, reserved };
}

export async function load() {
  try {
    const lots = itemsOf<Lot>(await api(`/api/lots?limit=20`));
    atom.update((s) => ({ ...s, lots, reserved: reservedOf(lots) }));
  } catch (e) {
    atom.update((s) => ({ ...s, error: errText(e, "loading the lots") }));
  }
}

export async function bid(lot: Lot, step: number) {
  const s0 = atom.get();
  if (BID_GUARD && s0.pending.includes(lot.id)) return;
  const cur = s0.lots.find((l) => l.id === lot.id) ?? lot;
  atom.update((s) => ({ ...s, pending: [...s.pending, lot.id], error: "", notice: "" }));
  try {
    const body: Record<string, unknown> = { bid: cur.bid + step, leader: ME };
    if (BID_MODE === "if-match") body.version = cur.version;
    const saved = await api<Lot>(`/api/lots/${lot.id}`, "PATCH", body);
    atom.update((s) => ({ ...upsert(s, saved), notice: `You lead “${saved.title}” at ${saved.bid} points.` }));
  } catch (e) {
    const latest = e instanceof HttpError && e.status === 409 ? (e.body?.current as Lot | undefined) : undefined;
    atom.update((s) => ({ ...(latest ? upsert(s, latest) : s), error: latest ? `Someone bid on “${lot.title}” first — it's now ${latest.bid}.` : errText(e, "your bid") }));
  } finally {
    atom.update((s) => ({ ...s, pending: s.pending.filter((x) => x !== lot.id) }));
  }
}

export const setView = (view: string) => atom.update((s) => ({ ...s, view }));

let stop: (() => void) | null = null;
export function start() {
  void load();
  let everUp = false;
  stop = liveTopic(
    "lots",
    (m) => {
      if (m.item) atom.update((s) => upsert(s, m.item as Lot));
    },
    (up) => {
      atom.update((s) => ({ ...s, live: up }));
      if (up && everUp && RECONNECT === "resync") void load();
      if (up) everUp = true;
    },
  );
}
export const end = () => stop?.();
