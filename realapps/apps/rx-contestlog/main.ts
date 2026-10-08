// Field Day contest logger (RxJS 7 streams over a runtime atom; vanilla DOM; fromFetch + rxjs/webSocket). The operator
// types a callsign and the logger checks it against the log for the current band (debounced GET /qsos?call=&band=)
// to flag dupes; "Log" posts the contact (one per call|band|mode: a dupe answers 409) and adds its points to the club
// score (a shared live counter that the second station increments too). The recent log shows the current band
// newest first, eight at a time ("Older" follows the cursor). Latent bugs by flag: dupe checks flattened with mergeMap
// (dupeCheck=mergeMap: the answer for "K1A" lands after the one for "K1ABC" and says "new"), no debounce (debounce=0: a
// request per keystroke), Log clicks flattened with mergeMap (logFlatten=mergeMap: a double click posts twice and the
// second one reports a dupe over a logged contact), a score kept by hand (score=local: own points are added once on
// logging and again when the counter push arrives, pushes missed while offline are lost) and the cursor kept across a
// band switch (older=keep-cursor: "Older" pages the previous band or comes back empty and hides the button).
import { EMPTY, Observable, Subject, defer, identity, of } from "rxjs";
import { catchError, debounceTime, exhaustMap, finalize, map, mergeMap, retry, switchMap, tap } from "rxjs/operators";
import { fromFetch } from "rxjs/fetch";
import { webSocket } from "rxjs/webSocket";
import { rt, flag } from "../_shared/genclass";
import { HttpError, errText, itemsOf } from "../_shared/w3-http";

type Qso = { id: number; call: string; band: string; mode: string; rst: string; points: number; op: string; key: string };
type Check = { call: string; band: string; mode: string; state: "idle" | "checking" | "new" | "dupe" | "unknown"; worked: string[] };
const DUPE = flag("dupeCheck", "switchMap");
const DEBOUNCE = Number(flag("debounce", 300));
const LOG_FLATTEN = flag("logFlatten", "exhaustMap");
const SCORE = flag("score", "server");
const OLDER = flag("older", "reset-on-band");
const ME = "you";
const ptsOf = (mode: string) => (mode === "SSB" ? 1 : 2);
const rstOf = (mode: string) => (mode === "CW" ? "599" : mode === "FT8" ? "-10" : "59");

const log = rt.atom("log", {
  band: "20m",
  mode: "SSB",
  call: "",
  check: { call: "", band: "", mode: "", state: "idle", worked: [] } as Check,
  rows: [] as Qso[],
  cursor: null as string | null,
  loading: true,
  loadingOlder: false,
  logging: 0,
  score: 0,
  live: false,
  error: "",
  notice: "",
});
type Log = ReturnType<typeof log.get>;
const set = (fn: (s: Log) => Log) => log.update(fn);

function json$<T>(url: string, method = "GET", body?: unknown): Observable<T> {
  return fromFetch(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    selector: async (r) => {
      const data = r.status === 204 ? null : await r.json().catch(() => null);
      if (!r.ok) throw new HttpError(r.status, data);
      return data as T;
    },
  });
}

// ------------------------------------------------------------------------------------------- dupe check
type Probe = { call: string; band: string; mode: string };
const probe$ = new Subject<Probe>();
const check = (p: Probe) =>
  json$<{ items: Qso[] }>(`/api/qsos?call=${encodeURIComponent(p.call)}&band=${p.band}&limit=10`).pipe(
    map((b): Check => {
      const worked = itemsOf<Qso>(b).map((q) => q.mode);
      return { ...p, state: worked.includes(p.mode) ? "dupe" : "new", worked };
    }),
    catchError(() => of<Check>({ ...p, state: "unknown", worked: [] })),
  );
probe$
  .pipe(
    DEBOUNCE > 0 ? debounceTime(DEBOUNCE) : identity,
    tap((p) => set((s) => ({ ...s, check: p.call.length >= 3 ? { ...p, state: "checking", worked: [] } : { call: "", band: "", mode: "", state: "idle", worked: [] } }))),
    DUPE === "switchMap" ? switchMap((p: Probe) => (p.call.length >= 3 ? check(p) : EMPTY)) : mergeMap((p: Probe) => (p.call.length >= 3 ? check(p) : EMPTY)),
  )
  .subscribe((c) => set((s) => ({ ...s, check: c })));
const reprobe = () => {
  const s = log.get();
  probe$.next({ call: s.call, band: s.band, mode: s.mode });
};

// ------------------------------------------------------------------------------------------- logging
type Entry = { call: string; band: string; mode: string };
const submit$ = new Subject<Entry>();
let lastPush = -1;
const score$ = new Subject<number>();
score$.pipe(mergeMap((by) => json$<{ value: number }>(`/api/counters/points/incr`, "POST", { by }).pipe(catchError(() => EMPTY)))).subscribe((r) => {
  if (SCORE === "server") set((s) => ({ ...s, score: Math.max(s.score, r.value) }));
});
const post = (e: Entry) =>
  defer(() => {
    set((s) => ({ ...s, logging: s.logging + 1, error: "", notice: "" }));
    const points = ptsOf(e.mode);
    return json$<Qso>(`/api/qsos`, "POST", { ...e, rst: rstOf(e.mode), points, op: ME, key: `${e.call}|${e.band}|${e.mode}` }).pipe(
      tap((q) => {
        callInput.value = "";
        set((s) => ({
          ...s,
          call: s.call === e.call ? "" : s.call,
          check: { call: "", band: "", mode: "", state: "idle", worked: [] },
          rows: q.band === s.band && !s.rows.some((r) => r.id === q.id) ? [q, ...s.rows] : s.rows,
          score: SCORE === "local" ? s.score + points : s.score,
          notice: `Logged ${q.call} on ${q.band} ${q.mode} (+${points}).`,
        }));
        score$.next(points);
      }),
      catchError((err) => {
        const dupe = err instanceof HttpError && err.status === 409;
        set((s) => ({ ...s, error: dupe ? `${e.call} is already in the log on ${e.band} ${e.mode} — dupe, not logged.` : errText(err, `logging ${e.call}`) }));
        return EMPTY;
      }),
      finalize(() => set((s) => ({ ...s, logging: s.logging - 1 }))),
    );
  });
submit$.pipe(LOG_FLATTEN === "exhaustMap" ? exhaustMap(post) : mergeMap(post)).subscribe();

// ------------------------------------------------------------------------------------------- recent log
const band$ = new Subject<string>();
const page = (band: string, cursor: string) => json$<{ items: Qso[]; nextCursor: string | null }>(`/api/qsos?band=${band}&sort=-createdAt&limit=8&cursor=${encodeURIComponent(cursor)}`);
band$
  .pipe(
    tap(() => set((s) => ({ ...s, loading: true, error: "" }))),
    switchMap((band) =>
      page(band, "").pipe(
        map((b) => ({ band, b })),
        catchError((e) => (set((s) => ({ ...s, loading: false, error: errText(e, `loading the ${band} log`) })), EMPTY)),
      ),
    ),
  )
  .subscribe(({ band, b }) => set((s) => (s.band !== band ? s : { ...s, rows: itemsOf<Qso>(b), cursor: b.nextCursor ?? null, loading: false })));

const older$ = new Subject<void>();
older$
  .pipe(
    exhaustMap(() =>
      defer(() => {
        const s0 = log.get();
        if (!s0.cursor) return EMPTY;
        const band = s0.band;
        set((s) => ({ ...s, loadingOlder: true, error: "" }));
        return page(band, s0.cursor).pipe(
          tap((b) =>
            set((s) => {
              if (OLDER === "reset-on-band" && s.band !== band) return s;
              const have = new Set(s.rows.map((r) => r.id));
              return { ...s, rows: [...s.rows, ...itemsOf<Qso>(b).filter((q) => !have.has(q.id))], cursor: b.nextCursor ?? null };
            }),
          ),
          catchError((e) => (set((s) => ({ ...s, error: errText(e, "loading older contacts") })), EMPTY)),
          finalize(() => set((s) => ({ ...s, loadingOlder: false }))),
        );
      }),
    ),
  )
  .subscribe();

// ------------------------------------------------------------------------------------------- live score
const loadScore = () => json$<{ value: number }>(`/api/counters/points`).pipe(catchError(() => EMPTY)).subscribe((c) => {
  lastPush = c.value;
  set((s) => ({ ...s, score: c.value }));
});
let opened = 0;
webSocket<{ value: number }>({
  url: `${location.origin.replace(/^http/, "ws")}/ws/counters/points`,
  openObserver: {
    next: () => {
      opened++;
      set((s) => ({ ...s, live: true }));
      if (opened > 1 && SCORE === "server") loadScore();
    },
  },
  closeObserver: { next: () => set((s) => ({ ...s, live: false })) },
})
  .pipe(retry({ delay: 2000 }))
  .subscribe((m) => {
    if (typeof m.value !== "number") return;
    const delta = lastPush < 0 ? 0 : m.value - lastPush;
    lastPush = m.value;
    set((s) => ({ ...s, score: SCORE === "server" ? Math.max(s.score, m.value) : s.score + delta }));
  });

// ------------------------------------------------------------------------------------------- view
const root = document.getElementById("app")!;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
root.innerHTML = `<main class="contest"><header><h1>Field Day 2026 · VE3UW 2A ON</h1><p class="score"></p></header>
  <form class="entry"><select name="band" aria-label="Band">${["20m", "40m", "15m", "10m"].map((b) => `<option>${b}</option>`).join("")}</select>
    <select name="mode" aria-label="Mode">${["SSB", "CW", "FT8"].map((m) => `<option>${m}</option>`).join("")}</select>
    <input name="call" placeholder="Callsign" autocomplete="off" aria-label="Callsign"> <button type="submit" class="log">Log</button>
    <p class="check"></p></form>
  <div class="msg"></div><h2 class="recent"></h2><ol class="qsos"></ol><button type="button" class="older">Older</button></main>`;
const $ = <T extends Element>(s: string) => root.querySelector(s) as T;
const callInput = $<HTMLInputElement>("input[name=call]");
function checkText(s: Log): string {
  const c = s.check;
  if (c.state === "idle" || !c.call) return "Type a callsign.";
  if (c.state === "checking") return `Checking ${c.call}…`;
  if (c.state === "unknown") return `${c.call}: dupe check unavailable — log anyway.`;
  if (c.state === "dupe") return `${c.call}: DUPE on ${c.band} ${c.mode}`;
  return `${c.call}: new on ${c.band} ${c.mode} (+${ptsOf(c.mode)})${c.worked.length ? ` · already worked on ${c.band} ${c.worked.join("/")}` : ""}`;
}
function render(s: Log) {
  $("p.score").textContent = `Club score ${s.score} pts · ${s.live ? "live" : "reconnecting…"}`;
  $<HTMLSelectElement>("select[name=band]").value = s.band;
  $<HTMLSelectElement>("select[name=mode]").value = s.mode;
  $("p.check").textContent = s.logging ? "Logging…" : checkText(s);
  $("div.msg").innerHTML = s.error ? `<p role="alert">${esc(s.error)}</p>` : s.notice ? `<p class="notice">${esc(s.notice)}</p>` : "";
  $("h2.recent").textContent = s.loading ? `Loading ${s.band}…` : `Recent contacts on ${s.band}`;
  $("ol.qsos").innerHTML = s.rows.map((q) => `<li class="qso" data-id="${q.id}">${esc(q.call)} · ${q.band} ${q.mode} · ${esc(q.rst)} · ${q.points} pt · ${esc(q.op)}</li>`).join("") || `<li class="empty">No contacts on ${s.band} yet.</li>`;
  const older = $<HTMLButtonElement>("button.older");
  older.disabled = s.loadingOlder || !s.cursor;
  older.textContent = s.loadingOlder ? "Loading…" : s.cursor ? "Older" : "Start of log";
}
log.subscribe(render);
render(log.get());

callInput.addEventListener("input", () => {
  const call = callInput.value.trim().toUpperCase();
  set((s) => ({ ...s, call }));
  reprobe();
});
root.addEventListener("change", (e) => {
  const t = e.target as HTMLSelectElement;
  if (t.matches("select[name=band]")) {
    set((s) => (OLDER === "reset-on-band" ? { ...s, band: t.value, rows: [], cursor: null } : { ...s, band: t.value }));
    band$.next(t.value);
    reprobe();
  } else if (t.matches("select[name=mode]")) {
    set((s) => ({ ...s, mode: t.value }));
    reprobe();
  }
});
$("form.entry").addEventListener("submit", (e) => {
  e.preventDefault();
  const s = log.get();
  const call = callInput.value.trim().toUpperCase();
  if (call.length < 3) return;
  submit$.next({ call, band: s.band, mode: s.mode });
});
root.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).matches("button.older")) older$.next();
});
band$.next("20m");
loadScore();
