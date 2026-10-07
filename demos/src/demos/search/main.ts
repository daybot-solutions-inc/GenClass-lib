import { bootDemo } from "../../site/demo-page.ts";
import { highlight } from "../../site/highlight.ts";
import { mountSearch } from "./app.ts";
import { searchOracle } from "./oracle.ts";
import { searchScenario } from "./scenario.ts";

bootDemo({
  id: "search",
  host: "wander.example/search",
  mount: mountSearch,
  scenario: searchScenario,
  oracle: searchOracle,
  code: highlight(`const gc = GenClass.init();
const search = gc.atom("search", { input: "", items: [] });

input.addEventListener("input", () => {
  search.set((s) => ({ ...s, input: input.value }));
  clearTimeout(t);
  t = setTimeout(() => run(input.value), 150);
});

async function run(q) {
  const res = await fetch(\`/api/search?q=\${q}\`);
  const data = await res.json();
  // no ordering guard: an older answer can land last
  search.set((s) => ({ ...s, items: data.items }));
}`),
});
