import { bootDemo } from "../../site/demo-page.ts";
import { h } from "../../site/dom.ts";
import { highlight } from "../../site/highlight.ts";
import type { ServerLink } from "../../shared/server.ts";
import { mountBoard } from "./app.tsx";
import { boardOracle } from "./oracle.ts";
import { boardScenario } from "./scenario.ts";

function extras(link: ServerLink): HTMLElement {
  const any = h("button", { class: "btn btn-sm", type: "button" }, "Teammate moves a card");
  any.addEventListener("click", () => void link.world("teammateMove", {}));
  const recent = h("button", { class: "btn btn-sm", type: "button" }, "…the one you just moved");
  recent.addEventListener("click", () => void link.world("teammateMove", { recent: true }));
  return h(
    "div",
    null,
    h("h4", null, "Teammates (they also move cards every ~9 s)"),
    h("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap" } }, any, recent),
  );
}

bootDemo({
  id: "board",
  host: "tasks.example/sprint-14",
  mount: mountBoard,
  scenario: boardScenario,
  oracle: boardOracle,
  loaded: "loaded",
  settle: { idleMs: 800, timeoutMs: 25000 },
  chaosExtras: extras,
  serverParams: { teamEveryMs: 9000 },
  code: highlight(`const gc = GenClass.init();
const useBoard = create(genclass(gc, "board", { resync: load })((set, get) => ({
  async move(id, column) {
    const before = get().cards;
    set(optimistic(id, column));
    try { set(confirm(await post(\`/api/cards/\${id}/move\`))); }
    catch { set({ cards: before }); }   // whole-board rollback
  },
  applyEvent(ev) {                      // no version check
    set((s) => ({ cards: { ...s.cards, [ev.card.id]: ev.card } }));
  },
})));

new EventSource("/api/board/events").onmessage =
  (e) => useBoard.getState().applyEvent(JSON.parse(e.data));`),
});
