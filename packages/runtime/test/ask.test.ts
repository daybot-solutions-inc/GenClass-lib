import { describe, expect, expectTypeOf, it } from "vitest";
import { createRuntime, GenClassUnavailableError } from "../src/index.js";
import type { ChoiceAnswer, NoulAnswer, ScoreAnswer } from "../src/types.js";
import { FakeClock, ManualDecider, choice, setup } from "./helpers.js";

describe("ask / decide (CONTRACT §2)", () => {
  it("ask() sends the current situation (trigger ask) with the question and returns a typed answer", async () => {
    const { rt, decider } = setup({
      script: (req) => {
        const q = req.questions.answer;
        if (q.type === "choice") return { answer: choice("checkout", Object.keys(q.criteria)) };
        if (q.type === "noul") return { answer: { type: "noul", noul: 0.2 } };
        return { answer: { type: "score", score: 1.4, confidence: 0.5, probabilities: { "0": 0.2, "1": 0.2, "2": 0.6 } } };
      },
    });
    const a = await rt.ask({ type: "choice", instructions: "Where is the user stuck?", criteria: { search: null, checkout: "the payment step" } });
    expectTypeOf(a).toEqualTypeOf<ChoiceAnswer<"search" | "checkout">>();
    expect(a.choice).toBe("checkout");
    const n = await rt.ask({ type: "noul", instructions: "Is the cart empty?" });
    expectTypeOf(n).toEqualTypeOf<NoulAnswer>();
    expect(n.noul).toBe(0.2);
    const s = await rt.ask({ type: "score", instructions: "How busy is the app?", criteria: ["idle", "some", "busy"] });
    expectTypeOf(s).toEqualTypeOf<ScoreAnswer>();
    expect(s.score).toBe(1.4);
    expect(decider.calls[0].trigger).toBe("ask");
    expect(Object.keys(decider.calls[0].questions)).toEqual(["answer"]);
    expect(decider.calls[0].state.trigger).toBe("The developer asks about the app right now.");
  });

  it("decide() returns the chosen label, typed", async () => {
    const { rt } = setup({ script: (req) => ({ answer: choice("later", Object.keys((req.questions.answer as { criteria: object }).criteria)) }) });
    const l = await rt.decide("Show the upsell now?", { now: "the user is idle", later: "the user is busy" });
    expectTypeOf(l).toEqualTypeOf<"now" | "later">();
    expect(l).toBe("later");
  });

  it("ask about an op or a store focuses the situation", async () => {
    const { rt, clock, server, fetch, decider } = setup();
    server.on("GET", "/api/x", { body: 1, latency: 10 });
    const p = fetch("/api/x");
    await clock.advance(20);
    await p;
    const op = [...rt.ops.byId.values()].find((o) => o.kind === "fetch")!;
    await rt.ask({ type: "noul", instructions: "Was it fast?" }, { about: op.id });
    expect(decider.calls[0].state.trigger).toMatch(/The developer asks about GET \/api\/x \(#\d+\)\./);
    rt.atom("cart", { n: 1 });
    await rt.ask({ type: "noul", instructions: "Is it ok?" }, { about: "cart" });
    expect(decider.calls[1].state.trigger).toBe("The developer asks about the store cart.");
  });

  it("rejects with GenClassUnavailableError when there is no model", async () => {
    const rt = createRuntime({ clock: new FakeClock(), global: {}, report: "silent" });
    await expect(rt.ask({ type: "noul", instructions: "?" })).rejects.toBeInstanceOf(GenClassUnavailableError);
    expect(rt.status.state).toBe("off");
    await expect(rt.ready).resolves.toBeUndefined();
  });

  it("times out with GenClassUnavailableError (reason timeout)", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual });
    const p = rt.ask({ type: "noul", instructions: "?" }, { timeoutMs: 100 });
    let err: unknown;
    p.catch((e) => (err = e));
    await clock.advance(150);
    expect(err).toBeInstanceOf(GenClassUnavailableError);
    expect((err as GenClassUnavailableError).reason).toBe("timeout");
  });
});
