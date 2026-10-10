import "@genclass/runtime/auto"; // GenClass, first line of the entry (observe by default), as `npx @genclass/runtime init` writes it
import { StrictMode, Suspense, lazy, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

// The compat page: ?layer=<data layer>&s=<scenario a-h>. Each data layer is its own chunk, so a page only creates
// the stores of the layer it shows.
const params = new URLSearchParams(location.search);
const layer = params.get("layer") ?? "state";
const s = params.get("s") ?? "h";

type LayerModule = { default: (p: { s: string }) => ReactElement };
const layers: Record<string, () => Promise<LayerModule>> = {
  state: () => import("./layers/state"),
  tanstack: () => import("./layers/tanstack"),
  zustand: () => import("./layers/zustand"),
  "zustand-on": () => import("./layers/zustand"),
  redux: () => import("./layers/redux"),
  apollo: () => import("./layers/apollo"),
};
const Layer = lazy(layers[layer] ?? layers.state);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={<p>Loading…</p>}>
      <Layer s={s} />
    </Suspense>
  </StrictMode>,
);
