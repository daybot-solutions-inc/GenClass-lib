// Habit tracker week grid (Hyperapp 2 actions/effects/subscriptions; state registered via hyperappGuard; fetch).
// Each cell toggles a check-in for one habit on one day: optimistic POST /checkins (a unique key per habit/day, so a
// second device's check-in answers 409) or DELETE to undo. The phone app checks in too, so the week polls. Latent bugs
// by flag: failed check-ins left on screen (checkin=optimistic; checkin=wait shows them only once saved), cells live
// while their request posts (cellGuard=none: a double click POSTs twice or DELETEs the temporary id), week loads
// applied in arrival order (weekSeq=blind: last week's check-ins land in this week), a week total kept by hand that
// the poll never updates (weekTotal=incremental) and polls that overwrite cells with a request in flight (poll=blind).
import { app, h, text } from "hyperapp";
import { flag } from "../_shared/genclass";
import { hyperappGuard } from "../_shared/hyperapp-guard";
import { api, errText, HttpError } from "../_shared/w3-http";

type Habit = { id: number; name: string; goal: number };
type Check = { id: number; habitId: number; week: number; day: number; key: string };
type S = { week: number; habits: Habit[]; checks: Check[]; total: number; pending: string[]; draft: string; adding: boolean; loading: boolean; error: string; notice: string };

const CHECKIN = flag("checkin", "optimistic-rollback") as "optimistic-rollback" | "optimistic" | "wait";
const CELL_GUARD = flag("cellGuard", "pending") === "pending";
const WEEK_SEQ = flag("weekSeq", "latest");
const WEEK_TOTAL = flag("weekTotal", "derive");
const POLL = flag("poll", "pending-aware");
const THIS_WEEK = 14;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const init: S = { week: THIS_WEEK, habits: [], checks: [], total: 0, pending: [], draft: "", adding: false, loading: true, error: "", notice: "" };
const { middleware, store } = hyperappGuard<S>("habits", init);
const keyOf = (habitId: number, week: number, day: number) => `${habitId}:${week}:${day}`;
const withChecks = (s: S, checks: Check[], delta: number): S => ({ ...s, checks, total: WEEK_TOTAL === "derive" ? checks.length : s.total + delta });
const unpend = (s: S, key: string): S => ({ ...s, pending: s.pending.filter((k) => k !== key) });
const fx = (run: () => void) => [run, null];

// ------------------------------------------------------------------------------------------- effects
let seq = 0;
const loadWeekFx = (week: number) =>
  fx(() => {
    const my = ++seq;
    api<Check[]>(`/api/checkins?week=${week}&limit=100`)
      .then((checks) =>
        store.update((s) => {
          if (WEEK_SEQ === "latest" && (my !== seq || s.week !== week)) return s;
          return { ...s, checks, total: checks.length, loading: false };
        }),
      )
      .catch((e) => store.update((s) => (my !== seq ? s : { ...s, loading: false, error: errText(e, "loading the week") })));
  });

const pollFx = (week: number) =>
  fx(() => {
    if (store.get().loading) return;
    const my = seq;
    api<Check[]>(`/api/checkins?week=${week}&limit=100`)
      .then((fresh) =>
        store.update((s) => {
          if (my !== seq || s.week !== week || s.loading) return s;
          let checks = fresh;
          if (POLL === "pending-aware") {
            const busy = new Set(s.pending);
            checks = [...fresh.filter((c) => !busy.has(c.key)), ...s.checks.filter((c) => busy.has(c.key))];
          }
          return { ...s, checks, total: WEEK_TOTAL === "derive" ? checks.length : s.total };
        }),
      )
      .catch(() => undefined);
  });

const addFx = (c: Check) =>
  fx(() => {
    api<Check>(`/api/checkins`, "POST", { habitId: c.habitId, week: c.week, day: c.day, key: c.key })
      .then((saved) =>
        store.update((s) => {
          const has = s.checks.some((x) => x.key === c.key);
          const next = has ? { ...s, checks: s.checks.map((x) => (x.key === c.key ? saved : x)) } : s.week === saved.week ? withChecks(s, [...s.checks, saved], 1) : s;
          return { ...unpend(next, c.key), error: "" };
        }),
      )
      .catch((e) =>
        store.update((s) => {
          const taken = e instanceof HttpError && e.status === 409;
          const back = CHECKIN === "optimistic-rollback" && !taken && s.checks.some((x) => x.key === c.key) ? withChecks(s, s.checks.filter((x) => x.key !== c.key), -1) : s;
          return { ...unpend(back, c.key), error: taken ? `${DAYS[c.day]} was already checked in from another device.` : errText(e, "saving the check-in") };
        }),
      );
  });

const removeFx = (c: Check) =>
  fx(() => {
    api(`/api/checkins/${c.id}`, "DELETE")
      .then(() => store.update((s) => unpend(s.checks.some((x) => x.key === c.key) ? withChecks(s, s.checks.filter((x) => x.key !== c.key), -1) : s, c.key)))
      .catch((e) =>
        store.update((s) => {
          const back = CHECKIN === "optimistic-rollback" && !s.checks.some((x) => x.key === c.key) && s.week === c.week ? withChecks(s, [...s.checks, c], 1) : s;
          return { ...unpend(back, c.key), error: errText(e, "undoing the check-in") };
        }),
      );
  });

const addHabitFx = (name: string) =>
  fx(() => {
    api<Habit>(`/api/habits`, "POST", { name, goal: 7 })
      .then((habit) => store.update((s) => ({ ...s, habits: [...s.habits, habit], draft: "", adding: false, notice: `Tracking “${habit.name}” from today.`, error: "" })))
      .catch((e) => store.update((s) => ({ ...s, adding: false, error: e instanceof HttpError && e.status === 409 ? `You already track “${name}”.` : errText(e, "adding the habit") })));
  });

const loadHabitsFx = fx(() => {
  api<Habit[]>(`/api/habits?limit=30`)
    .then((habits) => store.update((s) => ({ ...s, habits })))
    .catch((e) => store.update((s) => ({ ...s, error: errText(e, "loading habits") })));
});

// ------------------------------------------------------------------------------------------- actions
let tmp = 0;
const Toggle = (s: S, cell: { habitId: number; day: number }) => {
  const key = keyOf(cell.habitId, s.week, cell.day);
  if (CELL_GUARD && s.pending.includes(key)) return s;
  const existing = s.checks.find((c) => c.key === key);
  const pending = [...s.pending, key];
  if (existing) {
    const next = CHECKIN === "wait" ? s : withChecks(s, s.checks.filter((c) => c.key !== key), -1);
    return [{ ...next, pending, error: "", notice: "" }, removeFx(existing)];
  }
  const temp: Check = { id: -++tmp, habitId: cell.habitId, week: s.week, day: cell.day, key };
  const next = CHECKIN === "wait" ? s : withChecks(s, [...s.checks, temp], 1);
  return [{ ...next, pending, error: "", notice: "" }, addFx(temp)];
};
const GoWeek = (s: S, week: number) => [{ ...s, week, loading: true, error: "", notice: "" }, loadWeekFx(week)];
const Poll = (s: S) => [s, pollFx(s.week)];
const Draft = (s: S, ev: Event) => ({ ...s, draft: (ev.target as HTMLInputElement).value });
const AddHabit = (s: S, ev: Event) => {
  ev.preventDefault();
  const name = s.draft.trim();
  if (!name || s.adding) return s;
  return [{ ...s, adding: true, error: "" }, addHabitFx(name)];
};

// one subscriber function for every interval (module level): Hyperapp compares subscribers by identity, so a
// function created per render would restart the interval on every state change
const intervalSub = (dispatch: (a: unknown) => void, p: { ms: number; action: unknown }) => {
  const iv = setInterval(() => dispatch(p.action), p.ms);
  return () => clearInterval(iv);
};
const every = (ms: number, action: unknown) => [intervalSub, { ms, action }];

// ------------------------------------------------------------------------------------------- view
const view = (s: S) =>
  h("main", { class: "habits" }, [
    h("h1", {}, text("Habits")),
    h("nav", { class: "weeks" }, [
      h("button", { class: "prev", disabled: s.week <= 12, onclick: [GoWeek, s.week - 1] }, text("‹ Previous week")),
      h("span", { class: "label" }, text(s.week === THIS_WEEK ? " This week " : ` Week ${s.week} `)),
      h("button", { class: "next", disabled: s.week >= THIS_WEEK, onclick: [GoWeek, s.week + 1] }, text("Next week ›")),
    ]),
    s.error ? h("p", { role: "alert" }, text(s.error)) : s.notice ? h("p", { class: "notice" }, text(s.notice)) : text(""),
    s.loading ? h("p", { class: "muted" }, text("Loading…")) : text(""),
    h("table", { class: "grid" }, [
      h("thead", {}, h("tr", {}, [h("th", {}, text("Habit")), ...DAYS.map((d) => h("th", {}, text(d))), h("th", {}, text("Done"))])),
      h(
        "tbody",
        {},
        s.habits.map((hb) => {
          const mine = s.checks.filter((c) => c.habitId === hb.id);
          return h("tr", { class: "habit", key: hb.id }, [
            h("th", {}, text(hb.name)),
            ...DAYS.map((_, day) => {
              const key = keyOf(hb.id, s.week, day);
              const on = mine.some((c) => c.day === day);
              const busy = s.pending.includes(key);
              return h("td", { class: "day" }, h("button", { class: on ? "on" : "off", "aria-label": `${hb.name} ${DAYS[day]}`, disabled: CELL_GUARD && busy, onclick: [Toggle, { habitId: hb.id, day }] }, text(busy && CHECKIN === "wait" ? "…" : on ? "✓" : "·")));
            }),
            h("td", { class: "count" }, text(`${mine.length}/${hb.goal}`)),
          ]);
        }),
      ),
    ]),
    h("p", { class: "total" }, text(`${s.total} check-ins ${s.week === THIS_WEEK ? "this week" : `in week ${s.week}`}`)),
    h("form", { class: "add", onsubmit: AddHabit }, [h("input", { name: "habit", placeholder: "New habit", value: s.draft, oninput: Draft }), h("button", { type: "submit", disabled: s.adding }, text(s.adding ? "Adding…" : "Add habit"))]),
  ]);

app<S>({
  init: [init, loadHabitsFx, loadWeekFx(THIS_WEEK)],
  view,
  node: document.getElementById("app")!,
  subscriptions: () => [every(5000, Poll)],
  dispatch: middleware,
} as never);
