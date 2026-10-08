// Theatre box office seat map (petite-vue templates over a reactive mirror of a runtime atom; fetch). Clicking an
// available seat holds it (versioned PATCH: another buyer may have held it a moment ago), held seats form the basket
// and checkout creates an order then marks the seats sold. Latent bugs by flag: holds sent without the version
// (holdVersion=none: another buyer's hold is overwritten), seats clickable while their hold posts (holdGuard=none),
// a basket total kept by hand (total=incremental), order POSTs retried without an Idempotency-Key (orderKey=none)
// and seat-map polls that overwrite seats with a hold in flight (mapPoll=blind).
import { createApp, reactive } from "petite-vue";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Seat = { id: number; section: string; row: string; num: number; price: number; status: string; holder: string; version: number };
const HOLD_VERSION = flag("holdVersion", "if-match");
const HOLD_GUARD = flag("holdGuard", "pending") === "pending";
const TOTAL = flag("total", "derive");
const ORDER_KEY = flag("orderKey", "idempotency-key");
const MAP_POLL = flag("mapPoll", "pending-aware");
const ME = "me";

const box = rt.atom("box", { section: "Stalls", seats: [] as Seat[], mine: [] as Seat[], total: 0, pending: [] as number[], paying: false, error: "", notice: "" });
type Box = ReturnType<typeof box.get>;
const s = reactive({ ...box.get() });
box.subscribe((v) => Object.assign(s, v));
const sum = (xs: Seat[]) => xs.reduce((a, x) => a + x.price, 0);

function applySeat(b: Box, seat: Seat): Box {
  const wasMine = b.mine.some((m) => m.id === seat.id);
  const isMine = seat.status === "held" && seat.holder === ME;
  const mine = isMine ? (wasMine ? b.mine.map((m) => (m.id === seat.id ? seat : m)) : [...b.mine, seat]) : b.mine.filter((m) => m.id !== seat.id);
  const delta = isMine && !wasMine ? seat.price : !isMine && wasMine ? -seat.price : 0;
  return { ...b, seats: b.seats.map((x) => (x.id === seat.id ? seat : x)), mine, total: TOTAL === "derive" ? sum(mine) : b.total + delta };
}
const pend = (id: number, on: boolean) => box.update((b) => ({ ...b, pending: on ? [...b.pending, id] : b.pending.filter((x) => x !== id) }));

async function loadMap(background = false) {
  const section = box.get().section;
  try {
    const seats = itemsOf<Seat>(await api(`/api/seats?section=${section}&limit=40`));
    if (box.get().section !== section) return;
    box.update((b) => {
      const local = new Map(b.seats.map((x) => [x.id, x]));
      const merged = seats.map((x) => (MAP_POLL === "pending-aware" && b.pending.includes(x.id) ? (local.get(x.id) ?? x) : x));
      return { ...b, seats: merged };
    });
  } catch (e) {
    if (!background) box.update((b) => ({ ...b, error: errText(e, "loading the seat map") }));
  }
}

async function hold(seat: Seat) {
  if (HOLD_GUARD && box.get().pending.includes(seat.id)) return;
  pend(seat.id, true);
  box.update((b) => ({ ...b, error: "", notice: "" }));
  try {
    const body: Record<string, unknown> = { status: "held", holder: ME };
    if (HOLD_VERSION === "if-match") body.version = seat.version;
    const saved = await api<Seat>(`/api/seats/${seat.id}`, "PATCH", body);
    box.update((b) => ({ ...applySeat(b, saved), notice: `Holding ${saved.row}${saved.num} for you.` }));
  } catch (e) {
    const cur = e instanceof HttpError && e.status === 409 ? (e.body?.current as Seat | undefined) : undefined;
    box.update((b) => ({ ...(cur ? applySeat(b, cur) : b), error: cur ? `${seat.row}${seat.num} was just taken by someone else.` : errText(e, "holding the seat") }));
  } finally {
    pend(seat.id, false);
  }
}

async function release(seat: Seat) {
  if (box.get().pending.includes(seat.id)) return;
  pend(seat.id, true);
  try {
    const saved = await api<Seat>(`/api/seats/${seat.id}`, "PATCH", { status: "available", holder: "", version: seat.version });
    box.update((b) => applySeat(b, saved));
  } catch (e) {
    box.update((b) => ({ ...b, error: errText(e, "releasing the seat") }));
  } finally {
    pend(seat.id, false);
  }
}

async function checkout() {
  const b0 = box.get();
  if (b0.paying || !b0.mine.length) return;
  box.update((b) => ({ ...b, paying: true, error: "" }));
  const ids = b0.mine.map((m) => m.id);
  const key = ORDER_KEY === "idempotency-key" ? `ord-${ids.join("-")}-${Date.now()}` : "";
  const send = () => api<{ id: number }>(`/api/orders`, "POST", { seats: ids, total: b0.total }, key ? { "Idempotency-Key": key } : {});
  try {
    const order = await send().catch((e) => (e instanceof HttpError && e.status >= 500 ? send() : Promise.reject(e)));
    const r = await api<{ results: { id: number; ok: boolean }[] }>(`/api/seats/bulk`, "POST", { ids, op: "patch", patch: { status: "sold", holder: ME } });
    const failed = r.results.filter((x) => !x.ok).length;
    box.update((b) => ({ ...b, mine: [], total: 0, notice: `Order #${order.id} confirmed for ${ids.length} seat(s).`, error: failed ? `${failed} seat(s) could not be marked sold; the box office will follow up.` : "" }));
    void loadMap();
  } catch (e) {
    box.update((b) => ({ ...b, error: errText(e, "the checkout") }));
  } finally {
    box.update((b) => ({ ...b, paying: false }));
  }
}

document.getElementById("app")!.innerHTML = `<div v-scope>
  <h1>Spring Gala · seat selection</h1>
  <nav class="sections"><button v-for="sec in ['Stalls', 'Circle']" :key="sec" :class="{ current: s.section === sec }" @click="pick(sec)">{{ sec }}</button></nav>
  <p role="alert" v-if="s.error">{{ s.error }}</p><p class="notice" v-else-if="s.notice">{{ s.notice }}</p>
  <div class="seatmap"><button v-for="seat in s.seats" :key="seat.id" type="button" :class="['seat', seat.holder === 'me' ? 'mine' : seat.status]" :disabled="seat.status !== 'available' || (guard && s.pending.includes(seat.id))" @click="hold(seat)">{{ seat.row }}{{ seat.num }}</button></div>
  <section class="basket"><h2>Your seats ({{ s.mine.length }}) · \${{ s.total }}</h2>
    <ul><li class="held" v-for="m in s.mine" :key="m.id">{{ m.section }} {{ m.row }}{{ m.num }} · \${{ m.price }} <button type="button" class="release" @click="release(m)">Release</button></li></ul>
    <button type="button" class="checkout" :disabled="!s.mine.length || s.paying" @click="checkout()">{{ s.paying ? 'Processing…' : 'Checkout' }}</button></section>
</div>`;
createApp({ s, guard: HOLD_GUARD, hold: (x: Seat) => void hold(x), release: (x: Seat) => void release(x), checkout: () => void checkout(), pick: (sec: string) => { box.update((b) => ({ ...b, section: sec, seats: [] })); void loadMap(); } }).mount();
void loadMap();
setInterval(() => void loadMap(true), 3000);
