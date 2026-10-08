// Makerspace tool checkout (Alpine.js 3 x-data component holding its own state — nothing registered with GenClass:
// observe-only; fetch). Members check out tools they are certified for (GET /certs?member=you): a checkout is POST
// /checkouts {toolId, member, key} (the key is unique while a checkout is open) and then POST /tools/:id/out (a
// relative action that also counts uses). Returning deletes the checkout and POSTs /tools/:id/in. A tool someone
// else has out can be waitlisted (POST /waitlist, one entry per member and tool). The tool board polls every 3 s while
// other members take and bring back tools. Latent bugs by flag: Check out / Join waitlist buttons live while their
// request is in flight (checkoutGuard=none, waitlistGuard=none: the second POST answers 409 and shows an error after
// the first succeeded), a failed second checkout step that leaves the checkout record behind (steps=dangling: that
// tool can never be checked out again), polls on a fixed interval applied in arrival order and over local writes
// (poll=interval: a slow, older board overwrites a newer one) and returns shown at once and never rolled back
// (returnMode=optimistic-no-rollback: a failed return disappears from "your tools" while the server still has it out).
import Alpine from "alpinejs";
import { flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Tool = { id: number; name: string; area: string; cert: string; status: "available" | "out"; holder: string; uses: number };
type Checkout = { id: number; toolId: number; tool: string };
type Wait = { id: number; toolId: number; tool: string };
const CHECKOUT_GUARD = flag("checkoutGuard", "pending") === "pending";
const STEPS = flag("steps", "rollback");
const WAITLIST_GUARD = flag("waitlistGuard", "pending") === "pending";
const POLL = flag("poll", "chain");
const RETURN_MODE = flag("returnMode", "pessimistic");
const MAX_OUT = 3;
const POLL_MS = 3000;

Alpine.data("makerspace", () => ({
  area: "all",
  tools: [] as Tool[],
  certs: [] as string[],
  mine: [] as Checkout[],
  waits: [] as Wait[],
  busy: [] as number[],
  loading: true,
  error: "",
  notice: "",
  writeGen: 0,
  /** checkouts in flight (they count against the limit) */
  outgoing: 0,
  guardCheckout: CHECKOUT_GUARD,
  guardWait: WAITLIST_GUARD,

  init() {
    void this.loadMine();
    void this.refresh(true);
    if (POLL === "chain") {
      const tick = async () => {
        await this.poll();
        setTimeout(() => void tick(), POLL_MS);
      };
      setTimeout(() => void tick(), POLL_MS);
    } else setInterval(() => void this.poll(), POLL_MS);
  },
  get shown(): Tool[] {
    return this.tools.filter((t) => this.area === "all" || t.area === this.area);
  },
  get available(): number {
    return this.tools.filter((t) => t.status === "available").length;
  },
  certified(t: Tool) {
    return this.certs.includes(t.cert);
  },
  waiting(t: Tool) {
    return this.waits.some((w) => w.toolId === t.id);
  },
  label(t: Tool) {
    if (t.status === "available") return this.waiting(t) ? "available — your turn" : "available";
    return t.holder === "you" ? "out with you" : `out with ${t.holder}${this.waiting(t) ? " · you're on the waitlist" : ""}`;
  },
  apply(t: Tool) {
    this.tools = this.tools.map((x) => (x.id === t.id ? t : x));
  },
  async loadMine() {
    try {
      const [certs, mine, waits] = await Promise.all([api(`/api/certs?member=you&limit=20`), api(`/api/checkouts?member=you&limit=20`), api(`/api/waitlist?member=you&limit=20`)]);
      this.certs = itemsOf<{ cert: string }>(certs).map((c) => c.cert);
      this.mine = itemsOf<Checkout>(mine);
      this.waits = itemsOf<Wait>(waits);
    } catch (e) {
      this.error = errText(e, "loading your account");
      setTimeout(() => void this.loadMine(), 3000);
    }
  },
  async refresh(first = false) {
    const gen = this.writeGen;
    try {
      const tools = itemsOf<Tool>(await api(`/api/tools?limit=30`));
      if (POLL === "chain" && gen !== this.writeGen) return;
      this.tools = tools;
      if (this.error.startsWith("Tools")) this.error = "";
    } catch (e) {
      if (first || !this.tools.length) this.error = `Tools could not be loaded — ${errText(e, "loading tools")}`;
    } finally {
      this.loading = false;
    }
  },
  async poll() {
    const gen = this.writeGen;
    try {
      const tools = itemsOf<Tool>(await api(`/api/tools?limit=30`));
      // a checkout or return that landed meanwhile is newer than this answer
      if (POLL === "chain" && gen !== this.writeGen) return;
      this.tools = tools;
    } catch {
      /* keep showing the last known board */
    }
  },
  async checkout(t: Tool) {
    if (CHECKOUT_GUARD && this.busy.includes(t.id)) return;
    if (!this.certified(t) || t.status !== "available") return;
    if (this.mine.length + (CHECKOUT_GUARD ? this.outgoing : 0) >= MAX_OUT) {
      this.error = `You can have at most ${MAX_OUT} tools out at once.`;
      return;
    }
    this.busy = [...this.busy, t.id];
    this.outgoing++;
    this.error = "";
    this.notice = "";
    let co: Checkout | null = null;
    try {
      co = await api<Checkout>(`/api/checkouts`, "POST", { toolId: t.id, tool: t.name, member: "you", key: `you@${t.id}` });
      const tool = await api<Tool>(`/api/tools/${t.id}/out`, "POST");
      this.writeGen++;
      this.apply(tool);
      this.mine = [...this.mine, co];
      const w = this.waits.find((x) => x.toolId === t.id);
      if (w) {
        await api(`/api/waitlist/${w.id}`, "DELETE").catch(() => undefined);
        this.waits = this.waits.filter((x) => x.id !== w.id);
      }
      this.notice = `${t.name} is checked out to you.`;
    } catch (e) {
      if (co && STEPS === "rollback") await api(`/api/checkouts/${co.id}`, "DELETE").catch(() => undefined);
      this.error = e instanceof HttpError && e.status === 409 ? `${t.name} is already checked out to you.` : errText(e, `checking out the ${t.name.toLowerCase()}`);
    } finally {
      this.outgoing--;
      this.busy = this.busy.filter((x) => x !== t.id);
    }
  },
  async giveBack(c: Checkout) {
    if (this.busy.includes(c.toolId)) return;
    this.busy = [...this.busy, c.toolId];
    this.error = "";
    this.notice = "";
    const optimistic = RETURN_MODE !== "pessimistic";
    if (optimistic) {
      this.mine = this.mine.filter((x) => x.id !== c.id);
      this.tools = this.tools.map((x) => (x.id === c.toolId ? { ...x, status: "available", holder: "" } : x));
    }
    try {
      await api(`/api/checkouts/${c.id}`, "DELETE");
      const tool = await api<Tool>(`/api/tools/${c.toolId}/in`, "POST");
      this.writeGen++;
      this.apply(tool);
      this.mine = this.mine.filter((x) => x.id !== c.id);
      this.notice = `Thanks for returning the ${c.tool.toLowerCase()}.`;
    } catch (e) {
      this.error = errText(e, `returning the ${c.tool.toLowerCase()}`);
      // pessimistic: show what the server has now
      if (!optimistic) {
        this.writeGen++;
        void this.loadMine();
        void this.refresh();
      }
    } finally {
      this.busy = this.busy.filter((x) => x !== c.toolId);
    }
  },
  async join(t: Tool) {
    if (WAITLIST_GUARD && this.busy.includes(t.id)) return;
    if (this.waiting(t)) return;
    this.busy = [...this.busy, t.id];
    this.error = "";
    this.notice = "";
    try {
      const w = await api<Wait>(`/api/waitlist`, "POST", { toolId: t.id, tool: t.name, member: "you", key: `you@${t.id}` });
      this.waits = [...this.waits, w];
      this.notice = `You're on the waitlist for the ${t.name.toLowerCase()}.`;
    } catch (e) {
      this.error = e instanceof HttpError && e.status === 409 ? `You're already on the waitlist for the ${t.name.toLowerCase()}.` : errText(e, "joining the waitlist");
    } finally {
      this.busy = this.busy.filter((x) => x !== t.id);
    }
  },
}));

document.getElementById("app")!.innerHTML = `<main x-data="makerspace">
  <h1>Makerspace tools</h1>
  <p class="status" x-text="mine.length + ' of ${MAX_OUT} tools out with you · ' + available + ' available'"></p>
  <label>Area <select name="area" x-model="area"><option value="all">All areas</option><option>Fab lab</option><option>Wood shop</option><option>Textiles</option><option>Electronics</option><option>Metal shop</option></select></label>
  <button type="button" class="refresh" @click="refresh()">Refresh</button>
  <p role="alert" x-show="error" x-text="error"></p><p class="notice" x-show="!error && notice" x-text="notice"></p>
  <h2>Checked out to you</h2>
  <p class="muted" x-show="!mine.length">Nothing checked out.</p>
  <ul class="mine"><template x-for="c in mine" :key="c.id"><li class="mine"><span x-text="c.tool"></span> <button type="button" class="return" :disabled="busy.includes(c.toolId)" @click="giveBack(c)">Return</button></li></template></ul>
  <h2>Tool board</h2>
  <p class="muted" x-show="loading">Loading tools…</p>
  <ul class="tools"><template x-for="t in shown" :key="t.id"><li class="tool"><strong x-text="t.name"></strong> · <span x-text="t.area"></span> · <span x-text="label(t)"></span>
    <button type="button" class="checkout" x-show="t.status === 'available' && certified(t)" :disabled="guardCheckout && busy.includes(t.id)" @click="checkout(t)">Check out</button>
    <button type="button" class="waitlist" x-show="t.status === 'out' && t.holder !== 'you' && certified(t) && !waiting(t)" :disabled="guardWait && busy.includes(t.id)" @click="join(t)">Join waitlist</button>
    <span class="needs" x-show="!certified(t)" x-text="'needs ' + t.cert + ' certification'"></span></li></template></ul>
</main>`;
Alpine.start();
