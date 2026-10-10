// Invariant suite, application state (CONTRACT §4, §7, §8; OPTIONS-SPEC §4.1, §4.5). Each test names a guarantee
// about the app's own state that the runtime keeps whatever the model answers (an Adversary: probability 1 on the
// most disruptive offered action, non-"expected" diagnosis). Where the outcome legitimately depends on the model
// (a stale write may be dropped), the test pins down the set of acceptable outcomes instead of one value.
import { describe, expect, it } from "vitest";
import type { Atom, Mode } from "../../src/types.js";
import { setup, type Setup } from "../helpers.js";
import { Adversary, harmful, insist, ran } from "./adversary.js";

function hostile(mode: Mode, extra: Parameters<typeof setup>[0] = {}): Setup & { adv: Adversary } {
  const adv = new Adversary(harmful);
  const s = setup({ mode, aggressiveness: "eager", decider: adv, ...extra });
  adv.clock = s.clock;
  return { ...s, adv };
}

/** heal may answer a request with a synthetic 503 (block) whose empty body is not JSON: the app ignores it. */
const noop = () => undefined;

const click = (s: Setup, target: string, fn: () => void) => s.rt.user({ kind: "click", target: `button "${target}"` }, fn);

// ------------------------------------------------------------------------------------------------ concurrent writes

interface Profile {
  name: string;
  email: string;
  bio: string;
  avatar: string;
}

/** Two loads and a save in flight at once, each writing its own field, while the user types into a fourth. */
async function profileRun(s: Setup): Promise<{ final: Profile; seen: Profile[]; wrote: Partial<Profile> }> {
  s.server.on("GET", "/api/name", ({ n }) => ({ body: { name: `Ada ${n}` }, latency: 400 }));
  s.server.on("GET", "/api/email", ({ n }) => ({ body: { email: `ada${n}@x.test` }, latency: 50 }));
  s.server.on("PATCH", "/api/avatar", ({ n }) => ({ body: { avatar: `a${n}.png` }, latency: 200 }));
  const form = s.rt.atom<Profile>("profile", { name: "", email: "", bio: "", avatar: "" });
  const seen: Profile[] = [];
  /** The last value the app itself wrote to each field. */
  const wrote: Partial<Profile> = {};
  form.subscribe((v) => seen.push({ ...v }));
  const write = (k: keyof Profile, f: (old: string) => string) =>
    form.set((v) => {
      const next = f(v[k]);
      wrote[k] = next;
      return { ...v, [k]: next };
    });
  const round = async (k: number) => {
    click(s, "Reload name", () => void s.fetch("/api/name").then((r) => r.json()).then((d: { name: string }) => write("name", () => d.name), noop));
    click(s, "Reload email", () => void s.fetch("/api/email").then((r) => r.json()).then((d: { email: string }) => write("email", () => d.email), noop));
    click(s, "Save avatar", () =>
      void s.fetch("/api/avatar", { method: "PATCH", body: JSON.stringify({ k }) }).then((r) => r.json()).then((d: { avatar: string }) => write("avatar", () => d.avatar), noop),
    );
    for (const ch of `bio ${k}`) {
      await s.clock.advance(30);
      s.rt.user({ kind: "type", target: 'textarea "Bio"', value: ch }, () => write("bio", (old) => old + ch));
    }
    await s.clock.advance(1500);
  };
  for (let k = 1; k <= 3; k++) await round(k);
  return { final: form.get(), seen, wrote };
}

describe("invariant: legitimate concurrent writes to different fields are never dropped", () => {
  for (const mode of ["guard", "heal"] as const) {
    for (const holdWrites of [false, true]) {
      it(`${mode}${holdWrites ? " + holdWrites" : ""}: every field ends at the last value the app wrote to it; no write is discarded or reverted`, async () => {
        const s = hostile(mode, { policy: { holdWrites } });
        const run = await profileRun(s);
        expect(run.final).toEqual(run.wrote);
        expect(run.final.bio).toBe("bio 1bio 2bio 3");
        expect(ran(s.rt).filter((a) => /discard|rollback|defer/.test(a))).toEqual([]);
        if (mode === "guard") {
          // guard never substitutes a response: the result is exactly the run without GenClass
          const base = await profileRun(setup({ enabled: false }));
          expect(run.final).toEqual(base.final);
        }
      });
    }
  }
});

// ------------------------------------------------------------------------------------------------ optimistic updates

interface Todo {
  done: boolean;
  saving: boolean;
  error: string | null;
}

/** Optimistic toggle: set locally, PUT, confirm with the server's echo or roll back on failure (the app's own logic). */
function todoApp(s: Setup, server: (n: number, body: { done: boolean }) => { status: number; latency: number }) {
  s.server.on("PUT", "/api/todos/1", ({ n, body }) => {
    const b = JSON.parse(body ?? "{}") as { done: boolean };
    const r = server(n, b);
    return { status: r.status, body: r.status < 300 ? { done: b.done } : { error: "nope" }, latency: r.latency };
  });
  const todo = s.rt.atom<Todo>("todo", { done: false, saving: false, error: null });
  const values = new Set<string>();
  todo.subscribe((v) => values.add(JSON.stringify(v)));
  const toggle = () =>
    click(s, "Done", () => {
      const prev = todo.get().done;
      const next = !prev;
      todo.set((v) => ({ ...v, done: next, saving: true, error: null }));
      void s
        .fetch("/api/todos/1", { method: "PUT", body: JSON.stringify({ done: next }) })
        .then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const d = (await r.json()) as { done: boolean };
          todo.set((v) => ({ ...v, done: d.done, saving: false }));
        })
        .catch((e: unknown) => todo.set((v) => ({ ...v, done: prev, saving: false, error: String((e as Error).message) })));
    });
  return { todo, toggle, values };
}

/** The states the app's own logic can be in: initial, optimistic, confirmed, rolled back (with an HTTP error). */
function reachable(v: Todo): boolean {
  const k = `${v.done}/${v.saving}/${v.error === null ? "-" : "error"}`;
  return ["false/false/-", "true/true/-", "true/false/-", "false/false/error"].includes(k) && (v.error === null || /^HTTP \d{3}$/.test(v.error));
}

describe("invariant: optimistic update → server confirmation / rollback stays consistent", () => {
  const cases: [string, (n: number, b: { done: boolean }) => { status: number; latency: number }][] = [
    ["confirmed", () => ({ status: 200, latency: 120 })],
    ["rejected (the app rolls back)", () => ({ status: 422, latency: 120 })],
    ["server error (the app rolls back)", () => ({ status: 500, latency: 120 })],
  ];
  for (const [name, server] of cases) {
    it(`${name}, guard, default triage: the final state equals the run without GenClass`, async () => {
      const base = setup({ enabled: false });
      const bapp = todoApp(base, server);
      bapp.toggle();
      await base.clock.advance(10_000);
      const s = hostile("guard");
      const app = todoApp(s, server);
      app.toggle();
      await s.clock.advance(10_000);
      expect(app.todo.get()).toEqual(bapp.todo.get());
      expect([...app.values].every((v) => reachable(JSON.parse(v)))).toBe(true);
    });

    it(`${name}, heal, default triage: the app ends in one of its own terminal states (heal may fail a request: block)`, async () => {
      const s = hostile("heal");
      const app = todoApp(s, server);
      app.toggle();
      await s.clock.advance(10_000);
      const v = app.todo.get();
      expect(v.saving).toBe(false);
      expect(reachable(v)).toBe(true);
      expect([...app.values].every((x) => reachable(JSON.parse(x)))).toBe(true);
    });

    it(`${name}, every write consulted (triage "always"): every state is one the app's own logic produces; a hostile model can late-revert the last write within 800 ms (model-dependent, not a runtime guarantee)`, async () => {
      for (const mode of ["guard", "heal"] as const) {
        const s = hostile(mode, { triage: "always" });
        const app = todoApp(s, server);
        app.toggle();
        await s.clock.advance(10_000);
        expect(reachable(app.todo.get())).toBe(true);
        expect([...app.values].every((x) => reachable(JSON.parse(x)))).toBe(true);
      }
    });
  }

  it("two rapid toggles whose echoes arrive out of order (guard, hostile model): the result is the app's own outcome or the user's last intent, never a third state", async () => {
    const server = (n: number) => ({ status: 200, latency: n === 1 ? 600 : 60 });
    const run = async (s: Setup) => {
      const app = todoApp(s, server);
      app.toggle(); // done: true, slow echo
      await s.clock.advance(20);
      app.toggle(); // done: false, fast echo
      await s.clock.advance(5000);
      return app;
    };
    const base = await run(setup({ enabled: false }));
    const s = hostile("guard");
    const app = await run(s);
    const userIntent: Todo = { done: false, saving: false, error: null };
    expect([JSON.stringify(base.todo.get()), JSON.stringify(userIntent)]).toContain(JSON.stringify(app.todo.get()));
    for (const v of app.values) expect(base.values.has(v)).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ undo / disable

/** The out-of-order search: "a" (slow) answers after "ab" (fast): its write is stale. */
async function staleSearch(s: Setup): Promise<Atom<{ items: string[] }>> {
  s.server.on("GET", "/api/search", ({ url }) => {
    const q = url.searchParams.get("q") ?? "";
    return { body: { items: [`${q}-1`] }, latency: q === "a" ? 600 : 100 };
  });
  const st = s.rt.atom("search", { items: [] as string[] });
  const load = (q: string) =>
    s.rt.user({ kind: "type", target: 'input "Search"', value: q }, () => {
      void s.fetch(`/api/search?q=${q}`).then(async (r) => {
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
  return st;
}

describe("invariant: disable({ undo: true }) restores what the app would have without GenClass", () => {
  it("a delivery discard is undone (the dropped values apply) and every patched global is restored", async () => {
    const base = await staleSearch(setup({ enabled: false }));
    const s = hostile("guard");
    const fetchBefore = s.server.fetch;
    const st = await staleSearch(s);
    expect(ran(s.rt)).toContain("delivery:discard");
    expect(st.get()).not.toEqual(base.get());
    s.rt.disable({ undo: true });
    expect(st.get()).toEqual(base.get());
    expect(s.g.fetch).toBe(fetchBefore);
    expect(s.rt.status.state).toBe("disabled");
  });

  it("disable() without undo keeps the actions' effects; undo-window: actions older than 60 s are not rolled back", async () => {
    const s = hostile("guard");
    const st = await staleSearch(s);
    const after = st.get();
    await s.clock.advance(61_000);
    s.rt.disable({ undo: true });
    expect(st.get()).toEqual(after);
  });

  it("undoing through the action record restores the dropped write, once", async () => {
    const base = await staleSearch(setup({ enabled: false }));
    const s = hostile("guard", { breaker: false });
    const st = await staleSearch(s);
    const rec = s.rt.interventions().find((a) => a.action === "discard")!;
    rec.undo!();
    rec.undo!();
    expect(st.get()).toEqual(base.get());
    expect(s.rt.history().filter((e) => e.kind === "action" && e.name === "undo")).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------------------------------ breaker

describe("invariant: the circuit breaker demotes the session after undos (and never counts disable's own undos)", () => {
  it("two undos within the window → effective mode observe: the next stale delivery is not acted on", async () => {
    const s = hostile("guard");
    const trips: unknown[] = [];
    s.rt.on("breaker", (e) => trips.push(e));
    for (let i = 0; i < 2; i++) {
      await staleSearch(s);
      const rec = s.rt.interventions().filter((a) => a.action === "discard" && a.undo).at(-1)!;
      rec.undo!();
    }
    expect(s.rt.breaker.tripped).toBe(true);
    expect(s.rt.status.effectiveMode).toBe("observe");
    const before = s.rt.interventions().length;
    await staleSearch(s);
    expect(s.rt.interventions().length).toBe(before);
    expect(trips).toHaveLength(1);
  });

  it("rt.disable({ undo: true }) rolls back without tripping the breaker", async () => {
    const s = hostile("guard");
    await staleSearch(s);
    await staleSearch(s);
    expect(s.rt.interventions().filter((a) => a.undo).length).toBeGreaterThanOrEqual(2);
    s.rt.disable({ undo: true });
    expect(s.rt.breaker.tripped).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ held writes

describe("invariant: the hold budget caps the latency a held write gets (policy.holdWrites)", () => {
  for (const budget of [150, 300]) {
    it(`a model that always defers, related work running for 10 s: a held write applies within holdBudgetMs (${budget} ms) of being made`, async () => {
      const adv = new Adversary(insist("defer"));
      const s = setup({ mode: "guard", decider: adv, triage: "always", breaker: false, policy: { holdWrites: true, holdBudgetMs: budget } });
      adv.clock = s.clock;
      s.server.on("GET", "/api/slow", { body: { v: "slow" }, latency: 10_000 });
      s.server.on("GET", "/api/fast", { body: { v: "fast" }, latency: 20 });
      const cart = s.rt.atom("cart", { v: "" });
      const made: Record<string, number> = {};
      const applied: Record<string, number> = {};
      cart.subscribe((x) => (applied[x.v] ??= s.clock.now()));
      let n = 0;
      const load = (u: string) =>
        void s
          .fetch(u)
          .then((r) => r.json())
          .then((d: { v: string }) => {
            const v = `${d.v}${++n}`;
            made[v] = s.clock.now();
            cart.set({ v });
          });
      // warm-up: the runtime learns that both requests' chains write the cart
      load("/api/slow");
      load("/api/fast");
      await s.clock.advance(11_000);
      load("/api/slow");
      await s.clock.advance(100);
      load("/api/fast"); // its write is held while the slow request (related: it writes the cart too) is in flight
      await s.clock.advance(12_000);
      const fast = Object.keys(made).filter((v) => v.startsWith("fast")).at(-1)!;
      expect(applied[fast]).toBeDefined();
      expect(applied[fast] - made[fast]).toBeLessThanOrEqual(budget);
      expect(s.rt.decisions().some((d) => d.trigger === "mutation" && d.ran === "defer")).toBe(true);
    });
  }
});
