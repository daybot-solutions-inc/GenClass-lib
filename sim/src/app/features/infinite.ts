// Cursor-paginated infinite scroll: GET <list>?status&sort&limit&after=<cursor> → {items, nextCursor} (bare-array
// APIs send the cursor in an `x-next-cursor` header). The scroll sentinel can fire load-more several times while a
// page is in flight, and a filter/sort change resets the list. Knobs: in-flight guard on load-more (else the same
// cursor is fetched twice and the page appended twice), generation token or abort on reset (else a page for the old
// filter lands in the new list and its cursor hijacks the next load), dedupe by id on append (offset cursors overlap
// when other users insert items at the top), keyset vs offset cursors, a derived "showing N" count.

import type { Item } from "../../net/server.js";
import { rel, type ExternalEvent, type FeatureDef, type Relation, type UserStep } from "../feature.js";
import type { CallOpts } from "../kit.js";
import { title } from "../naming.js";
import { apiOf, errMsg, seedItems, weightsOf } from "./common.js";

export interface InfiniteSpec {
  id: string;
  api: string;
  store: string;
  f: { list: string; cursor: string; more: string; loading: string; error: string; filter: string; sort: string; count: string };
  path: string;
  params: { after: string; limit: string; sort: string };
  nameField: string;
  statuses: string[];
  sorts: string[];
  items: Item[];
  words: string[];
  limit: number;
  cursorKind: "keyset" | "offset";
  inflightGuard: boolean;
  reset: "gen" | "abort" | "none";
  dedupe: boolean;
  countMode: "none" | "derived" | "incr-page";
  timeoutMs: number;
  onError: "show" | "silent";
  creates: number;
  labels: { list: string; filter: string; sort: string };
}

type Obj = Record<string, unknown>;

const cmp = (a: unknown, b: unknown): number => {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const x = String(a ?? "");
  const y = String(b ?? "");
  return x < y ? -1 : x > y ? 1 : 0;
};

function ordered(list: Item[], status: string, sort: string): Item[] {
  const all = list.filter((it) => status === "all" || it.status === status);
  if (sort === "newest") return all.slice().reverse();
  return all.slice().sort((a, b) => cmp(a[sort], b[sort]) || cmp(a.id, b.id));
}

const encCursor = (kind: string, v: string): string => btoa(`${kind === "offset" ? "o" : "k"}:${v}`);
function decCursor(c: string): string | null {
  try {
    const s = atob(c);
    const i = s.indexOf(":");
    return i > 0 ? s.slice(i + 1) : null;
  } catch {
    return null;
  }
}

export const infinite: FeatureDef<InfiniteSpec> = {
  kind: "infinite",
  make({ rng, entity, naming, id, api, clean }) {
    const g = <T>(good: T, v: T): T => (clean ? good : v);
    const statuses = entity.status.length >= 2 ? entity.status.slice(0, 4) : ["open", "closed"];
    const numField = entity.nums[0]?.[0];
    const reset = rng.weighted([["gen", 3], ["abort", 2], ["none", 3]] as const);
    const countMode = rng.weighted([["none", 3], ["derived", 4], ["incr-page", 2]] as const);
    return {
      id,
      api: api.name,
      store: naming.store(entity.p, rng.pick(["feed", "scroll", "list", "stream"])),
      f: {
        list: naming.field("list", id),
        cursor: naming.word(rng.pick(["cursor", "nextCursor", "endCursor", "after"])),
        more: naming.field("hasMore", id),
        loading: naming.field("loading", id),
        error: naming.field("error", id),
        filter: naming.field("filter", id),
        sort: naming.field("sort", id),
        count: naming.word(rng.pick(["shown", "loadedCount", "showing", "count"])),
      },
      path: naming.route(entity.p),
      params: { after: rng.pick(["after", "cursor", "page_token", "starting_after"]), limit: rng.pick(["limit", "first", "per_page", "size"]), sort: rng.pick(["sort", "order", "orderBy"]) },
      nameField: entity.name,
      statuses: ["all", ...statuses],
      sorts: ["newest", entity.name, ...(numField ? [numField] : [])],
      items: seedItems(rng, entity, rng.int(18, 48), (it) => {
        it.status = rng.pick(statuses);
      }),
      words: entity.words,
      limit: rng.pick([5, 8, 10, 12]),
      cursorKind: rng.weighted([["keyset", 3], ["offset", 2]] as const),
      inflightGuard: g(true, rng.bool(0.55)),
      reset: g(reset === "none" ? "gen" : reset, reset),
      dedupe: g(true, rng.bool(0.5)),
      countMode: g(countMode === "incr-page" ? "derived" : countMode, countMode),
      timeoutMs: rng.weighted([[0, 3], [rng.int(4000, 10000), 2]] as const),
      onError: rng.weighted([["show", 3], ["silent", 2]] as const),
      creates: rng.weighted([[0, 2], [1, 2], [3, 2], [6, 1]] as const),
      labels: {
        list: `list "${title(entity.p)}"`,
        filter: `tablist "${rng.pick(["Status", "Show", "Filter"])}"`,
        sort: `select "${rng.pick(["Sort by", "Order", "Sort"])}"`,
      },
    };
  },
  pattern(s) {
    return [s.inflightGuard ? "guard:inflight" : "guard:none", `reset:${s.reset}`, s.dedupe ? "dedupe" : "nodedupe", `cursor:${s.cursorKind}`, `count:${s.countMode}`];
  },
  relations(s): Relation[] {
    if (s.countMode === "none") return [];
    const c = `${s.store}.${s.f.count}`;
    const l = `${s.store}.${s.f.list}`;
    return [{ fields: [c, l], desc: "shown count equals number of loaded items", check: (st) => Number(rel.field(st, c)) === ((rel.field(st, l) as unknown[]) ?? []).length }];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:items`;
    for (const it of s.items) db.insert(coll, it, `seed:${String(it[s.nameField])}`);
    srv.route(
      "GET",
      s.path,
      (req) => {
        const status = req.query.get("status") ?? "all";
        const sort = req.query.get(s.params.sort) ?? s.sorts[0]!;
        const limit = Math.max(1, Math.min(50, Number(req.query.get(s.params.limit)) || s.limit));
        const after = req.query.get(s.params.after);
        const all = ordered(db.list(coll), status, sort);
        let start = 0;
        if (after) {
          const c = decCursor(after);
          if (c === null) return { status: 400, body: api.error("bad_cursor", "invalid cursor") };
          if (s.cursorKind === "offset") start = Math.max(0, Number(c) || 0);
          else {
            const i = all.findIndex((x) => String(x.id) === c);
            start = i >= 0 ? i + 1 : all.length;
          }
        }
        const page = all.slice(start, start + limit);
        const end = start + page.length;
        const next = end < all.length && page.length ? encCursor(s.cursorKind, s.cursorKind === "offset" ? String(end) : String(page[page.length - 1]!.id)) : null;
        const headers: Record<string, string> = {};
        if (next) headers["x-next-cursor"] = next;
        return { status: 200, body: api.list(page, { nextCursor: next }), headers };
      },
      { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const init: Obj = { [F.list]: [] as Item[], [F.cursor]: null, [F.more]: true, [F.loading]: true, [F.error]: null, [F.filter]: s.statuses[0], [F.sort]: s.sorts[0] };
    if (s.countMode !== "none") init[F.count] = 0;
    const key = `${s.id}.query`;
    let gen = 0;
    let moreInflight = 0;
    let pageInflight = 0;
    /** cursor -> op currently fetching it (a second fetch of the same cursor is an app-generated duplicate). */
    const byCursor = new Map<string, number>();
    let ctl: AbortController | null = null;
    /** The sentinel fired while a page was loading: load the next page once it lands (still at the bottom). */
    let wantMore: number | null = null;
    const S = env.store(s.store, s.id, init, {
      weights: weightsOf([[F.list, 1], [F.cursor, 0], [F.more, 0.2], [F.loading, 0.1], [F.error, 0], [F.filter, 0.4], [F.sort, 0.4], [F.count, 0.5]]),
      resync: () => reset(env.know.latestIntent(key)?.id, true),
    });
    function reset(intent: number | undefined, bg: boolean): Promise<void> {
      const my = ++gen;
      wantMore = null;
      if (s.reset === "abort" && ctl) ctl.abort();
      ctl = s.reset === "abort" ? new AbortController() : null;
      const patch: Obj = { [F.list]: [], [F.cursor]: null, [F.more]: true, [F.loading]: true, [F.error]: null };
      if (s.countMode !== "none") patch[F.count] = 0;
      kit.write(S, (p) => ({ ...p, ...patch }), { role: "reset", intent, key });
      return load(my, null, intent, bg);
    }
    async function load(my: number, cursor: string | null, intent: number | undefined, bg: boolean): Promise<void> {
      const append = cursor !== null;
      const cur = S.get();
      let url = `${s.path}?status=${encodeURIComponent(String(cur[F.filter]))}&${s.params.sort}=${encodeURIComponent(String(cur[F.sort]))}&${s.params.limit}=${s.limit}`;
      if (cursor !== null) url += `&${s.params.after}=${encodeURIComponent(cursor)}`;
      const same = cursor !== null ? byCursor.get(cursor) : undefined;
      const op = kit.op({ role: append ? "more" : "page", method: "GET", url, intent, key, background: bg, handled: s.onError === "silent", ...(same !== undefined ? { dupOf: same } : {}) });
      if (cursor !== null) {
        moreInflight++;
        byCursor.set(cursor, op.id);
        kit.write(S, (p) => ({ ...p, [F.loading]: true }), { role: "loading", intent, key });
      } else pageInflight++;
      const opts: CallOpts = {};
      if (ctl) opts.signal = ctl.signal;
      if (s.timeoutMs) opts.timeoutMs = s.timeoutMs;
      const r = await kit.call(op, opts);
      if (cursor !== null) {
        moreInflight--;
        if (byCursor.get(cursor) === op.id) byCursor.delete(cursor);
      } else pageInflight--;
      if (r.outcome === "aborted") return;
      // Generation token: a page requested for an older filter/sort is dropped.
      if (s.reset === "gen" && my !== gen) return;
      const busy = moreInflight + pageInflight > 0;
      if (!r.ok) {
        const msg = s.onError === "show" ? errMsg(r.status, r.outcome) : null;
        kit.write(S, (p) => ({ ...p, [F.loading]: busy, ...(msg ? { [F.error]: msg } : {}) }), { role: "error", op, intent, key });
        if (msg) kit.shownError();
        return;
      }
      const { items, extra } = kit.api.unlist(r.body);
      const nc = extra.nextCursor;
      const next: string | null = typeof nc === "string" ? nc : nc === null ? null : r.headers?.get("x-next-cursor") ?? null;
      const prevNow = append ? ((S.get()[F.list] as Item[]) ?? []) : [];
      const overlap = items.some((x) => prevNow.some((y) => y.id === x.id));
      const classify = () => {
        if (my !== gen) return "stale";
        if (append && items.length > 0) {
          const list = (S.get()[F.list] as Item[]) ?? [];
          if (items.every((x) => list.some((y) => y.id === x.id))) return "duplicate";
        }
        return undefined;
      };
      const dedupe = s.dedupe;
      const mode = s.countMode;
      kit.write(
        S,
        (p) => {
          const prev = append ? ((p[F.list] as Item[]) ?? []) : [];
          const add = dedupe ? items.filter((x) => !prev.some((y) => y.id === x.id)) : items;
          const list = [...prev, ...add];
          const o: Obj = { ...p, [F.list]: list, [F.cursor]: next, [F.more]: next !== null, [F.loading]: busy, [F.error]: null };
          if (mode === "derived") o[F.count] = list.length;
          // Defect: counts the page, not what was actually appended after dedupe.
          else if (mode === "incr-page") o[F.count] = (append ? Number(p[F.count] ?? 0) : 0) + items.length;
          return o;
        },
        { role: append ? "append" : "results", op, intent, key, classify, ...(mode === "incr-page" && dedupe && overlap ? { anomaly: "partial" } : {}) },
      );
      if (wantMore !== null && !busy && my === gen && next !== null) {
        const again = wantMore;
        wantMore = null;
        kit.spawn(() => load(gen, next, again, false), "uncaught", { cause: "page-failed", diagnosis: "failing" });
      }
    }
    return {
      init() {
        kit.spawn(() => load(gen, null, undefined, true), "swallow");
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "filter" || step.action === "sort") {
          const field = step.action === "filter" ? F.filter : F.sort;
          const v = String(step.ui.value ?? "");
          kit.write(S, (p) => ({ ...p, [field]: v }), { role: "input", intent, key });
          kit.spawn(() => reset(intent, false), "uncaught", { cause: "page-failed", diagnosis: "failing" });
          return;
        }
        // The scroll sentinel became visible: load the next page.
        const cur = S.get();
        const cursor = cur[F.cursor];
        const repeat = env.know.getIntent(intent)?.accidental === true;
        if (cur[F.more] === false) return;
        // First page still loading (no cursor yet): the sentinel stays visible and fires again once it renders.
        if (typeof cursor !== "string") {
          if (pageInflight > 0 && !repeat) wantMore = intent;
          return;
        }
        if (s.inflightGuard && moreInflight + pageInflight > 0) {
          if (!repeat) wantMore = intent;
          return;
        }
        kit.spawn(() => load(gen, cursor, intent, false), "uncaught", { cause: "page-failed", diagnosis: "failing" });
      },
      cond(name) {
        return name === "loading-more" ? moreInflight > 0 : moreInflight + pageInflight > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(0.8);
    let filter = s.statuses[0]!;
    let sort = s.sorts[0]!;
    while (t < win.t1 - 800) {
      const r = user.rng.next();
      if (r < 0.62) {
        // Reaching the bottom: the sentinel fires, sometimes twice within a few hundred ms (not in clean runs, whose
        // personas never repeat); impatient users keep scrolling while the spinner shows.
        const sentinelDouble = user.p.doubleClickP > 0 || user.p.impatientP > 0 ? 0.3 : 0;
        const c = user.click(t, s.labels.list, "more", { kind: "more", key: `${s.id}.more` }, { kind: "key", value: "scroll", doubleP: sentinelDouble, pendingCond: "loading-more" });
        steps.push(...c.steps);
        t += user.rng.bool(0.3) ? user.rng.float(250, 900) : user.think(1.2);
        continue;
      }
      if (r < 0.85) {
        filter = user.rng.pick(s.statuses.filter((x) => x !== filter));
        steps.push({ t, feature: s.id, action: "filter", ui: { kind: "click", target: `${s.labels.filter.replace(/"$/, "")}: ${title(filter)}"`, value: filter }, intent: { kind: "filter", key: `${s.id}.query`, mode: "replace", accidental: false } });
      } else {
        sort = user.rng.pick(s.sorts.filter((x) => x !== sort));
        steps.push({ t, feature: s.id, action: "sort", ui: { kind: "change", target: s.labels.sort, value: sort }, intent: { kind: "sort", key: `${s.id}.query`, mode: "replace", accidental: false } });
      }
      // Right after a reset the user often scrolls straight down again (load-more racing the first page).
      t += user.rng.bool(0.35) ? user.rng.float(200, 700) : user.think(1.1);
    }
    return steps;
  },
  external(s, rng, win) {
    const out: ExternalEvent[] = [];
    const statuses = s.statuses.filter((x) => x !== "all");
    for (let i = 0; i < s.creates; i++) {
      const t = rng.float(win.t0 + 1000, Math.max(win.t0 + 1100, win.t1));
      const base = rng.pick(s.items);
      const name = `${rng.pick(s.words)} ${rng.pick(s.words)}`;
      const status = rng.pick(statuses);
      out.push({
        t,
        feature: s.id,
        desc: `another user adds ${name}`,
        apply(w) {
          w.db.insert(`${s.id}:items`, { ...base, [s.nameField]: name, status }, `ext:${i}:${name}`, w.now());
        },
      });
    }
    return out;
  },
};
