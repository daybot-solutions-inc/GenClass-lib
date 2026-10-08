// "GenClass must never make a correct app worse": with a model that always picks the passive action, guard and heal
// modes must leave a correct app exactly as observe mode does. The pattern here is the one in
// gothinkster/react-redux-realworld-example-app (Redux 3 + a promise middleware): the middleware remembers a view
// counter when it dispatches a request and drops the result when the counter changed before the response came back.
// Holding a dispatch (and applying it later) reorders it relative to the reads and dispatches after it, so the page
// never loads. Store writes are not held by default; delivery decisions only add latency.
import { applyMiddleware, combineReducers, compose, legacy_createStore as createStore, type Middleware, type StoreEnhancer, type UnknownAction } from "redux";
import { describe, expect, it } from "vitest";
import { genclassEnhancer } from "../src/adapters/redux.js";
import { PASSIVE } from "../src/situation/questions.js";
import type { Answer, DecisionProvider, EvaluateRequest, Mode, ModelStatus, TriggerKind } from "../src/types.js";
import { choice, FakeClock, setup, type Setup } from "./helpers.js";

/** Always answers the passive action, with an alarming diagnosis, after `latency` ms of virtual time. */
class PassiveDecider implements DecisionProvider {
  status: ModelStatus = { state: "ready", model: "passive" };
  calls: TriggerKind[] = [];
  /** The runtime's (fake) clock, set once the runtime exists. */
  clock!: FakeClock;
  constructor(private latency = 10) {}
  ready(): Promise<void> {
    return Promise.resolve();
  }
  evaluate(req: EvaluateRequest): Promise<Record<string, Answer>> {
    this.calls.push(req.trigger);
    const out: Record<string, Answer> = {};
    for (const [qid, q] of Object.entries(req.questions)) {
      if (q.type === "choice") {
        const labels = Object.keys(q.criteria);
        const pick = qid === "action" ? PASSIVE[req.trigger] : (labels.find((l) => l !== "expected") ?? labels[0]);
        out[qid] = choice(labels.includes(pick) ? pick : labels[0], labels, 0.97);
      } else if (q.type === "noul") out[qid] = { type: "noul", noul: 0.9 };
      else out[qid] = { type: "score", score: 1, confidence: 0.5, probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), 1 / q.criteria.length])) };
    }
    return new Promise((resolve) => this.clock.setTimeout(() => resolve(out), this.latency));
  }
}

// --- the app (realworld's reducers and promise middleware, reduced to what matters) ---

interface Common {
  appLoaded: boolean;
  viewChangeCounter: number;
  currentUser: string | null;
  inProgress: number;
  redirectTo: string | null;
}
interface Home {
  articles: string[];
  tag: string | null;
}
const common = (s: Common = { appLoaded: false, viewChangeCounter: 0, currentUser: null, inProgress: 0, redirectTo: null }, a: UnknownAction): Common => {
  switch (a.type) {
    case "APP_LOAD":
      return { ...s, appLoaded: true, currentUser: a.payload ? (a.payload as { user: string }).user : null };
    case "LOGIN":
      return { ...s, currentUser: (a.payload as { user: string }).user, redirectTo: "/" };
    case "REDIRECT":
      return { ...s, redirectTo: null };
    case "ASYNC_START":
      return { ...s, inProgress: s.inProgress + 1 };
    case "ASYNC_END":
      return { ...s, inProgress: s.inProgress - 1 };
    case "HOME_PAGE_UNLOADED":
    case "LOGIN_PAGE_UNLOADED":
      return { ...s, viewChangeCounter: s.viewChangeCounter + 1 };
    default:
      return s;
  }
};
const home = (s: Home = { articles: [], tag: null }, a: UnknownAction): Home => {
  switch (a.type) {
    case "HOME_PAGE_LOADED":
      return { ...s, articles: (a.payload as { articles: string[] }).articles };
    case "APPLY_TAG_FILTER":
      return { ...s, tag: a.tag as string, articles: (a.payload as { articles: string[] }).articles };
    case "HOME_PAGE_UNLOADED":
      return { articles: [], tag: null };
    default:
      return s;
  }
};

const isPromise = (v: unknown): v is Promise<unknown> => !!v && typeof (v as Promise<unknown>).then === "function";

/** realworld's promise middleware: drops a result when the view counter changed between dispatch and resolution. */
const promiseMiddleware: Middleware = (store) => (next) => (action) => {
  const a = action as UnknownAction & { payload?: unknown; skipTracking?: boolean };
  if (isPromise(a.payload)) {
    store.dispatch({ type: "ASYNC_START", subtype: a.type });
    const currentView = store.getState().common.viewChangeCounter;
    a.payload.then((res) => {
      if (!a.skipTracking && store.getState().common.viewChangeCounter !== currentView) return; // a newer view
      store.dispatch({ type: "ASYNC_END" });
      store.dispatch({ ...a, payload: res });
    });
    return;
  }
  return next(action);
};

interface Run {
  final: unknown;
  actions: string[];
  pages: string[];
  decisions: TriggerKind[];
  interventions: number;
}

/** Boot, load the home feed, log in (redirect: unload + reload the feed), filter by a tag; as a browser would. */
async function session(mode: Mode, opts: { triage?: "salient" | "always" } = {}): Promise<Run> {
  const decider = new PassiveDecider();
  // the harness's settings: every gate as permissive as it gets, so only the model's (passive) answer decides
  const S: Setup = setup({ mode, decider, triage: opts.triage ?? "salient", policy: { thresholds: { report: 0, guard: 0.5, heal: 0.5 }, requireDiagnosis: false, maxActionsPerMinute: 1e9 } });
  decider.clock = S.clock;
  S.server.on("GET", "/api/user", { body: { user: "demo" }, latency: 40 });
  S.server.on("GET", "/api/articles", ({ url }) => ({ body: { articles: url.searchParams.get("tag") ? [`#${url.searchParams.get("tag")} a`] : ["a1", "a2", "a3"] }, latency: 70 }));
  S.server.on("POST", "/api/users/login", { body: { user: "jake" }, latency: 50 });
  const json = (u: string, init?: RequestInit) => S.fetch(u, init).then((r) => r.json());

  const actions: string[] = [];
  const log = (_: unknown, a: UnknownAction) => {
    if (!a.type.startsWith("@@")) actions.push(a.type);
    return _;
  };
  const reducer = combineReducers({ common, home, log: (s: null = null, a: UnknownAction) => log(s, a) });
  const store = createStore(reducer, compose(applyMiddleware(promiseMiddleware), genclassEnhancer(S.rt, { name: "conduit" })) as StoreEnhancer);

  // the view layer: mounts the page for the current route once the app has loaded (react-redux, synchronously)
  let route = "/login";
  let mounted: string | null = null;
  const pages: string[] = [];
  /** Switch the mounted page: the old page's componentWillUnmount, then the new page's componentWillMount. */
  const show = (r: string) => {
    const prev = mounted;
    mounted = r; // set first: notifications from the dispatches below see the page already mounted
    pages.push(r);
    if (prev === "/") store.dispatch({ type: "HOME_PAGE_UNLOADED" });
    if (prev === "/login") store.dispatch({ type: "LOGIN_PAGE_UNLOADED" });
    if (r === "/") store.dispatch({ type: "HOME_PAGE_LOADED", payload: json("/api/articles") });
  };
  store.subscribe(() => {
    const st = store.getState();
    if (st.common.redirectTo) {
      route = st.common.redirectTo;
      store.dispatch({ type: "REDIRECT" });
      return;
    }
    if (st.common.appLoaded && mounted !== route) show(route);
  });

  // boot (no user action): App.componentWillMount
  store.dispatch({ type: "APP_LOAD", payload: json("/api/user"), skipTracking: true });
  await S.clock.advance(500);
  // the user logs in: the response redirects home (unload the login page, load the feed)
  S.rt.user({ kind: "click", target: 'button "Sign in"' }, () => {
    store.dispatch({ type: "LOGIN", payload: json("/api/users/login", { method: "POST", body: "{}" }) });
  });
  await S.clock.advance(500);
  // the user filters by a tag, then (before it loads) goes back to the global feed: the tag result must be dropped
  S.rt.user({ kind: "click", target: 'a "#rx"' }, () => {
    store.dispatch({ type: "APPLY_TAG_FILTER", tag: "rx", payload: json("/api/articles?tag=rx") });
  });
  await S.clock.advance(20);
  S.rt.user({ kind: "click", target: 'a "Global Feed"' }, () => show("/"));
  await S.clock.advance(2000);
  await S.clock.runAll();
  const { log: _l, ...final } = store.getState();
  const interventions = S.rt.interventions().length;
  S.rt.destroy();
  return { final, actions, pages, decisions: decider.calls, interventions };
}

describe("never worse: a correct app with an always-passive model", () => {
  it("the promise-middleware pattern renders in observe mode (baseline)", async () => {
    const r = await session("observe");
    expect(r.final).toEqual({
      // the dropped tag result never ends its ASYNC_START (as in the original app)
      common: { appLoaded: true, viewChangeCounter: 2, currentUser: "jake", inProgress: 1, redirectTo: null },
      home: { articles: ["a1", "a2", "a3"], tag: null },
    });
    expect(r.pages).toEqual(["/login", "/", "/"]);
  });

  for (const mode of ["guard", "heal"] as const) {
    for (const triage of ["salient", "always"] as const) {
      it(`${mode}, triage ${triage}: identical to observe mode (same dispatches, same order, same final state)`, async () => {
        const base = await session("observe");
        const r = await session(mode, { triage });
        expect(r.final).toEqual(base.final);
        expect(r.actions).toEqual(base.actions);
        expect(r.pages).toEqual(base.pages);
        expect(r.interventions).toBe(0);
        if (triage === "always") {
          // the model was consulted at the network boundary and on writes, and nothing changed
          expect(r.decisions).toContain("delivery");
          expect(r.decisions).toContain("mutation");
        }
      });
    }
  }

  it("holdWrites (opt-in) never reorders a store's dispatches: subscribers see them in dispatch order", async () => {
    const decider = new PassiveDecider();
    const S = setup({ mode: "heal", decider, triage: "always", policy: { holdWrites: true, requireDiagnosis: false } });
    decider.clock = S.clock;
    const reducer = (s: { n: number; last: string } = { n: 0, last: "" }, a: UnknownAction) => (a.type.startsWith("@@") ? s : { n: s.n + 1, last: a.type });
    const store = createStore(reducer, genclassEnhancer(S.rt, { name: "app" }));
    // what subscribers (the UI) see, in order
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getState().last));
    const order: string[] = [];
    await S.rt.op("response", async () => {
      for (const t of ["A", "B", "C"]) {
        order.push(t);
        store.dispatch({ type: t });
      }
    });
    // a user write in between: applies now, after the held ones (never before them)
    S.rt.user({ kind: "click", target: 'button "X"' }, () => {
      order.push("U");
      store.dispatch({ type: "U" });
    });
    await S.clock.runAll();
    expect(seen).toEqual(order);
    expect(store.getState()).toEqual({ n: 4, last: "U" });
    S.rt.destroy();
  });
});
