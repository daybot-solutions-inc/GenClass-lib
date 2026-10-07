import { bootDemo } from "../../site/demo-page.ts";
import { h } from "../../site/dom.ts";
import { highlight } from "../../site/highlight.ts";
import { SERVICES } from "../../server/worlds/status.ts";
import type { ServerLink } from "../../shared/server.ts";
import { mountStatus } from "./app.ts";
import { statusOracle } from "./oracle.ts";
import { statusScenario } from "./scenario.ts";

function extras(link: ServerLink): HTMLElement {
  const sel = h(
    "select",
    { class: "select", style: { height: "30px", fontSize: "13px" }, "aria-label": "Service" },
    SERVICES.map((s) => h("option", { value: s.id }, s.name)),
  );
  const incident = (status: "degraded" | "down") => {
    const b = h("button", { class: "btn btn-sm", type: "button" }, status === "down" ? "Start outage" : "Degrade");
    b.addEventListener("click", () => void link.world("incident", { svc: sel.value, status, dur: 12000 }));
    return b;
  };
  const resolve = h("button", { class: "btn btn-sm btn-ghost", type: "button" }, "Resolve all");
  resolve.addEventListener("click", () => void link.world("resolveAll"));
  return h(
    "div",
    null,
    h("h4", null, "Real incidents (12 s)"),
    h("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" } }, sel, incident("degraded"), incident("down"), resolve),
  );
}

bootDemo({
  id: "status",
  host: "status.acme.example",
  mount: mountStatus,
  scenario: statusScenario,
  oracle: statusOracle,
  loaded: "loaded",
  settle: false,
  chaosExtras: extras,
  serverParams: { randomIncidents: true },
  code: highlight(`GenClass.init();

// the app's own store, handed to GenClass
const board = gc.guard("services", store,
  { resync: () => refreshAll() });

setInterval(refreshAll, 2000);   // never waits

async function poll(id, attempt = 1) {
  try {
    const res = await fetchWithTimeout(\`/api/status/\${id}\`, 4000);
    board.update(...);
  } catch (e) {
    if (attempt < 3) return poll(id, attempt + 1); // no backoff
    board.update(markUnreachable(id));             // + banner
  }
}`),
});
