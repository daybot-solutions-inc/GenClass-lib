// ModelHost queue, priorities, timeouts, preload modes, status and fallbacks, against a fake worker and clock.
import { describe, expect, it } from "vitest";
import type { Clock } from "../../src/types.js";
import {
  MaxTokensExceededError,
  ModelBusyError,
  ModelDisposedError,
  ModelLoadError,
  ModelNotReadyError,
  ModelTimeoutError,
  serializeError,
} from "../../src/model/errors.js";
import { createModelHost, type ModelHostOptions, type WorkerLike } from "../../src/model/host.js";
import type { FromWorker, ToWorker } from "../../src/model/protocol.js";

class FakeClock implements Clock {
  t = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private next = 1;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h as number);
  }
  afterTask(fn: () => void): void {
    queueMicrotask(fn);
  }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      let best: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.timers) if (e[1].at <= end && (!best || e[1].at < best[1].at)) best = e;
      if (!best) break;
      this.timers.delete(best[0]);
      this.t = best[1].at;
      best[1].fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

class FakeWorker implements WorkerLike {
  sent: ToWorker[] = [];
  terminated = false;
  private listeners: Record<string, Array<(ev: any) => void>> = { message: [], error: [], messageerror: [] };
  postMessage(m: ToWorker): void {
    if (this.terminated) throw new Error("terminated");
    this.sent.push(m);
  }
  terminate(): void {
    this.terminated = true;
  }
  addEventListener(type: string, fn: (ev: any) => void): void {
    this.listeners[type].push(fn);
  }
  emit(m: FromWorker): void {
    for (const fn of this.listeners.message) fn({ data: m });
  }
  fail(message: string): void {
    for (const fn of this.listeners.error) fn({ message, preventDefault() {} });
  }
  evaluates(): Array<Extract<ToWorker, { type: "evaluate" }>> {
    return this.sent.filter((m): m is Extract<ToWorker, { type: "evaluate" }> => m.type === "evaluate");
  }
  ready(): void {
    this.emit({ type: "hello" });
    this.emit({ type: "status", status: { state: "ready", device: "wasm", variant: "q8", model: "genclass-test", version: "0.0.1", loadMs: 12, bytes: 1000, fromCache: false } });
  }
  answer(id: number, choice = "a", total = 6, tokens = 10): void {
    this.emit({ type: "result", id, ok: true, value: { answers: { q: { type: "choice", choice, confidence: 1, probabilities: { [choice]: 1 } } }, model: "m", usage: { input_tokens: tokens, positions: tokens }, timings: { pack: 1, forward: total - 1, total } } });
  }
}

const Q = { q: { type: "choice" as const, instructions: "pick", criteria: { a: null, b: null } } };
const req = (priority = 0, timeoutMs?: number) => ({ trigger: "mutation" as const, state: { s: `p${priority}` }, questions: Q, priority, ...(timeoutMs ? { timeoutMs } : {}) });

function setup(extra: Partial<ModelHostOptions> = {}) {
  const clock = new FakeClock();
  const workers: FakeWorker[] = [];
  const host = createModelHost({
    baseUrl: "https://models.example/genclass/",
    clock,
    preload: "eager",
    workerFactory: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    ...extra,
  });
  return { host, clock, workers, w: () => workers[workers.length - 1] };
}

describe("ModelHost", () => {
  it("lazy: nothing happens until the first evaluate, which fails open at once and starts the load", async () => {
    const { host, workers, w } = setup({ preload: "lazy" });
    expect(workers.length).toBe(0);
    expect(host.status.state).toBe("off");
    const err = await host.evaluate(req()).catch((e) => e);
    expect(err).toBeInstanceOf(ModelNotReadyError);
    expect(err.code).toBe("not_ready");
    expect(workers.length).toBe(1);
    expect(w().sent[0]).toMatchObject({ type: "load", options: { baseUrl: "https://models.example/genclass/", device: "auto" } });
    expect(host.status).toMatchObject({ state: "loading", worker: true });
    expect(host.stats.notReady).toBe(1);
  });

  it("lazy: ready() starts the load and resolves on the ready status", async () => {
    const { host, workers, w } = setup({ preload: "lazy" });
    const p = host.ready();
    expect(workers.length).toBe(1);
    w().ready();
    await p;
    expect(host.status).toMatchObject({ state: "ready", device: "wasm", variant: "q8", model: "genclass-test", worker: true, fromCache: false });
  });

  it("idle: starts after the idle callback (timer fallback without requestIdleCallback)", async () => {
    const { workers, clock } = setup({ preload: "idle" });
    expect(workers.length).toBe(0);
    await clock.advance(5000);
    expect(workers.length).toBe(1);
  });

  it("status listeners see every update; ready() rejects with the load error", async () => {
    const { host, w } = setup();
    const seen: string[] = [];
    host.onStatus((s) => seen.push(`${s.state}${s.progress ? `:${s.progress.loaded}/${s.progress.total}` : ""}`));
    const p = host.ready();
    w().emit({ type: "hello" });
    w().emit({ type: "status", status: { state: "loading", phase: "download", progress: { loaded: 5, total: 10 } } });
    w().emit({ type: "status", status: { state: "error", error: "no plan could run the model", attempts: [{ variant: "q8", device: "wasm", error: "boom" }] } });
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(ModelLoadError);
    expect(err.attempts[0].error).toBe("boom");
    expect(seen).toEqual(["loading:5/10", "error"]);
    expect(host.status.worker).toBe(true);
  });

  it("runs one request at a time, higher priority first, FIFO within a priority", async () => {
    const { host, w } = setup();
    w().ready();
    await flush();
    const order: string[] = [];
    const ps = [req(0), req(0), req(2), req(1), req(2)].map((r, i) =>
      host.evaluate({ ...r, state: { n: i } }).then(() => order.push(`r${i}`)),
    );
    await flush();
    expect(w().evaluates().length).toBe(1); // only the first is in flight
    for (let k = 0; k < 5; k++) {
      const ev = w().evaluates();
      expect(ev.length).toBe(k + 1);
      w().answer(ev[k].id);
      await flush();
    }
    await Promise.all(ps);
    expect(w().evaluates().map((m) => (m.state as { n: number }).n)).toEqual([0, 2, 4, 3, 1]);
    expect(order).toEqual(["r0", "r2", "r4", "r3", "r1"]);
    expect(host.stats.completed).toBe(5);
  });

  it("times out queued requests without running them; a running one rejects but keeps the slot until answered", async () => {
    const { host, w, clock } = setup();
    w().ready();
    await flush();
    const a = host.evaluate(req(0, 1000)).catch((e) => e);
    const b = host.evaluate(req(0, 500)).catch((e) => e);
    await flush();
    await clock.advance(600);
    expect(await b).toBeInstanceOf(ModelTimeoutError);
    await clock.advance(500);
    const ea = await a;
    expect(ea).toBeInstanceOf(ModelTimeoutError);
    expect(ea.code).toBe("timeout");
    const c = host.evaluate(req(0, 5000));
    await flush();
    expect(w().evaluates().length).toBe(1); // b never ran, c waits for the slot
    w().answer(w().evaluates()[0].id); // late answer for a frees the slot
    await flush();
    expect(w().evaluates().length).toBe(2);
    w().answer(w().evaluates()[1].id, "b");
    expect((await c).q).toMatchObject({ choice: "b" });
    expect(host.stats.timeouts).toBe(2);
  });

  it("a full queue evicts the lowest-priority, oldest request", async () => {
    const { host, w } = setup({ maxQueue: 2 });
    w().ready();
    await flush();
    const running = host.evaluate(req(5));
    const low = host.evaluate(req(0)).catch((e) => e);
    const mid = host.evaluate(req(1));
    const high = host.evaluate(req(3)); // queue full (low, mid): evicts low
    expect(await low).toBeInstanceOf(ModelBusyError);
    const lower = await host.evaluate(req(0)).catch((e) => e); // lowest itself: rejected
    expect(lower).toBeInstanceOf(ModelBusyError);
    for (let k = 0; k < 3; k++) {
      await flush();
      w().answer(w().evaluates()[k].id);
    }
    await Promise.all([running, mid, high]);
    expect(host.stats.busy).toBe(2);
  });

  it("status.latency: p50/p90 over the last 20 evaluations; listeners hear about it at most every 5 s", async () => {
    const { host, w, clock } = setup();
    w().ready();
    await flush();
    let notes = 0;
    host.onStatus(() => notes++);
    const one = async (ms: number) => {
      const p = host.evaluate(req());
      await flush();
      const ev = w().evaluates();
      w().answer(ev[ev.length - 1].id, "a", ms, 500);
      await p;
    };
    for (let k = 0; k < 25; k++) await one(100 + k * 10);
    // window = the last 20 (150..340 ms); nearest rank: p50 = 10th = 240, p90 = 18th = 320
    expect(host.status.latency).toEqual({ p50: 240, p90: 320, n: 20, tokensP50: 500, msPerToken: 0.48, source: "evaluations" });
    expect(notes).toBe(1); // only the first evaluation: the clock has not moved 5 s
    await clock.advance(5000);
    await one(1000);
    expect(notes).toBe(2);
    expect(host.status.latency?.p90).toBe(330);
    expect(host.status.state).toBe("ready");
  });

  it("errors cross the worker boundary as typed errors", async () => {
    const { host, w } = setup();
    w().ready();
    await flush();
    const p = host.evaluate(req()).catch((e) => e);
    await flush();
    w().emit({ type: "result", id: w().evaluates()[0].id, ok: false, error: serializeError(new MaxTokensExceededError(2000, 2100, 1536, 8192)) });
    const e = await p;
    expect(e).toBeInstanceOf(MaxTokensExceededError);
    expect(e).toMatchObject({ code: "max_tokens_exceeded", tokens: 2000, total: 2100, maxTokens: 1536 });
  });

  it("normalises the state to JSON before posting it", async () => {
    const { host, w } = setup();
    w().ready();
    await flush();
    void host.evaluate({ ...req(), state: { a: undefined, b: NaN, c: [1, undefined] } as any });
    await flush();
    expect(w().evaluates()[0].state).toEqual({ b: null, c: [1, null] });
  });

  it("measure goes straight to the worker", async () => {
    const { host, w } = setup();
    w().ready();
    await flush();
    const p = host.measure({ s: "x" });
    await flush();
    const m = w().sent.find((x) => x.type === "measure") as Extract<ToWorker, { type: "measure" }>;
    w().emit({ type: "result", id: m.id, ok: true, value: { stateTokens: 5, positions: 5, total: 5 } });
    expect(await p).toEqual({ stateTokens: 5, positions: 5, total: 5 });
  });

  it("dispose rejects everything pending, terminates the worker and reports off", async () => {
    const { host, w } = setup();
    w().ready();
    await flush();
    const states: string[] = [];
    host.onStatus((s) => states.push(s.state));
    const a = host.evaluate(req()).catch((e) => e);
    const b = host.evaluate(req()).catch((e) => e);
    await flush();
    host.dispose();
    expect(await a).toBeInstanceOf(ModelDisposedError);
    expect(await b).toBeInstanceOf(ModelDisposedError);
    expect(w().terminated).toBe(true);
    expect(states).toEqual(["off"]);
    expect(await host.evaluate(req()).catch((e) => e)).toBeInstanceOf(ModelDisposedError);
  });

  it("a worker crash after start-up becomes an error status; load() starts a fresh worker", async () => {
    const { host, w, workers } = setup();
    w().ready();
    await flush();
    const a = host.evaluate(req()).catch((e) => e);
    await flush();
    w().fail("out of memory");
    expect(await a).toBeInstanceOf(ModelLoadError);
    expect(host.status).toMatchObject({ state: "error", worker: true });
    expect(host.status.error).toContain("out of memory");
    const p = host.load();
    expect(workers.length).toBe(2);
    w().ready();
    await p;
    expect(host.status.state).toBe("ready");
  });
});

describe("ModelHost WebGPU recovery", () => {
  it("a worker whose load failed after a WebGPU attempt is replaced once by a fresh WASM-only worker", async () => {
    const { host, workers, w } = setup({ device: "auto" });
    w().emit({ type: "hello" });
    w().emit({ type: "status", status: { state: "error", error: "WebGPU did not come up", attempts: [{ variant: "fp16", device: "webgpu", error: "webgpu session creation timed out after 60000 ms" }] } });
    expect(workers.length).toBe(2);
    expect(workers[0].terminated).toBe(true);
    expect(w().sent[0]).toMatchObject({ type: "load", options: { device: "wasm" } });
    expect(host.status.state).toBe("loading");
    const p = host.ready();
    w().ready();
    await p;
    expect(host.status.attempts?.map((a) => a.device)).toEqual(["webgpu"]);
    // only once: a second WebGPU failure is reported
    expect(workers.length).toBe(2);
  });

  it("a worker that dies while loading on WebGPU is replaced by a WASM-only worker", async () => {
    const { host, workers, w } = setup();
    w().emit({ type: "hello" });
    w().emit({ type: "status", status: { state: "loading", phase: "session", device: "webgpu", variant: "fp16" } });
    w().fail("GPU process crashed");
    expect(workers.length).toBe(2);
    expect(w().sent[0]).toMatchObject({ type: "load", options: { device: "wasm" } });
    w().ready();
    expect(host.status.state).toBe("ready");
    expect(host.status.attempts?.[0]).toMatchObject({ device: "webgpu", variant: "fp16", error: "GPU process crashed" });
  });

  it("a loading worker that goes silent is treated as stuck: on WebGPU it is retried on WASM, otherwise it errors", async () => {
    const a = setup({ loadStallMs: 10_000 });
    a.w().emit({ type: "hello" });
    a.w().emit({ type: "status", status: { state: "loading", phase: "session", device: "webgpu", variant: "q8" } });
    await a.clock.advance(10_001);
    expect(a.workers.length).toBe(2);
    expect(a.w().sent[0]).toMatchObject({ type: "load", options: { device: "wasm" } });
    a.w().ready();
    expect(a.host.status.attempts?.[0]).toMatchObject({ device: "webgpu", error: "stalled" });

    const b = setup({ loadStallMs: 10_000 });
    b.w().emit({ type: "hello" });
    b.w().emit({ type: "status", status: { state: "loading", phase: "warmup", device: "wasm", variant: "q8" } });
    const r = b.host.ready().catch((e) => e);
    await b.clock.advance(10_001);
    expect(await r).toBeInstanceOf(ModelLoadError);
    expect(b.host.status.error).toContain("stopped responding while loading (warmup on wasm)");
    expect(b.workers.length).toBe(1);
  });
});

describe("ModelHost inline fallback", () => {
  const failingFetch = (async () => {
    throw new TypeError("network down");
  }) as unknown as typeof fetch;
  const ortLoader = async () => ({ env: { wasm: {}, versions: { web: "1.30.0" } } }) as any;

  it("falls back inline when the worker cannot be created", async () => {
    const { host } = setup({ workerFactory: () => { throw new Error("CSP: worker-src 'none'"); }, fetch: failingFetch, ortLoader });
    expect(host.status).toMatchObject({ state: "loading", worker: false });
    const err = await host.ready().catch((e) => e);
    expect(err).toBeInstanceOf(ModelLoadError);
    expect(host.status).toMatchObject({ state: "error", worker: false });
    expect(host.status.error).toContain("network down");
  });

  it("falls back inline when the worker errors before saying hello (e.g. a 404 worker script)", async () => {
    const { host, w } = setup({ fetch: failingFetch, ortLoader });
    expect(host.status.worker).toBe(true);
    w().fail("Failed to fetch worker script");
    expect(w().terminated).toBe(true);
    expect(host.status).toMatchObject({ state: "loading", worker: false, workerError: "Failed to fetch worker script" });
    await host.ready().catch(() => undefined);
    expect(host.status.worker).toBe(false);
  });

  it("falls back inline when the worker never comes up", async () => {
    const { host, w, clock } = setup({ fetch: failingFetch, ortLoader, helloTimeoutMs: 3000 });
    await clock.advance(3001);
    expect(w().terminated).toBe(true);
    expect(host.status.worker).toBe(false);
    expect(host.status.workerError).toContain("did not start");
  });

  it("worker: false runs inline from the start", async () => {
    const { host, workers } = setup({ worker: false, fetch: failingFetch, ortLoader });
    expect(workers.length).toBe(0);
    expect(host.status.worker).toBe(false);
  });
});
