// REVIEW: observability (console reports), init robustness, API details. A failing test demonstrates a bug.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, GenClassUnavailableError } from "../src/index.js";
import { FakeClock, ScriptedDecider, defaultScript, setup } from "./helpers.js";

describe("review: console reports", () => {
  afterEach(() => vi.restoreAllMocks());

  function quiet() {
    const lines: string[] = [];
    for (const m of ["groupCollapsed", "warn", "info", "log", "groupEnd", "debug"] as const)
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        if (m !== "log" && m !== "groupEnd" && typeof a[0] === "string") lines.push(a[0]);
      });
    return lines;
  }

  async function duplicateSubmits(n: number, policy = {}) {
    const lines = quiet();
    const { rt, clock, server, fetch } = setup({ report: "console", policy, script: defaultScript({ request: { diagnosis: "duplicate", action: "coalesce" } }) });
    server.on("POST", "/api/orders", { status: 201, body: { ok: 1 }, latency: 500 });
    for (let i = 0; i < n; i++) {
      rt.user({ kind: "click", target: 'button "Place order"' }, () => void fetch("/api/orders", { method: "POST", body: '{"sku":"A1"}' }));
      await clock.advance(50);
    }
    await clock.advance(120_000); // nothing else happens
    return { rt, lines };
  }

  it("every intervention reaches the console (at least as a ×N summary), even when the burst ends", async () => {
    const { rt, lines } = await duplicateSubmits(4); // 3 coalesces within 150 ms
    const ran = rt.interventions().length;
    const reported = lines.filter((l) => l.startsWith("[GenClass] Prevented"));
    const summarized = reported.reduce((n, l) => n + (Number(/×(\d+)/.exec(l)?.[1] ?? 1) || 1), 0);
    expect({ ran, reportedInterventions: Math.max(reported.length, summarized) }).toEqual({ ran: 3, reportedInterventions: 3 });
  });

  it("the rate-limit warning is printed once, not once per decision", async () => {
    const { lines } = await duplicateSubmits(8, { maxActionsPerMinute: 1 });
    expect(lines.filter((l) => l.includes("Rate limit reached")).length).toBeLessThanOrEqual(1);
  });
});

describe("review: init robustness", () => {
  it("createRuntime does not throw when a global it would wrap is read-only (frozen/hardened pages)", () => {
    const g: Record<string, unknown> = { Response, location: { href: "http://app.test/", pathname: "/", search: "" } };
    Object.defineProperty(g, "fetch", { value: () => Promise.resolve(new Response("x")), writable: false, enumerable: true, configurable: false });
    let err: unknown = null;
    try {
      createRuntime({ clock: new FakeClock(), global: g, decider: null, report: "silent", observe: { fetch: true } });
    } catch (e) {
      err = e;
    }
    expect(String(err)).toBe("null");
  });
});

describe("review: policy gate and plugin actions", () => {
  it("a guard-tier plugin action cannot run a denied heal-tier built-in through ctx.builtin()", async () => {
    const { rt, clock, server, fetch } = setup({
      mode: "guard",
      triage: "always",
      policy: { deny: ["block"] },
      script: defaultScript({ request: { diagnosis: "overload", action: "throttle" } }),
    });
    rt.action({ name: "throttle", description: "slow this down", on: ["request"], tier: "guard", run: (ctx) => void ctx.builtin("block") });
    server.on("GET", "/api/poll", { body: 1, latency: 10 });
    const p = fetch("/api/poll");
    await clock.advance(100);
    const r = await p;
    // guard mode never runs heal-tier actions, and "block" is denied by policy
    expect({ status: r.status, mark: r.headers.get("x-genclass"), sent: server.hits.get("GET /api/poll") ?? 0 }).toEqual({ status: 200, mark: null, sent: 1 });
  });
});

describe("review: decider queue robustness", () => {
  it("a provider call that never settles does not stop every later decision", async () => {
    let calls = 0;
    const answer = defaultScript();
    const decider = {
      status: { state: "ready" as const, model: "hangs-once" },
      ready: () => Promise.resolve(),
      evaluate: (req: Parameters<ScriptedDecider["evaluate"]>[0]) => {
        calls++;
        return calls === 1 ? new Promise<never>(() => undefined) : Promise.resolve(answer(req) as Awaited<ReturnType<ScriptedDecider["evaluate"]>>);
      },
    };
    const { clock, server, fetch } = setup({ decider, triage: "always" });
    server.on("GET", "/api/x", { body: 1, latency: 10 });
    for (let i = 0; i < 3; i++) {
      void fetch(`/api/x?i=${i}`);
      await clock.advance(30_000);
    }
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});

describe("review: ask() after destroy", () => {
  it("rejects with reason 'destroyed' (API.md)", async () => {
    const clock = new FakeClock();
    const rt = createRuntime({ clock, global: { location: { href: "http://app.test/" } }, decider: new ScriptedDecider(), report: "silent", observe: {} });
    rt.destroy();
    const e = await rt.ask({ type: "noul", instructions: "x?" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GenClassUnavailableError);
    expect((e as GenClassUnavailableError).reason).toBe("destroyed");
  });
});
