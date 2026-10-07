import { describe, expect, it } from "vitest";
import { VirtualLoop } from "../src/loop.js";
import { Rng } from "../src/rng.js";

describe("virtual loop", () => {
  it("orders macrotasks by (time, seq) and drains microtasks between them", async () => {
    const loop = new VirtualLoop();
    const log: string[] = [];
    loop.schedule(10, () => {
      log.push("a10");
      void Promise.resolve().then(() => log.push("a10-micro")).then(() => log.push("a10-micro2"));
    }, "app");
    loop.schedule(5, () => log.push("b5"), "app");
    loop.schedule(10, () => log.push("c10"), "app");
    loop.schedule(10, () => {
      log.push("d10");
      loop.afterTask(() => log.push("d10-after"));
    }, "app");
    await loop.runUntil(100);
    expect(log).toEqual(["b5", "a10", "a10-micro", "a10-micro2", "c10", "d10", "d10-after"]);
    expect(loop.now()).toBe(100);
  });

  it("resolves Response bodies within the same macrotask", async () => {
    const loop = new VirtualLoop();
    const log: string[] = [];
    loop.schedule(1, () => {
      const r = new Response(JSON.stringify({ a: 1 }));
      void r.clone().json().then((j) => log.push(`json ${j.a}`));
    }, "app");
    loop.schedule(2, () => log.push("next"), "app");
    await loop.runUntil(10);
    expect(log).toEqual(["json 1", "next"]);
  });

  it("keyed rng forks are independent of draw order", () => {
    const a = new Rng(7);
    const b = new Rng(7);
    b.next();
    b.next();
    expect(a.fork("x", 1).next()).toBe(b.fork("x", 1).next());
    expect(new Rng(7).next()).toBe(new Rng(7).next());
  });
});
