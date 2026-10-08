// Community garden plot allocation (petite-vue templates over a reactive mirror of a runtime atom; fetch). Members
// claim free plots (versioned PATCH: neighbours claim and give up plots all the time), release their own, and sign up
// for watering days on a shared weekly rota (a versioned doc others edit too). The plot list polls. Latent bugs by
// flag: claims sent without the version (claim=force: a plot a neighbour took a moment ago is taken over), claim
// buttons live while posting (claimGuard=none: the second PATCH carries the old version), polls that overwrite plots
// with a claim in flight (poll=blind), rota sign-ups saved by PUTting the whole week as last loaded
// (watering=put-whole: names others added meanwhile are wiped) and season fees adjusted by hand (fees=incremental:
// a plot lost to a conflict is still charged).
import { createApp, reactive } from "petite-vue";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Plot = { id: number; bed: string; size: string; status: string; holder: string; fee: number; version: number };
type Rota = Record<string, string> & { version?: number };
const CLAIM = flag("claim", "if-match");
const CLAIM_GUARD = flag("claimGuard", "pending") === "pending";
const POLL = flag("poll", "pending-aware");
const WATERING = flag("watering", "patch-if-match");
const FEES = flag("fees", "derive");
const ME = "you";
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const garden = rt.atom("garden", { size: "all", plots: [] as Plot[], fees: 0, pending: [] as number[], rota: {} as Record<string, string>, waterVersion: 0, watering: "", error: "", notice: "" });
type G = ReturnType<typeof garden.get>;
const s = reactive({ ...garden.get() });
garden.subscribe((v) => Object.assign(s, v));
const feesOf = (ps: Plot[]) => ps.filter((p) => p.holder === ME).reduce((a, p) => a + p.fee, 0);
const withPlots = (g: G, plots: Plot[], delta = 0): G => ({ ...g, plots, fees: FEES === "derive" ? feesOf(plots) : g.fees + delta });
const pend = (id: number, on: boolean) => garden.update((g) => ({ ...g, pending: on ? [...g.pending, id] : g.pending.filter((x) => x !== id) }));
const put = (g: G, p: Plot) => g.plots.map((x) => (x.id === p.id ? p : x));

async function loadPlots(background = false) {
  try {
    const plots = itemsOf<Plot>(await api(`/api/plots?limit=30`));
    garden.update((g) => {
      const local = new Map(g.plots.map((p) => [p.id, p]));
      const merged = POLL === "pending-aware" ? plots.map((p) => (g.pending.includes(p.id) ? (local.get(p.id) ?? p) : p)) : plots;
      return { ...withPlots(g, merged), fees: FEES === "derive" || !background ? feesOf(merged) : g.fees };
    });
  } catch (e) {
    if (!background) garden.update((g) => ({ ...g, error: errText(e, "loading plots") }));
  }
}

async function claim(p: Plot) {
  if (CLAIM_GUARD && garden.get().pending.includes(p.id)) return;
  pend(p.id, true);
  garden.update((g) => ({ ...g, error: "", notice: "", ...(FEES === "incremental" ? { fees: g.fees + p.fee } : {}) }));
  try {
    const body: Record<string, unknown> = { status: "taken", holder: ME };
    if (CLAIM === "if-match") body.version = p.version;
    const saved = await api<Plot>(`/api/plots/${p.id}`, "PATCH", body);
    garden.update((g) => ({ ...withPlots(g, put(g, saved)), ...(FEES === "incremental" ? { fees: g.fees } : {}), notice: `Plot ${saved.bed} is yours for the season ($${saved.fee}).` }));
  } catch (e) {
    const cur = e instanceof HttpError && e.status === 409 ? (e.body?.current as Plot | undefined) : undefined;
    garden.update((g) => ({ ...(cur ? { ...withPlots(g, put(g, cur)), ...(FEES === "incremental" ? { fees: g.fees } : {}) } : g), error: cur ? `Plot ${p.bed} was just taken by a neighbour.` : errText(e, `claiming plot ${p.bed}`) }));
  } finally {
    pend(p.id, false);
  }
}

async function release(p: Plot) {
  if (garden.get().pending.includes(p.id)) return;
  pend(p.id, true);
  try {
    const saved = await api<Plot>(`/api/plots/${p.id}`, "PATCH", { status: "free", holder: "", version: p.version });
    garden.update((g) => ({ ...withPlots(g, put(g, saved), -p.fee), notice: `You released plot ${saved.bed}.` }));
  } catch (e) {
    garden.update((g) => ({ ...g, error: errText(e, `releasing plot ${p.bed}`) }));
  } finally {
    pend(p.id, false);
  }
}

async function loadRota() {
  try {
    const doc = await api<Rota>(`/api/docs/watering`);
    garden.update((g) => (g.watering ? g : { ...g, rota: Object.fromEntries(DAYS.map((d) => [d, String(doc[d] ?? "")])), waterVersion: Number(doc.version ?? 0) }));
  } catch {
    /* keep the rota we have */
  }
}

async function takeDay(day: string) {
  const g0 = garden.get();
  if (g0.watering || g0.rota[day]) return;
  garden.update((g) => ({ ...g, watering: day, error: "", notice: "" }));
  try {
    let doc: Rota;
    if (WATERING === "patch-if-match") {
      try {
        doc = await api<Rota>(`/api/docs/watering`, "PATCH", { [day]: ME, version: g0.waterVersion });
      } catch (e) {
        const cur = e instanceof HttpError && e.status === 409 ? (e.body?.current as Rota | undefined) : undefined;
        if (!cur) throw e;
        if (cur[day]) throw new Error(`${cur[day]} already waters on ${day}`);
        doc = await api<Rota>(`/api/docs/watering`, "PATCH", { [day]: ME, version: cur.version });
      }
    } else doc = await api<Rota>(`/api/docs/watering`, "PUT", { ...g0.rota, [day]: ME });
    garden.update((g) => ({ ...g, rota: Object.fromEntries(DAYS.map((d) => [d, String(doc[d] ?? "")])), waterVersion: Number(doc.version ?? 0), notice: `You're watering on ${day}. Thanks!` }));
  } catch (e) {
    garden.update((g) => ({ ...g, error: e instanceof HttpError ? errText(e, "signing up to water") : `${(e as Error).message}.` }));
    void loadRota();
  } finally {
    garden.update((g) => ({ ...g, watering: "" }));
  }
}

document.getElementById("app")!.innerHTML = `<div v-scope>
  <h1>Maple Street community garden</h1>
  <p class="fees">Your season fees: \${{ s.fees }}</p>
  <nav class="sizes"><button v-for="z in ['all', 'small', 'large']" :key="z" type="button" :class="{ current: s.size === z }" @click="pick(z)">{{ z === 'all' ? 'All' : z }}</button></nav>
  <p role="alert" v-if="s.error">{{ s.error }}</p><p class="notice" v-else-if="s.notice">{{ s.notice }}</p>
  <ul class="plots"><li v-for="p in s.plots.filter(x => s.size === 'all' || x.size === s.size)" :key="p.id" :class="['plot', p.holder === 'you' ? 'mine' : p.status]">
    Bed {{ p.bed }} · {{ p.size }} · \${{ p.fee }} · {{ p.holder === 'you' ? 'yours' : p.status }}
    <button v-if="p.status === 'free'" type="button" class="claim" :disabled="guard && s.pending.includes(p.id)" @click="claim(p)">Claim</button>
    <button v-if="p.holder === 'you'" type="button" class="release" :disabled="s.pending.includes(p.id)" @click="release(p)">Release</button></li></ul>
  <h2>Watering rota</h2>
  <table class="watering"><tr><td v-for="d in days" :key="d">{{ d }}: <span v-if="s.rota[d]">{{ s.rota[d] }}</span><button v-else type="button" class="take" :disabled="!!s.watering" @click="take(d)">I'll water</button></td></tr></table>
</div>`;
createApp({ s, days: DAYS, guard: CLAIM_GUARD, claim: (p: Plot) => void claim(p), release: (p: Plot) => void release(p), take: (d: string) => void takeDay(d), pick: (z: string) => garden.update((g) => ({ ...g, size: z })) }).mount();
void loadPlots();
void loadRota();
setInterval(() => void loadPlots(true), 4000);
setInterval(() => void loadRota(), 6000);
