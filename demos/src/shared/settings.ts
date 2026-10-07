// Page settings from the URL and local storage. The demo's mode switch uses its own `?mode=` parameter;
// `?genclass=` is the runtime's own kill switch and is left to the runtime.
import { CALM, mergeChaos, type Chaos } from "./chaos.ts";
import type { DemoId, GcMode, TrialKind } from "./types.ts";

const params = new URLSearchParams(location.search);

function store(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
  return value ?? null;
}

/** Site root (the directory holding index.html and sw.js), from <meta name="gc-root">. */
export function siteRoot(): URL {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="gc-root"]');
  return new URL(meta?.content || "./", location.href);
}

export function getMode(): GcMode {
  const p = params.get("mode");
  if (p === "off" || p === "guard" || p === "heal") return p;
  const s = store("gc-demo-mode");
  if (s === "off" || s === "guard" || s === "heal") return s;
  return "guard";
}

export function setMode(mode: GcMode): void {
  store("gc-demo-mode", mode);
  const url = new URL(location.href);
  url.searchParams.delete("mode");
  location.assign(url.href);
}

/**
 * Model directory: `?model=<url>` > VITE_GENCLASS_MODEL_URL > `<site>/genclass-model/`.
 * `cdn` means "let the runtime use its default CDN".
 */
export function modelBaseUrl(root: URL): string | undefined {
  const raw = params.get("model") ?? (import.meta.env.VITE_GENCLASS_MODEL_URL as string | undefined) ?? "genclass-model/";
  if (raw === "cdn" || raw === "") return undefined;
  return new URL(raw.endsWith("/") ? raw : raw + "/", root).href;
}

export interface TrialParams {
  seed: number;
  kind: TrialKind;
  mode: GcMode;
  run: string;
}

export function trialParams(): TrialParams | null {
  if (params.get("embed") !== "trial") return null;
  const kind = params.get("kind") === "clean" ? "clean" : "chaos";
  const m = params.get("mode");
  return {
    seed: Number(params.get("seed") ?? 1) >>> 0,
    kind,
    mode: m === "off" || m === "heal" ? m : "guard",
    run: params.get("run") ?? Math.random().toString(36).slice(2, 8),
  };
}

export function sessionId(demo: DemoId): string {
  const key = `gc-demo-sid-${demo}`;
  let sid: string | null = null;
  try {
    sid = sessionStorage.getItem(key);
    if (!sid) {
      sid = `live-${demo}-${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem(key, sid);
    }
  } catch {
    sid = `live-${demo}-${Math.random().toString(36).slice(2, 10)}`;
  }
  return sid;
}

export function loadChaos(demo: DemoId): Chaos {
  const raw = store(`gc-demo-chaos-${demo}`);
  if (!raw) return { ...CALM, routes: {} };
  try {
    return mergeChaos({ ...CALM, routes: {} }, JSON.parse(raw) as Partial<Chaos>);
  } catch {
    return { ...CALM, routes: {} };
  }
}

export function saveChaos(demo: DemoId, c: Chaos): void {
  store(`gc-demo-chaos-${demo}`, JSON.stringify(c));
}

export function getTheme(): "light" | "dark" | null {
  const t = store("gc-demo-theme");
  return t === "light" || t === "dark" ? t : null;
}

export function setTheme(t: "light" | "dark" | null): void {
  store("gc-demo-theme", t);
}

export const urlParams = params;
