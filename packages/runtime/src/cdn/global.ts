// Script-tag build (dist/genclass.global.js, dist/genclass.global.min.js). Owner: INSTALL.
//
//   <script src="https://cdn.jsdelivr.net/npm/@genclass/runtime/dist/genclass.global.min.js" data-mode="guard" data-devtools></script>
//
// Runs GenClass.init() as soon as the tag executes (put it first in <head> so it sees the page's first requests),
// with options from the tag's data attributes, <meta name="genclass"> and window.GENCLASS_CONFIG (src/cdn/config.ts),
// and exposes window.GenClass: { init, runtime, destroy, devtools, createRuntime, version }. `data-manual` only
// exposes window.GenClass (call GenClass.init(options) yourself; the page configuration still applies underneath); `data-devtools` mounts the overlay (bare: always,
// "local": only on localhost); `data-base` is the URL of the package's dist/ directory when you self-host the file.
//
// Everything heavy loads on demand from the same place as this file (on jsDelivr/unpkg: the exact version of this
// file): the model worker (dist/cdn/worker.js, started from a same-origin Blob URL because browsers refuse
// cross-origin worker URLs), onnxruntime-web (bundled in dist/cdn/; its wasm comes from the jsDelivr
// onnxruntime-web package or `data-ort`), and the devtools overlay (dist/devtools/index.js).

import { GenClass, createRuntime, GenClassUnavailableError } from "../index.js";
import type { DevtoolsHandle, DevtoolsOptions } from "../devtools/index.js";
import type { InitOptions, ModelOptions, Runtime } from "../types.js";
import { devtoolsOptions, fromDataset, isKilled, mergeConfig, readMetaConfig, readWindowConfig, splitConfig, whenBody, type PageConfig } from "./config.js";

declare const __GENCLASS_VERSION__: string;
const VERSION: string = typeof __GENCLASS_VERSION__ === "string" ? __GENCLASS_VERSION__ : "0.0.0";

const CDN_RE = /^(https?:\/\/(?:cdn\.jsdelivr\.net|fastly\.jsdelivr\.net|gcore\.jsdelivr\.net|testingcf\.jsdelivr\.net)\/npm\/@genclass\/runtime|https?:\/\/unpkg\.com\/@genclass\/runtime)(?:@[^/?#]*)?(?:[/?#].*)?$/;

/**
 * The package's dist/ directory for a script URL. On jsDelivr/unpkg the version is pinned to this file's own version
 * (so `.../npm/@genclass/runtime` or `@latest` never mixes files of two releases); elsewhere the file's directory.
 */
export function assetBase(src: string | null | undefined): string {
  const fallback = `https://cdn.jsdelivr.net/npm/@genclass/runtime@${VERSION}/dist/`;
  if (!src) return fallback;
  const m = CDN_RE.exec(src);
  if (m) return `${m[1]}@${VERSION}/dist/`;
  try {
    return new URL("./", src).href;
  } catch {
    return fallback;
  }
}

function findScript(): HTMLScriptElement | null {
  const d = document;
  const cs = d.currentScript as HTMLScriptElement | null;
  if (cs && cs.tagName === "SCRIPT") return cs;
  // Loaded as a module, or injected and run later: find our tag.
  const all = d.querySelectorAll<HTMLScriptElement>("script[src]");
  for (let i = all.length - 1; i >= 0; i--) {
    if (/genclass[^/]*\.global(\.min)?\.js|\/@genclass\/runtime(@[^/]*)?\/?($|[?#])/.test(all[i].src)) return all[i];
  }
  return null;
}

/** A module worker started from a same-origin Blob URL that imports the CDN worker module. */
function blobModuleWorker(workerUrl: string): Worker | null {
  if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  const blobUrl = URL.createObjectURL(new Blob([`import ${JSON.stringify(workerUrl)};\n`], { type: "text/javascript" }));
  let w: Worker;
  try {
    w = new Worker(blobUrl, { type: "module", name: "genclass-model" });
  } catch (e) {
    URL.revokeObjectURL(blobUrl);
    throw e; // the host falls back to running the model inline
  }
  const revoke = () => URL.revokeObjectURL(blobUrl);
  w.addEventListener("message", revoke, { once: true });
  w.addEventListener("error", revoke, { once: true });
  return w;
}

export interface GenClassGlobal {
  readonly version: string;
  /** GenClass.init() (idempotent) with the CDN model worker; options go over the page's configuration; also takes `devtools`. */
  init(options?: PageConfig): Runtime;
  readonly runtime: Runtime | null;
  /** Unmount the overlay, uninstall observers, terminate the model worker. */
  destroy(): void;
  /** Load and mount the devtools overlay (initialises GenClass first if needed). */
  devtools(options?: DevtoolsOptions): Promise<DevtoolsHandle | null>;
  createRuntime: typeof createRuntime;
  GenClassUnavailableError: typeof GenClassUnavailableError;
  /** The dist/ directory the worker, onnxruntime-web and devtools load from. */
  readonly base: string;
}

function install(): void {
  const w = window as unknown as { GenClass?: Partial<GenClassGlobal> & { __genclassGlobal?: boolean } };
  if (w.GenClass && w.GenClass.__genclassGlobal) return; // the tag is on the page twice: keep the first
  const script = findScript();
  const ds = (script?.dataset ?? {}) as Record<string, string | undefined>;
  const base = (() => {
    const b = ds.base;
    if (b) {
      try {
        const abs = new URL(b, location.href).href;
        return abs.endsWith("/") ? abs : `${abs}/`;
      } catch {
        /* fall through */
      }
    }
    return assetBase(script?.src);
  })();
  const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ /* webpackIgnore: true */ base + path);

  const withCdnModel = (opts: InitOptions): InitOptions => {
    if (opts.decider !== undefined || opts.model === false) return opts;
    const user = (opts.model ?? {}) as ModelOptions & Record<string, unknown>;
    const model = {
      workerFactory: () => blobModuleWorker(`${base}cdn/worker.js`),
      ortLoader: (build: string) => load(build === "webgpu" ? "cdn/ort-webgpu.js" : "cdn/ort-wasm.js"),
      ...user,
    };
    return { ...opts, model: model as ModelOptions };
  };

  let overlay: Promise<DevtoolsHandle | null> | null = null;
  const mount = (rt: Runtime, options: DevtoolsOptions): Promise<DevtoolsHandle | null> => {
    if (overlay) return overlay;
    overlay = new Promise<void>((resolve) => whenBody(document, resolve))
      .then(() => load("devtools/index.js"))
      .then((m) => (m as { mountDevtools(rt: Runtime, o: DevtoolsOptions): DevtoolsHandle }).mountDevtools(rt, options))
      .catch((e: unknown) => {
        console.warn("[GenClass] Could not load the devtools overlay:", e);
        overlay = null;
        return null;
      });
    return overlay;
  };

  const api: GenClassGlobal & { __genclassGlobal: true } = {
    __genclassGlobal: true,
    version: VERSION,
    base,
    init(options: PageConfig = {}): Runtime {
      // the page's configuration (meta tag, the tag's data attributes, window.GENCLASS_CONFIG) is the default
      // automatic state discovery is on by default for the script tag (installed now, before the framework loads)
      const { init, devtools } = splitConfig(mergeConfig({ autoState: true }, readMetaConfig(document), fromDataset(ds), readWindowConfig(window), options));
      const rt = GenClass.init(withCdnModel(init));
      const dt = devtoolsOptions(devtools, location);
      if (dt && !isKilled(window)) void mount(rt, dt);
      return rt;
    },
    get runtime(): Runtime | null {
      return GenClass.runtime;
    },
    destroy(): void {
      const o = overlay;
      overlay = null;
      void o?.then((h) => h?.unmount());
      GenClass.destroy();
    },
    devtools(options: DevtoolsOptions = {}): Promise<DevtoolsHandle | null> {
      return mount(GenClass.runtime ?? api.init(), options);
    },
    createRuntime,
    GenClassUnavailableError,
  };
  w.GenClass = api;

  if (ds.manual !== undefined && ds.manual !== "false") return;
  try {
    api.init();
  } catch (e) {
    console.warn("[GenClass] Could not start:", e); // GenClass.init never throws; configuration code might
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") install();
