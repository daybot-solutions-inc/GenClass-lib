// Automatic React state discovery (InitOptions.autoState.react): every React ≥ 16.8 renderer (development and
// production builds) reports to `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` if it exists when react-dom is evaluated.
//
// - The hook: installed when absent (a minimal DevTools hook, as react-scan/bippy do); when a real one exists (the
//   React DevTools extension, React Refresh) its inject/onCommitFiberRoot/onCommitFiberUnmount are chained, never
//   replaced, and called first. GenClass must be on the page before react-dom (the one line, first).
// - Writers: a renderer that injects before it renders gets a dispatcher tap. Its hooks dispatcher property
//   (`ReactSharedInternals.H` in React 19, `ReactCurrentDispatcher.current` before) becomes an accessor that hands
//   React an object inheriting from each dispatcher whose own useState/useReducer return a wrapped setter: stable per hook (the wrapper is
//   created once per setter and React hands the same setter to every render), it calls the real setter unchanged and
//   first notes the ambient op. Class components: the instance's `updater` is wrapped the same way. A commit that
//   happens in a later task (React's scheduler) is thereby still attributed to the op that called setState (a fetch
//   callback, a timer, a user handler). Writes without a captured writer use the op ambient at commit time.
// - Commits: onCommitFiberRoot walks only fibers that re-rendered (a child whose `child` pointer is unchanged was not
//   re-rendered, as in React DevTools), skips newly mounted subtrees (a component's store is created on its first
//   state change, with the previous values as its initial state) and stops at a per-commit time budget (1 ms).
// - Stores: one observed-only store per component instance, named after the component (displayName or function
//   name, so minified in production builds), at most 3 instances per component type (`Name`, `Name_2`, `Name_3`) and
//   48 component stores in all. Fields: `Name.state0`, `Name.state1`, ... (useState/useReducer in hook order),
//   `Name.external0`, ... (useSyncExternalStore snapshots); a class component's state object is the store value.
// - Skipped: anonymous components, known framework internals (development names), values that are functions,
//   promises, React elements, DOM nodes, class instances or objects holding them (router caches, query clients).
// - Secrets: a hook whose string value equals what a password, card or one-time-code input holds (or a field named
//   like a secret) is redacted from then on; field names are redacted by the default redactor as usual.

import { isSensitiveField } from "../observe/dom-user.js";
import { REDACTED, isPlainObject } from "../util.js";
import type { Captured, DiscoveryHost, ObservedStore, WalkStats } from "./types.js";
import { storeBase } from "./types.js";

const HOOK_KEY = "__REACT_DEVTOOLS_GLOBAL_HOOK__";
/** Per-commit time budget (ms): the walk stops there and the rest of this commit is not looked at. */
export const COMMIT_BUDGET_MS = 1;
/** Fibers visited per commit at most (a second bound next to the time budget). */
const MAX_VISIT = 20_000;
const MAX_INSTANCES = 3;
const MAX_COMPONENT_STORES = 48;
const MAX_HOOK_FIELDS = 16;
const SAMPLES = 1024;
const MAX_ERRORS = 5;

// Fiber tags (stable since React 16.8).
const FUNCTION = 0;
const CLASS = 1;
const INDETERMINATE = 2;
const FORWARD_REF = 11;
const SIMPLE_MEMO = 15;

/** Framework components whose state is not app state (their development names; production names are minified). */
const INTERNAL = new Set([
  "AppRouter",
  "Router",
  "ServerRoot",
  "Root",
  "HotReload",
  "ReactDevOverlay",
  "DevOverlay",
  "AppDevOverlay",
  "AppDevOverlayErrorBoundary",
  "ErrorBoundary",
  "ErrorBoundaryHandler",
  "GlobalError",
  "LayoutRouter",
  "InnerLayoutRouter",
  "OuterLayoutRouter",
  "RenderFromTemplateContext",
  "ScrollAndFocusHandler",
  "InnerScrollAndFocusHandler",
  "RedirectBoundary",
  "RedirectErrorBoundary",
  "NotFoundBoundary",
  "NotFoundErrorBoundary",
  "HTTPAccessFallbackBoundary",
  "HTTPAccessFallbackErrorBoundary",
  "DevRootHTTPAccessFallbackBoundary",
  "LoadingBoundary",
  "MetadataBoundary",
  "ViewportBoundary",
  "OutletBoundary",
  "HandleISRError",
  "AppRouterAnnouncer",
  "LinkComponent",
  "Link",
  "Image",
  "ImageElement",
  "Script",
  "Head",
  "RouterProvider",
  "DataRoutes",
  "RenderedRoute",
  "RenderErrorBoundary",
  "BrowserRouter",
  "HashRouter",
  "MemoryRouter",
  "StaticRouter",
  "Routes",
  "Suspense",
  "StrictMode",
  "Profiler",
  "Fragment",
]);

type AnyObj = Record<string, unknown>;

/** A bundler-minified identifier: 1–2 characters, or 3 with a digit, `$` or `_`. */
export function isMinified(name: string): boolean {
  return name.length <= 2 || (name.length === 3 && /[0-9$_]/.test(name));
}

/** Generic data attributes of UI kits (state, layout), not names. */
const GENERIC_DATA = /^data-(state|slot|side|align|orientation|disabled|highlighted|selected|active|open|placeholder|theme|size|variant|testid-skip|radix-.*|headlessui-.*|rk|reactroot|nextjs-.*|sentry-.*)$/;

/** camelCase of a label: "order-chip" -> "orderChip", "Add to order" -> "addToOrder". */
function camel(s: string): string {
  const ws = s.trim().split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 4);
  return ws.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join("");
}

/** What a component instance renders, as a name: its first element's id, data-testid, first data-* attribute, aria-label or name. */
export function labelOf(el: Element): string {
  const id = el.getAttribute("id");
  if (id && !/\d{3,}|^:r|^«|^_r_/i.test(id)) return camel(id); // not React's useId ids
  const t = el.getAttribute("data-testid") ?? el.getAttribute("data-test");
  if (t) return camel(t);
  const attrs = el.attributes;
  for (let i = 0; attrs && i < attrs.length && i < 24; i++) {
    const n = attrs[i].name;
    if (n.startsWith("data-") && !GENERIC_DATA.test(n)) return camel(n.slice(5));
  }
  const a = el.getAttribute("aria-label") ?? el.getAttribute("name");
  if (a && a.length <= 40) return camel(a);
  return "";
}

const HOST_COMPONENT = 5;

/** The label of the first element a fiber renders (depth-first, bounded). */
function hostLabel(f: Fiber): string {
  try {
    let c: Fiber | null = f.child;
    for (let n = 0; c && n < 48; n++) {
      if (c.tag === HOST_COMPONENT) {
        const el = c.stateNode as Element | null;
        if (el && typeof el.getAttribute === "function") return labelOf(el);
        return "";
      }
      c = c.child ?? c.sibling;
    }
  } catch {
    /* no label */
  }
  return "";
}

interface Fiber {
  tag: number;
  type: unknown;
  elementType?: unknown;
  stateNode: unknown;
  memoizedState: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
}

interface Hook {
  memoizedState: unknown;
  queue: unknown;
  next: Hook | null;
}

interface TypeRec {
  base: string;
  /** The name looks minified (production build): stores are named after the instance's first element instead. */
  minified: boolean;
  /** Store of each instance slot (kept when its instance unmounts, so a remount writes to the same store). */
  stores: (ObservedStore | null)[];
  owners: (InstRec | null)[];
}

interface InstRec {
  type: TypeRec;
  slot: number;
  /** Field name -> value as last recorded. */
  values: AnyObj;
  /** Field names never recorded (a value that is not app data: element, promise, class instance, ...). */
  rejected: Set<string>;
  /** Field names redacted (they once held what a password/card input holds). */
  secret: Set<string>;
  cls: boolean;
  /** A change was recorded (values hold what the store holds). */
  started: boolean;
}

export interface ReactDiscovery {
  uninstall(): void;
  stats(): WalkStats & { renderers: number; tapped: number; components: number };
}

/** Install the DevTools hook (or chain onto the page's). Null when there is nothing to do (no window). */
export function installReactDiscovery(host: DiscoveryHost): ReactDiscovery | null {
  const g = host.global as AnyObj;
  if (typeof g.document !== "object" || !g.document) return null;
  let active = true;
  const stats: WalkStats = { commits: 0, overBudget: 0, visited: 0, samples: [], errors: 0 };
  let renderers = 0;
  let tapped = 0;
  let componentStores = 0;
  const typeRecs = new WeakMap<object, TypeRec>();
  const insts = new WeakMap<object, InstRec>();
  /** setState / class updater -> the writer captured when the app called it (consumed by the next commit). */
  const pending = new WeakMap<object, Captured>();
  const doc = g.document as Document;

  const fail = (where: string, e: unknown) => {
    stats.errors++;
    if (stats.errors === 1 || stats.errors === MAX_ERRORS) host.log(`React state discovery: ${where} failed${stats.errors >= MAX_ERRORS ? "; turned off" : ""}`, e);
    if (stats.errors >= MAX_ERRORS) active = false;
  };

  // ------------------------------------------------------------------------------------------ dispatcher tap

  const dispatchWraps = new WeakMap<object, unknown>();
  const wrappedDispatchers = new WeakMap<object, object>();
  /** wrapped dispatcher -> React's own */
  const unwrapped = new WeakMap<object, unknown>();
  const isWrapped = new WeakSet<object>();
  const tappedRefs = new WeakSet<object>();

  const wrapSetter = (d: (...a: unknown[]) => unknown): unknown => {
    let w = dispatchWraps.get(d);
    if (w === undefined) {
      w = function (this: unknown, ...a: unknown[]) {
        if (active) {
          try {
            pending.set(d, host.capture());
          } catch {
            /* never break a setState */
          }
        }
        return d.apply(this, a);
      };
      dispatchWraps.set(d, w);
    }
    return w;
  };

  const tapResult = (r: unknown): unknown => {
    try {
      if (Array.isArray(r) && typeof r[1] === "function") r[1] = wrapSetter(r[1] as (...a: unknown[]) => unknown);
    } catch {
      /* the result goes back to React unchanged */
    }
    return r;
  };

  const wrapDispatcher = (d: unknown): unknown => {
    if (!d || typeof d !== "object" || isWrapped.has(d)) return d;
    const cached = wrappedDispatchers.get(d);
    if (cached) return cached;
    const o = d as AnyObj;
    if (typeof o.useState !== "function" || typeof o.useReducer !== "function") {
      wrappedDispatchers.set(d, d);
      return d;
    }
    // inherits every other hook from React's dispatcher (also when it is React DevTools' inspection Proxy, whose
    // traps then still see each lookup); only useState/useReducer are own properties
    const w = Object.create(o) as AnyObj;
    const us = o.useState as (...a: unknown[]) => unknown;
    const ur = o.useReducer as (...a: unknown[]) => unknown;
    w.useState = function (this: unknown, ...a: unknown[]) {
      return tapResult(us.apply(this, a));
    };
    w.useReducer = function (this: unknown, ...a: unknown[]) {
      return tapResult(ur.apply(this, a));
    };
    isWrapped.add(w);
    wrappedDispatchers.set(d, w);
    unwrapped.set(w, d);
    return w;
  };

  /** React 19: `H`; 16.8–18: `current`. Only before the renderer's first render (else setter identities would change). */
  const tapDispatcherRef = (ref: unknown): void => {
    if (!ref || typeof ref !== "object" || tappedRefs.has(ref)) return;
    tappedRefs.add(ref);
    const key = "H" in ref ? "H" : "current" in ref ? "current" : null;
    if (!key) return;
    const desc = Object.getOwnPropertyDescriptor(ref, key);
    if (!desc || !desc.configurable || !("value" in desc)) return;
    let cur: unknown = desc.value;
    let curW: unknown = wrapDispatcher(cur);
    Object.defineProperty(ref, key, {
      configurable: true,
      enumerable: desc.enumerable ?? true,
      // the wrapped copy even after uninstall: its setters stay the same functions (they pass through when inactive)
      get() {
        return curW;
      },
      set(d: unknown) {
        const o = d && typeof d === "object" && unwrapped.has(d) ? unwrapped.get(d) : d;
        if (o === cur) return;
        cur = o;
        try {
          curW = wrapDispatcher(o);
        } catch {
          curW = o;
        }
      },
    });
    tapped++;
  };

  const tapClassInstance = (inst: unknown): void => {
    if (!inst || typeof inst !== "object") return;
    const i = inst as AnyObj;
    const u = i.updater as AnyObj | undefined;
    if (!u || typeof u !== "object" || isWrapped.has(u) || typeof u.enqueueSetState !== "function") return;
    const note = () => {
      if (!active) return;
      try {
        pending.set(i, host.capture());
      } catch {
        /* never break a setState */
      }
    };
    const w: AnyObj = Object.assign(Object.create(Object.getPrototypeOf(u) as object) as object, u);
    for (const k of ["enqueueSetState", "enqueueReplaceState"]) {
      const f = u[k];
      if (typeof f === "function")
        w[k] = function (this: unknown, ...a: unknown[]) {
          note();
          return (f as (...x: unknown[]) => unknown).apply(u, a);
        };
    }
    isWrapped.add(w);
    try {
      i.updater = w;
    } catch {
      /* a frozen instance: commit-time attribution */
    }
  };

  // ----------------------------------------------------------------------------------------------- naming

  const nameOf = (f: Fiber): string => {
    const t = f.type as AnyObj | ((...a: unknown[]) => unknown) | null;
    let n: unknown;
    if (f.tag === FORWARD_REF) {
      const o = t as AnyObj | null;
      const r = o?.render as AnyObj | undefined;
      n = o?.displayName || r?.displayName || r?.name;
    } else if (f.tag === SIMPLE_MEMO) {
      const e = f.elementType as AnyObj | null;
      n = e?.displayName || (t as AnyObj | null)?.displayName || (t as AnyObj | null)?.name;
    } else n = (t as AnyObj | null)?.displayName || (t as AnyObj | null)?.name;
    return typeof n === "string" ? n : "";
  };

  const typeRecOf = (f: Fiber): TypeRec | null => {
    const key = (f.tag === SIMPLE_MEMO ? (f.elementType as object) : null) ?? (f.type as object);
    if (!key || (typeof key !== "object" && typeof key !== "function")) return null;
    let tr = typeRecs.get(key);
    if (tr !== undefined) return tr.base ? tr : null;
    const name = nameOf(f);
    // error boundaries hold errors, not app data (Next.js and React Router boundaries are classes like this)
    const t = f.type as AnyObj | null;
    const boundary = f.tag === CLASS && !!t && (typeof t.getDerivedStateFromError === "function" || typeof (t.prototype as AnyObj | undefined)?.componentDidCatch === "function");
    const base = boundary || INTERNAL.has(name) || name === "default" || name === "Anonymous" ? "" : storeBase(name);
    tr = { base, minified: isMinified(base), stores: [], owners: [] };
    typeRecs.set(key, tr);
    return base ? tr : null;
  };

  // ---------------------------------------------------------------------------------------- value filters

  /** App data: primitives, arrays, plain objects, dates, maps, sets, without elements/promises/nodes/instances inside. */
  const isData = (v: unknown, depth = 0, budget = { n: 64 }): boolean => {
    if (v === null || typeof v !== "object") return typeof v !== "function" && typeof v !== "symbol";
    if (--budget.n < 0) return true;
    const o = v as AnyObj;
    if ("$$typeof" in o || typeof (o as { then?: unknown }).then === "function" || typeof (o as { nodeType?: unknown }).nodeType === "number") return false;
    if (Array.isArray(v)) {
      if (depth >= 2) return true;
      for (let i = 0; i < v.length && i < 16; i++) if (!isData(v[i], depth + 1, budget)) return false;
      return true;
    }
    if (v instanceof Date || v instanceof Map || v instanceof Set) return true;
    if (!isPlainObject(v)) return false;
    if (depth >= 2) return true;
    let k = 0;
    for (const key in o) {
      if (++k > 64) break;
      const x = o[key];
      if (typeof x === "function") continue; // callbacks kept in state objects are dropped by flatten as "f"
      if (!isData(x, depth + 1, budget)) return false;
    }
    return true;
  };

  /** Values of password / card / one-time-code inputs on the page right now (lazily, once per commit). */
  let secretsMemo: Set<string> | null = null;
  const sensitiveCache = new WeakMap<object, boolean>();
  const secrets = (): Set<string> => {
    if (secretsMemo) return secretsMemo;
    const out = new Set<string>();
    try {
      const els = doc.querySelectorAll?.("input, textarea");
      for (let i = 0; els && i < els.length && i < 300; i++) {
        const el = els[i] as HTMLInputElement;
        const v = el.value;
        if (typeof v !== "string" || !v) continue;
        let s = sensitiveCache.get(el);
        if (s === undefined) {
          s = isSensitiveField(el);
          sensitiveCache.set(el, s);
        }
        if (s) out.add(v);
      }
    } catch {
      /* no secrets known */
    }
    secretsMemo = out;
    return out;
  };

  /** The value as recorded: redacted when it holds (or once held) what a sensitive input holds. */
  const recordable = (rec: InstRec, field: string, v: unknown): unknown => {
    if (rec.secret.has(field)) return REDACTED;
    if (typeof v === "string") {
      if (v && secrets().has(v)) {
        rec.secret.add(field);
        return REDACTED;
      }
      return v;
    }
    if (isPlainObject(v)) {
      let out: AnyObj | null = null;
      let k = 0;
      for (const key in v) {
        if (++k > 64) break;
        const x = v[key];
        if (typeof x === "string" && x && secrets().has(x)) (out ??= { ...v })[key] = REDACTED;
      }
      return out ?? v;
    }
    return v;
  };

  // ----------------------------------------------------------------------------------------------- hooks

  const isStateHook = (h: Hook): boolean => {
    const q = h.queue as AnyObj | null;
    return !!q && typeof q === "object" && typeof q.dispatch === "function" && typeof q.lastRenderedReducer === "function";
  };
  const isExternalHook = (h: Hook): boolean => {
    const q = h.queue as AnyObj | null;
    return !!q && typeof q === "object" && typeof q.getSnapshot === "function" && !("dispatch" in q);
  };
  /** useTransition's pending flag is a state hook followed by a hook holding the start function. */
  const isTransitionFlag = (h: Hook): boolean => {
    const n = h.next;
    return !!n && n.queue === null && typeof n.memoizedState === "function" && typeof h.memoizedState === "boolean";
  };

  /** Field name -> value for a function component's hook list. */
  const hookFields = (first: unknown): AnyObj => {
    const out: AnyObj = {};
    let s = 0;
    let e = 0;
    let n = 0;
    for (let h = first as Hook | null; h && typeof h === "object" && n < 128; h = h.next, n++) {
      if (isStateHook(h)) {
        const name = `state${s++}`;
        if (isTransitionFlag(h)) continue;
        if (s > MAX_HOOK_FIELDS) continue;
        out[name] = h.memoizedState;
      } else if (isExternalHook(h)) {
        const name = `external${e++}`;
        if (e > MAX_HOOK_FIELDS) continue;
        out[name] = h.memoizedState;
      }
    }
    return out;
  };

  // ----------------------------------------------------------------------------------------------- stores

  const instOf = (f: Fiber, p: Fiber, cls: boolean): InstRec | null => {
    const key = cls ? (f.stateNode as object | null) : f;
    if (!key || typeof key !== "object") return null;
    let rec = insts.get(key) ?? (cls ? undefined : insts.get(p));
    if (rec) {
      if (!cls && !insts.has(f)) insts.set(f, rec);
      return rec;
    }
    const tr = typeRecOf(f);
    if (!tr) return null;
    let slot = tr.owners.indexOf(null);
    if (slot < 0) {
      if (tr.owners.length >= MAX_INSTANCES) return null;
      slot = tr.owners.length;
      tr.owners.push(null);
      tr.stores.push(null);
    }
    rec = { type: tr, slot, values: {}, rejected: new Set(), secret: new Set(), cls, started: false };
    tr.owners[slot] = rec;
    insts.set(key, rec);
    if (!cls) insts.set(p, rec);
    else tapClassInstance(f.stateNode);
    return rec;
  };

  const storeOf = (rec: InstRec, initial: AnyObj, f: Fiber): ObservedStore | null => {
    const tr = rec.type;
    const have = tr.stores[rec.slot];
    if (have) return have;
    if (componentStores >= MAX_COMPONENT_STORES) return null;
    // a minified name ("e", "Xt") says nothing: name the store after what the instance renders (data-*, id, aria-label)
    let b = tr.base;
    if (tr.minified) {
      const l = storeBase(hostLabel(f));
      if (l) b = l;
    }
    // instance slots: Name, Name_2, Name_3 (a second component type with the same name is deduplicated by the host)
    const base = rec.slot > 0 ? `${b}_${rec.slot + 1}` : b;
    const st = host.observed(base, initial, "react");
    if (!st) return null;
    componentStores++;
    tr.stores[rec.slot] = st;
    return st;
  };

  const filtered = (rec: InstRec, raw: AnyObj): AnyObj => {
    const out: AnyObj = {};
    for (const k in raw) {
      if (rec.rejected.has(k)) continue;
      const v = raw[k];
      if (!isData(v)) {
        rec.rejected.add(k);
        continue;
      }
      out[k] = recordable(rec, k, v);
    }
    return out;
  };

  interface Pending {
    rec: InstRec;
    fiber: Fiber;
    prev: AnyObj;
    next: AnyObj;
    /** field -> captured writer */
    writers: Map<string, Captured | null>;
  }

  const visit = (f: Fiber, p: Fiber, out: Pending[]): void => {
    if (f.memoizedState === p.memoizedState) return;
    const tag = f.tag;
    if (tag === CLASS) {
      const s = f.memoizedState;
      if (!isPlainObject(s)) return;
      const rec = instOf(f, p, true);
      if (!rec) return;
      const w = pending.get(f.stateNode as object) ?? null;
      if (w) pending.delete(f.stateNode as object);
      const prev = isPlainObject(p.memoizedState) ? (p.memoizedState as AnyObj) : {};
      const next = s as AnyObj;
      const writers = new Map<string, Captured | null>();
      for (const k in next) if (!Object.is(next[k], prev[k])) writers.set(k, w);
      for (const k in prev) if (!(k in next)) writers.set(k, w);
      if (writers.size) out.push({ rec, fiber: f, prev, next, writers });
      return;
    }
    if (tag !== FUNCTION && tag !== FORWARD_REF && tag !== SIMPLE_MEMO && tag !== INDETERMINATE) return;
    // compare the two hook lists in step; allocate only when a state hook changed
    let writers: Map<string, Captured | null> | null = null;
    let s = 0;
    let e = 0;
    let n = 0;
    let hp = p.memoizedState as Hook | null;
    for (let h = f.memoizedState as Hook | null; h && typeof h === "object" && n < 128; h = h.next, hp = hp && typeof hp === "object" ? hp.next : null, n++) {
      let name: string;
      if (isStateHook(h)) {
        name = `state${s++}`;
        if (s > MAX_HOOK_FIELDS || isTransitionFlag(h)) continue;
      } else if (isExternalHook(h)) {
        name = `external${e++}`;
        if (e > MAX_HOOK_FIELDS) continue;
      } else continue;
      if (hp && Object.is(h.memoizedState, hp.memoizedState)) continue;
      let w: Captured | null = null;
      if (name.charCodeAt(0) === 115 /* s */) {
        const setter = (h.queue as AnyObj).dispatch as object;
        w = pending.get(setter) ?? null;
        if (w) pending.delete(setter);
      }
      (writers ??= new Map()).set(name, w);
    }
    if (!writers) return;
    const rec = instOf(f, p, false);
    if (rec) out.push({ rec, fiber: f, prev: hookFields(p.memoizedState), next: hookFields(f.memoizedState), writers });
  };

  const record = (list: Pending[]): void => {
    let fallback: Captured | null | undefined;
    for (const u of list) {
      const rec = u.rec;
      const prevF = filtered(rec, u.prev);
      const nextF = filtered(rec, u.next);
      // first change of this instance: its previous values are where the store starts (or what a remount overwrites)
      if (!rec.started) {
        rec.started = true;
        rec.values = prevF;
      }
      const st = storeOf(rec, rec.values, u.fiber);
      if (!st) continue;
      // one write per writer, in the order the app made them
      const groups = new Map<Captured | null, string[]>();
      for (const [k, w] of u.writers) {
        // a value that is not app data (any more): the field keeps its last data value
        if (rec.rejected.has(k) || (!(k in nextF) && !(k in rec.values))) continue;
        const ws = w ?? (fallback === undefined ? (fallback = host.capture()) : fallback);
        const keys = groups.get(ws);
        if (keys) keys.push(k);
        else groups.set(ws, [k]);
      }
      const ordered = [...groups.entries()].sort((a, b) => (a[0]?.seq ?? 0) - (b[0]?.seq ?? 0));
      let cur: AnyObj = { ...rec.values };
      // fields that changed without a report (a commit skipped at the budget): brought up to date by the first write
      for (const k in nextF) if (!u.writers.has(k) && !Object.is(cur[k], nextF[k])) cur[k] = nextF[k];
      for (const [w, keys] of ordered) {
        cur = { ...cur };
        for (const k of keys) {
          if (k in nextF) cur[k] = nextF[k];
          else delete cur[k];
        }
        rec.values = cur;
        st.write(cur, w);
      }
    }
  };

  // ------------------------------------------------------------------------------------------------ walk

  const now = () => host.clock.now();

  const onCommit = (root: unknown): void => {
    if (!active || !root || typeof root !== "object") return;
    const t0 = now();
    let visited = 0;
    let over = false;
    secretsMemo = null;
    const out: Pending[] = [];
    try {
      const cur = (root as AnyObj).current as Fiber | null;
      const prev = cur?.alternate ?? null;
      if (!cur || !prev) return;
      const stack: Fiber[] = [cur, prev];
      while (stack.length) {
        const p = stack.pop()!;
        const f = stack.pop()!;
        if (++visited > MAX_VISIT || ((visited & 31) === 0 && now() - t0 > COMMIT_BUDGET_MS)) {
          over = true;
          break;
        }
        visit(f, p, out);
        if (f.child !== p.child) {
          // re-rendered children: each one with an alternate is an update; one without was mounted now (skipped)
          for (let c = f.child; c; c = c.sibling) if (c.alternate) stack.push(c, c.alternate);
        }
      }
      if (out.length) record(out);
    } catch (e) {
      fail("a commit walk", e);
    } finally {
      stats.commits++;
      stats.visited += visited;
      if (over) stats.overBudget++;
      const d = now() - t0;
      stats.samples.push(d);
      if (stats.samples.length > SAMPLES) stats.samples.splice(0, stats.samples.length - SAMPLES);
      secretsMemo = null;
    }
  };

  const onUnmount = (fiber: unknown): void => {
    if (!fiber || typeof fiber !== "object") return;
    try {
      const f = fiber as Fiber;
      const rec = insts.get(f) ?? (f.alternate ? insts.get(f.alternate) : undefined) ?? (f.tag === CLASS && f.stateNode && typeof f.stateNode === "object" ? insts.get(f.stateNode) : undefined);
      if (!rec) return;
      if (rec.type.owners[rec.slot] === rec) rec.type.owners[rec.slot] = null;
      insts.delete(f);
      if (f.alternate) insts.delete(f.alternate);
    } catch (e) {
      fail("an unmount", e);
    }
  };

  const onInject = (renderer: unknown, early: boolean): void => {
    renderers++;
    if (!early || !renderer || typeof renderer !== "object") return;
    try {
      tapDispatcherRef((renderer as AnyObj).currentDispatcherRef);
    } catch (e) {
      fail("tapping a renderer", e);
    }
  };

  // ----------------------------------------------------------------------------------------- the hook itself

  const existing = g[HOOK_KEY] as AnyObj | undefined;
  const restore: (() => void)[] = [];
  if (existing && typeof existing === "object") {
    if (existing.isDisabled) return null;
    // chain onto the page's hook (React DevTools, React Refresh): theirs run first, unchanged
    const wrap = (k: string, ours: (...a: unknown[]) => void, after = true) => {
      const orig = existing[k];
      const fn = function (this: unknown, ...a: unknown[]) {
        let r: unknown;
        if (!after) safeCall(ours, a);
        if (typeof orig === "function") r = (orig as (...x: unknown[]) => unknown).apply(this, a);
        if (after) safeCall(ours, a);
        return r;
      };
      try {
        existing[k] = fn;
        restore.push(() => {
          if (existing[k] === fn) existing[k] = orig;
        });
      } catch {
        /* a frozen hook: not chained */
      }
    };
    const safeCall = (fn: (...a: unknown[]) => void, a: unknown[]) => {
      try {
        fn(...a);
      } catch (e) {
        fail("a hook callback", e);
      }
    };
    // renderers that injected before us rendered already: observed, but their setters are not tapped
    try {
      const rs = existing.renderers as Map<unknown, unknown> | undefined;
      if (rs && typeof rs.forEach === "function") rs.forEach((r) => onInject(r, false));
    } catch {
      /* ignore */
    }
    const origInject = existing.inject;
    const inject = function (this: unknown, renderer: unknown) {
      safeCall(() => onInject(renderer, true), []);
      return typeof origInject === "function" ? (origInject as (r: unknown) => unknown).call(this, renderer) : 0;
    };
    try {
      existing.inject = inject;
      restore.push(() => {
        if (existing.inject === inject) existing.inject = origInject;
      });
    } catch {
      /* ignore */
    }
    wrap("onCommitFiberRoot", (_id, root) => onCommit(root));
    wrap("onCommitFiberUnmount", (_id, fiber) => onUnmount(fiber));
  } else if (existing === undefined) {
    let nextId = 0;
    const roots = new Map<number, Set<unknown>>();
    const hook = {
      renderers: new Map<number, unknown>(),
      supportsFiber: true,
      _genclass: true,
      inject(renderer: unknown): number {
        const id = ++nextId;
        hook.renderers.set(id, renderer);
        try {
          onInject(renderer, true);
        } catch {
          /* never break react-dom's evaluation */
        }
        return id;
      },
      onCommitFiberRoot(id: number, root: unknown): void {
        try {
          let set = roots.get(id);
          if (!set) roots.set(id, (set = new Set()));
          if (root && typeof root === "object" && (root as AnyObj).current) set.add(root);
          onCommit(root);
        } catch {
          /* never break a commit */
        }
      },
      onCommitFiberUnmount(_id: number, fiber: unknown): void {
        onUnmount(fiber);
      },
      onPostCommitFiberRoot(): void {},
      onScheduleFiberRoot(): void {},
      setStrictMode(): void {},
      checkDCE(): void {},
      getFiberRoots(id: number): Set<unknown> {
        let set = roots.get(id);
        if (!set) roots.set(id, (set = new Set()));
        return set;
      },
    };
    try {
      Object.defineProperty(g, HOOK_KEY, { configurable: true, enumerable: false, writable: true, value: hook });
    } catch {
      return null;
    }
    restore.push(() => {
      // React keeps its reference to the hook: it stays, inert
    });
  } else return null;

  return {
    uninstall() {
      active = false;
      for (const r of restore) {
        try {
          r();
        } catch {
          /* ignore */
        }
      }
    },
    stats() {
      return { ...stats, samples: stats.samples.slice(), renderers, tapped, components: componentStores };
    },
  };
}
