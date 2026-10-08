// REVIEW: redaction. A failing test demonstrates a bug.
import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

describe("review: a custom redact option", () => {
  it("also applies to learned-invariant facts (inconsistency situations)", async () => {
    const redact = (path: string, v: unknown) => (/email/i.test(path) ? "[redacted]" : v);
    const { rt, clock, decider } = setup({ redact });
    const user = rt.atom("user", { email: "" });
    const form = rt.atom("form", { email: "" });
    for (const e of ["a@corp.io", "b@corp.io", "c@corp.io"]) {
      // load a profile into the store and the edit form
      await rt.op("load", () => {
        user.set({ email: e });
        form.set({ email: e });
      });
      await clock.advance(200);
    }
    rt.user({ kind: "type", target: 'input "Email"', value: "x" }, () => form.set({ email: "secret.person@corp.io" }));
    await clock.advance(1200); // batch 8: relations on a store being typed into are checked after the typing burst (1 s)
    const inc = decider.calls.filter((c) => c.trigger === "inconsistency");
    expect(inc).toHaveLength(1);
    const text = JSON.stringify(inc[0].state);
    expect(text.match(/[a-z.]+@corp\.io/g) ?? []).toEqual([]);
  });
});
