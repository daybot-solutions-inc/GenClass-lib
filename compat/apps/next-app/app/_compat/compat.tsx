"use client";
// The compat page's client root: picks the data layer (?layer=) and the scenario (?s=). Rendered on the server first
// (SSR), then hydrated.
import StateLayer from "./layers/state";
import SwrLayer from "./layers/swr";

const LAYERS: Record<string, (p: { s: string }) => React.ReactElement> = { state: StateLayer, swr: SwrLayer };

export default function Compat({ layer, s }: { layer: string; s: string }) {
  const L = LAYERS[layer] ?? StateLayer;
  return <L s={s} />;
}
