// INTERCEPTION.md is a contract: this test installs the runtime (every observer, automatic state discovery) on a
// synthetic browser global and checks that exactly the globals, prototypes and listeners the page's machine-checked
// inventory lists are changed, that destroy() restores what it says is restored, and that the patch sites in src/
// (addEventListener calls, defineProperty, Reflect.set, assignments to global / prototype / hook objects) still match
// the per-file counts there. A new patch anywhere in src/ fails this test until INTERCEPTION.md is updated.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import "./discover-register.js";
import { createRuntime } from "../src/index.js";
import { FakeClock, ScriptedDecider } from "./helpers.js";

const PKG = join(__dirname, "..");
const DOC = readFileSync(join(PKG, "INTERCEPTION.md"), "utf8");

function inventory(): { patch: Map<string, "restored" | "stays">; listen: Set<string>; observe: Set<string>; sites: Map<string, number> } {
  const m = /<!-- inventory:start -->\s*```text\n([\s\S]*?)```\s*<!-- inventory:end -->/.exec(DOC);
  if (!m) throw new Error("INTERCEPTION.md has no machine-checked inventory block");
  const out = { patch: new Map<string, "restored" | "stays">(), listen: new Set<string>(), observe: new Set<string>(), sites: new Map<string, number>() };
  for (const line of m[1].split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [kind, a, b] = line.split(/\s+/);
    if (kind === "patch") out.patch.set(a, b as "restored" | "stays");
    else if (kind === "listen") out.listen.add(`${a} ${b}`);
    else if (kind === "observe") out.observe.add(`${a} ${b}`);
    else if (kind === "sites") out.sites.set(a, Number(b));
    else throw new Error(`INTERCEPTION.md inventory: unknown line "${line}"`);
  }
  return out;
}

/** A browser-like global with every API the observers and discovery hook into, recording listeners. */
function browserGlobal() {
  const added: string[] = [];
  const removed: string[] = [];
  const target = (name: string) => ({
    addEventListener: (t: string) => void added.push(`${name} ${t}`),
    removeEventListener: (t: string) => void removed.push(`${name} ${t}`),
  });
  class XHR {}
  for (const k of ["open", "send", "abort", "setRequestHeader", "addEventListener", "removeEventListener", "dispatchEvent"])
    (XHR.prototype as unknown as Record<string, unknown>)[k] = function () {
      return undefined;
    };
  class Storage {}
  for (const k of ["getItem", "setItem", "removeItem", "clear"])
    (Storage.prototype as unknown as Record<string, unknown>)[k] = function () {
      return null;
    };
  class WS extends EventTarget {
    constructor(_url: string) {
      super();
    }
    send(): void {}
  }
  class ES extends EventTarget {
    constructor(_url: string) {
      super();
    }
  }
  const observed: string[] = [];
  class PO {
    static supportedEntryTypes = ["longtask"];
    constructor(_fn: unknown) {}
    observe(o: { type: string }): void {
      observed.push(`PerformanceObserver ${o.type}`);
    }
    disconnect(): void {
      observed.push("disconnected");
    }
  }
  const g: Record<string, unknown> = {
    ...target("window"),
    fetch: () => Promise.resolve(new Response("")),
    Response,
    XMLHttpRequest: XHR,
    WebSocket: WS,
    EventSource: ES,
    Storage,
    localStorage: new Storage(),
    sessionStorage: new Storage(),
    setTimeout: () => 0,
    setInterval: () => 0,
    history: { pushState() {}, replaceState() {} },
    location: { href: "http://app.test/", pathname: "/", search: "", hash: "" },
    document: { ...target("document"), visibilityState: "visible", title: "t" },
    navigator: {},
    PerformanceObserver: PO,
  };
  g.window = g;
  return { g, added, removed, observed, XHR, Storage };
}

type Snap = Map<string, unknown>;
function snapshot(g: Record<string, unknown>, XHR: { prototype: object }, S: { prototype: object }): Snap {
  const s: Snap = new Map();
  const HOOKS = ["__REACT_DEVTOOLS_GLOBAL_HOOK__", "__REDUX_DEVTOOLS_EXTENSION_COMPOSE__", "__REDUX_DEVTOOLS_EXTENSION__"];
  for (const k of new Set([...Object.keys(g), ...HOOKS])) if (k !== "window" && k !== "document") s.set(`window.${k}`, g[k]);
  for (const k of Object.getOwnPropertyNames(XHR.prototype)) s.set(`XMLHttpRequest.prototype.${k}`, (XHR.prototype as Record<string, unknown>)[k]);
  for (const k of Object.getOwnPropertyNames(S.prototype)) s.set(`Storage.prototype.${k}`, (S.prototype as Record<string, unknown>)[k]);
  const h = g.history as Record<string, unknown>;
  for (const k of Object.keys(h)) s.set(`history.${k}`, h[k]);
  return s;
}

function diff(a: Snap, b: Snap): string[] {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((k) => a.get(k) !== b.get(k)).sort();
}

const OBSERVERS = { fetch: true, xhr: true, websocket: true, eventsource: true, user: true, errors: true, nav: true, storage: true, perf: true, timers: true };

describe("INTERCEPTION.md matches what the runtime patches (docs contract)", () => {
  it("installing changes exactly the inventory's globals, prototypes and listeners", () => {
    const inv = inventory();
    const { g, added, observed, XHR, Storage } = browserGlobal();
    const before = snapshot(g, XHR, Storage);
    const rt = createRuntime({ clock: new FakeClock(), global: g, decider: new ScriptedDecider(), report: "silent", autoState: true, observe: OBSERVERS });
    try {
      const after = snapshot(g, XHR, Storage);
      expect(diff(before, after), "patched globals differ from INTERCEPTION.md: update its tables and inventory").toEqual([...inv.patch.keys()].sort());
      expect([...new Set(added)].sort(), "listeners differ from INTERCEPTION.md").toEqual([...inv.listen].sort());
      expect(observed.filter((o) => o !== "disconnected").sort()).toEqual([...inv.observe].sort());
    } finally {
      rt.destroy();
    }
  });

  it("destroy() restores what the inventory says is restored and removes every listener", () => {
    const inv = inventory();
    const { g, added, removed, observed, XHR, Storage } = browserGlobal();
    const before = snapshot(g, XHR, Storage);
    const rt = createRuntime({ clock: new FakeClock(), global: g, decider: new ScriptedDecider(), report: "silent", autoState: true, observe: OBSERVERS });
    const installed = snapshot(g, XHR, Storage);
    rt.destroy();
    const after = snapshot(g, XHR, Storage);
    for (const [name, fate] of inv.patch) {
      if (fate === "restored") expect(after.get(name), `${name} should be restored`).toBe(before.get(name));
      else expect(after.get(name), `${name} stays (inert)`).toBe(installed.get(name));
    }
    expect([...removed].sort()).toEqual([...added].sort());
    expect(observed).toContain("disconnected");
  });

  it("the patch sites in src/ match the per-file counts in INTERCEPTION.md", () => {
    const inv = inventory();
    const PATTERNS = [
      /\.addEventListener\(/g,
      /Object\.defineProperty\(/g,
      /Reflect\.(?:set|defineProperty)\(/g,
      /\b(?:g|w|P|hist|existing|api|globalThis|window|self|document)\.[A-Za-z_$][\w$]* = (?!=)/g,
      /\bg\[[\w$]+\] = (?!=)/g,
      /\.prototype\.[\w$]+ = (?!=)/g,
      /\bi\.updater = (?!=)/g,
    ];
    /** Instances observers create for the app (a WebSocket's own send). */
    const INSTANCE = /\bthis\.[\w$]+ = (?!=)/g;
    // pure computation (facts, situation text, learned profiles, the gate) touches no global
    const SKIP = /^src\/(learn|situation)\/|^src\/decide\/policy\.ts$/;
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(PKG, "src"));
    const counts = new Map<string, number>();
    for (const p of files) {
      const rel = relative(PKG, p).split("\\").join("/");
      if (SKIP.test(rel)) continue;
      let n = 0;
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
        for (const re of PATTERNS) n += line.match(re)?.length ?? 0;
        if (/^src\/(observe|discover|cdn)\//.test(rel)) n += line.match(INSTANCE)?.length ?? 0;
      }
      if (n) counts.set(rel, n);
    }
    const sorted = (m: Map<string, number>) => [...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([f, n]) => `${f} ${n}`);
    expect(sorted(counts), "patch sites in src/ changed: document the new interception in INTERCEPTION.md (tables and the `sites` lines)").toEqual(sorted(inv.sites));
  });

  it("every file named in INTERCEPTION.md exists", () => {
    for (const m of DOC.matchAll(/\]\((src\/[^)#]+)\)/g)) expect(() => statSync(join(PKG, m[1])), m[1]).not.toThrow();
  });
});
