// Amateur league match-day desk (React 19 + effector + effector-react useUnit; fetch + WebSocket). Today's round is
// played on six fields at once: the desk kicks matches off (versioned PATCH status=live), records goals as the
// marshals call them in (POST /matches/:id/home|away, relative), takes back a goal that was disallowed
// (homeUndo|awayUndo, −1) and blows the final whistle (versioned PATCH status=final). Field marshals with the app
// also score live, so every match streams in over the live topic. The league table is kept next to the matches and
// counts final results only. Server results reach the stores through GenClass-guarded writes (w4-effector
// guardStore). Latent bugs by flag: goal buttons live while the goal posts (goalGuard=none: a double click scores
// twice — the action is relative), a table updated by hand when a result comes in (standings=incremental: the
// whistle's answer and its push both add the result), pushes and answers applied in arrival order
// (live=blind: an older score overwrites a newer one), the final whistle sent without the version (finalize=force: a
// goal scored meanwhile is signed off unseen) and reconnects that don't reload what was missed (reconnect=naive).
import { createRoot } from "react-dom/client";
import { createEffect, createEvent, createStore, sample } from "effector";
import { useUnit } from "effector-react";
import { flag } from "../_shared/genclass";
import { guardStore } from "../_shared/w4-effector";
import { api, itemsOf, errText, HttpError, liveTopic } from "../_shared/w3-http";

type Status = "scheduled" | "live" | "final";
type Match = { id: number; round: number; field: string; kickoff: string; home: string; away: string; homeGoals: number; awayGoals: number; status: Status; version: number };
type Row = { team: string; p: number; w: number; d: number; l: number; gf: number; ga: number; pts: number };
type League = { matches: Match[]; standings: Row[] };
type Desk = { pending: number[]; live: boolean; error: string; notice: string };
type Side = "home" | "away";

const GOAL_GUARD = flag("goalGuard", "pending") === "pending";
const STANDINGS = flag("standings", "recompute");
const LIVE = flag("live", "version-check");
const FINALIZE = flag("finalize", "if-match");
const RECONNECT = flag("reconnect", "resync");
const TODAY = 3;

// ------------------------------------------------------------------------------------------------- table
const sortTable = (rs: Row[]) => [...rs].sort((a, b) => b.pts - a.pts || b.gf - b.ga - (a.gf - a.ga) || b.gf - a.gf || a.team.localeCompare(b.team));
/** The table with one more final result in it. */
function withResult(rows: Row[], m: Match): Row[] {
  const add = (r: Row, gf: number, ga: number): Row => ({ ...r, p: r.p + 1, w: r.w + (gf > ga ? 1 : 0), d: r.d + (gf === ga ? 1 : 0), l: r.l + (gf < ga ? 1 : 0), gf: r.gf + gf, ga: r.ga + ga, pts: r.pts + (gf > ga ? 3 : gf === ga ? 1 : 0) });
  return sortTable(rows.map((r) => (r.team === m.home ? add(r, m.homeGoals, m.awayGoals) : r.team === m.away ? add(r, m.awayGoals, m.homeGoals) : r)));
}
function table(ms: Match[]): Row[] {
  const teams = [...new Set(ms.flatMap((m) => [m.home, m.away]))];
  return ms.filter((m) => m.status === "final").reduce(withResult, sortTable(teams.map((team) => ({ team, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 }))));
}

// ------------------------------------------------------------------------------------------------ stores
const $league = createStore<League>({ matches: [], standings: [] });
const $desk = createStore<Desk>({ pending: [], live: false, error: "", notice: "" });
const writeLeague = guardStore("league", $league);
const writeDesk = guardStore("desk", $desk);

/** A match from the server (answer or push). */
function upsert(k: League, m: Match, fromPush: boolean): League {
  const cur = k.matches.find((x) => x.id === m.id);
  if (cur && LIVE === "version-check" && Number(m.version) < Number(cur.version)) return k;
  const matches = cur ? k.matches.map((x) => (x.id === m.id ? m : x)) : [...k.matches, m];
  if (STANDINGS === "recompute") return { matches, standings: table(matches) };
  // incremental: a push that turns a match final adds its result (the whistle's own answer adds it in its handler)
  const turnedFinal = fromPush && cur && cur.status !== "final" && m.status === "final";
  return { matches, standings: turnedFinal ? withResult(k.standings, m) : k.standings };
}
const pend = (id: number, on: boolean) => writeDesk((d) => ({ ...d, pending: on ? [...d.pending, id] : d.pending.filter((x) => x !== id) }));
const say = (notice: string) => writeDesk((d) => ({ ...d, notice, error: "" }));
const fail = (e: unknown, what: string) => writeDesk((d) => ({ ...d, error: errText(e, what) }));
const score = (m: Match) => `${m.home} ${m.homeGoals}–${m.awayGoals} ${m.away}`;

// ----------------------------------------------------------------------------------------------- effects
const loadFx = createEffect(async () => itemsOf<Match>(await api("/api/matches?limit=50")));
loadFx.doneData.watch((ms) => writeLeague(() => ({ matches: ms, standings: table(ms) })));
loadFx.failData.watch((e) => fail(e, "loading the fixtures"));

type Goal = { m: Match; side: Side; undo: boolean };
const goalFx = createEffect(async ({ m, side, undo }: Goal) => api<Match>(`/api/matches/${m.id}/${side}${undo ? "Undo" : ""}`, "POST"));
const goalClicked = createEvent<Goal>();
sample({ clock: goalClicked, source: $desk, filter: (d, g) => !(GOAL_GUARD && d.pending.includes(g.m.id)), fn: (_, g) => g, target: goalFx });
goalFx.watch(({ m }) => pend(m.id, true));
goalFx.done.watch(({ params, result }) => {
  writeLeague((k) => upsert(k, result, false));
  say(params.undo ? `Goal taken back — ${score(result)}.` : `Goal ${params.side === "home" ? result.home : result.away}! ${score(result)}.`);
});
goalFx.fail.watch(({ params, error }) => fail(error, `recording the goal in ${params.m.home} v ${params.m.away}`));
goalFx.finally.watch(({ params }) => pend(params.m.id, false));

const statusFx = createEffect(async ({ m, status }: { m: Match; status: Status }) =>
  api<Match>(`/api/matches/${m.id}`, "PATCH", status === "final" && FINALIZE === "force" ? { status } : { status, version: m.version }),
);
const statusClicked = createEvent<{ m: Match; status: Status }>();
sample({ clock: statusClicked, source: $desk, filter: (d, e) => !d.pending.includes(e.m.id), fn: (_, e) => e, target: statusFx });
statusFx.watch(({ m }) => pend(m.id, true));
statusFx.done.watch(({ params, result }) => {
  writeLeague((k) => {
    const next = upsert(k, result, false);
    return STANDINGS === "incremental" && params.status === "final" ? { ...next, standings: withResult(next.standings, result) } : next;
  });
  say(params.status === "final" ? `Full time: ${score(result)}.` : `${result.home} v ${result.away} kicked off on ${result.field}.`);
});
statusFx.fail.watch(({ params, error }) => {
  const cur = error instanceof HttpError && error.status === 409 ? (error.body?.current as Match | undefined) : undefined;
  if (cur) writeLeague((k) => upsert(k, cur, false));
  writeDesk((d) => ({ ...d, error: cur ? `${score(cur)} changed meanwhile — check the score and try again.` : errText(error, params.status === "final" ? "signing off the result" : "kicking off") }));
});
statusFx.finally.watch(({ params }) => pend(params.m.id, false));

// ---------------------------------------------------------------------------------------------------- UI
function MatchRow({ m, busy }: { m: Match; busy: boolean }) {
  const off = GOAL_GUARD && busy;
  return (
    <li className={`match ${m.status}`}>
      <span className="where">
        {m.field} · {m.kickoff}
      </span>{" "}
      <strong className="score">
        {m.home} {m.homeGoals} – {m.awayGoals} {m.away}
      </strong>{" "}
      <span className="state">{m.status === "live" ? "live" : m.status === "final" ? "full time" : "not started"}</span>
      {m.status === "live" && (
        <span className="controls">
          {(["home", "away"] as Side[]).map((side) => (
            <button key={side} type="button" className={`goal ${side}`} disabled={off} onClick={() => goalClicked({ m, side, undo: false })}>
              + {m[side]}
            </button>
          ))}
          {(["home", "away"] as Side[]).map((side) => (
            <button key={side} type="button" className={`undo ${side}`} disabled={off || (side === "home" ? m.homeGoals : m.awayGoals) === 0} onClick={() => goalClicked({ m, side, undo: true })}>
              − {m[side]}
            </button>
          ))}
          <button type="button" className="finalize" disabled={busy} onClick={() => statusClicked({ m, status: "final" })}>
            Full time
          </button>
        </span>
      )}
      {m.status === "scheduled" && (
        <button type="button" className="kickoff" disabled={busy} onClick={() => statusClicked({ m, status: "live" })}>
          Kick off
        </button>
      )}
    </li>
  );
}

function App() {
  const [league, desk] = useUnit([$league, $desk]);
  const today = league.matches.filter((m) => m.round === TODAY).sort((a, b) => a.field.localeCompare(b.field));
  return (
    <main className="league">
      <header>
        <h1>Sunday League · Round {TODAY}</h1>
        <p className="conn">
          {today.filter((m) => m.status === "live").length} live · {desk.live ? "scores streaming" : "reconnecting…"}{" "}
          <button type="button" className="refresh" onClick={() => void loadFx()}>
            Refresh
          </button>
        </p>
      </header>
      {desk.error ? <p role="alert">{desk.error}</p> : desk.notice ? <p className="notice">{desk.notice}</p> : null}
      <ul className="matches">
        {today.map((m) => (
          <MatchRow key={m.id} m={m} busy={desk.pending.includes(m.id)} />
        ))}
      </ul>
      <h2>Table</h2>
      <table className="standings">
        <thead>
          <tr>
            {["#", "Team", "P", "W", "D", "L", "GD", "Pts"].map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {league.standings.map((r, i) => (
            <tr key={r.team} className="team">
              <td>{i + 1}</td>
              <td>{r.team}</td>
              <td>{r.p}</td>
              <td>{r.w}</td>
              <td>{r.d}</td>
              <td>{r.l}</td>
              <td>{r.gf - r.ga}</td>
              <td>{r.pts}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<App />);

let everUp = false;
liveTopic(
  "matches",
  (msg) => {
    if (msg.item) writeLeague((k) => upsert(k, msg.item as Match, true));
  },
  (up) => {
    writeDesk((d) => ({ ...d, live: up }));
    if (up && everUp && RECONNECT === "resync") void loadFx();
    if (up) everUp = true;
  },
);
void loadFx();
