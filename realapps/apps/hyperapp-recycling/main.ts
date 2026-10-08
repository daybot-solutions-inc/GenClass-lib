// City bulky-waste pickup booking for residents (Hyperapp 2 actions/effects/subscriptions; state registered via
// hyperappGuard; fetch). A three-step form, each step opening once the previous one is done: tick what needs collecting
// → choose a collection date (this week or next; only dates with places left: ?left__gt=0, refreshed while the
// resident looks) → confirm (POST /bookings with an
// Idempotency-Key per attempt, retried once after a 5xx or a network error, then POST /dates/:id/take; when the
// answer shows the date was already full the place is given back and the resident picks again). Booked pickups are
// listed with their status (the depot assigns crews; refreshed every few seconds) and can be cancelled (DELETE + POST
// /dates/:id/giveback). Other residents book all the time. Latent bugs by
// flag: the booking retried without an Idempotency-Key (confirmKey=none: a booking stored before a 5xx is made twice),
// the Confirm button live while posting (confirmGuard=none: a double click books and takes a place twice), date lists
// applied in arrival order (datesSeq=blind: switching weeks quickly shows the other week's dates), cancellations
// removed from the list before the server answers and never restored (cancel=optimistic-no-rollback) and places
// counted down locally instead of from the server's answer (capacity=local: a date that filled up meanwhile is
// overbooked without noticing).
import { app, h, text } from "hyperapp";
import { flag } from "../_shared/genclass";
import { hyperappGuard } from "../_shared/hyperapp-guard";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type DateRow = { id: number; week: string; day: string; left: number; capacity: number };
type Booking = { id: number; resident: string; dateId: number; day: string; items: string[]; status: string };
type S = { items: string[]; week: string; dates: DateRow[]; datesLoading: boolean; chosen: DateRow | null; bookings: Booking[]; confirming: boolean; cancelling: number[]; key: string; error: string; notice: string };
const CONFIRM_KEY = flag("confirmKey", "idempotency-key");
const CONFIRM_GUARD = flag("confirmGuard", "pending") === "pending";
const DATES_SEQ = flag("datesSeq", "latest");
const CANCEL = flag("cancel", "pessimistic");
const CAPACITY = flag("capacity", "server");
const ME = "you";
const ITEMS = ["Sofa or armchair", "Mattress", "Fridge or freezer", "Washing machine", "Wardrobe", "Bed frame", "Garden waste bags"];

const init: S = { items: [], week: "this", dates: [], datesLoading: false, chosen: null, bookings: [], confirming: false, cancelling: [], key: "", error: "", notice: "" };
const { middleware, store } = hyperappGuard<S>("pickup", init);
const withLeft = (s: S, id: number, delta: number) => s.dates.map((d) => (d.id === id ? { ...d, left: d.left + delta } : d));
const withDate = (s: S, row: DateRow) => s.dates.map((d) => (d.id === row.id ? row : d));

// ------------------------------------------------------------------------------------------- effects
let seq = 0;
function loadDates(week: string, background: boolean) {
  const my = background ? seq : ++seq;
  if (!background) store.update((s) => (s.datesLoading ? s : { ...s, datesLoading: true }));
  api(`/api/dates?week=${week}&left__gt=0&limit=20`)
    .then((body) =>
      store.update((s) => {
        if (DATES_SEQ === "latest" && (my !== seq || s.week !== week)) return s;
        return { ...s, dates: itemsOf<DateRow>(body), datesLoading: !background && my === seq ? false : s.datesLoading };
      }),
    )
    .catch((e) => store.update((s) => (background || my !== seq ? s : { ...s, datesLoading: false, error: errText(e, "loading collection dates") })));
}
const datesFx = (week: string, background: boolean) => [() => loadDates(week, background), null];

// the resident's pickups (the depot assigns crews during the day); not while a cancellation is on its way
let bookingsBusy = false;
let bookingWrites = 0;
const bookingsFx = [
  () => {
    if (bookingsBusy) return;
    bookingsBusy = true;
    const epoch = bookingWrites;
    api(`/api/bookings?resident=${ME}&limit=20`)
      .then((body) => store.update((s) => (s.cancelling.length || s.confirming || epoch !== bookingWrites ? s : { ...s, bookings: itemsOf<Booking>(body) })))
      .catch(() => undefined)
      .finally(() => (bookingsBusy = false));
  },
  null,
];

const confirmFx = (s0: S) => [
  async () => {
    const d = s0.chosen!;
    const headers: Record<string, string> = CONFIRM_KEY === "idempotency-key" ? { "Idempotency-Key": s0.key } : {};
    const post = () => api<Booking>(`/api/bookings`, "POST", { resident: ME, dateId: d.id, day: d.day, items: s0.items, status: "scheduled" }, headers);
    try {
      const b = await post().catch((e) => (!(e instanceof HttpError) || e.status >= 500 ? post() : Promise.reject(e)));
      const taken = await api<DateRow>(`/api/dates/${d.id}/take`, "POST");
      if (CAPACITY === "server" && taken.left < 0) {
        // someone took the last place first: give it back and let the resident choose again
        await api(`/api/bookings/${b.id}`, "DELETE").catch(() => undefined);
        await api(`/api/dates/${d.id}/giveback`, "POST").catch(() => undefined);
        store.update((s) => ({ ...s, confirming: false, chosen: null, error: `${d.day} just filled up. Please choose another date.` }));
        loadDates(store.get().week, false);
        return;
      }
      bookingWrites++;
      store.update((s) => ({
        ...s,
        confirming: false,
        items: [],
        chosen: null,
        bookings: [...s.bookings.filter((x) => x.id !== b.id), b],
        dates: CAPACITY === "server" ? withDate(s, taken) : s.dates,
        notice: `Booked: ${s0.items.join(", ")} on ${d.day}. Put them out by 7am.`,
      }));
    } catch (e) {
      store.update((s) => ({ ...s, confirming: false, error: errText(e, "booking your pickup") }));
    }
  },
  null,
];

const cancelFx = (b: Booking) => [
  () => {
    api(`/api/bookings/${b.id}`, "DELETE")
      .then(() => {
        bookingWrites++;
        store.update((s) => ({ ...s, bookings: s.bookings.filter((x) => x.id !== b.id), cancelling: s.cancelling.filter((x) => x !== b.id), notice: `Your ${b.day} pickup is cancelled.` }));
        return api<DateRow>(`/api/dates/${b.dateId}/giveback`, "POST")
          .then((d) => store.update((s) => ({ ...s, dates: CAPACITY === "server" ? withDate(s, d) : withLeft(s, b.dateId, 1) })))
          .catch(() => undefined);
      })
      .catch((e) => store.update((s) => ({ ...s, cancelling: s.cancelling.filter((x) => x !== b.id), error: errText(e, `cancelling the ${b.day} pickup`) })));
  },
  null,
];

// ------------------------------------------------------------------------------------------- actions
let keyN = 0;
const Toggle = (s: S, item: string) => {
  const items = s.items.includes(item) ? s.items.filter((x) => x !== item) : [...s.items, item];
  if (!items.length) return { ...s, items, chosen: null };
  // the first item opens step 2: load the collection days
  return s.items.length ? { ...s, items } : [{ ...s, items, datesLoading: true, error: "", notice: "" }, datesFx(s.week, false)];
};
const Week = (s: S, week: string) => [{ ...s, week, chosen: null, datesLoading: true, error: "" }, datesFx(week, false)];
const Choose = (s: S, d: DateRow) => ({ ...s, chosen: d, key: `pickup-${++keyN}`, error: "", notice: "" });
const Confirm = (s: S) => {
  if (!s.chosen || !s.items.length || (CONFIRM_GUARD && s.confirming)) return s;
  return [{ ...s, confirming: true, error: "", notice: "", dates: CAPACITY === "local" ? withLeft(s, s.chosen.id, -1) : s.dates }, confirmFx(s)];
};
const Cancel = (s: S, b: Booking) => {
  if (s.cancelling.includes(b.id)) return s;
  const next = CANCEL === "pessimistic" ? { ...s, cancelling: [...s.cancelling, b.id], error: "", notice: "" } : { ...s, bookings: s.bookings.filter((x) => x.id !== b.id), error: "", notice: "" };
  return [next, cancelFx(b)];
};
const Poll = (s: S) => (s.items.length && !s.datesLoading ? [s, datesFx(s.week, true)] : s);
const PollBookings = (s: S) => [s, bookingsFx];
// one subscriber function for every interval, so Hyperapp keeps a running interval across state changes
const intervalSub = (dispatch: (a: unknown) => void, p: { ms: number; action: unknown }) => {
  const iv = setInterval(() => dispatch(p.action), p.ms);
  return () => clearInterval(iv);
};
const every = (ms: number, action: unknown) => [intervalSub, { ms, action }];

// ------------------------------------------------------------------------------------------- view
const view = (s: S) =>
  h("main", { class: "pickup" }, [
    h("h1", {}, text("Book a bulky waste pickup")),
    h("p", { class: "muted" }, text("Up to five large items per household, collected from the kerb from 7am.")),
    s.error ? h("p", { role: "alert" }, text(s.error)) : s.notice ? h("p", { class: "notice" }, text(s.notice)) : text(""),
    h("section", { class: "items" }, [
      h("h2", {}, text("1. What needs collecting?")),
      h("ul", {}, ITEMS.map((it) => h("li", { class: "item" }, [h("label", {}, [h("input", { type: "checkbox", checked: s.items.includes(it), onchange: [Toggle, it] }), text(` ${it}`)])]))),
    ]),
    s.items.length
      ? h("section", { class: "dates" }, [
          h("h2", {}, text("2. Choose a collection day")),
          h("nav", { class: "weeks" }, [["this", "This week"], ["next", "Next week"]].map(([w, l]) => h("button", { type: "button", class: s.week === w ? "current" : "", onclick: [Week, w] }, text(l!)))),
          s.datesLoading ? h("p", { class: "muted" }, text("Loading days…")) : !s.dates.length ? h("p", { class: "muted" }, text("No free days left this week.")) : text(""),
          h("ul", {}, s.dates.map((d) => h("li", { class: s.chosen?.id === d.id ? "date chosen" : "date", key: d.id }, [text(`${d.day} · ${d.left} left `), h("button", { type: "button", class: "choose", onclick: [Choose, d] }, text("Choose"))]))),
        ])
      : text(""),
    s.items.length && s.chosen
      ? h("section", { class: "confirm" }, [
          h("h2", {}, text("3. Check and confirm")),
          h("p", {}, text(`${s.items.join(", ")} on ${s.chosen.day} (${s.week === "this" ? "this week" : "next week"}).`)),
          h("button", { type: "button", class: "confirm", disabled: CONFIRM_GUARD && s.confirming, onclick: Confirm }, text(s.confirming ? "Booking…" : "Confirm booking")),
        ])
      : text(""),
    h("aside", { class: "mine" }, [
      h("h2", {}, text("Your pickups")),
      s.bookings.length
        ? h("ul", {}, s.bookings.map((b) => h("li", { class: "booking", key: b.id }, [text(`${b.day} · ${b.items.join(", ")} · ${b.status === "crew assigned" ? "crew assigned" : "scheduled"} `), h("button", { type: "button", class: "cancel", disabled: s.cancelling.includes(b.id), onclick: [Cancel, b] }, text("Cancel"))])))
        : h("p", { class: "muted" }, text("None booked yet.")),
    ]),
  ]);

app<S>({
  init: [init, bookingsFx],
  view,
  node: document.getElementById("app")!,
  subscriptions: () => [every(5000, Poll), every(8000, PollBookings)],
  dispatch: middleware,
} as never);
