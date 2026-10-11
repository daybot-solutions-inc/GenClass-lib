// Anonymous diagnostics (InitOptions.telemetry, TELEMETRY.md): defaults, opt-outs, batching, page exit, event
// shapes, the redacted situation text, transport failures, and that GenClass never observes its own requests.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GenClass, createRuntime, DEFAULT_TELEMETRY_ENDPOINT, RUNTIME_VERSION, TELEMETRY_NOTICE } from "../src/index.js";
import type { RuntimeImpl } from "../src/runtime.js";
import { stateText } from "../src/situation/serialize.js";
import { resetTelemetryNotice, resolveTelemetry, MAX_QUEUE } from "../src/telemetry/index.js";
import { isLocalHost } from "../src/telemetry/config.js";
import type { TelemetryTransport } from "../src/types.js";
import { FakeClock, defaultScript, setup } from "./helpers.js";

interface Sent {
  url: string;
  body: Record<string, unknown> & { events: Record<string, unknown>[] };
  beacon: boolean;
}

function recorder(fail?: "throw" | "reject"): TelemetryTransport & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    send(url, body, o) {
      sent.push({ url, body: JSON.parse(body), beacon: o.beacon });
      if (fail === "throw") throw new Error("offline");
      if (fail === "reject") return Promise.reject(new Error("HTTP 500"));
      return Promise.resolve();
    },
  };
}

const events = (t: { sent: Sent[] }) => t.sent.flatMap((s) => s.body.events);
const ofType = (t: { sent: Sent[] }, type: string) => events(t).filter((e) => e.t === type);

/** A headless runtime with telemetry explicitly on and an injected transport. */
function tsetup(opts: Parameters<typeof setup>[0] = {}, telemetry: Record<string, unknown> = {}, fail?: "throw" | "reject") {
  const transport = recorder(fail);
  const s = setup({ ...opts, telemetry: { transport, ...telemetry }, extraGlobal: { crypto: globalThis.crypto, ...(opts.extraGlobal ?? {}) } });
  return { ...s, transport };
}

const noRandom = { getRandomValues: undefined };

describe("telemetry: defaults and opt-outs (TELEMETRY.md)", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  afterEach(() => {
    GenClass.destroy();
    delete g.location;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("RUNTIME_VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(RUNTIME_VERSION).toBe(pkg.version);
  });

  it("off in createRuntime (headless) and in GenClass.init outside a browser unless enabled", () => {
    const { rt } = setup();
    expect(rt.telemetry).toMatchObject({ enabled: false, reason: "headless" });
    const r = GenClass.init({ model: false, report: "silent", observe: { fetch: false, timers: false } });
    expect(r.telemetry).toMatchObject({ enabled: false, reason: "headless" });
  });

  it("on by default in GenClass.init in a browser, with one console notice per page, to the default endpoint", async () => {
    vi.resetModules();
    const sent: { url: string; init: RequestInit }[] = [];
    const fake = vi.fn((url: string, init: RequestInit) => {
      sent.push({ url, init });
      return Promise.resolve(new Response(null, { status: 202 }));
    });
    vi.stubGlobal("fetch", fake);
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const m = await import("../src/index.js");
    m.GenClass.destroy();
    const rt = m.GenClass.init({ model: false, report: "silent", observe: { fetch: false, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, timers: false } });
    expect(rt.telemetry?.enabled).toBe(true);
    expect(info.mock.calls.filter((c) => c[0] === TELEMETRY_NOTICE)).toHaveLength(1);
    expect(TELEMETRY_NOTICE).toBe(
      "[GenClass] Sends anonymous diagnostics (decisions and counts, no page text) to improve the model. Opt out: GenClass.init({ telemetry: false }) or ?genclass=no-telemetry.",
    );
    // a second runtime on the same page does not repeat the notice
    const rt2 = m.createRuntime({ telemetry: true, decider: null, report: "silent", observe: { fetch: false, timers: false } });
    expect(info.mock.calls.filter((c) => c[0] === TELEMETRY_NOTICE)).toHaveLength(1);
    rt2.destroy();
    await rt.telemetry!.flush();
    const mine = sent.filter((s) => s.url === m.DEFAULT_TELEMETRY_ENDPOINT);
    expect(mine.length).toBeGreaterThan(0);
    expect(m.DEFAULT_TELEMETRY_ENDPOINT).toBe("https://genclass-telemetry.mehar-144.workers.dev/v1/events");
    const req = mine[0].init;
    expect(req.method).toBe("POST");
    expect(req.keepalive).toBe(true);
    expect(req.credentials).toBe("omit");
    expect((req.headers as Record<string, string>)["content-type"]).toMatch(/^text\/plain/);
    const body = JSON.parse(String(req.body));
    expect(body).toMatchObject({ schema: "genclass-telemetry/1", runtime: RUNTIME_VERSION, model: null });
    expect(body.sid).toMatch(/^[0-9a-f]{24}$/);
    expect(body.events[0]).toMatchObject({ t: "session", seq: 0, mode: "observe", model: "off" });
    m.GenClass.destroy();
  });

  it("every opt-out: option, ?genclass=no-telemetry / off, localStorage, GPC, sample, no crypto", () => {
    const base = { crypto: globalThis.crypto };
    const ls = (v: string | null) => ({ getItem: (k: string) => (k === "genclass.telemetry" ? v : null) });
    expect(resolveTelemetry(false, base, true)).toEqual({ on: false, reason: "option" });
    expect(resolveTelemetry(undefined, base, false)).toEqual({ on: false, reason: "headless" });
    expect(resolveTelemetry(undefined, { ...base, location: { search: "?genclass=no-telemetry" } }, true)).toEqual({ on: false, reason: "url" });
    expect(resolveTelemetry(true, { ...base, location: { search: "?genclass=guard&genclass=no-telemetry" } }, true)).toEqual({ on: false, reason: "url" });
    expect(resolveTelemetry(undefined, { ...base, location: { search: "?genclass=off" } }, true)).toEqual({ on: false, reason: "url" });
    expect(resolveTelemetry(undefined, { ...base, localStorage: ls("off") }, true)).toEqual({ on: false, reason: "localStorage" });
    expect(resolveTelemetry({}, { ...base, navigator: { globalPrivacyControl: true } }, true)).toEqual({ on: false, reason: "gpc" });
    expect(resolveTelemetry({ sample: 0 }, base, true)).toEqual({ on: false, reason: "sampled-out" });
    expect(resolveTelemetry(undefined, { crypto: noRandom }, true)).toEqual({ on: false, reason: "no-crypto" });
    // still on: GPC false, localStorage other values, sample 1, an unrelated genclass value
    const on = resolveTelemetry({ sample: 1 }, { ...base, navigator: { globalPrivacyControl: false }, localStorage: ls("on"), location: { search: "?genclass=guard" } }, true);
    expect(on.on).toBe(true);
    if (on.on) expect(on.config).toMatchObject({ endpoint: DEFAULT_TELEMETRY_ENDPOINT, flushMs: 10_000, maxBatch: 100, situation: false, sample: 1 });
    const withText = resolveTelemetry({ include: { situation: true } }, base, true);
    expect(withText.on).toBe(true);
    if (withText.on) expect(withText.config.situation).toBe(true);
  });

  it("the default-on telemetry stays off on local and private hosts; an explicit option still sends from them", () => {
    const base = { crypto: globalThis.crypto };
    const at = (hostname: string) => ({ ...base, location: { hostname, search: "" } });
    for (const h of ["localhost", "LOCALHOST", "app.localhost", "dev.test", "mac.local", "db.internal", "127.0.0.1", "127.9.9.9", "[::1]", "::1", "0.0.0.0", "10.0.0.5", "192.168.1.20", "172.16.0.1", "172.31.255.255", "169.254.1.1", "100.64.0.1", "fd12::1", "fe80::1", "intranet", ""]) {
      expect(resolveTelemetry(undefined, at(h), true), h).toEqual({ on: false, reason: "local" });
    }
    for (const h of ["genclass.dev", "app.example.com", "172.32.0.1", "11.0.0.1", "8.8.8.8", "2606:4700::1"]) {
      expect(resolveTelemetry(undefined, at(h), true).on, h).toBe(true);
    }
    expect(resolveTelemetry(undefined, { ...base, location: { search: "" } }, true).on).toBe(true); // hostname unknown: not local
    expect(isLocalHost(undefined)).toBe(false);
    expect(resolveTelemetry(true, at("localhost"), true).on).toBe(true);
    expect(resolveTelemetry({ sample: 1 }, at("10.0.0.5"), true).on).toBe(true);
    // the explicit opt-outs keep their reasons on local hosts too
    expect(resolveTelemetry(undefined, { ...at("localhost"), location: { hostname: "localhost", search: "?genclass=no-telemetry" } }, true)).toEqual({ on: false, reason: "url" });
  });

  it("opt-outs apply to createRuntime and GenClass.init too (GPC, ?genclass=off kill switch)", () => {
    const { rt } = tsetup({ extraGlobal: { navigator: { globalPrivacyControl: true } } });
    expect(rt.telemetry).toMatchObject({ enabled: false, reason: "gpc" });
    const { rt: rt2, transport } = tsetup({}, { sample: 0 });
    expect(rt2.telemetry).toMatchObject({ enabled: false, reason: "sampled-out" });
    void rt2.telemetry!.flush();
    expect(transport.sent).toHaveLength(0);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    g.location = { search: "?genclass=off", href: "http://x/?genclass=off", pathname: "/" };
    const r = GenClass.init({ telemetry: true });
    expect(r.telemetry).toMatchObject({ enabled: false, reason: "kill-switch" });
  });
});

describe("telemetry: batching, flush and page exit", () => {
  it("batches on the flush interval, splits by maxBatch, and keeps a bounded queue", async () => {
    const { rt, clock, transport } = tsetup({ triage: "always" }, { flushMs: 5000, maxBatch: 3 });
    expect(rt.telemetry?.enabled).toBe(true);
    expect(transport.sent).toHaveLength(0);
    const a = rt.atom("a", 1);
    for (let i = 0; i < 3; i++) {
      void rt.op("w", () => a.set(i + 2));
      await clock.advance(100);
    }
    expect(transport.sent).toHaveLength(0);
    await clock.advance(5000);
    const n = events(transport).length;
    expect(n).toBeGreaterThanOrEqual(4); // session + 3 decisions
    expect(transport.sent.every((s) => s.body.events.length <= 3)).toBe(true);
    expect(transport.sent.every((s) => s.beacon === false && s.url === DEFAULT_TELEMETRY_ENDPOINT)).toBe(true);
    const seqs = events(transport).map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => (x as number) - (y as number)));
    expect(new Set(transport.sent.map((s) => s.body.sid)).size).toBe(1);
    // bounded: beyond MAX_QUEUE queued events new ones are dropped and counted
    const client = rt.telemetry as unknown as { push(e: Record<string, unknown>): void; summary(r: string): void };
    for (let i = 0; i < MAX_QUEUE + 5; i++) client.push({ t: "x" });
    await rt.telemetry!.flush();
    const before = transport.sent.length;
    client.summary("periodic");
    await rt.telemetry!.flush();
    const sum = transport.sent.slice(before).flatMap((s) => s.body.events).find((e) => e.t === "summary") as { telemetry: { dropped: number } };
    expect(sum.telemetry.dropped).toBe(5);
  });

  it("pagehide sends a final summary with sendBeacon; a hidden tab flushes too", async () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const { rt, clock, transport } = tsetup({ triage: "always", extraGlobal: { addEventListener: win.addEventListener.bind(win), removeEventListener: win.removeEventListener.bind(win), document: doc } });
    const a = rt.atom("a", 1);
    void rt.op("w", () => a.set(2));
    await clock.flush();
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    await clock.flush();
    expect(transport.sent.at(-1)!.beacon).toBe(true);
    expect(transport.sent.at(-1)!.body.events.at(-1)).toMatchObject({ t: "summary", reason: "hidden" });
    win.dispatchEvent(new Event("pagehide"));
    await clock.flush();
    const last = transport.sent.at(-1)!;
    expect(last.beacon).toBe(true);
    const s = last.body.events.at(-1) as Record<string, any>;
    expect(s).toMatchObject({ t: "summary", reason: "pagehide" });
    expect(s.counts.decisions).toBe(1);
    expect(s.counts.byTrigger).toEqual({ mutation: 1 });
    rt.destroy();
    expect(transport.sent.at(-1)!.body.events.at(-1)).toMatchObject({ t: "summary", reason: "destroy" });
  });

  it("transport errors never reach the app: failures are counted and the batch dropped", async () => {
    for (const fail of ["throw", "reject"] as const) {
      const { rt, clock, transport } = tsetup({ triage: "always" }, {}, fail);
      const a = rt.atom("a", 1);
      void rt.op("w", () => a.set(2));
      await clock.flush();
      await expect(rt.telemetry!.flush()).resolves.toBeUndefined();
      await expect(rt.telemetry!.flush()).resolves.toBeUndefined();
      expect(a.get()).toBe(2);
      (rt.telemetry as unknown as { summary(r: string): void }).summary("periodic");
      await rt.telemetry!.flush();
      const s = events(transport).filter((e) => e.t === "summary").at(-1) as { telemetry: { sendFailures: number } };
      expect(s.telemetry.sendFailures).toBeGreaterThanOrEqual(1);
      expect(() => rt.destroy()).not.toThrow();
    }
  });
});

describe("telemetry: event shapes and the situation text", () => {
  it("with include.situation, a decision carries the exact redacted situation text the model received, its answers and the gate", async () => {
    const { rt, clock, transport, decider } = tsetup(
      { triage: "always", policy: { holdWrites: true }, script: defaultScript({ mutation: { diagnosis: "stale", action: "discard" } }) },
      { include: { situation: true } },
    );
    const auth = rt.atom("auth", { user: "ada", password: "hunter2-secret", token: "tok-SECRET-123" });
    void rt.op("login", () => auth.set({ user: "bob", password: "correct-horse", token: "tok-SECRET-456" }));
    await clock.flush();
    await rt.telemetry!.flush();
    const [d] = ofType(transport, "decision") as Record<string, any>[];
    expect(decider.calls).toHaveLength(1);
    expect(d.situation).toBe(stateText(decider.calls[0].state));
    expect(d.situation).toBe(rt.explain(d.id)!.situationText);
    for (const secret of ["hunter2", "correct-horse", "SECRET"]) expect(JSON.stringify(transport.sent)).not.toContain(secret);
    expect(d).toMatchObject({
      t: "decision",
      trigger: "mutation",
      route: "/search",
      model: "scripted",
      held: true,
      diagnosis: "stale",
      action: "discard",
      ran: "discard",
      executed: true,
      acted: true,
      tier: "guard",
      gateKind: "mass",
      threshold: 0.9,
      thresholdSource: "default",
      effectiveMode: "guard",
    });
    expect(d.questions).toEqual(expect.arrayContaining(["diagnosis", "action"]));
    expect(d.answers.diagnosis).toMatchObject({ type: "choice", choice: "stale" });
    expect(d.answers.action.probabilities.discard).toBe(0.97);
    expect(typeof d.latencyMs).toBe("number");
    expect(d.gates).toMatchObject({ guard: 0.9, heal: 0.8 });
    const [det] = ofType(transport, "detect");
    expect(det).toMatchObject({ decision: d.id, trigger: "mutation", diagnosis: "stale", p: 0.97 });
    const [act] = ofType(transport, "action") as Record<string, any>[];
    expect(act).toMatchObject({ decision: d.id, action: "discard", tier: "guard", trigger: "mutation", outcome: "applied", reversible: true });
    expect(act).not.toHaveProperty("error");
    // undo
    rt.interventions()[0].undo!();
    await rt.telemetry!.flush();
    expect(ofType(transport, "action").at(-1)).toMatchObject({ outcome: "undone", action: "discard" });
  });

  it("by default (include.situation off) the text is left out; vetoes, failures and late reverts are recorded", async () => {
    const { rt, clock, transport } = tsetup(
      { triage: "always", onBeforeAction: () => false, script: defaultScript({ mutation: { diagnosis: "stale", action: "discard" } }) },
      {},
    );
    const a = rt.atom("a", 1);
    void rt.op("w", () => a.set(2));
    await clock.flush();
    await rt.telemetry!.flush();
    const [d] = ofType(transport, "decision");
    expect(d).not.toHaveProperty("situation");
    expect(d).toMatchObject({ reason: "vetoed", acted: false });
    expect(ofType(transport, "veto")[0]).toMatchObject({ decision: d.id, action: "discard", enforced: true });
    expect(ofType(transport, "session")[0]).toMatchObject({ situation: false, runtime: RUNTIME_VERSION, mode: "guard", model: "custom", route: "/search" });
  });

  it("late reverts and model errors / fail-opens are counted", async () => {
    const { rt, clock, transport } = tsetup({ triage: "always", script: defaultScript({ mutation: { diagnosis: "stale", action: "discard" } }) });
    const a = rt.atom("a", 1);
    void rt.op("w", () => a.set(2));
    await clock.flush();
    await rt.telemetry!.flush();
    expect(ofType(transport, "action")[0]).toMatchObject({ outcome: "applied", late: true });

    let n = 0;
    const { rt: rt2, clock: c2, transport: t2 } = tsetup({
      triage: "always",
      script: () => {
        n++;
        throw Object.assign(new Error("inference failed"), { code: "inference_failed" });
      },
    });
    const b = rt2.atom("b", 1);
    void rt2.op("w", () => b.set(2));
    await c2.flush();
    expect(n).toBe(1);
    (rt2.telemetry as unknown as { summary(r: string): void }).summary("periodic");
    await rt2.telemetry!.flush();
    expect(ofType(t2, "model-error")[0]).toMatchObject({ code: "inference_failed", message: "inference failed" });
    const s = ofType(t2, "summary").at(-1) as Record<string, any>;
    expect(s.counts.modelErrors).toEqual({ inference_failed: 1 });
    expect(s.counts.failOpen).toEqual({ "no-answer:mutation": 1 });
    expect(b.get()).toBe(2);
  });

  it("telemetry never changes what the model sees", async () => {
    const run = async (telemetry: boolean) => {
      const s = telemetry ? tsetup({ triage: "always" }) : setup({ triage: "always" });
      const a = s.rt.atom("cart", { items: 1, card: "4111111111111111" });
      void s.rt.op("add", () => a.set({ items: 2, card: "4111111111111111" }));
      await s.clock.flush();
      return s.decider.calls.map((c) => JSON.stringify(c.state) + JSON.stringify(c.questions));
    };
    expect(await run(true)).toEqual(await run(false));
  });
});

describe("telemetry: GenClass never observes its own requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("uses the fetch captured at module load, not the instrumented one", async () => {
    vi.resetModules();
    const calls: string[] = [];
    const fake = vi.fn((url: string) => {
      calls.push(String(url));
      return Promise.resolve(new Response("{}", { status: 202, headers: { "content-type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fake);
    resetTelemetryNotice();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const m = await import("../src/index.js");
    const clock = new FakeClock();
    const rt = m.createRuntime({
      clock,
      decider: null,
      report: "silent",
      telemetry: { endpoint: "https://collector.test/v1/events" },
      observe: { fetch: true, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, timers: false },
    }) as RuntimeImpl;
    expect((globalThis as { fetch: unknown }).fetch).not.toBe(fake); // instrumented by the runtime
    await rt.telemetry!.flush();
    expect(calls).toEqual(["https://collector.test/v1/events"]);
    expect(rt.history().filter((e) => e.kind === "op.start")).toHaveLength(0);
    await (globalThis as { fetch: typeof fetch }).fetch("https://app.test/api/items");
    expect(rt.history().filter((e) => e.kind === "op.start").map((e) => e.name)).toEqual([expect.stringContaining("/api/items")]);
    rt.destroy();
    vi.restoreAllMocks();
  });
});

void createRuntime;
