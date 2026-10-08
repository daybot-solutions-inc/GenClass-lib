// Situation v2: decide at the network boundary (the `delivery` trigger), never hold store writes by default.
import { describe, expect, it } from "vitest";
import type { Answer, EvaluateRequest, Op } from "../src/types.js";
import { stateText } from "../src/situation/serialize.js";
import { FakeClock, ManualDecider, defaultScript, setup, type Setup } from "./helpers.js";

const stale = defaultScript({ delivery: { diagnosis: "stale", action: "discard" }, mutation: { diagnosis: "stale", action: "discard" } });

/** A global whose setTimeout runs on the fake clock (so debounces are observed by the timers observer). */
function timers(holder: { clock?: FakeClock }) {
  return {
    setTimeout: (fn: () => void, ms: number) => holder.clock!.setTimeout(fn, ms),
    clearTimeout: (h: unknown) => holder.clock!.clearTimeout(h),
  };
}

/** The DEMOS search app: input + loading written on every keystroke, a 150 ms debounce, results + loading:false. */
function searchApp(s: Setup) {
  const { rt, g, fetch } = s;
  const search = rt.atom("search", { input: "", query: "", items: [] as string[], total: 0, loading: false, error: null as string | null });
  let debounce: unknown;
  const setT = g.setTimeout as (f: () => void, ms: number) => unknown;
  const clearT = g.clearTimeout as (h: unknown) => void;
  const type = (value: string) =>
    rt.user({ kind: "type", target: 'input "Search a city"', value }, () => {
      search.set((v) => ({ ...v, input: value, loading: value.trim() !== "" }));
      clearT(debounce);
      debounce = setT(() => {
        void (async () => {
          const res = await fetch(`/api/search?q=${encodeURIComponent(value)}`);
          const data = (await res.json()) as { query: string; items: string[] };
          search.set((v) => ({ ...v, query: data.query, items: data.items, total: data.items.length, loading: false, error: null }));
        })();
      }, 150);
    });
  return { search, type };
}

describe("delivery: typeahead", () => {
  it("clean typing (in-order responses, loading flags, debounce) makes zero model calls", async () => {
    const holder: { clock?: FakeClock } = {};
    const s = setup({ observe: { fetch: true, timers: true }, extraGlobal: timers(holder) });
    holder.clock = s.clock;
    s.server.on("GET", "/api/search", ({ url }) => {
      const q = url.searchParams.get("q") ?? "";
      return { body: { query: q, items: [`${q} city`, `${q}ville`] }, latency: 180 };
    });
    const app = searchApp(s);
    const word = "barcelona";
    for (let i = 1; i <= word.length; i++) {
      app.type(word.slice(0, i));
      await s.clock.advance(200);
    }
    await s.clock.advance(2000);
    expect(app.search.get().query).toBe("barcelona");
    expect(s.decider.calls).toHaveLength(0);
  });

  it("a debounced search that sets its own loading flag: no model call and no hold, also when an older response lands while the newer request is in flight", async () => {
    const holder: { clock?: FakeClock } = {};
    const s = setup({ observe: { fetch: true, timers: true }, extraGlobal: timers(holder) });
    holder.clock = s.clock;
    // latencies vary so that some older responses land while a newer request is still in flight
    const lat = [400, 120, 380, 90, 300, 150, 260, 100, 200];
    let k = 0;
    s.server.on("GET", "/api/search", ({ url }) => {
      const q = url.searchParams.get("q") ?? "";
      return { body: { query: q, items: [`${q}-1`] }, latency: lat[k++ % lat.length] };
    });
    const st = s.rt.atom("search", { input: "", fetching: false, query: "", items: [] as string[] });
    const setT = s.g.setTimeout as (f: () => void, ms: number) => unknown;
    const clearT = s.g.clearTimeout as (h: unknown) => void;
    let debounce: unknown;
    let latest = "";
    const held: number[] = [];
    const type = (value: string) =>
      s.rt.user({ kind: "type", target: 'input "Search"', value }, () => {
        st.set((v) => ({ ...v, input: value }));
        clearT(debounce);
        debounce = setT(() => {
          latest = value;
          st.set((v) => ({ ...v, fetching: true })); // written by the timer's chain, not by the user
          void (async () => {
            const res = await s.fetch(`/api/search?q=${value}`);
            const arrived = s.clock.now();
            const d = (await res.json()) as { query: string; items: string[] };
            held.push(s.clock.now() - arrived);
            if (d.query === latest) st.set((v) => ({ ...v, fetching: false, query: d.query, items: d.items })); // the app ignores stale answers
          })();
        }, 80);
      });
    for (const w of ["b", "ba", "bar", "barc", "barce", "barcel", "barcelo", "barcelon", "barcelona"]) {
      type(w);
      await s.clock.advance(110);
    }
    await s.clock.advance(2000);
    expect(st.get().query).toBe("barcelona");
    expect(s.decider.calls.filter((c) => c.trigger === "delivery")).toHaveLength(0);
    expect(held.every((ms) => ms === 0)).toBe(true);
  });

  it("a stale out-of-order response gets a delivery decision; discard drops only the stale field writes", async () => {
    const s = setup({ script: stale });
    s.server.on("GET", "/api/search", ({ url }) => {
      const q = url.searchParams.get("q") ?? "";
      return { body: { q, items: [`${q}-1`] }, latency: q === "a" ? 600 : 100 };
    });
    const st = s.rt.atom("search", { items: [] as string[], loaded: {} as Record<string, boolean> });
    const load = (q: string) =>
      s.rt.user({ kind: "type", target: 'input "Search"', value: q }, () => {
        void (async () => {
          const d = (await (await s.fetch(`/api/search?q=${q}`)).json()) as { q: string; items: string[] };
          st.set((v) => ({ items: d.items, loaded: { ...v.loaded, [d.q]: true } }));
        })();
      });
    load("z"); // a first completion: the signature's write set is learned (search.items, search.loaded.*)
    await s.clock.advance(300);
    load("a"); // slow
    await s.clock.advance(20);
    load("ab"); // fast: answers first
    await s.clock.advance(1000);
    expect(st.get().items).toEqual(["ab-1"]); // the stale results were dropped
    expect(st.get().loaded).toEqual({ z: true, ab: true, a: true }); // the per-query flag of the stale response applied
    const del = s.decider.calls.filter((c) => c.trigger === "delivery");
    expect(del).toHaveLength(1);
    expect(del[0].state.trigger).toMatch(/^The response to GET \/api\/search\?q=a \(#\d+\) arrived and is about to be delivered; its operation (usually writes|last wrote) search\.items/);
    expect((del[0].state.facts as string[])[0]).toMatch(/^search\.items was written once by other operations since its operation \(#\d+\) started \(version 1 → 2\), last 0\.\d\ds ago by GET \/api\/search\?q=ab/);
    expect(del[0].subject).toMatchObject({ kind: "delivery", paths: ["search.items"] });
    const rec = s.rt.interventions()[0];
    expect(rec.action).toBe("discard");
    expect(rec.dropped).toEqual(["search.items"]);
    expect(rec.changed).toMatch(/^Delivered the response to GET \/api\/search\?q=a \(#\d+\) and dropped the state changes it makes over newer data \(search\.items\)\.$/);
    const ev = s.rt.history().find((e) => e.kind === "action" && e.name === "dropped")!;
    expect(ev.data).toMatchObject({ paths: ["search.items"] });
    rec.undo!();
    expect(st.get().items).toEqual(["a-1"]);
  });

  it("holding a response is only latency: the app's promise resolves after the decision", async () => {
    const manual = new ManualDecider();
    const s = setup({ decider: manual, triage: "always" });
    s.server.on("GET", "/api/x", { body: { v: 1 }, latency: 50 });
    let at = -1;
    const t0 = s.clock.now();
    void s.fetch("/api/x").then(() => (at = s.clock.now() - t0));
    await s.clock.advance(50); // request held for its decision (triage always): answer it
    manual.answer(defaultScript());
    await s.clock.advance(100);
    expect(manual.pending.map((p) => p.req.trigger)).toEqual(["delivery"]);
    expect(at).toBe(-1); // still held
    manual.answer(defaultScript());
    await s.clock.flush();
    expect(at).toBe(150);
  });

  it("does not hold when the model is not expected to answer within the hold budget", async () => {
    const manual = new ManualDecider();
    const s = setup({ decider: manual, triage: "always" });
    manual.status = { state: "ready", warmupMs: 2000 }; // expected ~2 s; the auto budget tops out at 800 ms
    s.server.on("GET", "/api/x", { body: 1, latency: 50 });
    let at = -1;
    const t0 = s.clock.now();
    void s.fetch("/api/x").then(() => (at = s.clock.now() - t0));
    await s.clock.advance(100);
    expect(at).toBe(50); // neither the request nor the response waited
  });
});

describe("store writes are never held by default", () => {
  it("read-after-write: set(x); get() returns x even for a salient write", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always" });
    const a = rt.atom("a", { v: 0 });
    let read = -1;
    void rt.op("w", () => {
      a.set({ v: 7 });
      read = a.get().v;
    });
    expect(read).toBe(7);
    expect(a.get().v).toBe(7);
    expect(manual.pending.map((p) => p.req.trigger)).toEqual(["mutation"]); // decided in the background
    await clock.flush();
  });

  it("a background decision can still revert the write (late revert), within the strict rules", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always" });
    const a = rt.atom("a", { v: 0 });
    void rt.op("w", () => a.set({ v: 7 }));
    await clock.advance(300);
    manual.answer(stale);
    await clock.flush();
    expect(a.get().v).toBe(0);
    const rec = rt.interventions()[0];
    expect(rec.late).toBe(true);
    expect(rec.changed).toMatch(/^Reverted the write to a\.v from task w \(#\d+\) \(decided 0\.30s after it applied\)/);
  });

  it("a slow model: the response is released at the budget, its writes are decided in the background and late-reverted", async () => {
    const manual = new ManualDecider();
    const s = setup({ decider: manual, policy: { holdBudgetMs: 100 } });
    s.server.on("GET", "/api/doc", ({ n }) => ({ body: { v: n }, latency: n === 2 ? 500 : 50 }));
    const doc = s.rt.atom("doc", { v: 0 });
    let k = 0;
    const load = () =>
      s.rt.user({ kind: "click", target: 'button "Reload"' }, () => {
        void (async () => {
          const d = (await (await s.fetch(`/api/doc?i=${++k}`)).json()) as { v: number };
          doc.set({ v: d.v });
        })();
      });
    load(); // learn the write set
    await s.clock.advance(200);
    load(); // slow (#2)
    await s.clock.advance(10);
    load(); // fast (#3): writes v = 3 first
    await s.clock.advance(200);
    expect(doc.get().v).toBe(3);
    await s.clock.advance(400); // #2 arrives at 700: its delivery is salient, held for 100 ms, then released
    expect(doc.get().v).toBe(2); // released at the budget: the app wrote the stale value
    // the runtime stopped waiting for the delivery decision at its deadline; the write was not covered, so it is
    // decided in the background
    expect(manual.pending.map((p) => p.req.trigger)).toEqual(["delivery", "mutation"]);
    manual.answer(stale); // the abandoned delivery decision: ignored
    manual.answer(stale);
    await s.clock.flush();
    expect(doc.get().v).toBe(3); // late revert
    expect(s.rt.interventions().map((r) => [r.action, r.late])).toEqual([["discard", true]]);
    expect(s.rt.decisions().map((d) => d.trigger)).toEqual(["mutation"]);
  });

  it("drops a queued background decision whose write was superseded before the model got to it", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always" });
    const a = rt.atom("a", 0);
    const b = rt.atom("b", 0);
    void rt.op("w1", () => b.set(1)); // dispatched to the model
    void rt.op("w2", () => a.set(1)); // queued
    void rt.op("w3", () => a.set(2)); // supersedes w2 (and is queued itself)
    const w3 = rt.internals.hub.field("a")!.log.at(-1)!.mutation;
    manual.answer(defaultScript());
    await clock.flush();
    // w2's queued decision was dropped (superseded by w3 before the model got to it); w3's is being computed
    expect(manual.pending.map((p) => p.req.subject?.mutation)).toEqual([w3]);
    while (manual.pending.length) manual.answer(defaultScript());
    await clock.flush();
    expect(rt.decisions()).toHaveLength(2);
  });
});

// ------------------------------------------------------------------------------------------- push channels

class FakeWS extends EventTarget {
  static all: FakeWS[] = [];
  sent: unknown[] = [];
  constructor(public url: string) {
    super();
    FakeWS.all.push(this);
  }
  set onmessage(fn: (e: MessageEvent) => void) {
    this.addEventListener("message", fn as EventListener);
  }
  send(d: unknown) {
    this.sent.push(d);
  }
  emit(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}

class FakeES extends EventTarget {
  static all: FakeES[] = [];
  constructor(public url: string) {
    super();
    FakeES.all.push(this);
  }
  emit(type: string, data: unknown, id: string) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data), lastEventId: id }));
  }
}

function board(s: Setup) {
  const b = s.rt.atom("board", { cards: { c1: "todo", c2: "todo" } as Record<string, string> });
  const seen: number[] = [];
  const ws = new (s.g.WebSocket as typeof FakeWS)("ws://app.test/live");
  ws.onmessage = (e: MessageEvent) => {
    const m = JSON.parse(e.data as string) as { n: number; card: string; col: string };
    seen.push(m.n);
    b.set((v) => ({ cards: { ...v.cards, [m.card]: m.col } }));
  };
  const socket = FakeWS.all[FakeWS.all.length - 1];
  return { b, seen, socket };
}

describe("delivery: WebSocket messages", () => {
  it("a message that would put back the value a pending local change replaced is held; later messages wait behind it (order kept); discard drops its write", async () => {
    const manual = new ManualDecider();
    const created: Op[] = [];
    const s = setup({ decider: manual, observe: { fetch: true, websocket: true }, extraGlobal: { WebSocket: FakeWS }, hooks: { opCreated: (op) => created.push(op) } });
    s.server.on("PATCH", "/api/cards/c1", { body: { ok: true }, latency: 800 });
    const { b, seen, socket } = board(s);
    socket.emit({ n: 1, card: "c2", col: "doing" }); // learn what these messages write
    await s.clock.advance(50);
    // the user moves c1 (optimistic) and the save is in flight
    s.rt.user({ kind: "click", target: 'button "Move c1 to done"' }, () => {
      b.set((v) => ({ cards: { ...v.cards, c1: "done" } }));
      void s.fetch("/api/cards/c1", { method: "PATCH", body: '{"col":"done"}' });
    });
    await s.clock.advance(50);
    socket.emit({ n: 2, card: "c1", col: "todo" }); // older server state for c1 (before the user's move): held
    const msgOp = created[created.length - 1];
    expect(msgOp.name).toBe("WS message /live"); // created synchronously inside the dispatch
    socket.emit({ n: 3, card: "c2", col: "review" }); // queued behind #2
    await s.clock.flush();
    expect(seen).toEqual([1]);
    expect(manual.pending.map((p) => p.req.trigger)).toEqual(["delivery"]);
    const req: EvaluateRequest = manual.answer(stale);
    console.log(`==== delivery (WebSocket) ====\n${stateText(req.state)}\n`);
    expect(req.state.trigger).toMatch(/^A WebSocket message \/live \(#\d+\) arrived and is about to be delivered; messages like it last wrote board\.cards\.:id\.$/);
    expect((req.state.facts as string[])[0]).toMatch(/^board\.cards\.c1 has a pending local change: user clicked button "Move c1 to done" \(#\d+\) wrote it 0\.05s ago and its PATCH \/api\/cards\/c1 \{col: "done"\} \(#\d+\) is still in flight/);
    await s.clock.flush();
    // #2 delivered (its write over the pending change dropped), then #3 right behind it: #3 is about c2 and does not
    // touch the pending change, so it needs no decision
    expect(seen).toEqual([1, 2, 3]);
    expect(b.get().cards.c1).toBe("done");
    expect(manual.pending.length).toBe(0);
    expect(b.get().cards).toEqual({ c1: "done", c2: "review" });
    await s.clock.advance(1000);
  });

  it("a message with a third value over a pending local change is delivered at once (the pending request decides)", async () => {
    const s = setup({ observe: { fetch: true, websocket: true }, extraGlobal: { WebSocket: FakeWS } });
    s.server.on("PATCH", "/api/cards/c1", { body: { ok: true }, latency: 800 });
    const { b, seen, socket } = board(s);
    socket.emit({ n: 1, card: "c2", col: "doing" });
    await s.clock.advance(50);
    s.rt.user({ kind: "click", target: 'button "Move c1 to done"' }, () => {
      b.set((v) => ({ cards: { ...v.cards, c1: "done" } }));
      void s.fetch("/api/cards/c1", { method: "PATCH", body: '{"col":"done"}' });
    });
    await s.clock.advance(50);
    socket.emit({ n: 2, card: "c1", col: "review" });
    await s.clock.flush();
    expect(seen).toEqual([1, 2]);
    expect(s.decider.calls.filter((c) => c.trigger === "delivery")).toHaveLength(0);
    await s.clock.advance(1000);
  });

  it("messages that touch nothing pending are delivered at once (no model call)", async () => {
    const s = setup({ observe: { fetch: true, websocket: true }, extraGlobal: { WebSocket: FakeWS } });
    const { seen, socket } = board(s);
    for (let i = 1; i <= 5; i++) socket.emit({ n: i, card: "c2", col: `col${i}` });
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(s.decider.calls).toHaveLength(0);
    const w = s.rt.history().filter((e) => e.kind === "state").pop()!;
    expect(s.rt.ops.get(w.op)!.name).toBe("WS message /live");
  });
});

describe("delivery: EventSource", () => {
  it("custom event types are observed as ops; a held message delays the handler, order kept", async () => {
    const manual = new ManualDecider();
    const s = setup({ decider: manual, triage: "always", observe: { fetch: true, eventsource: true }, extraGlobal: { EventSource: FakeES } });
    const st = s.rt.atom("feed", { last: 0 });
    const got: number[] = [];
    const es = new (s.g.EventSource as typeof FakeES)("http://app.test/stream");
    es.addEventListener("update", (e) => {
      const d = JSON.parse((e as MessageEvent).data as string) as { n: number };
      got.push(d.n);
      st.set({ last: d.n });
    });
    const src = FakeES.all[FakeES.all.length - 1];
    src.emit("update", { n: 1 }, "e1"); // triage always: held for the model
    src.emit("update", { n: 2 }, "e2"); // queued behind
    expect(got).toEqual([]);
    await s.clock.flush(); // the gate reads the message body before asking
    manual.answer(defaultScript());
    await s.clock.flush();
    expect(got).toEqual([1]);
    while (manual.pending.length) {
      manual.answer(defaultScript());
      await s.clock.flush();
    }
    expect(got).toEqual([1, 2]);
    const w = s.rt.history().filter((e) => e.kind === "state").pop()!;
    expect(s.rt.ops.get(w.op)!.name).toBe("SSE update /stream");
  });
});

/** An XMLHttpRequest stand-in like the real one where it matters: state behind getters, on* handlers called by the
 * object itself after the listeners, open() resets, abort() of a completed request fires nothing. */
function makeXHR(ref: { clock?: FakeClock }, handler: (method: string, url: string) => { status: number; body: string; latency: number }) {
  return class FakeXHR extends EventTarget {
    #rs = 0;
    #status = 0;
    #text = "";
    #m = "GET";
    #u = "";
    #sending = false;
    responseType = "";
    onload: ((e: Event) => void) | null = null;
    onreadystatechange: ((e: Event) => void) | null = null;
    get readyState() {
      return this.#rs;
    }
    get status() {
      return this.#status;
    }
    get statusText() {
      return this.#status === 200 ? "OK" : "";
    }
    get responseText() {
      return this.#text;
    }
    get response() {
      return this.#text;
    }
    open(m: string, u: string) {
      this.#m = m;
      this.#u = u;
      this.#rs = 1;
      this.#status = 0;
      this.#text = "";
      this.#sending = false;
    }
    send() {
      this.#sending = true;
      const r = handler(this.#m, this.#u);
      ref.clock!.setTimeout(() => {
        if (!this.#sending) return;
        this.#sending = false;
        this.#rs = 4;
        this.#status = r.status;
        this.#text = r.body;
        this.#fire("readystatechange");
        this.#fire("load");
        this.#fire("loadend");
      }, r.latency);
    }
    abort() {
      if (this.#rs === 4) {
        this.#rs = 0;
        this.#status = 0;
      }
    }
    setRequestHeader() {}
    #fire(t: string) {
      const e = new Event(t);
      this.dispatchEvent(e);
      const h = (this as unknown as Record<string, unknown>)[`on${t}`];
      if (typeof h === "function") h.call(this, e);
    }
    getResponseHeader(): string | null {
      return null;
    }
    getAllResponseHeaders(): string {
      return "";
    }
  };
}

describe("delivery: XMLHttpRequest", () => {
  it("a stale response is held before any app completion listener runs (added before or after open, or on*), in order; discard drops only the stale field", async () => {
    const ref: { clock?: FakeClock } = {};
    const XHR = makeXHR(ref, (_m, url) => {
      const q = new URL(url, "http://app.test/").searchParams.get("q") ?? "";
      return { status: 200, body: JSON.stringify({ q, items: [`${q}-1`] }), latency: q === "a" ? 600 : 100 };
    });
    const s = setup({ script: stale, observe: { fetch: false, xhr: true }, extraGlobal: { XMLHttpRequest: XHR } });
    ref.clock = s.clock;
    const st = s.rt.atom("search", { items: [] as string[], loaded: {} as Record<string, boolean> });
    const log: string[] = [];
    const load = (q: string) =>
      s.rt.user({ kind: "type", target: 'input "Search"', value: q }, () => {
        const x = new (s.g.XMLHttpRequest as typeof XHR)();
        x.addEventListener("readystatechange", () => x.readyState === 4 && log.push(`done ${q}`)); // before open()
        x.open("GET", `/api/search?q=${q}`);
        x.onload = () => {
          log.push(`load ${q}`);
          const d = JSON.parse(x.responseText) as { q: string; items: string[] };
          st.set((v) => ({ items: d.items, loaded: { ...v.loaded, [d.q]: true } }));
        };
        x.addEventListener("loadend", () => log.push(`end ${q}`));
        x.send();
      });
    load("z");
    await s.clock.advance(300);
    load("a"); // slow
    await s.clock.advance(20);
    load("ab"); // fast: answers first
    await s.clock.advance(1000);
    expect(log).toEqual(["done z", "load z", "end z", "done ab", "load ab", "end ab", "done a", "load a", "end a"]);
    expect(st.get().items).toEqual(["ab-1"]);
    expect(st.get().loaded).toEqual({ z: true, ab: true, a: true });
    const del = s.decider.calls.filter((c) => c.trigger === "delivery");
    expect(del).toHaveLength(1);
    expect(del[0].state.trigger).toMatch(/^The response to GET \/api\/search\?q=a \(#\d+\) arrived and is about to be delivered/);
    expect(s.rt.interventions()[0].dropped).toEqual(["search.items"]);
    const op = [...s.rt.ops.byId.values()].find((o) => o.kind === "xhr" && o.detail === "?q=a")!;
    expect(op.status).toBe("ok");
  });

  it("holding is only latency: handlers run after the decision with the request op ambient; abort() during the hold drops the response", async () => {
    const ref: { clock?: FakeClock } = {};
    const XHR = makeXHR(ref, () => ({ status: 200, body: '{"n":1}', latency: 50 }));
    const manual = new ManualDecider();
    const s = setup({ decider: manual, triage: "always", observe: { fetch: false, xhr: true }, extraGlobal: { XMLHttpRequest: XHR } });
    ref.clock = s.clock;
    const data = s.rt.atom("data", 0);
    const seen: string[] = [];
    const x = new (s.g.XMLHttpRequest as typeof XHR)();
    x.open("GET", "/api/n");
    x.onload = () => {
      seen.push("load");
      data.set((JSON.parse(x.responseText) as { n: number }).n);
    };
    const removed = () => seen.push("removed listener ran");
    x.addEventListener("load", removed);
    x.removeEventListener("load", removed);
    x.send();
    manual.answer(); // request: send
    await s.clock.advance(60);
    expect(manual.pending.map((p) => p.req.trigger)).toEqual(["delivery"]);
    expect(seen).toEqual([]); // held
    manual.answer(); // deliver
    await s.clock.flush();
    expect(seen).toEqual(["load"]);
    const w = s.rt.history().filter((e) => e.kind === "state").pop()!;
    expect(s.rt.ops.get(w.op)!.kind).toBe("xhr");

    while (manual.pending.length) manual.answer(); // the background decision on the write (triage "always")
    await s.clock.flush();

    // abort() while the response is held: the app is told it was aborted and never sees the response
    const y = new (s.g.XMLHttpRequest as typeof XHR)();
    y.open("GET", "/api/n");
    y.onload = () => seen.push("load y");
    y.addEventListener("abort", () => seen.push("abort y"));
    y.send();
    manual.answer();
    await s.clock.advance(60);
    expect(manual.pending.map((p) => p.req.trigger)).toEqual(["delivery"]);
    y.abort();
    expect(seen).toEqual(["load", "abort y"]);
    manual.answer();
    await s.clock.flush();
    expect(seen).toEqual(["load", "abort y"]);
  });
});

describe("answers", () => {
  it("forced actions: probability 1 on an action runs exactly it (sim forcing semantics)", async () => {
    const force = (action: string) => (req: EvaluateRequest): Record<string, Answer> => {
      const out = defaultScript()(req) as Record<string, Answer>;
      const q = req.questions.action;
      if (q && q.type === "choice") {
        const probabilities: Record<string, number> = {};
        for (const l of Object.keys(q.criteria)) probabilities[l] = l === action ? 1 : 0;
        out.action = { type: "choice", choice: action, confidence: 1, probabilities };
      }
      return out;
    };
    const s = setup({ mode: "heal", triage: "always", policy: { thresholds: { report: 0, guard: 0.5, heal: 0.5 }, requireDiagnosis: false }, script: force("discard") });
    s.server.on("GET", "/api/x", { body: 1, latency: 10 });
    const a = s.rt.atom("a", 0);
    void (async () => a.set((await (await s.fetch("/api/x")).json()) as number))();
    await s.clock.advance(100);
    expect(s.rt.decisions().find((d) => d.trigger === "delivery")).toMatchObject({ ran: "discard", executed: true });
  });
});
