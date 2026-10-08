// Clinic appointment booking (Vue 3 templates + ofetch; state in runtime atoms bridged into Vue). Slots are unique on
// the server (a clash answers 409), so a slot taken by another patient between "choose" and "book" offers the
// waitlist instead. ofetch handles JSON, query strings, retries and an onResponseError hook that raises a "busy"
// banner. Latent bugs by flag: retry configured on the shared ofetch instance (retryPolicy=global: POSTs are retried
// too, and ofetch's default retry codes include 409 — a booking that committed before a 5xx comes back as "slot
// taken", and a real clash is hammered three times), "Book" not locked while booking (bookLock=false: the second
// click hits the unique constraint and reports a clash for the user's own booking), availability not reloaded after
// a booking, clash or cancellation (slotRefresh=never), clinician/day switches without aborting the previous lookup
// (scheduleGuard=none: an older answer paints the wrong day's slots).
import { createApp, defineComponent, computed } from "vue";
import { ofetch, FetchError } from "ofetch";
import { rt, flag } from "../_shared/genclass";
import { useAtom } from "../_shared/vue-atom";

type Appt = { id: number; slotKey: string; clinician: string; day: string; time: string; patient: string; reason: string; account: string };

const RETRY_POLICY = flag("retryPolicy", "get-only") as "get-only" | "global";
const BOOK_LOCK = Boolean(flag("bookLock", true));
const SLOT_REFRESH = flag("slotRefresh", "after-change") as "after-change" | "never";
const SCHEDULE_GUARD = flag("scheduleGuard", "abort") as "abort" | "none";

const ACCOUNT = "lind-household";
const CLINICIANS: [string, string][] = [
  ["osei", "Dr. Amara Osei (GP)"],
  ["brandt", "Lucas Brandt (physio)"],
  ["sousa", "Nurse Inês Sousa (vaccinations)"],
];
const DAYS: [string, string][] = [
  ["2026-04-06", "Mon 6 Apr"],
  ["2026-04-07", "Tue 7 Apr"],
  ["2026-04-08", "Wed 8 Apr"],
];
const SLOTS = ["09:00", "09:20", "09:40", "10:00", "10:20", "10:40", "11:00", "11:20", "11:40"];
const REASONS = ["Check-up", "Follow-up", "Prescription review", "Vaccination", "Back pain"];
const label = (list: [string, string][], k: string) => list.find(([x]) => x === k)?.[1] ?? k;
const keyOf = (clinician: string, day: string, time: string) => `${clinician}|${day}|${time}`;

const schedule = rt.atom("schedule", { clinician: "osei", day: DAYS[0]![0], booked: [] as string[], loading: false, error: "" });
const booking = rt.atom("booking", { slot: "", patient: "", reason: REASONS[0]!, status: "idle", notice: "", error: "", waitlistOffer: false });
const visits = rt.atom("visits", { items: [] as Appt[], error: "" });
const banner = rt.atom("banner", { text: "" });

const api = ofetch.create({
  baseURL: "/api",
  ...(RETRY_POLICY === "global" ? { retry: 2, retryDelay: 400 } : {}),
  onResponseError({ response }) {
    if (response.status >= 500 || response.status === 429) banner.set({ text: "The booking system is busy. Some actions may take a moment." });
  },
  onResponse({ response }) {
    if (response.ok && banner.get().text) banner.set({ text: "" });
  },
});
const reads = RETRY_POLICY === "get-only" ? { retry: 2, retryDelay: 400 } : {};

// ---------------------------------------------------------------------------------------- availability
let lookup: AbortController | null = null;
let lookupSeq = 0;
async function loadSchedule() {
  const { clinician, day } = schedule.get();
  if (SCHEDULE_GUARD === "abort") lookup?.abort();
  const ctl = new AbortController();
  lookup = ctl;
  const seq = ++lookupSeq;
  schedule.update((s) => ({ ...s, loading: true, error: "" }));
  try {
    const body = await api<{ data: Appt[] }>("/appointments", { query: { clinician, day, limit: 50 }, signal: SCHEDULE_GUARD === "abort" ? ctl.signal : undefined, ...reads });
    const booked = (body.data ?? []).map((a) => a.time);
    schedule.update((s) => ({ ...s, booked, loading: SCHEDULE_GUARD === "abort" ? false : seq !== lookupSeq, error: "" }));
  } catch (e) {
    if ((e as Error).name === "AbortError" || (e as FetchError).cause?.name === "AbortError" || ctl.signal.aborted) return;
    schedule.update((s) => ({ ...s, loading: false, error: "Availability couldn't be loaded." }));
  }
}

function pick(field: "clinician" | "day", v: string) {
  schedule.update((s) => ({ ...s, [field]: v }));
  booking.update((b) => ({ ...b, slot: "", notice: "", error: "", waitlistOffer: false }));
  void loadSchedule();
}

function choose(time: string) {
  booking.update((b) => ({ ...b, slot: time, notice: "", error: "", waitlistOffer: false }));
}

// --------------------------------------------------------------------------------------------- booking
async function book() {
  const b = booking.get();
  const { clinician, day } = schedule.get();
  const patient = b.patient.trim();
  if (!b.slot) return;
  if (!patient) return booking.update((x) => ({ ...x, error: "Enter the patient's name." }));
  if (BOOK_LOCK && b.status === "booking") return;
  booking.update((x) => ({ ...x, status: "booking", notice: "", error: "", waitlistOffer: false }));
  const time = b.slot;
  try {
    const appt = await api<Appt>("/appointments", { method: "POST", body: { slotKey: keyOf(clinician, day, time), clinician, day, time, patient, reason: b.reason, account: ACCOUNT } });
    visits.update((v) => (v.items.some((a) => a.id === appt.id) ? v : { ...v, items: [...v.items, appt] }));
    booking.update((x) => ({ ...x, status: "idle", slot: "", patient: "", notice: `Booked ${label(DAYS, day)} at ${time} with ${label(CLINICIANS, clinician)} for ${patient}.` }));
    schedule.update((s) => (s.clinician === clinician && s.day === day && !s.booked.includes(time) ? { ...s, booked: [...s.booked, time] } : s));
  } catch (e) {
    const status = (e as FetchError).status ?? (e as FetchError).statusCode;
    if (status === 409) booking.update((x) => ({ ...x, status: "idle", error: `${time} was just taken by another patient.`, waitlistOffer: true }));
    else booking.update((x) => ({ ...x, status: "idle", error: "The booking didn't go through. Please try again." }));
  }
  if (SLOT_REFRESH === "after-change") void loadSchedule();
}

async function joinWaitlist() {
  const b = booking.get();
  const { clinician, day } = schedule.get();
  const patient = b.patient.trim();
  if (!patient) return;
  booking.update((x) => ({ ...x, waitlistOffer: false, error: "" }));
  try {
    await api("/waitlist", { method: "POST", body: { clinician, day, patient, account: ACCOUNT } });
    booking.update((x) => ({ ...x, slot: "", notice: `${patient} is on the waitlist for ${label(DAYS, day)}. We'll text if a slot opens.` }));
  } catch {
    booking.update((x) => ({ ...x, error: "Couldn't join the waitlist." }));
  }
}

async function cancel(a: Appt) {
  visits.update((v) => ({ ...v, items: v.items.filter((x) => x.id !== a.id), error: "" }));
  try {
    await api(`/appointments/${a.id}`, { method: "DELETE" });
    if (SLOT_REFRESH === "after-change" && schedule.get().clinician === a.clinician && schedule.get().day === a.day) void loadSchedule();
  } catch {
    visits.update((v) => ({ ...v, items: v.items.some((x) => x.id === a.id) ? v.items : [...v.items, a], error: `Couldn't cancel the ${a.time} appointment.` }));
  }
}

async function loadVisits() {
  try {
    const body = await api<{ data: Appt[] }>("/appointments", { query: { account: ACCOUNT, limit: 50 }, ...reads });
    visits.update((v) => ({ ...v, items: body.data ?? [] }));
  } catch {
    visits.update((v) => ({ ...v, error: "Your appointments couldn't be loaded." }));
  }
}

// ---------------------------------------------------------------------------------------------------- UI
const App = defineComponent({
  setup() {
    const sch = useAtom(schedule);
    const bk = useAtom(booking);
    const mine = useAtom(visits);
    const bn = useAtom(banner);
    const isBooked = (t: string) => sch.value.booked.includes(t);
    const free = computed(() => SLOTS.filter((t) => !sch.value.booked.includes(t)).length);
    return {
      sch, bk, mine, bn, isBooked, free, SLOTS, CLINICIANS, DAYS, REASONS, LOCK: BOOK_LOCK,
      who: computed(() => label(CLINICIANS, sch.value.clinician)),
      when: computed(() => label(DAYS, sch.value.day)),
      dayOf: (d: string) => label(DAYS, d),
      nameOf: (c: string) => label(CLINICIANS, c),
      pick, choose, book, joinWaitlist, cancel,
      setPatient: (v: string) => booking.update((b) => ({ ...b, patient: v })),
      setReason: (v: string) => booking.update((b) => ({ ...b, reason: v })),
    };
  },
  template: `
    <div class="clinic">
      <header><h1>Riverside Health · Book a visit</h1></header>
      <p v-if="bn.text" class="banner">{{ bn.text }}</p>
      <section class="pick">
        <label>Clinician <select name="clinician" aria-label="Clinician" :value="sch.clinician" @change="pick('clinician', $event.target.value)"><option v-for="c in CLINICIANS" :key="c[0]" :value="c[0]">{{ c[1] }}</option></select></label>
        <label>Day <select name="day" aria-label="Day" :value="sch.day" @change="pick('day', $event.target.value)"><option v-for="d in DAYS" :key="d[0]" :value="d[0]">{{ d[1] }}</option></select></label>
      </section>
      <p class="free">{{ sch.loading ? "Checking availability…" : free + " of " + SLOTS.length + " slots free" }}</p>
      <p v-if="sch.error" role="alert">{{ sch.error }}</p>
      <div class="slots"><button v-for="t in SLOTS" :key="t" class="slot" :class="{ chosen: bk.slot === t }" :disabled="isBooked(t)" @click="choose(t)">{{ t }}{{ isBooked(t) ? " booked" : "" }}</button></div>
      <form v-if="bk.slot" class="booking" @submit.prevent="book">
        <p class="summary">{{ who }} · {{ when }} at {{ bk.slot }}</p>
        <label>Patient name <input name="patient" :value="bk.patient" @input="setPatient($event.target.value)" autocomplete="off"></label>
        <label>Reason <select name="reason" aria-label="Reason" :value="bk.reason" @change="setReason($event.target.value)"><option v-for="r in REASONS" :key="r" :value="r">{{ r }}</option></select></label>
        <button class="book" type="submit" :disabled="LOCK && bk.status === 'booking'">{{ bk.status === "booking" ? "Booking…" : "Book appointment" }}</button>
      </form>
      <p v-if="bk.notice" class="notice">{{ bk.notice }}</p>
      <p v-if="bk.error" role="alert">{{ bk.error }}</p>
      <button v-if="bk.waitlistOffer" class="waitlist" @click="joinWaitlist">Join the waitlist for {{ when }}</button>
      <section class="mine">
        <h2>Your appointments</h2>
        <p v-if="!mine.items.length" class="none">No upcoming appointments.</p>
        <ul><li v-for="a in mine.items" :key="a.id" class="visit">{{ dayOf(a.day) }} {{ a.time }} · {{ nameOf(a.clinician) }} · {{ a.patient }} ({{ a.reason }}) <button class="cancel" @click="cancel(a)">Cancel</button></li></ul>
        <p v-if="mine.error" role="alert">{{ mine.error }}</p>
      </section>
    </div>`,
});

createApp(App).mount("#app");
void loadSchedule();
void loadVisits();
