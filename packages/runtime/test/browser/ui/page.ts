// Screenshot page: a small store app with the devtools overlay mounted on a scripted runtime.
// Bundled by test/browser/ui-devtools.spec.ts (esbuild) and driven through window.__gc.

import { mountDevtools, type DevtoolsHandle, type DevtoolsOptions } from "../../../src/devtools/index.js";
import type { Mode, ModelStatus } from "../../../src/types.js";
import { MockRuntime } from "./mock-runtime.js";
import { loadScenario } from "./scenario.js";

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
.search span{color:var(--fg2)}
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
    <div class="search"><span>⌕</span><b>react</b></div>
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
  scenario?: "full" | "empty" | "loading";
  mode?: Mode;
  status?: ModelStatus;
}

declare global {
  interface Window {
    __gc: { start(o?: StartOptions): void; rt?: MockRuntime; dt?: DevtoolsHandle; undos: string[] };
  }
}

window.__gc = {
  undos: [],
  start(o: StartOptions = {}) {
    window.__gc.dt?.unmount();
    document.head.querySelector("#app-css")?.remove();
    const style = document.createElement("style");
    style.id = "app-css";
    style.textContent = APP_CSS;
    document.head.appendChild(style);
    document.body.innerHTML = APP_HTML;
    const rt = new MockRuntime();
    if (!o.scenario || o.scenario === "full") loadScenario(rt, { onUndo: (id) => window.__gc.undos.push(id) });
    else {
      rt.clock.t = 2600;
      rt.event("nav", "load /search", { t: 640, data: { route: "/search" } });
      rt.event("op.start", "GET /api/session", { t: 1130, op: 1, data: { kind: "fetch" } });
      rt.event("op.end", "GET /api/session", { t: 1342, op: 1, data: { kind: "fetch", status: "ok", code: 200 } });
      rt.event("state", "session", { t: 1344, op: 1, cause: 1, data: { paths: ["session.user", "session.flags"] } });
    }
    if (o.mode) rt.mode = o.mode;
    if (o.scenario === "loading") rt.setStatus({ state: "loading", progress: { loaded: 9_830_000, total: 24_740_000 } });
    if (o.status) rt.setStatus(o.status);
    window.__gc.rt = rt;
    window.__gc.dt = mountDevtools(rt, o);
  },
};
