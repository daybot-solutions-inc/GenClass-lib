// REVIEW: built-in actions (applicability and effect). A failing test demonstrates a bug.
import { describe, expect, it } from "vitest";
import { defaultScript, setup } from "./helpers.js";

describe("review: rollback on an error trigger", () => {
  it("is offered only when the failing chain wrote state, and never reverts other chains' writes (user input)", async () => {
    const { rt, clock, server, fetch, decider } = setup({ mode: "heal", script: defaultScript({ error: { diagnosis: "inconsistent", action: "rollback" } }) });
    server.on("POST", "/api/save", { body: { ok: true }, latency: 300 });
    const note = rt.atom("note", { text: "" });
    const other = rt.atom("profile", { name: "Ada" });
    // a settled point so a consistent snapshot exists
    other.set({ name: "Ada L." });
    await clock.advance(200);
    // the user clicks Save: the save chain reads the response and then hits a bug; it writes no state
    rt.user({ kind: "click", target: 'button "Save"' }, () => {
      void (async () => {
        const r = await fetch("/api/save", { method: "POST", body: "{}" });
        await r.json();
        rt.reportError(new TypeError("Cannot read properties of undefined (reading 'id')"));
      })();
    });
    await clock.advance(50);
    // meanwhile the user types a note (a different chain, different store)
    rt.user({ kind: "type", target: 'textarea "Note"', value: "hello" }, () => note.set({ text: "hello" }));
    await clock.advance(1000);
    const call = decider.calls.find((c) => c.trigger === "error")!;
    expect(call).toBeDefined();
    const facts = call.state.facts as string[];
    expect(facts).toContain("Its chain wrote no state before the error.");
    // contract §6: rollback* only when "the failing op wrote state"; and the user's note must survive
    expect({
      offered: Object.keys((call.questions.action as { criteria?: object } | undefined)?.criteria ?? {}),
      note: note.get(),
      changed: rt.interventions().map((a) => a.changed),
    }).toEqual({ offered: [], note: { text: "hello" }, changed: [] });
  });
});
