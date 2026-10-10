// @vitest-environment happy-dom
// The zero-code entries turn automatic state discovery on by default (InitOptions.autoState); GenClass.init() does
// not; the page config and the kill switch turn it off. Telemetry and the model are off in every run here.
import { afterEach, describe, expect, it } from "vitest";
import { AUTO_DEFAULTS, startAuto } from "../src/cdn/auto-start.js";
import { fromPairs } from "../src/cdn/config.js";
import { GenClass } from "../src/index.js";
import type { RuntimeImpl } from "../src/runtime.js";

const W = window as unknown as Record<string, unknown>;
const HOOK = "__REACT_DEVTOOLS_GLOBAL_HOOK__";

afterEach(() => {
  GenClass.destroy();
  delete W[HOOK];
  delete (globalThis as Record<string, unknown>)[HOOK];
  delete W.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__;
  delete W.__REDUX_DEVTOOLS_EXTENSION__;
  delete W.GENCLASS_CONFIG;
  localStorage.removeItem("genclass");
  document.head.innerHTML = "";
});

const SAFE = { telemetry: false, model: false as const, report: "silent" as const };

describe("autoState defaults (zero-code entries)", () => {
  it("@genclass/runtime/auto installs discovery synchronously", () => {
    W.GENCLASS_CONFIG = SAFE;
    expect(AUTO_DEFAULTS.autoState).toBe(true);
    const rt = startAuto() as RuntimeImpl;
    expect((W[HOOK] as { _genclass?: boolean } | undefined)?._genclass).toBe(true);
    expect(typeof W.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__).toBe("function");
    expect(rt.discoveryStats()).not.toBeNull();
    expect(rt.telemetry?.enabled).toBe(false);
  });

  it("GenClass.init() leaves it off unless asked", () => {
    const rt = GenClass.init(SAFE) as RuntimeImpl;
    expect(W[HOOK]).toBeUndefined();
    expect(rt.discoveryStats()).toBeNull();
  });

  it("<meta name=genclass content=autostate=off> and window.GENCLASS_CONFIG.autoState=false turn it off", () => {
    expect(fromPairs({ autostate: "off" }).autoState).toBe(false);
    expect(fromPairs({ autostate: "on" }).autoState).toBeUndefined();
    const m = document.createElement("meta");
    m.name = "genclass";
    m.content = "autostate=off, telemetry=off, model=off";
    document.head.appendChild(m);
    const rt = startAuto() as RuntimeImpl;
    expect(W[HOOK]).toBeUndefined();
    expect(rt.discoveryStats()).toBeNull();
    GenClass.destroy();
    document.head.innerHTML = "";
    W.GENCLASS_CONFIG = { ...SAFE, autoState: { react: false } };
    const rt2 = startAuto() as RuntimeImpl;
    expect(W[HOOK]).toBeUndefined();
    expect(typeof W.__REDUX_DEVTOOLS_EXTENSION__).toBe("function");
    void rt2;
  });

  it("the kill switch (genclass=off) installs no discovery either", () => {
    localStorage.setItem("genclass", "off");
    W.GENCLASS_CONFIG = SAFE;
    const rt = startAuto() as RuntimeImpl;
    expect(W[HOOK]).toBeUndefined();
    expect(W.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__).toBeUndefined();
    expect(rt.discoveryStats()).toBeNull();
  });
});
