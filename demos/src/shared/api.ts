// Base URL of the demo API (served by the Service Worker mock server under <site>/api/). Works under any
// sub-path, e.g. GitHub Pages.
import { siteRoot } from "./settings.ts";

const BASE = new URL("api/", siteRoot()).href;

export function api(path: string): string {
  return BASE + path.replace(/^\//, "");
}
