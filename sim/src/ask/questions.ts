// Programmatic developer questions about the current trace (trigger "ask") with exact answers from the sim's
// knowledge. Each question checks that its evidence is present in the situation text the runtime produced, so the
// answer is derivable from what the model sees. Phrasings, option sets and thresholds are randomised.

import type { AskRec } from "../run/runner.js";
import type { Rng } from "../rng.js";
import type { Label, Question } from "../types.js";

export interface AskQ {
  qid: string;
  question: Question;
  label: Label;
  kind: string;
}

type Gen = (a: AskRec, text: string, rng: Rng) => AskQ | null;

const yes = (p: boolean): Label => ({ type: "noul", p: p ? 1 : 0 });
const pathOf = (sig: string) => sig.split(" ").slice(1).join(" ");

function noul(instructions: string, t?: string, f?: string): Question {
  const q: Question = { type: "noul", instructions };
  if (t || f) q.criteria = { ...(t ? { true: t } : {}), ...(f ? { false: f } : {}) };
  return q;
}

const failedRecent = (a: AskRec, win: number) => a.facts.recent.filter((r) => (r.outcome === "http-error" && (r.status ?? 0) >= 400) || r.outcome === "neterr").filter((r) => r.td >= a.facts.now - win);

const GENS: Record<string, Gen> = {
  write_inflight(a, _text, rng) {
    const yesAns = a.facts.inflight.some((x) => x.write);
    const q = rng.pick([
      "Is any write request (POST, PUT, PATCH or DELETE) still in flight?",
      "Is the app currently waiting on a request that changes data on the server?",
      "Are there unfinished save/update requests right now?",
    ]);
    return { qid: "q_write_inflight", question: noul(q, "yes, a write is in flight", "no write is in flight"), label: yes(yesAns), kind: "write_inflight" };
  },
  any_inflight(a, _t, rng) {
    const q = rng.pick(["Is any network request in flight right now?", "Is the app waiting for any response from the server?", "Are requests still pending?"]);
    return { qid: "q_any_inflight", question: noul(q), label: yes(a.facts.inflight.length > 0), kind: "any_inflight" };
  },
  pending_count(a, _t, rng) {
    const n = a.facts.inflight.length;
    if (n > 6) return null;
    const crit = rng.bool(0.5) ? ["none", "one", "two", "three or more"] : ["0 requests", "1 request", "2 requests", "3+ requests"];
    const q = rng.pick(["How many requests are pending?", "How many network requests are currently in flight?", "Count the unfinished requests."]);
    return { qid: "q_pending", question: { type: "score", instructions: q, criteria: crit }, label: { type: "score", level: Math.min(3, n) }, kind: "pending_count" };
  },
  last_failed(a, text, rng) {
    const fails = failedRecent(a, 12000).sort((x, y) => x.td - y.td);
    const last = fails[fails.length - 1];
    const sigs = [...new Set(a.facts.recent.map((r) => r.sig).concat(a.facts.inflight.map((r) => r.sig)))];
    if (sigs.length < 2) return null;
    if (last && !text.includes(pathOf(last.sig).split("/").filter((s) => s && !s.startsWith(":")).slice(-1)[0] ?? "")) return null;
    let opts = rng.sample(sigs.filter((s) => s !== last?.sig), 3);
    if (last) opts = rng.shuffle([last.sig, ...opts.slice(0, 2)]);
    const none = rng.pick(["none of these", "no request failed", "nothing failed recently"]);
    const crit: Record<string, string | null> = {};
    const ids: Record<string, string> = {};
    opts.forEach((s, i) => {
      const id = `e${i + 1}`;
      crit[id] = s;
      ids[s] = id;
    });
    crit.none = none;
    const q = rng.pick(["Which endpoint failed most recently?", "Which request was the last one to fail?", "What is the most recent failing endpoint?"]);
    return { qid: "q_last_failed", question: { type: "choice", instructions: q, criteria: crit }, label: { type: "choice", label: last ? ids[last.sig]! : "none" }, kind: "last_failed" };
  },
  recent_failure(a, _t, rng) {
    const win = rng.pick([5, 10]);
    const q = rng.pick([`Has any request failed in the last ${win} seconds?`, `Did a request fail within the past ${win} s?`, `Any failed requests in the last ${win} seconds?`]);
    const f = failedRecent(a, win * 1000);
    // Borderline timing (within 1 s of the window edge) is ambiguous for relative timestamps: skip.
    if (f.some((r) => Math.abs(a.facts.now - r.td - win * 1000) < 1000)) return null;
    return { qid: "q_recent_failure", question: noul(q), label: yes(f.length > 0), kind: "recent_failure" };
  },
  fail_count(a, _t, rng) {
    const n = failedRecent(a, 10000).length;
    if (failedRecent(a, 11000).length !== failedRecent(a, 9000).length) return null;
    const q = rng.pick(["How many requests failed in the last 10 seconds?", "Count the failed requests in the past 10 s."]);
    return { qid: "q_fail_count", question: { type: "score", instructions: q, criteria: ["none", "one", "two", "three or more"] }, label: { type: "score", level: Math.min(3, n) }, kind: "fail_count" };
  },
  user_waiting(a, _t, rng) {
    const n = rng.pick([1, 2, 3, 5]);
    const w = a.facts.userWaitingMs;
    if (Math.abs(w - n * 1000) < 400) return null;
    const q = rng.pick([`Has the user been waiting more than ${n} seconds for a response?`, `Is a user-triggered request taking longer than ${n} s?`, `Has the user waited over ${n} seconds on something they started?`]);
    return { qid: "q_user_waiting", question: noul(q), label: yes(w > n * 1000), kind: "user_waiting" };
  },
  user_recent(a, _t, rng) {
    const n = rng.pick([1, 2, 3]);
    const since = a.facts.lastUserAt < 0 ? Infinity : a.facts.now - a.facts.lastUserAt;
    if (Math.abs(since - n * 1000) < 300) return null;
    const q = rng.pick([`Did the user do something in the last ${n} seconds?`, `Was there user input within the past ${n} s?`, `Has the user interacted in the last ${n} seconds?`]);
    return { qid: "q_user_recent", question: noul(q), label: yes(since < n * 1000), kind: "user_recent" };
  },
  last_save(a, _t, rng) {
    if (!a.facts.lastSave) return null;
    const q = rng.pick(["Did the last save succeed?", "Was the most recent save successful?", "Did the latest save go through?"]);
    return { qid: "q_last_save", question: noul(q, "the last save succeeded", "the last save failed"), label: yes(a.facts.lastSave.ok), kind: "last_save" };
  },
  route(a, text, rng) {
    if (!text.includes(a.facts.route)) return null;
    const others = ["/settings", "/home", "/dashboard", "/inbox", "/account", "/reports", "/checkout", "/search"].filter((r) => r !== a.facts.route);
    const opts = rng.shuffle([a.facts.route, ...rng.sample(others, 2)]);
    const crit: Record<string, string | null> = {};
    let gold = "";
    opts.forEach((r, i) => {
      crit[`r${i + 1}`] = r;
      if (r === a.facts.route) gold = `r${i + 1}`;
    });
    const q = rng.pick(["Which page is the user on?", "What route is currently open?", "Which view is active?"]);
    return { qid: "q_route", question: { type: "choice", instructions: q, criteria: crit }, label: { type: "choice", label: gold }, kind: "route" };
  },
  slowest(a, text, rng) {
    const fl = a.facts.inflight.filter((x) => x.age > 0);
    if (fl.length < 2) return null;
    const sorted = fl.slice().sort((x, y) => y.age - x.age);
    if (sorted[0]!.age - sorted[1]!.age < 300 || sorted[0]!.sig === sorted[1]!.sig) return null;
    if (!sorted.every((x) => text.includes(pathOf(x.sig).split("/").filter((s) => s && !s.startsWith(":")).slice(-1)[0] ?? "#"))) return null;
    const uniq = [...new Set(sorted.map((x) => x.sig))].slice(0, 4);
    const crit: Record<string, string | null> = {};
    let gold = "";
    rng.shuffle(uniq).forEach((s, i) => {
      crit[`o${i + 1}`] = s;
      if (s === sorted[0]!.sig) gold = `o${i + 1}`;
    });
    const q = rng.pick(["Which in-flight request has been running the longest?", "Which pending request started earliest?"]);
    return { qid: "q_slowest", question: { type: "choice", instructions: q, criteria: crit }, label: { type: "choice", label: gold }, kind: "slowest" };
  },
};

export function askQuestions(a: AskRec, rng: Rng): AskQ[] {
  const text = JSON.stringify(a.state);
  const names = rng.shuffle(Object.keys(GENS));
  const want = rng.int(1, 3);
  const out: AskQ[] = [];
  for (const n of names) {
    if (out.length >= want) break;
    const q = GENS[n]!(a, text, rng.fork(n));
    if (q) out.push(q);
  }
  return out;
}
