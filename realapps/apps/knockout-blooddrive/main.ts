// Blood donation drive booking for donors (Knockout 3 view model; a pureComputed snapshot is registered with rt.guard;
// fetch). The donor picks one of the spring community drives, answers three eligibility questions (Continue), then
// books a chair in one of the drive's open time slots: POST /appointments (one per donor and drive: the server's
// unique `key`) followed by POST /slots/:id/book (relative: other donors book and cancel all the time). Booked
// appointments can be cancelled (DELETE + POST /slots/:id/unbook). Only slots with chairs left are listed
// (booked__lt=capacity) and the list polls while the donor is choosing. Latent bugs by flag: a failed second booking
// step leaves the appointment behind (steps=dangling: the slot never counts the donor and every later booking at that
// drive answers 409), Book buttons live while a booking posts (bookGuard=none: a double click races two bookings),
// polls that overwrite slots with a booking or cancellation in flight or answered meanwhile (poll=blind: the chair
// count jumps back), slot lists applied in arrival order when the donor switches drives quickly (slotSeq=blind: the
// previous drive's times are shown under the new drive) and the "chairs open" figure adjusted by hand on each booking
// instead of recounted from the slots (remaining=incremental: other donors' bookings never show).
import ko from "knockout";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Slot = { id: number; drive: number; time: string; nurse: string; capacity: number; booked: number };
type Appt = { id: number; donor: string; slotId: number; drive: number; time: string; nurse: string; key: string };
const STEPS = flag("steps", "rollback");
const BOOK_GUARD = flag("bookGuard", "pending") === "pending";
const POLL = flag("poll", "pending-aware");
const SLOT_SEQ = flag("slotSeq", "latest");
const REMAINING = flag("remaining", "derive");
const CAP = 4;
const ME = "you";
const DRIVES = [
  { id: 41, name: "Riverside Library", day: "Sat 11 Apr" },
  { id: 42, name: "City Hall Atrium", day: "Sun 12 Apr" },
  { id: 43, name: "Northgate Mall", day: "Mon 13 Apr" },
];
const QUESTIONS = ["I weigh at least 50 kg", "I feel well and have eaten today", "No tattoos or piercings in the last four months"];

const vm = {
  driveId: ko.observable(""),
  step: ko.observable<"eligibility" | "slots">("eligibility"),
  questions: QUESTIONS.map((text) => ({ text, ok: ko.observable(false) })),
  slots: ko.observableArray<Slot>([]),
  mine: ko.observableArray<Appt>([]),
  manualRemaining: ko.observable(0),
  loading: ko.observable(false),
  booking: ko.observable(false),
  cancelling: ko.observableArray<number>([]),
  error: ko.observable(""),
  notice: ko.observable(""),
};
const chairsLeft = (ss: Slot[]) => ss.reduce((a, s) => a + Math.max(0, s.capacity - s.booked), 0);
const remaining = ko.pureComputed(() => (REMAINING === "derive" ? chairsLeft(vm.slots()) : vm.manualRemaining()));
const canContinue = ko.pureComputed(() => vm.questions.every((q) => q.ok()));
const driveOf = (id: number | string) => DRIVES.find((d) => String(d.id) === String(id));
const driveLabel = (id: number | string) => `${driveOf(id)?.name ?? "?"} · ${driveOf(id)?.day ?? ""}`;
const mineAt = (drive: number | string) => vm.mine().some((a) => String(a.drive) === String(drive));
const byTime = (a: Slot, b: Slot) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0);

const snapshot = ko.pureComputed(() => ({
  driveId: vm.driveId(),
  step: vm.step(),
  answers: vm.questions.map((q) => q.ok()),
  slots: vm.slots().map((s) => ({ id: s.id, drive: s.drive, time: s.time, nurse: s.nurse, capacity: s.capacity, booked: s.booked })),
  remaining: remaining(),
  mine: vm.mine().map((a) => ({ id: a.id, slotId: a.slotId, drive: a.drive, time: a.time })),
  loading: vm.loading(),
  booking: vm.booking(),
  cancelling: vm.cancelling().length > 0,
  error: vm.error(),
  notice: vm.notice(),
}));
rt.guard("donor", {
  get: () => snapshot.peek(),
  set: (v: any) => {
    vm.error(v.error ?? "");
    vm.notice(v.notice ?? "");
  },
  subscribe: (fn) => {
    const sub = snapshot.subscribe(() => fn());
    return () => sub.dispose();
  },
});

/** A slot the server just answered with: kept (in time order) while it has chairs left, dropped once full. */
function applySlot(x: Slot) {
  if (String(x.drive) !== vm.driveId()) return;
  const rest = vm.slots().filter((s) => s.id !== x.id);
  vm.slots((x.booked < x.capacity ? [...rest, x] : rest).sort(byTime));
}

let seq = 0;
let writes = 0;
async function loadSlots(background = false) {
  const drive = vm.driveId();
  if (!drive) return;
  const my = background ? seq : ++seq;
  const epoch = writes;
  if (!background) vm.loading(true);
  try {
    const body = await api(`/api/slots?drive=${drive}&booked__lt=${CAP}&sort=time&limit=20`);
    if (SLOT_SEQ === "latest" && (my !== seq || drive !== vm.driveId())) return;
    // a booking or cancellation answered after this poll left carries newer counts than the poll
    if (background && POLL === "pending-aware" && (vm.booking() || vm.cancelling().length > 0 || epoch !== writes)) return;
    const items = itemsOf<Slot>(body).sort(byTime);
    vm.slots(items);
    if (!background) vm.manualRemaining(chairsLeft(items));
  } catch (e) {
    if (!background && my === seq) vm.error(errText(e, "loading open times"));
  } finally {
    if (!background && my === seq) vm.loading(false);
  }
}

async function loadMine() {
  try {
    vm.mine(itemsOf<Appt>(await api(`/api/appointments?donor=${ME}&limit=20`)));
  } catch {
    /* keep what we show */
  }
}

async function book(s: Slot) {
  if (BOOK_GUARD && vm.booking()) return;
  if (mineAt(s.drive)) return;
  const d = driveOf(s.drive)!;
  vm.booking(true);
  vm.error("");
  vm.notice("");
  writes++;
  let appt: Appt | null = null;
  try {
    appt = await api<Appt>(`/api/appointments`, "POST", { donor: ME, slotId: s.id, drive: s.drive, time: s.time, nurse: s.nurse, key: `${ME}@${s.drive}` });
    const saved = await api<Slot>(`/api/slots/${s.id}/book`, "POST");
    applySlot(saved);
    const a = appt;
    vm.mine([...vm.mine().filter((x) => x.id !== a.id), a]);
    if (REMAINING === "incremental") vm.manualRemaining(vm.manualRemaining() - 1);
    vm.notice(`You're booked at ${d.name} (${d.day}) at ${s.time} with ${s.nurse}.`);
  } catch (e) {
    if (appt && STEPS === "rollback") await api(`/api/appointments/${appt.id}`, "DELETE").catch(() => undefined);
    if (e instanceof HttpError && e.status === 409) {
      vm.error(`You already have an appointment at ${d.name}.`);
      void loadMine();
    } else vm.error(errText(e, `booking ${s.time} at ${d.name}`));
  } finally {
    writes++;
    vm.booking(false);
  }
}

async function cancel(a: Appt) {
  if (vm.cancelling().includes(a.id)) return;
  vm.cancelling.push(a.id);
  vm.error("");
  vm.notice("");
  writes++;
  try {
    await api(`/api/appointments/${a.id}`, "DELETE");
    vm.mine(vm.mine().filter((x) => x.id !== a.id));
    const saved = await api<Slot>(`/api/slots/${a.slotId}/unbook`, "POST");
    applySlot(saved);
    if (REMAINING === "incremental" && String(a.drive) === vm.driveId()) vm.manualRemaining(vm.manualRemaining() + 1);
    vm.notice(`Your ${a.time} appointment at ${driveOf(a.drive)?.name} is cancelled.`);
  } catch (e) {
    vm.error(errText(e, `cancelling your ${a.time} appointment`));
  } finally {
    writes++;
    vm.cancelling.remove(a.id);
  }
}

vm.driveId.subscribe(() => {
  vm.notice("");
  void loadSlots();
});

document.getElementById("app")!.innerHTML = `<h1>Give blood this spring</h1>
  <p class="lede">Book a 45-minute donation at one of our community drives. Walk-ins welcome while chairs last.</p>
  <div class="bar"><label>Drive <select name="drive" data-bind="value: driveId"><option value="">Choose a drive…</option>${DRIVES.map((d) => `<option value="${d.id}">${d.name} · ${d.day}</option>`).join("")}</select></label>
    <span class="open" data-bind="visible: driveId() && step() === 'slots', text: remaining() + ' chairs open at this drive'"></span>
    <span class="muted" data-bind="visible: loading">Loading times…</span></div>
  <p role="alert" data-bind="visible: error, text: error"></p><p class="notice" data-bind="visible: !error() && notice(), text: notice"></p>
  <section class="step eligibility" data-bind="visible: step() === 'eligibility'"><h2>Can you donate?</h2>
    <ul class="answers" data-bind="foreach: questions"><li class="answer"><label><input type="checkbox" data-bind="checked: ok"> <span data-bind="text: text"></span></label></li></ul>
    <button type="button" class="next" data-bind="enable: canContinue, click: goSlots">Continue</button></section>
  <section class="step slots" data-bind="visible: step() === 'slots'"><h2 data-bind="text: driveId() ? 'Open times · ' + driveLabel(driveId()) : 'Choose a drive above'"></h2>
    <p class="muted" data-bind="visible: driveId() && !loading() && !slots().length">No chairs left at this drive.</p>
    <ul class="slots" data-bind="foreach: slots"><li class="slot"><strong data-bind="text: time"></strong> · <span data-bind="text: nurse"></span> · <span data-bind="text: (capacity - booked) + ' chairs left'"></span>
      <!-- ko if: $root.mine().some((a) => a.slotId === id) --><em class="yours">your appointment</em><!-- /ko -->
      <button type="button" class="book" data-bind="visible: !$root.mineAt(drive), disable: $root.bookLocked, click: () => $root.book($data)">Book</button></li></ul></section>
  <section class="mine" data-bind="visible: mine().length"><h2>Your appointments</h2>
    <ul data-bind="foreach: mine"><li class="appt"><span data-bind="text: $root.driveLabel(drive) + ' · ' + time + ' with ' + nurse"></span>
      <button type="button" class="cancel" data-bind="disable: $root.cancelling().includes(id), click: () => $root.cancel($data)">Cancel</button></li></ul></section>`;

ko.applyBindings(
  {
    ...vm,
    remaining,
    canContinue,
    driveLabel,
    mineAt,
    bookLocked: ko.pureComputed(() => BOOK_GUARD && vm.booking()),
    goSlots: () => {
      vm.step("slots");
      if (!vm.slots().length) void loadSlots();
    },
    book: (s: Slot) => void book(s),
    cancel: (a: Appt) => void cancel(a),
  },
  document.getElementById("app"),
);
void loadMine();
setInterval(() => vm.step() === "slots" && vm.driveId() && !vm.loading() && void loadSlots(true), 4000);
