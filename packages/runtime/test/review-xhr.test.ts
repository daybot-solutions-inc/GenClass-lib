// REVIEW: XMLHttpRequest observer. A failing test demonstrates a bug.
import { describe, expect, it } from "vitest";
import type { Answer, EvaluateRequest } from "../src/types.js";
import { FakeClock, ManualDecider, defaultScript, setup } from "./helpers.js";

/**
 * An XMLHttpRequest stand-in that behaves like the real one where it matters here: state lives in internal slots
 * exposed by prototype getters, open() resets it, sync requests complete inside send().
 */
function makeXHR(clockRef: { clock?: FakeClock }, handler: (method: string, url: string) => { status: number; body: string; latency: number }) {
  return class FakeXHR extends EventTarget {
    static sent = 0;
    #readyState = 0;
    #status = 0;
    #text = "";
    #method = "GET";
    #url = "";
    #async = true;
    #sendFlag = false;
    responseType = "";
    onload: ((e: Event) => void) | null = null;
    onreadystatechange: ((e: Event) => void) | null = null;
    get readyState() {
      return this.#readyState;
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
    open(method: string, url: string, async?: boolean) {
      this.#method = method;
      this.#url = url;
      this.#async = async !== false;
      this.#readyState = 1;
      this.#status = 0;
      this.#text = "";
      this.#sendFlag = false;
      this.#fire("readystatechange");
    }
    send(_body?: unknown) {
      if (this.#readyState !== 1 || this.#sendFlag) throw new Error("InvalidStateError");
      this.#sendFlag = true;
      FakeXHR.sent++;
      const r = handler(this.#method, this.#url);
      const complete = () => {
        if (!this.#sendFlag) return; // aborted meanwhile
        this.#sendFlag = false;
        this.#readyState = 4;
        this.#status = r.status;
        this.#text = r.body;
        this.#fire("readystatechange");
        this.#fire("load");
        this.#fire("loadend");
      };
      if (!this.#async) complete();
      else clockRef.clock!.setTimeout(complete, r.latency);
    }
    /** XHR spec: abort() of an opened-but-unsent request does nothing (no events, state stays OPENED). */
    abort() {
      if ((this.#readyState === 1 && this.#sendFlag) || this.#readyState === 2 || this.#readyState === 3) {
        this.#sendFlag = false;
        this.#readyState = 4;
        this.#fire("readystatechange");
        this.#fire("abort");
        this.#fire("loadend");
      }
      if (this.#readyState === 4) this.#readyState = 0;
    }
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

const XHR_ONLY = { fetch: false, xhr: true };

describe("review: XMLHttpRequest observer", () => {
  it("a synchronous XHR is never held: send() returns with the response", () => {
    const ref: { clock?: FakeClock } = {};
    const XHR = makeXHR(ref, () => ({ status: 200, body: '{"a":1}', latency: 30 }));
    const s = setup({ observe: XHR_ONLY, extraGlobal: { XMLHttpRequest: XHR } });
    ref.clock = s.clock;
    const load = () => {
      const x = new (s.g.XMLHttpRequest as typeof XHR)();
      x.open("GET", "/api/config", false); // legacy synchronous request
      x.send();
      return { status: x.status, text: x.responseText };
    };
    expect(load()).toEqual({ status: 200, text: '{"a":1}' });
    // the same request again right away (e.g. a double click): salient (identical request just sent)
    expect(load()).toEqual({ status: 200, text: '{"a":1}' });
  });

  it("an XHR the app aborts while GenClass holds it is never sent", async () => {
    const ref: { clock?: FakeClock } = {};
    const XHR = makeXHR(ref, () => ({ status: 201, body: '{"order":1}', latency: 10 }));
    const manual = new ManualDecider();
    const s = setup({ decider: manual, triage: "always", observe: XHR_ONLY, extraGlobal: { XMLHttpRequest: XHR } });
    ref.clock = s.clock;
    const x = new (s.g.XMLHttpRequest as typeof XHR)();
    let loaded = false;
    x.onload = () => (loaded = true);
    x.open("POST", "/api/orders");
    x.send('{"sku":"A"}');
    const held = manual.pending.length;
    x.abort(); // the user cancels (e.g. a newer search, or a Cancel button)
    manual.answer(defaultScript()); // model: send
    await s.clock.advance(100);
    expect({ held, sent: XHR.sent, loaded }).toEqual({ held: 1, sent: 0, loaded: false });
  });

  it("reusing one XHR object for many requests does not accumulate listeners (work per request stays constant)", async () => {
    const ref: { clock?: FakeClock } = {};
    const XHR = makeXHR(ref, () => ({ status: 200, body: "{}", latency: 10 }));
    const s = setup({ observe: XHR_ONLY, extraGlobal: { XMLHttpRequest: XHR } });
    ref.clock = s.clock;
    let sticks = 0;
    const ctx = s.rt.ctx;
    const orig = ctx.stick.bind(ctx);
    ctx.stick = (op) => {
      sticks++;
      orig(op);
    };
    const x = new (s.g.XMLHttpRequest as typeof XHR)();
    for (let i = 0; i < 200; i++) {
      x.open("GET", `/api/poll?i=${i}`);
      x.send();
      await s.clock.advance(20);
    }
    const before = sticks;
    x.open("GET", "/api/poll?i=last");
    x.send();
    await s.clock.advance(20);
    expect(sticks - before).toBeLessThanOrEqual(2);
  });

  it("after a blocked answer, reusing the same XHR shows the real state and response", async () => {
    const ref: { clock?: FakeClock } = {};
    const XHR = makeXHR(ref, () => ({ status: 200, body: '{"ok":true}', latency: 10 }));
    let calls = 0;
    const script = (req: EvaluateRequest): Record<string, Answer> => {
      calls++;
      return defaultScript(calls === 1 ? { request: { diagnosis: "overload", action: "block" } } : {})(req) as Record<string, Answer>;
    };
    const s = setup({ mode: "heal", triage: "always", observe: XHR_ONLY, extraGlobal: { XMLHttpRequest: XHR }, script });
    ref.clock = s.clock;
    const x = new (s.g.XMLHttpRequest as typeof XHR)();
    x.open("GET", "/api/a");
    x.send();
    await s.clock.advance(50);
    const blocked = x.status;
    x.open("GET", "/api/b");
    const afterOpen = x.readyState;
    x.send();
    await s.clock.advance(50);
    expect({ blocked, afterOpen, status: x.status, text: x.responseText }).toEqual({ blocked: 503, afterOpen: 1, status: 200, text: '{"ok":true}' });
  });
});
