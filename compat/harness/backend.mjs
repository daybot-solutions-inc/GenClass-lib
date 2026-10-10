// Shared fault-injecting mock backend for every compat app (REST, a mock GraphQL endpoint, WebSocket and
// EventSource). One instance per runner worker; the runner resets it before each trial with (seed, scenario).
//
// Latency is seeded per (seed, route key, n-th call of that key), so every mode of a trial sees the same network
// draws ("common random numbers"): off, observe, guard and heal differ only by what GenClass does.
//
// Scenario profiles (see compat/README.md for the full scenario table):
//   a  typeahead: a shorter prefix answers later than the full one (out of order)
//   b  create: POST /api/items is slow (350-650 ms), so a double submit reaches the server twice
//   c  two panels: /api/left and /api/right answer in a random order (80-600 ms)
//   d  optimistic toggles: PATCH /api/todos/1 succeeds, PATCH /api/todos/2 fails with 500
//   e  offline -> reconnect: the runner takes the browser offline (no server fault)
//   f  +1 five times: every POST /api/counter/increment takes 150-500 ms (overlapping, identical requests)
//   g  polling + fan-out: /api/status (20-120 ms) polled every 250 ms, /api/detail/:id (50-400 ms) six at once
//   h  clean traffic: everything 20-80 ms

import { WebSocketServer } from "ws";

export const CITIES = [
  "Amsterdam", "Ankara", "Athens", "Auckland", "Bangkok", "Barcelona", "Beijing", "Belgrade", "Berlin", "Bern",
  "Bilbao", "Bogota", "Bologna", "Bordeaux", "Boston", "Brasilia", "Bratislava", "Bremen", "Brisbane", "Bristol",
  "Brussels", "Bucharest", "Budapest", "Cairo", "Calgary", "Lagos", "Lahore", "Lima", "Lisbon", "Liverpool",
  "Ljubljana", "London", "Lyon", "Madrid", "Malaga", "Manchester", "Manila", "Marseille", "Melbourne", "Milan",
  "Montreal", "Moscow", "Munich", "Paris", "Parma", "Perth", "Philadelphia", "Phoenix", "Porto", "Portland",
  "Prague", "Pretoria", "San Diego", "San Francisco", "San Jose", "Santiago", "Santo Domingo", "Sao Paulo",
  "Sapporo", "Sarajevo", "Seattle", "Seoul", "Seville", "Shanghai", "Singapore", "Sofia", "Stockholm", "Sydney",
  "Toronto", "Tunis", "Turin", "Valencia", "Vancouver", "Venice", "Vienna", "Vilnius", "Warsaw", "Zurich",
];

/** The server's answer to a search: up to 8 city names starting with q (case-insensitive), sorted. */
export function searchCities(q) {
  const s = String(q ?? "").trim().toLowerCase();
  if (!s) return [];
  return CITIES.filter((c) => c.toLowerCase().startsWith(s)).slice(0, 8);
}

/** The word typed in scenario a/h for a seed (a 5-letter prefix is typed in a, 3 letters in h). */
export const TYPEAHEAD_WORDS = ["santiago", "berlin", "manchester", "porto", "lisbon", "bratislava", "sapporo", "melbourne", "barcelona", "seattle"];
export const typeaheadWord = (seed) => TYPEAHEAD_WORDS[(seed - 1) % TYPEAHEAD_WORDS.length];
export const A_PREFIX = 5;

const LEFT_ROWS = ["Ada Lovelace", "Grace Hopper", "Linus Torvalds"];
const RIGHT_ROWS = ["Build passed", "Deploy queued", "Review requested", "Issue closed"];
export const detail = (id) => ({ id, name: `Item ${id}`, price: id * 3 });

// mulberry32 over a string hash
function hash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}
function rand01(s) {
  let t = (hash(s) + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function initialState() {
  return {
    items: [
      { id: 1, title: "Alpha" },
      { id: 2, title: "Bravo" },
    ],
    nextItem: 3,
    notes: [{ id: 1, text: "first note" }],
    nextNote: 2,
    todos: [
      { id: 1, title: "Write tests", done: false },
      { id: 2, title: "Ship release", done: false },
      { id: 3, title: "Fix flaky CI", done: true },
    ],
    counter: 0,
    statusTicks: 0,
    leftVersion: 0,
    rightVersion: 0,
    log: [],
  };
}

export function createBackend() {
  let seed = 1;
  let scenario = "h";
  let st = initialState();
  let counts = new Map();
  let inflight = 0;
  let epoch = 0;
  const timers = new Set();
  const sockets = new Set();
  const streams = new Set();

  function lat(key, lo, hi) {
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    return Math.round(lo + rand01(`${seed}|${scenario}|${key}|${n}`) * (hi - lo));
  }

  /** Latency (ms) for one call, by scenario profile. */
  function latencyFor(kind, arg) {
    switch (kind) {
      case "search":
        if (scenario === "a") {
          const len = String(arg ?? "").length;
          if (len >= A_PREFIX) return lat(`search|${arg}`, 30, 90);
          return lat(`search|${arg}`, 950 - 160 * len, 1070 - 160 * len);
        }
        return lat("search", 20, 80);
      case "create":
        return scenario === "b" ? lat("create", 350, 650) : lat("create", 20, 80);
      case "left":
      case "right":
        return scenario === "c" ? lat(kind, 80, 600) : lat(kind, 20, 80);
      case "toggle":
        return scenario === "d" ? lat(`toggle|${arg}`, 150, 450) : lat("toggle", 20, 80);
      case "note":
        return lat("note", 40, 120);
      case "increment":
        return scenario === "f" ? lat("increment", 150, 500) : lat("increment", 20, 80);
      case "status":
        return scenario === "g" ? lat("status", 20, 120) : lat("status", 20, 80);
      case "detail":
        return scenario === "g" ? lat(`detail|${arg}`, 50, 400) : lat("detail", 20, 80);
      default:
        return lat(kind, 20, 80);
    }
  }

  /** Run fn after ms unless the backend was reset meanwhile; counts as in flight until then. */
  function later(ms, fn) {
    const e = epoch;
    inflight++;
    const t = setTimeout(() => {
      timers.delete(t);
      inflight--;
      if (e !== epoch) return;
      try {
        fn();
      } catch (err) {
        console.error("[backend]", err);
      }
    }, ms);
    timers.add(t);
  }

  // ------------------------------------------------------------------------------------------- operations
  // Each returns { status, body } computed when the response is sent (the server applies the write at answer time,
  // like a server that does its work during the latency).
  const ops = {
    search: (q) => ({ status: 200, body: { q, results: searchCities(q) } }),
    items: () => ({ status: 200, body: { items: st.items } }),
    create: (title) => {
      const item = { id: st.nextItem++, title: String(title ?? "").slice(0, 80) };
      st.items = [...st.items, item];
      broadcast({ type: "item-added", item });
      return { status: 201, body: item };
    },
    left: () => ({ status: 200, body: { version: ++st.leftVersion, rows: LEFT_ROWS } }),
    right: () => ({ status: 200, body: { version: ++st.rightVersion, rows: RIGHT_ROWS } }),
    todos: () => ({ status: 200, body: { todos: st.todos } }),
    toggle: (id, done) => {
      if (scenario === "d" && id === 2) return { status: 500, body: { error: "could not update todo 2" } };
      const t = st.todos.find((x) => x.id === id);
      if (!t) return { status: 404, body: { error: "no such todo" } };
      st.todos = st.todos.map((x) => (x.id === id ? { ...x, done: !!done } : x));
      const todo = st.todos.find((x) => x.id === id);
      broadcast({ type: "todo", todo });
      return { status: 200, body: todo };
    },
    notes: () => ({ status: 200, body: { notes: st.notes } }),
    note: (text) => {
      const note = { id: st.nextNote++, text: String(text ?? "").slice(0, 80) };
      st.notes = [...st.notes, note];
      return { status: 201, body: note };
    },
    increment: () => ({ status: 200, body: { count: ++st.counter } }),
    counter: () => ({ status: 200, body: { count: st.counter } }),
    status: () => ({ status: 200, body: { tick: ++st.statusTicks } }),
    detail: (id) => ({ status: 200, body: detail(id) }),
  };

  function logCall(entry) {
    if (st.log.length < 500) st.log.push(entry);
  }

  // --------------------------------------------------------------------------------------------- REST
  function sendJson(res, status, body) {
    const s = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(s) });
    res.end(s);
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => {
        try {
          resolve(b ? JSON.parse(b) : {});
        } catch {
          resolve({});
        }
      });
      req.on("error", () => resolve({}));
    });
  }

  function respondLater(res, kind, arg, run) {
    const ms = latencyFor(kind, arg);
    logCall({ kind, arg, ms });
    let closed = false;
    res.on("close", () => (closed = true));
    later(ms, () => {
      const r = run();
      if (!closed && !res.writableEnded) sendJson(res, r.status, r.body);
    });
  }

  /** Handles /api/*, /graphql and /sse/*; returns false for anything else. */
  async function handle(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    let mm;
    if (p.startsWith("/sse/")) return sse(req, res, p), true;
    if (p === "/graphql" && m === "POST") return graphql(req, res), true;
    if (!p.startsWith("/api/")) return false;
    if (p === "/api/search" && m === "GET") return respondLater(res, "search", url.searchParams.get("q") ?? "", () => ops.search(url.searchParams.get("q") ?? "")), true;
    if (p === "/api/items" && m === "GET") return respondLater(res, "items", null, ops.items), true;
    if (p === "/api/items" && m === "POST") {
      const b = await readBody(req);
      return respondLater(res, "create", null, () => ops.create(b.title)), true;
    }
    if (p === "/api/left" && m === "GET") return respondLater(res, "left", null, ops.left), true;
    if (p === "/api/right" && m === "GET") return respondLater(res, "right", null, ops.right), true;
    if (p === "/api/todos" && m === "GET") return respondLater(res, "todos", null, ops.todos), true;
    if ((mm = /^\/api\/todos\/(\d+)$/.exec(p)) && (m === "PATCH" || m === "PUT")) {
      const b = await readBody(req);
      const id = Number(mm[1]);
      return respondLater(res, "toggle", id, () => ops.toggle(id, b.done)), true;
    }
    if (p === "/api/notes" && m === "GET") return respondLater(res, "notes", null, ops.notes), true;
    if (p === "/api/notes" && m === "POST") {
      const b = await readBody(req);
      return respondLater(res, "note", null, () => ops.note(b.text)), true;
    }
    if (p === "/api/counter" && m === "GET") return respondLater(res, "counter", null, ops.counter), true;
    if (p === "/api/counter/increment" && m === "POST") {
      await readBody(req);
      return respondLater(res, "increment", null, ops.increment), true;
    }
    if (p === "/api/status" && m === "GET") return respondLater(res, "status", null, ops.status), true;
    if ((mm = /^\/api\/detail\/(\d+)$/.exec(p)) && m === "GET") {
      const id = Number(mm[1]);
      return respondLater(res, "detail", id, () => ops.detail(id)), true;
    }
    sendJson(res, 404, { error: "not found" });
    return true;
  }

  // ------------------------------------------------------------------------------------------ GraphQL
  // A mock GraphQL endpoint: operations are dispatched by operationName (the apps send fixed documents).
  const T = (typename, o) => ({ __typename: typename, ...o });
  const gqlOps = {
    Search: (v) => ["search", v.q, () => ({ search: T("SearchResult", { q: v.q, results: searchCities(v.q) }) })],
    Items: () => ["items", null, () => ({ items: st.items.map((i) => T("Item", i)) })],
    CreateItem: (v) => ["create", null, () => ({ createItem: T("Item", ops.create(v.title).body) })],
    Left: () => ["left", null, () => ({ left: T("Panel", { id: "left", ...ops.left().body }) })],
    Right: () => ["right", null, () => ({ right: T("Panel", { id: "right", ...ops.right().body }) })],
    Todos: () => ["todos", null, () => ({ todos: st.todos.map((t) => T("Todo", t)) })],
    ToggleTodo: (v) => [
      "toggle",
      Number(v.id),
      () => {
        const r = ops.toggle(Number(v.id), v.done);
        if (r.status !== 200) throw new Error(r.body.error);
        return { toggleTodo: T("Todo", r.body) };
      },
    ],
    Notes: () => ["notes", null, () => ({ notes: st.notes.map((n) => T("Note", n)) })],
    AddNote: (v) => ["note", null, () => ({ addNote: T("Note", ops.note(v.text).body) })],
    Counter: () => ["counter", null, () => ({ counter: T("Counter", { id: "counter", count: st.counter }) })],
    Increment: () => ["increment", null, () => ({ increment: T("Counter", { id: "counter", count: ops.increment().body.count }) })],
    Status: () => ["status", null, () => ({ status: T("Status", { id: "status", tick: ops.status().body.tick }) })],
    Detail: (v) => ["detail", Number(v.id), () => ({ detail: T("Detail", detail(Number(v.id))) })],
  };

  async function graphql(req, res) {
    const b = await readBody(req);
    const op = gqlOps[b.operationName];
    if (!op) return sendJson(res, 400, { errors: [{ message: `unknown operation ${b.operationName}` }] });
    const [kind, arg, run] = op(b.variables ?? {});
    const ms = latencyFor(kind, arg);
    logCall({ kind, arg, ms, gql: b.operationName });
    let closed = false;
    res.on("close", () => (closed = true));
    later(ms, () => {
      let out;
      try {
        out = { data: run() };
      } catch (e) {
        out = { data: null, errors: [{ message: String(e.message ?? e) }] };
      }
      if (!closed && !res.writableEnded) sendJson(res, 200, out);
    });
  }

  // ------------------------------------------------------------------------------------ EventSource
  // /sse/status: 8 ticks, one every 250 ms (the stream then stays open, silent). /sse/right: the right panel once.
  function sse(req, res, p) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(": open\n\n");
    const e = epoch;
    const s = { res, timers: [] };
    streams.add(s);
    const send = (obj) => {
      if (e === epoch && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    if (p === "/sse/status") {
      for (let i = 1; i <= 8; i++) {
        const ms = 250 * i + (scenario === "g" ? latencyFor("status", null) : 0);
        later(ms, () => send({ tick: ++st.statusTicks }));
      }
    } else if (p === "/sse/right") {
      later(latencyFor("right", null), () => send({ type: "right", ...ops.right().body }));
    }
    req.on("close", () => streams.delete(s));
  }

  // ---------------------------------------------------------------------------------------- WebSocket
  const wss = new WebSocketServer({ noServer: true });
  function broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of sockets) if (ws.readyState === 1) ws.send(s);
  }
  wss.on("connection", (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      const reply = (kind, arg, run) => {
        const ms = latencyFor(kind, arg);
        logCall({ kind, arg, ms, ws: m.type });
        later(ms, () => ws.readyState === 1 && ws.send(JSON.stringify(run())));
      };
      if (m.type === "search") reply("search", m.q ?? "", () => ({ type: "results", id: m.id, q: m.q, results: searchCities(m.q) }));
      else if (m.type === "left") reply("left", null, () => ({ type: "left", ...ops.left().body }));
      else if (m.type === "items") reply("items", null, () => ({ type: "items", items: st.items }));
      else if (m.type === "todos") reply("todos", null, () => ({ type: "todos", todos: st.todos }));
      else if (m.type === "detail") reply("detail", Number(m.id), () => ({ type: "detail", ...detail(Number(m.id)) }));
    });
  });
  function handleUpgrade(req, socket, head) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  }

  // ------------------------------------------------------------------------------------------- control
  function reset(o = {}) {
    epoch++;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    inflight = 0;
    for (const ws of sockets) ws.terminate();
    sockets.clear();
    for (const s of streams) s.res.end();
    streams.clear();
    seed = o.seed ?? 1;
    scenario = o.scenario ?? "h";
    st = initialState();
    counts = new Map();
  }

  /** The server's truth after a trial (what the oracles compare the DOM with). */
  function snapshot() {
    return {
      items: st.items.map((i) => i.title),
      notes: st.notes.map((n) => n.text),
      todos: st.todos.map((t) => `${t.title}: ${t.done ? "done" : "open"}`),
      counter: st.counter,
      statusTicks: st.statusTicks,
      leftVersion: st.leftVersion,
      rightVersion: st.rightVersion,
    };
  }

  return {
    handle,
    handleUpgrade,
    reset,
    snapshot,
    calls: () => st.log.slice(),
    inflight: () => inflight,
    close: () => {
      reset();
      wss.close();
    },
  };
}
