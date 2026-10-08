// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime } from "../src/index.js";
import { describeElement } from "../src/observe/dom-user.js";
import type { RuntimeImpl } from "../src/runtime.js";
import { FakeClock, ManualDecider, ScriptedDecider } from "./helpers.js";

const OFF = { fetch: false, xhr: false, errors: false, nav: false, storage: false, perf: false, websocket: false, timers: false };

function page(html: string) {
  document.body.innerHTML = html;
}

describe("element descriptions", () => {
  it("uses aria-label, labels, text, placeholder, name, id", () => {
    page(`
      <button id="b1" aria-label="Place order"><span>Buy</span></button>
      <label for="q">Search</label><input id="q">
      <label>Email <input id="e" type="email"></label>
      <input id="p" placeholder="Your city">
      <a href="/home">Home</a>
      <input type="checkbox" id="c" name="remember">
      <div role="button" id="d">Open menu</div>
      <select id="s" aria-label="Size"><option>M</option></select>
    `);
    const $ = (id: string) => document.getElementById(id);
    expect(describeElement($("b1"))).toBe('button "Place order"');
    expect(describeElement($("q"))).toBe('input "Search"');
    expect(describeElement($("e"))).toBe('input "Email"');
    expect(describeElement($("p"))).toBe('input "Your city"');
    expect(describeElement(document.querySelector("a"))).toBe('link "Home"');
    expect(describeElement($("c"))).toBe('checkbox "remember"');
    expect(describeElement($("d"))).toBe('button "Open menu"');
    expect(describeElement($("s"))).toBe('select "Size"');
  });
});

describe("DOM user-action observer", () => {
  let rt: RuntimeImpl | null = null;
  afterEach(() => {
    rt?.destroy();
    rt = null;
  });

  it("records clicks with element descriptions; the app's handler writes are user writes (never held)", async () => {
    page(`<button id="add">Add to cart</button>`);
    const clock = new FakeClock();
    const manual = new ManualDecider();
    rt = createRuntime({ clock, global: window, decider: manual, triage: "always", report: "silent", observe: { ...OFF, user: true } }) as RuntimeImpl;
    const cart = rt.atom("cart", 0);
    document.getElementById("add")!.addEventListener("click", () => cart.set((n) => n + 1));
    (document.getElementById("add") as HTMLButtonElement).click();
    expect(cart.get()).toBe(1);
    expect(manual.pending.length).toBe(0);
    const u = rt.history().find((e) => e.kind === "user")!;
    expect(u.name).toBe('click button "Add to cart"');
    const w = rt.history().find((e) => e.kind === "state")!;
    expect(rt.ops.get(w.op)!.kind).toBe("user");
    await clock.flush();
  });

  it("typing is one event per burst with the latest value; passwords are never recorded", async () => {
    page(`<label for="q">Search</label><input id="q"><input id="pw" type="password" placeholder="Password">`);
    const clock = new FakeClock();
    rt = createRuntime({ clock, global: window, decider: new ScriptedDecider(), report: "silent", observe: { ...OFF, user: true } }) as RuntimeImpl;
    const q = document.getElementById("q") as HTMLInputElement;
    for (const v of ["r", "re", "rea"]) {
      q.value = v;
      q.dispatchEvent(new Event("input", { bubbles: true }));
      await clock.advance(120);
    }
    const typed = rt.history().filter((e) => e.kind === "user");
    expect(typed.length).toBe(1);
    expect(typed[0].data).toMatchObject({ kind: "type", target: 'input "Search"', value: '"rea"', count: 3 });
    expect([...rt.ops.byId.values()].filter((o) => o.kind === "user").length).toBe(3);
    const pw = document.getElementById("pw") as HTMLInputElement;
    pw.value = "hunter2";
    pw.dispatchEvent(new Event("input", { bubbles: true }));
    const all = JSON.stringify(rt.history()) + JSON.stringify([...rt.ops.byId.values()].map((o) => ({ d: o.detail, m: o.meta })));
    expect(all).not.toContain("hunter2");
  });

  it("records submit, change and Enter", async () => {
    page(`<form aria-label="Checkout"><select id="s" aria-label="Size"><option>S</option><option>M</option></select><input id="t"><button>Pay</button></form>`);
    const clock = new FakeClock();
    rt = createRuntime({ clock, global: window, decider: new ScriptedDecider(), report: "silent", observe: { ...OFF, user: true } }) as RuntimeImpl;
    const s = document.getElementById("s") as HTMLSelectElement;
    s.selectedIndex = 1;
    s.dispatchEvent(new Event("change", { bubbles: true }));
    const t = document.getElementById("t")!;
    t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const names = rt.history().filter((e) => e.kind === "user").map((e) => e.name);
    expect(names).toEqual(['change select "Size"', 'key input "t"', 'submit form "Checkout"']);
    await clock.flush();
  });

  it("ignores events from inside [data-genclass-ignore] (devtools overlay, app debug UI)", async () => {
    page(`<div data-genclass-ignore><button id="dbg">Debug</button></div><button id="app">App</button>`);
    const host = document.createElement("genclass-devtools");
    host.setAttribute("data-genclass-ignore", "");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<button id="inner">Clear</button>`;
    const clock = new FakeClock();
    rt = createRuntime({ clock, global: window, decider: new ScriptedDecider(), report: "silent", observe: { ...OFF, user: true } }) as RuntimeImpl;
    (document.getElementById("dbg") as HTMLButtonElement).click();
    (root.getElementById("inner") as HTMLButtonElement).click();
    (document.getElementById("app") as HTMLButtonElement).click();
    const names = rt.history().filter((e) => e.kind === "user").map((e) => e.name);
    expect(names).toEqual(['click button "App"']);
    await clock.flush();
  });

  it("synthetic (isTrusted false) events are user actions only with observe.untrustedEvents (test harnesses)", async () => {
    page(`<button id="go">Go</button>`);
    const synthetic = () => {
      const ev = new MouseEvent("click", { bubbles: true });
      Object.defineProperty(ev, "isTrusted", { value: false });
      document.getElementById("go")!.dispatchEvent(ev);
    };
    const clock = new FakeClock();
    rt = createRuntime({ clock, global: window, decider: new ScriptedDecider(), report: "silent", observe: { ...OFF, user: true } }) as RuntimeImpl;
    synthetic();
    expect(rt.history().filter((e) => e.kind === "user")).toHaveLength(0);
    rt.destroy();
    rt = createRuntime({ clock, global: window, decider: new ScriptedDecider(), report: "silent", observe: { ...OFF, user: true, untrustedEvents: true } }) as RuntimeImpl;
    synthetic();
    expect(rt.history().filter((e) => e.kind === "user").map((e) => e.name)).toEqual(['click button "Go"']);
    // never while an app operation's code is running (the app dispatched it)
    await rt.op("task", () => synthetic());
    expect(rt.history().filter((e) => e.kind === "user")).toHaveLength(1);
    await clock.flush();
  });

  it("destroy() removes the listeners", () => {
    page(`<button id="b">B</button>`);
    rt = createRuntime({ clock: new FakeClock(), global: window, decider: new ScriptedDecider(), report: "silent", observe: { ...OFF, user: true } }) as RuntimeImpl;
    rt.destroy();
    (document.getElementById("b") as HTMLButtonElement).click();
    expect(rt.history().filter((e) => e.kind === "user").length).toBe(0);
  });
});

describe("browser globals are restored by destroy()", () => {
  it("fetch, XMLHttpRequest, history, Storage, WebSocket, timers", () => {
    const w = window as unknown as Record<string, unknown>;
    const before = {
      fetch: w.fetch,
      open: (w.XMLHttpRequest as { prototype: XMLHttpRequest }).prototype.open,
      push: history.pushState,
      setItem: Storage.prototype.setItem,
      ws: w.WebSocket,
      st: w.setTimeout,
    };
    const r = createRuntime({ clock: new FakeClock(), global: window, decider: new ScriptedDecider(), report: "silent" }) as RuntimeImpl;
    expect(w.fetch).not.toBe(before.fetch);
    expect(history.pushState).not.toBe(before.push);
    expect(Storage.prototype.setItem).not.toBe(before.setItem);
    expect(w.setTimeout).not.toBe(before.st);
    if (before.ws) expect(w.WebSocket).not.toBe(before.ws);
    history.pushState({}, "", "/checkout");
    localStorage.setItem("k", "v");
    const kinds = r.history().map((e) => `${e.kind}:${e.name}`);
    expect(kinds).toContain("nav:/checkout");
    expect(kinds.some((k) => /^storage:(localStorage|storage)\.setItem$/.test(k))).toBe(true);
    r.destroy();
    expect(w.fetch).toBe(before.fetch);
    expect((w.XMLHttpRequest as { prototype: XMLHttpRequest }).prototype.open).toBe(before.open);
    expect(history.pushState).toBe(before.push);
    expect(Storage.prototype.setItem).toBe(before.setItem);
    expect(w.WebSocket).toBe(before.ws);
    expect(w.setTimeout).toBe(before.st);
  });

  it("uncaught errors and unhandled rejections become error triggers", async () => {
    const clock = new FakeClock();
    const d = new ScriptedDecider();
    const r = createRuntime({ clock, global: window, decider: d, report: "silent", observe: { ...OFF, errors: true } }) as RuntimeImpl;
    window.dispatchEvent(new ErrorEvent("error", { message: "boom", error: new TypeError("boom"), filename: "http://x/app.js", lineno: 12 }));
    await clock.flush();
    const e = d.calls.find((c) => c.trigger === "error")!;
    expect((e.state.facts as string[])[0]).toBe("Uncaught TypeError: boom (at app.js:12).");
    r.destroy();
  });
});
