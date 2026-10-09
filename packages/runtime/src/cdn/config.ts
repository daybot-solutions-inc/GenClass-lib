// Page-level configuration for the zero-code entries: `import "@genclass/runtime/auto"` and the CDN script tag
// (dist/genclass.global.js). Owner: INSTALL.
//
// Sources, lowest precedence first (the URL kill switch `?genclass=off|observe|guard|heal` and
// `localStorage.genclass` still beat everything, inside GenClass.init):
//   <meta name="genclass" content="mode=observe, devtools=local">
//   <script src=".../genclass.global.min.js" data-mode="observe" data-devtools></script>   (script tag only)
//   window.GENCLASS_CONFIG = { mode: "observe", devtools: true, policy: { deny: ["delay"] } }  (any InitOptions)
//
// Keys of the meta tag and data attributes: mode, model (a model directory URL, or "off"), device, preload, ort
// (onnxruntime-web wasm directory), worker, report, debug, triage, devtools (bare / true, "local" = only on
// localhost, false, or a corner such as "bottom-left"), telemetry (off/false/no: no anonymous diagnostics).
//
// Trust: every `<meta name="genclass">` in the document is read (head or body, first to last), and its keys can set
// the mode and the model and onnxruntime-web URLs. That is deliberate (no build step needed), but on a page that
// renders untrusted HTML able to contain <meta> tags, set those keys in window.GENCLASS_CONFIG (it wins over meta
// tags) or call GenClass.init(options) instead of using /auto or the script tag's automatic start.
//
// Remote code: an `integrity` attribute on the script tag covers that one file only. What it loads later at runtime
// (dist/cdn/worker.js, dist/cdn/ort-*.js, dist/devtools/index.js, onnxruntime-web's wasm and the model files) is
// fetched by URL without SRI (dynamic import() and module workers take no integrity option). On
// jsDelivr/unpkg those URLs are pinned to the tag's own version (immutable there), so pin the tag's version
// (`@genclass/runtime@x.y.z`, as `init` writes it), never @latest, in production. For full control, self-host:
// `data-base` (this package's dist/), `data-ort` (onnxruntime-web's dist/) and `data-model` (a model directory), plus
// a CSP `script-src` / `worker-src` / `connect-src` limited to those origins.

import type { DevtoolsOptions, DevtoolsPosition } from "../devtools/index.js";
import type { InitOptions, Mode, ModelOptions } from "../types.js";

/** true, "local" (localhost, 127.0.0.1, [::1], *.localhost, *.local, *.test, file:), false, or overlay options. */
export type DevtoolsSetting = boolean | "local" | DevtoolsOptions;

export interface PageConfig extends InitOptions {
  /** Mount the devtools overlay (loaded on demand). Default: not mounted. */
  devtools?: DevtoolsSetting;
}

const MODES: readonly string[] = ["observe", "guard", "heal"];
const POSITIONS: readonly string[] = ["bottom-right", "bottom-left", "top-right", "top-left"];

const isOff = (v: string) => v === "false" || v === "0" || v === "off" || v === "no" || v === "none";
const isOn = (v: string) => v === "" || v === "true" || v === "1" || v === "on" || v === "yes";
const normKey = (k: string) => k.trim().toLowerCase().replace(/[-_\s]/g, "");

/** `"mode=observe, devtools; model=off"` -> `{ mode: "observe", devtools: "", model: "off" }` (keys normalised). */
export function parsePairs(s: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(s ?? "").split(/[,;\s]+/)) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = normKey(eq < 0 ? part : part.slice(0, eq));
    if (k) out[k] = eq < 0 ? "" : part.slice(eq + 1).trim();
  }
  return out;
}

function parseDevtools(v: string): DevtoolsSetting {
  if (isOff(v)) return false;
  if (v === "local" || v === "dev" || v === "localhost") return "local";
  if (POSITIONS.includes(v)) return { position: v as DevtoolsPosition };
  return true;
}

/** Turns normalised key/value pairs (meta content, script data attributes) into options. Unknown keys are ignored. */
export function fromPairs(pairs: Record<string, string>): PageConfig {
  const c: PageConfig = {};
  const model: ModelOptions = {};
  let modelOff = false;
  for (const [k, raw] of Object.entries(pairs)) {
    const v = String(raw ?? "").trim();
    const lv = v.toLowerCase();
    switch (k) {
      case "mode":
        if (MODES.includes(lv)) c.mode = lv as Mode;
        break;
      case "model":
        if (isOff(lv)) modelOff = true;
        else if (!isOn(lv)) model.baseUrl = v;
        break;
      case "modelurl":
      case "baseurl":
        if (v) model.baseUrl = v;
        break;
      case "device":
        if (lv === "auto" || lv === "webgpu" || lv === "wasm") model.device = lv;
        break;
      case "preload":
        if (lv === "eager" || lv === "idle" || lv === "lazy") model.preload = lv;
        break;
      case "ort":
      case "ortwasmpaths":
        if (v) model.ortWasmPaths = v;
        break;
      case "worker":
        model.worker = !isOff(lv);
        break;
      case "report":
        if (lv === "console" || lv === "silent") c.report = lv;
        break;
      case "debug":
        c.debug = !isOff(lv);
        break;
      case "triage":
        if (lv === "salient" || lv === "always") c.triage = lv;
        break;
      case "devtools":
        c.devtools = parseDevtools(lv);
        break;
      case "telemetry":
        // anonymous diagnostics (TELEMETRY.md): only an opt-out here; on is the GenClass.init default
        if (isOff(lv)) c.telemetry = false;
        break;
    }
  }
  if (modelOff) c.model = false;
  else if (Object.keys(model).length) c.model = model;
  return c;
}

/** Shallow merge, later wins; two `model` objects are merged, `model: false` replaces. */
export function mergeConfig(...configs: (PageConfig | null | undefined)[]): PageConfig {
  const out: Record<string, unknown> = {};
  for (const c of configs) {
    if (!c || typeof c !== "object") continue;
    for (const [k, v] of Object.entries(c)) {
      if (v === undefined) continue;
      const prev = out[k];
      out[k] = k === "model" && v && typeof v === "object" && prev && typeof prev === "object" ? { ...prev, ...v } : v;
    }
  }
  return out as PageConfig;
}

interface DocLike {
  querySelectorAll?(sel: string): ArrayLike<{ getAttribute(name: string): string | null }>;
}

/** Every `<meta name="genclass" content="...">`, in document order. */
export function readMetaConfig(doc: DocLike | null | undefined): PageConfig {
  let c: PageConfig = {};
  try {
    const metas = doc?.querySelectorAll?.('meta[name="genclass"]');
    for (let i = 0; metas && i < metas.length; i++) c = mergeConfig(c, fromPairs(parsePairs(metas[i].getAttribute("content"))));
  } catch {
    /* never break the page over configuration */
  }
  return c;
}

/** `window.GENCLASS_CONFIG` (any InitOptions plus `devtools`). */
export function readWindowConfig(win: unknown): PageConfig {
  try {
    const c = (win as { GENCLASS_CONFIG?: unknown } | null | undefined)?.GENCLASS_CONFIG;
    return c && typeof c === "object" ? ({ ...(c as PageConfig) } as PageConfig) : {};
  } catch {
    return {};
  }
}

/** A script tag's dataset (`data-mode`, `data-devtools`, ...); `data-manual` and `data-base` are not options. */
export function fromDataset(ds: Record<string, string | undefined> | null | undefined): PageConfig {
  const pairs: Record<string, string> = {};
  for (const [k, v] of Object.entries(ds ?? {})) {
    const nk = normKey(k);
    if (nk === "manual" || nk === "base") continue;
    pairs[nk] = v ?? "";
  }
  return fromPairs(pairs);
}

interface LocLike {
  protocol?: string;
  hostname?: string;
  search?: string;
}

/** Development hosts: loopback, *.localhost, *.local, *.test, file:. */
export function isLocalHost(loc: LocLike | null | undefined): boolean {
  if (!loc) return false;
  if (loc.protocol === "file:") return true;
  const h = String(loc.hostname ?? "").toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "[::1]" ||
    h === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(h) ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".test")
  );
}

/** `?genclass=off` or `localStorage.genclass = "off"` (GenClass.init installs nothing then; neither do we). */
export function isKilled(g: { location?: LocLike; localStorage?: { getItem(k: string): string | null } } | null | undefined): boolean {
  let v: string | null = null;
  try {
    if (g?.location?.search) v = new URLSearchParams(g.location.search).get("genclass");
  } catch {
    /* ignore */
  }
  if (!v) {
    try {
      v = g?.localStorage?.getItem("genclass") ?? null;
    } catch {
      /* ignore */
    }
  }
  return !!v && v.trim().toLowerCase() === "off";
}

/** Overlay options when the setting asks for the overlay on this page, else null. */
export function devtoolsOptions(s: DevtoolsSetting | undefined, loc: LocLike | null | undefined): DevtoolsOptions | null {
  if (!s) return null;
  if (s === "local") return isLocalHost(loc) ? {} : null;
  if (s === true) return {};
  return typeof s === "object" ? s : null;
}

/** InitOptions without `devtools`, and the devtools setting. */
export function splitConfig(c: PageConfig): { init: InitOptions; devtools: DevtoolsSetting | undefined } {
  const { devtools, ...init } = c;
  return { init, devtools };
}

/** Runs fn once document.body exists. */
export function whenBody(doc: Document, fn: () => void): void {
  if (doc.body) fn();
  else doc.addEventListener("DOMContentLoaded", () => fn(), { once: true });
}
