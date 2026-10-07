import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

describe("context propagation (CONTRACT §3)", () => {
  it("fetch -> json -> set records the fetch op as cause and the user action as root", async () => {
    const { rt, clock, server, fetch } = setup();
    server.on("GET", "/api/items", { body: [{ id: 1 }], latency: 80 });
    const items = rt.atom("items", [] as unknown[]);
    rt.user({ kind: "click", target: 'button "Load"' }, () => {
      void (async () => {
        const res = await fetch("/api/items");
        const data = await res.json();
        items.set(data as unknown[]);
      })();
    });
    await clock.advance(200);
    const st = rt.history().find((e) => e.kind === "state" && e.name === "items")!;
    const f = rt.ops.get(st.op)!;
    expect(f.kind).toBe("fetch");
    expect(rt.ops.get(f.root)!.kind).toBe("user");
    expect(rt.ops.get(f.cause)!.kind).toBe("user");
  });

  it("concurrent chains keep their own causes", async () => {
    const { rt, clock, server, fetch } = setup();
    server.on("GET", "/api/a", { body: "a", latency: 300 });
    server.on("GET", "/api/b", { body: "b", latency: 100 });
    const a = rt.atom("a", "");
    const b = rt.atom("b", "");
    const load = (url: string, target: string, atom: typeof a) =>
      rt.user({ kind: "click", target }, () => {
        void (async () => {
          const r = await fetch(url);
          const t = (await r.json()) as string;
          await Promise.resolve();
          atom.set(t);
        })();
      });
    load("/api/a", 'button "A"', a);
    await clock.advance(10);
    load("/api/b", 'button "B"', b);
    await clock.advance(500);
    const ev = rt.history().filter((e) => e.kind === "state");
    const wa = ev.find((e) => e.name === "a")!;
    const wb = ev.find((e) => e.name === "b")!;
    const fa = rt.ops.get(wa.op)!;
    const fb = rt.ops.get(wb.op)!;
    expect(fa.name).toBe("GET /api/a");
    expect(fb.name).toBe("GET /api/b");
    expect((rt.ops.get(fa.root)!.meta!.action as { target: string }).target).toBe('button "A"');
    expect((rt.ops.get(fb.root)!.meta!.action as { target: string }).target).toBe('button "B"');
  });

  it("runtime.op is ambient in its body and when it settles", async () => {
    const { rt, clock } = setup();
    const x = rt.atom("x", 0);
    const p = rt.op("load", async () => {
      x.set(1); // synchronous part
      await Promise.resolve();
      return 2;
    });
    const v = await p;
    x.set(v); // continuation after the op settled
    await clock.flush();
    const writes = rt.history().filter((e) => e.kind === "state");
    expect(writes.length).toBe(2);
    for (const w of writes) expect(rt.ops.get(w.op)!.name).toBe("load");
  });

  it("ops started while another op is ambient get it as cause", async () => {
    const { rt, clock, server, fetch } = setup();
    server.on("GET", "/api/one", { body: 1, latency: 20 });
    server.on("GET", "/api/two", { body: 2, latency: 20 });
    let second: number | undefined;
    rt.user({ kind: "click", target: 'button "Go"' }, () => {
      void (async () => {
        await (await fetch("/api/one")).json();
        const r = await fetch("/api/two");
        second = (await r.json()) as number;
      })();
    });
    await clock.advance(100);
    expect(second).toBe(2);
    const two = [...rt.ops.byId.values()].find((o) => o.name === "GET /api/two")!;
    expect(rt.ops.get(two.cause)!.name).toBe("GET /api/one");
    expect(rt.ops.get(two.root)!.kind).toBe("user");
  });

  it("the ambient op is cleared by clock.afterTask", async () => {
    const { rt, clock } = setup();
    rt.user({ kind: "click", target: "button" });
    expect(rt.ctx.op()?.kind).toBe("user");
    await clock.flush();
    expect(rt.ctx.op()).toBeNull();
  });

  it("timers observer carries the cause into timer callbacks (debounce)", async () => {
    const holder: { clock?: import("./helpers.js").FakeClock } = {};
    const s = setup({
      observe: { fetch: true, timers: true },
      extraGlobal: {
        setTimeout: (fn: () => void, ms: number) => holder.clock!.setTimeout(fn, ms),
        clearTimeout: (h: unknown) => holder.clock!.clearTimeout(h),
        setInterval: () => 0,
      },
    });
    holder.clock = s.clock;
    const { rt, clock, server, g, fetch } = s;
    server.on("GET", "/api/q", { body: [], latency: 30 });
    rt.user({ kind: "type", target: 'input "Search"', value: "a" }, () => {
      (g.setTimeout as (f: () => void, ms: number) => unknown)(() => void fetch("/api/q?x=a"), 300);
    });
    await clock.advance(400);
    const f = [...rt.ops.byId.values()].find((o) => o.kind === "fetch")!;
    const timer = rt.ops.get(f.cause)!;
    expect(timer.kind).toBe("timer");
    expect(timer.name).toBe("timer 300ms");
    expect(rt.ops.get(timer.cause)!.kind).toBe("user");
    expect(f.root).toBe(timer.cause);
  });

  it("idle timers do not create ops", async () => {
    const holder: { clock?: import("./helpers.js").FakeClock } = {};
    const s = setup({
      observe: { fetch: true, timers: true },
      extraGlobal: { setTimeout: (fn: () => void, ms: number) => holder.clock!.setTimeout(fn, ms), clearTimeout: () => undefined },
    });
    holder.clock = s.clock;
    let ran = 0;
    for (let i = 0; i < 5; i++) (s.g.setTimeout as (f: () => void, ms: number) => unknown)(() => ran++, 10 * i);
    await s.clock.advance(100);
    expect(ran).toBe(5);
    expect([...s.rt.ops.byId.values()].filter((o) => o.kind === "timer").length).toBe(0);
  });
});
