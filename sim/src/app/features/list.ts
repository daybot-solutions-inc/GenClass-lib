// Filtered, sorted list with infinite scroll ("load more"). Knobs: request-id / abort guard on filter changes,
// in-flight guard on load-more (scroll events fire repeatedly: duplicate page appends otherwise), page reset on
// filter change, total maintained from the response.

import type { Item } from "../../net/server.js";
import type { FeatureDef, UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, ContentBook, errMsg, idsKey, seedItems, weightsOf } from "./common.js";

export interface ListSpec {
  id: string;
  api: string;
  store: string;
  f: { list: string; filter: string; sort: string; page: string; more: string; loading: string; error: string };
  path: string;
  statusField: string;
  statuses: string[];
  sortFields: string[];
  items: Item[];
  pageSize: number;
  guard: "none" | "reqid" | "abort";
  moreGuard: boolean;
  filterLabel: string;
  sortLabel: string;
}

export const list: FeatureDef<ListSpec> = {
  kind: "list",
  make({ rng, entity, naming, id, api }) {
    const statuses = entity.status.length >= 2 ? entity.status : ["open", "closed"];
    return {
      id,
      api: api.name,
      store: naming.store(entity.p, rng.pick(["list", "table", "index", "browser"])),
      f: { list: naming.field("list", id), filter: naming.field("filter", id), sort: naming.field("sort", id), page: naming.field("page", id), more: naming.field("hasMore", id), loading: naming.field("loading", id), error: naming.field("error", id) },
      path: naming.route(entity.p),
      statusField: "status",
      statuses: ["all", ...statuses],
      sortFields: [entity.name, ...entity.nums.map((n) => n[0])].slice(0, 3),
      items: seedItems(rng, entity, rng.int(15, 45), (it) => {
        it.status = rng.pick(statuses);
      }),
      pageSize: rng.pick([5, 8, 10]),
      guard: rng.weighted([["none", 4], ["reqid", 3], ["abort", 2]] as const),
      moreGuard: rng.bool(0.5),
      filterLabel: `select "${rng.pick(["Status", "Show", "Filter"])}"`,
      sortLabel: `select "${rng.pick(["Sort by", "Order", "Sort"])}"`,
    };
  },
  pattern(s) {
    return [`guard:${s.guard}`, s.moreGuard ? "more-guard" : "more-noguard"];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:items`;
    for (const it of s.items) db.insert(coll, it, `seed:${JSON.stringify(it)}`);
    srv.route(
      "GET",
      s.path,
      (req) => {
        const st = req.query.get("status") ?? "all";
        const sort = req.query.get("sort") ?? s.sortFields[0]!;
        const page = Number(req.query.get("page") ?? "1");
        let all = db.list(coll).filter((it) => st === "all" || it.status === st);
        all = all.slice().sort((a, b) => (String(a[sort]) < String(b[sort]) ? -1 : String(a[sort]) > String(b[sort]) ? 1 : 0));
        const slice = all.slice((page - 1) * s.pageSize, page * s.pageSize);
        return { status: 200, body: api.list(slice, { page, hasMore: page * s.pageSize < all.length, total: all.length }) };
      },
      { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const init: Record<string, unknown> = { [F.list]: [] as Item[], [F.filter]: "all", [F.sort]: s.sortFields[0], [F.page]: 0, [F.more]: true, [F.loading]: false, [F.error]: null };
    const book = new ContentBook(env.know);
    const S = env.store(s.store, s.id, init, {
      weights: weightsOf([[F.list, 1], [F.filter, 0.4], [F.sort, 0.4], [F.page, 0.2], [F.more, 0.2], [F.loading, 0.1], [F.error, 0]]),
      resync: () => fetchPage(1, false, env.know.latestIntent(`${s.id}.query`)?.id, true),
    });
    const qkey = `${s.id}.query`;
    let latest = 0;
    let ctl: AbortController | null = null;
    let moreInflight = 0;
    async function fetchPage(page: number, append: boolean, intent: number | undefined, bg = false): Promise<void> {
      if (append && s.moreGuard && moreInflight > 0) return;
      const cur = S.get();
      const filter = String(cur[F.filter]);
      const sort = String(cur[F.sort]);
      const my = ++latest;
      if (!append && s.guard === "abort" && ctl) ctl.abort();
      const myCtl = !append && s.guard === "abort" ? new AbortController() : null;
      if (myCtl) ctl = myCtl;
      if (append) moreInflight++;
      kit.write(S, (p) => ({ ...p, [F.loading]: true }), { role: "loading", key: qkey, ...(intent !== undefined ? { intent } : {}) });
      const url = `${s.path}?status=${filter}&sort=${sort}&page=${page}`;
      const it = intent !== undefined ? env.know.getIntent(intent) : undefined;
      const op = kit.op({ role: append ? "more" : "page", method: "GET", url, key: qkey, background: bg, ...(intent !== undefined ? { intent } : {}), ...(it?.accidental ? { dupOf: it.repeatOf } : {}) });
      const opts: { signal?: AbortSignal; timeoutMs?: number } = { timeoutMs: 9000 };
      if (myCtl) opts.signal = myCtl.signal;
      const r = await kit.call(op, opts);
      if (append) moreInflight--;
      if (r.outcome === "aborted") return;
      if (!append && s.guard === "reqid" && my !== latest) return;
      if (!r.ok) {
        kit.write(S, (p) => ({ ...p, [F.loading]: false, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, key: qkey });
        kit.shownError();
        return;
      }
      const { items, extra } = kit.api.unlist(r.body);
      const hasMore = extra.hasMore === true || (extra.total !== undefined && Number(extra.total) > page * s.pageSize);
      const filterNow = String(S.get()[F.filter]);
      const sortNow = String(S.get()[F.sort]);
      const classify = () => {
        if (filterNow !== filter || sortNow !== sort || String(S.get()[F.filter]) !== filter || String(S.get()[F.sort]) !== sort) return "stale";
        if (append) {
          const curList = (S.get()[F.list] as Item[]) ?? [];
          if (items.length > 0 && items.every((x) => curList.some((y) => y.id === x.id))) return "duplicate";
        }
        if (!append && intent !== undefined && env.know.superseded(intent)) {
          const shown = book.shown(idsKey(S.get()[F.list]));
          if (shown !== undefined && shown > intent) return "stale";
        }
        return undefined;
      };
      if (!append) book.note(intent, idsKey(items));
      kit.write(
        S,
        (p) => ({ ...p, [F.list]: append ? [...((p[F.list] as Item[]) ?? []), ...items] : items, [F.page]: page, [F.more]: hasMore, [F.loading]: false, [F.error]: null }),
        { role: append ? "append" : "results", op, key: qkey, classify, ...(intent !== undefined ? { intent } : {}) },
      );
    }
    return {
      init() {
        kit.spawn(() => fetchPage(1, false, 0, true), "swallow");
        book.note(0, idsKey([]));
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "filter") {
          kit.write(S, (p) => ({ ...p, [F.filter]: String(step.ui.value), [F.page]: 0 }), { role: "input", intent, key: qkey });
          kit.spawn(() => fetchPage(1, false, intent), "uncaught", { cause: "list-failed", diagnosis: "failing" });
        } else if (step.action === "sort") {
          kit.write(S, (p) => ({ ...p, [F.sort]: String(step.ui.value), [F.page]: 0 }), { role: "input", intent, key: qkey });
          kit.spawn(() => fetchPage(1, false, intent), "uncaught", { cause: "list-failed", diagnosis: "failing" });
        } else {
          const cur = S.get();
          if (cur[F.more] === false) return;
          kit.spawn(() => fetchPage(Number(cur[F.page] ?? 0) + 1, true, intent), "uncaught", { cause: "list-failed", diagnosis: "failing" });
        }
      },
      cond() {
        return moreInflight > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(1);
    while (t < win.t1 - 800) {
      const r = user.rng.next();
      if (r < 0.3) {
        steps.push({ t, feature: s.id, action: "filter", ui: { kind: "change", target: s.filterLabel, value: user.rng.pick(s.statuses) }, intent: { kind: "filter", key: `${s.id}.query`, mode: "replace", accidental: false } });
      } else if (r < 0.45) {
        steps.push({ t, feature: s.id, action: "sort", ui: { kind: "change", target: s.sortLabel, value: user.rng.pick(s.sortFields) }, intent: { kind: "sort", key: `${s.id}.query`, mode: "replace", accidental: false } });
      } else {
        // Scrolling to the bottom fires the load-more handler, sometimes repeatedly within a few hundred ms.
        const c = user.click(t, `list "${title(s.store)}"`, "more", { kind: "more", key: `${s.id}.more` }, { kind: "key", value: "scroll", doubleP: 0.35 });
        steps.push(...c.steps);
      }
      t += user.think(1.1);
    }
    return steps;
  },
};
