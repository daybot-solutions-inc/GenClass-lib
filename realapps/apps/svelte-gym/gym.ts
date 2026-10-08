// Store + API for the gym class booking app (see App.svelte). A booking is two writes: the member's booking record
// (unique per class server-side) and the class's relative seat counter. Latent bugs by flag: book buttons that stay
// clickable while posting (bookGuard=none), the counter bumped before the booking record exists (order=count-first:
// a double click counts two seats, the second booking answers 409), day schedules applied in arrival order
// (dayLoad=blind) and a "my bookings" count kept by hand (myCount=manual).
import { rt, flag } from "../_shared/genclass";
import { atomStore } from "../_shared/svelte-atom";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

export type GymClass = { id: number; name: string; day: string; time: string; capacity: number; booked: number; coach: string };
export type Booking = { id: number; classId: number; name: string; day: string; time: string };
export const BOOK_GUARD = flag("bookGuard", "disable") === "disable";
const ORDER = flag("order", "booking-first");
const DAY_LOAD = flag("dayLoad", "latest");
const MY_COUNT = flag("myCount", "derive");
const POLL_MS = Number(flag("pollMs", 5000));

const atom = rt.atom("gym", { day: "Mon", classes: [] as GymClass[], mine: [] as Booking[], count: 0, pending: [] as number[], loading: true, error: "", notice: "" });
export const gym = atomStore(atom);
type S = ReturnType<typeof atom.get>;
const withMine = (s: S, mine: Booking[], delta: number): S => ({ ...s, mine, count: MY_COUNT === "derive" ? mine.length : s.count + delta });
const pend = (id: number, on: boolean) => atom.update((s) => ({ ...s, pending: on ? [...s.pending, id] : s.pending.filter((x) => x !== id) }));
const setClass = (c: GymClass) => atom.update((s) => ({ ...s, classes: s.classes.map((x) => (x.id === c.id ? c : x)) }));

let daySeq = 0;
export async function loadDay(day: string, background = false) {
  const seq = ++daySeq;
  if (!background) atom.update((s) => ({ ...s, day, loading: true, error: "" }));
  try {
    const classes = itemsOf<GymClass>(await api(`/api/classes?day=${day}&limit=40`));
    if (DAY_LOAD === "latest" && (seq !== daySeq || atom.get().day !== day)) return;
    atom.update((s) => ({ ...s, classes, loading: false }));
  } catch (e) {
    if (seq === daySeq) atom.update((s) => ({ ...s, loading: false, error: background ? s.error : errText(e, "loading the timetable") }));
  }
}

export async function loadMine() {
  try {
    const mine = itemsOf<Booking>(await api(`/api/bookings?limit=50`));
    atom.update((s) => ({ ...s, mine, count: mine.length }));
  } catch (e) {
    atom.update((s) => ({ ...s, error: errText(e, "loading your bookings") }));
  }
}

export async function book(c: GymClass) {
  const s0 = atom.get();
  if (BOOK_GUARD && s0.pending.includes(c.id)) return;
  if (s0.mine.some((b) => b.classId === c.id)) return atom.update((s) => ({ ...s, notice: `You're already in ${c.name}.` }));
  pend(c.id, true);
  atom.update((s) => ({ ...s, error: "", notice: "" }));
  try {
    let rec: Booking;
    if (ORDER === "count-first") {
      setClass(await api<GymClass>(`/api/classes/${c.id}/book`, "POST"));
      rec = await api<Booking>(`/api/bookings`, "POST", { classId: c.id, name: c.name, day: c.day, time: c.time });
    } else {
      rec = await api<Booking>(`/api/bookings`, "POST", { classId: c.id, name: c.name, day: c.day, time: c.time });
      setClass(await api<GymClass>(`/api/classes/${c.id}/book`, "POST"));
    }
    atom.update((s) => ({ ...withMine(s, [...s.mine, rec], 1), notice: `Booked ${c.name} on ${c.day} at ${c.time}.` }));
  } catch (e) {
    atom.update((s) => ({ ...s, error: e instanceof HttpError && e.status === 409 ? `You already have a spot in ${c.name}.` : errText(e, "the booking") }));
  } finally {
    pend(c.id, false);
  }
}

export async function cancel(b: Booking) {
  if (atom.get().pending.includes(b.classId)) return;
  pend(b.classId, true);
  try {
    await api(`/api/bookings/${b.id}`, "DELETE");
    atom.update((s) => ({ ...withMine(s, s.mine.filter((x) => x.id !== b.id), -1), notice: `Cancelled ${b.name}.` }));
    const c = await api<GymClass>(`/api/classes/${b.classId}/unbook`, "POST");
    if (atom.get().classes.some((x) => x.id === c.id)) setClass(c);
  } catch (e) {
    atom.update((s) => ({ ...s, error: errText(e, "the cancellation") }));
  } finally {
    pend(b.classId, false);
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
export function start() {
  void loadDay("Mon");
  void loadMine();
  timer = setInterval(() => void loadDay(atom.get().day, true), POLL_MS);
}
export const stop = () => clearInterval(timer);
