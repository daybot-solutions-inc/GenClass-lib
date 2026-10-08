// Class attendance register for teachers (petite-vue templates over a reactive mirror of a runtime atom; fetch +
// WebSocket). The teacher picks a period and marks each student present, late or absent from a dropdown (a PATCH per
// change, shown at once; quick corrections of the same student are queued behind the earlier save), or marks
// everyone still unmarked present in one go (POST /attendance/bulk, per-item results). The front office records late
// slips as students arrive, pushed live over the attendance socket (versioned records). The header shows the
// present/late/absent counts. Latent bugs by flag: class lists applied in arrival order (periodSeq=blind: switching
// periods quickly shows the previous class), marks of one student sent in parallel (mark=parallel: a quick
// correction can land before the original and the register keeps the wrong mark), bulk results ignored
// (bulk=assume-all: students the server could not mark show "present"), pushes applied without comparing versions or
// pending marks (live=blind: an older echo overwrites a newer mark) and counts adjusted by hand at click time
// (counts=incremental: late slips pushed by the front office never move the counts).
import { createApp, reactive } from "petite-vue";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, liveTopic } from "../_shared/w3-http";

type Rec = { id: number; period: string; student: string; status: string; slip: string; version: number };
type Counts = { present: number; late: number; absent: number; unmarked: number };
const PERIOD_SEQ = flag("periodSeq", "latest");
const MARK = flag("mark", "serial-per-student");
const BULK = flag("bulk", "per-item");
const LIVE = flag("live", "version-check");
const COUNTS = flag("counts", "derive");
const PERIODS = [
  { id: "p1", label: "P1 · Algebra 9B · Room 114" },
  { id: "p2", label: "P2 · Biology 10A · Lab 2" },
  { id: "p3", label: "P3 · History 9A · Room 207" },
];

const countOf = (rows: Rec[]): Counts => {
  const c: Counts = { present: 0, late: 0, absent: 0, unmarked: 0 };
  for (const r of rows) c[r.status as keyof Counts] = (c[r.status as keyof Counts] ?? 0) + 1;
  return c;
};
const roll = rt.atom("roll", { period: "p1", rows: [] as Rec[], counts: countOf([]), loading: true, pending: [] as number[], bulkBusy: false, live: false, error: "", notice: "" });
type R = ReturnType<typeof roll.get>;
const s = reactive({ ...roll.get() });
roll.subscribe((v) => Object.assign(s, v));
/** New rows; counts recounted (derive) or as the caller adjusted them by hand (incremental). */
const withRows = (a: R, rows: Rec[], counts?: Counts): R => ({ ...a, rows, counts: COUNTS === "derive" ? countOf(rows) : (counts ?? a.counts) });
const bump = (c: Counts, from: string, to: string): Counts => ({ ...c, [from]: c[from as keyof Counts] - 1, [to]: c[to as keyof Counts] + 1 });

let seq = 0;
async function loadPeriod(background = false) {
  const my = background ? seq : ++seq;
  const period = roll.get().period;
  if (!background) roll.update((a) => ({ ...a, loading: true, error: "" }));
  try {
    const rows = itemsOf<Rec>(await api(`/api/attendance?period=${period}&sort=student&limit=40`));
    if (PERIOD_SEQ === "latest" && (my !== seq || period !== roll.get().period)) return;
    roll.update((a) => {
      // students with a mark in flight keep the teacher's mark
      const merged = rows.map((x) => (a.pending.includes(x.id) ? (a.rows.find((y) => y.id === x.id) ?? x) : x));
      return { ...withRows(a, merged, background ? undefined : countOf(merged)), loading: background || my !== seq ? a.loading : false };
    });
  } catch (e) {
    if (!background && my === seq) roll.update((a) => ({ ...a, loading: false, error: errText(e, "loading the class list") }));
  }
}

const queues = new Map<number, Promise<void>>();
const outstanding = new Map<number, number>();
function mark(id: number, status: string) {
  const a0 = roll.get();
  const prev = a0.rows.find((x) => x.id === id);
  if (!prev || prev.status === status) return;
  roll.update((a) => ({
    ...withRows(a, a.rows.map((x) => (x.id === id ? { ...x, status } : x)), bump(a.counts, prev.status, status)),
    pending: a.pending.includes(id) ? a.pending : [...a.pending, id],
    error: "",
    notice: "",
  }));
  outstanding.set(id, (outstanding.get(id) ?? 0) + 1);
  const send = () => save(prev, status);
  if (MARK === "serial-per-student") queues.set(id, (queues.get(id) ?? Promise.resolve()).then(send));
  else void send();
}

async function save(r: Rec, status: string) {
  let saved: Rec | null = null;
  let err: unknown = null;
  try {
    saved = await api<Rec>(`/api/attendance/${r.id}`, "PATCH", { status });
  } catch (e) {
    err = e;
  }
  const left = (outstanding.get(r.id) ?? 1) - 1;
  outstanding.set(r.id, left);
  roll.update((a) => {
    const pending = left === 0 ? a.pending.filter((x) => x !== r.id) : a.pending;
    if (err) return { ...a, pending, error: errText(err, `marking ${r.student} ${status}`) };
    // only the last save of a student shows the server's record; earlier ones just advance the version
    const rows = a.rows.map((x) => (x.id !== r.id ? x : left === 0 ? saved! : { ...x, version: saved!.version }));
    return { ...withRows(a, rows), pending, notice: left === 0 ? `${r.student}: ${saved!.status}.` : a.notice };
  });
  if (err && left === 0) void loadPeriod(true);
}

async function restPresent() {
  const a0 = roll.get();
  const ids = a0.rows.filter((r) => r.status === "unmarked" && !a0.pending.includes(r.id)).map((r) => r.id);
  if (!ids.length || a0.bulkBusy) return;
  roll.update((a) => ({ ...a, bulkBusy: true, error: "", notice: "" }));
  try {
    const res = await api<{ results: { id: number; ok: boolean }[] }>(`/api/attendance/bulk`, "POST", { ids, op: "patch", patch: { status: "present" } });
    const results = res?.results ?? [];
    const ok = new Set(BULK === "per-item" ? results.filter((x) => x.ok).map((x) => Number(x.id)) : ids);
    const failed = ids.length - results.filter((x) => x.ok).length;
    roll.update((a) => {
      if (a.period !== a0.period) return { ...a, bulkBusy: false };
      const hit = a.rows.filter((r) => ok.has(r.id) && r.status === "unmarked").length;
      const rows = a.rows.map((r) => (ok.has(r.id) && r.status === "unmarked" ? { ...r, status: "present" } : r));
      return {
        ...withRows(a, rows, { ...a.counts, present: a.counts.present + hit, unmarked: a.counts.unmarked - hit }),
        bulkBusy: false,
        notice: `Marked ${ok.size} student(s) present.`,
        error: BULK === "per-item" && failed ? `${failed} student(s) could not be marked. Try again.` : "",
      };
    });
  } catch (e) {
    roll.update((a) => ({ ...a, bulkBusy: false, error: errText(e, "marking everyone else present") }));
  }
}

let everUp = false;
liveTopic(
  "attendance",
  (m) => {
    const it = m?.item as Rec | null;
    if (m?.type !== "updated" || !it) return;
    roll.update((a) => {
      const cur = a.rows.find((r) => r.id === it.id);
      if (!cur || it.period !== a.period) return a;
      if (LIVE === "version-check" && (Number(it.version) <= Number(cur.version) || a.pending.includes(it.id))) return a;
      return withRows(a, a.rows.map((r) => (r.id === it.id ? it : r)));
    });
  },
  (up) => {
    roll.update((a) => ({ ...a, live: up }));
    if (up && everUp) void loadPeriod(true);
    if (up) everUp = true;
  },
);

document.getElementById("app")!.innerHTML = `<div v-scope>
  <h1>Attendance register</h1>
  <label>Period <select name="period" @change="pick($event.target.value)">${PERIODS.map((p) => `<option value="${p.id}">${p.label}</option>`).join("")}</select></label>
  <p class="counts">Present {{ s.counts.present }} · Late {{ s.counts.late }} · Absent {{ s.counts.absent }} · Not marked {{ s.counts.unmarked }}</p>
  <button type="button" class="rest-present" :disabled="s.bulkBusy || s.loading || !s.rows.some((r) => r.status === 'unmarked')" @click="restPresent()">Mark everyone else present</button>
  <p role="alert" v-if="s.error">{{ s.error }}</p><p class="notice" v-else-if="s.notice">{{ s.notice }}</p>
  <p class="muted" v-if="s.loading">Loading class list…</p>
  <ul class="roll"><li v-for="r in s.rows" :key="r.id" :class="['student', r.status]">
    <span class="name">{{ r.student }}</span> <span class="slip" v-if="r.slip">{{ r.slip }}</span>
    <select class="status" :value="r.status" @change="mark(r.id, $event.target.value)"><option value="unmarked">–</option><option value="present">Present</option><option value="late">Late</option><option value="absent">Absent</option></select>
  </li></ul>
</div>`;
createApp({
  s,
  mark: (id: number, status: string) => mark(id, status),
  restPresent: () => void restPresent(),
  pick: (period: string) => {
    roll.update((a) => ({ ...a, period, notice: "" }));
    void loadPeriod();
  },
}).mount();
void loadPeriod();
