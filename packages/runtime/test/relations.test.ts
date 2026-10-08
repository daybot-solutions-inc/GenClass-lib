// Batch 8: precision of the relation learner on correct apps (REAL's wave-5 findings, 158 real apps). Each case is a
// synthetic store reproducing a false `inconsistency` trigger; none may fire, while a real defect still does.
import { describe, expect, it } from "vitest";
import { flatten } from "../src/state/fields.js";
import { InvariantMiner } from "../src/state/invariants.js";
import { setup } from "./helpers.js";

function leaves(stores: Record<string, unknown>) {
  const m = new Map();
  for (const [k, v] of Object.entries(stores)) for (const [p, l] of flatten(k, v)) m.set(p, l);
  return m;
}

/** Feed snapshots to a miner (every field changed each time); return what it learned and the violations at the end. */
function learn(states: Record<string, unknown>[], busy: (p: string) => boolean = () => false) {
  const m = new InvariantMiner(undefined, busy);
  const violations: string[][] = [];
  for (const s of states) {
    m.noteChanged([...leaves(s).keys()]);
    violations.push(m.observe(leaves(s), 0).violations.map((v) => v.text));
  }
  return { learned: m.learned().map((x) => x.text), violations, m };
}

describe("relation learner precision (batch 8)", () => {
  it("(1) a selection holding 0 / -1 / '' / null means nothing is selected: membership is vacuous, not violated", () => {
    const items = [{ id: 1, n: "a" }, { id: 2, n: "b" }, { id: 3, n: "c" }];
    const sel = (selectedId: number | string | null) => ({ ui: { items, selectedId } });
    const r = learn([sel(1), sel(2), sel(3), sel(2), sel(0), sel(-1), sel(""), sel(null), sel(3)]);
    expect(r.learned).toContain("ui.selectedId ∈ ui.items[*].id");
    expect(r.violations.flat()).toEqual([]);
    // a real dangling selection still breaks it
    r.m.noteChanged(["ui.selectedId"]);
    expect(r.m.observe(leaves(sel(9)), 0).violations.map((v) => v.text)).toEqual(["ui.selectedId ∈ ui.items[*].id"]);
  });

  it("(2) uniqueness only for id columns (≥ 3 rows) or id-shaped values (≥ 5 rows)", () => {
    const row = (i: number, status: string) => ({ id: i, status, title: `T${i}`, ref: `post-${i}a7k${i}`, partId: 100 + i });
    const page = (n: number, off: number) => ({ feed: { rows: Array.from({ length: n }, (_, i) => row(off + i, ["open", "done", "late"][i % 3])) } });
    const r = learn([page(3, 0), page(3, 3), page(3, 6), page(3, 9)]);
    expect(r.learned).toContain("feed.rows[*].id unique");
    expect(r.learned).not.toContain("feed.rows[*].title unique"); // an ordinary column
    expect(r.learned).not.toContain("feed.rows[*].status unique");
    expect(r.learned).not.toContain("feed.rows[*].partId unique"); // a foreign key
    expect(r.learned).not.toContain("feed.rows[*].ref unique"); // id-shaped values, but only 3 rows
    const big = learn([page(5, 0), page(5, 5), page(5, 10), page(5, 15)]);
    expect(big.learned).toContain("feed.rows[*].ref unique");
    // two items whose titles happen to be equal later: no violation (titles were never learned unique)
    const dup = { feed: { rows: [row(1, "open"), { ...row(2, "open"), title: "T1" }, row(3, "done")] } };
    r.m.noteChanged(["feed.rows"]);
    expect(r.m.observe(leaves(dup), 0).violations).toEqual([]);
  });

  it("(3) envelope / pagination metadata never enters a relation; equality and aggregates need compatible names", () => {
    // a paged list: total is all matches across pages, items is this page; page/limit coincide with counts
    const env = (page: number, items: number[], total: number) => ({ list: { items, total, page, limit: 2, offset: (page - 1) * 2 }, stats: { shownCount: items.length, unread: 2 } });
    const states = [env(1, [1, 2], 2), env(2, [3, 4], 2), env(1, [5, 6], 2), env(2, [7, 8], 2)];
    const r = learn(states);
    for (const t of r.learned.filter((x) => x.includes("==") || x.includes("∈"))) expect(t).not.toMatch(/list\.(total|page|limit|offset)/);
    expect(r.learned).toContain("stats.shownCount == len(list.items)");
    expect(r.learned).not.toContain("stats.unread == list.limit");
    // more results arrive: total grows past the page size; nothing breaks
    expect(learn([...states, env(1, [1, 2], 7)]).violations.flat()).toEqual([]);
    // unrelated names never get an equality, even when they agree every time
    const pairs = [3, 4, 5, 6, 7].map((n) => ({ a: { retries: n, visitors: n } }));
    expect(learn(pairs).learned.filter((t) => t.includes("=="))).toEqual([]);
    expect(learn([3, 4, 5, 6].map((n) => ({ a: { cartCount: n }, b: { badgeCount: n } }))).learned).toContain("a.cartCount == b.badgeCount");
    // an aggregate needs an aggregate-like name: `active == len(hits)` is a coincidence, `hitCount` is not
    const hits = (n: number) => ({ ill: { hits: Array.from({ length: n }, (_, i) => ({ id: i + 1 })), active: n, hitCount: n } });
    const agg = learn([hits(1), hits(2), hits(3), hits(4)]).learned;
    expect(agg).toContain("ill.hitCount == len(ill.hits)");
    expect(agg).not.toContain("ill.active == len(ill.hits)");
    // membership only for a selection in the list's own id column: a filter equal to some item's kind, a draft's id,
    // a foreign key are not selections
    const inbox = (filter: string, i: number) => ({ inbox: { filter, draft: { id: i }, reportId: i, items: [{ id: 1, kind: "mail", reportId: 1 }, { id: 2, kind: "chat", reportId: 2 }, { id: 3, kind: "mail", reportId: 3 }] } });
    expect(learn([inbox("mail", 1), inbox("chat", 2), inbox("mail", 3), inbox("chat", 1)]).learned.filter((t) => t.includes("∈"))).toEqual([]);
    // sums never run over id or version columns; group counters are named after the group
    const polls = (v: number[]) => ({ polls: { total: v.reduce((x, y, i) => x + y * (i + 1), 0), options: v.map((votes, i) => ({ pollId: i + 1, votes, version: votes })), counts: { open: 1, waitingParts: 1 }, jobs: [{ status: "open" }, { status: "waiting" }] } });
    const pl = learn([polls([1, 2]), polls([2, 2]), polls([3, 1]), polls([1, 4])]).learned;
    expect(pl.filter((t) => /pollId|version/.test(t) && t.includes("sum("))).toEqual([]);
    expect(pl).toContain('polls.counts.open == count(polls.jobs[*].status == "open")');
    expect(pl.filter((t) => t.includes("waitingParts") && t.includes("count("))).toEqual([]);
  });

  it("(5) busy counters only enter derived relations (len/sum), never equality or membership", () => {
    const st = (n: number) => ({ app: { renderCount: 10 + 3 * n, clickCount: 10 + 3 * n, items: Array.from({ length: n + 1 }, (_, i) => ({ id: i + 1 })), itemCount: n + 1 } });
    const states = [st(1), st(2), st(3), st(4)];
    // control: without the busy rule the two counters look equal (related names, always the same value)
    expect(learn(states).learned).toContain("app.renderCount == app.clickCount");
    const busy = (p: string) => p === "app.renderCount" || p === "app.clickCount" || p === "app.itemCount";
    const r = learn(states, busy);
    expect(r.learned).toContain("app.itemCount == len(app.items)"); // derived: kept
    expect(r.learned).not.toContain("app.renderCount == app.clickCount");
    expect(r.m.derived("app.itemCount")).toBe(true);
    expect(r.m.busyCounter("app.itemCount")).toBe(false); // derived counters are not treated as busy
    expect(r.m.busyCounter("app.renderCount")).toBe(true);
  });
});

describe("runtime: typing bursts and busy counters", () => {
  it("(4) relations on a store the user is typing into are checked only after the burst (≥ 1 s after the last keystroke)", async () => {
    const { rt, clock, decider } = setup();
    const profile = rt.atom("profile", { name: "" });
    const form = rt.atom("form", { name: "" });
    for (const n of ["Ada", "Grace", "Hedy"]) {
      await rt.op("load", () => {
        profile.set({ name: n });
        form.set({ name: n });
      });
      await clock.advance(200);
    }
    expect(rt.miner.learned().map((x) => x.text)).toContain("profile.name == form.name");
    // the user edits the form (settled points happen between keystrokes), then saves within the burst
    for (const v of ["Hedy L", "Hedy La", "Hedy Lam"]) {
      rt.user({ kind: "type", target: 'input "Name"', value: v }, () => form.set({ name: v }));
      await clock.advance(200);
    }
    await rt.op("save", () => profile.set({ name: form.get().name }));
    await clock.advance(1500);
    expect(decider.calls.filter((c) => c.trigger === "inconsistency")).toHaveLength(0);
    // the check is deferred, not lost: a real divergence after typing stops is still reported
    rt.user({ kind: "type", target: 'input "Name"', value: "x" }, () => form.set({ name: "x" }));
    await clock.advance(300);
    expect(decider.calls.filter((c) => c.trigger === "inconsistency")).toHaveLength(0);
    await clock.advance(1000);
    expect(decider.calls.filter((c) => c.trigger === "inconsistency")).toHaveLength(1);
  });

  it("(5) a busy counter written by some completions of an op is not a transition", async () => {
    const { rt, clock, decider } = setup();
    const app = rt.atom("app", { requests: 0, data: 0 });
    for (let i = 0; i < 26; i++) {
      // every op bumps the request counter; one in five also changes data
      await rt.op("poll", () => app.set((a) => ({ requests: a.requests + 1, data: i % 5 === 0 ? i : a.data })));
      await clock.advance(200);
    }
    // the 26th: the same op skips the counter once (a code path that forgot it): the counter is busy, not a shape
    await rt.op("poll", () => app.set((a) => ({ ...a, data: 999 })));
    await clock.advance(200);
    expect(rt.hub.busy("app.requests")).toBe(true);
    expect(decider.calls.filter((c) => c.trigger === "transition")).toHaveLength(0);
  });
});
