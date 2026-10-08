// DOM user-action observer (CONTRACT §3): capture-phase listeners record clicks, typing (one "typed" event per
// burst; password values never recorded), changes, submits and Enter/Escape as user ops. The user op is ambient
// for the rest of the event's task, so the app's handlers' writes are user writes (never held) and the requests
// they start have the user action as their cause.
//
// Shadow DOM (Lit, native custom elements): the element described is the first node of the event's composed path
// (the real target inside open shadow roots, not the retargeted host); names are looked up in the element's own
// tree (labels, aria-labelledby) and rendered text follows slots. Events that do not cross shadow boundaries
// (change, submit) are observed by listeners added to each open shadow root the first time a composed event
// (focusin, pointerdown, click, input, keydown) comes from inside it.

import type { UserAction } from "../types.js";
import { isSensitiveName, truncate } from "../util.js";

interface UserSink {
  /** Record synthetic (isTrusted false) events too (test harnesses). Default false. */
  untrusted?: boolean;
  user<T>(action: UserAction, handler?: () => T): T | undefined;
  /** Kind of the ambient op ("user", "task", "fetch", ...), or null when none. */
  ambientKind?(): string | null;
  /** Kind of the op whose code is running synchronously right now, or null. */
  runningKind?(): string | null;
}

const INTERACTIVE = "button,a,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],[role=switch],[contenteditable=''],[contenteditable=true]";
const TEXT_INPUTS = new Set(["text", "search", "email", "number", "tel", "url", "password", "date", "time", "datetime-local", "month", "week", ""]);

function clean(s: string | null | undefined, n = 40): string {
  return truncate((s ?? "").replace(/\s+/g, " ").trim(), n);
}

function roleOf(el: Element): string {
  const role = el.getAttribute("role");
  if (role) return role;
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "input") {
    const t = ((el as HTMLInputElement).type || "text").toLowerCase();
    if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
    if (t === "checkbox" || t === "radio" || t === "range" || t === "file" || t === "color") return t;
    return "input";
  }
  return tag;
}

/** Text nodes are 3, elements 1, shadow roots / fragments 11 (no DOM globals needed). */
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const FRAGMENT_NODE = 11;
const SKIP_TEXT = new Set(["script", "style", "template", "noscript"]);
/** Form controls whose text (options, values, button captions) is not part of an enclosing label's name. */
const CONTROL_TAGS = new Set(["select", "option", "optgroup", "datalist", "input", "textarea", "button"]);
const BLOCK_TAGS = new Set(["div", "p", "li", "ul", "ol", "br", "td", "th", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "header", "footer", "nav", "label", "dt", "dd", "option", "figcaption", "blockquote"]);

/**
 * Rendered text of a node following the flat tree (an element's open shadow root instead of its light children,
 * a slot's assigned nodes), optionally without the text of descendant form controls. Bounded.
 */
function flatText(node: Node, skipControls: boolean, budget = { nodes: 400, chars: 240 }, root = true): string {
  if (budget.nodes-- <= 0 || budget.chars <= 0) return "";
  if (node.nodeType === TEXT_NODE) {
    const t = node.nodeValue ?? "";
    budget.chars -= t.length;
    return t;
  }
  let kids: ArrayLike<Node> | null = null;
  let block = false;
  if (node.nodeType === ELEMENT_NODE) {
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TEXT.has(tag) || (skipControls && !root && CONTROL_TAGS.has(tag))) return "";
    block = BLOCK_TAGS.has(tag);
    if (tag === "slot" && typeof (el as HTMLSlotElement).assignedNodes === "function") {
      const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
      if (assigned.length) kids = assigned;
    }
    if (!kids) kids = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot?.childNodes ?? el.childNodes;
  } else if (node.nodeType === FRAGMENT_NODE) kids = node.childNodes;
  if (!kids) return "";
  let out = "";
  for (let i = 0; i < kids.length; i++) out += flatText(kids[i], skipControls, budget, false);
  return block ? ` ${out} ` : out;
}

/** The shadow root an element lives in, or null (document tree). */
function shadowRootOf(el: Element): ShadowRoot | null {
  const r = typeof el.getRootNode === "function" ? el.getRootNode() : null;
  return r && r.nodeType === FRAGMENT_NODE && (r as ShadowRoot).host ? (r as ShadowRoot) : null;
}

/** Where ids and label[for] resolve: the element's own tree (its shadow root, or its document). */
function scopeOf(el: Element): (Document | ShadowRoot) | null {
  return shadowRootOf(el) ?? el.ownerDocument;
}

function byId(scope: Document | ShadowRoot | null, id: string): Element | null {
  if (!scope) return null;
  try {
    return typeof scope.getElementById === "function" ? scope.getElementById(id) : scope.querySelector(`#${CSS && CSS.escape ? CSS.escape(id) : id}`);
  } catch {
    return null;
  }
}

function textOfIds(scope: Document | ShadowRoot | null, ids: string): string {
  return ids
    .split(/\s+/)
    .map((id) => {
      const el = id ? byId(scope, id) : null;
      return el ? flatText(el, true) : "";
    })
    .join(" ");
}

/** A label's own text: without the options, values or captions of the controls nested inside it. */
function labelText(label: Element | null | undefined): string {
  return label ? clean(flatText(label, true)) : "";
}

/** The visible name text of a non-field element. */
function ownText(el: Element): string {
  const deep = !!shadowRootOf(el) || !!(el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot || el.tagName.toLowerCase() === "label";
  let hasControls = false;
  try {
    hasControls = !!el.querySelector("select,option,textarea,input,button,slot");
  } catch {
    hasControls = false;
  }
  if (deep || hasControls) return clean(flatText(el, true));
  return clean((el as HTMLElement).innerText ?? el.textContent);
}

/** 'button "Place order"', 'input "Search"', 'link "Home"'. */
export function describeElement(el: Element | null): string {
  if (!el) return "page";
  const scope = scopeOf(el);
  let name = clean(el.getAttribute("aria-label"));
  if (!name) {
    const lb = el.getAttribute("aria-labelledby");
    if (lb) name = clean(textOfIds(scope, lb));
  }
  const tag = el.tagName.toLowerCase();
  const isField = tag === "input" || tag === "select" || tag === "textarea";
  if (!name && isField) {
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) name = labelText(labels[0]);
    if (!name && el.id && scope) {
      try {
        name = labelText(scope.querySelector(`label[for="${CSS && CSS.escape ? CSS.escape(el.id) : el.id}"]`));
      } catch {
        /* ignore */
      }
    }
    if (!name) name = labelText(el.closest("label"));
  }
  if (!name && !isField) name = ownText(el);
  if (!name) name = clean(el.getAttribute("placeholder"));
  if (!name) name = clean(el.getAttribute("title"));
  if (!name) name = clean(el.getAttribute("name"));
  // only a button-like input's value is a label; never what the user typed (passwords, card numbers, ...)
  if (!name && tag === "input" && ["button", "submit", "reset"].includes(((el as HTMLInputElement).type || "").toLowerCase())) name = clean((el as HTMLInputElement).value);
  if (!name) {
    // a control inside a custom element's shadow root, named by its host (<x-field label="Email">)
    const host = shadowRootOf(el)?.host;
    if (host) name = clean(host.getAttribute("aria-label")) || clean(host.getAttribute("label")) || clean(host.getAttribute("title")) || clean(host.getAttribute("placeholder"));
  }
  if (!name) name = clean(el.id);
  const role = roleOf(el);
  return name ? `${role} "${name}"` : role;
}

const SENSITIVE_AUTOCOMPLETE = /^(cc-|one-time-code$|current-password$|new-password$)/i;

/**
 * Whether a field holds a secret by its semantics: a password input, a card/one-time-code autocomplete hint, or a
 * name/id/label that names a secret (password, card number, cvv, ssn, iban, token, ...). A kanban "card" is not.
 */
export function isSensitiveField(el: Element | null): boolean {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" && ((el as HTMLInputElement).type || "").toLowerCase() === "password") return true;
  const ac = (el.getAttribute("autocomplete") ?? "").trim().split(/\s+/).pop() ?? "";
  if (ac && SENSITIVE_AUTOCOMPLETE.test(ac)) return true;
  const names = [el.getAttribute("name"), el.id, el.getAttribute("aria-label"), el.getAttribute("placeholder")];
  const labels = (el as HTMLInputElement).labels;
  if (labels) for (const l of Array.from(labels)) names.push(labelText(l));
  const host = shadowRootOf(el)?.host;
  if (host) names.push(host.getAttribute("label"), host.getAttribute("name"), host.getAttribute("aria-label"));
  return names.some((n) => !!n && isSensitiveName(n));
}

function asElement(t: unknown): Element | null {
  const n = t as Node | null;
  if (!n || typeof n !== "object") return null;
  if (n.nodeType === ELEMENT_NODE && typeof (n as Element).closest === "function") return n as Element;
  return n.parentElement ?? null; // a text node
}

/** The node the user actually interacted with: the start of the composed path (inside open shadow roots). */
function originOf(e: Event): Element | null {
  try {
    if (typeof e.composedPath === "function") {
      const p = e.composedPath();
      if (p.length) {
        const el = asElement(p[0]);
        if (el) return el;
      }
    }
  } catch {
    /* ignore */
  }
  return asElement(e.target);
}

/** closest() across shadow boundaries (an interactive ancestor in the flat tree). */
function closestDeep(el: Element, sel: string): Element | null {
  let cur: Element | null = el;
  for (let i = 0; cur && i < 32; i++) {
    const hit = cur.closest(sel);
    if (hit) return hit;
    cur = shadowRootOf(cur)?.host ?? null;
  }
  return null;
}

function interactive(t: Element | null): Element | null {
  if (!t) return null;
  return closestDeep(t, INTERACTIVE) ?? t;
}

/** True when `node` is inside an element marked `data-genclass-ignore`, crossing shadow-root boundaries. */
function insideIgnored(node: unknown): boolean {
  let n = node as (Node & { host?: Node }) | null;
  for (let i = 0; n && i < 1000; i++) {
    const el = n as unknown as Element;
    if (typeof el.hasAttribute === "function" && el.hasAttribute("data-genclass-ignore")) return true;
    n = (n.parentNode ?? n.host ?? null) as (Node & { host?: Node }) | null;
  }
  return false;
}

/** Events from inside `[data-genclass-ignore]` (the devtools overlay, an app's own debug UI) are not user actions. */
export function ignoredEvent(e: Event): boolean {
  try {
    if (typeof e.composedPath === "function") {
      const path = e.composedPath();
      if (path.length && insideIgnored(path[0])) return true;
    }
  } catch {
    /* ignore */
  }
  return insideIgnored(e.target);
}

export function installDomUser(g: Record<string, unknown>, sink: UserSink): (() => void) | null {
  const doc = g.document as Document | undefined;
  if (!doc || typeof doc.addEventListener !== "function") return null;
  const root: EventTarget = typeof (g as { addEventListener?: unknown }).addEventListener === "function" ? (g as unknown as EventTarget) : doc;
  const opts = { capture: true, passive: true } as AddEventListenerOptions;

  const onClick = (e: Event) => {
    const el = interactive(originOf(e));
    sink.user({ kind: "click", target: describeElement(el) });
  };
  const onInput = (e: Event) => {
    const el = originOf(e) as HTMLInputElement | null;
    if (!el || !el.tagName) return;
    const tag = el.tagName.toLowerCase();
    const type = (el.type || "").toLowerCase();
    const editable = (el as unknown as HTMLElement).isContentEditable;
    const textLike = tag === "textarea" || editable || (tag === "input" && TEXT_INPUTS.has(type));
    if (!textLike) return;
    const sensitive = isSensitiveField(el);
    const value = sensitive ? "" : editable ? (el as unknown as HTMLElement).textContent ?? "" : el.value ?? "";
    sink.user({ kind: "type", target: describeElement(el), value, sensitive });
  };
  const onChange = (e: Event) => {
    const el = originOf(e) as HTMLInputElement | HTMLSelectElement | null;
    if (!el || !el.tagName) return;
    const tag = el.tagName.toLowerCase();
    const type = ((el as HTMLInputElement).type || "").toLowerCase();
    const sensitive = isSensitiveField(el);
    if (tag === "select") {
      const s = el as HTMLSelectElement;
      const opt = s.selectedOptions?.[0];
      sink.user({ kind: "change", target: describeElement(el), value: sensitive ? "" : clean(opt?.textContent ?? s.value), sensitive });
    } else if (tag === "input" && (type === "checkbox" || type === "radio")) {
      sink.user({ kind: "change", target: describeElement(el), value: (el as HTMLInputElement).checked ? "checked" : "unchecked" });
    } else if (tag === "input" && (type === "range" || type === "color" || type === "file")) {
      sink.user({ kind: "change", target: describeElement(el), value: type === "file" ? "file" : sensitive ? "" : clean((el as HTMLInputElement).value), sensitive });
    }
  };
  const onSubmit = (e: Event) => {
    const form = originOf(e) as HTMLFormElement | null;
    let target = "form";
    if (form && form.tagName) {
      const name = clean(form.getAttribute("aria-label")) || clean(form.getAttribute("name")) || clean(form.id) || clean(form.querySelector("h1,h2,h3,legend")?.textContent);
      target = name ? `form "${name}"` : "form";
    }
    sink.user({ kind: "submit", target });
  };
  const onKey = (e: Event) => {
    const k = (e as KeyboardEvent).key;
    if (k !== "Enter" && k !== "Escape") return;
    sink.user({ kind: "key", key: k, target: describeElement(interactive(originOf(e))) });
  };
  const pairs: [string, (e: Event) => void][] = [
    ["click", onClick],
    ["input", onInput],
    ["change", onChange],
    ["submit", onSubmit],
    ["keydown", onKey],
  ];
  // Events dispatched by app code while one of its operations runs (el.click() inside a task, a fetch callback,
  // ...) are not user actions. Untrusted events with no operation running (test drivers) and events dispatched
  // while handling a user action are kept.
  const programmatic = (e: Event): boolean => {
    // a browser never dispatches a real user event while app code is running: an event that arrives during an
    // operation's synchronous code was dispatched by that code
    const r = sink.runningKind?.() ?? null;
    if (r !== null && r !== "user") return true;
    if (e.isTrusted !== false) return false;
    // a synthetic event: only recorded when the app opted in (observe.untrustedEvents), and never while an app
    // operation is ambient
    if (!sink.untrusted) return true;
    const k = sink.ambientKind?.() ?? null;
    return k !== null && k !== "user";
  };
  let stopped = false;
  const guarded = pairs.map(([t, fn]) => [t, (e: Event) => (stopped || ignoredEvent(e) || programmatic(e) ? undefined : fn(e))] as [string, (e: Event) => void]);
  // change and submit do not leave a shadow root: listen on each open shadow root a composed event came from
  const LOCAL = new Set(["change", "submit"]);
  // (a synthetic composed one also reaches the window listener: handled there only)
  const local = guarded.filter(([t]) => LOCAL.has(t)).map(([t, fn]) => [t, (e: Event) => (e.composed ? undefined : fn(e))] as [string, (e: Event) => void]);
  const seenRoots = new WeakSet<object>();
  const shadowRoots: { deref(): EventTarget | undefined }[] = [];
  const WR = (globalThis as { WeakRef?: new <T extends object>(t: T) => { deref(): T | undefined } }).WeakRef;
  const adopt = (e: Event) => {
    if (stopped || typeof e.composedPath !== "function") return;
    let path: EventTarget[];
    try {
      path = e.composedPath();
    } catch {
      return;
    }
    for (const n of path) {
      const sr = n as unknown as ShadowRoot;
      if (!sr || sr.nodeType !== FRAGMENT_NODE || !sr.host || seenRoots.has(sr)) continue;
      seenRoots.add(sr);
      for (const [t, fn] of local) sr.addEventListener(t, fn, opts);
      if (WR) shadowRoots.push(new WR(sr));
    }
  };
  const ADOPT_ON = ["focusin", "pointerdown", "mousedown", "click", "input", "keydown"];
  for (const t of ADOPT_ON) root.addEventListener(t, adopt, opts);
  for (const [t, fn] of guarded) root.addEventListener(t, fn, opts);
  return () => {
    stopped = true;
    for (const t of ADOPT_ON) root.removeEventListener(t, adopt, opts);
    for (const [t, fn] of guarded) root.removeEventListener(t, fn, opts);
    for (const w of shadowRoots) {
      const sr = w.deref();
      if (sr) for (const [t, fn] of local) sr.removeEventListener(t, fn, opts);
    }
  };
}
