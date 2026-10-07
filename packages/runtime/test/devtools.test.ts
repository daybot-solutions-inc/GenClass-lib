// @vitest-environment happy-dom
// Devtools overlay against a scripted implementation of the public Runtime interface.
import { afterEach, describe, expect, it } from "vitest";
import { mountDevtools, type DevtoolsHandle, type DevtoolsOptions } from "../src/devtools/index.js";
import { CSS } from "../src/devtools/css.js";
import { MockRuntime, makeAction, makeDecision } from "./browser/ui/mock-runtime.js";
import { loadScenario } from "./browser/ui/scenario.js";

const frame = (): Promise<void> => new Promise((r) => setTimeout(r, 40));
let handles: DevtoolsHandle[] = [];

afterEach(() => {
  for (const h of handles) h.unmount();
  handles = [];
  document.body.innerHTML = "";
});

function mount(rt: MockRuntime, opts: DevtoolsOptions = {}) {
  const h = mountDevtools(rt, opts);
  handles.push(h);
  const host = h.element as HTMLElement;
  const sr = host.shadowRoot as ShadowRoot;
  const $ = <E extends Element = HTMLElement>(sel: string) => sr.querySelector<E>(sel as never) as E | null;
  const $$ = (sel: string) => [...sr.querySelectorAll<HTMLElement>(sel)];
  const click = async (sel: string) => {
    const el = $(sel);
    if (!el) throw new Error(`no element ${sel}`);
    el.click();
    await frame();
  };
  return { h, host, sr, $, $$, click };
}

function scripted(): { rt: MockRuntime; undos: string[] } {
  const rt = new MockRuntime();
  const undos: string[] = [];
  loadScenario(rt, { onUndo: (id) => undos.push(id) });
  return { rt, undos };
}

const decision = (id: string, at: number, extra: Partial<Parameters<typeof makeDecision>[0]> = {}) =>
  makeDecision({
    id,
    at,
    trigger: "failure",
    subject: `The request #${id.slice(1)} failed with 503.`,
    diagnosisProbabilities: { failing: 0.8, expected: 0.2 },
    probabilities: { deliver: 0.9, retry: 0.1 },
    tier: "passive",
    executed: true,
    facts: [`The request #${id.slice(1)} failed: HTTP 503 after 0.05s; the app has not seen the failure yet.`],
    ...extra,
  });

describe("devtools: mount", () => {
  it("mounts a host with an open shadow root and unmounts without leftovers", async () => {
    const rt = new MockRuntime();
    const before = { styles: document.querySelectorAll("style").length, sheets: document.styleSheets.length, body: document.body.children.length };
    const { h, host } = mount(rt);
    await frame();
    expect(host.tagName.toLowerCase()).toBe("genclass-devtools");
    expect(host.parentElement).toBe(document.body);
    expect(host.shadowRoot).toBeTruthy();
    expect(host.hasAttribute("data-genclass-ignore")).toBe(true);
    expect(rt.listenerCount("event")).toBe(1);
    expect(rt.listenerCount("act")).toBe(1);
    expect(rt.plugins.length).toBe(1);
    expect(document.querySelectorAll("style").length).toBe(before.styles);
    expect(document.styleSheets.length).toBe(before.sheets);

    h.unmount();
    expect(document.querySelector("genclass-devtools")).toBeNull();
    expect(document.body.children.length).toBe(before.body);
    for (const t of ["event", "act", "detect", "decide", "status", "report"] as const) expect(rt.listenerCount(t)).toBe(0);
    expect(rt.plugins.length).toBe(0);
    expect(h.element).toBeNull();
    h.unmount(); // idempotent
  });

  it("keeps every style inside the shadow root (no global CSS leakage)", async () => {
    const rt = new MockRuntime();
    document.body.innerHTML = '<button class="app">Buy</button>';
    const htmlStyle = document.documentElement.getAttribute("style");
    const { sr, host } = mount(rt, { collapsed: false });
    await frame();
    // the stylesheet lives in the shadow root (constructable sheet or <style> inside it), never in the document
    const inShadow = (sr as ShadowRoot & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets?.length || sr.querySelectorAll("style").length;
    expect(inShadow).toBeGreaterThan(0);
    expect(document.head.querySelectorAll("style, link").length).toBe(0);
    expect(document.documentElement.getAttribute("style")).toBe(htmlStyle);
    expect(document.body.getAttribute("style")).toBeNull();
    expect((document.querySelector(".app") as HTMLElement).getAttribute("style")).toBeNull();
    // the only inline style outside the shadow root is the host's own reset + position
    expect(host.style.position).toBe("fixed");
    expect(host.style.zIndex).toBe("2147483646");
    // and the sheet never targets document-level selectors
    expect(CSS).not.toMatch(/(^|[\s,}])(html|body|:root)\s*[{,]/);
  });

  it("returns a no-op handle without a runtime", () => {
    const h = mountDevtools(null as never);
    expect(h.element).toBeNull();
    h.open();
    h.close();
    h.unmount();
  });

  it("honours theme and position", async () => {
    const rt = new MockRuntime();
    const { $, host } = mount(rt, { theme: "dark", position: "top-left" });
    await frame();
    const root = $(".root") as HTMLElement;
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.pos).toBe("top-left");
    expect(host.style.top).toBe("16px");
    expect(host.style.left).toBe("16px");
  });
});

describe("devtools: feeds", () => {
  it("renders interventions, detections, status and counters from the runtime", async () => {
    const { rt } = scripted();
    const { $, $$, click } = mount(rt, { collapsed: false });
    await frame();
    expect($(".pc.a b")?.textContent).toBe("3");
    expect($(".pc.d b")?.textContent).toBe("3");
    expect($(".st b")?.textContent).toBe("Model ready");
    expect($(".st .sm")?.textContent).toContain("WebGPU");

    const cards = $$('[data-pane="interventions"] article.card');
    expect(cards.map((c) => c.dataset.id)).toEqual(["a3", "a2", "a1"]); // newest first
    expect(cards.map((c) => c.querySelector(".ct")?.textContent)).toEqual([
      "Slowed down a failing request",
      "Prevented a duplicate request",
      "Prevented a stale write",
    ]);
    const a1 = cards[2];
    expect(a1.querySelector(".chg")?.textContent).toContain("Dropped the write to search.results");
    // reports emitted before mounting are not replayed: the body is the runtime's lead fact
    expect(a1.querySelector(".cx")?.textContent).toBe(rt.decs[0].facts[0]);
    expect(a1.querySelector(".chip.t-brand")?.textContent).toContain("stale");
    expect(a1.querySelector(".chip.t-brand")?.textContent).toContain("97%");
    expect(a1.querySelector('[data-act="undo"]')).toBeTruthy();
    expect(cards[1].querySelector('[data-act="undo"]')).toBeNull(); // coalesce has no undo

    await click('[data-tab="detections"]');
    const dets = $$('[data-pane="detections"] article.card');
    expect(dets.map((c) => c.querySelector(".ct")?.textContent)).toEqual(["Slow request", "Inconsistent state", "Unusual state change"]);
    expect(dets[0].querySelector(".note")?.textContent).toBe("Would have run hedge in heal mode.");
  });

  it("renders the activity timeline, pairing op start and end", async () => {
    const { rt } = scripted();
    const { $$, click } = mount(rt, { collapsed: false });
    await click('[data-tab="activity"]');
    const rows = $$('[data-pane="activity"] .ev');
    const starts = rt.events.filter((e) => e.kind === "op.start").length;
    const ends = rt.events.filter((e) => e.kind === "op.end").length;
    expect(rows.length).toBe(rt.events.length - Math.min(starts, ends));
    const rea = rows.find((r) => r.querySelector(".m")?.textContent?.startsWith("GET /api/search?q=rea"));
    expect(rea?.querySelector(".x")?.textContent).toBe("2001.82 s");
    expect(rea?.querySelector(".id")?.textContent).toBe("#3");
    const recs = rows.find((r) => r.querySelector(".m")?.textContent?.startsWith("GET /api/recommendations"));
    expect(recs?.querySelector(".spin")).toBeTruthy(); // still in flight
    const state = rows.find((r) => r.dataset.g === "state");
    expect(state?.querySelector(".id")?.textContent).toMatch(/^← #\d+$/);

    // filters hide whole groups; the text filter matches row text
    await click('.f[data-g="op"]');
    expect(rows.filter((r) => r.dataset.g === "op").every((r) => r.hidden)).toBe(true);
    expect(rows.filter((r) => r.dataset.g === "user").some((r) => !r.hidden)).toBe(true);
    const q = (rows[0].getRootNode() as ShadowRoot).querySelector("input.q") as HTMLInputElement;
    q.value = "qty";
    q.dispatchEvent(new Event("input"));
    expect(rows.filter((r) => !r.hidden).map((r) => r.dataset.g)).toEqual(["user"]);

    // rows expand to their data
    const user = rows.find((r) => r.dataset.g === "user" && !r.hidden) as HTMLElement;
    user.click();
    expect(user.getAttribute("aria-expanded")).toBe("true");
    expect(user.querySelector(".evx")?.textContent).toContain("value: 3");
    expect(user.querySelector(".evx")?.textContent).toContain("op: #17");
  });

  it("updates one activity row when the runtime re-emits a growing typing burst", async () => {
    const rt = new MockRuntime();
    const { $$, click } = mount(rt, { collapsed: false });
    await click('[data-tab="activity"]');
    const e = rt.event("user", 'type input "Search"', { op: 1, data: { kind: "type", value: '"r"', count: 1 } });
    await frame();
    e.data = { ...e.data, value: '"rea"', count: 3 };
    e.op = 3;
    rt.emitTo("event", e);
    await frame();
    const rows = $$(".ev");
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector(".m")?.textContent).toBe('type input "Search" = "rea" (3 keystrokes)#3');
  });

  it("shows the evidence: facts, answers, timeline and the exact situation text", async () => {
    const { rt } = scripted();
    const { $, click } = mount(rt, { collapsed: false });
    await frame();
    await click('[data-id="a1"] [data-act="evidence"]');
    const ev = $('[data-id="a1"] .evd') as HTMLElement;
    expect(ev).toBeTruthy();
    expect(rt.calls.explain).toContain("a1");
    const ex = rt.explanations.get("a1")!;
    expect([...ev.querySelectorAll(".facts li")].map((li) => li.textContent)).toEqual(ex.facts);
    expect(ev.querySelector('[data-part="situation"]')?.textContent).toBe(ex.situationText);
    const diag = ev.querySelector('.ans[data-q="diagnosis"]') as HTMLElement;
    expect(diag.querySelector(".bl.top")?.textContent).toBe("stale");
    expect(diag.querySelector(".bp.top")?.textContent).toBe("97%");
    expect(ev.textContent).toContain('policy: { deny: ["discard"] }');
    expect($('[data-id="a1"] [data-act="evidence"]')?.getAttribute("aria-expanded")).toBe("true");
    await click('[data-id="a1"] [data-act="evidence"]');
    expect($('[data-id="a1"] .evd')).toBeNull();
  });

  it("undo calls ActionRecord.undo once and marks the card", async () => {
    const { rt, undos } = scripted();
    const { $, click } = mount(rt, { collapsed: false });
    await frame();
    await click('[data-id="a1"] [data-act="undo"]');
    expect(undos).toEqual(["a1"]);
    expect($('[data-id="a1"]')?.classList.contains("undone")).toBe(true);
    expect($('[data-id="a1"] [data-act="undone"]')).toBeTruthy();
    expect($('[data-id="a1"] [data-act="undo"]')).toBeNull();
  });

  it("reports an undo that throws instead of marking it undone", async () => {
    const rt = new MockRuntime();
    rt.setStatus({ state: "ready" });
    const d = rt.decision(decision("d9", 100, { trigger: "mutation", subject: "A write to x.", diagnosisProbabilities: { stale: 0.95, expected: 0.05 }, probabilities: { discard: 0.96, apply: 0.04 }, tier: "guard" }));
    rt.act(makeAction(d, { id: "a9", changed: "Dropped it.", undo: () => { throw new Error("store gone"); } }));
    const { $, click } = mount(rt, { collapsed: false });
    await frame();
    await click('[data-id="a9"] [data-act="undo"]');
    expect($('[data-id="a9"] .err')?.textContent).toBe("Undo failed: store gone");
    expect($('[data-id="a9"]')?.classList.contains("undone")).toBe(false);
  });

  it("adds live interventions and pulses the collapsed pill", async () => {
    const rt = new MockRuntime();
    const { $, $$, h } = mount(rt);
    await frame();
    expect($(".pill")?.hidden).toBe(false);
    expect($(".panel")?.hidden).toBe(true);
    const d = rt.decision(decision("d1", 50, { trigger: "request", subject: "POST /api/orders is about to be sent.", facts: [], diagnosisProbabilities: { duplicate: 0.95, expected: 0.05 }, probabilities: { coalesce: 0.96, send: 0.04 }, tier: "guard" }));
    rt.act(makeAction(d, { id: "a1", changed: "Did not send it." }));
    await frame();
    expect($(".pill")?.classList.contains("pa")).toBe(true);
    expect($(".pc.a b")?.textContent).toBe("1");
    expect($(".pill")?.getAttribute("aria-label")).toContain("1 interventions");
    h.open();
    await frame();
    expect($$('[data-pane="interventions"] article.card').length).toBe(1);
    expect($('[data-pane="interventions"] .ct')?.textContent).toBe("Prevented a duplicate request");
    expect($('[data-pane="interventions"] .cx')?.textContent).toBe("POST /api/orders is about to be sent.");

    // the runtime's own report sentence, when it arrives, becomes the card text (minus what the note already says)
    rt.report({
      kind: "intervene",
      message: "[GenClass] Prevented a duplicate request: An identical POST /api/orders request is in flight (#7). Did not send it. (duplicate, 0.95; coalesce 0.96)",
      decision: d,
      action: rt.acts[0],
    });
    await frame();
    expect($('[data-pane="interventions"] .cx')?.textContent).toBe("An identical POST /api/orders request is in flight (#7).");
    expect($('[data-pane="interventions"] .chg')?.textContent).toBe("Did not send it.");
  });

  it("folds repeated detections into one card and moves acted decisions to interventions", async () => {
    const rt = new MockRuntime();
    rt.setStatus({ state: "ready" });
    const { $, $$, click } = mount(rt, { collapsed: false });
    rt.decision(decision("d1", 1000));
    rt.decision(decision("d2", 3000));
    rt.decision(decision("d3", 5000));
    await click('[data-tab="detections"]');
    const cards = $$('[data-pane="detections"] article.card');
    expect(cards.length).toBe(1);
    expect(cards[0].querySelector(".ct")?.textContent).toBe("Failing request");
    expect(cards[0].querySelector(".rep")?.textContent).toBe("×3");
    expect(cards[0].querySelector(".note")?.textContent).toBe("The model chose deliver: nothing was changed.");
    expect($(".pc.d b")?.textContent).toBe("3");

    // an executed non-passive decision is an intervention, never a detection
    const d4 = rt.decision(decision("d4", 6000, { trigger: "request", subject: "GET /api/status is about to be sent.", diagnosisProbabilities: { failing: 0.91, expected: 0.09 }, probabilities: { delay: 0.93, send: 0.07 }, tier: "guard" }));
    await frame();
    expect($$('[data-pane="detections"] article.card').length).toBe(1);
    rt.act(makeAction(d4, { id: "a1", changed: "Held it for 4.0 s." }));
    await frame();
    expect($(".pc.a b")?.textContent).toBe("1");
    expect($(".pc.d b")?.textContent).toBe("3");
  });

  it("explains a decision held back by policy rather than by the mode", async () => {
    const rt = new MockRuntime();
    rt.decision(
      decision("d1", 10, {
        trigger: "mutation",
        subject: "A write to cart.total is about to apply.",
        diagnosisProbabilities: { stale: 0.8, expected: 0.2 },
        probabilities: { discard: 0.72, apply: 0.28 },
        tier: "guard",
        executed: false,
        reason: "probability 0.72 is below the guard threshold 0.9",
      }),
    );
    const { $, click } = mount(rt, { collapsed: false });
    await click('[data-tab="detections"]');
    expect($('[data-pane="detections"] .note')?.textContent).toBe("Not acted on: probability 0.72 is below the guard threshold 0.9. The model chose discard (guard).");
  });

  it("pause buffers new items until resumed; clear empties the feeds", async () => {
    const { rt } = scripted();
    const { $, $$, click } = mount(rt, { collapsed: false });
    await frame();
    await click('[data-part="pause"]');
    expect($('[data-part="pause"]')?.getAttribute("aria-pressed")).toBe("true");
    const d = rt.decision(decision("d7", 27_000, { trigger: "request", subject: "GET /api/x is about to be sent.", diagnosisProbabilities: { duplicate: 0.95, expected: 0.05 }, probabilities: { coalesce: 0.96, send: 0.04 }, tier: "guard" }));
    rt.act(makeAction(d, { id: "a7", changed: "Reused it." }));
    await frame();
    expect($$('[data-pane="interventions"] article.card').length).toBe(3);
    expect($(".pz")?.hidden).toBe(false);
    expect($(".pz span")?.textContent).toBe("Feed paused · 1 new");
    expect($(".pc.a b")?.textContent).toBe("4"); // counters stay truthful while paused
    await click('[data-part="pause"]');
    expect($$('[data-pane="interventions"] article.card').length).toBe(4);
    expect($(".pz")?.hidden).toBe(true);

    await click('[data-part="clear"]');
    expect($$("article.card").length).toBe(0);
    expect($$(".ev").length).toBe(0);
    expect($(".pc.a b")?.textContent).toBe("0");
    expect($('[data-pane="interventions"] .empty')?.hidden).toBe(false);
  });

  it("renders the Now view from runtime.situation() and reports failures", async () => {
    const { rt } = scripted();
    const { $, click } = mount(rt, { collapsed: false });
    await click('[data-tab="now"]');
    expect(rt.calls.situation).toBeGreaterThan(0);
    const now = $(".now") as HTMLElement;
    expect(now.textContent).toContain(rt.sit!.subject);
    expect(now.textContent).toContain("salient");
    expect(now.querySelector(".op .m")?.textContent).toBe("GET /api/recommendations?for=cart");
    expect(now.querySelector(".op .x")?.textContent).toContain("5.30 s");
    rt.sit = null;
    await click('[data-tab="activity"]');
    await click('[data-tab="now"]');
    expect($(".now .note.fail")?.textContent).toContain("situation() failed");
  });
});

describe("devtools: controls", () => {
  it("switches the runtime mode", async () => {
    const { rt } = scripted();
    const { $, click } = mount(rt, { collapsed: false });
    await frame();
    expect($('[data-mode="guard"]')?.getAttribute("aria-checked")).toBe("true");
    await click('[data-mode="heal"]');
    expect(rt.calls.setMode).toEqual(["heal"]);
    expect($('[data-mode="heal"]')?.getAttribute("aria-checked")).toBe("true");
    expect($(".pm")?.textContent).toBe("heal");
  });

  it("phrases a held-back decision by the current mode when the runtime gave no reason", async () => {
    const rt = new MockRuntime();
    rt.decision(
      decision("d1", 10, {
        trigger: "stall",
        subject: "GET /api/x has been in flight for 4.0s.",
        diagnosisProbabilities: { slow: 0.85, expected: 0.15 },
        probabilities: { hedge: 0.7, wait: 0.3 },
        tier: "heal",
        executed: false,
      }),
    );
    const { $, click } = mount(rt, { collapsed: false });
    await click('[data-tab="detections"]');
    expect($('[data-pane="detections"] .note')?.textContent).toBe("Would have run hedge in heal mode.");
    await click('[data-mode="heal"]');
    expect($('[data-pane="detections"] .note')?.textContent).toBe("Not acted on: held back by policy. The model chose hedge (heal).");
  });

  it("is keyboard accessible: pill, tabs, mode radios, Escape, Alt+Shift+G", async () => {
    const { rt } = scripted();
    const { $, sr } = mount(rt);
    await frame();
    const pill = $(".pill") as HTMLButtonElement;
    expect(pill.tagName).toBe("BUTTON");
    pill.click();
    await frame();
    expect($(".panel")?.hidden).toBe(false);
    const tab = $('[data-tab="interventions"]') as HTMLElement;
    expect(sr.activeElement).toBe(tab);
    tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect($('[data-tab="detections"]')?.getAttribute("aria-selected")).toBe("true");
    expect($('[data-pane="detections"]')?.hidden).toBe(false);
    ($('[data-tab="detections"]') as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect($('[data-tab="now"]')?.getAttribute("aria-selected")).toBe("true");

    const radio = $('[data-mode="guard"]') as HTMLElement;
    radio.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(rt.calls.setMode).toEqual(["observe"]);

    ($(".panel") as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect($(".panel")?.hidden).toBe(true);
    expect(sr.activeElement).toBe(pill);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "G", code: "KeyG", altKey: true, shiftKey: true, bubbles: true }));
    expect($(".panel")?.hidden).toBe(false);
  });

  it("explains an empty feed by mode and model state", async () => {
    const rt = new MockRuntime();
    rt.setStatus({ state: "loading", progress: { loaded: 5_000_000, total: 20_000_000 } });
    const { $ } = mount(rt, { collapsed: false });
    await frame();
    expect($('[data-pane="interventions"] .empty b')?.textContent).toBe("Model loading");
    expect($(".st .sm")?.textContent).toBe("4.8 / 19.1 MB · 25%");
    expect(parseFloat(($(".sb i") as HTMLElement).style.width)).toBe(25);
    rt.setStatus({ state: "ready", device: "wasm", variant: "q8" });
    await frame();
    expect($('[data-pane="interventions"] .empty b')?.textContent).toBe("No interventions yet");
    expect($(".st .sm")?.textContent).toBe("WASM · q8");
  });
});
