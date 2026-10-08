// Moving-company quote and booking wizard (Preact 10 + XState v5 machine run with createActor; fetch). A parallel
// machine: the quote region follows the inventory (+/- per room; every change re-quotes after a short debounce: POST
// /quotes stores the estimate for that inventory) while the flow region walks the wizard: moving dates (GET
// /dates?left__gt=0) → holding (POST /holds, then POST /dates/:id/take takes one crew slot; a slot that went negative
// is given back) → held (a 20 s countdown in the machine; running out or going back releases the date: DELETE
// /holds/:id + POST /dates/:id/give) → booking (POST /bookings, retried once after a 5xx) → confirmed. The inventory
// stays editable until booking. The machine context is mirrored into a GenClass atom on every transition and Preact
// renders it through a signal. Latent bugs by flag: quotes spawned per change and never cancelled (quote=spawn-leak:
// a slow answer for the previous inventory lands after the current one and the wizard shows and books a stale
// price), holds that expire only on screen (holdExpiry=leak: the server keeps the hold and the crew slot, so that
// date can never be held again), bookings retried without an Idempotency-Key (bookKey=none: a booking that committed
// before its 5xx is stored twice), a Book button the machine still accepts while booking (bookGuard=none) and the
// calendar fetched once per session (dates=once: dates other customers filled meanwhile are still offered).
import { render } from "preact";
import { assign, createActor, fromCallback, fromPromise, setup, spawnChild } from "xstate";
import { rt, flag } from "../_shared/genclass";
import { atomSignal } from "../_shared/preact-atom";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Rooms = Record<string, number>;
type Quote = { id: number; cubicFeet: number; crew: number; hours: number; total: number };
type MoveDate = { id: number; date: string; label: string; crew: string; left: number };
type Hold = { id: number; dateId: number; slot: string };
type Booking = { id: number; label: string; total: number };
interface Ctx {
  rooms: Rooms;
  quote: Quote | null;
  quoting: boolean;
  dates: MoveDate[];
  date: MoveDate | null;
  hold: Hold | null;
  holdLeft: number;
  bookKey: string;
  booking: Booking | null;
  /** booking or booked: the inventory can no longer change */
  locked: boolean;
  error: string;
  notice: string;
}
type Ev =
  | { type: "ROOM"; room: string; delta: number }
  | { type: "QUOTED"; quote: Quote }
  | { type: "QUOTE_FAILED"; error: string }
  | { type: "NEXT" }
  | { type: "BACK" }
  | { type: "PICK"; date: MoveDate }
  | { type: "TICK" }
  | { type: "BOOK" }
  | { type: "NEW" };

const QUOTE = flag("quote", "invoke-cancel");
const HOLD_EXPIRY = flag("holdExpiry", "release");
const BOOK_KEY = flag("bookKey", "idempotency-key");
const BOOK_GUARD = flag("bookGuard", "state");
const DATES = flag("dates", "refetch-on-enter");
const HOLD_S = 20;
const ROOMS: [string, string, number][] = [
  ["bedroom", "Bedrooms", 160],
  ["living", "Living rooms", 200],
  ["dining", "Dining rooms", 120],
  ["kitchen", "Kitchens", 100],
  ["office", "Home offices", 90],
  ["garage", "Garage bays", 180],
];
const DEFAULT_ROOMS: Rooms = { bedroom: 2, living: 1, dining: 0, kitchen: 1, office: 0, garage: 0 };

const volumeOf = (r: Rooms) => ROOMS.reduce((s, [k, , cf]) => s + (r[k] ?? 0) * cf, 0);
function estimate(rooms: Rooms) {
  const cubicFeet = volumeOf(rooms);
  const crew = cubicFeet >= 900 ? 4 : cubicFeet >= 500 ? 3 : 2;
  const hours = Math.ceil(cubicFeet / (crew * 60)) + 1;
  return { cubicFeet, crew, hours, total: hours * crew * 58 + 180 };
}
const postQuote = (rooms: Rooms, signal?: AbortSignal) => api<Quote>(`/api/quotes`, "POST", { rooms, ...estimate(rooms) }, {}, signal);
const fresh = (): Ctx => ({ rooms: { ...DEFAULT_ROOMS }, quote: null, quoting: true, dates: [], date: null, hold: null, holdLeft: 0, bookKey: "", booking: null, locked: false, error: "", notice: "" });

class DateFull extends Error {}
async function placeHold(d: MoveDate, quoteId: number): Promise<{ hold: Hold; date: MoveDate }> {
  const hold = await api<Hold>(`/api/holds`, "POST", { dateId: d.id, date: d.date, slot: `you@${d.id}`, customer: "you", quoteId });
  try {
    const date = await api<MoveDate>(`/api/dates/${d.id}/take`, "POST");
    if (date.left < 0) {
      await api(`/api/dates/${d.id}/give`, "POST").catch(() => undefined);
      throw new DateFull();
    }
    return { hold, date };
  } catch (e) {
    await api(`/api/holds/${hold.id}`, "DELETE").catch(() => undefined);
    throw e;
  }
}
const releaseHold = (hold: Hold) =>
  void api(`/api/holds/${hold.id}`, "DELETE")
    .then(() => api(`/api/dates/${hold.dateId}/give`, "POST"))
    .catch(() => undefined);
function holdError(e: unknown, d: MoveDate): string {
  if (e instanceof DateFull) return `${d.label} just filled up — pick another date.`;
  if (e instanceof HttpError && e.status === 409) return `You already have a hold on ${d.label}.`;
  return errText(e, `holding ${d.label}`);
}

/** An inventory change (re)starts the quote debounce; a quote request in flight is left behind. */
const roomEdit = {
  target: "debounce",
  reenter: true,
  guard: ({ context, event }: { context: Ctx; event: Extract<Ev, { type: "ROOM" }> }) => !context.locked && (context.rooms[event.room] ?? 0) + event.delta >= 0 && (context.rooms[event.room] ?? 0) + event.delta <= 9,
  actions: assign(({ context, event }: { context: Ctx; event: Extract<Ev, { type: "ROOM" }> }) => ({ rooms: { ...context.rooms, [event.room]: (context.rooms[event.room] ?? 0) + event.delta }, quoting: true, error: "", notice: "" })),
} as const;

const machine = setup({
  types: { context: {} as Ctx, events: {} as Ev },
  actors: {
    quote: fromPromise(({ input, signal }: { input: Rooms; signal: AbortSignal }) => postQuote(input, signal)),
    // fire-and-forget quote request: reports back to the machine whenever it lands
    quoteTask: fromCallback<Ev, Rooms>(({ sendBack, input }) => {
      postQuote(input).then(
        (quote) => sendBack({ type: "QUOTED", quote }),
        (e) => sendBack({ type: "QUOTE_FAILED", error: errText(e, "updating the quote") }),
      );
    }),
    loadDates: fromPromise(async () => itemsOf<MoveDate>(await api(`/api/dates?left__gt=0&sort=date&limit=12`))),
    hold: fromPromise(({ input }: { input: { date: MoveDate; quoteId: number } }) => placeHold(input.date, input.quoteId)),
    ticker: fromCallback(({ sendBack }) => {
      const iv = setInterval(() => sendBack({ type: "TICK" }), 1000);
      return () => clearInterval(iv);
    }),
    book: fromPromise(async ({ input }: { input: Ctx }) => {
      const body = { holdId: input.hold!.id, quoteId: input.quote!.id, dateId: input.date!.id, date: input.date!.date, cubicFeet: input.quote!.cubicFeet, total: input.quote!.total, customer: "you" };
      const post = () => api<{ id: number }>(`/api/bookings`, "POST", body, input.bookKey ? { "Idempotency-Key": input.bookKey } : {});
      return post().catch((e) => (e instanceof HttpError && e.status > 0 && e.status < 500 ? Promise.reject(e) : post()));
    }),
  },
  actions: {
    release: ({ context }) => {
      if (context.hold) releaseHold(context.hold);
    },
    expire: ({ context }) => {
      if (HOLD_EXPIRY === "release" && context.hold) releaseHold(context.hold);
    },
  },
}).createMachine({
  id: "move",
  type: "parallel",
  context: fresh(),
  states: {
    // the estimate follows the inventory in its own region, whatever step the customer is on
    quote: {
      initial: "quoting",
      states: {
        idle: { on: { ROOM: roomEdit } },
        debounce: { after: { 500: "quoting" }, on: { ROOM: roomEdit } },
        // a quote that could not be saved is tried again after a while (still pending meanwhile)
        failed: { after: { 3000: "quoting" }, on: { ROOM: roomEdit } },
        quoting:
          QUOTE === "invoke-cancel"
            ? {
                on: { ROOM: roomEdit },
                invoke: {
                  src: "quote",
                  input: ({ context }: { context: Ctx }) => context.rooms,
                  onDone: { target: "idle", actions: assign(({ event }) => ({ quote: event.output as Quote, quoting: false, error: "" })) },
                  onError: { target: "failed", actions: assign(({ event }) => ({ error: errText(event.error, "updating the quote") })) },
                },
              }
            : {
                entry: spawnChild("quoteTask", { input: ({ context }: { context: Ctx }) => context.rooms }),
                on: {
                  ROOM: roomEdit,
                  QUOTED: { target: "idle", actions: assign(({ event }) => ({ quote: event.quote, quoting: false, error: "" })) },
                  QUOTE_FAILED: { target: "failed", actions: assign(({ event }) => ({ error: event.error })) },
                },
              },
      },
      on: {
        // a quote that lands late (only spawned requests can) still replaces the shown one
        QUOTED: { actions: assign(({ event }) => ({ quote: event.quote })) },
      },
    },
    flow: {
      initial: "start",
      states: {
        start: { on: { NEXT: { target: "dates", guard: ({ context }) => !context.quoting && !!context.quote } } },
        dates: {
          initial: "check",
          states: {
            check: { always: [{ guard: ({ context }) => DATES === "once" && context.dates.length > 0, target: "ready" }, { target: "loading" }] },
            loading: {
              invoke: {
                src: "loadDates",
                onDone: { target: "ready", actions: assign(({ event }) => ({ dates: event.output })) },
                onError: { target: "ready", actions: assign(({ event }) => ({ error: errText(event.error, "loading moving dates") })) },
              },
            },
            // an empty calendar (or a failed load) is checked again after a while
            ready: { after: { 6000: { guard: ({ context }) => context.dates.length === 0, target: "loading" } } },
          },
          on: {
            PICK: { target: "holding", guard: ({ context }) => !!context.quote, actions: assign(({ event }) => ({ date: event.date, error: "", notice: "" })) },
            BACK: { target: "start" },
          },
        },
        holding: {
          invoke: {
            src: "hold",
            input: ({ context }) => ({ date: context.date!, quoteId: context.quote!.id }),
            onDone: {
              target: "held",
              actions: assign(({ context, event }) => ({
                hold: event.output.hold,
                date: event.output.date,
                dates: context.dates.map((d) => (d.id === event.output.date.id ? event.output.date : d)),
                holdLeft: HOLD_S,
                bookKey: BOOK_KEY === "idempotency-key" ? `booking-${event.output.hold.id}` : "",
              })),
            },
            onError: { target: "dates", actions: assign(({ context, event }) => ({ date: null, error: holdError(event.error, context.date!) })) },
          },
        },
        held: {
          invoke: { src: "ticker" },
          on: {
            TICK: [
              { guard: ({ context }) => context.holdLeft <= 1, target: "dates", actions: ["expire", assign(({ context }) => ({ notice: `Your hold on ${context.date!.label} ran out.`, hold: null, date: null, holdLeft: 0 }))] },
              { actions: assign(({ context }) => ({ holdLeft: context.holdLeft - 1 })) },
            ],
            BOOK: { target: "booking", guard: ({ context }) => !context.quoting && !!context.quote, actions: assign({ error: "", locked: true }) },
            BACK: { target: "dates", actions: ["release", assign({ hold: null, date: null, holdLeft: 0 })] },
          },
        },
        booking: {
          invoke: {
            src: "book",
            input: ({ context }) => context,
            onDone: { target: "confirmed", actions: assign(({ context, event }) => ({ booking: { id: event.output.id, label: context.date!.label, total: context.quote!.total }, hold: null })) },
            onError: { target: "held", actions: assign(({ event }) => ({ locked: false, error: errText(event.error, "booking your move") })) },
          },
          on: BOOK_GUARD === "none" ? { BOOK: { target: "booking", reenter: true } } : {},
        },
        confirmed: {},
      },
    },
  },
  on: {
    NEW: { guard: ({ context }) => !!context.booking, target: [".quote.quoting", ".flow.start"], actions: assign(({ context }) => ({ ...fresh(), dates: context.dates })) },
  },
});

const stepOf = (v: unknown): string => (typeof v === "string" ? v : Object.keys(v as object)[0]!);
const actor = createActor(machine);
const move = rt.atom("move", { step: "start", ...actor.getSnapshot().context, loadingDates: false, busy: false });
actor.subscribe((s) => {
  const step = stepOf((s.value as { flow: unknown }).flow);
  move.set({ step, ...s.context, loadingDates: s.matches({ flow: { dates: "loading" } }), busy: ["holding", "booking"].includes(step) });
});
actor.start();
const moveSig = atomSignal(move);

// ------------------------------------------------------------------------------------------- view
const STEPS: [string, string[]][] = [
  ["Inventory", ["start"]],
  ["Date", ["dates", "holding"]],
  ["Book", ["held", "booking"]],
  ["Done", ["confirmed"]],
];
function Wizard() {
  const m = moveSig.value;
  const send = (e: Ev) => actor.send(e);
  const q = m.quote;
  return (
    <main className="moving">
      <h1>Plan your move</h1>
      <ol className="steps">
        {STEPS.map(([label, states]) => (
          <li key={label} className={states.includes(m.step) ? "current" : ""}>
            {label}
          </li>
        ))}
      </ol>
      {m.error ? <p role="alert">{m.error}</p> : m.notice ? <p className="notice">{m.notice}</p> : null}
      <section className="inventory">
        <h2>What are we moving?</h2>
        <ul className="rooms">
          {ROOMS.map(([k, label]) => (
            <li key={k} className="room">
              <span className="label">{label}</span>{" "}
              <button type="button" className="dec" disabled={m.locked || !m.rooms[k]} onClick={() => send({ type: "ROOM", room: k, delta: -1 })}>
                −
              </button>{" "}
              <span className="count">{m.rooms[k] ?? 0}</span>{" "}
              <button type="button" className="inc" disabled={m.locked || (m.rooms[k] ?? 0) >= 9} onClick={() => send({ type: "ROOM", room: k, delta: 1 })}>
                +
              </button>
            </li>
          ))}
        </ul>
        <p className="quote">{m.quoting ? "Updating your quote…" : q ? `${q.cubicFeet} cu ft · ${q.crew} movers · about ${q.hours} h · $${q.total}` : "No quote yet."}</p>
      </section>
      {m.step === "dates" ? (
        <section className="dates">
          <h2>Pick a moving date</h2>
          {m.loadingDates ? <p className="muted">Checking the calendar…</p> : null}
          {!m.loadingDates && m.dates.length === 0 ? <p className="muted">No dates open right now.</p> : null}
          {!m.loadingDates ? (
            <ul className="dates">
              {m.dates.map((d) => (
                <li key={d.id} className="date">
                  {d.label} · crew {d.crew} · {Math.max(0, d.left)} open{" "}
                  <button type="button" className="hold" disabled={d.left <= 0} onClick={() => send({ type: "PICK", date: d })}>
                    Hold this date
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      {m.step === "holding" ? <p className="muted">Holding {m.date?.label}…</p> : null}
      {(m.step === "held" || m.step === "booking") && m.date && q ? (
        <section className="held">
          <h2>
            {m.date.label} with crew {m.date.crew}
          </h2>
          <p className="countdown">Held for you — {m.holdLeft} s left to book.</p>
          <button type="button" className="book" disabled={m.quoting || (m.step === "booking" && BOOK_GUARD === "state")} onClick={() => send({ type: "BOOK" })}>
            {m.step === "booking" ? "Booking…" : `Book for $${q.total}`}
          </button>
        </section>
      ) : null}
      {m.step === "confirmed" && m.booking ? (
        <section className="done">
          <p>
            Booking #{m.booking.id} confirmed for {m.booking.label} — ${m.booking.total}.
          </p>
        </section>
      ) : null}
      <footer>
        {m.step === "dates" || m.step === "held" ? (
          <button type="button" className="back" onClick={() => send({ type: "BACK" })}>
            Back
          </button>
        ) : null}{" "}
        {m.step === "start" ? (
          <button type="button" className="primary to-dates" disabled={m.quoting || !q} onClick={() => send({ type: "NEXT" })}>
            See moving dates
          </button>
        ) : null}
        {m.step === "confirmed" ? (
          <button type="button" className="primary again" onClick={() => send({ type: "NEW" })}>
            Plan another move
          </button>
        ) : null}
      </footer>
    </main>
  );
}

render(<Wizard />, document.getElementById("app")!);
