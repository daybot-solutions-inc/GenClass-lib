// Development stand-in for @genclass/runtime/devtools (see index.ts): no overlay.
import type { Runtime } from "../../../../packages/runtime/src/types.ts";

export interface DevtoolsOptions {
  position?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  collapsed?: boolean;
  theme?: "auto" | "light" | "dark";
  tab?: "interventions" | "detections" | "activity" | "now";
  hotkey?: boolean;
  container?: HTMLElement;
}

export function mountDevtools(_runtime: Runtime, _opts?: DevtoolsOptions) {
  return { open() {}, close() {}, toggle() {}, unmount() {}, element: null };
}
