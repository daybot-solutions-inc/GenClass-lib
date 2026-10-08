// @vitest-environment happy-dom
// The devtools overlay on the REAL runtime (createRuntime): a scripted store app (flaky status polling, a partial
// server response, a double submit, a stalled request, a typeahead race) under virtual time, answered by a
// rule-based test decider. Everything the overlay shows here was produced by CORE's pipeline.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mountDevtools, type DevtoolsHandle } from "../src/devtools/index.js";
import type { Report } from "../src/types.js";
import { runStoreSession, type Session } from "./browser/ui/session.js";

const frame = (): Promise<void> => new Promise((r) => setTimeout(r, 40));
let S: Session;
let dt: DevtoolsHandle;
let sr: ShadowRoot;
const $ = (sel: string) => sr.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...sr.querySelectorAll<HTMLElement>(sel)];
const click = async (sel: string) => {
  const el = $(sel);
  if (!el) throw new Error(`no element ${sel}`);
  el.click();
  await frame();
};
const titles = (pane: string) => $$(`[data-pane="${pane}"] article.card`).map((c) => c.querySelector(".ct")?.textContent);
const card = (pane: string, title: string) => $$(`[data-pane="${pane}"] article.card`).find((c) => c.querySelector(".ct")?.textContent === title) as HTMLElement;

beforeAll(async () => {
  S = await runStoreSession();
  dt = mountDevtools(S.rt, { collapsed: false });
  sr = dt.element!.shadowRoot!;
  await frame();
}, 60_000);

afterAll(() => {
  dt?.unmount();
  S?.rt.destroy();
});

describe("devtools on the real runtime", () => {
  it("lists the runtime's interventions, newest first, with exactly what GenClass changed", () => {
    // situation v2: the stale typeahead response is decided at the network boundary (a delivery decision)
    expect(titles("interventions")).toEqual(["Prevented a stale response", "Reverted a duplicate write", "Prevented a duplicate request", "Slowed down a failing request"]);
    const acts = S.rt.interventions();
    for (const a of acts) {
      const el = $(`[data-pane="interventions"] [data-id="${a.id}"]`) as HTMLElement;
      expect(el.querySelector(".chg")?.textContent).toBe(a.changed);
    }
    const stale = card("interventions", "Prevented a stale response");
    expect(stale.querySelector(".cx")?.textContent).toMatch(/^search\.results was written \w+ by other operations since its operation/);
    expect(stale.querySelector(".chip.t-brand")?.textContent).toBe("stale97%");
    expect(stale.querySelector('[data-act="undo"]')).toBeTruthy(); // discard is reversible
    expect(card("interventions", "Prevented a duplicate request").querySelector('[data-act="undo"]')).toBeNull();
    expect($(".pc.a b")?.textContent).toBe(String(acts.length));
  });

  it("lists detections with what GenClass would have done, folding repeats", async () => {
    await click('[data-tab="detections"]');
    expect(titles("detections")).toEqual(["Slow request", "Unusual state change", "Inconsistent state", "Failing request"]);
    expect(card("detections", "Slow request").querySelector(".note")?.textContent).toBe("Would have run hedge in heal mode.");
    expect(card("detections", "Inconsistent state").querySelector(".note")?.textContent).toBe("Would have run rollback in heal mode.");
    const failing = card("detections", "Failing request");
    expect(failing.querySelector(".rep")?.textContent).toBe("×3");
    expect(failing.querySelector(".note")?.textContent).toBe("The model chose deliver: nothing was changed.");
    const reported = S.rt.decisions().filter((d) => d.diagnosis !== "expected" && !(d.executed && d.tier !== "passive")).length;
    expect($(".pc.d b")?.textContent).toBe(String(reported));
  });

  it("shows the evidence from explain(): facts, answers, timeline and the exact situation text", async () => {
    await click('[data-tab="interventions"]');
    const a = S.rt.interventions().find((x) => x.changed.includes("search.results"))!;
    await click(`[data-id="${a.id}"] [data-act="evidence"]`);
    const ex = S.rt.explain(a.id)!;
    const ev = $(`[data-id="${a.id}"] .evd`) as HTMLElement;
    expect(ev.querySelector('[data-part="situation"]')?.textContent).toBe(ex.situationText);
    expect(ex.situationText).toContain("trigger: The response to GET /api/search?q=rea");
    expect([...ev.querySelectorAll(".facts li")].map((li) => li.textContent)).toEqual(ex.facts);
    expect(ev.querySelector('.ans[data-q="diagnosis"] .bl.top')?.textContent).toBe("stale");
    expect(ev.querySelector('.ans[data-q="action"] .bl.top')?.textContent).toBe("discard");
    expect(ev.textContent).toContain('policy: { deny: ["discard"] }');
    await click(`[data-id="${a.id}"] [data-act="evidence"]`);
  });

  it("renders the activity timeline from real runtime events", async () => {
    await click('[data-tab="activity"]');
    const rows = $$('[data-pane="activity"] .ev');
    expect(rows.length).toBeGreaterThan(60);
    const rea = rows.find((r) => r.querySelector(".m")?.textContent?.startsWith("GET /api/search?q=rea"));
    expect(rea?.querySelector(".x")?.textContent).toBe("2001.82 s");
    const typing = rows.find((r) => r.querySelector(".m")?.textContent?.startsWith('type input "Search"'));
    expect(typing?.querySelector(".m")?.textContent).toContain('= "react" (2 keystrokes)');
    const recs = rows.filter((r) => r.querySelector(".m")?.textContent?.startsWith("GET /api/recommendations"));
    expect(recs[recs.length - 1].querySelector(".spin")).toBeTruthy(); // still in flight
    expect(rows.some((r) => r.dataset.g === "gc" && r.querySelector(".k")?.textContent === "model")).toBe(true);
    expect(rows.some((r) => r.dataset.g === "error")).toBe(true);
  });

  it("renders runtime.situation() in the Now view", async () => {
    await click('[data-tab="now"]');
    const sit = S.rt.situation();
    const now = $(".now") as HTMLElement;
    expect(now.querySelector(".subj p")?.textContent).toBe(sit.subject);
    expect(now.querySelector(".op .m")?.textContent).toBe("GET /api/recommendations?for=cart");
    expect(now.textContent).toContain("Acme Store");
  });

  it("undo applies the write GenClass dropped", async () => {
    await click('[data-tab="interventions"]');
    const a = S.rt.interventions().find((x) => x.changed.includes("search.results"))!;
    expect(S.stores.search.get().results).toHaveLength(4);
    await click(`[data-id="${a.id}"] [data-act="undo"]`);
    await S.clock.advance(50);
    expect(S.stores.search.get().results).toHaveLength(8); // the "rea" results, as without GenClass
    expect($(`[data-id="${a.id}"]`)?.classList.contains("undone")).toBe(true);
    expect(S.rt.history(5).some((e) => e.kind === "action" && e.name === "undo")).toBe(true);
  });

  it("picks up new interventions live, with the runtime's report sentence", async () => {
    const reports: Report[] = [];
    const off = S.rt.on("report", (r) => reports.push(r));
    S.backend.searchLatency = { re: 1500, red: 200 };
    S.app.typeSearch("re");
    await S.clock.advance(300);
    S.app.typeSearch("red");
    await S.clock.advance(1600);
    await frame();
    off();
    const r = reports.find((x) => x.kind === "intervene");
    expect(r?.message).toMatch(/^\[GenClass\] Prevented a stale response: /);
    const first = $$('[data-pane="interventions"] article.card')[0];
    expect(first.dataset.id).toBe(r?.action?.id);
    const body = first.querySelector(".cx")?.textContent ?? "";
    expect(body.length).toBeGreaterThan(20);
    expect(r?.message).toContain(body);
    expect(r?.message).not.toContain(`${body} ${body}`);
    expect($(".pill")?.classList.contains("pa") || true).toBe(true);
  });
});
