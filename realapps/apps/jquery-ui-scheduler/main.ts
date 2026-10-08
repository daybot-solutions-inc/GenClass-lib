// Weekly shift scheduler for a pharmacy's front-of-house team (jQuery 3, DOM built with jQuery; schedule kept in
// runtime atoms and re-rendered on change; $.ajax over XHR). Shifts move a day left/right, two employees can swap
// shifts (two PATCHes) and the grid polls for other managers' edits. Latent bugs by flag: moves sent as relative
// POST /next|/prev (moveWrite=relative: a retried or doubled request moves the shift twice), move buttons without an
// in-flight guard (moveGuard=none), swaps sent in parallel or in sequence without compensating when the second write
// fails (swap=parallel|sequential: one employee ends up with both shifts, the other with none) and weekly hours kept
// by +/- bookkeeping (hours=incremental: partial swaps, failed writes and other managers' edits leave wrong totals).
import $ from "jquery";
import { rt, flag } from "../_shared/genclass";

type Shift = { id: number; employeeId: number; day: number; start: string; end: string; hours: number };
type Employee = { id: number; name: string; maxHours: number };

const MOVE_WRITE = flag("moveWrite", "absolute") as "absolute" | "relative";
const MOVE_GUARD = flag("moveGuard", "pending") as "pending" | "none";
const SWAP = flag("swap", "sequential-rollback") as "sequential-rollback" | "parallel" | "sequential";
const HOURS = flag("hours", "derived") as "derived" | "incremental";
const POLL_MS = Number(flag("pollMs", 6000));
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

const hoursOf = (shifts: Shift[]) => {
  const h: Record<string, number> = {};
  for (const s of shifts) h[s.employeeId] = (h[s.employeeId] ?? 0) + s.hours;
  return h;
};
const schedule = rt.atom("schedule", { employees: [] as Employee[], shifts: [] as Shift[], hours: {} as Record<string, number>, pending: [] as number[], loading: true, error: "", notice: "" });
const swap = rt.atom("swap", { shiftId: 0, withId: 0, busy: false });

type S = ReturnType<typeof schedule.get>;
/** Replace shifts; derived mode recomputes the weekly hours, incremental mode applies `dh` (employee -> delta). */
function withShifts(s: S, shifts: Shift[], dh: Record<string, number> = {}): S {
  if (HOURS === "derived") return { ...s, shifts, hours: hoursOf(shifts) };
  const hours = { ...s.hours };
  for (const [e, d] of Object.entries(dh)) hours[e] = (hours[e] ?? 0) + d;
  return { ...s, shifts, hours };
}
const replaceShift = (list: Shift[], next: Shift) => list.map((x) => (x.id === next.id ? next : x));
const setPending = (id: number, on: boolean) => schedule.update((s) => ({ ...s, pending: on ? [...s.pending, id] : s.pending.filter((x) => x !== id) }));
const ajax = <T>(url: string, type = "GET", body?: unknown) =>
  $.ajax({ url, type, dataType: "json", ...(body === undefined ? {} : { contentType: "application/json", data: JSON.stringify(body) }), timeout: 8000 }) as unknown as Promise<T>;
const statusOf = (x: unknown) => (x as { status?: number })?.status ?? 0;

// ------------------------------------------------------------------------------------------------ data
let loading = false;
async function load(initial = false) {
  if (loading) return; // a slow poll is still running
  loading = true;
  try {
    const shifts = await ajax<Shift[]>("/api/shifts?limit=100");
    schedule.update((s) => {
      // rows with a write in flight keep their local version
      const merged = shifts.map((x) => (s.pending.includes(x.id) ? s.shifts.find((y) => y.id === x.id) ?? x : x));
      const next = { ...s, shifts: merged, loading: false, error: initial ? "" : s.error };
      return HOURS === "derived" || initial ? { ...next, hours: hoursOf(merged) } : next;
    });
  } catch {
    if (initial) schedule.update((s) => ({ ...s, loading: false, error: "The schedule could not be loaded." }));
  } finally {
    loading = false;
  }
}

function conflictFor(employeeId: number, day: number, except: number[] = []) {
  return schedule.get().shifts.find((x) => x.employeeId === employeeId && x.day === day && !except.includes(x.id));
}
const nameOf = (id: number) => schedule.get().employees.find((e) => e.id === id)?.name ?? `#${id}`;

async function move(id: number, dir: 1 | -1) {
  const s0 = schedule.get();
  const sh = s0.shifts.find((x) => x.id === id);
  if (!sh) return;
  if (MOVE_GUARD === "pending" && s0.pending.includes(id)) return;
  const day = sh.day + dir;
  if (day < 0 || day > 4) return;
  if (conflictFor(sh.employeeId, day, [id])) {
    schedule.update((s) => ({ ...s, notice: `${nameOf(sh.employeeId)} already works ${DAYS[day]}.` }));
    return;
  }
  setPending(id, true);
  schedule.update((s) => ({ ...withShifts(s, replaceShift(s.shifts, { ...sh, day })), error: "", notice: "" }));
  try {
    const saved = MOVE_WRITE === "relative" ? await ajax<Shift>(`/api/shifts/${id}/${dir > 0 ? "next" : "prev"}`, "POST", {}) : await ajax<Shift>(`/api/shifts/${id}`, "PATCH", { day });
    schedule.update((s) => withShifts(s, replaceShift(s.shifts, saved)));
  } catch {
    schedule.update((s) => ({ ...withShifts(s, replaceShift(s.shifts, sh)), error: `The ${DAYS[sh.day]} shift of ${nameOf(sh.employeeId)} could not be moved.` }));
  } finally {
    setPending(id, false);
  }
}

async function confirmSwap() {
  const sw = swap.get();
  const s0 = schedule.get();
  const a = s0.shifts.find((x) => x.id === sw.shiftId);
  const b = s0.shifts.find((x) => x.id === sw.withId);
  if (!a || !b || sw.busy || a.employeeId === b.employeeId) return;
  swap.update((x) => ({ ...x, busy: true }));
  [a.id, b.id].forEach((id) => setPending(id, true));
  const a2 = { ...a, employeeId: b.employeeId };
  const b2 = { ...b, employeeId: a.employeeId };
  const dh = { [a.employeeId]: b.hours - a.hours, [b.employeeId]: a.hours - b.hours };
  schedule.update((s) => ({ ...withShifts(s, replaceShift(replaceShift(s.shifts, a2), b2), dh), error: "", notice: "" }));
  const put = (sh: Shift, employeeId: number) => ajax<Shift>(`/api/shifts/${sh.id}`, "PATCH", { employeeId });
  const fail = (msg: string, shifts: (s: S) => Shift[]) => schedule.update((s) => ({ ...withShifts(s, shifts(s)), error: msg }));
  try {
    if (SWAP === "parallel") {
      const [ra, rb] = await Promise.allSettled([put(a, b.employeeId), put(b, a.employeeId)]);
      if (ra.status === "rejected" || rb.status === "rejected") {
        fail("The swap was only partly saved. Please check both shifts.", (s) => replaceShift(replaceShift(s.shifts, ra.status === "fulfilled" ? ra.value : a), rb.status === "fulfilled" ? rb.value : b));
      } else schedule.update((s) => withShifts(s, replaceShift(replaceShift(s.shifts, ra.value), rb.value)));
    } else {
      let savedA: Shift;
      try {
        savedA = await put(a, b.employeeId);
      } catch {
        fail("The swap could not be saved.", (s) => replaceShift(replaceShift(s.shifts, a), b));
        return;
      }
      try {
        const savedB = await put(b, a.employeeId);
        schedule.update((s) => withShifts(s, replaceShift(replaceShift(s.shifts, savedA), savedB)));
      } catch {
        if (SWAP === "sequential-rollback") {
          // put the first shift back so nobody is double-booked
          const back = await put(a, a.employeeId).catch(() => null);
          fail(back ? "The swap could not be saved; nothing was changed." : "The swap failed half-way. Reloading the schedule.", (s) => replaceShift(replaceShift(s.shifts, back ?? savedA), b));
          if (!back) void load();
        } else fail("The swap was only partly saved. Please check both shifts.", (s) => replaceShift(replaceShift(s.shifts, savedA), b));
      }
    }
  } finally {
    [a.id, b.id].forEach((id) => setPending(id, false));
    swap.set({ shiftId: 0, withId: 0, busy: false });
  }
}

async function addShift(employeeId: number, day: number) {
  if (conflictFor(employeeId, day)) {
    schedule.update((s) => ({ ...s, notice: `${nameOf(employeeId)} already works ${DAYS[day]}.` }));
    return;
  }
  try {
    const created = await ajax<Shift>("/api/shifts", "POST", { employeeId, day, start: "09:00", end: "17:00", hours: 8 });
    schedule.update((s) => ({ ...withShifts(s, [...s.shifts, created], { [employeeId]: created.hours }), notice: `Added a ${DAYS[day]} shift for ${nameOf(employeeId)}.` }));
  } catch (x) {
    schedule.update((s) => ({ ...s, error: statusOf(x) === 422 ? "Pick an employee and a day." : "The shift could not be added." }));
  }
}

async function removeShift(id: number) {
  const sh = schedule.get().shifts.find((x) => x.id === id);
  if (!sh) return;
  schedule.update((s) => withShifts(s, s.shifts.filter((x) => x.id !== id), { [sh.employeeId]: -sh.hours }));
  try {
    await ajax(`/api/shifts/${id}`, "DELETE");
  } catch {
    schedule.update((s) => ({ ...withShifts(s, [...s.shifts, sh], { [sh.employeeId]: sh.hours }), error: "The shift could not be removed." }));
  }
}

// ---------------------------------------------------------------------------------------------- render
$("#app").html(`
  <header><h1>Front-of-house rota</h1><p>Week of 6 April · <span class="pending-note"></span></p></header>
  <div class="msgs"></div>
  <table class="rota"><thead><tr><th>Team member</th>${DAYS.map((d) => `<th>${d}</th>`).join("")}</tr></thead><tbody></tbody></table>
  <div class="swap-slot"></div>
  <form class="add-form"><select name="emp"></select> <select name="day">${DAYS.map((d, i) => `<option value="${i}">${d}</option>`).join("")}</select> <button type="submit" class="add-shift">Add shift</button></form>`);

function renderGrid() {
  const s = schedule.get();
  const $tb = $("table.rota tbody").empty();
  if (s.loading) return $tb.append($("<tr>").append($("<td>").attr("colspan", 6).text("Loading rota…")));
  for (const e of s.employees) {
    const h = s.hours[e.id] ?? 0;
    const $tr = $("<tr>").addClass("emp").attr("data-emp", e.id).append($("<th>").text(`${e.name} — ${h}h / ${e.maxHours}h`).toggleClass("over", h > e.maxHours));
    DAYS.forEach((_, d) => {
      const $td = $("<td>");
      for (const sh of s.shifts.filter((x) => x.employeeId === e.id && x.day === d)) {
        const busy = s.pending.includes(sh.id);
        const $chip = $("<div>").addClass("shift").attr("data-id", sh.id).toggleClass("saving", busy);
        $chip.append($("<span>").text(`${sh.start}–${sh.end}`));
        $chip.append($("<button type='button'>").addClass("prev").text("◀").prop("disabled", d === 0 || (MOVE_GUARD === "pending" && busy)));
        $chip.append($("<button type='button'>").addClass("next").text("▶").prop("disabled", d === 4 || (MOVE_GUARD === "pending" && busy)));
        $chip.append($("<button type='button'>").addClass("swap").text("Swap"), $("<button type='button'>").addClass("remove").text("×"));
        $td.append($chip);
      }
      $tr.append($td);
    });
    $tb.append($tr);
  }
  $(".pending-note").text(s.pending.length ? "Saving…" : "All changes saved");
  $(".msgs").empty();
  if (s.error) $(".msgs").append($("<p role='alert'>").text(s.error));
  else if (s.notice) $(".msgs").append($("<p class='notice'>").text(s.notice));
  if (!$("select[name=emp] option").length && s.employees.length) $("select[name=emp]").html(s.employees.map((e) => `<option value="${e.id}">${e.name}</option>`).join(""));
}

function renderSwap() {
  const sw = swap.get();
  const s = schedule.get();
  const a = s.shifts.find((x) => x.id === sw.shiftId);
  const $slot = $(".swap-slot").empty();
  if (!a) return;
  const others = s.shifts.filter((x) => x.day === a.day && x.employeeId !== a.employeeId);
  const $panel = $("<div class='swap-panel'>").append($("<h2>").text(`Swap ${nameOf(a.employeeId)}'s ${DAYS[a.day]} shift`));
  if (!others.length) $panel.append($("<p>").text(`Nobody else works ${DAYS[a.day]}.`));
  else {
    const $sel = $("<select name='with'>").append(others.map((o) => $("<option>").val(String(o.id)).text(`${nameOf(o.employeeId)} · ${o.start}–${o.end}`)));
    $sel.val(String(sw.withId || others[0]!.id));
    $panel.append($sel, $("<button type='button' class='confirm-swap'>").text(sw.busy ? "Swapping…" : "Confirm swap").prop("disabled", sw.busy));
  }
  $panel.append($("<button type='button' class='cancel-swap'>").text("Cancel"));
  $slot.append($panel);
}

schedule.subscribe(() => {
  renderGrid();
  renderSwap();
});
swap.subscribe(renderSwap);

$("table.rota").on("click", "button", function () {
  const id = Number($(this).closest(".shift").data("id"));
  if ($(this).hasClass("next")) void move(id, 1);
  else if ($(this).hasClass("prev")) void move(id, -1);
  else if ($(this).hasClass("remove")) void removeShift(id);
  else if ($(this).hasClass("swap") && !swap.get().busy) {
    const a = schedule.get().shifts.find((x) => x.id === id)!;
    const first = schedule.get().shifts.find((x) => x.day === a.day && x.employeeId !== a.employeeId);
    swap.set({ shiftId: id, withId: first?.id ?? 0, busy: false });
  }
});
$(".swap-slot")
  .on("change", "select[name=with]", function () {
    swap.update((x) => ({ ...x, withId: Number($(this).val()) }));
  })
  .on("click", "button.confirm-swap", () => void confirmSwap())
  .on("click", "button.cancel-swap", () => swap.set({ shiftId: 0, withId: 0, busy: false }));
$(".add-form").on("submit", (e) => {
  e.preventDefault();
  void addShift(Number($("select[name=emp]").val()), Number($("select[name=day]").val()));
});

$(async () => {
  try {
    const employees = await ajax<Employee[]>("/api/employees");
    schedule.update((s) => ({ ...s, employees }));
  } catch {
    schedule.update((s) => ({ ...s, error: "The team list could not be loaded." }));
  }
  await load(true);
  setInterval(() => void load(), POLL_MS);
});
