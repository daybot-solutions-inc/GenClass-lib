// Observe mode (and any delivery that cannot be held): the delivery reaches the app exactly as without GenClass,
// synchronously and before any body read (fetch resolves at the network time; XHR, WebSocket and EventSource
// listeners run inside the original dispatch). The body analysis and the delivery decision still run, in the
// background and on the state the delivery was released into, for detection, reports and standing questions; such a
// decision never acts and never double-reports the delivery's own writes as mutations. Guard mode still holds and
// discards as before.
import { describe, expect, it } from "vitest";
import type { Answer, Detection } from "../src/types.js";
import { FakeClock, ManualDecider, defaultScript, setup, type Setup } from "./helpers.js";

const stale = defaultScript({ delivery: { diagnosis: "stale", action: "discard" }, mutation: { diagnosis: "stale", action: "discard" } });

interface Route {
  body: unknown;
  /** Time to the response headers (the fetch promise). */
  latency: number;
  /** Time from the headers to the body (0: the body comes with the headers). */
  bodyDelay?: number;
}

/** A fetch on the fake clock whose response body can arrive after the headers (a streamed body). */
function streamingFetch(ref: { clock?: FakeClock }, route: (url: URL) => Route) {
  return (input: unknown): Promise<Response> => {
    const url = new URL(String(input), "http://app.test/");
    const r = route(url);
    const clock = ref.clock!;
    return new Promise<Response>((resolve) => {
      clock.setTimeout(() => {
        const bytes = new TextEncoder().encode(JSON.stringify(r.body));
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            const send = () => {
              c.enqueue(bytes);
              c.close();
            };
            if (r.bodyDelay) clock.setTimeout(send, r.bodyDelay);
            else send();
          },
        });
        resolve(new Response(stream, { status: 200, headers: { "content-type": "application/json" } }));
      }, r.latency);
    });
  };
}

/** The out-of-order search: "a" is slow (its body possibly slower still), "ab" answers first; "a" is then stale. */
function searchSetup(opts: Parameters<typeof setup>[0] & { bodyDelay?: number }) {
  const ref: { clock?: FakeClock } = {};
  const { bodyDelay = 0, ...rest } = opts ?? {};
  const fetchFn = streamingFetch(ref, (url) => {
    const q = url.searchParams.get("q") ?? "";
    return { body: { q, items: [`${q}-1`] }, latency: q === "a" ? 600 : 100, bodyDelay: q === "a" ? bodyDelay : 0 };
  });
  const s = setup({ ...rest, extraGlobal: { ...(rest.extraGlobal ?? {}), fetch: fetchFn } });
  ref.clock = s.clock;
  const st = s.rt.atom("search", { status: 0, items: [] as string[] });
  /** When each query started and when its fetch promise resolved (the response reached the app). */
  const started = new Map<string, number>();
  const resolved = new Map<string, number>();
  const load = (q: string, statusFirst = false) =>
    s.rt.user({ kind: "type", target: 'input "Search"', value: q }, () => {
      started.set(q, s.clock.now());
      void (async () => {
        const res = await s.fetch(`/api/search?q=${q}`);
        resolved.set(q, s.clock.now());
        if (statusFirst) st.set((v) => ({ ...v, status: res.status })); // a write before the body is read
        const d = (await res.json()) as { q: string; items: string[] };
        st.set((v) => ({ ...v, status: res.status, items: d.items }));
      })();
    });
  return { ...s, st, load, resolved, started };
}

/** z (learns the write set) at 1000; a (slow) at 1300; ab at 1320, answering first. a arrives at 1900. */
async function outOfOrder(x: ReturnType<typeof searchSetup>, statusFirst = false) {
  x.load("z", statusFirst);
  await x.clock.advance(300);
  x.load("a", statusFirst);
  await x.clock.advance(20);
  x.load("ab", statusFirst);
}

const deliveryCalls = (s: Setup) => s.decider.calls.filter((c) => c.trigger === "delivery");

describe("observe mode: fetch responses are never held", () => {
  it("a conflicting response with a slow body resolves at the network time; the background decision is recorded and reported, its writes are not decided again", async () => {
    const x = searchSetup({ mode: "observe", script: stale, bodyDelay: 300 });
    const detections: Detection[] = [];
    x.rt.on("detect", (d) => detections.push(d));
    await outOfOrder(x);
    await x.clock.advance(1000);
    // the response reached the app when it arrived (600 ms), not after waiting up to 100 ms for its body
    expect(x.resolved.get("a")! - x.started.get("a")!).toBe(600);
    // observe never changes anything: the stale result applied, as without GenClass
    expect(x.st.get().items).toEqual(["a-1"]);
    expect(x.rt.interventions()).toEqual([]);
    // the delivery was decided in the background (not dropped as stale), without its body (it came too late)
    expect(deliveryCalls(x)).toHaveLength(1);
    expect(deliveryCalls(x)[0].state.trigger).toMatch(/^The response to GET \/api\/search\?q=a \(#\d+\) arrived and is about to be delivered/);
    const ds = x.rt.decisions();
    expect(ds.map((d) => d.trigger)).toEqual(["delivery"]); // the stale write is covered by it: no mutation decision
    expect(ds[0]).toMatchObject({ diagnosis: "stale", action: "discard", executed: false });
    expect(ds[0].reason).toMatch(/observe mode never changes execution/);
    expect(detections.map((d) => d.trigger)).toEqual(["delivery"]);
    // delivered over newer data without a decision to drop it: the stale value is marked (F9), as before
    expect(x.rt.internals.hub.field("search.items")!.mark?.why).toMatch(/^by the response to GET \/api\/search\?q=a \(#\d+\), which was delivered over newer data from /);
  });

  it("the background decision is built on the state the response was delivered into, not on its own writes", async () => {
    const x = searchSetup({ mode: "observe", script: stale });
    await outOfOrder(x);
    await x.clock.advance(1000);
    expect(x.resolved.get("a")! - x.started.get("a")!).toBe(600);
    expect(x.st.get().items).toEqual(["a-1"]);
    const [req] = deliveryCalls(x);
    expect(req).toBeDefined();
    const text = JSON.stringify(req.state);
    expect(text).toContain("ab-1"); // search.items still holds the newer result
    expect(text).not.toContain('a-1\\"]');
    expect(x.rt.decisions().map((d) => d.trigger)).toEqual(["delivery"]);
  });

  it("when the app writes before the body is read, the delivery is decided at that write, not after the body wait", async () => {
    const x = searchSetup({ mode: "observe", script: stale, bodyDelay: 300 });
    await outOfOrder(x, true);
    await x.clock.advance(580); // "a" arrives at 1900 and the app writes its status at once
    expect(x.resolved.get("a")! - x.started.get("a")!).toBe(600);
    expect(deliveryCalls(x)).toHaveLength(1);
    await x.clock.advance(1000);
    expect(x.st.get().items).toEqual(["a-1"]);
    expect(deliveryCalls(x)).toHaveLength(1);
    expect(x.rt.decisions().map((d) => d.trigger)).toEqual(["delivery"]); // neither write is decided again
  });

  it("a response that puts back what a pending local change replaced, written by the app before its body was analyzed: its write is still decided (F1 is not lost)", async () => {
    const s = setup({ mode: "observe", script: stale });
    s.server.on("PATCH", "/api/cards/c1", { body: { ok: true }, latency: 800 });
    let n = 0;
    s.server.on("GET", "/api/board", () => ({ body: { cards: { c1: "todo", c2: n++ ? "review" : "doing" } }, latency: 50 }));
    const b = s.rt.atom("board", { cards: { c1: "", c2: "" } as Record<string, string> });
    let resolvedAt = -1;
    const load = () =>
      s.rt.op("load", async () => {
        const res = await s.fetch("/api/board");
        resolvedAt = s.clock.now();
        const d = (await res.json()) as { cards: Record<string, string> };
        b.set({ cards: d.cards }); // the usual app: the write follows its own body read at once
      });
    void load(); // learns what GET /api/board writes
    await s.clock.advance(100);
    s.rt.user({ kind: "click", target: 'button "Move c1 to done"' }, () => {
      b.set((v) => ({ cards: { ...v.cards, c1: "done" } }));
      void s.fetch("/api/cards/c1", { method: "PATCH", body: '{"col":"done"}' });
    });
    await s.clock.advance(50);
    const t0 = s.clock.now();
    void load(); // its response has c1 = "todo", the value the user's pending move replaced
    await s.clock.advance(1000);
    expect(resolvedAt - t0).toBe(50); // not held
    expect(b.get().cards.c1).toBe("todo"); // observe: the app's write applied
    // without the body, the delivery cannot tell (F1): it is not decided as a delivery, and its write is decided on
    // its own instead of being covered by a delivery that was never decided (exactly one decision either way)
    const ds = s.rt.decisions().filter((d) => d.trigger !== "request");
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ diagnosis: "stale", executed: false });
    expect(ds[0].facts[0]).toMatch(/^board\.cards\.c1 has a pending local change: user clicked button "Move c1 to done" \(#\d+\)/);
    expect(s.rt.interventions()).toEqual([]);
  });

  it("standing questions on delivery are answered (salient deliveries; every delivery with always)", async () => {
    const x = searchSetup({ mode: "observe", script: stale });
    const asked: { id: string; subject: string; answer: Answer }[] = [];
    x.rt.question({ id: "dup", on: ["delivery"], question: { type: "noul", instructions: "Is this response a duplicate?" }, onAnswer: (a, c) => asked.push({ id: "dup", subject: c.decision.subject, answer: a }) });
    await outOfOrder(x);
    await x.clock.advance(1000);
    expect(asked).toEqual([{ id: "dup", subject: expect.stringMatching(/^response to GET \/api\/search\?q=a /), answer: { type: "noul", noul: 0.9 } }]);
    expect(x.st.get().items).toEqual(["a-1"]);

    const y = searchSetup({ mode: "observe" });
    const every: string[] = [];
    y.rt.question({ id: "seen", on: ["delivery"], always: true, question: { type: "noul", instructions: "Did the app need this response?" }, onAnswer: (_a, c) => every.push(c.decision.subject) });
    y.load("z");
    await y.clock.advance(100);
    expect(y.resolved.get("z")! - y.started.get("z")!).toBe(100); // asked, not held
    await y.clock.flush();
    expect(every).toEqual([expect.stringMatching(/^response to GET \/api\/search\?q=z /)]);
  });
});

/** An XMLHttpRequest stand-in (as in delivery.test.ts): state behind getters, events dispatched on the object. */
function makeXHR(ref: { clock?: FakeClock }, handler: (method: string, url: string) => { status: number; body: string; latency: number }) {
  return class FakeXHR extends EventTarget {
    #rs = 0;
    #status = 0;
    #text = "";
    #m = "GET";
    #u = "";
    #sending = false;
    responseType = "";
    /** The type of the event being dispatched right now ("" outside a dispatch). */
    dispatching = "";
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
        for (const t of ["readystatechange", "load", "loadend"]) {
          const e = new Event(t);
          this.dispatching = t;
          this.dispatchEvent(e);
          this.dispatching = "";
          const h = (this as unknown as Record<string, unknown>)[`on${t}`];
          if (typeof h === "function") h.call(this, e);
        }
      }, r.latency);
    }
    abort() {
      if (this.#rs === 4) {
        this.#rs = 0;
        this.#status = 0;
      }
    }
    setRequestHeader() {}
    getResponseHeader(): string | null {
      return null;
    }
    getAllResponseHeaders(): string {
      return "";
    }
  };
}

describe("observe mode: XMLHttpRequest", () => {
  it("a conflicting response: the app's listeners run inside the original dispatch (currentTarget set); the body is analyzed before they run", async () => {
    const ref: { clock?: FakeClock } = {};
    const XHR = makeXHR(ref, (_m, url) => {
      const q = new URL(url, "http://app.test/").searchParams.get("q") ?? "";
      return { status: 200, body: JSON.stringify({ q, items: [`${q}-1`] }), latency: q === "a" ? 600 : 100 };
    });
    const s = setup({ mode: "observe", script: stale, observe: { fetch: false, xhr: true }, extraGlobal: { XMLHttpRequest: XHR } });
    ref.clock = s.clock;
    const st = s.rt.atom("search", { items: [] as string[] });
    const log: string[] = [];
    const load = (q: string) =>
      s.rt.user({ kind: "type", target: 'input "Search"', value: q }, () => {
        const x = new (s.g.XMLHttpRequest as typeof XHR)();
        x.addEventListener("readystatechange", (e) => x.readyState === 4 && log.push(`done ${q} ${x.dispatching === e.type}`)); // before open()
        x.open("GET", `/api/search?q=${q}`);
        x.addEventListener("load", (e) => {
          // the first "load" listener: e.currentTarget is reliable there (Node clears it after each listener)
          log.push(`load ${q} ${x.dispatching === e.type} ${e.currentTarget === x} ${deliveryCalls(s).length}`);
          st.set({ items: (JSON.parse(x.responseText) as { items: string[] }).items });
        });
        x.addEventListener("loadend", (e) => log.push(`end ${q} ${x.dispatching === e.type}`));
        x.send();
      });
    load("z");
    await s.clock.advance(300);
    load("a"); // slow
    await s.clock.advance(20);
    load("ab"); // fast: answers first
    await s.clock.advance(1000);
    // every listener ran inside the dispatch; the delivery decision of "a" was asked before its load listener ran
    expect(log).toEqual(["done z true", "load z true true 0", "end z true", "done ab true", "load ab true true 0", "end ab true", "done a true", "load a true true 1", "end a true"]);
    expect(st.get().items).toEqual(["a-1"]);
    const del = deliveryCalls(s);
    expect(del).toHaveLength(1);
    // the body was analyzed on the state before the app's write (a content fact about the incoming value)
    expect((del[0].state.facts as string[]).some((f) => /^The response has search\.items = .*a-1.*: neither the current value .*ab-1/.test(f))).toBe(true);
    expect(s.rt.decisions().map((d) => d.trigger)).toEqual(["delivery"]);
    expect(s.rt.interventions()).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------- push channels

class FakeWS extends EventTarget {
  static all: FakeWS[] = [];
  /** Inside a dispatch of an incoming message. */
  dispatching = false;
  constructor(public url: string) {
    super();
    FakeWS.all.push(this);
  }
  send() {}
  emit(data: unknown) {
    this.dispatching = true;
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
    this.dispatching = false;
  }
}

class FakeES extends EventTarget {
  static all: FakeES[] = [];
  dispatching = false;
  constructor(public url: string) {
    super();
    FakeES.all.push(this);
  }
  emit(type: string, data: unknown, id: string) {
    this.dispatching = true;
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data), lastEventId: id }));
    this.dispatching = false;
  }
}

describe("observe mode: push channels", () => {
  it("a WebSocket message that would put back the value a pending local change replaced is delivered synchronously, inside the dispatch; decided in the background with its content", async () => {
    const s = setup({ mode: "observe", script: stale, observe: { fetch: true, websocket: true }, extraGlobal: { WebSocket: FakeWS } });
    s.server.on("PATCH", "/api/cards/c1", { body: { ok: true }, latency: 800 });
    const b = s.rt.atom("board", { cards: { c1: "todo", c2: "todo" } as Record<string, string> });
    const seen: string[] = [];
    const ws = new (s.g.WebSocket as typeof FakeWS)("ws://app.test/live");
    ws.addEventListener("message", (e) => {
      const m = JSON.parse((e as MessageEvent).data as string) as { n: number; card: string; col: string };
      seen.push(`${m.n} ${ws.dispatching}`);
      b.set((v) => ({ cards: { ...v.cards, [m.card]: m.col } }));
    });
    const socket = FakeWS.all[FakeWS.all.length - 1];
    socket.emit({ n: 1, card: "c2", col: "doing" }); // learn what these messages write
    await s.clock.advance(50);
    s.rt.user({ kind: "click", target: 'button "Move c1 to done"' }, () => {
      b.set((v) => ({ cards: { ...v.cards, c1: "done" } }));
      void s.fetch("/api/cards/c1", { method: "PATCH", body: '{"col":"done"}' });
    });
    await s.clock.advance(50);
    socket.emit({ n: 2, card: "c1", col: "todo" }); // older server state for c1: guard would hold it
    expect(seen).toEqual(["1 true", "2 true"]); // delivered at once, inside the dispatch
    expect(b.get().cards.c1).toBe("todo"); // observe: the app's write applied
    const del = deliveryCalls(s);
    expect(del).toHaveLength(1); // asked before the listener ran (the body is in memory)
    expect((del[0].state.facts as string[])[0]).toMatch(/^board\.cards\.c1 has a pending local change: user clicked button "Move c1 to done" \(#\d+\) wrote it 0\.05s ago/);
    await s.clock.flush();
    expect(s.rt.decisions().map((d) => d.trigger)).toEqual(["delivery"]);
    expect(s.rt.decisions()[0]).toMatchObject({ diagnosis: "stale", executed: false });
    expect(s.rt.interventions()).toEqual([]);
    // delivered over the pending local change without a decision to drop it: marked (F9), as before
    expect(s.rt.internals.hub.field("board.cards.c1")!.mark?.why).toMatch(/^by the message WS message \/live \(#\d+\), which was delivered over a pending local change of /);
    await s.clock.advance(1000);
  });

  it("EventSource messages asked about (triage always) are delivered synchronously, in order; each is still decided", async () => {
    const manual = new ManualDecider();
    const s = setup({ mode: "observe", decider: manual, triage: "always", observe: { fetch: true, eventsource: true }, extraGlobal: { EventSource: FakeES } });
    const st = s.rt.atom("feed", { last: 0 });
    const got: string[] = [];
    const es = new (s.g.EventSource as typeof FakeES)("http://app.test/stream");
    es.addEventListener("update", (e) => {
      const d = JSON.parse((e as MessageEvent).data as string) as { n: number };
      got.push(`${d.n} ${es.dispatching}`);
      st.set({ last: d.n });
    });
    const src = FakeES.all[FakeES.all.length - 1];
    src.emit("update", { n: 1 }, "e1");
    src.emit("update", { n: 2 }, "e2");
    expect(got).toEqual(["1 true", "2 true"]); // nothing waits for the model, which has not answered yet
    expect(st.get().last).toBe(2);
    while (manual.pending.length) {
      manual.answer(defaultScript());
      await s.clock.flush();
    }
    expect(s.rt.decisions().filter((d) => d.trigger === "delivery")).toHaveLength(2);
  });
});

describe("guard mode is unchanged", () => {
  it("a stale response is held until its decision; discard drops the stale write", async () => {
    const manual = new ManualDecider();
    const x = searchSetup({ mode: "guard", decider: manual });
    await outOfOrder(x);
    await x.clock.advance(580); // "a" arrives at 1900: held for its delivery decision
    expect(manual.pending.map((p) => p.req.trigger)).toEqual(["delivery"]);
    await x.clock.advance(50);
    expect(x.resolved.has("a")).toBe(false); // the app has not seen it yet
    manual.answer(stale);
    await x.clock.flush();
    expect(x.resolved.get("a")! - x.started.get("a")!).toBe(650);
    expect(x.st.get().items).toEqual(["ab-1"]); // the stale result was dropped
    expect(x.rt.interventions().map((r) => [r.action, r.dropped])).toEqual([["discard", ["search.items"]]]);
    expect(x.rt.decisions().map((d) => [d.trigger, d.executed])).toEqual([["delivery", true]]);
  });

  it("a delivery that cannot be held in guard mode (the model too slow) is released at once; its stale write is still decided on its own and late-reverted, as before", async () => {
    const manual = new ManualDecider();
    const x = searchSetup({ mode: "guard", decider: manual, bodyDelay: 300 });
    manual.status = { state: "ready", warmupMs: 2000 }; // expected ~2 s; the auto budget tops out at 800 ms
    await outOfOrder(x);
    await x.clock.advance(580);
    expect(x.resolved.get("a")! - x.started.get("a")!).toBe(600); // not held, not even for its body
    await x.clock.advance(1000); // the body arrives at 2200 and the app writes the stale result
    expect(x.st.get().items).toEqual(["a-1"]);
    // the write is not covered by a delivery decision that could not act: it gets its own (no delivery decision)
    expect(manual.pending.map((p) => p.req.trigger)).toEqual(["mutation"]);
    manual.answer(stale);
    await x.clock.flush();
    expect(x.st.get().items).toEqual(["ab-1"]); // late revert
    expect(x.rt.interventions().map((r) => [r.trigger, r.action, r.late])).toEqual([["mutation", "discard", true]]);
    expect(x.rt.decisions().map((d) => d.trigger)).toEqual(["mutation"]);
  });

  it("guard mode with a slow model and a standing question that always asks about deliveries: the delivery is decided without acting, its write still on its own", async () => {
    const manual = new ManualDecider();
    const x = searchSetup({ mode: "guard", decider: manual });
    manual.status = { state: "ready", warmupMs: 2000 };
    const asked: string[] = [];
    x.rt.question({ id: "seen", on: ["delivery"], always: true, question: { type: "noul", instructions: "Did the app need this response?" }, onAnswer: (_a, c) => asked.push(c.decision.subject) });
    await outOfOrder(x);
    await x.clock.advance(1000);
    expect(x.resolved.get("a")! - x.started.get("a")!).toBe(600);
    expect(x.st.get().items).toEqual(["a-1"]);
    while (manual.pending.length) {
      manual.answer(stale);
      await x.clock.flush();
    }
    expect(asked).toEqual(["z", "ab", "a"].map((q) => expect.stringMatching(new RegExp(`^response to GET /api/search\\?q=${q} `))));
    const del = x.rt.decisions().find((d) => d.trigger === "delivery" && /q=a /.test(d.subject))!;
    expect(del).toMatchObject({ action: "discard", executed: false, reason: "the subject was not held (decided in the background)" });
    // the stale write of "a" got its own decision, which reverted it
    expect(x.rt.decisions().filter((d) => d.trigger === "mutation")).toHaveLength(1);
    expect(x.st.get().items).toEqual(["ab-1"]);
    expect(x.rt.interventions().map((r) => [r.trigger, r.action, r.late])).toEqual([["mutation", "discard", true]]);
  });
});
