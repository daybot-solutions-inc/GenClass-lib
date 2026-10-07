// A realistic, scripted GenClass session for the devtools screenshots and UI tests: a store app with a search
// typeahead (out-of-order responses), checkout (double submit), cart (an unusual transition and a broken
// derived total), a flaky status poll and a stalled request. All numbers are illustrative.

import type { Explanation, Situation } from "../../../src/types.js";
import { makeAction, makeDecision, type MockRuntime } from "./mock-runtime.js";

export interface ScenarioOptions {
  onUndo?: (actionId: string) => void;
  /** Clock time the screenshots are taken at (drives "12s ago"). Default 27_400. */
  now?: number;
}

const MODEL = "genclass-runtime-0.1 · fp16";

/** Render a Jev state like the runtime's serializer: "key:\nvalue" blocks, arrays one item per line. */
function stateText(state: Record<string, unknown>): string {
  return Object.entries(state)
    .map(([k, v]) => `${k}:\n${Array.isArray(v) ? v.join("\n") : String(v)}`)
    .join("\n\n");
}

function explanation(d: ReturnType<typeof makeDecision>, state: Record<string, unknown>, a?: ReturnType<typeof makeAction>): Explanation {
  return {
    decision: d,
    situationText: stateText(state),
    facts: d.facts,
    timeline: (state.timeline as string[]) ?? [],
    answers: d.answers,
    action: a,
    changed: a?.changed,
  };
}

export function loadScenario(rt: MockRuntime, opts: ScenarioOptions = {}): void {
  const ev = (t: number, kind: Parameters<MockRuntime["event"]>[0], name: string, extra: { op?: number; cause?: number; data?: Record<string, unknown> } = {}) =>
    rt.event(kind, name, { t, ...extra });
  const fetchStart = (t: number, op: number, name: string, detail?: string, cause?: number) =>
    ev(t, "op.start", name, { op, cause, data: { kind: "fetch", ...(detail ? { detail } : {}) } });
  const fetchEnd = (t: number, op: number, name: string, code: number, detail?: string) =>
    ev(t, "op.end", name, { op, data: { kind: "fetch", status: code >= 400 ? "error" : "ok", code, ...(detail ? { detail } : {}) } });

  rt.setStatus({ state: "ready", device: "webgpu", variant: "fp16", model: "genclass-runtime-0.1", progress: { loaded: 24_740_000, total: 24_740_000 }, loadMs: 1240 });

  // --- load
  ev(640, "nav", "load /search", { data: { route: "/search" } });
  fetchStart(1130, 1, "GET /api/session");
  fetchEnd(1342, 1, "GET /api/session", 200);
  ev(1344, "state", "session", { op: 1, cause: 1, data: { paths: ["session.user", "session.flags"] } });

  // --- search typeahead: the slow response for "rea" arrives after the one for "react"
  ev(2210, "user", 'type input "Search"', { op: 2, data: { value: "rea" } });
  ev(2212, "state", "search", { op: 2, cause: 2, data: { paths: ["search.query"] } });
  fetchStart(2214, 3, "GET /api/search", "?q=rea", 2);
  ev(2601, "user", 'type input "Search"', { op: 4, data: { value: "react" } });
  ev(2603, "state", "search", { op: 4, cause: 4, data: { paths: ["search.query"] } });
  fetchStart(2606, 5, "GET /api/search", "?q=react", 4);
  fetchEnd(2818, 5, "GET /api/search", 200, "?q=react");
  ev(2821, "state", "search", { op: 5, cause: 5, data: { paths: ["search.results", "search.total"] } });
  fetchEnd(4031, 3, "GET /api/search", 200, "?q=rea");

  const d1 = makeDecision({
    id: "d1",
    trigger: "mutation",
    subject: "A write to search.results and search.total from GET /api/search?q=rea is about to apply.",
    at: 4069,
    latencyMs: 38,
    model: MODEL,
    diagnosisProbabilities: { stale: 0.97, conflict: 0.014, expected: 0.009, duplicate: 0.004, unusual: 0.003 },
    probabilities: { discard: 0.98, apply: 0.012, defer: 0.008 },
    executed: true,
    tier: "guard",
    facts: [
      'GET /api/search?q=rea started 1.82s ago, caused by typing "rea" in input "Search".',
      "search.results was at version 3 when it started; it is now at version 4, written 1.21s ago by GET /api/search?q=react.",
      "GET /api/search?q=react started 0.39s after this request, from a later user action, and finished first.",
      'search.query changed since this request started: "rea" → "react" (typing in input "Search").',
      "GET /api/search usually takes 240ms (p95 610ms); this one took 1.82s (7.6×).",
      "Value delta: search.results 3 items → 12 items; search.total 3 → 12.",
    ],
  });
  ev(4069, "decision", "mutation", { cause: 3, data: { id: "d1", diagnosis: "stale", action: "discard", confidence: 0.98 } });
  rt.decision(d1);
  const a1 = makeAction(d1, {
    id: "a1",
    at: 4070,
    changed: 'Dropped the write to search.results and search.total from GET /api/search?q=rea; the newer results for "react" stay on screen.',
    undo: () => opts.onUndo?.("a1"),
  });
  ev(4070, "action", "discard", { cause: 3, data: { id: "a1", store: "search" } });
  rt.act(a1);
  rt.report({
    kind: "intervene",
    message:
      `[GenClass] Prevented a stale write: ${d1.facts[1]} ${a1.changed} (stale, 0.97; discard 0.98)`,
    decision: d1,
    action: a1,
  });
  rt.explanations.set(
    "a1",
    explanation(
      d1,
      {
        app: "Acme Store · /search",
        trigger: "A write to search.results and search.total from GET /api/search?q=rea is about to apply.",
        facts: d1.facts,
        in_flight: "none",
        timeline: [
          '-1.82s user type input "Search" = "rea"',
          "-1.82s fetch GET /api/search?q=rea started (#3, cause #2)",
          '-1.43s user type input "Search" = "react"',
          "-1.43s fetch GET /api/search?q=react started (#5, cause #4)",
          "-1.21s fetch GET /api/search?q=react 200 in 212ms",
          "-1.21s state search.results, search.total ← #5",
          "-0.00s fetch GET /api/search?q=rea 200 in 1.82s",
        ],
        state: [
          'search.query: "react" (v5, user input)',
          'search.results: 3 items [{id: 9, name: "react"}, {id: 14, name: "react-dom"}, …] (v4, GET /api/search?q=react)',
          "search.total: 3 (v4)",
        ],
        stats: "GET /api/search: 41 completions, median 240ms, p95 610ms, 0 errors",
      },
      a1,
    ),
  );

  // --- checkout: double submit
  ev(7210, "user", 'click button "Place order"', { op: 6 });
  fetchStart(7214, 7, "POST /api/orders", "{items: 3, total: 84.97}", 6);
  ev(7304, "user", 'click button "Place order"', { op: 8 });
  const d2 = makeDecision({
    id: "d2",
    trigger: "request",
    subject: "POST /api/orders is about to be sent.",
    at: 7329,
    latencyMs: 24,
    model: MODEL,
    diagnosisProbabilities: { duplicate: 0.95, expected: 0.031, conflict: 0.012, unusual: 0.007 },
    probabilities: { coalesce: 0.96, send: 0.03, delay: 0.01 },
    executed: true,
    tier: "guard",
    facts: [
      'An identical POST /api/orders (same body) is in flight: it started 90ms ago from click button "Place order".',
      'This request comes from a second click on button "Place order", 94ms after the first.',
      "POST /api/orders is not idempotent; the first request has not answered yet.",
      "Body: {items: 3, total: 84.97}.",
    ],
  });
  ev(7329, "decision", "request", { cause: 8, data: { id: "d2", diagnosis: "duplicate", action: "coalesce", confidence: 0.96 } });
  rt.decision(d2);
  const a2 = makeAction(d2, { id: "a2", at: 7330, changed: "Did not send the second POST /api/orders; it gets a copy of the first request's response." });
  ev(7330, "action", "coalesce", { cause: 8, data: { id: "a2" } });
  rt.act(a2);
  rt.report({
    kind: "intervene",
    message: `[GenClass] Prevented a duplicate request: ${d2.facts[0]} ${a2.changed} (duplicate, 0.95; coalesce 0.96)`,
    decision: d2,
    action: a2,
  });
  rt.explanations.set(
    "a2",
    explanation(
      d2,
      {
        app: "Acme Store · /checkout",
        trigger: "POST /api/orders is about to be sent.",
        facts: d2.facts,
        in_flight: ['POST /api/orders {items: 3, total: 84.97} (90ms, from click button "Place order")'],
        timeline: ['-0.09s user click button "Place order"', "-0.09s fetch POST /api/orders started (#7, cause #6)", '-0.00s user click button "Place order"'],
        state: ["cart.items: 3 items (v11)", "cart.total: 84.97 (v8)", "orders.count: 0 (v1)"],
        stats: "POST /api/orders: no previous completions",
      },
      a2,
    ),
  );
  fetchEnd(7690, 7, "POST /api/orders", 201);
  ev(7693, "state", "orders", { op: 7, cause: 7, data: { paths: ["orders.last", "orders.count"] } });

  // --- cart: an unusual transition
  ev(9020, "nav", "/cart", { data: { route: "/cart" } });
  fetchStart(10850, 30, "GET /api/status");
  fetchEnd(10900, 30, "GET /api/status", 200);
  ev(11020, "user", 'click button "Remove"', { op: 9 });
  fetchStart(11024, 10, "POST /api/cart", '{op: "remove", id: 31}', 9);
  fetchEnd(11380, 10, "POST /api/cart", 200);
  ev(11383, "state", "cart", { op: 10, cause: 10, data: { paths: ["cart.items"] } });
  const d3 = makeDecision({
    id: "d3",
    trigger: "transition",
    subject: "POST /api/cart completed; its state transition differs from its learned profile.",
    at: 11471,
    latencyMs: 29,
    model: MODEL,
    diagnosisProbabilities: { unusual: 0.88, inconsistent: 0.07, expected: 0.04, failing: 0.01 },
    probabilities: { rollback: 0.64, ignore: 0.36 },
    executed: false,
    tier: "heal",
    ran: "ignore",
    reason: "guard mode does not allow heal-tier actions",
    facts: [
      "In the previous 317 completions of POST /api/cart it wrote cart.items and cart.total; this time it wrote only cart.items.",
      'It was caused by click button "Remove" 0.45s ago.',
      "Value delta: cart.items 4 items → 3 items; cart.total unchanged (124.95).",
    ],
  });
  ev(11471, "decision", "transition", { cause: 10, data: { id: "d3", diagnosis: "unusual", action: "rollback", confidence: 0.64 } });
  rt.decision(d3);
  rt.report({
    kind: "detect",
    message: `[GenClass] Flagged an unusual state change: ${d3.facts[0]} Not acted on (rollback 0.64): ${d3.reason}. (unusual, 0.88)`,
    decision: d3,
  });
  rt.explanations.set(
    "d3",
    explanation(d3, {
      app: "Acme Store · /cart",
      trigger: d3.subject,
      facts: d3.facts,
      in_flight: "none",
      timeline: ['-0.45s user click button "Remove"', "-0.45s fetch POST /api/cart started (#10, cause #9)", "-0.09s fetch POST /api/cart 200 in 356ms", "-0.09s state cart.items ← #10"],
      state: ['cart.items: 3 items [{id: 17, name: "Desk lamp", qty: 1}, …] (v12)', "cart.total: 124.95 (v8)"],
      stats: "POST /api/cart: 317 completions, median 180ms, 0 errors",
    }),
  );

  // --- a flaky status poll, then a backed-off request
  let op = 11;
  for (const t of [15010, 17012, 19011, 21010]) {
    fetchStart(t, op, "GET /api/status");
    fetchEnd(t + 52, op, "GET /api/status", 503);
    op++;
  }
  fetchStart(22100, 15, "GET /api/recommendations", "?for=cart", 9);
  const d4 = makeDecision({
    id: "d4",
    trigger: "request",
    subject: "GET /api/status is about to be sent.",
    at: 23022,
    latencyMs: 21,
    model: MODEL,
    diagnosisProbabilities: { failing: 0.91, overload: 0.04, expected: 0.03, slow: 0.02 },
    probabilities: { delay: 0.93, send: 0.07 },
    executed: true,
    tier: "guard",
    facts: [
      "GET /api/status failed 4 times in a row (503, 503, 503, 503); the last success was 12.1s ago.",
      "It is polled every 2.0s by a timer; no user action is waiting on it.",
      "Error rate of GET /api/status in the last minute: 4 of 9 (usually 0 of 40).",
    ],
  });
  ev(23022, "decision", "request", { data: { id: "d4", diagnosis: "failing", action: "delay", confidence: 0.93 } });
  rt.decision(d4);
  const a3 = makeAction(d4, { id: "a3", at: 23023, changed: "Held GET /api/status for 2.0 s before sending it (backoff after 4 failures in a row)." });
  ev(23023, "action", "delay", { data: { id: "a3" } });
  rt.act(a3);
  rt.report({
    kind: "intervene",
    message: `[GenClass] Slowed down a failing request: ${d4.facts[0]} ${a3.changed} (failing, 0.91; delay 0.93)`,
    decision: d4,
    action: a3,
  });
  rt.explanations.set(
    "a3",
    explanation(
      d4,
      {
        app: "Acme Store · /cart",
        trigger: d4.subject,
        facts: d4.facts,
        in_flight: ['GET /api/recommendations?for=cart (0.92s, from click button "Remove")'],
        timeline: ["-12.12s fetch GET /api/status 200 in 50ms", "-7.96s fetch GET /api/status 503 in 52ms", "-5.96s fetch GET /api/status 503 in 52ms", "-3.96s fetch GET /api/status 503 in 52ms", "-1.96s fetch GET /api/status 503 in 52ms", "-0.92s fetch GET /api/recommendations?for=cart started (#15, cause #9)"],
        state: ["status.services: 6 items (v40)", "status.lastOk: 10.9 (v35)"],
        stats: "GET /api/status: 4 failures in a row; error rate 44% in the last minute (usually 0%)",
      },
      a3,
    ),
  );


  // --- user edits quantity; the derived total does not follow
  ev(24000, "user", 'change input "Qty"', { op: 17, data: { value: "3" } });
  ev(24003, "state", "cart", { op: 17, cause: 17, data: { paths: ["cart.items"] } });
  const d6 = makeDecision({
    id: "d6",
    trigger: "inconsistency",
    subject: "A learned relation between store fields broke at a settled point.",
    at: 24093,
    latencyMs: 33,
    model: MODEL,
    diagnosisProbabilities: { inconsistent: 0.9, expected: 0.06, conflict: 0.03, unusual: 0.01 },
    probabilities: { rollback: 0.58, ignore: 0.42 },
    executed: false,
    tier: "heal",
    ran: "ignore",
    reason: "guard mode does not allow heal-tier actions",
    facts: [
      "cart.total == sum(cart.items[*].price × qty) held at 41 settled points; now cart.total is 84.97 and the sum is 124.95.",
      'It broke after a write to cart.items by change input "Qty" 0.09s ago.',
      "The last consistent state was 13.1s ago.",
    ],
  });
  ev(24093, "decision", "inconsistency", { cause: 17, data: { id: "d6", diagnosis: "inconsistent", action: "rollback", confidence: 0.58 } });
  rt.decision(d6);
  rt.report({
    kind: "detect",
    message: `[GenClass] Flagged inconsistent state: ${d6.facts[0]} Not acted on (rollback 0.58): ${d6.reason}. (inconsistent, 0.90)`,
    decision: d6,
  });
  rt.explanations.set(
    "d6",
    explanation(d6, {
      app: "Acme Store · /cart",
      trigger: d6.subject,
      facts: d6.facts,
      in_flight: ['GET /api/recommendations?for=cart (1.99s, from click button "Remove")'],
      timeline: ['-0.09s user change input "Qty" = "3"', "-0.09s state cart.items ← #17"],
      state: ['cart.items: 3 items [{id: 17, name: "Desk lamp", price: 20.99, qty: 3}, …] (v13)', "cart.total: 84.97 (v9)"],
      stats: "none",
    }),
  );
  ev(24910, "error", "TypeError", { cause: 17, data: { message: "Cannot read properties of undefined (reading 'price')", source: "window.onerror" } });
  fetchStart(25024, 16, "GET /api/status");
  fetchEnd(25071, 16, "GET /api/status", 200);

  const d5 = makeDecision({
    id: "d5",
    trigger: "stall",
    subject: "GET /api/recommendations?for=cart has been in flight for 4.1s.",
    at: 26240,
    latencyMs: 27,
    model: MODEL,
    diagnosisProbabilities: { slow: 0.84, expected: 0.1, failing: 0.04, overload: 0.02 },
    probabilities: { hedge: 0.71, wait: 0.2, serve_cached: 0.09 },
    executed: false,
    tier: "heal",
    ran: "wait",
    reason: "guard mode does not allow heal-tier actions",
    facts: [
      "GET /api/recommendations has been in flight for 4.14s; it usually answers in 320ms (p95 610ms), 13× slower.",
      'It was started by click button "Remove" 5.2s ago; nothing else is waiting on it.',
      "It is an idempotent GET with no body; a cached good response from 2m ago exists.",
    ],
  });
  ev(26240, "decision", "stall", { cause: 15, data: { id: "d5", diagnosis: "slow", action: "hedge", confidence: 0.71 } });
  rt.decision(d5);
  rt.report({
    kind: "detect",
    message: `[GenClass] Flagged a slow request: ${d5.facts[0]} Not acted on (hedge 0.71): ${d5.reason}. (slow, 0.84)`,
    decision: d5,
  });

  // --- what the model would see right now
  rt.ops = [{ id: 15, kind: "fetch", name: "GET /api/recommendations", detail: "?for=cart", start: 22100, attempt: 1, reads: new Map(), cause: 9, root: 9 }];
  const facts = [
    "GET /api/recommendations has been in flight for 5.30s; it usually answers in 320ms (p95 610ms).",
    "cart.total (84.97) differs from the sum of cart.items price × qty (124.95); the relation held at 41 settled points before.",
    "GET /api/status recovered after 4 failures in a row (last 200 OK 2.3s ago).",
    'The last user action was change input "Qty" 3.4s ago.',
  ];
  const sit: Situation = {
    trigger: "ask",
    subject: "A developer question about the app as it is right now.",
    salient: true,
    facts,
    actions: [],
    questions: {},
    state: {
      app: "Acme Store · /cart",
      trigger: "A developer question about the app as it is right now.",
      facts,
      in_flight: ['GET /api/recommendations?for=cart (5.30s, from click button "Remove")'],
      timeline: [
        "-5.30s fetch GET /api/recommendations?for=cart started (#15, cause #9)",
        "-4.38s genclass delay GET /api/status (2.0s)",
        '-3.40s user change input "Qty" = "3"',
        "-3.40s state cart.items ← #17",
        "-3.31s genclass flagged cart.total ≠ sum(cart.items price × qty)",
        "-2.49s error TypeError: Cannot read properties of undefined (reading 'price')",
        "-2.38s fetch GET /api/status 200 in 47ms",
        "-1.16s genclass flagged GET /api/recommendations (slow)",
      ],
      state: [
        'cart.items: 3 items [{id: 17, name: "Desk lamp", price: 20.99, qty: 3}, …] (v13)',
        "cart.total: 84.97 (v9)",
        'search.query: "react" (v5)',
        "search.results: 3 items (v4)",
        'orders.last: {id: 5521, status: "created"} (v2)',
        'session.user: {id: 42, name: "Mehar"} (v1)',
      ],
      stats: ["GET /api/recommendations: median 320ms, p95 610ms over 18 completions", "GET /api/status: error rate 44% in the last minute (usually 0%)"],
    },
  };
  rt.sit = sit;
  rt.clock.t = opts.now ?? 27_400;
}
