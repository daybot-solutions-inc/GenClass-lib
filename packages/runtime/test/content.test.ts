// Batch 5: situation-v2 facts from SIM's separability analysis (sim/SEPARABILITY.md §6), one test per fact:
// F1 revert of newer data (field and item cell), F2 overwrite of text the user typed (diff-centred), F3 "changes
// nothing" (not salient), F9 provenance of known-stale values, F6 cadence, F5 failure scope and commit ambiguity,
// F7 repeat evidence, F8 relation quality, read-your-writes.
import { describe, expect, it } from "vitest";
import { changeText, flatten } from "../src/state/fields.js";
import { InvariantMiner } from "../src/state/invariants.js";
import { stateText } from "../src/situation/serialize.js";
import type { EvaluateRequest } from "../src/types.js";
import { FakeClock, defaultScript, setup, type Setup } from "./helpers.js";

const factsOf = (r: EvaluateRequest | undefined) => ((r?.state.facts as string[] | undefined) ?? []).join("\n");
const calls = (s: Setup, trigger: string) => s.decider.calls.filter((c) => c.trigger === trigger);

/** A global whose timers run on the fake clock (timers observer: debounces become ops). */
function timers(holder: { clock?: FakeClock }) {
  return {
    setTimeout: (fn: () => void, ms: number) => holder.clock!.setTimeout(fn, ms),
    clearTimeout: (h: unknown) => holder.clock!.clearTimeout(h),
  };
}

/** A list app: GET /api/items?q=… loads `list.items`; the first load teaches the signature's write set. */
function listApp(s: Setup, respond: (q: string) => { items: unknown[]; latency: number }) {
  s.server.on("GET", "/api/items", ({ url }) => {
    const q = url.searchParams.get("q") ?? "";
    const r = respond(q);
    return { body: { q, items: r.items }, latency: r.latency };
  });
  const st = s.rt.atom("list", { items: [] as unknown[] });
  const load = (q: string) =>
    s.rt.user({ kind: "type", target: 'input "Filter"', value: q }, () => {
      void (async () => {
        const d = (await (await s.fetch(`/api/items?q=${q}`)).json()) as { items: unknown[] };
        st.set({ items: d.items });
      })();
    });
  return { st, load };
}

describe("F3: a response that changes nothing is not salient", () => {
  it("an out-of-order response equal to the current values makes no model call; a different one does", async () => {
    const s = setup();
    const { st, load } = listApp(s, (q) => ({ items: q === "z" ? ["z"] : q === "c" ? ["c-1"] : q === "cd" ? ["cd-1"] : ["same"], latency: q === "a" || q === "c" ? 600 : 100 }));
    load("z");
    await s.clock.advance(300);
    load("a"); // slow, returns ["same"]
    await s.clock.advance(20);
    load("ab"); // fast, returns ["same"]
    await s.clock.advance(1000);
    expect(st.get().items).toEqual(["same"]);
    expect(calls(s, "delivery")).toHaveLength(0);
    expect(s.rt.history().some((e) => e.name === "delivery.unchanged")).toBe(true);
    // the same race where the slow response differs: one decision
    load("c");
    await s.clock.advance(20);
    load("cd");
    await s.clock.advance(1000);
    expect(calls(s, "delivery")).toHaveLength(1);
    expect(factsOf(calls(s, "delivery")[0])).toMatch(/The response has list\.items = 1 item \["c-1"\]: neither the current value 1 item \["cd-1"\], nor the value when #\d+ started\./);
  });
});

describe("F1: the response would put back a value a newer operation replaced", () => {
  it("a field: the stale GET has the status a newer PATCH replaced", async () => {
    const s = setup();
    let status = "open";
    s.server.on("GET", "/api/card", ({ n }) => ({ body: { id: "c7", status }, latency: n === 2 ? 800 : 50 }));
    s.server.on("PATCH", "/api/card", () => {
      status = "closed";
      return { body: { id: "c7", status: "closed" }, latency: 50 };
    });
    const card = s.rt.atom("card", { id: "", status: "" });
    const get = () => void s.rt.op("refresh", async () => card.set((await (await s.fetch("/api/card")).json()) as { id: string; status: string }));
    get();
    await s.clock.advance(100);
    get(); // slow: answers with the old status (served before the PATCH)
    await s.clock.advance(10);
    status = "open";
    void s.rt.op("close", async () => card.set((await (await s.fetch("/api/card", { method: "PATCH", body: "{}" })).json()) as { id: string; status: string }));
    await s.clock.advance(2000);
    const req = calls(s, "delivery")[0];
    expect(req).toBeDefined();
    expect(factsOf(req)).toMatch(/The response has card\.status = "open", the value that PATCH \/api\/card \{\} \(#\d+\) replaced with "closed" 0\.74s ago \(it started after #\d+\); delivering it would put the older value back\./);
  });

  it("item cells: put back the cell a newer write changed; newer writes on other items are named as unchanged by it", async () => {
    const s = setup();
    const v1 = [{ id: 1, done: false }, { id: 2, done: false }, { id: 3, done: false }];
    const { st, load } = listApp(s, (q) => ({ items: q === "old" ? v1 : v1, latency: q === "old" ? 800 : 50 }));
    load("first");
    await s.clock.advance(200);
    load("old"); // slow: the list before the toggle
    await s.clock.advance(10);
    // a newer operation toggles item 2 (e.g. a push from another client)
    await s.rt.op("push", () => st.set((v) => ({ items: (v.items as typeof v1).map((x) => (x.id === 2 ? { ...x, done: true } : x)) })));
    await s.clock.advance(2000);
    const req = calls(s, "delivery")[0];
    console.log(`==== delivery (F1: item cells) ====\n${stateText(req.state)}\n`);
    expect(factsOf(req)).toMatch(/The response would put back done = false for item 2 of list\.items: the store has true, changed since #\d+ started; delivering it would undo that change\./);
    expect(factsOf(req)).toMatch(/Joined by id with list\.items, the response would change 1 cell in 1 item\./);
  });
});

describe("F2: the response would replace text the user typed after the request started", () => {
  it("salient even without a newer operation; the preview is centred on the difference", async () => {
    const s = setup();
    s.server.on("PUT", "/api/doc", ({ body }) => ({ body: { text: (JSON.parse(body ?? "{}") as { text: string }).text.trim() }, latency: 400 }));
    const doc = s.rt.atom("doc", { text: "Guild page sword shield " });
    const save = () =>
      void s.rt.op("autosave", async () => {
        const d = (await (await s.fetch("/api/doc", { method: "PUT", body: JSON.stringify({ text: doc.get().text }) })).json()) as { text: string };
        doc.set({ text: d.text });
      });
    save(); // teaches the signature's write set
    await s.clock.advance(600);
    save();
    await s.clock.advance(100);
    for (const t of ["Guild page sword shield m", "Guild page sword shield market", "Guild page sword shield market lib"]) {
      s.rt.user({ kind: "type", target: 'textarea "Page"', value: t }, () => doc.set({ text: t }));
      await s.clock.advance(80);
    }
    await s.clock.advance(1000);
    const req = calls(s, "delivery")[0];
    expect(req).toBeDefined();
    expect(factsOf(req)).toMatch(/The response would replace text the user typed into doc\.text after #\d+ started \(3 user writes, the last [\d.]+s ago\): "…e sword shield market lib" → "…e sword shield" \(removes " market lib"\)\./);
  });

  it("long string changes are previewed around the first difference", () => {
    const t = changeText({ path: "doc.text", before: "Guild page sword shield market lib", after: "Guild page sword shield" }, (_p, v) => v);
    expect(t).toBe('"…e sword shield market lib" → "…e sword shield" (removes " market lib")');
  });
});

describe("F9: provenance of values known to be stale", () => {
  it("delivered over newer data, a 5× slow response, a write after an ambiguous failure", async () => {
    const s = setup({ triage: "always" });
    // (a) a stale response the model let through
    const { st, load } = listApp(s, (q) => ({ items: [q], latency: q === "a" ? 600 : 50 }));
    load("z");
    await s.clock.advance(300);
    load("a");
    await s.clock.advance(20);
    load("ab");
    await s.clock.advance(1000);
    expect(st.get().items).toEqual(["a"]); // delivered (expected → deliver)
    expect(s.rt.hub.field("list.items")!.mark?.why).toMatch(/^by the response to GET \/api\/items\?q=a \(#\d+\), which was delivered over newer data from GET \/api\/items\?q=ab \(#\d+\)$/);
    await s.rt.op("edit", () => st.set({ items: ["x"] }));
    await s.clock.flush();
    expect(factsOf(calls(s, "mutation").pop())).toMatch(/list\.items holds a value written 0\.42s ago by the response to GET \/api\/items\?q=a \(#\d+\), which was delivered over newer data from GET \/api\/items\?q=ab \(#\d+\); nothing has rewritten it since\./);
    expect(s.rt.hub.field("list.items")!.mark).toBeUndefined(); // the edit rewrote it

    // (b) a response 5× slower than usual
    s.server.on("GET", "/api/rate", ({ n }) => ({ body: { rate: n }, latency: n === 7 ? 1200 : 100 }));
    const rate = s.rt.atom("rate", { v: 0 });
    for (let i = 0; i < 7; i++) {
      void s.rt.op("poll", async () => rate.set({ v: ((await (await s.fetch("/api/rate")).json()) as { rate: number }).rate }));
      await s.clock.advance(1500);
    }
    expect(s.rt.hub.field("rate.v")!.mark?.why).toMatch(/^by the response to GET \/api\/rate \(#\d+\), which took 1\.20s \(12× its usual 0\.10s\)$/);

    // (c) the app's rollback after a POST that failed with 500 after its usual time
    let fail = false;
    s.server.on("POST", "/api/likes", () => ({ status: fail ? 500 : 201, body: {}, latency: 300 }));
    const likes = s.rt.atom("likes", { n: 0 });
    const like = () =>
      s.rt.user({ kind: "click", target: 'button "Like"' }, () => {
        likes.set((v) => ({ n: v.n + 1 }));
        void s.fetch("/api/likes", { method: "POST", body: "{}" }).then((r) => {
          if (!r.ok) likes.set((v) => ({ n: v.n - 1 }));
        });
      });
    for (let i = 0; i < 5; i++) {
      like();
      await s.clock.advance(500);
    }
    fail = true;
    like();
    await s.clock.advance(500);
    expect(likes.get().n).toBe(5);
    expect(s.rt.hub.field("likes.n")!.mark?.why).toMatch(/^after POST \/api\/likes \{\} \(#\d+\) failed \(HTTP 500 after 0\.30s\), although the server may have applied it$/);
  });

  it("a live channel that was down: the fields its messages wrote may have missed updates", async () => {
    class WS extends EventTarget {
      static all: WS[] = [];
      constructor(public url: string) {
        super();
        WS.all.push(this);
      }
      send() {}
    }
    const s = setup({ triage: "always", observe: { fetch: true, websocket: true }, extraGlobal: { WebSocket: WS } });
    const b = s.rt.atom("board", { c1: "todo" });
    const connect = () => {
      const ws = new (s.g.WebSocket as typeof WS)("ws://app.test/live");
      ws.addEventListener("message", (e) => b.set(JSON.parse((e as MessageEvent).data as string) as { c1: string }));
      return WS.all[WS.all.length - 1];
    };
    const w1 = connect();
    w1.dispatchEvent(new Event("open"));
    w1.dispatchEvent(new MessageEvent("message", { data: '{"c1":"doing"}' }));
    await s.clock.advance(100);
    w1.dispatchEvent(Object.assign(new Event("close"), { code: 1006 }));
    await s.clock.advance(3000);
    const w2 = connect();
    w2.dispatchEvent(new Event("open"));
    expect(s.rt.hub.field("board.c1")!.mark?.why).toBe("by WebSocket messages on /live; the channel then was down for 3.00s (closed 1006), so updates sent meanwhile may be missing");
  });
});

describe("F6: learned cadence", () => {
  it("a polled endpoint: its schedule and when the next run is due (failure situation)", async () => {
    const s = setup();
    s.server.on("GET", "/api/feed", ({ n }) => (n === 6 ? { status: 503, latency: 50 } : { body: [], latency: 50 }));
    for (let i = 0; i < 6; i++) {
      void s.fetch("/api/feed").catch(() => undefined); // background polling: no user action
      await s.clock.advance(1000);
    }
    const f = calls(s, "failure")[0];
    expect(factsOf(f)).toMatch(/GET \/api\/feed runs on a schedule: every 1\.00s \(last 5 intervals\); the next run is due in 0\.95s\./);
  });

  it("a debounced save: sent a steady delay after the user's last input", async () => {
    const holder: { clock?: FakeClock } = {};
    const s = setup({ observe: { fetch: true, timers: true }, extraGlobal: timers(holder) });
    holder.clock = s.clock;
    s.server.on("PUT", "/api/note", ({ n }) => (n === 4 ? { status: 500, latency: 50 } : { body: {}, latency: 50 }));
    const setT = s.g.setTimeout as (f: () => void, ms: number) => unknown;
    for (let i = 0; i < 4; i++) {
      s.rt.user({ kind: "type", target: 'textarea "Note"', value: `v${i}` }, () => {
        setT(() => void s.fetch("/api/note", { method: "PUT", body: `{"v":${i}}` }).catch(() => undefined), 300);
      });
      await s.clock.advance(1000);
    }
    expect(factsOf(calls(s, "failure")[0])).toMatch(/PUT \/api\/note is usually sent 0\.30s after the user's last input \(4 of the last 4\): a later edit is followed by a new request\./);
  });
});

describe("F5: failure scope and commit ambiguity", () => {
  it("other endpoints of the origin failing, the browser offline, a POST that may have been applied", async () => {
    const s = setup({ extraGlobal: { navigator: { onLine: false } } });
    s.server.on("GET", "/api/a", { status: 500, latency: 20 });
    s.server.on("GET", "/api/b", { status: 503, latency: 20 });
    s.server.on("POST", "/api/orders", ({ n }) => (n <= 5 ? { status: 201, body: { id: n }, latency: 500 } : { status: 500, latency: 600 }));
    for (let i = 0; i < 5; i++) {
      void s.fetch("/api/orders", { method: "POST", body: `{"n":${i}}` });
      await s.clock.advance(600);
    }
    void s.fetch("/api/a");
    void s.fetch("/api/b");
    await s.clock.advance(100);
    void s.fetch("/api/orders", { method: "POST", body: "{}" });
    await s.clock.advance(1000);
    const fr = calls(s, "failure").find((c) => String(c.state.trigger).startsWith("POST /api/orders"))!;
    console.log(`==== failure (F5: scope, commit ambiguity) ====\n${stateText(fr.state)}\n`);
    const f = factsOf(fr);
    expect(f).toMatch(/This POST failed with HTTP 500 after 0\.60s \(usual 0\.50s\): the server may have applied it before failing\./);
    expect(f).toMatch(/2 other endpoints of this origin failed in the last 10s \(2 failures, latest: GET \/api\/a 500, GET \/api\/b 503\)/);
    expect(f).toMatch(/The browser reports that it is offline \(navigator\.onLine is false\)\./);
    const g = factsOf(calls(s, "failure").find((c) => String(c.state.trigger).startsWith("GET /api/b")));
    expect(g).not.toMatch(/may have applied/); // GETs never have a commit question
  });
});

describe("F7: evidence about a repeated user action", () => {
  it("same element, the browser's click count, the first request still in flight, the UI change between them", async () => {
    const s = setup({ triage: "always" });
    s.server.on("POST", "/api/videos/7/like", { status: 200, body: {}, latency: 300 });
    const ui = s.rt.atom("video", { pending: false });
    const click = (clicks: number) =>
      s.rt.user({ kind: "click", target: 'button "Like"', clicks }, () => {
        ui.set({ pending: true });
        void s.fetch("/api/videos/7/like", { method: "POST", body: "{}" });
      });
    click(1);
    await s.clock.advance(80);
    click(2);
    await s.clock.advance(1000);
    const req = calls(s, "request")[1];
    expect(factsOf(req)).toMatch(/they come from separate user actions 0\.08s apart\./);
    expect(factsOf(req)).toMatch(/User actions #1 and #3, 0\.08s apart: both are clicks on button "Like"; the browser counted #3 as click 2 of a multi-click \(MouseEvent\.detail\); the request of #1 \(#2\) was still in flight at #3; between them the app wrote video\.pending\./);
  });
});

describe("F8: relation quality", () => {
  const leaves = (stores: Record<string, unknown>) => {
    const m = new Map();
    for (const [k, v] of Object.entries(stores)) for (const [p, l] of flatten(k, v)) m.set(p, l);
    return m;
  };
  it("no coincidences between unrelated small numbers or version counters; count-by-group relations are learned", () => {
    const m = new InvariantMiner();
    const lanes = ["todo", "todo", "done", "doing"];
    for (let i = 0; i < 6; i++) {
      const items = lanes.slice(0, 2 + (i % 3)).map((lane, j) => ({ id: j + 1, lane, days: 2 }));
      const state = {
        items,
        counts: { todo: items.filter((x) => x.lane === "todo").length, done: items.filter((x) => x.lane === "done").length },
        tally: { approved: 2 },
        meta: { revision: 2, offset: 2 },
      };
      m.noteChanged(["board.items", "board.counts.todo", "board.counts.done", "board.tally.approved", "board.meta.revision", "board.meta.offset"]);
      m.observe(leaves({ board: state }), 0);
    }
    const learned = m.learned().map((x) => x.text);
    expect(learned).toContain('board.counts.done == count(board.items[*].lane == "done")');
    expect(learned).not.toContain("board.tally.approved ∈ board.items[*].days");
    expect(learned).not.toContain("board.meta.revision == board.meta.offset");
    expect(learned.filter((t) => t.includes("tally.approved =="))).toEqual([]);
  });
});

describe("read-your-writes", () => {
  it("a list reloaded after a create lacks the created item, or holds it twice", async () => {
    const s = setup({ triage: "always" });
    s.server.on("POST", "/api/lists", { status: 201, body: { id: "weekend", name: "Weekend" }, latency: 50 });
    let dup = false;
    s.server.on("GET", "/api/lists", ({ n }) => ({
      body: dup ? [{ id: "home", name: "Home" }, { id: "weekend", name: "Weekend" }, { id: "weekend", name: "Weekend" }] : n === 1 ? [{ id: "home", name: "Home" }] : [{ id: "home", name: "Home" }, { id: "garden", name: "Garden" }],
      latency: 50,
    }));
    const lists = s.rt.atom("lists", { hits: [] as { id: string; name: string }[] });
    const refresh = () => s.rt.op("refresh", async () => lists.set({ hits: (await (await s.fetch("/api/lists")).json()) as { id: string; name: string }[] }));
    void refresh();
    await s.clock.advance(200);
    void s.fetch("/api/lists", { method: "POST", body: '{"name":"Weekend"}' });
    await s.clock.advance(100);
    void refresh();
    await s.clock.advance(200);
    const t1 = factsOf(calls(s, "mutation").pop());
    console.log(`==== facts (read-your-writes) ====\n${t1}\n`);
    expect(t1).toMatch(/lists\.hits was loaded by GET \/api\/lists \(#\d+\), which started [\d.]+s after POST \/api\/lists \{name: "Weekend"\} \(#\d+\) created item "weekend" [\d.]+s ago \(201\), and does not contain it\./);
    dup = true;
    void refresh();
    await s.clock.advance(200);
    expect(factsOf(calls(s, "mutation").pop())).toMatch(/lists\.hits contains item "weekend" twice; POST \/api\/lists \{name: "Weekend"\} \(#\d+\) created item "weekend" [\d.]+s ago \(201\)\./);
  });
});

describe("example situations", () => {
  it("prints the F1/F2 delivery situations at the full budget", async () => {
    const s = setup({ script: defaultScript() });
    s.server.on("PUT", "/api/doc", ({ body }) => ({ body: { text: (JSON.parse(body ?? "{}") as { text: string }).text.trim() }, latency: 400 }));
    const doc = s.rt.atom("doc", { text: "Guild page sword shield " });
    const save = () =>
      void s.rt.op("autosave", async () => {
        const d = (await (await s.fetch("/api/doc", { method: "PUT", body: JSON.stringify({ text: doc.get().text }) })).json()) as { text: string };
        doc.set({ text: d.text });
      });
    save();
    await s.clock.advance(600);
    save();
    await s.clock.advance(100);
    for (const t of ["Guild page sword shield m", "Guild page sword shield market lib"]) {
      s.rt.user({ kind: "type", target: 'textarea "Page"', value: t }, () => doc.set({ text: t }));
      await s.clock.advance(80);
    }
    await s.clock.advance(1000);
    console.log(`==== delivery (F2: user text) ====\n${stateText(calls(s, "delivery")[0].state)}\n`);
  });
});
