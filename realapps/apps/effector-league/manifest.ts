import type { AppManifest } from "../../src/shared/manifest.js";

const teams = ["Riverside Rovers", "Hilltop United", "Old Mill Athletic", "Harbour Town", "Northgate Wanderers", "Saint Jude's", "Canal Street", "Parkside Celtic", "Orchard Lane", "Brickworks City", "Lakeside Albion", "Station Road"];
const rounds: [number, number, number, number][][] = [
  [[0, 1, 2, 1], [2, 3, 0, 0], [4, 5, 3, 2], [6, 7, 1, 4], [8, 9, 2, 2], [10, 11, 0, 1]],
  [[1, 2, 1, 1], [3, 4, 2, 0], [5, 6, 0, 3], [7, 8, 2, 1], [9, 10, 1, 0], [11, 0, 2, 2]],
  [[0, 2, 1, 0], [1, 3, 0, 0], [4, 6, 2, 1], [5, 7, 0, 1], [8, 10, 0, 0], [9, 11, 0, 0]],
];
const matches = rounds.flatMap((games, r) =>
  games.map(([h, a, hg, ag], i) => {
    const today = r === 2;
    const status = !today ? "final" : i < 4 ? "live" : "scheduled";
    return { id: 400 + r * 10 + i, round: r + 1, field: `Field ${i + 1}`, kickoff: today && i >= 4 ? "11:30" : "10:00", home: teams[h], away: teams[a], homeGoals: hg, awayGoals: ag, status };
  }),
);

type M = { home: string; away: string; homeGoals: number; awayGoals: number; status: string };
type R = { team: string; p: number; w: number; d: number; l: number; gf: number; ga: number; pts: number };

const manifest: AppManifest = {
  name: "effector-league",
  title: "League match day",
  framework: "react",
  libs: ["react", "effector", "effector-react", "createEffect", "sample", "useUnit", "fetch", "WebSocket", "rt.guard"],
  domain: "amateur-sports-league",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      {
        name: "matches",
        seed: matches,
        versioned: true,
        live: true,
        filters: ["round", "status"],
        envelope: "items",
        pageSize: 50,
        actions: { home: { inc: "homeGoals", by: 1 }, away: { inc: "awayGoals", by: 1 }, homeUndo: { inc: "homeGoals", by: -1 }, awayUndo: { inc: "awayGoals", by: -1 } },
      },
    ],
  },
  variants: {
    goalGuard: ["pending", "none"],
    standings: ["recompute", "incremental"],
    live: ["version-check", "blind"],
    finalize: ["if-match", "force"],
    reconnect: ["resync", "naive"],
  },
  affordances: [
    { id: "goal", kind: "click", sel: "li.match.live button.goal", nth: 8, weight: 4, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.2, requires: "li.match.live button.goal:not([disabled])" },
    { id: "undo", kind: "click", sel: "li.match.live button.undo", nth: 8, weight: 0.7, mode: "accumulate", intent: "nth", requires: "li.match.live button.undo:not([disabled])" },
    { id: "finalize", kind: "click", sel: "li.match.live button.finalize", nth: 4, weight: 0.25, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.2, requires: "li.match.live button.finalize:not([disabled])" },
    { id: "kickoff", kind: "click", sel: "li.match.scheduled button.kickoff", nth: 2, weight: 0.6, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: "li.match.scheduled button.kickoff:not([disabled])" },
    { id: "refresh", kind: "click", sel: "button.refresh", weight: 0.3, mode: "replace", dblclickP: 0.1 },
  ],
  external: [
    { kind: "action", target: "matches", verb: "home", perMin: 2.5, where: { status: "live" } },
    { kind: "action", target: "matches", verb: "away", perMin: 2.5, where: { status: "live" } },
    { kind: "update", target: "matches", perMin: 0.8, where: { status: "scheduled" }, data: [{ status: "live" }] },
    { kind: "update", target: "matches", perMin: 0.2, where: { status: "live" }, data: [{ status: "final" }] },
  ],
  weights: { "desk.error": 0, "desk.notice": 0, "desk.pending": 0.1, "desk.live": 0.1 },
  relations: [
    {
      name: "table = final results",
      fields: ["league.standings", "league.matches"],
      check: (s) => {
        const k = s.league;
        if (!k || !k.matches.length) return true;
        const want = new Map<string, R>();
        const row = (t: string) => want.get(t) ?? want.set(t, { team: t, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 }).get(t)!;
        for (const m of k.matches as M[]) {
          row(m.home);
          row(m.away);
          if (m.status !== "final") continue;
          for (const [t, gf, ga] of [[m.home, m.homeGoals, m.awayGoals], [m.away, m.awayGoals, m.homeGoals]] as [string, number, number][]) {
            const r = row(t);
            r.p++;
            r.gf += gf;
            r.ga += ga;
            if (gf > ga) (r.w++, (r.pts += 3));
            else if (gf === ga) (r.d++, r.pts++);
            else r.l++;
          }
        }
        return (k.standings as R[]).length === want.size && (k.standings as R[]).every((r) => {
          const w = want.get(r.team);
          return !!w && w.p === r.p && w.w === r.w && w.d === r.d && w.l === r.l && w.gf === r.gf && w.ga === r.ga && w.pts === r.pts;
        });
      },
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
