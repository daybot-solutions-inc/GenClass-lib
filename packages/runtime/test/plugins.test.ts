import { describe, expect, it } from "vitest";
import type { Plugin } from "../src/types.js";
import { choice, defaultScript, setup } from "./helpers.js";

describe("plugins, custom actions and standing questions (CONTRACT §9)", () => {
  it("plugin facts, diagnoses and custom actions reach the model; the custom action runs", async () => {
    const ran: string[] = [];
    const plugin: Plugin = {
      name: "inventory",
      facts: (d) => (d.trigger === "mutation" ? [`The warehouse reports ${d.mutation?.store} is being restocked.`] : []),
      diagnoses: { restock: "the inventory is being restocked and numbers are temporarily off" },
      actions: [
        {
          name: "notify_ops",
          description: "tell the operations team and keep the write",
          on: ["mutation"],
          tier: "guard",
          run: async (ctx) => {
            ran.push(ctx.decision.id);
            ctx.describe("Sent a note to the operations team; the write was applied.");
          },
        },
      ],
    };
    const { rt, clock, decider } = setup({
      triage: "always",
      plugins: [plugin],
      script: (req) => ({
        diagnosis: choice("restock", Object.keys((req.questions.diagnosis as { criteria: object }).criteria)),
        action: choice("notify_ops", Object.keys((req.questions.action as { criteria: object }).criteria)),
      }),
    });
    const stock = rt.atom("stock", { n: 5 });
    void rt.op("sync", () => stock.set({ n: 4 }));
    await clock.flush();
    const req = decider.calls[0];
    expect((req.state.facts as string[]).some((f) => f.includes("The warehouse reports stock is being restocked."))).toBe(true);
    expect((req.questions.diagnosis as { criteria: Record<string, string> }).criteria.restock).toMatch(/restocked/);
    expect((req.questions.action as { criteria: Record<string, string> }).criteria.notify_ops).toBe("tell the operations team and keep the write");
    expect(ran.length).toBe(1);
    expect(stock.get()).toEqual({ n: 4 }); // custom action did not take over: passive (apply) ran after it
    const rec = rt.interventions()[0];
    expect(rec.action).toBe("notify_ops");
    expect(rec.changed).toBe("Sent a note to the operations team; the write was applied.");
  });

  it("a custom action can run a built-in action through ctx.builtin", async () => {
    const { rt, clock } = setup({
      triage: "always",
      script: (req) => ({
        diagnosis: choice("stale", Object.keys((req.questions.diagnosis as { criteria: object }).criteria)),
        action: choice("drop_and_log", Object.keys((req.questions.action as { criteria: object }).criteria)),
      }),
    });
    const logs: string[] = [];
    rt.action({
      name: "drop_and_log",
      description: "drop the write and log it",
      on: ["mutation"],
      tier: "guard",
      run: async (ctx) => {
        await ctx.builtin("discard");
        logs.push(ctx.situation.subject);
      },
    });
    const a = rt.atom("a", 1);
    void rt.op("w", () => a.set(2));
    await clock.flush();
    expect(a.get()).toBe(1);
    expect(logs.length).toBe(1);
    expect(rt.interventions()[0].changed).toMatch(/Dropped the write to a/);
  });

  it("plugin actions default to the heal tier (not run in guard mode)", async () => {
    let ran = 0;
    const { rt, clock } = setup({
      triage: "always",
      script: (req) => ({
        diagnosis: choice("stale", Object.keys((req.questions.diagnosis as { criteria: object }).criteria)),
        action: choice("fix", Object.keys((req.questions.action as { criteria: object }).criteria)),
      }),
    });
    rt.action({ name: "fix", description: "fix it", on: ["mutation"], run: () => void ran++ });
    const a = rt.atom("a", 1);
    void rt.op("w", () => a.set(2));
    await clock.flush();
    expect(ran).toBe(0);
    expect(rt.decisions()[0].reason).toMatch(/heal-tier/);
    expect(a.get()).toBe(2);
  });

  it("applicable() limits when a custom action is offered", async () => {
    const { rt, clock, decider } = setup({ triage: "always" });
    rt.action({ name: "never", description: "x", on: ["mutation"], applicable: () => false, run: () => undefined });
    const a = rt.atom("a", 1);
    void rt.op("w", () => a.set(2));
    await clock.flush();
    expect(Object.keys((decider.calls[0].questions.action as { criteria: object }).criteria)).toEqual(["apply", "discard", "defer"]);
  });

  it("standing questions are asked on their triggers and onAnswer receives the answer", async () => {
    const answers: number[] = [];
    const { rt, clock, decider, server, fetch } = setup({
      script: (req) => ({ ...defaultScript()(req), risky: { type: "noul", noul: 0.83 } }),
    });
    rt.question({ id: "risky", on: ["request"], always: true, question: { type: "noul", instructions: "Is this request risky for the user's data?" }, onAnswer: (a) => answers.push((a as { noul: number }).noul) });
    server.on("DELETE", "/api/item/7", { status: 204, latency: 10 });
    const p = fetch("/api/item/7", { method: "DELETE" });
    await clock.advance(100);
    await p;
    expect(decider.calls[0].questions.risky).toEqual({ type: "noul", instructions: "Is this request risky for the user's data?" });
    expect(answers).toEqual([0.83]);
  });

  it("setup() receives the plugin API; cleanup runs on unregister and destroy", async () => {
    const events: string[] = [];
    let cleaned = 0;
    const { rt, clock } = setup();
    const off = rt.use({
      name: "bus",
      setup(api) {
        const id = api.recordOp("task", "bus.connect", { detail: "ws" });
        api.runInOp(id, () => api.emit("bus.ready", { channel: "main" }));
        api.endOp(id, "ok");
        api.on("event", (e) => events.push(e.name));
        return () => void cleaned++;
      },
    });
    await clock.flush();
    const hist = rt.history().map((e) => `${e.kind}:${e.name}`);
    expect(hist).toContain("op.start:bus.connect");
    expect(hist).toContain("custom:bus.ready");
    off();
    expect(cleaned).toBe(1);
  });

  it("vocabulary overrides replace diagnosis labels and action descriptions", async () => {
    const { rt, clock, decider } = setup({
      triage: "always",
      vocabulary: { diagnoses: { fine: "all good", old: "an older result" }, actions: { discard: "throw this write away" } },
    });
    const a = rt.atom("a", 1);
    void rt.op("w", () => a.set(2));
    await clock.flush();
    const q = decider.calls[0].questions;
    expect(Object.keys((q.diagnosis as { criteria: object }).criteria)).toEqual(["expected", "fine", "old"]);
    expect((q.action as { criteria: Record<string, string> }).criteria.discard).toBe("throw this write away");
  });
});
