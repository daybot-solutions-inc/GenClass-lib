// Search-as-you-type: input → (debounce) → GET search → results. Guards: abort previous, request ids, query check,
// cache. Defects: none of them (out-of-order responses overwrite newer results), errors thrown unhandled.

import type { Item } from "../../net/server.js";
import type { Store } from "../env.js";
import type { FeatureDef, UserStep } from "../feature.js";
import { errorFor } from "../kit.js";
import { title } from "../naming.js";
import { apiOf, ContentBook, errMsg, idsKey, queryWords, seedItems, weightsOf } from "./common.js";

export interface SearchSpec {
  id: string;
  api: string;
  store: string;
  f: { query: string; list: string; total: string; loading: string; error: string };
  path: string;
  qParam: string;
  coll: string;
  nameField: string;
  items: Item[];
  debounce: number;
  guard: "none" | "abort" | "reqid" | "check";
  cache: boolean;
  minLen: number;
  loadingFlag: boolean;
  totalField: boolean;
  onError: "show" | "silent" | "throw";
  timeoutMs: number;
  label: string;
  queries: string[];
  pageSize: number;
}

export const search: FeatureDef<SearchSpec> = {
  kind: "search",
  make({ rng, entity, naming, id, api }) {
    const guard = rng.weighted([["none", 4], ["abort", 2], ["reqid", 2], ["check", 2]] as const);
    return {
      id,
      api: api.name,
      store: naming.store(entity.s, rng.pick(["search", "finder", "lookup", "results"])),
      f: {
        query: naming.field("query", id),
        list: naming.field("list", id),
        total: naming.field("total", id),
        loading: naming.field("loading", id),
        error: naming.field("error", id),
      },
      path: naming.route(entity.p, rng.pick(["search", "", "find", "query"]).trim() || "search"),
      qParam: rng.pick(["q", "query", "search", "term", "text"]),
      coll: entity.p,
      nameField: entity.name,
      items: seedItems(rng, entity, rng.int(12, 40)),
      debounce: rng.weighted([[0, 4], [rng.int(120, 450), 4]] as const),
      guard,
      cache: rng.bool(0.25),
      minLen: rng.weighted([[0, 2], [1, 2], [2, 2]] as const),
      loadingFlag: rng.bool(0.7),
      totalField: rng.bool(0.6),
      onError: rng.weighted([["show", 5], ["silent", 2], ["throw", 2]] as const),
      timeoutMs: rng.weighted([[0, 3], [rng.int(2500, 9000), 2]] as const),
      label: `input "${rng.pick(["Search", "Find", "Filter", "Look up"])} ${entity.p}"`,
      queries: queryWords(rng, entity),
      pageSize: rng.pick([10, 20, 25]),
    };
  },
  pattern(s) {
    return [`guard:${s.guard}`, s.debounce ? "debounce" : "nodebounce", s.cache ? "cache" : "nocache", `err:${s.onError}`, s.timeoutMs ? "timeout" : "notimeout"];
  },
  server(s, srv, db) {
    const coll = `${s.id}:${s.coll}`;
    for (const it of s.items) db.insert(coll, it, `seed:${it[s.nameField]}`);
    srv.route(
      "GET",
      s.path,
      (req) => {
        const q = (req.query.get(s.qParam) ?? "").toLowerCase();
        const all = db.list(coll).filter((it) => String(it[s.nameField] ?? "").toLowerCase().includes(q));
        return { status: 200, body: apiOf(s.api).list(all.slice(0, s.pageSize), { total: all.length }) };
      },
      { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const init: Record<string, unknown> = { [F.query]: "", [F.list]: [] as Item[], [F.loading]: false, [F.error]: null };
    if (s.totalField) init[F.total] = 0;
    let latest = 0;
    let timer: unknown = null;
    let ctl: AbortController | null = null;
    const cache = new Map<string, { items: Item[]; total: number }>();
    const book = new ContentBook(env.know);
    const key = `${s.id}.query`;
    const S: Store<Record<string, unknown>> = env.store(s.store, s.id, init, {
      weights: weightsOf([[F.query, 0.4], [F.list, 1], [F.total, 0.4], [F.loading, 0.12], [F.error, 0]]),
      resync: (): void => run(String(S.get()[F.query] ?? ""), env.know.latestIntent(key)?.id, true),
    });
    const classifyResults = (intent: number | undefined) => () => {
      if (intent === undefined) return undefined;
      if (!env.know.superseded(intent)) return "expected";
      const shown = book.shown(idsKey(S.get()[F.list]));
      return shown !== undefined && shown > intent ? "stale" : "expected";
    };
    function run(q: string, intent: number | undefined, fromResync = false): void {
      if (q.length < s.minLen) {
        if (ctl) ctl.abort();
        book.note(intent, idsKey([]));
        const patch: Record<string, unknown> = { [F.list]: [], [F.loading]: false };
        if (s.totalField) patch[F.total] = 0;
        kit.write(S, (p) => ({ ...p, ...patch }), { role: "clear", intent, key });
        return;
      }
      const hit = s.cache && !fromResync ? cache.get(q) : undefined;
      if (hit) {
        book.note(intent, idsKey(hit.items));
        const patch: Record<string, unknown> = { [F.list]: hit.items, [F.loading]: false, [F.error]: null };
        if (s.totalField) patch[F.total] = hit.total;
        kit.write(S, (p) => ({ ...p, ...patch }), { role: "cache", intent, key });
        return;
      }
      const my = ++latest;
      if (s.guard === "abort" && ctl) ctl.abort();
      const myCtl = s.guard === "abort" ? new AbortController() : null;
      ctl = myCtl;
      if (s.loadingFlag) kit.write(S, (p) => ({ ...p, [F.loading]: true }), { role: "loading", intent, key });
      const url = `${s.path}?${s.qParam}=${encodeURIComponent(q)}`;
      const op = kit.op({ role: "search", method: "GET", url, intent, key, background: fromResync });
      kit.spawn(
        async () => {
          const opts: { signal?: AbortSignal; timeoutMs?: number } = {};
          if (myCtl) opts.signal = myCtl.signal;
          if (s.timeoutMs) opts.timeoutMs = s.timeoutMs;
          const r = await kit.call(op, opts);
          if (r.outcome === "aborted") return;
          if (s.guard === "reqid" && my !== latest) return;
          if (s.guard === "check" && S.get()[F.query] !== q) return;
          if (!r.ok) {
            if (s.onError === "throw") {
              kit.write(S, (p) => ({ ...p, [F.loading]: false }), { role: "loading", intent, key, op });
              throw errorFor(r, `search ${q}`);
            }
            const patch: Record<string, unknown> = { [F.loading]: false };
            if (s.onError === "show") {
              patch[F.error] = errMsg(r.status, r.outcome);
              kit.shownError();
            }
            kit.write(S, (p) => ({ ...p, ...patch }), { role: "error", intent, key, op });
            return;
          }
          const { items, extra } = kit.api.unlist(r.body);
          const total = typeof extra.total === "number" ? extra.total : items.length;
          if (s.cache) cache.set(q, { items, total });
          book.note(intent, idsKey(items));
          const patch: Record<string, unknown> = { [F.list]: items, [F.loading]: false, [F.error]: null };
          if (s.totalField) patch[F.total] = total;
          kit.write(S, (p) => ({ ...p, ...patch }), { role: "results", intent, key, op, classify: classifyResults(intent) });
        },
        "uncaught",
        { cause: "search-failed", diagnosis: "failing", op },
      );
    }
    return {
      init() {
        book.note(0, idsKey([]));
      },
      handle(step: UserStep, intent: number) {
        const q = String(step.ui.value ?? "");
        kit.write(S, (p) => ({ ...p, [F.query]: q }), { role: "input", intent, key });
        if (s.debounce) {
          if (timer) env.clearTimeout(timer);
          timer = env.setTimeout(() => {
            timer = null;
            run(q, intent);
          }, s.debounce);
        } else run(q, intent);
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(0.5);
    let cur = "";
    let qi = 0;
    while (t < win.t1 - 800) {
      const word = s.queries[qi++ % s.queries.length]!;
      const r = user.rng.next();
      let text: string;
      if (cur && r < 0.3) {
        // refine: append more letters / a second word
        text = user.rng.bool(0.5) ? " " + word.slice(0, user.rng.int(2, word.length)) : word.slice(0, 2);
      } else if (cur && r < 0.45) {
        // clear and retype
        const back = cur.length;
        for (let i = 0; i < back; i++) {
          t += user.key() * 0.6;
          cur = cur.slice(0, -1);
          steps.push({ t, feature: s.id, action: "type", ui: { kind: "type", target: s.label, value: cur }, intent: { kind: "query", key: `${s.id}.query`, mode: "replace", accidental: false } });
        }
        text = word.slice(0, user.rng.int(2, word.length));
      } else {
        text = cur ? "" : word.slice(0, user.rng.int(2, word.length));
        if (!text) {
          t += user.think();
          continue;
        }
      }
      const typed = user.type(t, cur, text, s.label, "type", `${s.id}.query`);
      for (const st of typed.steps) st.intent.kind = "query";
      steps.push(...typed.steps);
      t = typed.t;
      cur = typed.steps.length ? String(typed.steps[typed.steps.length - 1]!.ui.value) : cur;
      t += user.think(1.3);
    }
    return steps;
  },
};

export function searchLabel(entity: string): string {
  return title(entity);
}
