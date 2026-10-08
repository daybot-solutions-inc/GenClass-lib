// Job board (RxJS 7 streams over a BehaviorSubject view state with a hand-written DOM layer; fromFetch + fetch;
// nothing registered with GenClass: observe-only). The search box and the remote-only toggle feed a debounced query
// stream; results come six at a time with "Load more" (new postings appear at the top while you scroll); jobs can be
// bookmarked (optimistic POST/DELETE /saved) or quick-applied (POST /applications). Latent bugs by flag: queries
// flattened with mergeMap (search=mergeMap: results for an older query land last), no debounce (debounce=0: a request
// per keystroke), Load more flattened with mergeMap (more=mergeMap: a double click appends the same page twice),
// bookmarks not rolled back when they fail (save=optimistic) and apply buttons live while posting (applyGuard=none:
// two applications for one job).
import { BehaviorSubject, EMPTY, Subject, defer } from "rxjs";
import { catchError, debounceTime, distinctUntilChanged, exhaustMap, finalize, map, mergeMap, switchMap, tap } from "rxjs/operators";
import { fromFetch } from "rxjs/fetch";
import { flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Job = { id: number; title: string; company: string; city: string; remote: boolean; salary: number; posted: number };
type Page = { items: Job[]; total: number };
type S = { q: string; remote: boolean; items: Job[]; total: number; page: number; loading: boolean; loadingMore: boolean; saved: Record<number, number>; busy: number[]; applying: number[]; applied: number[]; error: string; notice: string };
const SEARCH = flag("search", "switchMap");
const DEBOUNCE = Number(flag("debounce", 300));
const MORE = flag("more", "exhaustMap");
const SAVE = flag("save", "optimistic-rollback");
const APPLY_GUARD = flag("applyGuard", "pending") === "pending";
const PER = 6;

const state$ = new BehaviorSubject<S>({ q: "", remote: false, items: [], total: 0, page: 1, loading: true, loadingMore: false, saved: {}, busy: [], applying: [], applied: [], error: "", notice: "" });
const set = (fn: (s: S) => S) => state$.next(fn(state$.value));
const pageOf = (q: string, remote: boolean, page: number) =>
  fromFetch(`/api/jobs?sort=-posted&page=${page}&limit=${PER}${q ? `&q=${encodeURIComponent(q)}` : ""}${remote ? "&remote=true" : ""}`, {
    selector: (r) => (r.ok ? (r.json() as Promise<Page>) : Promise.reject(new HttpError(r.status))),
  });

// ------------------------------------------------------------------------------------------- streams
type Query = { q: string; remote: boolean };
const query$ = new Subject<Query>();
const runQuery = ({ q, remote }: Query) =>
  pageOf(q, remote, 1).pipe(
    map((body) => ({ q, remote, body })),
    catchError((e) => (set((s) => ({ ...s, loading: false, error: errText(e, "searching jobs") })), EMPTY)),
  );
query$
  .pipe(
    DEBOUNCE > 0 ? debounceTime(DEBOUNCE) : (x) => x,
    distinctUntilChanged((a, b) => a.q === b.q && a.remote === b.remote),
    tap(() => set((s) => ({ ...s, loading: true, error: "" }))),
    SEARCH === "switchMap" ? switchMap(runQuery) : mergeMap(runQuery),
  )
  .subscribe(({ body }) => set((s) => ({ ...s, items: itemsOf<Job>(body), total: Number(body.total ?? 0), page: 1, loading: false })));

const more$ = new Subject<void>();
const loadNext = () =>
  defer(() => {
    const s = state$.value;
    const page = s.page + 1;
    set((x) => ({ ...x, loadingMore: true, error: "" }));
    return pageOf(s.q, s.remote, page).pipe(
      tap((body) => set((x) => (x.q !== s.q || x.remote !== s.remote ? x : { ...x, items: [...x.items, ...itemsOf<Job>(body)], page: Math.max(x.page, page), total: Number(body.total ?? x.total) }))),
      catchError((e) => (set((x) => ({ ...x, error: errText(e, "loading more jobs") })), EMPTY)),
      finalize(() => set((x) => ({ ...x, loadingMore: false }))),
    );
  });
more$.pipe(MORE === "exhaustMap" ? exhaustMap(loadNext) : mergeMap(loadNext)).subscribe();

// ------------------------------------------------------------------------------------------- writes
async function toggleSave(job: Job) {
  const s = state$.value;
  if (s.busy.includes(job.id)) return;
  const id = s.saved[job.id];
  set((x) => {
    const saved = { ...x.saved };
    if (id) delete saved[job.id];
    else saved[job.id] = -1;
    return { ...x, saved, busy: [...x.busy, job.id], error: "", notice: "" };
  });
  try {
    if (id) await api(`/api/saved/${id}`, "DELETE");
    else {
      const r = await api<{ id: number }>(`/api/saved`, "POST", { jobId: job.id });
      set((x) => ({ ...x, saved: { ...x.saved, [job.id]: r.id } }));
    }
  } catch (e) {
    set((x) => {
      const saved = { ...x.saved };
      if (SAVE === "optimistic-rollback") {
        if (id) saved[job.id] = id;
        else delete saved[job.id];
      }
      return { ...x, saved, error: e instanceof HttpError && e.status === 409 ? `${job.title} is already saved.` : errText(e, `saving ${job.title}`) };
    });
  } finally {
    set((x) => ({ ...x, busy: x.busy.filter((b) => b !== job.id) }));
  }
}

async function apply(job: Job) {
  const s = state$.value;
  if (s.applied.includes(job.id) || (APPLY_GUARD && s.applying.includes(job.id))) return;
  set((x) => ({ ...x, applying: [...x.applying, job.id], error: "", notice: "" }));
  try {
    await api(`/api/applications`, "POST", { jobId: job.id, title: job.title, company: job.company });
    set((x) => ({ ...x, applied: x.applied.includes(job.id) ? x.applied : [...x.applied, job.id], notice: `Applied to ${job.title} at ${job.company}.` }));
  } catch (e) {
    set((x) => ({ ...x, error: errText(e, `applying to ${job.title}`) }));
  } finally {
    set((x) => ({ ...x, applying: x.applying.filter((b) => b !== job.id) }));
  }
}

// ------------------------------------------------------------------------------------------- DOM
const root = document.getElementById("app")!;
root.innerHTML = `<main class="jobs"><h1>Jobs</h1>
  <div class="search"><input name="q" placeholder="Title, company or city"> <label><input type="checkbox" name="remote"> Remote only</label></div>
  <p class="summary"></p><div class="msg"></div><ul class="results"></ul><button type="button" class="more">Load more</button></main>`;
const q = <T extends Element>(s: string) => root.querySelector(s) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
state$.subscribe((s) => {
  q("p.summary").textContent = s.loading ? "Searching…" : `${s.items.length} of ${s.total} jobs${s.q ? ` for “${s.q}”` : ""}`;
  q("div.msg").innerHTML = s.error ? `<p role="alert">${esc(s.error)}</p>` : s.notice ? `<p class="notice">${esc(s.notice)}</p>` : "";
  q("ul.results").innerHTML = s.items
    .map((j) => `<li class="job" data-id="${j.id}"><strong>${esc(j.title)}</strong> · ${esc(j.company)} · ${esc(j.city)}${j.remote ? " · remote" : ""} · $${j.salary}k
      <button type="button" class="save"${s.busy.includes(j.id) ? " disabled" : ""}>${s.saved[j.id] ? "★ Saved" : "☆ Save"}</button>
      ${s.applied.includes(j.id) ? "<em>Applied ✓</em>" : `<button type="button" class="apply"${APPLY_GUARD && s.applying.includes(j.id) ? " disabled" : ""}>${s.applying.includes(j.id) ? "Applying…" : "Quick apply"}</button>`}</li>`)
    .join("");
  const more = q<HTMLButtonElement>("button.more");
  more.disabled = s.loading || s.items.length >= s.total;
  more.textContent = s.loadingMore ? "Loading…" : "Load more";
});
const current = (): Query => ({ q: q<HTMLInputElement>("input[name=q]").value.trim(), remote: q<HTMLInputElement>("input[name=remote]").checked });
q("input[name=q]").addEventListener("input", () => {
  set((s) => ({ ...s, q: current().q }));
  query$.next(current());
});
q("input[name=remote]").addEventListener("change", () => {
  set((s) => ({ ...s, remote: current().remote }));
  query$.next(current());
});
root.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.matches("button.more")) return more$.next();
  const job = state$.value.items.find((j) => j.id === Number(t.closest("li")?.dataset.id));
  if (!job) return;
  if (t.matches("button.save")) void toggleSave(job);
  else if (t.matches("button.apply")) void apply(job);
});
query$.next({ q: "", remote: false });
void api(`/api/saved?limit=50`).then((b) => set((s) => ({ ...s, saved: Object.fromEntries(itemsOf<{ id: number; jobId: number }>(b).map((x) => [x.jobId, x.id])) })), () => undefined);
