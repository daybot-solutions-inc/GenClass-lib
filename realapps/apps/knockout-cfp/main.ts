// Conference call-for-papers review board (Knockout 3 view model registered with rt.guard; fetch). Reviewers page
// through proposals (5 per page, cached per page and revalidated), score them 1–5 (a versioned PATCH per change;
// other reviewers bump the version all the time, so a 409 on a score is merged and re-sent) and accept/reject open
// ones (the programme chair decides too). Latent bugs by flag: cached pages shown without revalidation
// (cache=cache-only: the chair's decisions never appear), score saves of one row fired in parallel (save=parallel: a
// reordered pair leaves the older score), decision conflicts resolved by re-sending over the chair's decision
// (conflict=overwrite), page answers applied in arrival order (pageSeq=blind) and the "scored" counter bumped by
// each save instead of recounted (count=incremental: parallel saves count a row twice).
import ko from "knockout";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Proposal = { id: number; title: string; speaker: string; track: string; myScore: number; reviews: number; status: string; version: number };
const CACHE = flag("cache", "swr");
const SAVE = flag("save", "serial");
const CONFLICT = flag("conflict", "respect");
const PAGE_SEQ = flag("pageSeq", "latest");
const COUNT = flag("count", "computed");
const PER = 5;

class Row {
  myScore = ko.observable("0");
  status = ko.observable("open");
  reviews = ko.observable(0);
  busy = ko.observable(false);
  version = 0;
  saved = 0;
  saving = 0;
  queue: Promise<void> = Promise.resolve();
  private adopting = false;
  constructor(public p: Proposal) {
    this.adopt(p);
    this.myScore.subscribe(() => {
      if (this.adopting) return;
      if (SAVE === "serial") this.queue = this.queue.then(() => saveScore(this));
      else void saveScore(this);
    });
  }
  adopt(p: Proposal) {
    this.adopting = true;
    this.myScore(String(p.myScore ?? 0));
    this.adopting = false;
    this.status(p.status);
    this.reviews(p.reviews);
    this.version = p.version;
    this.saved = Number(p.myScore ?? 0);
  }
}

const vm = {
  track: ko.observable("all"),
  page: ko.observable(1),
  rows: ko.observableArray<Row>([]),
  total: ko.observable(0),
  manualScored: ko.observable(0),
  loading: ko.observable(true),
  saving: ko.observable(0),
  error: ko.observable(""),
  notice: ko.observable(""),
};
const countScored = () => vm.rows().filter((r) => Number(r.myScore()) > 0).length;
const scored = ko.pureComputed(() => (COUNT === "computed" ? countScored() : vm.manualScored()));
const pages = ko.pureComputed(() => Math.max(1, Math.ceil(vm.total() / PER)));
const cache = new Map<string, { items: Proposal[]; total: number }>();
const remember = (p: Proposal) => cache.forEach((c) => (c.items = c.items.map((x) => (x.id === p.id ? p : x))));
const asItem = (r: Row): Proposal => ({ ...r.p, myScore: Number(r.myScore()), status: r.status(), reviews: r.reviews(), version: r.version });

const snapshot = ko.pureComputed(() => ({
  track: vm.track(),
  page: vm.page(),
  rows: vm.rows().map((r) => ({ id: r.p.id, title: r.p.title, track: r.p.track, myScore: Number(r.myScore()), status: r.status(), reviews: r.reviews() })),
  total: vm.total(),
  scored: scored(),
  loading: vm.loading(),
  saving: vm.saving() > 0,
  error: vm.error(),
  notice: vm.notice(),
}));
rt.guard("cfp", {
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

let seq = 0;
async function loadPage() {
  const my = ++seq;
  const key = `${vm.track()}|${vm.page()}`;
  const hit = cache.get(key);
  if (hit) {
    vm.rows(hit.items.map((p) => new Row(p)));
    vm.total(hit.total);
    vm.manualScored(countScored());
    vm.loading(false);
    if (CACHE === "cache-only") return;
  } else vm.loading(true);
  try {
    const qs = `page=${vm.page()}&limit=${PER}${vm.track() === "all" ? "" : `&track=${vm.track()}`}`;
    const body = await api<{ items: Proposal[]; total: number }>(`/api/proposals?${qs}`);
    if (PAGE_SEQ === "latest" && my !== seq) return;
    const items = itemsOf<Proposal>(body);
    cache.set(key, { items, total: Number(body.total ?? items.length) });
    const live = new Map(vm.rows().map((r) => [r.p.id, r]));
    // rows with a save or decision in flight keep their local state
    vm.rows(items.map((p) => { const r = live.get(p.id); return r && (r.busy() || r.saving > 0) ? r : new Row(p); }));
    vm.total(Number(body.total ?? items.length));
    vm.manualScored(countScored());
  } catch (e) {
    if (my === seq && !hit) vm.error(errText(e, "loading proposals"));
  } finally {
    if (my === seq) vm.loading(false);
  }
}

async function saveScore(r: Row) {
  const score = Number(r.myScore());
  const before = r.saved;
  r.saving++;
  vm.saving(vm.saving() + 1);
  vm.error("");
  try {
    let saved: Proposal;
    try {
      saved = await api<Proposal>(`/api/proposals/${r.p.id}`, "PATCH", { myScore: score, version: r.version });
    } catch (e) {
      const cur = e instanceof HttpError && e.status === 409 ? (e.body?.current as Proposal | undefined) : undefined;
      if (!cur) throw e;
      // another reviewer touched the proposal: scores are ours alone, so re-send on top of their version
      saved = await api<Proposal>(`/api/proposals/${r.p.id}`, "PATCH", { myScore: score, version: cur.version });
    }
    r.version = saved.version;
    r.saved = saved.myScore;
    r.reviews(saved.reviews);
    r.status(saved.status);
    remember(saved);
    if (COUNT === "incremental") vm.manualScored(vm.manualScored() + (before === 0 && saved.myScore > 0 ? 1 : before > 0 && saved.myScore === 0 ? -1 : 0));
    vm.notice(`Scored “${r.p.title}”: ${saved.myScore}/5.`);
  } catch (e) {
    vm.error(errText(e, `saving your score for “${r.p.title}”`));
  } finally {
    r.saving--;
    vm.saving(vm.saving() - 1);
  }
}

async function decide(r: Row, status: string) {
  if (r.busy() || r.status() !== "open") return;
  r.busy(true);
  vm.error("");
  try {
    let saved: Proposal;
    try {
      saved = await api<Proposal>(`/api/proposals/${r.p.id}`, "PATCH", { status, version: r.version });
    } catch (e) {
      const cur = e instanceof HttpError && e.status === 409 ? (e.body?.current as Proposal | undefined) : undefined;
      if (!cur) throw e;
      if (CONFLICT === "overwrite" || cur.status === "open") saved = await api<Proposal>(`/api/proposals/${r.p.id}`, "PATCH", { status, version: cur.version });
      else {
        r.adopt({ ...cur, myScore: Number(r.myScore()) });
        remember(asItem(r));
        vm.error(`“${r.p.title}” was already ${cur.status} by the chair.`);
        return;
      }
    }
    r.version = saved.version;
    r.status(saved.status);
    r.reviews(saved.reviews);
    remember(saved);
    vm.notice(`“${r.p.title}” ${saved.status}.`);
  } catch (e) {
    vm.error(errText(e, `recording your decision on “${r.p.title}”`));
  } finally {
    r.busy(false);
  }
}

document.getElementById("app")!.innerHTML = `<h1>CFP review · DevConf 2026</h1>
  <label>Track <select name="track" data-bind="value: track, event: { change: changeTrack }"><option value="all">All tracks</option><option>frontend</option><option>backend</option><option>data</option><option>devops</option></select></label>
  <span class="summary" data-bind="text: 'Scored ' + scored() + ' of ' + rows().length + ' on this page · ' + total() + ' proposals'"></span>
  <span class="muted" data-bind="visible: loading">Loading…</span> <span class="muted" data-bind="visible: saving() > 0">Saving…</span>
  <p role="alert" data-bind="visible: error, text: error"></p><p class="notice" data-bind="visible: !error() && notice(), text: notice"></p>
  <table><tbody data-bind="foreach: rows"><tr class="proposal">
    <td data-bind="text: p.title"></td><td data-bind="text: p.speaker + ' · ' + p.track"></td><td data-bind="text: reviews() + ' reviews'"></td>
    <td><select class="score" data-bind="value: myScore"><option value="0">–</option><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select></td>
    <td data-bind="text: status"></td>
    <td><!-- ko if: status() === 'open' --><button type="button" class="decide" data-bind="click: () => $root.decide($data, 'accepted'), disable: busy">Accept</button> <button type="button" class="decide" data-bind="click: () => $root.decide($data, 'rejected'), disable: busy">Reject</button><!-- /ko --></td>
  </tr></tbody></table>
  <nav class="pages" data-bind="foreach: Array.from({ length: pages() }, (_, i) => i + 1)"><button type="button" data-bind="text: $data, css: { current: $root.page() === $data }, click: () => $root.goPage($data)"></button></nav>`;

ko.applyBindings(
  {
    ...vm,
    scored,
    pages,
    decide: (r: Row, s: string) => void decide(r, s),
    goPage: (p: number) => {
      vm.page(p);
      void loadPage();
    },
    changeTrack: () => {
      vm.page(1);
      vm.error("");
      vm.notice("");
      void loadPage();
    },
  },
  document.getElementById("app"),
);
void loadPage();
setInterval(() => CACHE === "swr" && !vm.loading() && void loadPage(), 7000);
