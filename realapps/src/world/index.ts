// Entry of the in-page world (bundled as an IIFE and injected with page.addInitScript before any page script).
// Reads window.__RW_CFG (RunConfig), virtualises time and the network, prepares the runtime's init options
// (window.__GENCLASS_INIT__, read by the app's one-line integration) and exposes window.__RW.start(), which runs
// the session on virtual time and resolves with the RunResult as a JSON string.

import type { RunConfig, RunResult } from "../shared/types.js";
import { installTime } from "./loop.js";
import { Network } from "./net.js";
import { installNetApi } from "./netapi.js";
import { Probe } from "./probe.js";
import { hashAll, MockServer } from "./server.js";
import { UserDriver } from "./user.js";

declare global {
  interface Window {
    __RW_CFG?: RunConfig;
    __RW?: { start(): Promise<string>; probe: Probe };
    __GENCLASS_INIT__?: Record<string, unknown>;
    __RW_VARIANT?: Record<string, unknown>;
  }
}

(function main() {
  const w = window as Window & typeof globalThis;
  const cfg = w.__RW_CFG;
  if (!cfg) return;
  const realNow = performance.now.bind(performance);
  const realStart = realNow();
  const loop = installTime(w, { epoch: cfg.epoch, randomSeed: hashAll(cfg.seed, "page-random") });
  // a fresh browser profile per run: storage and (script-visible) cookies cleared, then the app's preloads
  try {
    for (const c of w.document.cookie.split(";")) {
      const name = c.split("=")[0]!.trim();
      if (name) w.document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    }
    const ck = cfg.variant.__cookies as Record<string, string> | undefined;
    if (ck) for (const [k, v] of Object.entries(ck)) w.document.cookie = `${k}=${encodeURIComponent(v)}; path=/`;
  } catch {
    /* cookies unavailable */
  }
  try {
    w.localStorage.clear();
    w.sessionStorage.clear();
    const pre = cfg.variant.__localStorage as Record<string, string> | undefined;
    if (pre) for (const [k, v] of Object.entries(pre)) w.localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
  const server = new MockServer(cfg.server, `srv-${cfg.app}`);
  server.now = () => loop.now;
  server.epoch = cfg.epoch;
  const net = new Network(loop, server, cfg.net, cfg.seed, cfg.ideal, w.location.origin);
  const netApi = installNetApi(w, net);
  const probe = new Probe(w, cfg, loop, net, netApi, server);
  net.onSend = (rec, ctx) => probe.onSend(rec, ctx);
  net.onSettle = (rec) => probe.onSettle(rec);
  net.onWsMessage = (m) => {
    probe.currentWs = m;
    if (m) probe.wsMessages++;
  };

  const ALL_OFF = { fetch: false, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, timers: false };
  w.__GENCLASS_INIT__ = cfg.ideal
    ? { mode: "observe", model: false, decider: null, report: "silent", observe: ALL_OFF, hooks: probe.hooks(), plugins: [probe.plugin()] }
    : {
        mode: cfg.mode ?? "heal",
        decider: probe.decider(),
        report: "silent",
        triage: "salient",
        observe: cfg.observe,
        policy: { thresholds: { report: 0, guard: 0.5, heal: 0.5 }, holdBudgetMs: 1e9, maxActionsPerMinute: 1e9, requireDiagnosis: false },
        historySize: 500,
        situation: { budget: cfg.budget },
        hooks: probe.hooks(),
        plugins: [probe.plugin()],
        ...(cfg.vocab ? { vocabulary: cfg.vocab } : {}),
      };
  const variant: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg.variant)) if (!k.startsWith("__")) variant[k] = v;
  w.__RW_VARIANT = variant;

  // uncaught errors (the browser's own reporting path)
  const errLog: string[] = [];
  w.addEventListener("error", (e) => {
    if (!(e instanceof ErrorEvent)) return; // resource load errors (img/script) are not uncaught exceptions
    probe.uncaught.push(loop.now);
    if (errLog.length < 6) errLog.push(`uncaught@${Math.round(loop.now)}: ${String((e as ErrorEvent).error?.stack ?? (e as ErrorEvent).message).slice(0, 400)}`);
  }, true);
  w.addEventListener("unhandledrejection", (e) => {
    probe.uncaught.push(loop.now);
    const r = (e as PromiseRejectionEvent).reason;
    if (errLog.length < 6) errLog.push(`rejection@${Math.round(loop.now)}: ${String(r?.stack ?? r).slice(0, 400)}`);
  }, true);
  loop.onTaskError = (e) => {
    try {
      w.reportError(e);
    } catch {
      probe.uncaught.push(loop.now);
    }
  };
  loop.onTaskEnd = () => probe.taskEnd();
  // never let a click or submit navigate the page away (SPAs prevent these themselves)
  let navAttempts = 0;
  w.addEventListener("click", (e) => {
    if (e.defaultPrevented) return;
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (a && !a.getAttribute("href")!.startsWith("#")) {
      e.preventDefault();
      navAttempts++;
    }
  });
  w.addEventListener("submit", (e) => {
    if (!e.defaultPrevented) {
      e.preventDefault();
      navAttempts++;
    }
  });
  let unloading = false;
  w.addEventListener("beforeunload", () => (unloading = true));
  const startObserver = () => {
    // the callback runs in a microtask and consumes the records, so it only marks the DOM dirty
    probe.mo = new MutationObserver(() => {
      probe.domDirty = true;
    });
    probe.mo.observe(w.document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden", "class", "style", "open", "disabled", "value"] });
  };
  if (w.document.documentElement) startObserver();
  // shadow roots (Lit, Stencil, ...): observe their mutations too, and make text snapshots walk into them
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit): ShadowRoot {
    const sr = attach.call(this, init);
    probe.hasShadow = true;
    probe.domDirty = true;
    const obs = new MutationObserver(() => {
      probe.domDirty = true;
    });
    obs.observe(sr, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden", "class", "style", "open", "disabled", "value"] });
    return sr;
  };

  w.__RW = {
    probe,
    async start(): Promise<string> {
      if (!probe.mo) startObserver();
      cfg.external.forEach((ev, i) => {
        let t = ev.t;
        if (cfg.future && t > cfg.future.t) t += (hashAll("ext-jitter", cfg.future.salt, i) / 4294967296) * 600;
        loop.at(t, () => server.external(ev.kind, ev.target, ev.index, ev.data, ev.verb, ev.by, ev.where), "ext");
      });
      for (const d of cfg.net.wsDrops) if (!cfg.ideal) loop.at(d.t, () => net.dropSockets(d.downMs), "ws-drop");
      let driver: UserDriver;
      const skipWhy: Record<string, number> = {};
      const stepLog: string[] = [];
      // developer-question probes (side-effect free: runtime.situation() consumes no ids)
      const asks: NonNullable<RunResult["asks"]> = [];
      // probes run in every real run of a trajectory (base and counterfactuals), so a probe can never make a
      // counterfactual prefix differ; only the base run (record) keeps them
      if (!cfg.ideal)
        for (const at of cfg.askTimes ?? [])
          loop.at(at, () => {
            if (!probe.rt) return;
            try {
              const now = loop.now;
              const sit = probe.rt.situation("ask");
              const inflight = net.log.filter((r) => r.td === undefined && r.outcome !== "aborted").map((r) => ({ sig: r.sig, method: r.method, age: now - r.t0, write: r.method !== "GET", feature: "" }));
              const recent = net.log.filter((r) => r.td !== undefined && r.td >= now - 15000).map((r) => ({ sig: r.sig, method: r.method, ...(r.status !== undefined ? { status: r.status } : {}), outcome: r.outcome, t: r.t0, td: r.td! }));
              const pendingUser = net.log.filter((r) => r.td === undefined && r.step !== undefined);
              const stores: Record<string, unknown> = {};
              if (cfg.record) asks.push({
                t: now,
                state: sit.state,
                facts: { now, inflight, recent, lastUserAt: probe.stepsRan.length ? probe.stepsRan[probe.stepsRan.length - 1]!.t : -1, userWaitingMs: pendingUser.length ? Math.max(...pendingUser.map((r) => now - r.t0)) : 0, stores, errorsShown: probe.errorWrites.length + probe.errorEpisodes.length, route: w.location.pathname },
              });
            } catch (e) {
              loop.internalErrors.push(`ask probe: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
            }
          }, "ask");
      driver = new UserDriver(w, loop, cfg.steps, cfg.ideal, {
        begin: (st, sub) => {
          probe.current = { step: st, sub };
          probe.subTimes.set(`${st.i}:${sub}`, loop.now);
          net.lastStepT = loop.now;
        },
        end: () => {
          probe.current = null;
        },
        inflight: () => net.inflight(),
        skipped: (_st, why) => {
          probe.stepsSkipped++;
          skipWhy[why] = (skipWhy[why] ?? 0) + 1;
          if (why === "missing") probe.skippedAt.push(loop.now);
        },
        ran: (st, el) => {
          probe.stepsRan.push({ i: st.i, t: loop.now });
          if (el && stepLog.length < 400) stepLog.push(`${st.i}@${Math.round(loop.now)} ${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""} "${((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 30)}"`);
        },
      });
      driver.pins = cfg.pins;
      driver.start();
      probe.markAllDirty();
      let error: string | undefined;
      try {
        await loop.runUntil(cfg.tStop);
      } catch (e) {
        error = String((e as Error)?.stack ?? e).slice(0, 500);
      }
      if (unloading) error = "page tried to unload";
      probe.markAllDirty();
      probe.taskEnd();
      const userOps: [number, number | null][] = [];
      for (const r of net.log) if (r.step !== undefined) userOps.push([r.t0, r.td ?? null]);
      const res: RunResult = {
        runId: cfg.runId,
        ok: !error && !loop.internalErrors.length,
        ...(error ? { error } : loop.internalErrors.length ? { error: loop.internalErrors[0] } : {}),
        tStop: cfg.tStop,
        tasks: loop.tasksRun,
        realMs: Math.round(realNow() - realStart),
        decisions: probe.decisions,
        snapshots: probe.snapshots,
        initial: probe.initial,
        net: net.log,
        server: server.snapshot(),
        ...(cfg.ideal || cfg.record ? { serverTimeline: probe.serverTimeline } : {}),
        errorEpisodes: probe.errorEpisodes,
        errorWrites: probe.errorWrites,
        skippedAt: probe.skippedAt,
        uncaught: probe.uncaught,
        userOps,
        stepsRun: probe.stepsRan.length,
        stepsSkipped: probe.stepsSkipped,
        skipWhy,
        stepLog,
        internalErrors: [...loop.internalErrors, ...(navAttempts ? [`nav-prevented:${navAttempts}`] : []), ...errLog],
        wsMessages: probe.wsMessages,
        ...(asks.length ? { asks } : {}),
        ...(cfg.ideal ? { pins: driver.recorded } : {}),
      };
      return JSON.stringify(res);
    },
  };
})();
