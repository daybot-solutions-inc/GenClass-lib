// Live classroom quiz, student view (RxJS 7 over a runtime atom; vanilla DOM). The teacher's current question is a
// live doc (rxjs/webSocket on docs/quiz); students pick an option and may change it while the question is open
// (POST /answers the first time — one per student and question — then PATCH it). Applause is a shared live counter
// and the leaderboard polls. Latent bugs by flag: answer clicks flattened with mergeMap (answerMap=mergeMap: a quick
// change of mind PATCHes out of order and a double click POSTs twice) or exhaustMap (answerMap=exhaustMap: a change
// made while the first answer posts is dropped), leaderboard polls with mergeMap (leaderboard=mergeMap: a slow
// answer overwrites a newer one), applause counted per push instead of taking the server's value (claps=local-add:
// your own claps count twice), reconnects that don't reload the question (reconnect=naive) and answers sent without
// a timeout/retry (answerRetry=none: a hung request leaves "Sending…" until the gateway gives up).
import { EMPTY, Subject, defer, merge, of, throwError, timer } from "rxjs";
import { catchError, concatMap, exhaustMap, finalize, map, mergeMap, retry, switchMap, tap, timeout } from "rxjs/operators";
import { ajax } from "rxjs/ajax";
import { fromFetch } from "rxjs/fetch";
import { webSocket } from "rxjs/webSocket";
import { rt, flag } from "../_shared/genclass";

type Doc = { qid: string; question: string; options: string[]; open: boolean };
type Answer = { id: number; qid: string; choice: string; student: string; key: string };
type Score = { id: number; name: string; points: number };
const ANSWER_MAP = flag("answerMap", "concatMap") as "concatMap" | "mergeMap" | "exhaustMap";
const BOARD = flag("leaderboard", "switchMap");
const CLAPS = flag("claps", "server-value");
const RECONNECT = flag("reconnect", "resync");
const ANSWER_RETRY = flag("answerRetry", "timeout-retry");
const ME = "you";

const quiz = rt.atom("quiz", { qid: "", question: "", options: [] as string[], open: false, mine: {} as Record<string, Answer>, sending: 0, claps: 0, board: [] as Score[], live: false, error: "", notice: "" });
type Q = ReturnType<typeof quiz.get>;
const json = <T>(url: string) => fromFetch(url, { selector: (r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(String(r.status)))) });
const wsUrl = (topic: string) => `${location.origin.replace(/^http/, "ws")}/ws/${topic}`;
const statusOf = (e: any) => Number(e?.status ?? 0);

const applyDoc = (d: Partial<Doc>) => quiz.update((q) => ({ ...q, qid: d.qid ?? q.qid, question: d.question ?? q.question, options: d.options ?? q.options, open: d.open ?? q.open }));
const loadQuiz = () => json<Doc>("/api/docs/quiz").pipe(catchError(() => (quiz.update((q) => ({ ...q, error: q.question ? q.error : "The quiz could not be loaded." })), EMPTY))).subscribe(applyDoc);
const loadClaps = () => json<{ value: number }>("/api/counters/claps").pipe(catchError(() => EMPTY)).subscribe((c) => quiz.update((q) => ({ ...q, claps: c.value })));
const loadMine = () =>
  json<{ items: Answer[] }>(`/api/answers?student=${ME}&limit=50`)
    .pipe(catchError(() => EMPTY))
    .subscribe((b) => quiz.update((q) => ({ ...q, mine: Object.fromEntries((b.items ?? []).map((a) => [a.qid, a])) })));

// ------------------------------------------------------------------------------------------- answers
type Pick = { qid: string; choice: string };
const picks$ = new Subject<Pick>();
function send(p: Pick) {
  return defer(() => {
    const prev = quiz.get().mine[p.qid];
    quiz.update((q) => ({ ...q, sending: q.sending + 1, error: "", notice: "" }));
    const req$ = prev
      ? ajax<Answer>({ url: `/api/answers/${prev.id}`, method: "PATCH", headers: { "content-type": "application/json" }, body: { choice: p.choice } })
      : ajax<Answer>({ url: "/api/answers", method: "POST", headers: { "content-type": "application/json" }, body: { qid: p.qid, choice: p.choice, student: ME, key: `${ME}:${p.qid}` } });
    const guarded$ = ANSWER_RETRY === "timeout-retry" ? req$.pipe(timeout(5000), retry({ count: 1, delay: (e) => (statusOf(e) === 0 || statusOf(e) >= 500 ? timer(400) : throwError(() => e)) })) : req$;
    return guarded$.pipe(
      map((r) => r.response),
      tap((saved) => quiz.update((q) => ({ ...q, mine: { ...q.mine, [saved.qid]: saved }, notice: `Answer saved: ${saved.choice}.` }))),
      catchError((e) => {
        if (statusOf(e) === 409) {
          loadMine();
          quiz.update((q) => ({ ...q, error: "Your answer was already recorded — showing the saved one." }));
        } else quiz.update((q) => ({ ...q, error: `Your answer did not go through (${statusOf(e) || "offline"}).` }));
        return EMPTY;
      }),
      finalize(() => quiz.update((q) => ({ ...q, sending: q.sending - 1 }))),
    );
  });
}
const flatten = ANSWER_MAP === "mergeMap" ? mergeMap(send) : ANSWER_MAP === "exhaustMap" ? exhaustMap(send) : concatMap(send);
picks$.pipe(flatten).subscribe();

// ------------------------------------------------------------------------------------------- applause
const claps$ = new Subject<void>();
claps$
  .pipe(
    tap(() => quiz.update((q) => ({ ...q, claps: q.claps + 1 }))),
    mergeMap(() => ajax<{ value: number }>({ url: "/api/counters/claps/incr", method: "POST", headers: { "content-type": "application/json" }, body: { by: 1 } }).pipe(catchError(() => EMPTY))),
  )
  .subscribe((r) => {
    if (CLAPS === "server-value") quiz.update((q) => ({ ...q, claps: Math.max(q.claps, r.response.value) }));
  });

// ------------------------------------------------------------------------------------------- leaderboard
const refresh$ = new Subject<void>();
const fetchBoard = () => json<{ items: Score[] }>("/api/scores?sort=-points&limit=5").pipe(catchError(() => EMPTY));
merge(timer(0, 4000), refresh$)
  .pipe(BOARD === "switchMap" ? switchMap(fetchBoard) : mergeMap(fetchBoard))
  .subscribe((b) => quiz.update((q) => ({ ...q, board: b.items ?? [] })));

// ------------------------------------------------------------------------------------------- live
let opened = 0;
webSocket<{ item?: Partial<Doc> }>({
  url: wsUrl("docs/quiz"),
  openObserver: {
    next: () => {
      opened++;
      quiz.update((q) => ({ ...q, live: true }));
      if (opened > 1 && RECONNECT === "resync") {
        loadQuiz();
        loadClaps();
      }
    },
  },
  closeObserver: { next: () => quiz.update((q) => ({ ...q, live: false })) },
})
  .pipe(retry({ delay: 2000 }))
  .subscribe((m) => m.item && applyDoc(m.item));
webSocket<{ value: number }>({ url: wsUrl("counters/claps") })
  .pipe(retry({ delay: 2000 }))
  .subscribe((m) => quiz.update((q) => ({ ...q, claps: CLAPS === "server-value" ? m.value : q.claps + 1 })));

// ------------------------------------------------------------------------------------------- view
const root = document.getElementById("app")!;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
root.innerHTML = `<main class="quiz"><h1>Live quiz</h1><p class="conn"></p><section class="question"></section><div class="msg"></div>
  <p class="applause"><button type="button" class="clap">👏 Clap</button> <span class="claps"></span></p>
  <section class="board"><h2>Leaderboard <button type="button" class="refresh-board">Refresh</button></h2><ol></ol></section></main>`;
const $ = (s: string) => root.querySelector(s) as HTMLElement;
function render(q: Q) {
  $(".conn").textContent = q.live ? "live" : "reconnecting…";
  const mine = q.mine[q.qid];
  $(".question").innerHTML = q.question
    ? `<h2>${esc(q.question)}</h2><div class="options">${q.options.map((o, i) => `<button type="button" class="option${mine?.choice === o ? " chosen" : ""}" data-i="${i}"${q.open ? "" : " disabled"}>${"ABCD"[i]}) ${esc(o)}</button>`).join(" ")}</div>
       <p class="status">${!q.open ? "Answers are closed." : q.sending ? "Sending…" : mine ? `Your answer: ${esc(mine.choice)} (you can still change it)` : "Pick an answer."}</p>`
    : "<p>Waiting for the teacher…</p>";
  $(".msg").innerHTML = q.error ? `<p role="alert">${esc(q.error)}</p>` : q.notice ? `<p class="notice">${esc(q.notice)}</p>` : "";
  $(".claps").textContent = `${q.claps} claps`;
  $(".board ol").innerHTML = q.board.map((s) => `<li class="score${s.name === ME ? " me" : ""}">${esc(s.name)} · ${s.points} pts</li>`).join("");
}
quiz.subscribe(render);
render(quiz.get());
root.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const opt = t.closest("button.option") as HTMLButtonElement | null;
  if (opt && !opt.disabled) {
    const q = quiz.get();
    picks$.next({ qid: q.qid, choice: q.options[Number(opt.dataset.i)]! });
  } else if (t.closest("button.clap")) claps$.next();
  else if (t.closest("button.refresh-board")) refresh$.next();
});

loadQuiz();
loadClaps();
loadMine();
