// Food bank volunteer shift sign-up (Knockout 3 view model, no state registered with GenClass: observe-only; fetch +
// WebSocket). Shifts show live fill counts as other volunteers join; signing up is two calls (POST /signups — one per
// shift — then POST /shifts/:id/join to bump the count), leaving undoes both. Latent bugs by flag: optimistic sign-ups
// (signup=optimistic-rollback) that are never rolled back when they fail (signup=optimistic: you look signed up),
// join buttons live while the sign-up posts (joinGuard=none: the second POST answers 409 or a second join), capacity
// checked against the possibly stale local count (capacity=client: full shifts get overbooked), pushes applied in
// arrival order (live=blind: an older count overwrites a newer one) and reconnects that don't reload (reconnect=naive).
import ko from "knockout";
import { flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError, liveTopic } from "../_shared/w3-http";

type Shift = { id: number; day: string; time: string; role: string; capacity: number; filled: number; updatedAt?: string };
type Signup = { id: number; shiftId: number };
const SIGNUP = flag("signup", "wait") as "wait" | "optimistic-rollback" | "optimistic";
const JOIN_GUARD = flag("joinGuard", "pending") === "pending";
const CAPACITY = flag("capacity", "server-check");
const LIVE = flag("live", "newer-wins");
const RECONNECT = flag("reconnect", "resync");
class Full extends Error {}

class ShiftVM {
  filled = ko.observable(0);
  mineId = ko.observable(0);
  busy = ko.observable(false);
  updatedAt = "";
  full = ko.pureComputed(() => this.filled() >= this.s.capacity);
  spots = ko.pureComputed(() => (this.full() ? "Full" : `${this.s.capacity - this.filled()} of ${this.s.capacity} spots left`));
  constructor(public s: Shift) {
    this.apply(s);
  }
  apply(x: Shift) {
    if (LIVE === "newer-wins" && x.updatedAt && this.updatedAt && x.updatedAt < this.updatedAt) return;
    this.filled(x.filled);
    if (x.updatedAt) this.updatedAt = x.updatedAt;
  }
}

const vm = {
  shifts: ko.observableArray<ShiftVM>([]),
  day: ko.observable("all"),
  role: ko.observable("all"),
  live: ko.observable(false),
  loading: ko.observable(true),
  error: ko.observable(""),
  notice: ko.observable(""),
};
const shown = ko.pureComputed(() => vm.shifts().filter((sh) => (vm.day() === "all" || sh.s.day === vm.day()) && (vm.role() === "all" || sh.s.role === vm.role())));
const mineCount = ko.pureComputed(() => vm.shifts().filter((sh) => sh.mineId() !== 0).length);
const find = (id: number) => vm.shifts().find((sh) => sh.s.id === id);

async function load() {
  try {
    const [shifts, mine] = await Promise.all([api(`/api/shifts?limit=40`).then((b) => itemsOf<Shift>(b)), api(`/api/signups?limit=40`).then((b) => itemsOf<Signup>(b))]);
    const known = new Map(vm.shifts().map((sh) => [sh.s.id, sh]));
    vm.shifts(
      shifts.map((s) => {
        const sh = known.get(s.id) ?? new ShiftVM(s);
        if (known.has(s.id) && !sh.busy()) sh.apply(s);
        const m = mine.find((x) => x.shiftId === s.id);
        if (!sh.busy()) sh.mineId(m ? m.id : 0);
        return sh;
      }),
    );
  } catch (e) {
    vm.error(errText(e, "loading shifts"));
  } finally {
    vm.loading(false);
  }
}

async function join(sh: ShiftVM) {
  if (JOIN_GUARD && sh.busy()) return;
  if (sh.mineId() > 0 || (SIGNUP !== "wait" && sh.mineId() < 0)) return;
  sh.busy(true);
  vm.error("");
  vm.notice("");
  let optimistic = false;
  try {
    if (CAPACITY === "server-check") {
      const fresh = await api<Shift>(`/api/shifts/${sh.s.id}`);
      sh.apply(fresh);
      if (fresh.filled >= fresh.capacity) throw new Full();
    } else if (sh.full()) throw new Full();
    if (SIGNUP !== "wait") {
      optimistic = true;
      sh.mineId(-1);
      sh.filled(sh.filled() + 1);
    }
    const signup = await api<Signup>(`/api/signups`, "POST", { shiftId: sh.s.id });
    sh.mineId(signup.id);
    const updated = await api<Shift>(`/api/shifts/${sh.s.id}/join`, "POST");
    sh.apply(updated);
    vm.notice(`You're on ${sh.s.day} ${sh.s.time} (${sh.s.role}). Thank you!`);
  } catch (e) {
    if (e instanceof Full) vm.error(`${sh.s.day} ${sh.s.time} ${sh.s.role} just filled up.`);
    else if (e instanceof HttpError && e.status === 409) vm.error(`You're already signed up for ${sh.s.day} ${sh.s.time}.`);
    else vm.error(errText(e, "signing up"));
    if (optimistic && SIGNUP === "optimistic-rollback" && sh.mineId() === -1) {
      sh.mineId(0);
      sh.filled(sh.filled() - 1);
    }
  } finally {
    sh.busy(false);
  }
}

async function leave(sh: ShiftVM) {
  if (JOIN_GUARD && sh.busy()) return;
  const id = sh.mineId();
  if (!id) return;
  sh.busy(true);
  vm.error("");
  vm.notice("");
  try {
    await api(`/api/signups/${id}`, "DELETE");
    sh.mineId(0);
    const updated = await api<Shift>(`/api/shifts/${sh.s.id}/leave`, "POST");
    sh.apply(updated);
    vm.notice(`You're off ${sh.s.day} ${sh.s.time}.`);
  } catch (e) {
    vm.error(errText(e, "cancelling the sign-up"));
  } finally {
    sh.busy(false);
  }
}

document.getElementById("app")!.innerHTML = `<h1>Volunteer shifts · Riverside Food Bank</h1>
  <p class="summary"><span data-bind="text: mineCount() === 1 ? 'You are signed up for 1 shift' : 'You are signed up for ' + mineCount() + ' shifts'"></span> · <span data-bind="text: live() ? 'live' : 'reconnecting…'"></span></p>
  <label>Day <select name="day" data-bind="value: day"><option value="all">Both days</option><option value="Sat">Saturday</option><option value="Sun">Sunday</option></select></label>
  <nav class="roles" data-bind="foreach: ['all', 'sorting', 'packing', 'driver', 'front desk']"><button type="button" data-bind="text: $data === 'all' ? 'All roles' : $data, css: { current: $root.role() === $data }, click: () => $root.role($data)"></button></nav>
  <p role="alert" data-bind="visible: error, text: error"></p><p class="notice" data-bind="visible: !error() && notice(), text: notice"></p>
  <p class="muted" data-bind="visible: loading">Loading shifts…</p>
  <ul class="shifts" data-bind="foreach: shown"><li class="shift" data-bind="css: { mine: mineId() !== 0, full: full() }">
    <strong data-bind="text: s.day + ' ' + s.time"></strong> · <span data-bind="text: s.role"></span> · <span data-bind="text: spots"></span>
    <!-- ko if: mineId() !== 0 --><em>You're in</em> <button type="button" class="leave" data-bind="click: $root.leave, disable: busy">Cancel</button><!-- /ko -->
    <!-- ko if: mineId() === 0 && !full() --><button type="button" class="join" data-bind="click: $root.join, disable: $root.guard && busy(), text: busy() ? 'Signing up…' : 'Sign up'"></button><!-- /ko -->
  </li></ul>`;
ko.applyBindings({ ...vm, shown, mineCount, guard: JOIN_GUARD, join: (sh: ShiftVM) => void join(sh), leave: (sh: ShiftVM) => void leave(sh) }, document.getElementById("app"));

let everUp = false;
liveTopic(
  "shifts",
  (m) => {
    if (m.type !== "updated" || !m.item) return;
    find(Number(m.id))?.apply(m.item as Shift);
  },
  (up) => {
    vm.live(up);
    if (up && everUp && RECONNECT === "resync") void load();
    if (up) everUp = true;
  },
);
void load();
