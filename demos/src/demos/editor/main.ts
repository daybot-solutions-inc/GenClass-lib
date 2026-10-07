import { bootDemo } from "../../site/demo-page.ts";
import { highlight } from "../../site/highlight.ts";
import { mountEditor } from "./app.ts";
import { editorOracle } from "./oracle.ts";
import { editorScenario } from "./scenario.ts";

bootDemo({
  id: "editor",
  host: "notes.example/workspace",
  mount: mountEditor,
  scenario: editorScenario,
  oracle: editorOracle,
  loaded: "loaded",
  settle: { idleMs: 900, timeoutMs: 25000 },
  code: highlight(`const gc = GenClass.init();
const store = createStore(notes, initial,
  genclassEnhancer(gc, { name: "notes" }));

async function save() {
  store.dispatch({ type: "save/started" });
  const res = await fetch(\`/api/notes/\${id}\`, { method: "PUT", body });
  const saved = await res.json();
  // the echo becomes the note unless the user is typing
  store.dispatch({ type: "save/succeeded", note: saved,
    applyBody: now() - lastKeyAt > 300 });
}`),
});
