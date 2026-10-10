// The audit trail (rt.audit(), InitOptions.audit; src/decide/audit.ts): one JSON-serialisable entry per decision,
// action, undo, breaker event and control change, with the mode, profile, gate values and model hash in force. It
// never changes what the model reads (packages/runtime/INTERCEPTION.md "Audit trail").
import { describe, expect, it, vi } from "vitest";
import type { AuditEntry, EvaluateRequest } from "../src/types.js";
import { AUDIT_SCHEMA } from "../src/index.js";
import { drain, setup, type Setup } from "./helpers.js";
import { Adversary, harmful } from "./invariants/adversary.js";

/** The out-of-order search: "a" (slow) answers after "ab" (fast); a hostile model discards its stale delivery. */
async function staleSearch(s: Setup): Promise<void> {
  s.server.on("GET", "/api/search", ({ url }) => {
    const q = url.searchParams.get("q") ?? "";
    return { body: { items: [`${q}-1`] }, latency: q === "a" ? 600 : 100 };
  });
  const st = s.rt.atom("search", { items: [] as string[] });
  const load = (q: string) =>
    s.rt.user({ kind: "type", target: 'input "Search"', value: q }, () => {
      void s.fetch(`/api/search?q=${q}&token=s3cret`).then(async (r) => {
        const d = (await r.json()) as { items: string[] };
        st.set((v) => ({ ...v, items: d.items }));
      });
    });
  load("z");
  await s.clock.advance(300);
  load("a");
  await s.clock.advance(20);
  load("ab");
  await s.clock.advance(2000);
}

function hostile(extra: Parameters<typeof setup>[0] = {}): Setup & { adv: Adversary } {
  const adv = new Adversary(harmful);
  const s = setup({ mode: "guard", decider: adv, ...extra });
  adv.clock = s.clock;
  adv.status = { state: "ready", model: "genclass-runtime-r17", version: "2.0.0", variant: "q8", device: "wasm", sha256: "ab".repeat(32) };
  return { ...s, adv };
}

describe("rt.audit() (audit trail)", () => {
  it("records decisions, the action, its undo and control changes, with mode, profile, gates and the model hash", async () => {
    const s = hostile({ breaker: false, aggressiveness: "eager" });
    s.rt.setMode("guard");
    await staleSearch(s);
    const rec = s.rt.interventions().find((a) => a.action === "discard")!;
    expect(rec).toBeTruthy();
    rec.undo!();
    s.rt.pause();
    s.rt.resume();
    s.rt.setAggressiveness("cautious");
    const log = s.rt.audit();
    // gap-free sequence numbers, schema, every entry plain JSON
    expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
    expect(log.every((e) => e.schema === AUDIT_SCHEMA && e.sessionId === log[0].sessionId)).toBe(true);
    expect(JSON.parse(JSON.stringify(log))).toEqual(log);
    const kinds = log.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["control", "decision", "action", "undo"]));
    // the delivery decision that acted
    const d = log.find((e) => e.kind === "decision" && e.decisionId === rec.decisionId)!;
    expect(d).toMatchObject({ trigger: "delivery", mode: "guard", requestedMode: "guard", aggressiveness: 1, profile: "eager", ran: "discard", executed: true, tier: "guard", held: true });
    expect(d.model).toEqual({ name: "genclass-runtime-r17", state: "ready", version: "2.0.0", variant: "q8", device: "wasm", sha256: "ab".repeat(32) });
    expect(d.gate).toMatchObject({ kind: "mass", candidate: "discard", thresholds: { guard: expect.any(Number), heal: expect.any(Number), report: expect.any(Number) } });
    expect(d.gate!.mass).toBeGreaterThanOrEqual(d.gate!.threshold!);
    expect(d.probabilities?.discard).toBe(1);
    expect(typeof d.holdBudgetMs).toBe("number");
    // query values never appear (subjects, what changed)
    expect(JSON.stringify(log)).not.toContain("s3cret");
    // the action and its undo
    const a = log.find((e) => e.kind === "action" && e.actionId === rec.id)!;
    expect(a).toMatchObject({ decisionId: rec.decisionId, ran: "discard", ok: true, undoable: true, tier: "guard" });
    expect(a.changed).toContain("Delivered");
    const u = log.find((e) => e.kind === "undo")!;
    expect(u).toMatchObject({ actionId: rec.id, ran: "discard", byRuntime: false });
    // control changes, from/to
    const ctl = log.filter((e) => e.kind === "control").map((e) => e.control);
    expect(ctl).toEqual([{ what: "setMode", from: "guard", to: "guard" }, { what: "pause" }, { what: "resume" }, { what: "setAggressiveness", from: 1, to: 0 }]);
    // every decision says what the model proposed, what ran and against which gate
    expect(log.filter((e) => e.kind === "decision").every((e) => !!e.proposed && !!e.ran && !!e.gate && !!e.trigger)).toBe(true);
  });

  it("records breaker trips and resets, and disable() (with the runtime's own undos marked)", async () => {
    const s = hostile();
    for (let i = 0; i < 2; i++) {
      await staleSearch(s);
      s.rt.interventions().filter((a) => a.action === "discard" && a.undo).at(-1)!.undo!();
    }
    expect(s.rt.breaker.tripped).toBe(true);
    s.rt.breaker.reset();
    await staleSearch(s);
    s.rt.disable({ undo: true });
    const log = s.rt.audit();
    const br = log.filter((e) => e.kind === "breaker").map((e) => e.breaker);
    expect(br[0]).toMatchObject({ tripped: true, reason: "undos", counts: { undos: 2 } });
    expect(br[0]!.decisionIds.length).toBeGreaterThan(0);
    expect(br[1]).toMatchObject({ tripped: false, reason: "reset" });
    const trip = log.find((e) => e.kind === "breaker")!;
    expect(trip.mode).toBe("observe"); // the session's effective mode after the trip
    expect(log.filter((e) => e.kind === "undo" && e.byRuntime).length).toBeGreaterThan(0);
    expect(log.at(-1)).toMatchObject({ kind: "control", control: { what: "disable", from: "on", to: "disabled (undo)" } });
    // still readable after destroy
    expect(s.rt.audit().length).toBe(log.length);
  });

  it("the sink gets every entry once, in order, after the current task (never on a hold path); a throwing sink is contained", async () => {
    const got: AuditEntry[] = [];
    const calledSync: boolean[] = [];
    let sync = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const s = hostile({
      audit: {
        sink: (e) => {
          calledSync.push(sync);
          got.push(e);
          if (e.seq === 2) throw new Error("logging is down");
        },
      },
    });
    s.rt.setMode("guard");
    sync = false;
    await drain();
    sync = true;
    s.rt.pause();
    s.rt.resume();
    sync = false;
    await staleSearch(s);
    await drain();
    expect(calledSync.length).toBeGreaterThan(2);
    expect(calledSync.every((x) => !x)).toBe(true);
    expect(got.map((e) => e.seq)).toEqual(s.rt.audit().map((e) => e.seq));
    expect(got).toEqual(s.rt.audit());
    expect(warn.mock.calls.some((c) => String(c[0]).includes("audit sink failed"))).toBe(true);
    warn.mockRestore();
  });

  it("is bounded: size keeps the newest entries (sequence numbers keep counting); size 0 keeps none but the sink still gets all", async () => {
    const s = hostile({ audit: { size: 3 } });
    for (let i = 0; i < 5; i++) s.rt.setAggressiveness(i % 2 ? "eager" : "balanced");
    expect(s.rt.audit().map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(s.rt.audit(2).map((e) => e.seq)).toEqual([4, 5]);
    const got: AuditEntry[] = [];
    const z = hostile({ audit: { size: 0, sink: (e) => got.push(e) } });
    z.rt.setMode("heal");
    await drain();
    expect(z.rt.audit()).toEqual([]);
    expect(got).toHaveLength(1);
  });

  it("returns copies: editing what rt.audit() returned changes nothing", async () => {
    const s = hostile();
    s.rt.setMode("heal");
    const a = s.rt.audit();
    a[0].mode = "off";
    (a[0].control as { what: string }).what = "x";
    expect(s.rt.audit()[0]).toMatchObject({ mode: "heal", control: { what: "setMode", from: "guard", to: "heal" } });
  });

  it("never changes what the model reads: the same run with and without an audit sink sends identical evaluation requests", async () => {
    const strip = (calls: EvaluateRequest[]) => calls.map((c) => ({ trigger: c.trigger, state: c.state, questions: c.questions }));
    const a = hostile();
    await staleSearch(a);
    const b = hostile({ audit: { size: 10_000, sink: () => undefined } });
    await staleSearch(b);
    expect(b.adv.calls.length).toBeGreaterThan(0);
    expect(strip(b.adv.calls)).toEqual(strip(a.adv.calls));
  });

  it("records the reason a protected subject was not acted on", async () => {
    const s = hostile({ requests: { protect: ["preset:payments"] }, triage: "always" });
    s.server.on("POST", "/api/checkout", { status: 503, body: {}, latency: 10 });
    const p = s.fetch("/api/checkout", { method: "POST", body: "{}" }).catch(() => undefined);
    await s.clock.advance(1000);
    await p;
    const d = s.rt.audit().filter((e) => e.kind === "decision");
    expect(d.length).toBeGreaterThan(0);
    expect(d.every((e) => e.reason === "protected" || e.tier === "passive")).toBe(true);
    expect(d.some((e) => e.reason === "protected")).toBe(true);
    expect(s.rt.audit().some((e) => e.kind === "action")).toBe(false);
  });
});
