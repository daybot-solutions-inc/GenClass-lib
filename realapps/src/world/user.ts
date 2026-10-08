// Scripted user on virtual time. Steps run in order, each at max(scheduled time, previous step done), as
// user-phase tasks (after every other task due at the same instant, like input arriving between tasks). Events are
// dispatched the way @testing-library/user-event does it (pointer/mouse/focus/key/beforeinput/input/change
// sequences, native value setters so framework value trackers see the change); they are untrusted, which the
// runtime's DOM observer accepts when no operation is ambient.

import type { Step } from "../shared/types.js";
import type { VirtualLoop } from "./loop.js";

const USER_PHASE = 1;

export interface DriverHooks {
  /** Called synchronously before each atomic input dispatch (step index, sub-action index). */
  begin(step: Step, sub: number): void;
  end(): void;
  inflight(): number;
  skipped(step: Step, why: string): void;
  ran(step: Step, el?: Element): void;
}

function deepQueryAll(root: ParentNode, sel: string): Element[] {
  const parts = sel.split(">>>").map((s) => s.trim());
  let scope: ParentNode[] = [root];
  for (let i = 0; i < parts.length; i++) {
    const found: Element[] = [];
    for (const s of scope) found.push(...Array.from(s.querySelectorAll(parts[i]!)));
    if (i === parts.length - 1) return found;
    scope = found.map((e) => (e as Element & { shadowRoot: ShadowRoot | null }).shadowRoot).filter(Boolean) as ParentNode[];
  }
  return [];
}

function visible(el: Element): boolean {
  if (!el.isConnected) return false;
  const he = el as HTMLElement;
  if (he.hidden) return false;
  return el.getClientRects().length > 0;
}

function textOf(el: Element): string {
  const he = el as HTMLElement;
  return (he.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
}

const ITEM = "li, tr, article, [data-id], [data-key], .card, .item, .row, .result, .product, .todo, .message, .post, .entry, .line, .slot";

/** Identity tokens of the item an element belongs to: words of its list item / card / row (numbers dropped, since
 * counts and prices change), plus its own label. Used to pin a step to the same entity across runs. */
export function pinOf(el: Element): string[] {
  let host: Element | null = el.closest(ITEM);
  if (!host) {
    const root = el.getRootNode();
    const h = (root as ShadowRoot).host;
    host = h ? h.closest(ITEM) ?? h : null;
  }
  // controls outside any list item (a unique "Save" button) are not pinned: the selector identifies them; neither
  // is a one-off container (a detail <article>): only hosts that repeat among their siblings are list items
  if (!host || host === el) return [];
  const sibs = host.parentElement ? Array.from(host.parentElement.children).filter((c) => c.tagName === host!.tagName) : [];
  if (sibs.length < 2) return [];
  const words = (s: string) => s.toLowerCase().replace(/[0-9]+/g, " ").split(/[^a-z\u00c0-\u024f]+/).filter((w) => w.length >= 3);
  const own = new Set(words(textOf(el)));
  const t = textOf(host);
  return t.length <= 400 ? [...new Set(words(t).filter((w) => !own.has(w)))].slice(0, 24) : [];
}

function pinScore(pin: string[], el: Element): number {
  if (!pin.length) return 0;
  const have = new Set(pinOf(el));
  let n = 0;
  for (const w of pin) if (have.has(w)) n++;
  return n / pin.length;
}

export class UserDriver {
  private i = 0;
  private busyUntil = 0;
  private lastFocus: Element | null = null;
  private dirtyValue = false;

  constructor(
    private w: Window & typeof globalThis,
    private loop: VirtualLoop,
    private steps: Step[],
    private ideal: boolean,
    private hooks: DriverHooks,
  ) {}

  start(): void {
    this.next();
  }

  private next(): void {
    while (this.i < this.steps.length && this.ideal && this.steps[this.i]!.accidental) this.i++;
    if (this.i >= this.steps.length) return;
    const st = this.steps[this.i++]!;
    const at = Math.max(st.t, this.busyUntil, this.loop.now);
    this.loop.at(at, () => this.run(st, 0), "user", USER_PHASE);
  }

  private find(st: Step): Element | null {
    let els = deepQueryAll(this.w.document, st.sel).filter(visible);
    if (st.text) els = els.filter((e) => textOf(e).toLowerCase().includes(st.text!.toLowerCase()));
    if (!els.length) return null;
    // an accidental repeat (double click, impatient re-click) hits the same element again if it is still there
    if (st.repeatOf !== undefined) {
      const prev = this.usedEl.get(st.repeatOf);
      if (prev && visible(prev)) return prev;
    }
    // the same intent as the ideal run's user: the element whose list item matches the pinned item best
    const pin = this.pins?.[st.i] ?? (st.repeatOf !== undefined ? this.pins?.[st.repeatOf] : undefined);
    if (pin && pin.length) {
      let best: Element | null = null;
      let bestScore = -1;
      for (const e of els) {
        const sc = pinScore(pin, e);
        if (sc > bestScore + 1e-9) {
          best = e;
          bestScore = sc;
        }
      }
      return bestScore >= 0.6 ? best : null;
    }
    return els[(st.nth ?? 0) % els.length]!;
  }

  private usedEl = new Map<number, Element>();
  /** Ideal run: what each step acted on (exported as RunResult.pins). */
  recorded: Record<number, string[]> = {};
  pins: Record<number, string[]> | undefined;

  private skippedSteps = new Set<number>();
  private reqOk = new Set<number>();

  private skip(st: Step, why: string): void {
    this.skippedSteps.add(st.i);
    this.hooks.skipped(st, why);
    this.busyUntil = this.loop.now;
    this.next();
  }

  /** Affordances whose steps actually ran (minus those reset since). */
  private ranAff = new Set<string>();

  /** Grace (virtual ms) for a `requires` precondition: a few-ms difference in when a response lands (e.g. GenClass
   * holding it briefly) must not flip whether the user can take the step. */
  static REQUIRES_GRACE = 300;

  private run(st: Step, waited: number): void {
    if (waited === 0 && st.head !== undefined && st.head !== st.i && this.skippedSteps.has(st.head)) return this.skip(st, "chain");
    // `after`: one of these affordances must have actually run (not just been scheduled)
    if (waited === 0 && st.after?.length && !st.after.some((a) => this.ranAff.has(a))) return this.skip(st, "after");
    if (st.requires && !this.reqOk.has(st.i)) {
      let ok = false;
      try {
        ok = deepQueryAll(this.w.document, st.requires).some((e) => visible(e) && (!st.requiresText || textOf(e).toLowerCase().includes(st.requiresText.toLowerCase())));
      } catch {
        ok = false;
      }
      if (!ok) {
        if (waited >= UserDriver.REQUIRES_GRACE) return this.skip(st, "precondition");
        this.loop.schedule(100, () => this.run(st, waited + 100), "user-wait", USER_PHASE);
        return;
      }
      this.reqOk.add(st.i);
    }
    if (st.when === "inflight" && this.hooks.inflight() === 0) {
      this.hooks.skipped(st, "not-inflight");
      this.busyUntil = this.loop.now;
      this.next();
      return;
    }
    const el = this.find(st);
    if (!el) {
      const limit = st.waitMs ?? 2000;
      if (waited >= limit) return this.skip(st, "missing");
      this.loop.schedule(100, () => this.run(st, waited + 100), "user-wait", USER_PHASE);
      return;
    }
    this.hooks.ran(st, el);
    this.ranAff.add(st.intent.affordance);
    for (const r of st.resets ?? []) this.ranAff.delete(r);
    this.usedEl.set(st.i, el);
    if (this.ideal && st.kind !== "type" && st.kind !== "key") {
      const pin = pinOf(el);
      if (pin.length) this.recorded[st.i] = pin;
    }
    switch (st.kind) {
      case "type":
        this.typeInto(st, el);
        return;
      default:
        this.atomic(st, 0, () => this.act(st, el));
        this.busyUntil = this.loop.now;
        this.next();
    }
  }

  private atomic(st: Step, sub: number, fn: () => void): void {
    this.hooks.begin(st, sub);
    try {
      fn();
    } catch (e) {
      this.w.reportError?.(e);
    } finally {
      this.hooks.end();
    }
  }

  private center(el: Element): { clientX: number; clientY: number } {
    const r = el.getBoundingClientRect();
    return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  }

  private focus(el: Element): void {
    const d = this.w.document;
    const prev = d.activeElement;
    if (prev === el) return;
    if (prev && this.dirtyValue && (prev instanceof HTMLInputElement || prev instanceof HTMLTextAreaElement)) {
      prev.dispatchEvent(new Event("change", { bubbles: true }));
    }
    this.dirtyValue = false;
    // a user who clicks an element is looking at it: focusing never scrolls (scrolling is real-time; see loop.ts)
    if (typeof (el as HTMLElement).focus === "function") (el as HTMLElement).focus({ preventScroll: true });
    this.lastFocus = el;
  }

  private mouse(el: Element, type: string): void {
    const c = this.center(el);
    const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, button: 0, buttons: type.endsWith("down") ? 1 : 0, view: this.w, ...c, ...(type.startsWith("pointer") ? { pointerId: 1, pointerType: "mouse", isPrimary: true } : {}) }));
  }

  private click(el: Element): void {
    this.mouse(el, "pointerdown");
    const ok = el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, view: this.w, ...this.center(el) }));
    const focusable = el.closest("button,a,input,select,textarea,[tabindex],summary") ?? el;
    if (ok) this.focus(focusable);
    this.mouse(el, "pointerup");
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, composed: true, button: 0, view: this.w, ...this.center(el) }));
    (el as HTMLElement).click();
  }

  private key(el: Element, key: string): boolean {
    const code = key.length === 1 ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : key === " " ? "Space" : "") : key;
    const keyCode = key === "Enter" ? 13 : key === "Escape" ? 27 : key === "Backspace" ? 8 : key === "Tab" ? 9 : key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
    const init = { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true, view: this.w };
    const ok = el.dispatchEvent(new KeyboardEvent("keydown", init));
    if (ok && key.length === 1) el.dispatchEvent(new KeyboardEvent("keypress", { ...init, charCode: key.charCodeAt(0) }));
    return ok;
  }

  private keyUp(el: Element, key: string): void {
    el.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true, composed: true, view: this.w }));
  }

  private setValue(el: Element, v: string): void {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, v);
    else (el as HTMLInputElement).value = v;
  }

  private input(el: Element, data: string | null, inputType: string): void {
    el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: false, composed: true, data, inputType }));
  }

  private act(st: Step, el: Element): void {
    switch (st.kind) {
      case "click":
      case "dblclick":
        this.click(el);
        if (st.kind === "dblclick") {
          this.click(el);
          el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, composed: true, view: this.w, ...this.center(el) }));
        }
        return;
      case "hover":
        this.mouse(el, "pointerover");
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, composed: true, view: this.w }));
        el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, composed: true, view: this.w }));
        return;
      case "check":
        this.click(el);
        return;
      case "select": {
        const s = el as HTMLSelectElement;
        this.focus(s);
        const opts = Array.from(s.options);
        const o = opts.find((x) => x.value === st.value) ?? opts.find((x) => x.text.trim() === st.value) ?? (st.value === undefined ? opts[((st.nth ?? 0) % Math.max(1, opts.length))] : undefined);
        if (!o) return;
        this.setValue(s, o.value);
        s.dispatchEvent(new Event("input", { bubbles: true }));
        s.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
      case "clear": {
        this.click(el);
        this.setValue(el, "");
        this.input(el, null, "deleteContentBackward");
        this.dirtyValue = true;
        return;
      }
      case "key": {
        const target = this.w.document.activeElement && this.w.document.activeElement !== this.w.document.body ? this.w.document.activeElement : el;
        const k = st.key ?? st.value ?? "Enter";
        const ok = this.key(target, k);
        if (ok && k === "Enter") this.implicitSubmit(target);
        this.keyUp(target, k);
        return;
      }
    }
  }

  private implicitSubmit(el: Element): void {
    const f = (el as HTMLInputElement).form;
    if (f && el instanceof HTMLInputElement) {
      try {
        f.requestSubmit();
      } catch {
        /* ignore */
      }
    }
  }

  private typeInto(st: Step, el: Element): void {
    const text = st.value ?? "";
    const delays = st.keyMs ?? [];
    let j = 0;
    let sub = 0;
    // focus (click) first
    this.atomic(st, sub++, () => {
      this.click(el);
      if (st.clear && ((el as HTMLInputElement).value ?? "") !== "") {
        this.setValue(el, "");
        this.input(el, null, "deleteContentBackward");
        this.dirtyValue = true;
      }
    });
    const typeOne = () => {
      if (j >= text.length) {
        if (st.enter) {
          this.atomic(st, sub++, () => {
            const ok = this.key(el, "Enter");
            if (ok) this.implicitSubmit(el);
            this.keyUp(el, "Enter");
          });
        }
        this.busyUntil = this.loop.now;
        this.next();
        return;
      }
      const ch = text[j]!;
      const target = el.isConnected ? el : this.w.document.activeElement ?? el;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
        // the field went away (view changed): the rest of the text is not typed anywhere
        this.busyUntil = this.loop.now;
        this.next();
        return;
      }
      this.atomic(st, sub++, () => {
        const ok = this.key(target, ch === "\b" ? "Backspace" : ch);
        if (ok) {
          const cur = (target as HTMLInputElement).value ?? "";
          if (ch === "\b") {
            this.setValue(target, cur.slice(0, -1));
            this.input(target, null, "deleteContentBackward");
          } else {
            const before = new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, data: ch, inputType: "insertText" });
            if (target.dispatchEvent(before)) {
              const max = (target as HTMLInputElement).maxLength;
              if (!(max > 0 && cur.length >= max)) {
                this.setValue(target, cur + ch);
                this.input(target, ch, "insertText");
              }
            }
          }
          this.dirtyValue = true;
        }
        this.keyUp(target, ch === "\b" ? "Backspace" : ch);
      });
      j++;
      const d = delays[j - 1] ?? 120;
      this.loop.schedule(d, typeOne, "user-key", USER_PHASE);
    };
    this.loop.schedule(delays.length ? 30 : 0, typeOne, "user-key", USER_PHASE);
  }
}
