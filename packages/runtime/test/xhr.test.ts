import { describe, expect, it } from "vitest";
import { FakeClock, ManualDecider, defaultScript, setup } from "./helpers.js";

/** A small XMLHttpRequest stand-in driven by the fake clock. */
function makeFakeXHR(clock: FakeClock, handler: (method: string, url: string) => { status: number; body: string; latency: number }) {
  return class FakeXHR extends EventTarget {
    static sent = 0;
    readyState = 0;
    status = 0;
    statusText = "";
    responseText = "";
    response: unknown = "";
    responseType = "";
    private method = "GET";
    private url = "";
    onload: ((e: Event) => void) | null = null;
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
      this.readyState = 1;
    }
    send(_body?: unknown) {
      FakeXHR.sent++;
      const r = handler(this.method, this.url);
      clock.setTimeout(() => {
        this.readyState = 4;
        this.status = r.status;
        this.responseText = r.body;
        this.response = r.body;
        this.dispatchEvent(new Event("readystatechange"));
        const load = new Event("load");
        this.dispatchEvent(load);
        this.onload?.(load);
        this.dispatchEvent(new Event("loadend"));
      }, r.latency);
    }
    getResponseHeader(_k: string): string | null {
      return null;
    }
    getAllResponseHeaders(): string {
      return "";
    }
  };
}

describe("XMLHttpRequest observer (basics)", () => {
  it("records an op with its cause; the op is ambient when the app's load handler runs", async () => {
    const holder: { clock?: FakeClock } = {};
    const XHR = makeFakeXHR({ setTimeout: (fn: () => void, ms: number) => holder.clock!.setTimeout(fn, ms) } as unknown as FakeClock, () => ({ status: 200, body: '{"ok":true}', latency: 50 }));
    const s = setup({ observe: { fetch: false, xhr: true }, extraGlobal: { XMLHttpRequest: XHR } });
    holder.clock = s.clock;
    const data = s.rt.atom("data", { ok: false });
    s.rt.user({ kind: "click", target: 'button "Load"' }, () => {
      const x = new (s.g.XMLHttpRequest as typeof XHR)();
      x.open("GET", "/api/legacy?id=5");
      x.onload = () => data.set(JSON.parse(x.responseText));
      x.send();
    });
    await s.clock.advance(100);
    expect(data.get()).toEqual({ ok: true });
    const op = [...s.rt.ops.byId.values()].find((o) => o.kind === "xhr")!;
    expect(op.name).toBe("GET /api/legacy");
    expect(op.detail).toBe("?id=5");
    expect(op.status).toBe("ok");
    expect(op.code).toBe(200);
    expect(s.rt.ops.get(op.cause)!.kind).toBe("user");
    const w = s.rt.history().find((e) => e.kind === "state")!;
    expect(w.op).toBe(op.id);
  });

  it("block replays a 503 onto the XHR without sending it (heal mode)", async () => {
    const holder: { clock?: FakeClock } = {};
    const XHR = makeFakeXHR({ setTimeout: (fn: () => void, ms: number) => holder.clock!.setTimeout(fn, ms) } as unknown as FakeClock, () => ({ status: 200, body: "x", latency: 10 }));
    const s = setup({ mode: "heal", triage: "always", observe: { fetch: false, xhr: true }, extraGlobal: { XMLHttpRequest: XHR }, script: defaultScript({ request: { diagnosis: "overload", action: "block" } }) });
    holder.clock = s.clock;
    let status = 0;
    let mark: string | null = null;
    const x = new (s.g.XMLHttpRequest as typeof XHR)();
    x.open("GET", "/api/poll");
    x.addEventListener("load", () => {
      status = x.status;
      mark = x.getResponseHeader("x-genclass");
    });
    x.send();
    await s.clock.advance(100);
    expect(status).toBe(503);
    expect(mark).toBe("blocked");
    expect(XHR.sent).toBe(0);
  });

  it("failures are observed (diagnosis only: the app sees XHR failures directly)", async () => {
    const holder: { clock?: FakeClock } = {};
    const XHR = makeFakeXHR({ setTimeout: (fn: () => void, ms: number) => holder.clock!.setTimeout(fn, ms) } as unknown as FakeClock, () => ({ status: 500, body: "err", latency: 10 }));
    const s = setup({ observe: { fetch: false, xhr: true }, extraGlobal: { XMLHttpRequest: XHR } });
    holder.clock = s.clock;
    const x = new (s.g.XMLHttpRequest as typeof XHR)();
    x.open("POST", "/api/save");
    x.send("{}");
    await s.clock.advance(100);
    const f = s.decider.calls.find((c) => c.trigger === "failure")!;
    expect(f).toBeDefined();
    expect(f.questions.action).toBeUndefined();
    expect(x.status).toBe(500);
  });

  it("request gate holds the send until the decision (fail-open after the budget)", async () => {
    const holder: { clock?: FakeClock } = {};
    const XHR = makeFakeXHR({ setTimeout: (fn: () => void, ms: number) => holder.clock!.setTimeout(fn, ms) } as unknown as FakeClock, () => ({ status: 200, body: "x", latency: 10 }));
    const manual = new ManualDecider();
    const s = setup({ decider: manual, triage: "always", observe: { fetch: false, xhr: true }, extraGlobal: { XMLHttpRequest: XHR } });
    holder.clock = s.clock;
    const x = new (s.g.XMLHttpRequest as typeof XHR)();
    x.open("GET", "/api/x");
    x.send();
    expect(XHR.sent).toBe(0);
    await s.clock.advance(300);
    expect(XHR.sent).toBe(1);
  });

  it("destroy() restores open/send", () => {
    const XHR = makeFakeXHR(new FakeClock(), () => ({ status: 200, body: "", latency: 1 }));
    const open = XHR.prototype.open;
    const s = setup({ observe: { fetch: false, xhr: true }, extraGlobal: { XMLHttpRequest: XHR } });
    expect(XHR.prototype.open).not.toBe(open);
    s.rt.destroy();
    expect(XHR.prototype.open).toBe(open);
  });
});
