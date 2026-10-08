// GraphQL-style batched queries. Components (list, total, stats/recent/viewer widgets) request fields; a batching
// window (5-30 ms, env timers, DataLoader-style dedupe per field) merges them into one POST /graphql {ops:[...]}
// answered with {data:{...}, errors:[...]}; resolvers fail now and then (partial errors). A create mutation rides
// in the same batch as the refetches it needs. Knobs: batching window vs one request per field (request storms;
// an unbatched mutation races its own refetch), retry policy (whole batch = the mutation runs again; idempotent =
// re-ask only failed queries), field errors (keep previous data vs write null over good data), per-field sequence
// guard (out-of-order batches), add-button guard.

import type { Item } from "../../net/server.js";
import { canonical } from "../../net/server.js";
import type { SimOp } from "../../oracle/knowledge.js";
import { u01, type Rng } from "../../rng.js";
import { round2, type ExternalEvent, type FeatureDef, type UserStep } from "../feature.js";
import { title } from "../naming.js";
import { errMsg, seedItems, weightsOf } from "./common.js";

type CompKind = "list" | "count" | "sum" | "recent" | "viewer";
interface Comp { alias: string; field: string; kind: CompKind; filtered: boolean }

export interface GraphqlSpec {
  id: string;
  store: string;
  f: { filter: string; draft: string; loading: string; error: string };
  comps: Comp[];
  mutation: string;
  path: string;
  coll: string;
  nameField: string;
  numField: string | null;
  statuses: string[];
  items: Item[];
  viewer: { name: string; role: string };
  salt: string;
  errP: number;
  batching: "window" | "none";
  windowMs: number;
  retry: "idempotent" | "whole-batch" | "none";
  fieldErrors: "keep" | "null";
  seqGuard: boolean;
  addGuard: boolean;
  refreshMs: number;
  timeoutMs: number;
  words: string[];
  labels: { filter: string; name: string; add: string; refresh: string };
  externalAdds: number;
}

function knob<T>(rng: Rng, clean: boolean | undefined, good: T, opts: readonly (readonly [T, number])[]): T {
  const v = rng.weighted(opts);
  return clean ? good : v;
}

export const graphql: FeatureDef<GraphqlSpec> = {
  kind: "graphql",
  make({ rng, clean, domain, entity, naming, id }) {
    const num = entity.nums[0]?.[0] ?? null;
    const comps: Comp[] = [
      { alias: naming.field("list", id), field: naming.word(entity.p), kind: "list", filtered: true },
      { alias: naming.field("total", id), field: naming.word(`${entity.p} count`), kind: "count", filtered: true },
    ];
    const extra: Comp[] = [{ alias: naming.word(`recent ${entity.p}`), field: naming.word(`recent ${entity.p}`), kind: "recent", filtered: false }, { alias: rng.pick(["viewer", "me", "currentUser"]), field: "viewer", kind: "viewer", filtered: false }];
    if (num) extra.push({ alias: naming.word(`${num} sum`), field: naming.word(`${entity.s} stats`), kind: "sum", filtered: true });
    comps.push(...rng.sample(extra, rng.int(1, extra.length)));
    const statuses = entity.status.length >= 2 ? entity.status : ["open", "closed"];
    return {
      id,
      store: naming.store(entity.p, rng.pick(["page", "view", "query", "screen"])),
      f: { filter: naming.field("filter", id), draft: naming.field("draft", id), loading: naming.field("loading", id), error: naming.field("error", id) },
      comps,
      mutation: naming.word(`${entity.create} ${entity.s}`),
      path: naming.route(rng.pick(["graphql", "gql", "query"])),
      coll: entity.p,
      nameField: entity.name,
      numField: num,
      statuses,
      items: seedItems(rng, entity, rng.int(5, 16), (it) => { it.status = rng.pick(statuses); }),
      viewer: { name: rng.pick(domain.people), role: rng.pick(["admin", "member", "viewer"]) },
      salt: rng.token(8),
      errP: rng.weighted([[0.04, 2], [0.1, 3], [0.2, 1]] as const),
      batching: knob(rng, clean, "window", [["window", 5], ["none", 2]] as const),
      windowMs: rng.int(5, 30),
      retry: knob(rng, clean, "idempotent", [["idempotent", 3], ["whole-batch", 3], ["none", 2]] as const),
      fieldErrors: knob(rng, clean, "keep", [["keep", 3], ["null", 2]] as const),
      seqGuard: knob(rng, clean, true, [[true, 1], [false, 1]] as const),
      addGuard: knob(rng, clean, true, [[true, 1], [false, 1]] as const),
      refreshMs: rng.weighted([[0, 2], [rng.int(2500, 8000), 2]] as const),
      timeoutMs: rng.weighted([[0, 2], [rng.int(2500, 8000), 2]] as const),
      words: entity.words,
      labels: { filter: `select "${rng.pick(["Status", "Show", "Filter"])}"`, name: `input "${title(entity.name)}"`, add: `button "${title(entity.create)} ${entity.s}"`, refresh: `button "${rng.pick(["Refresh", "Reload", "↻"])}"` },
      externalAdds: rng.int(0, 4),
    };
  },
  pattern(s) {
    return [`batch:${s.batching}`, `retry:${s.retry}`, `ferr:${s.fieldErrors}`, s.seqGuard ? "seq" : "noseq", s.addGuard ? "addguard" : "noaddguard", s.refreshMs ? "refresh" : "norefresh"];
  },
  server(s, srv, db) {
    const coll = `${s.id}:${s.coll}`;
    for (const it of s.items) db.insert(coll, it, `seed:${canonical(it)}`);
    const occ = new Map<string, number>();
    const resolve = (c: Comp, args: Record<string, unknown>): unknown => {
      const rows = () => db.list(coll).filter((it) => !c.filtered || !args.status || args.status === "all" || it.status === args.status);
      if (c.kind === "list") return rows().slice(0, 30);
      if (c.kind === "count") return rows().length;
      if (c.kind === "sum") return round2(rows().reduce((a, it) => a + Number(it[s.numField ?? ""] ?? 0), 0));
      if (c.kind === "recent") return db.list(coll).slice(-3).reverse();
      return { ...s.viewer };
    };
    srv.route(
      "POST",
      s.path,
      (req) => {
        const ops = ((req.body ?? {}) as { ops?: { alias: string; field: string; type?: string; args?: Record<string, unknown> }[] }).ops ?? [];
        const data: Record<string, unknown> = {};
        const errors: { message: string; path: string[]; extensions: { code: string } }[] = [];
        for (const o of ops) {
          if (o.type === "mutation") {
            const name = String(o.args?.name ?? "").trim();
            if (!name) {
              data[o.alias] = null;
              errors.push({ message: `${s.nameField} is required`, path: [o.alias], extensions: { code: "BAD_USER_INPUT" } });
            } else data[o.alias] = db.insert(coll, { [s.nameField]: name, status: s.statuses[0]! }, undefined, req.t);
            continue;
          }
          const c = s.comps.find((x) => x.field === o.field);
          const k = `${o.field}|${canonical(o.args ?? {})}`;
          const n = occ.get(k) ?? 0;
          occ.set(k, n + 1);
          if (!c || (c.kind !== "viewer" && u01(s.salt, k, n) < s.errP)) {
            data[o.alias] = null;
            errors.push({ message: c ? `Cannot resolve ${o.field}: upstream timeout` : `Unknown field ${o.field}`, path: [o.alias], extensions: { code: c ? "UPSTREAM_TIMEOUT" : "GRAPHQL_VALIDATION_FAILED" } });
          } else data[o.alias] = resolve(c, o.args ?? {});
        }
        return { status: 200, body: errors.length ? { data, errors } : { data } };
      },
      { feature: s.id, kind: "read", idempotent: false, resource: `c:${coll}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const key = `${s.id}.gql`;
    const init: Record<string, unknown> = { [F.filter]: "all", [F.draft]: "", [F.loading]: false, [F.error]: null };
    const wts: [string, number][] = [[F.filter, 0.4], [F.draft, 0.3], [F.loading, 0.1], [F.error, 0]];
    for (const c of s.comps) {
      init[c.alias] = c.kind === "list" || c.kind === "recent" ? [] : c.kind === "viewer" ? null : 0;
      wts.push([c.alias, c.kind === "viewer" ? 0.3 : 1]);
    }
    interface Req { comp?: Comp; args: Record<string, unknown>; seq: number; intent?: number; settled?: boolean }
    let queue: Req[] = [];
    let timer: unknown = null;
    let seqN = 0;
    let inflight = 0;
    let adding = 0;
    const shown = new Map<string, number>();
    const S = env.store(s.store, s.id, init, { weights: weightsOf(wts), resync: () => ask(s.comps, undefined) });
    const argsFor = (c: Comp): Record<string, unknown> => (c.filtered ? { status: String(S.get()[F.filter] ?? "all") } : {});
    function ask(comps: Comp[], intent: number | undefined, name?: string): void {
      const reqs: Req[] = comps.map((c) => ({ comp: c, args: argsFor(c), seq: ++seqN, intent }));
      if (name !== undefined) reqs.unshift({ args: { name }, seq: ++seqN, intent });
      if (intent !== undefined) kit.write(S, (p) => ({ ...p, [F.loading]: true }), { role: "loading", intent, key });
      if (s.batching === "none") {
        for (const r of reqs) send([r], 1);
        return;
      }
      queue = queue.filter((q) => !q.comp || !reqs.some((r) => r.comp === q.comp));
      queue.push(...reqs);
      if (!timer) {
        timer = env.setTimeout(() => {
          timer = null;
          const b = queue;
          queue = [];
          if (b.length) send(b, 1);
        }, s.windowMs);
      }
    }
    function settleMutations(batch: Req[], failed: boolean, op: SimOp): void {
      for (const q of batch) {
        if (q.comp || q.settled) continue;
        q.settled = true;
        adding--;
        if (failed) {
          kit.write(S, (p) => ({ ...p, [F.error]: `Could not ${s.mutation}` }), { role: "error", op, key });
          kit.shownError();
        } else kit.write(S, (p) => ({ ...p, [F.draft]: "" }), { role: "reset", op, key, ...(q.intent !== undefined ? { intent: q.intent } : {}) });
      }
    }
    function send(batch: Req[], attempt: number, prev?: SimOp, dupOfPrev = false): void {
      const hasMut = batch.some((q) => !q.comp);
      const intent = [...batch].reverse().find((q) => q.intent !== undefined)?.intent;
      const it = env.know.getIntent(intent);
      const ops = batch.map((q, i) => (q.comp ? { alias: q.comp.alias, field: q.comp.field, args: q.args } : { alias: `m${i}`, type: "mutation", field: s.mutation, args: q.args }));
      inflight++;
      const op = kit.op({
        role: hasMut ? "mutate" : "query", method: "POST", url: s.path, body: { ops }, intent, key, idempotent: !hasMut,
        background: intent === undefined, attempt, handled: s.retry !== "none",
        ...(prev ? { retryOf: prev.id } : {}),
        ...(dupOfPrev && prev ? { dupOf: prev.id } : it?.accidental && attempt === 1 ? { dupOf: it.repeatOf } : {}),
      });
      if (s.batching === "none" && inflight >= 6) op.anomaly = "storm";
      kit.spawn(async () => {
        const r = await kit.call(op, s.timeoutMs ? { timeoutMs: s.timeoutMs } : {});
        inflight--;
        if (!r.ok) {
          const retriable = r.outcome === "timeout" || r.outcome === "neterr" || r.status >= 500 || r.status === 429;
          if (retriable && s.retry !== "none" && attempt < 3) {
            const again = s.retry === "whole-batch" ? batch : batch.filter((q) => q.comp);
            if (again.length) {
              if (again.length < batch.length) settleMutations(batch, true, op);
              await env.sleep(300 * attempt);
              send(again, attempt + 1, op);
              return;
            }
          }
          settleMutations(batch, true, op);
          const queries = batch.some((q) => q.comp);
          kit.write(S, (p) => ({ ...p, [F.loading]: inflight > 0, ...(queries ? { [F.error]: errMsg(r.status, r.outcome) } : {}) }), { role: "error", op, key });
          if (queries) kit.shownError();
          return;
        }
        const body = (r.body ?? {}) as { data?: Record<string, unknown> | null; errors?: { path?: unknown[]; message?: string }[] };
        const data = body.data && typeof body.data === "object" ? body.data : {};
        const bad = new Set((body.errors ?? []).map((e) => String(e.path?.[0] ?? "")));
        const failedQ = batch.filter((q) => q.comp && (bad.has(q.comp.alias) || !(q.comp.alias in data)));
        const mutBad = batch.some((q, i) => !q.comp && (bad.has(`m${i}`) || data[`m${i}`] == null));
        const patch: Record<string, unknown> = {};
        const applied: Req[] = [];
        let nulls = false;
        for (const q of batch) {
          if (!q.comp) continue;
          if (s.seqGuard && (shown.get(q.comp.alias) ?? 0) > q.seq) continue;
          if (failedQ.includes(q)) {
            if (s.fieldErrors === "keep") continue;
            patch[q.comp.alias] = null;
            nulls = true;
          } else patch[q.comp.alias] = data[q.comp.alias];
          applied.push(q);
        }
        const filterNow = S.get()[F.filter];
        const stale = applied.some((q) => (shown.get(q.comp!.alias) ?? 0) > q.seq || (q.comp!.filtered && q.args.status !== filterNow));
        // Data for the inputs the user has now is not stale even when its intent was superseded (A -> B -> A).
        const verdict = stale ? "stale" : intent !== undefined && env.know.superseded(intent) ? "expected" : undefined;
        const errText = failedQ.length ? `Some ${s.coll} data could not be loaded` : null;
        kit.write(S, (p) => ({ ...p, ...patch, [F.loading]: inflight > 0, [F.error]: errText }), { role: "data", op, key, classify: () => verdict, ...(intent !== undefined ? { intent } : {}), ...(nulls ? { anomaly: "shape" } : {}) });
        for (const q of applied) shown.set(q.comp!.alias, q.seq);
        if (failedQ.length) kit.shownError();
        // A whole-batch retry re-sends the (already committed) mutation: in the ideal world it is exactly-once.
        if ((failedQ.length || mutBad) && s.retry === "whole-batch" && attempt < 3) {
          await env.sleep(200 * attempt);
          send(batch, attempt + 1, op, hasMut);
          return;
        }
        settleMutations(batch, mutBad, op);
        if (failedQ.length && s.retry === "idempotent" && attempt < 3) {
          await env.sleep(200 * attempt);
          send(failedQ.map((q) => ({ ...q, seq: ++seqN })), attempt + 1, op);
        }
      }, "uncaught", { cause: "graphql-failed", diagnosis: "failing", op });
    }
    const refetchable = () => s.comps.filter((c) => c.kind !== "viewer");
    return {
      init() {
        ask(s.comps, undefined);
        if (s.refreshMs) env.setInterval(() => ask(refetchable(), undefined), s.refreshMs);
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "type") {
          kit.write(S, (p) => ({ ...p, [F.draft]: String(step.ui.value ?? "") }), { role: "input", intent, key: `${s.id}.draft` });
        } else if (step.action === "filter") {
          kit.write(S, (p) => ({ ...p, [F.filter]: String(step.ui.value) }), { role: "input", intent, key: `${s.id}.filter` });
          ask(s.comps.filter((c) => c.filtered), intent);
        } else if (step.action === "add") {
          const name = String(S.get()[F.draft] ?? "").trim();
          if (!name || (s.addGuard && adding > 0)) return;
          adding++;
          ask(s.comps.filter((c) => c.kind !== "viewer"), intent, name);
        } else ask(refetchable(), intent);
      },
      cond(name) {
        return name === "adding" ? adding > 0 : inflight > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(0.8);
    let filter = "all";
    while (t < win.t1 - 1200) {
      const r = user.rng.next();
      if (r < 0.35) {
        const n = user.rng.weighted([[1, 4], [2, 2], [3, 1]] as const);
        for (let i = 0; i < n; i++) {
          filter = user.rng.pick(["all", ...s.statuses].filter((x) => x !== filter));
          steps.push({ t, feature: s.id, action: "filter", ui: { kind: "change", target: s.labels.filter, value: filter }, intent: { kind: "filter", key: `${s.id}.filter`, mode: "replace", accidental: false } });
          t += user.rng.float(150, 900);
        }
      } else if (r < 0.7) {
        const name = `${user.rng.pick(s.words)}${user.rng.bool(0.5) ? " " + user.rng.pick(s.words) : ""}`;
        const typed = user.type(t, "", name, s.labels.name, "type", `${s.id}.draft`);
        steps.push(...typed.steps);
        t = typed.t + user.rng.float(150, 700);
        steps.push(...user.click(t, s.labels.add, "add", { kind: "add", key: `${s.id}.add` }, { pendingCond: "adding" }).steps);
      } else {
        steps.push(...user.click(t, s.labels.refresh, "refresh", { kind: "refresh", key: `${s.id}.refresh` }, { pendingCond: "inflight" }).steps);
      }
      t += user.think(1.2);
    }
    return steps;
  },
  external(s, rng, win) {
    const out: ExternalEvent[] = [];
    for (let i = 0; i < s.externalAdds; i++) {
      const name = `${rng.pick(s.words)} ${rng.pick(s.words)}`;
      const status = rng.pick(s.statuses);
      out.push({
        t: rng.float(win.t0 + 1000, win.t1),
        feature: s.id,
        desc: `another user creates ${name}`,
        apply(w) {
          w.db.insert(`${s.id}:${s.coll}`, { [s.nameField]: name, status }, `ext:${i}:${name}`, w.now());
        },
      });
    }
    return out;
  },
};
