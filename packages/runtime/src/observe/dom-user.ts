// DOM user-action observer (CONTRACT §3): capture-phase listeners record clicks, typing (one "typed" event per
// burst; password values never recorded), changes, submits and Enter/Escape as user ops. The user op is ambient
// for the rest of the event's task, so the app's handlers' writes are user writes (never held) and the requests
// they start have the user action as their cause.

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

function textOfIds(doc: Document, ids: string): string {
  return ids
    .split(/\s+/)
    .map((id) => doc.getElementById(id)?.textContent ?? "")
    .join(" ");
}

/** 'button "Place order"', 'input "Search"', 'link "Home"'. */
export function describeElement(el: Element | null): string {
  if (!el) return "page";
  const doc = el.ownerDocument;
  let name = clean(el.getAttribute("aria-label"));
  if (!name) {
    const lb = el.getAttribute("aria-labelledby");
    if (lb && doc) name = clean(textOfIds(doc, lb));
  }
  const tag = el.tagName.toLowerCase();
  const isField = tag === "input" || tag === "select" || tag === "textarea";
  if (!name && isField) {
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) name = clean(labels[0].textContent);
    if (!name && el.id && doc) {
      try {
        name = clean(doc.querySelector(`label[for="${CSS && CSS.escape ? CSS.escape(el.id) : el.id}"]`)?.textContent);
      } catch {
        /* ignore */
      }
    }
    if (!name) name = clean(el.closest("label")?.textContent);
  }
  if (!name && !isField) name = clean((el as HTMLElement).innerText ?? el.textContent);
  if (!name) name = clean(el.getAttribute("placeholder"));
  if (!name) name = clean(el.getAttribute("title"));
  if (!name) name = clean(el.getAttribute("name"));
  // only a button-like input's value is a label; never what the user typed (passwords, card numbers, ...)
  if (!name && tag === "input" && ["button", "submit", "reset"].includes(((el as HTMLInputElement).type || "").toLowerCase())) name = clean((el as HTMLInputElement).value);
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
  if (labels) for (const l of Array.from(labels)) names.push(l.textContent);
  return names.some((n) => !!n && isSensitiveName(n));
}

function interactive(t: EventTarget | null): Element | null {
  let el = t as Element | null;
  if (!el || typeof (el as Element).closest !== "function") {
    const n = t as Node | null;
    el = n && n.parentElement ? n.parentElement : null;
  }
  if (!el) return null;
  return el.closest(INTERACTIVE) ?? el;
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
    const el = interactive(e.target);
    sink.user({ kind: "click", target: describeElement(el) });
  };
  const onInput = (e: Event) => {
    const el = e.target as HTMLInputElement | null;
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
    const el = e.target as HTMLInputElement | HTMLSelectElement | null;
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
    const form = e.target as HTMLFormElement | null;
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
    sink.user({ kind: "key", key: k, target: describeElement(interactive(e.target)) });
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
  const guarded = pairs.map(([t, fn]) => [t, (e: Event) => (ignoredEvent(e) || programmatic(e) ? undefined : fn(e))] as [string, (e: Event) => void]);
  for (const [t, fn] of guarded) root.addEventListener(t, fn, opts);
  return () => {
    for (const [t, fn] of guarded) root.removeEventListener(t, fn, opts);
  };
}
