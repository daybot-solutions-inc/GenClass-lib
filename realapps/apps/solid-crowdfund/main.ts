// Crowdfunding campaign page (SolidJS with solid-js/html, @tanstack/solid-query, fetch, WebSocket). Reward tiers
// have a limited quantity (`left`); pledging to a tier is POST /pledges {backer, tierId, key: backer|tier} (the key is
// unique on the server: one pledge per backer and tier), then POST /tiers/:id/take (left - 1), then POST
// /counters/funded/incr {by}. The funded total comes from a live counter (WebSocket topic counters/funded); recent
// backers are paged by cursor ("More backers"). The ["tiers"] and ["backers"] query caches are registered with
// rt.guard (the app's own cache writes go through GenClass; query fetches are traced). Latent bugs by flag:
// pledges retried after a 5xx without an idempotency key or a unique key (pledgeKey=none: the retry pledges twice),
// the reward taken before the pledge is recorded (steps=take-first: a pledge that 409s or fails leaves the tier one
// short), tier quantities left as they were after a pledge (tiers=stale: "3 left" stays until the next poll, so the
// last reward can be oversold), the funded total bumped locally before the pledge and never rolled back
// (total=optimistic-no-rollback: a failed pledge inflates the total until the real one overtakes it) and pledge
// buttons live while a pledge to that tier is still processing (pledgeGuard=none: a double click pledges twice).
import html from "solid-js/html";
import { render } from "solid-js/web";
import { For, Show, createSignal } from "solid-js";
import { QueryClient, useInfiniteQuery, useMutation, useQuery, type InfiniteData } from "@tanstack/solid-query";
import { rt, flag } from "../_shared/genclass";
import { atomSignal } from "../_shared/solid-atom";
import { api, itemsOf, errText, HttpError, liveTopic } from "../_shared/w3-http";

type Tier = { id: number; name: string; amount: number; left: number; limit: number; perks: string; ships: string };
type Pledge = { id: number; backer: string; tierId: number; tier: string; amount: number; key?: string; createdAt?: string };
type TierList = { items: Tier[]; total: number };
type BackerPage = { items: Pledge[]; total: number; nextCursor: string | null };
type Backers = InfiniteData<BackerPage, string>;
type PledgeVars = { tier: Tier; backer: string; attempt: string };

const KEYED = flag("pledgeKey", "idempotency-key") === "idempotency-key";
const STEPS = flag("steps", "pledge-first") as "pledge-first" | "take-first";
const TIERS_AFTER = flag("tiers", "invalidate") as "invalidate" | "stale";
const TOTAL = flag("total", "server") as "server" | "optimistic-no-rollback";
const PLEDGE_GUARD = flag("pledgeGuard", "pending") === "pending";

const TIERS = ["tiers"];
const BACKERS = ["backers"];
const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 3000 } } });

function cacheGuard<T>(name: string, key: string[], empty: T) {
  return rt.guard<T>(name, {
    get: () => qc.getQueryData<T>(key) ?? empty,
    set: (v) => void qc.setQueryData<T>(key, v),
    subscribe: (fn) =>
      qc.getQueryCache().subscribe((e) => {
        if (e.type === "updated" && e.query.queryKey[0] === key[0] && e.action.type === "success") fn();
      }),
  });
}
const tiers = cacheGuard<TierList>("tiers", TIERS, { items: [], total: 0 });
const backers = cacheGuard<Backers>("backers", BACKERS, { pages: [], pageParams: [] });
const campaign = rt.atom("campaign", { backer: "Robin Hale", funded: 0, live: false, availableOnly: false, mine: [] as Pledge[], myTotal: 0, error: "", notice: "" });
const [pending, setPending] = createSignal<number[]>([]);

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The counter only ever grows: keep the highest value the server reported (pushes and answers can cross). */
const raise = (v: number) => campaign.update((c) => (Number.isFinite(v) && v > c.funded ? { ...c, funded: v } : c));

async function loadFunded() {
  try {
    raise(Number((await api<{ value: number }>("/api/counters/funded")).value));
  } catch {
    /* the live counter will fill it in */
  }
}

async function postPledge(v: PledgeVars): Promise<Pledge> {
  const body: Record<string, unknown> = { backer: v.backer, tierId: v.tier.id, tier: v.tier.name, amount: v.tier.amount };
  const headers: Record<string, string> = {};
  if (KEYED) {
    body.key = `${v.backer}|${v.tier.id}`;
    headers["Idempotency-Key"] = v.attempt;
  }
  for (let i = 0; ; i++) {
    try {
      return await api<Pledge>("/api/pledges", "POST", body, headers);
    } catch (e) {
      // the payment gateway hiccupped: try once more before telling the backer
      if (i === 0 && (!(e instanceof HttpError) || e.status >= 500)) {
        await sleep(700);
        continue;
      }
      throw e;
    }
  }
}

const take = (id: number) => api<Tier>(`/api/tiers/${id}/take`, "POST");

async function runPledge(v: PledgeVars): Promise<{ saved: Pledge; taken: Tier }> {
  let saved: Pledge;
  let taken: Tier;
  if (STEPS === "take-first") {
    taken = await take(v.tier.id); // reserve the reward, then record the pledge
    saved = await postPledge(v);
  } else {
    saved = await postPledge(v);
    taken = await take(v.tier.id);
  }
  try {
    raise(Number((await api<{ value: number }>("/api/counters/funded/incr", "POST", { by: v.tier.amount })).value));
  } catch {
    /* the total catches up from the live counter */
  }
  return { saved, taken };
}

function Campaign() {
  const c = atomSignal(campaign);
  const tiersQ = useQuery(
    () => ({
      queryKey: TIERS,
      queryFn: async () => {
        const body = await api<TierList>("/api/tiers?limit=20");
        return { items: itemsOf<Tier>(body), total: Number(body.total ?? 0) };
      },
      refetchInterval: 9000,
    }),
    () => qc,
  );
  const backersQ = useInfiniteQuery(
    () => ({
      queryKey: BACKERS,
      queryFn: ({ pageParam }: { pageParam: string }) => api<BackerPage>(`/api/pledges?sort=-createdAt&limit=5&cursor=${encodeURIComponent(pageParam)}`),
      initialPageParam: "",
      getNextPageParam: (last: BackerPage) => last.nextCursor ?? undefined,
      refetchInterval: 15000,
    }),
    () => qc,
  );
  const pledge = useMutation(
    () => ({
      mutationFn: runPledge,
      onMutate: (v: PledgeVars) => {
        setPending((p) => [...p, v.tier.id]);
        campaign.update((x) => ({ ...x, error: "", notice: "", funded: TOTAL === "optimistic-no-rollback" ? x.funded + v.tier.amount : x.funded }));
      },
      onSuccess: ({ saved, taken }: { saved: Pledge; taken: Tier }, v: PledgeVars) => {
        if (TIERS_AFTER === "invalidate") {
          tiers.update((l) => ({ ...l, items: l.items.map((t) => (t.id === taken.id ? { ...t, left: taken.left } : t)) }));
          void qc.invalidateQueries({ queryKey: TIERS });
        }
        backers.update((b) => {
          if (!b.pages.length || b.pages.some((p) => p.items.some((x) => x.id === saved.id))) return b;
          const [first, ...rest] = b.pages;
          return { ...b, pages: [{ ...first!, items: [saved, ...first!.items], total: first!.total + 1 }, ...rest] };
        });
        campaign.update((x) => ({ ...x, mine: [...x.mine, saved], myTotal: x.myTotal + saved.amount, notice: `Thank you, ${v.backer}! You're backing ${v.tier.name}.` }));
      },
      onError: (e: Error, v: PledgeVars) => {
        const msg = e instanceof HttpError && e.status === 409 ? `${v.backer} already backs ${v.tier.name}.` : errText(e, `your pledge to ${v.tier.name}`);
        campaign.update((x) => ({ ...x, notice: "", error: msg }));
        if (TIERS_AFTER === "invalidate") void qc.invalidateQueries({ queryKey: TIERS });
      },
      onSettled: (_d: unknown, _e: unknown, v: PledgeVars) => {
        setPending((p) => {
          const i = p.indexOf(v.tier.id);
          return i < 0 ? p : [...p.slice(0, i), ...p.slice(i + 1)];
        });
      },
    }),
    () => qc,
  );

  const start = (t: Tier) => {
    const backer = c().backer.trim();
    if (!backer || t.left <= 0) return;
    if (PLEDGE_GUARD && pending().includes(t.id)) return;
    pledge.mutate({ tier: t, backer, attempt: crypto.randomUUID() });
  };
  const shown = () => (tiersQ.data?.items ?? []).filter((t) => !c().availableOnly || t.left > 0);
  const recent = () => (backersQ.data?.pages ?? []).flatMap((p) => itemsOf<Pledge>(p));
  const goal = 75000;

  return html`<main class="campaign">
    <header>
      <h1>Driftwood — a handmade wooden synthesizer</h1>
      <p class="funded"><strong>${() => money(c().funded)}</strong> pledged of ${money(goal)} goal · ${() => `${Math.min(100, Math.floor((c().funded / goal) * 100))}% funded`} · ${() => (c().live ? "live" : "reconnecting…")}</p>
    </header>
    <${Show} when=${() => tiersQ.isError && !tiersQ.data}><p role="alert">Rewards couldn't be loaded.</p><//>
    <${Show} when=${() => c().error}><p role="alert">${() => c().error}</p><//>
    <${Show} when=${() => c().notice}><p class="notice">${() => c().notice}</p><//>
    <section class="you">
      <label>Backer name <input name="backer" value=${() => c().backer} onInput=${(e: Event) => campaign.update((x) => ({ ...x, backer: (e.currentTarget as HTMLInputElement).value }))} /></label>
      <label><input type="checkbox" name="available" checked=${() => c().availableOnly} onChange=${(e: Event) => campaign.update((x) => ({ ...x, availableOnly: (e.currentTarget as HTMLInputElement).checked }))} /> Hide sold-out rewards</label>
      <p class="mine">${() => (c().mine.length ? `You've pledged ${money(c().myTotal)} across ${c().mine.length} ${c().mine.length === 1 ? "reward" : "rewards"}.` : "You haven't pledged yet.")}</p>
    </section>
    <ul class="tiers">
      <${For} each=${shown}>${(t: Tier) => html`<li class="tier">
        <h2>${t.name} — ${money(t.amount)}</h2>
        <p class="perks">${t.perks} Ships ${t.ships}.</p>
        <p class="left">${t.left > 0 ? `${t.left} of ${t.limit} left` : "All claimed"}</p>
        <button class="pledge" disabled=${() => t.left <= 0 || (PLEDGE_GUARD && pending().includes(t.id))} onClick=${() => start(t)}>${() => (pending().includes(t.id) ? "Processing…" : t.left > 0 ? `Pledge ${money(t.amount)}` : "Sold out")}</button>
      </li>`}<//>
    </ul>
    <section class="backers">
      <h2>Recent backers</h2>
      <ol>
        <${For} each=${recent}>${(p: Pledge) => html`<li class="backer">${p.backer} backed ${p.tier} (${money(p.amount)})</li>`}<//>
      </ol>
      <${Show} when=${() => backersQ.hasNextPage}>
        <button class="more-backers" disabled=${() => backersQ.isFetchingNextPage} onClick=${() => void backersQ.fetchNextPage()}>${() => (backersQ.isFetchingNextPage ? "Loading…" : "More backers")}</button>
      <//>
    </section>
  </main>`;
}

render(() => html`<${Campaign} />`, document.getElementById("app")!);
let everUp = false;
liveTopic(
  "counters/funded",
  (m) => raise(Number(m.value)),
  (up) => {
    campaign.update((x) => ({ ...x, live: up }));
    if (up && everUp) void loadFunded(); // pledges made while we were offline
    if (up) everUp = true;
  },
);
void loadFunded();
