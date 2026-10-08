// Baby-shower gift registry for guests (React 19 + Valtio proxy read with useSnapshot; fetch + WebSocket). Guests
// browse the couple's list by category (optionally "still needed only": remaining__gt=0) and promise to bring a gift:
// claiming is two requests — POST /claims {guest, giftId, key} (one claim per guest and gift: the key is unique, a
// 409 means an earlier attempt already got through, so it is picked up and finished) then POST /gifts/:id/claim
// (remaining −1); unclaiming deletes the claim and posts /gifts/:id/unclaim. Other guests claim and give back gifts
// all the time (live pushes). The proxy is registered with rt.guard: async results go through the guarded handle,
// filter changes write the proxy directly. Latent bugs by flag: claim buttons live while the claim posts
// (claimGuard=none: a second click finds the claim row, "finishes" it and takes a second unit), a failed second step
// that leaves the claim row behind (steps=dangling: the guest is listed as bringing a gift the count never lost, and
// unclaiming it later gives back a unit that was never taken), pushes and answers applied in arrival order
// (live=blind: an older copy of a gift overwrites a newer count), the "still needed" view filtered only when it is
// fetched (filter=stale: gifts that ran out stay listed as needed) and a still-needed total kept by hand
// (remainingCount=incremental: the push and the claim answer both subtract the same unit).
import { createRoot } from "react-dom/client";
import { proxy, snapshot, subscribe } from "valtio/vanilla";
import { useSnapshot } from "valtio/react";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError, liveTopic } from "../_shared/w3-http";

type Gift = { id: number; name: string; category: string; price: number; shop: string; wanted: number; remaining: number; updatedAt?: string };
type Claim = { id: number; guest: string; giftId: number; key: string };
interface Registry {
  category: string;
  onlyNeeded: boolean;
  gifts: Gift[];
  neededCount: number;
  mine: Record<string, number>;
  pending: number[];
  loading: boolean;
  live: boolean;
  error: string;
  notice: string;
}

const CLAIM_GUARD = flag("claimGuard", "pending") === "pending";
const STEPS = flag("steps", "rollback");
const LIVE = flag("live", "newer-wins");
const FILTER = flag("filter", "refetch-on-change");
const REMAINING = flag("remainingCount", "derive");
const ME = "June";
const CATEGORIES = ["all", "nursery", "feeding", "clothing", "books"];

const state = proxy<Registry>({ category: "all", onlyNeeded: false, gifts: [], neededCount: 0, mine: {}, pending: [], loading: true, live: false, error: "", notice: "" });
const registry = rt.guard<Registry>("registry", {
  get: () => snapshot(state) as Registry,
  set: (v) => void Object.assign(state, structuredClone(v)),
  subscribe: (fn) => subscribe(state, () => fn()),
});
/** Mutate a copy of the current state and write it through GenClass. */
const commit = (fn: (d: Registry) => void) =>
  registry.update((s) => {
    const d = structuredClone(s) as Registry;
    fn(d);
    return d;
  });
const fits = (d: Registry, g: Gift) => (d.category === "all" || g.category === d.category) && (!d.onlyNeeded || g.remaining > 0);
const sum = (gs: Gift[]) => gs.reduce((a, g) => a + g.remaining, 0);
const keyOf = (giftId: number) => `${ME}|${giftId}`;

/** A gift from the server (answer or push). Pushes move the hand-kept count by the change they make to the list. */
function applyGift(d: Registry, g: Gift, fromPush: boolean) {
  const i = d.gifts.findIndex((x) => x.id === g.id);
  const cur = i >= 0 ? d.gifts[i] : undefined;
  if (cur && LIVE === "newer-wins" && String(g.updatedAt ?? "") < String(cur.updatedAt ?? "")) return;
  const before = cur?.remaining ?? 0;
  if (FILTER === "refetch-on-change") {
    // the view is re-evaluated on every change: gifts leave or join it as they run out or come back
    if (!fits(d, g)) d.gifts = d.gifts.filter((x) => x.id !== g.id);
    else if (cur) d.gifts[i] = g;
    else d.gifts = [...d.gifts, g].sort((a, b) => a.id - b.id);
  } else if (cur) d.gifts[i] = g;
  const after = d.gifts.find((x) => x.id === g.id)?.remaining ?? 0;
  if (REMAINING === "derive") d.neededCount = sum(d.gifts);
  else if (fromPush) d.neededCount += after - before;
}

let seq = 0;
async function load() {
  const my = ++seq;
  const s = registry.get();
  const q = new URLSearchParams({ limit: "50" });
  if (s.category !== "all") q.set("category", s.category);
  if (s.onlyNeeded) q.set("remaining__gt", "0");
  try {
    const gifts = itemsOf<Gift>(await api(`/api/gifts?${q}`)).sort((a, b) => a.id - b.id);
    if (my !== seq) return;
    commit((d) => {
      d.gifts = gifts;
      d.neededCount = sum(gifts);
      d.loading = false;
      d.error = "";
    });
  } catch (e) {
    if (my === seq) commit((d) => void ((d.loading = false), (d.error = errText(e, "loading the registry"))));
  }
}

async function loadMine() {
  try {
    const claims = itemsOf<Claim>(await api(`/api/claims?guest=${ME}&limit=50`));
    commit((d) => void (d.mine = Object.fromEntries(claims.map((c) => [String(c.giftId), c.id]))));
  } catch {
    /* shown as not claimed until the next load */
  }
}

function setFilter(patch: Partial<Pick<Registry, "category" | "onlyNeeded">>) {
  Object.assign(state, patch, { loading: true, notice: "" });
  void load();
}
const done = (id: number) => commit((d) => void (d.pending = d.pending.filter((x) => x !== id)));

async function claim(g: Gift) {
  const s = registry.get();
  if ((CLAIM_GUARD && s.pending.includes(g.id)) || s.mine[g.id] || g.remaining <= 0) return;
  state.pending.push(g.id);
  state.error = state.notice = "";
  let claimId = 0;
  try {
    let c: Claim | undefined;
    try {
      c = await api<Claim>("/api/claims", "POST", { guest: ME, giftId: g.id, key: keyOf(g.id) });
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 409)) throw e;
      // the claim row exists already (an earlier attempt whose answer was lost): pick it up and finish the claim
      c = itemsOf<Claim>(await api(`/api/claims?key=${encodeURIComponent(keyOf(g.id))}`))[0];
      if (!c) throw e;
    }
    claimId = c.id;
    const saved = await api<Gift>(`/api/gifts/${g.id}/claim`, "POST");
    commit((d) => {
      d.mine[g.id] = claimId;
      applyGift(d, saved, false);
      if (REMAINING === "incremental") d.neededCount -= 1;
      d.notice = `You're bringing the ${g.name} — thank you!`;
    });
  } catch (e) {
    if (claimId && STEPS === "rollback") await api(`/api/claims/${claimId}`, "DELETE").catch(() => undefined);
    commit((d) => {
      if (claimId && STEPS === "dangling") d.mine[g.id] = claimId;
      d.error = errText(e, `reserving the ${g.name}`);
    });
  } finally {
    done(g.id);
  }
}

async function unclaim(g: Gift) {
  const s = registry.get();
  const claimId = s.mine[g.id];
  if (!claimId || (CLAIM_GUARD && s.pending.includes(g.id))) return;
  state.pending.push(g.id);
  state.error = state.notice = "";
  let deleted = false;
  try {
    await api(`/api/claims/${claimId}`, "DELETE").catch((e) => {
      if (!(e instanceof HttpError && e.status === 404)) throw e;
    });
    deleted = true;
    const saved = await api<Gift>(`/api/gifts/${g.id}/unclaim`, "POST");
    commit((d) => {
      delete d.mine[g.id];
      applyGift(d, saved, false);
      if (REMAINING === "incremental") d.neededCount += 1;
      d.notice = `Okay — the ${g.name} is back on the list.`;
    });
  } catch (e) {
    // rollback: the gift's count was not given back, so the guest keeps the claim (re-created)
    const again = deleted && STEPS === "rollback" ? await api<Claim>("/api/claims", "POST", { guest: ME, giftId: g.id, key: keyOf(g.id) }).catch(() => null) : null;
    commit((d) => {
      if (again) d.mine[g.id] = again.id;
      else if (deleted) delete d.mine[g.id];
      d.error = errText(e, `giving back the ${g.name}`);
    });
  } finally {
    done(g.id);
  }
}

function App() {
  const s = useSnapshot(state) as Registry;
  const bringing = Object.keys(s.mine).length;
  return (
    <main className="registry">
      <h1>Lena &amp; Tom's baby registry</h1>
      <p className="summary">
        {s.neededCount} still needed in this list · you're bringing {bringing} · {s.live ? "live" : "reconnecting…"}
      </p>
      <div className="filters">
        <label>
          Category{" "}
          <select name="category" value={s.category} onChange={(e) => setFilter({ category: e.target.value })}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          <input type="checkbox" name="needed" checked={s.onlyNeeded} onChange={(e) => setFilter({ onlyNeeded: e.target.checked })} /> Still needed only
        </label>
      </div>
      {s.error ? <p role="alert">{s.error}</p> : s.notice ? <p className="notice">{s.notice}</p> : null}
      {s.loading ? (
        <p className="muted">Loading the registry…</p>
      ) : (
        <ul className="gifts">
          {s.gifts.map((g) => {
            const busy = s.pending.includes(g.id);
            return (
              <li key={g.id} className="gift" data-id={g.id}>
                <strong className="name">{g.name}</strong> · {g.category} · ${g.price} from {g.shop} · {g.remaining > 0 ? `${g.remaining} of ${g.wanted} still needed` : "all taken"}
                {s.mine[g.id] ? (
                  <>
                    {" "}
                    · <em>you're bringing this</em>{" "}
                    <button type="button" className="unclaim" disabled={CLAIM_GUARD && busy} onClick={() => void unclaim(g)}>
                      Unclaim
                    </button>
                  </>
                ) : (
                  <button type="button" className="claim" disabled={g.remaining <= 0 || (CLAIM_GUARD && busy)} onClick={() => void claim(g)}>
                    I'll bring it
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!s.loading && !s.gifts.length && <p className="muted">Nothing left in this list — everything is spoken for.</p>}
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<App />);

let everUp = false;
liveTopic(
  "gifts",
  (m) => {
    if (m.item) commit((d) => applyGift(d, m.item as Gift, true));
  },
  (up) => {
    commit((d) => void (d.live = up));
    if (up && everUp) void load();
    if (up) everUp = true;
  },
);
void load();
void loadMine();
