// Teacher's gradebook (Knockout 3 view model with textInput bindings; registered with rt.guard; fetch). Each score
// cell autosaves (debounced, versioned PATCH) and a teaching assistant edits section 9A at the same time; a poll
// merges their changes. Latent bugs by flag: saves of one cell fired in parallel with the same version
// (autosave=parallel: our own second save conflicts), conflicts resolved by re-sending over the TA's score
// (conflict=overwrite), section loads applied in arrival order (sectionSeq=blind), class averages recomputed only
// when our own saves land (average=on-save) and polls that overwrite cells being edited (poll=blind).
import ko from "knockout";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Grade = { id: number; section: string; student: string; assignment: string; score: number; version: number };
const AUTOSAVE = flag("autosave", "per-cell-queue");
const CONFLICT = flag("conflict", "reload");
const SECTION_SEQ = flag("sectionSeq", "latest");
const AVERAGE = flag("average", "computed");
const POLL = flag("poll", "pending-aware");
const ASSIGNMENTS = ["Essay", "Quiz", "Lab"];
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

class Cell {
  score = ko.observable("");
  version = 0;
  dirty = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  constructor(public id: number, public student: string, public assignment: string, g: Grade) {
    this.adopt(g);
    this.score.subscribe(() => {
      if (this.adopting) return;
      this.dirty++;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => (AUTOSAVE === "parallel" ? void this.save() : (this.queue = this.queue.then(() => this.save()))), 600);
    });
  }
  adopting = false;
  adopt(g: Grade) {
    this.adopting = true;
    this.score(String(g.score));
    this.adopting = false;
    this.version = g.version;
  }
  async save() {
    const sent = num(this.score());
    const d = this.dirty;
    vm.saving(vm.saving() + 1);
    try {
      let g: Grade;
      try {
        g = await api<Grade>(`/api/grades/${this.id}`, "PATCH", { score: sent, version: this.version });
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 409 && CONFLICT === "overwrite")) throw e;
        g = await api<Grade>(`/api/grades/${this.id}`, "PATCH", { score: sent, version: e.body?.current?.version });
      }
      this.version = g.version;
      if (this.dirty === d) this.dirty = 0;
      if (AVERAGE === "on-save") recalc();
      vm.notice(`Saved ${this.student}'s ${this.assignment}: ${g.score}.`);
      vm.error("");
    } catch (e) {
      const cur = e instanceof HttpError && e.status === 409 ? (e.body?.current as Grade | undefined) : undefined;
      if (cur) {
        this.dirty = 0;
        this.adopt(cur);
        if (AVERAGE === "on-save") recalc();
        vm.error(`${this.student}'s ${this.assignment} was changed by someone else (now ${cur.score}).`);
      } else vm.error(errText(e, `saving ${this.student}'s ${this.assignment}`));
    } finally {
      vm.saving(vm.saving() - 1);
    }
  }
}

const vm = {
  section: ko.observable("9A"),
  cells: ko.observableArray<Cell>([]),
  manualAverages: ko.observable<Record<string, number>>({}),
  loading: ko.observable(true),
  saving: ko.observable(0),
  publishing: ko.observable(false),
  error: ko.observable(""),
  notice: ko.observable(""),
};
const averagesOf = (cells: Cell[]) => Object.fromEntries(ASSIGNMENTS.map((a) => {
  const xs = cells.filter((c) => c.assignment === a).map((c) => num(c.score()));
  return [a, xs.length ? Math.round(xs.reduce((p, q) => p + q, 0) / xs.length) : 0];
}));
const recalc = () => vm.manualAverages(averagesOf(vm.cells()));
const averages = ko.pureComputed(() => (AVERAGE === "computed" ? averagesOf(vm.cells()) : vm.manualAverages()));
const rows = ko.pureComputed(() => {
  const by = new Map<string, Cell[]>();
  for (const c of vm.cells()) by.set(c.student, [...(by.get(c.student) ?? []), c]);
  return [...by.entries()].map(([student, cells]) => ({ student, cells: ASSIGNMENTS.map((a) => cells.find((c) => c.assignment === a)!) }));
});

const snapshot = ko.pureComputed(() => ({
  section: vm.section(),
  cells: vm.cells().map((c) => ({ id: c.id, student: c.student, assignment: c.assignment, score: num(c.score()) })),
  averages: averages(),
  loading: vm.loading(),
  saving: vm.saving() > 0,
  error: vm.error(),
  notice: vm.notice(),
}));
rt.guard("gradebook", {
  get: () => snapshot.peek(),
  set: (v: any) => {
    if (v.section) vm.section(v.section);
    for (const x of v.cells ?? []) vm.cells().find((c) => c.id === x.id)?.score(String(x.score));
    vm.error(v.error ?? "");
    vm.notice(v.notice ?? "");
  },
  subscribe: (fn) => {
    const sub = snapshot.subscribe(() => fn());
    return () => sub.dispose();
  },
});

let seq = 0;
async function loadSection(section: string, background = false) {
  const my = background ? seq : ++seq;
  if (!background) vm.loading(true);
  else if (vm.loading()) return;
  try {
    const gs = itemsOf<Grade>(await api(`/api/grades?section=${encodeURIComponent(section)}&limit=50`));
    if (SECTION_SEQ === "latest" && (my !== seq || vm.section() !== section)) return;
    if (background) {
      if (my !== seq || vm.section() !== section) return;
      for (const g of gs) {
        const c = vm.cells().find((x) => x.id === g.id);
        if (c && (POLL === "blind" || c.dirty === 0) && c.version !== g.version) c.adopt(g);
      }
      if (AVERAGE === "on-save") recalc();
    } else {
      vm.cells(gs.map((g) => new Cell(g.id, g.student, g.assignment, g)));
      recalc();
    }
    vm.loading(false);
  } catch (e) {
    if (my === seq) {
      vm.loading(false);
      if (!background) vm.error(errText(e, "loading the section"));
    }
  }
}

async function publish() {
  if (vm.publishing()) return;
  vm.publishing(true);
  try {
    const ids = vm.cells().map((c) => c.id);
    const r = await api<{ results: { ok: boolean }[] }>(`/api/grades/bulk`, "POST", { ids, op: "patch", patch: { published: true } });
    const failed = r.results.filter((x) => !x.ok).length;
    if (failed) vm.error(`${failed} grade(s) could not be published.`);
    else vm.notice(`Published ${ids.length} grades for ${vm.section()}.`);
  } catch (e) {
    vm.error(errText(e, "publishing"));
  } finally {
    vm.publishing(false);
  }
}

document.getElementById("app")!.innerHTML = `<h1>Gradebook</h1>
  <label>Section <select name="section" data-bind="value: section, event: { change: changeSection }"><option>9A</option><option>9B</option><option>10A</option></select></label>
  <span class="muted" data-bind="visible: loading">Loading…</span> <span class="muted" data-bind="visible: saving() > 0">Saving…</span>
  <p role="alert" data-bind="visible: error, text: error"></p><p class="notice" data-bind="visible: !error() && notice(), text: notice"></p>
  <table class="grid"><thead><tr><th>Student</th><th>Essay</th><th>Quiz</th><th>Lab</th></tr></thead>
    <tbody data-bind="foreach: rows"><tr><th data-bind="text: student"></th>
      <!-- ko foreach: cells --><td class="cell"><input class="score" inputmode="numeric" data-bind="textInput: score"></td><!-- /ko --></tr></tbody>
    <tfoot><tr><th>Average</th><td data-bind="text: averages().Essay"></td><td data-bind="text: averages().Quiz"></td><td data-bind="text: averages().Lab"></td></tr></tfoot></table>
  <button type="button" class="publish" data-bind="click: publish, disable: publishing">Publish grades</button>`;

ko.applyBindings({ ...vm, rows, averages, publish: () => void publish(), changeSection: () => { vm.error(""); vm.notice(""); void loadSection(vm.section()); } }, document.getElementById("app"));
void loadSection("9A");
setInterval(() => void loadSection(vm.section(), true), 6000);
