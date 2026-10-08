// In-page synthetic user: executes scripted steps with the same DOM events a browser fires for real typing and
// clicking (keydown, beforeinput, input, keyup; pointer/mouse down/up, click). Playwright runs the same steps with
// real input instead (e2e/eval.ts).
import type { Chaos } from "./chaos.ts";
import type { Step } from "./types.ts";

export interface DriverHooks {
  chaos(patch: Partial<Chaos>): Promise<void>;
  server(action: string, args?: unknown): Promise<void>;
  mark(name: string): void;
  check(cond: string): boolean;
  /** Called when an `until` step times out. */
  onTimeout?(cond: string): void;
}

import { sleep } from "./native.ts";

type TextEl = HTMLInputElement | HTMLTextAreaElement;

function q(doc: Document, sel: string): HTMLElement | null {
  return doc.querySelector<HTMLElement>(sel);
}

async function waitFor(doc: Document, sel: string, timeout = 5000): Promise<HTMLElement | null> {
  const t0 = performance.now();
  for (;;) {
    const el = q(doc, sel);
    if (el && el.isConnected) return el;
    if (performance.now() - t0 > timeout) return null;
    await sleep(25);
  }
}

function codeFor(key: string): string {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key === " ") return "Space";
  if (key.length > 1) return key;
  return "";
}

function kb(el: Element, type: "keydown" | "keyup" | "keypress", key: string): boolean {
  return el.dispatchEvent(
    new KeyboardEvent(type, {
      key,
      code: codeFor(key),
      bubbles: true,
      cancelable: true,
      composed: true,
      charCode: type === "keypress" ? key.charCodeAt(0) : 0,
    }),
  );
}

function focus(el: HTMLElement) {
  if (el.ownerDocument.activeElement !== el) el.focus({ preventScroll: true });
}

function isText(el: Element): el is TextEl {
  return el instanceof el.ownerDocument.defaultView!.HTMLInputElement || el instanceof el.ownerDocument.defaultView!.HTMLTextAreaElement;
}

function edit(el: TextEl, inputType: string, data: string | null, apply: () => void) {
  const before = new InputEvent("beforeinput", { inputType, data, bubbles: true, cancelable: true, composed: true });
  if (!el.dispatchEvent(before)) return;
  apply();
  el.dispatchEvent(new InputEvent("input", { inputType, data, bubbles: true, composed: true }));
}

function insertText(el: TextEl, text: string) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  edit(el, text === "\n" ? "insertLineBreak" : "insertText", text === "\n" ? null : text, () => el.setRangeText(text, start, end, "end"));
}

function deleteBackward(el: TextEl) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  if (start === end && start === 0) return;
  const from = start === end ? start - 1 : start;
  edit(el, "deleteContentBackward", null, () => el.setRangeText("", from, end, "end"));
}

async function typeInto(doc: Document, sel: string, text: string, delays: number[]) {
  for (let i = 0; i < text.length; i++) {
    await sleep(delays[i] ?? 90);
    const el = q(doc, sel);
    if (!el || !isText(el) || el.disabled) continue;
    focus(el);
    const ch = text[i];
    if (ch === "\n") {
      pressKey(el, "Enter");
      continue;
    }
    if (!kb(el, "keydown", ch)) {
      kb(el, "keyup", ch);
      continue;
    }
    kb(el, "keypress", ch);
    insertText(el, ch);
    kb(el, "keyup", ch);
  }
}

function pressKey(el: HTMLElement, key: string) {
  focus(el);
  const go = kb(el, "keydown", key);
  if (go && isText(el)) {
    if (key === "Backspace") deleteBackward(el);
    else if (key === "Enter") {
      if (el instanceof el.ownerDocument.defaultView!.HTMLTextAreaElement) insertText(el, "\n");
      else el.form?.requestSubmit();
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      const p = Math.max(0, Math.min(el.value.length, (el.selectionStart ?? 0) + (key === "ArrowLeft" ? -1 : 1)));
      el.setSelectionRange(p, p);
    }
  }
  kb(el, "keyup", key);
}

function mouse(el: HTMLElement, type: string, detail: number) {
  const r = el.getBoundingClientRect();
  const init = {
    bubbles: type !== "pointerenter" && type !== "mouseenter",
    cancelable: true,
    composed: true,
    clientX: r.left + r.width / 2,
    clientY: r.top + r.height / 2,
    button: 0,
    buttons: type.endsWith("down") ? 1 : 0,
    detail,
    view: el.ownerDocument.defaultView,
  };
  const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
  return el.dispatchEvent(
    type.startsWith("pointer") ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }) : new Ctor(type, init),
  );
}

function clickOnce(el: HTMLElement, detail: number) {
  // A real click on a disabled control does nothing.
  if ((el as HTMLButtonElement).disabled) return;
  mouse(el, "pointerover", 0);
  mouse(el, "pointerenter", 0);
  mouse(el, "mouseover", 0);
  mouse(el, "pointerdown", detail);
  mouse(el, "mousedown", detail);
  if (el.tabIndex >= 0 || isText(el) || el instanceof el.ownerDocument.defaultView!.HTMLButtonElement) focus(el);
  mouse(el, "pointerup", detail);
  mouse(el, "mouseup", detail);
  mouse(el, "click", detail);
  if (detail === 2) mouse(el, "dblclick", 2);
}

export async function runSteps(doc: Document, steps: Step[], hooks: DriverHooks, shouldStop: () => boolean = () => false): Promise<void> {
  for (const s of steps) {
    if (shouldStop()) return;
    switch (s.k) {
      case "wait":
        await sleep(s.ms);
        break;
      case "mark":
        hooks.mark(s.name);
        break;
      case "chaos":
        await hooks.chaos(s.patch);
        break;
      case "server":
        await hooks.server(s.action, s.args);
        break;
      case "until": {
        const t0 = performance.now();
        while (!hooks.check(s.cond)) {
          if (performance.now() - t0 > s.timeout) {
            hooks.onTimeout?.(s.cond);
            break;
          }
          await sleep(25);
        }
        break;
      }
      case "focus": {
        const el = await waitFor(doc, s.sel);
        if (el) focus(el);
        break;
      }
      case "caret": {
        const el = await waitFor(doc, s.sel);
        if (el && isText(el)) {
          focus(el);
          const p = s.pos === "end" ? el.value.length : s.pos === "start" ? 0 : Math.min(s.pos, el.value.length);
          el.setSelectionRange(p, p);
        }
        break;
      }
      case "type": {
        const el = await waitFor(doc, s.sel);
        if (el) focus(el);
        await typeInto(doc, s.sel, s.text, s.delays);
        break;
      }
      case "key": {
        for (const d of s.delays) {
          await sleep(d);
          const el = q(doc, s.sel);
          if (el) pressKey(el, s.key);
        }
        break;
      }
      case "click": {
        if (s.unless && hooks.check(s.unless)) break;
        const count = s.count ?? 1;
        for (let i = 0; i < count; i++) {
          const el = await waitFor(doc, s.sel, 4000);
          if (!el) break;
          const dbl = count === 2 && (s.gap ?? 0) < 300;
          clickOnce(el, dbl ? i + 1 : 1);
          if (i < count - 1) await sleep(s.gap ?? 120);
        }
        break;
      }
    }
  }
}
