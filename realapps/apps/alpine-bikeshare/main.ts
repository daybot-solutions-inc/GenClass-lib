// Bike share dock finder for group rides (Alpine.js 3 x-data component holding its own state — nothing registered
// with GenClass: observe-only; fetch + WebSocket). Dock availability changes live as riders take and return bikes. A
// rider can hold up to three bikes (one per dock) for 12 s each: POST /reservations (one per rider and dock), then
// POST /docks/:id/reserve takes the bike off the dock; a countdown cancels each hold when it runs out (DELETE + POST
// /docks/:id/release). Latent bugs by flag: reserve buttons live while a hold is being placed (reserveGuard=none: the
// second POST answers 409), pushes applied in arrival order (live=blind: an older count overwrites a newer one), holds
// that expire only on screen (expiry=leak: the server keeps the reservation and the bike), reconnects without a reload
// (reconnect=naive) and a failed second step that leaves the reservation behind (steps=dangling: that dock can never
// be held again).
import Alpine from "alpinejs";
import { flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError, liveTopic } from "../_shared/w3-http";

type Dock = { id: number; name: string; area: string; bikes: number; ebikes: number; slots: number; updatedAt?: string };
type Hold = { id: number; dockId: number; name: string; left: number };
const MAX_HOLDS = 3;
const RESERVE_GUARD = flag("reserveGuard", "pending") === "pending";
const LIVE = flag("live", "newer-wins");
const EXPIRY = flag("expiry", "cancel-on-expire");
const RECONNECT = flag("reconnect", "resync");
const STEPS = flag("steps", "rollback");
const HOLD_S = 12;

Alpine.data("bikes", () => ({
  area: "all",
  docks: [] as Dock[],
  loading: true,
  holds: [] as Hold[],
  busy: [] as number[],
  live: false,
  error: "",
  notice: "",
  timer: 0 as unknown as ReturnType<typeof setInterval>,
  guard: RESERVE_GUARD,

  init() {
    let everUp = false;
    liveTopic(
      "docks",
      (m) => {
        if (m.type === "updated" && m.item) this.apply(m.item as Dock, true);
      },
      (up) => {
        this.live = up;
        if (up && everUp && RECONNECT === "resync") void this.load();
        if (up) everUp = true;
      },
    );
    void this.load();
    void this.restore();
  },
  get shown(): Dock[] {
    return this.docks.filter((d) => this.area === "all" || d.area === this.area);
  },
  apply(d: Dock, fromPush = false) {
    this.docks = this.docks.map((x) => (x.id !== d.id ? x : fromPush && LIVE === "newer-wins" && x.updatedAt && d.updatedAt && d.updatedAt < x.updatedAt ? x : d));
  },
  async load() {
    try {
      const body = await api(`/api/docks?limit=20`);
      this.docks = itemsOf<Dock>(body);
      this.error = this.error.startsWith("Docks") ? "" : this.error;
    } catch (e) {
      if (!this.docks.length) this.error = `Docks could not be loaded — ${errText(e, "loading docks")}`;
    } finally {
      this.loading = false;
    }
  },
  async restore() {
    try {
      const mine = itemsOf<{ id: number; dockId: number; dock: string }>(await api(`/api/reservations?rider=you`));
      for (const r of mine) if (!this.holds.some((h) => h.dockId === r.dockId)) this.holds = [...this.holds, { id: r.id, dockId: r.dockId, name: r.dock, left: HOLD_S }];
      if (this.holds.length) this.tick();
    } catch {
      /* no holds to restore */
    }
  },
  tick() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.holds.length) {
        clearInterval(this.timer);
        this.timer = 0 as unknown as ReturnType<typeof setInterval>;
        return;
      }
      this.holds = this.holds.map((h) => (this.busy.includes(h.dockId) ? h : { ...h, left: h.left - 1 }));
      for (const h of this.holds.filter((x) => x.left <= 0)) {
        if (EXPIRY === "cancel-on-expire") void this.cancel(h, true);
        else {
          this.holds = this.holds.filter((x) => x !== h);
          this.notice = `Your hold at ${h.name} expired.`;
        }
      }
    }, 1000);
  },
  held(d: Dock) {
    return this.holds.some((h) => h.dockId === d.id);
  },
  async reserve(d: Dock) {
    if (RESERVE_GUARD && this.busy.includes(d.id)) return;
    if (this.held(d)) return;
    if (this.holds.length >= MAX_HOLDS) {
      this.error = `You can hold at most ${MAX_HOLDS} bikes.`;
      return;
    }
    this.busy = [...this.busy, d.id];
    this.error = "";
    this.notice = "";
    let resv: { id: number } | null = null;
    try {
      resv = await api<{ id: number }>(`/api/reservations`, "POST", { dockId: d.id, dock: d.name, rider: "you", key: `you@${d.id}` });
      const dock = await api<Dock>(`/api/docks/${d.id}/reserve`, "POST");
      this.apply(dock);
      this.holds = [...this.holds, { id: resv.id, dockId: d.id, name: d.name, left: HOLD_S }];
      this.tick();
      this.notice = `A bike is held for you at ${d.name}.`;
    } catch (e) {
      if (resv && STEPS === "rollback") await api(`/api/reservations/${resv.id}`, "DELETE").catch(() => undefined);
      this.error = e instanceof HttpError && e.status === 409 ? `You already hold a bike at ${d.name}.` : errText(e, `holding a bike at ${d.name}`);
    } finally {
      this.busy = this.busy.filter((x) => x !== d.id);
    }
  },
  async cancel(h: Hold, expired = false) {
    if (this.busy.includes(h.dockId)) return;
    this.busy = [...this.busy, h.dockId];
    try {
      await api(`/api/reservations/${h.id}`, "DELETE");
      this.holds = this.holds.filter((x) => x.id !== h.id);
      const dock = await api<Dock>(`/api/docks/${h.dockId}/release`, "POST");
      this.apply(dock);
      this.notice = expired ? `Your hold at ${h.name} expired.` : `Hold at ${h.name} cancelled.`;
    } catch (e) {
      this.error = errText(e, "cancelling the hold");
    } finally {
      this.busy = this.busy.filter((x) => x !== h.dockId);
    }
  },
}));

document.getElementById("app")!.innerHTML = `<main x-data="bikes">
  <h1>Bike share</h1>
  <p class="status" x-text="live ? 'live availability' : 'reconnecting…'"></p>
  <label>Area <select name="area" x-model="area"><option value="all">All areas</option><option>Downtown</option><option>Riverside</option><option>University</option></select></label>
  <button type="button" class="refresh" @click="load()">Refresh</button>
  <p role="alert" x-show="error" x-text="error"></p><p class="notice" x-show="!error && notice" x-text="notice"></p>
  <ul class="holds"><template x-for="h in holds" :key="h.id"><li class="hold">Bike held at <span x-text="h.name"></span> · <span x-text="Math.max(0, h.left) + ' s left'"></span> <button type="button" class="cancel-reservation" @click="cancel(h)">Cancel hold</button></li></template></ul>
  <p class="muted" x-show="loading">Loading docks…</p>
  <ul class="docks"><template x-for="d in shown" :key="d.id"><li class="dock"><strong x-text="d.name"></strong> · <span x-text="d.area"></span> · <span x-text="Math.max(0, d.bikes) + ' bikes, ' + d.ebikes + ' e-bikes'"></span>
    <button type="button" class="reserve" :disabled="Math.max(0, d.bikes) === 0 || held(d) || (guard && busy.includes(d.id))" @click="reserve(d)" x-text="held(d) ? 'Held' : 'Hold a bike'"></button></li></template></ul>
</main>`;
Alpine.start();
