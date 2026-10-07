// Screenshot page: a small store app with the devtools overlay mounted on a scripted runtime.
// Bundled by test/browser/ui-devtools.spec.ts (esbuild) and driven through window.__gc.

import { mountDevtools, type DevtoolsHandle, type DevtoolsOptions } from "../../../src/devtools/index.js";
import type { Mode, ModelStatus, Runtime } from "../../../src/types.js";
import { MockRuntime } from "./mock-runtime.js";
import { loadScenario } from "./scenario.js";
import { runStoreSession } from "./session.js";

const APP_CSS = `
:root{--bg:#f6f6f4;--card:#fff;--line:#e6e5e1;--fg:#1d1d1b;--fg2:#6b6a66;--accent:#0f766e;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0c;--card:#151517;--line:#232326;--fg:#ececea;--fg2:#8d8d92;--accent:#2dd4bf;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.nav{display:flex;align-items:center;gap:28px;height:60px;padding:0 48px;border-bottom:1px solid var(--line);background:var(--card)}
.logo{display:flex;align-items:center;gap:8px;font-weight:700;font-size:17px;letter-spacing:-.02em}
.logo i{width:20px;height:20px;border-radius:6px;background:var(--accent);display:block}
.nav a{color:var(--fg2);text-decoration:none;font-size:14px;font-weight:500}
.nav a.on{color:var(--fg)}
.nav .sp{flex:1}
.av{width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#f59e0b,#ef4444);color:#fff;display:grid;place-items:center;font-size:12px;font-weight:700}
main{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:28px;max-width:860px;padding:36px 48px}
h1{margin:0 0 4px;font-size:26px;letter-spacing:-.025em}
.sub{margin:0 0 20px;color:var(--fg2);font-size:14px}
.search{display:flex;align-items:center;gap:10px;height:44px;padding:0 14px;border:1px solid var(--line);border-radius:10px;background:var(--card);margin-bottom:16px}
.search svg{color:var(--fg2)}
.search b{font-weight:500}
.res{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.res li{display:flex;gap:14px;align-items:center;padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
.th{width:44px;height:44px;border-radius:10px;flex:none}
.res b{display:block;font-size:15px}
.res small{color:var(--fg2);font-size:13px}
.res .pr{margin-left:auto;font-weight:600;font-variant-numeric:tabular-nums}
.cart{padding:18px;border:1px solid var(--line);border-radius:14px;background:var(--card);align-self:start}
.cart h3{margin:0 0 12px;font-size:15px}
.ci{display:flex;justify-content:space-between;font-size:14px;padding:8px 0;border-bottom:1px solid var(--line)}
.ci span{color:var(--fg2)}
.tot{display:flex;justify-content:space-between;margin:14px 0;font-weight:700}
.cta{width:100%;height:42px;border:0;border-radius:10px;background:var(--fg);color:var(--bg);font:600 14px Inter,system-ui,sans-serif}
`;

const APP_HTML = `
<header class="nav"><div class="logo"><i></i>Acme</div><a href="#">Products</a><a href="#">Orders</a><a class="on" href="#">Cart</a><span class="sp"></span><div class="av">MK</div></header>
<main>
  <section>
    <h1>Desk setup</h1>
    <p class="sub">3 results for “react” · updated just now</p>
    <div class="search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><b>react</b></div>
    <ul class="res">
      <li><div class="th" style="background:linear-gradient(135deg,#fde68a,#f59e0b)"></div><div><b>Desk lamp</b><small>Warm LED, dimmable</small></div><span class="pr">$20.99</span></li>
      <li><div class="th" style="background:linear-gradient(135deg,#a7f3d0,#10b981)"></div><div><b>Monitor arm</b><small>Single, gas spring</small></div><span class="pr">$41.99</span></li>
      <li><div class="th" style="background:linear-gradient(135deg,#c7d2fe,#6366f1)"></div><div><b>Keyboard tray</b><small>Under-desk, 26 in</small></div><span class="pr">$21.99</span></li>
    </ul>
  </section>
  <aside class="cart"><h3>Your cart</h3>
    <div class="ci">Desk lamp × 3<span>$62.97</span></div>
    <div class="ci">Keyboard tray<span>$21.99</span></div>
    <div class="ci">Monitor arm<span>$41.99</span></div>
    <div class="tot">Total<span>$84.97</span></div>
    <button class="cta" type="button">Place order</button>
  </aside>
</main>`;

interface StartOptions extends DevtoolsOptions {
  /** live (default): the real runtime running the store session; loading: real runtime, model still downloading;
   *  mock: the scripted mock runtime (fast, for interaction checks); empty: mock with almost no data. */
  scenario?: "live" | "loading" | "mock" | "empty";
  mode?: Mode;
  status?: ModelStatus;
}

declare global {
  interface Window {
    __gc: { start(o?: StartOptions): Promise<void>; rt?: Runtime; dt?: DevtoolsHandle; undos: string[] };
  }
}

window.__gc = {
  undos: [],
  async start(o: StartOptions = {}) {
    window.__gc.dt?.unmount();
    window.__gc.rt?.destroy();
    document.head.querySelector("#app-css")?.remove();
    const style = document.createElement("style");
    style.id = "app-css";
    style.textContent = APP_CSS;
    document.head.appendChild(style);
    document.body.innerHTML = APP_HTML;
    let rt: Runtime;
    const scenario = o.scenario ?? "live";
    if (scenario === "live") {
      rt = (await runStoreSession()).rt;
    } else if (scenario === "loading") {
      rt = (await runStoreSession({ warmupOnly: true, status: { state: "loading", progress: { loaded: 9_830_000, total: 24_740_000 } } })).rt;
    } else {
      const m = new MockRuntime();
      if (scenario === "mock") loadScenario(m, { onUndo: (id) => window.__gc.undos.push(id) });
      else {
        m.clock.t = 2600;
        m.event("op.start", "GET /api/session", { t: 1130, op: 1, data: { kind: "fetch" } });
        m.event("op.end", "GET /api/session", { t: 1342, op: 1, data: { status: "ok", code: 200 } });
      }
      if (o.status) m.setStatus(o.status);
      rt = m;
    }
    if (o.mode) rt.setMode(o.mode);
    window.__gc.rt = rt;
    window.__gc.dt = mountDevtools(rt, o);
  },
};
