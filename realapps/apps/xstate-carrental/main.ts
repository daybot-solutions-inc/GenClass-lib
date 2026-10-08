// Car rental booking flow (XState v5 machine run with createActor, rendered with template strings; fetch). Pick a
// pickup location (available cars load), reserve one (a versioned PATCH holds it for you for 20 s — other customers
// hold and book cars too), choose cover and book (POST /bookings, retried once after a 5xx, then the car is marked
// booked; the list comes back for the next booking). Going back or letting the hold run out releases the car. The machine context is mirrored into a GenClass
// atom on every transition. Latent bugs by flag: availability fetched outside the machine (quote=effect: a slow answer
// for the previous location fills the list), holds never released (holdRelease=never: the car stays held for nobody),
// bookings retried without an Idempotency-Key (bookKey=none: one booking stored twice), a Book button the machine
// still accepts while booking (bookGuard=none) and the list kept when you come back (availability=stale: cars other
// customers took meanwhile are still offered).
import { assign, createActor, fromPromise, setup } from "xstate";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Car = { id: number; location: string; model: string; cls: string; dayRate: number; status: string; holder: string; version: number };
interface Ctx {
  location: string;
  cars: Car[];
  quoting: boolean;
  car: Car | null;
  insurance: string;
  total: number;
  bookKey: string;
  bookingId: number;
  error: string;
  notice: string;
}
type Ev =
  | { type: "LOCATION"; location: string }
  | { type: "CARS"; cars: Car[] }
  | { type: "RESERVE"; car: Car }
  | { type: "INSURANCE"; insurance: string }
  | { type: "BOOK" }
  | { type: "BACK" };
const QUOTE = flag("quote", "invoke");
const HOLD_RELEASE = flag("holdRelease", "on-exit");
const BOOK_KEY = flag("bookKey", "per-hold");
const BOOK_GUARD = flag("bookGuard", "state");
const AVAILABILITY = flag("availability", "refetch-on-back");
const DAYS = 3;
const COVER: Record<string, number> = { none: 0, basic: 9, full: 19 };
const totalOf = (car: Car | null, insurance: string) => (car ? (car.dayRate + COVER[insurance]!) * DAYS : 0);
const fetchCars = async (location: string) => itemsOf<Car>(await api(`/api/cars?location=${location}&status=available&limit=20`));
let keyN = 0;

const machine = setup({
  types: { context: {} as Ctx, events: {} as Ev },
  actors: {
    loadCars: fromPromise(({ input }: { input: string }) => fetchCars(input)),
    holdCar: fromPromise(({ input }: { input: Car }) => api<Car>(`/api/cars/${input.id}`, "PATCH", { status: "held", holder: "you", version: input.version })),
    book: fromPromise(async ({ input }: { input: Ctx }) => {
      const body = { carId: input.car!.id, model: input.car!.model, location: input.location, insurance: input.insurance, total: input.total, days: DAYS };
      const post = () => api<{ id: number }>(`/api/bookings`, "POST", body, input.bookKey ? { "Idempotency-Key": input.bookKey } : {});
      const b = await post().catch((e) => (e instanceof HttpError && e.status > 0 && e.status < 500 ? Promise.reject(e) : post()));
      await api<Car>(`/api/cars/${input.car!.id}`, "PATCH", { status: "booked", holder: "you" });
      return b;
    }),
  },
  actions: {
    fetchOutside: ({ context }) => void fetchCars(context.location).then((cars) => actor.send({ type: "CARS", cars }), () => actor.send({ type: "CARS", cars: [] })),
    releaseHold: ({ context }) => {
      if (HOLD_RELEASE === "on-exit" && context.car) void api(`/api/cars/${context.car.id}`, "PATCH", { status: "available", holder: "" }).catch(() => undefined);
    },
  },
}).createMachine({
  id: "rental",
  initial: "browsing",
  context: { location: "Airport", cars: [], quoting: true, car: null, insurance: "basic", total: 0, bookKey: "", bookingId: 0, error: "", notice: "" },
  states: {
    browsing: {
      initial: "decide",
      states: {
        decide: { always: [{ guard: ({ context }) => AVAILABILITY === "stale" && context.cars.length > 0 && context.cars[0]!.location === context.location, target: "ready" }, { target: "fetching" }] },
        fetching:
          QUOTE === "invoke"
            ? {
                entry: assign({ quoting: true }),
                invoke: {
                  src: "loadCars",
                  input: ({ context }) => context.location,
                  onDone: { target: "ready", actions: assign(({ event }) => ({ cars: event.output, quoting: false })) },
                  onError: { target: "ready", actions: assign(({ event }) => ({ quoting: false, error: errText(event.error, "loading cars") })) },
                },
              }
            : { entry: [assign({ quoting: true }), "fetchOutside"], on: { CARS: { target: "ready", actions: assign(({ event }) => ({ cars: event.cars, quoting: false })) } } },
        // an empty lot (or a failed load) is checked again after a while
        ready: { after: { 5000: { guard: ({ context }) => context.cars.length === 0, target: "fetching" } }, on: { CARS: { actions: assign(({ event }) => ({ cars: event.cars, quoting: false })) } } },
      },
      on: {
        LOCATION: { target: ".fetching", reenter: true, actions: assign(({ event }) => ({ location: event.location, error: "", notice: "" })) },
        RESERVE: { target: "holding", actions: assign(({ event }) => ({ car: event.car, error: "", notice: "" })) },
      },
    },
    holding: {
      invoke: {
        src: "holdCar",
        input: ({ context }) => context.car!,
        onDone: { target: "held", actions: assign(({ context, event }) => ({ car: event.output, total: totalOf(event.output, context.insurance), bookKey: BOOK_KEY === "per-hold" ? `book-${event.output.id}-${++keyN}` : "" })) },
        onError: {
          target: "browsing",
          actions: assign(({ context, event }) => {
            const cur = event.error instanceof HttpError && event.error.status === 409 ? (event.error.body?.current as Car | undefined) : undefined;
            return { car: null, cars: cur ? context.cars.filter((c) => c.id !== cur.id) : context.cars, error: cur ? `The ${context.car!.model} was just taken by someone else.` : errText(event.error, "holding the car") };
          }),
        },
      },
    },
    held: {
      after: { 20000: { target: "browsing", actions: ["releaseHold", assign({ car: null, notice: "Your hold expired — the car is back on the lot." })] } },
      on: {
        INSURANCE: { actions: assign(({ context, event }) => ({ insurance: event.insurance, total: totalOf(context.car, event.insurance) })) },
        BOOK: { target: "booking", actions: assign({ error: "" }) },
        BACK: { target: "browsing", actions: ["releaseHold", assign({ car: null })] },
      },
    },
    booking: {
      invoke: {
        src: "book",
        input: ({ context }) => context,
        onDone: { target: "browsing", actions: assign(({ context, event }) => ({ bookingId: event.output.id, notice: `Booking #${event.output.id} confirmed: ${context.car!.model} from ${context.location}, $${context.total}.`, car: null, insurance: "basic", total: 0 })) },
        onError: { target: "held", actions: assign(({ event }) => ({ error: errText(event.error, "booking the car") })) },
      },
      on: BOOK_GUARD === "none" ? { BOOK: { target: "booking", reenter: true } } : {},
    },
  },
});

const actor = createActor(machine);
const rental = rt.atom("rental", { step: "browsing", ...actor.getSnapshot().context, busy: false });
const stepOf = (v: unknown) => (typeof v === "string" ? v : Object.keys(v as object)[0]!);

// ------------------------------------------------------------------------------------------- DOM
const root = document.getElementById("app")!;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
function render() {
  const snap = actor.getSnapshot();
  const c = snap.context;
  const step = stepOf(snap.value);
  const msg = c.error ? `<p role="alert">${esc(c.error)}</p>` : c.notice ? `<p class="notice">${esc(c.notice)}</p>` : "";
  const browsing = step === "browsing";
  const list = `<label>Pick up at <select name="location"${browsing ? "" : " disabled"}>${["Airport", "Downtown", "Station"].map((l) => `<option${l === c.location ? " selected" : ""}>${l}</option>`).join("")}</select></label>
      <p class="summary">${c.quoting ? "Checking availability…" : `${c.cars.length} cars available for ${DAYS} days`}</p>
      <ul class="cars">${c.cars.map((car) => `<li class="car" data-id="${car.id}">${esc(car.model)} · ${car.cls} · $${car.dayRate}/day <button type="button" class="reserve"${browsing ? "" : " disabled"}>${c.car?.id === car.id ? (step === "holding" ? "Holding…" : "Held") : "Reserve"}</button></li>`).join("")}</ul>`;
  const held =
    step === "held" || step === "booking"
      ? `<section class="held"><h2>${esc(c.car!.model)} · ${esc(c.location)}</h2><p>Held for you — finish within 20 seconds.</p>
      <label>Cover <select name="insurance">${Object.keys(COVER).map((k) => `<option value="${k}"${k === c.insurance ? " selected" : ""}>${k} (+$${COVER[k]}/day)</option>`).join("")}</select></label>
      <p class="total">Total for ${DAYS} days: $${c.total}</p>
      <button type="button" class="back"${step === "booking" ? " disabled" : ""}>Back</button> <button type="button" class="book"${step === "booking" && BOOK_GUARD === "state" ? " disabled" : ""}>${step === "booking" ? "Booking…" : "Book now"}</button></section>`
      : "";
  const body = held + list;
  root.innerHTML = `<main class="rental"><h1>Rent a car</h1>${msg}${body}</main>`;
}
actor.subscribe((s) => {
  rental.set({ step: stepOf(s.value), ...s.context, busy: ["holding", "booking"].includes(stepOf(s.value)) });
  render();
});
root.addEventListener("change", (e) => {
  const t = e.target as HTMLSelectElement;
  if (t.name === "location") actor.send({ type: "LOCATION", location: t.value });
  else if (t.name === "insurance") actor.send({ type: "INSURANCE", insurance: t.value });
});
root.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (!(t instanceof HTMLButtonElement) || t.disabled) return;
  if (t.classList.contains("reserve")) {
    const car = actor.getSnapshot().context.cars.find((x) => x.id === Number(t.closest("li")!.dataset.id));
    if (car) actor.send({ type: "RESERVE", car });
  } else if (t.classList.contains("book")) actor.send({ type: "BOOK" });
  else if (t.classList.contains("back")) actor.send({ type: "BACK" });
});
actor.start();
render();
