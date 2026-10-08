// A/B experiment console (RxJS 7 streams over DOM events, fromFetch and rxjs/ajax; state in a runtime atom). The
// list polls; selecting an experiment loads its arm metrics (re-polled while selected); start/pause is a versioned
// PATCH; the traffic allocation form saves a percentage. Latent bugs by flag: metric loads flattened with mergeMap
// (metricsMap=merge: the previous experiment's numbers can land last), toggles flattened with mergeMap
// (toggleMap=merge: a double click starts and pauses), traffic saves with mergeMap (trafficSave=merge: an older
// value can win) and writes without the version (versioned=false: a teammate's change is silently overwritten).
import { EMPTY, fromEvent, interval, timer } from "rxjs";
import { catchError, concatMap, exhaustMap, filter, groupBy, map, mergeMap, startWith, switchMap, tap } from "rxjs/operators";
import { fromFetch } from "rxjs/fetch";
import { ajax } from "rxjs/ajax";
import { rt, flag } from "../_shared/genclass";

type Exp = { id: number; key: string; name: string; status: string; traffic: number; version: number };
type Metric = { id: number; experimentId: number; arm: string; users: number; conversions: number };
const METRICS_MAP = flag("metricsMap", "switch");
const TOGGLE_MAP = flag("toggleMap", "exhaust");
const TRAFFIC_SAVE = flag("trafficSave", "concat");
const VERSIONED = Boolean(flag("versioned", true));
const POLL_MS = Number(flag("pollMs", 4000));

const con = rt.atom("console", { exps: [] as Exp[], selected: 0, metrics: [] as Metric[], metricsLoading: false, saving: false, error: "", notice: "" });
const getJson = <T>(url: string) => fromFetch(url).pipe(switchMap((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(Object.assign(new Error(String(r.status)), { status: r.status })))));
const patch = (e: Exp, body: Record<string, unknown>) => ajax<Exp>({ url: `/api/experiments/${e.id}`, method: "PATCH", headers: { "content-type": "application/json" }, body: VERSIONED ? { ...body, version: e.version } : body }).pipe(map((r) => r.response));
const status = (e: any) => Number(e?.status ?? 0);
const putExp = (x: Exp) => con.update((s) => ({ ...s, exps: s.exps.map((e) => (e.id === x.id ? x : e)) }));
const failed = (what: string) => (e: any) => {
  const cur = e?.response?.current as Exp | undefined;
  if (status(e) === 409 && cur) putExp(cur);
  con.update((s) => ({ ...s, saving: false, error: status(e) === 409 ? `Someone else changed this experiment; ${what} was not saved.` : `${what} failed (${status(e) || "offline"}).` }));
  return EMPTY;
};
const conv = (m: Metric) => (m.users ? ((100 * m.conversions) / m.users).toFixed(2) : "0.00");

const root = document.getElementById("app")!;
root.innerHTML = `<h1>Experiments</h1><div class="msg"></div><ul class="exps"></ul>
  <section class="detail"><h2 class="title"></h2><table class="metrics"></table>
  <form class="traffic" hidden><label>Traffic % <input name="traffic" inputmode="numeric"></label> <button type="submit" class="save">Save allocation</button></form></section>`;
const $ = <T extends Element>(sel: string) => root.querySelector(sel) as T;
const form = $<HTMLFormElement>("form.traffic");
const input = $<HTMLInputElement>("input[name=traffic]");

con.subscribe((s) => {
  $(".msg").innerHTML = s.error ? `<p role="alert"></p>` : s.notice ? `<p class="notice"></p>` : "";
  const p = $(".msg p");
  if (p) p.textContent = s.error || s.notice;
  $(".exps").innerHTML = s.exps
    .map((e) => `<li class="exp ${e.status}${e.id === s.selected ? " current" : ""}" data-id="${e.id}"><button type="button" class="select">${e.name}</button> ${e.status} · ${e.traffic}% ${e.status === "draft" ? "" : `<button type="button" class="toggle">${e.status === "running" ? "Pause" : "Start"}</button>`}</li>`)
    .join("");
  const sel = s.exps.find((e) => e.id === s.selected);
  $(".title").textContent = sel ? `${sel.name} (${sel.key})` : "Select an experiment";
  $(".metrics").innerHTML = s.metricsLoading ? `<tr><td>Loading metrics…</td></tr>` : s.metrics.map((m) => `<tr class="arm"><td>${m.arm}</td><td>${m.users} users</td><td>${m.conversions} conversions</td><td>${conv(m)}%</td></tr>`).join("");
  form.hidden = !sel;
  $<HTMLButtonElement>("button.save").disabled = s.saving && TRAFFIC_SAVE === "concat";
});

// list polling (a poll never overlaps the previous one)
interval(POLL_MS)
  .pipe(
    startWith(0),
    exhaustMap(() => getJson<{ items: Exp[] }>(`/api/experiments?limit=20`).pipe(catchError((e) => (con.update((s) => ({ ...s, error: s.exps.length ? s.error : `Experiments could not be loaded (${status(e) || "offline"}).` })), EMPTY)))),
  )
  .subscribe((b) => con.update((s) => ({ ...s, exps: b.items ?? [] })));

const clicks$ = fromEvent<MouseEvent>(root, "click").pipe(map((ev) => ev.target as HTMLElement), filter((t) => t.tagName === "BUTTON" && !!t.closest("li.exp")));
const idOf = (t: HTMLElement) => Number(t.closest("li.exp")!.getAttribute("data-id"));

// selection → metrics (re-polled while selected)
const selected$ = clicks$.pipe(filter((t) => t.classList.contains("select")), map(idOf), tap((id) => { con.update((s) => ({ ...s, selected: id, metricsLoading: true, notice: "", error: "" })); input.value = String(con.get().exps.find((e) => e.id === id)?.traffic ?? ""); }));
const loadMetrics = (id: number) =>
  timer(0, POLL_MS).pipe(
    exhaustMap(() => getJson<{ items: Metric[] }>(`/api/metrics?experimentId=${id}&limit=10`).pipe(catchError(() => EMPTY))),
    map((b) => b.items ?? []),
  );
(METRICS_MAP === "switch" ? selected$.pipe(switchMap(loadMetrics)) : selected$.pipe(mergeMap(loadMetrics))).subscribe((metrics) => con.update((s) => ({ ...s, metrics, metricsLoading: false })));

// start / pause
const toggle$ = (id: number) => {
  const e = con.get().exps.find((x) => x.id === id);
  if (!e) return EMPTY;
  const next = e.status === "running" ? "paused" : "running";
  return patch(e, { status: next }).pipe(tap((x) => { putExp(x); con.update((s) => ({ ...s, notice: `${x.name} is ${x.status}.`, error: "" })); }), catchError(failed("the status change")));
};
const toggleIds$ = clicks$.pipe(filter((t) => t.classList.contains("toggle")), map(idOf));
(TOGGLE_MAP === "exhaust" ? toggleIds$.pipe(groupBy((id) => id), mergeMap((g) => g.pipe(exhaustMap(toggle$)))) : toggleIds$.pipe(mergeMap(toggle$))).subscribe();

// traffic allocation
const saves$ = fromEvent<SubmitEvent>(form, "submit").pipe(
  tap((ev) => ev.preventDefault()),
  map(() => ({ id: con.get().selected, traffic: Math.max(0, Math.min(100, Math.round(Number(input.value)))) })),
  filter((x) => x.id > 0 && Number.isFinite(x.traffic)),
);
const save$ = ({ id, traffic }: { id: number; traffic: number }) => {
  const e = con.get().exps.find((x) => x.id === id);
  if (!e) return EMPTY;
  con.update((s) => ({ ...s, saving: true, error: "" }));
  return patch(e, { traffic }).pipe(tap((x) => { putExp(x); con.update((s) => ({ ...s, saving: false, notice: `${x.name} now gets ${x.traffic}% of traffic.` })); }), catchError(failed("the allocation")));
};
(TRAFFIC_SAVE === "concat" ? saves$.pipe(concatMap(save$)) : saves$.pipe(mergeMap(save$))).subscribe();
