// Heavy client work on the main thread: a large filterable table whose responses are processed (sorted, formatted,
// rendered) synchronously. env.busy(ms) blocks the thread: input handlers, debounced timers and polls queued during
// the block run late, and users re-click because nothing happened (clicks queued during the block are delivered
// right after it). Knobs: one big block (defect) vs chunked work yielding with setTimeout(0) between slices or a
// virtualized render (guards); debounced input vs a request + render per keystroke; request-id guard on results;
// busy flag released after the queued input (a disabled button swallows the queued clicks) vs released at once;
// background auto-refresh.

import type { Item } from "../../net/server.js";
import type { Store } from "../env.js";
import type { FeatureDef, UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, errMsg, queryWords, seedItems, weightsOf } from "./common.js";

export interface LongtaskSpec {
  id: string;
  api: string;
  store: string;
  f: { query: string; rows: string; total: string; sort: string; loading: string; error: string };
  path: string;
  qParam: string;
  nameField: string;
  sortFields: string[];
  items: Item[];
  perRowMs: number;
  render: "block" | "chunked" | "virtual";
  chunks: number;
  input: "debounce" | "every-key";
  debounceMs: number;
  reqGuard: boolean;
  busyGuard: boolean;
  autoRefreshMs: number;
  inputLabel: string;
  refreshLabel: string;
  queries: string[];
}

const STUCK_MS = 250;
const cmp = (f: string, dir: string) => (a: Item, b: Item) => {
  const x = a[f];
  const y = b[f];
  const r = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
  return dir === "desc" ? -r : r;
};

export const longtask: FeatureDef<LongtaskSpec> = {
  kind: "longtask",
  make({ rng, entity, naming, id, api, clean }) {
    const render = rng.weighted([["block", 5], ["chunked", 3], ["virtual", 2]] as const);
    const input = rng.weighted([["debounce", 3], ["every-key", 2]] as const);
    const reqGuard = rng.bool(0.5);
    const busyGuard = rng.bool(0.4);
    return {
      id,
      api: api.name,
      store: naming.store(entity.p, rng.pick(["table", "grid", "report", "explorer"])),
      f: { query: naming.field("query", id), rows: naming.field("list", id), total: naming.field("total", id), sort: naming.field("sort", id), loading: naming.field("loading", id), error: naming.field("error", id) },
      path: naming.route(entity.p, rng.pick(["", "table", "export", "all"]).trim() || "all"),
      qParam: rng.pick(["q", "filter", "search", "contains"]),
      nameField: entity.name,
      sortFields: [entity.name, ...entity.nums.map((n) => n[0])].slice(0, 3),
      items: seedItems(rng, entity, rng.int(60, 240)),
      perRowMs: rng.float(1.5, 9),
      render: clean && render === "block" ? "chunked" : render,
      chunks: rng.int(3, 8),
      input: clean ? "debounce" : input,
      debounceMs: rng.int(150, 450),
      reqGuard: clean || reqGuard,
      busyGuard: clean || busyGuard,
      autoRefreshMs: rng.weighted([[0, 3], [rng.int(4000, 12000), 2]] as const),
      inputLabel: `input "${rng.pick(["Filter", "Search", "Find in table"])} ${entity.p}"`,
      refreshLabel: `button "${rng.pick(["Refresh", "Reload data", "Run report"])}"`,
      queries: queryWords(rng, entity),
    };
  },
  pattern(s) {
    return [`render:${s.render}`, `input:${s.input}`, s.reqGuard ? "reqid" : "noreqid", s.busyGuard ? "busy-guard" : "no-busy-guard", s.autoRefreshMs ? "autorefresh" : "noautorefresh"];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:rows`;
    for (const it of s.items) db.insert(coll, it, `seed:${JSON.stringify(it)}`);
    srv.route(
      "GET",
      s.path,
      (req) => {
        const q = (req.query.get(s.qParam) ?? "").toLowerCase();
        const all = db.list(coll).filter((it) => String(it[s.nameField] ?? "").toLowerCase().includes(q));
        return { status: 200, body: api.list(all, { total: all.length }) };
      },
      { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const qkey = `${s.id}.query`;
    const init: Record<string, unknown> = { [F.query]: "", [F.rows]: [] as Item[], [F.total]: 0, [F.sort]: `${s.sortFields[0]}:asc`, [F.loading]: false, [F.error]: null };
    const S: Store<Record<string, unknown>> = env.store(s.store, s.id, init, {
      weights: weightsOf([[F.query, 0.4], [F.rows, 1], [F.total, 0.3], [F.sort, 0.4], [F.loading, 0.1], [F.error, 0]]),
      resync: (): Promise<void> => fetchRows(String(S.get()[F.query] ?? ""), env.know.latestIntent(qkey)?.id, true, "resync"),
    });
    let latest = 0;
    let inflight = 0;
    let refreshing = 0;
    let busy = false;
    let lastLongEnd = -1;
    let timer: unknown = null;
    const cost = (n: number) => Math.max(100, Math.min(1500, n * s.perRowMs));
    const block = (ms: number) => {
      env.busy(ms);
      if (ms >= STUCK_MS) lastLongEnd = env.now();
    };
    // Process rows (sort + format + render). Returns false when the work was abandoned for newer work.
    async function process(n: number, still: () => boolean): Promise<boolean> {
      const total = cost(n);
      if (s.render === "virtual") block(Math.min(total, 60));
      else if (s.render === "block") block(total);
      else {
        for (let i = 0; i < s.chunks; i++) {
          block(total / s.chunks);
          await env.sleep(0);
          if (!still()) return false;
        }
      }
      return true;
    }
    const release = () => {
      if (s.busyGuard) env.setTimeout(() => (busy = false), 0);
      else busy = false;
    };
    async function fetchRows(q: string, intent: number | undefined, bg: boolean, role: string): Promise<void> {
      const my = ++latest;
      inflight++;
      if (!bg) kit.write(S, (p) => ({ ...p, [F.loading]: true }), { role: "loading", intent, key: qkey });
      const op = kit.op({ role, method: "GET", url: `${s.path}?${s.qParam}=${encodeURIComponent(q)}`, intent, key: qkey, background: bg, handled: true });
      const r = await kit.call(op, { timeoutMs: 12000 });
      inflight--;
      if (s.reqGuard && my !== latest) return;
      if (!r.ok) {
        kit.write(S, (p) => ({ ...p, [F.loading]: inflight > 0, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, intent, key: qkey });
        if (!bg) kit.shownError();
        return;
      }
      const { items, extra } = kit.api.unlist(r.body);
      busy = true;
      const [field, dir] = String(S.get()[F.sort]).split(":");
      const ok = await process(items.length, () => !s.reqGuard || my === latest);
      if (!ok) return release();
      const rows = items.slice().sort(cmp(field!, dir!));
      const total = typeof extra.total === "number" ? extra.total : rows.length;
      const classify = () => (String(S.get()[F.query] ?? "") !== q && intent !== undefined && env.know.superseded(intent) ? "stale" : undefined);
      kit.write(S, (p) => ({ ...p, [F.rows]: rows, [F.total]: total, [F.loading]: inflight > 0, [F.error]: null }), { role: "results", op, intent, key: qkey, classify });
      release();
    }
    function sortBy(intent: number, field: string): void {
      if (s.busyGuard && busy) return;
      const [cur, dir] = String(S.get()[F.sort]).split(":");
      const next = `${field}:${cur === field && dir === "asc" ? "desc" : "asc"}`;
      kit.write(S, (p) => ({ ...p, [F.sort]: next }), { role: "input", intent, key: `${s.id}.sort` });
      busy = true;
      kit.spawn(async () => {
        const rows = ((S.get()[F.rows] as Item[]) ?? []).slice();
        const ok = await process(rows.length, () => S.get()[F.sort] === next);
        if (!ok) return release();
        const [f, d] = next.split(":");
        kit.write(S, (p) => ({ ...p, [F.rows]: rows.sort(cmp(f!, d!)) }), { role: "sorted", intent, key: `${s.id}.sort` });
        release();
      }, "swallow");
    }
    return {
      init() {
        kit.spawn(() => fetchRows("", undefined, true, "initial"), "swallow");
        if (s.autoRefreshMs) {
          env.setInterval(() => {
            if (inflight > 0) return;
            kit.spawn(() => fetchRows(String(S.get()[F.query] ?? ""), env.know.latestIntent(qkey)?.id, true, "auto-refresh"), "swallow");
          }, s.autoRefreshMs);
        }
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "type") {
          const q = String(step.ui.value ?? "");
          kit.write(S, (p) => ({ ...p, [F.query]: q }), { role: "input", intent, key: qkey });
          if (s.input === "every-key") return void kit.spawn(() => fetchRows(q, intent, false, "filter"), "swallow");
          if (timer) env.clearTimeout(timer);
          timer = env.setTimeout(() => {
            timer = null;
            kit.spawn(() => fetchRows(q, intent, false, "filter"), "swallow");
          }, s.debounceMs);
          return;
        }
        if (step.action === "sort") return sortBy(intent, String(step.args?.field ?? s.sortFields[0]));
        if (s.busyGuard && (busy || refreshing > 0)) return;
        refreshing++;
        kit.spawn(async () => {
          try {
            await fetchRows(String(S.get()[F.query] ?? ""), intent, false, "refresh");
          } finally {
            refreshing--;
          }
        }, "swallow");
      },
      cond(name) {
        // "stuck": this click was queued while the main thread was blocked (the user saw nothing happen).
        if (name === "stuck") return lastLongEnd >= 0 && env.now() - lastLongEnd < 1;
        return inflight > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(0.6);
    let cur = "";
    let qi = 0;
    // Impatient re-clicks: delivered only if the click was queued behind a long task (when: "stuck").
    const stuckRepeat = (base: UserStep) => {
      if (!user.rng.bool(Math.max(0.25, user.p.impatientP))) return;
      const n = user.rng.int(1, 2);
      let tt = base.t + user.rng.float(150, 700);
      for (let i = 0; i < n; i++) {
        steps.push({ ...base, t: tt, intent: { ...base.intent, accidental: true }, when: "stuck", repeatOf: -1 });
        tt += user.rng.float(120, 500);
      }
    };
    while (t < win.t1 - 1000) {
      const r = user.rng.next();
      if (r < 0.45) {
        const word = s.queries[qi++ % s.queries.length]!;
        const text = cur && user.rng.bool(0.4) ? "" : word.slice(0, user.rng.int(2, Math.max(2, word.length)));
        if (!text) {
          for (let i = cur.length; i > 0; i--) {
            t += user.key() * 0.6;
            cur = cur.slice(0, -1);
            steps.push({ t, feature: s.id, action: "type", ui: { kind: "type", target: s.inputLabel, value: cur }, intent: { kind: "query", key: `${s.id}.query`, mode: "replace", accidental: false } });
          }
        } else {
          const typed = user.type(t, cur, text, s.inputLabel, "type", `${s.id}.query`);
          for (const st of typed.steps) st.intent.kind = "query";
          steps.push(...typed.steps);
          t = typed.t;
          cur = typed.steps.length ? String(typed.steps[typed.steps.length - 1]!.ui.value) : cur;
        }
      } else if (r < 0.8) {
        const field = user.rng.pick(s.sortFields);
        const base: UserStep = { t, feature: s.id, action: "sort", ui: { kind: "click", target: `columnheader "${title(field)}"` }, args: { field }, intent: { kind: "sort", key: `${s.id}.sort`, mode: "replace", accidental: false } };
        steps.push(base);
        stuckRepeat(base);
      } else {
        const c = user.click(t, s.refreshLabel, "refresh", { kind: "refresh", key: `${s.id}.refresh`, mode: "replace" }, { pendingCond: "loading" });
        steps.push(...c.steps);
        stuckRepeat(c.steps[0]!);
      }
      t += user.think(1.3);
    }
    return steps;
  },
};
