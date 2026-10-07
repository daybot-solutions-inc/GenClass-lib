// Cart with derived totals maintained by app code (count, subtotal) and a cross-store badge. Server endpoints:
// add line (non-idempotent POST), set quantity (PATCH), remove (DELETE), checkout (non-idempotent POST).
// Knobs: optimistic vs server-confirmed updates, echo of the full server cart (stale when several updates are in
// flight), rollback on failure, recompute of derived fields on every path (or a partial-update defect), add
// button disabled while pending, checkout guards (disable / idempotency key / retry policy).

import type { Item } from "../../net/server.js";
import { rel, type FeatureDef, type Relation, type UserStep } from "../feature.js";
import { round2 } from "../feature.js";
import { errorFor } from "../kit.js";
import { title } from "../naming.js";
import { apiOf, ContentBook, errMsg, seedItems, weightsOf } from "./common.js";

export interface CartSpec {
  id: string;
  api: string;
  store: string;
  badgeStore: string | null;
  f: { lines: string; count: string; sum: string; busy: string; error: string; placed: string };
  priceField: string;
  nameField: string;
  products: Item[];
  paths: { cart: string; lines: string; line: string; checkout: string; products: string };
  mode: "optimistic" | "server" | "echo";
  rollback: boolean;
  recompute: "always" | "skip-rollback" | "skip-echo" | "items-only-qty";
  addGuard: boolean;
  checkout: { disable: boolean; idem: boolean; retry: "none" | "same-key" | "no-key"; timeoutMs: number };
  addLabel: string;
  checkoutLabel: string;
  verb: string;
}

const linesTotal = (lines: Item[], pf: string) => round2(lines.reduce((a, l) => a + Number(l[pf] ?? 0) * Number(l.qty ?? 0), 0));
const linesCount = (lines: Item[]) => lines.reduce((a, l) => a + Number(l.qty ?? 0), 0);

export const cart: FeatureDef<CartSpec> = {
  kind: "cart",
  make({ rng, entity, naming, id, api }) {
    const priceField = entity.nums.find((n) => /price|amount|fare|cost|rate|fee|total|premium|value|bid/.test(n[0]))?.[0] ?? "price";
    const products = seedItems(rng, entity, rng.int(4, 10), (it) => {
      if (!(priceField in it)) it[priceField] = round2(rng.float(3, 200));
    });
    const retry = rng.weighted([["none", 3], ["same-key", 2], ["no-key", 2]] as const);
    return {
      id,
      api: api.name,
      store: naming.store(rng.pick(["cart", "basket", "bag", "order", "selection"])),
      badgeStore: rng.bool(0.5) ? naming.store(rng.pick(["header", "badge", "nav", "summary"])) : null,
      f: {
        lines: naming.field("list", id + "c"),
        count: naming.field("qty", id + "c") === "qty" ? "itemCount" : naming.field("total", id + "c"),
        sum: naming.field("sum", id + "c"),
        busy: naming.field("loading", id + "c"),
        error: naming.field("error", id + "c"),
        placed: rng.pick(["orderId", "confirmation", "placedOrder", "receipt"]),
      },
      priceField,
      nameField: entity.name,
      products,
      paths: {
        cart: naming.route(rng.pick(["cart", "basket", "bag"])),
        lines: naming.route(rng.pick(["cart", "basket"]), rng.pick(["items", "lines"])),
        line: naming.route("cart", "items", ":id"),
        checkout: naming.route(rng.pick(["checkout", "orders", "purchase"])),
        products: naming.route(entity.p),
      },
      mode: rng.weighted([["optimistic", 3], ["server", 3], ["echo", 3]] as const),
      rollback: rng.bool(0.6),
      recompute: rng.weighted([["always", 3], ["skip-rollback", 4], ["skip-echo", 2], ["items-only-qty", 1]] as const),
      addGuard: rng.bool(0.4),
      checkout: { disable: rng.bool(0.5), idem: retry === "same-key" || rng.bool(0.3), retry, timeoutMs: rng.weighted([[0, 2], [rng.int(2000, 7000), 3]] as const) },
      addLabel: `button "${rng.pick(["Add to cart", "Add", "Add to basket", "+ Add"])}"`,
      checkoutLabel: `button "${rng.pick(["Checkout", "Place order", "Pay now", "Confirm purchase", title(entity.create)])}"`,
      verb: entity.create,
    };
  },
  pattern(s) {
    return [`mode:${s.mode}`, s.rollback ? "rollback" : "norollback", `recompute:${s.recompute}`, s.addGuard ? "addguard" : "noaddguard", s.checkout.disable ? "co-disable" : "co-nodisable", s.checkout.idem ? "co-idem" : "co-noidem", `co-retry:${s.checkout.retry}`, s.badgeStore ? "badge" : "nobadge"];
  },
  relations(s) {
    const L = `${s.store}.${s.f.lines}`;
    const T = `${s.store}.${s.f.sum}`;
    const C = `${s.store}.${s.f.count}`;
    const lines = (st: Record<string, unknown>) => ((rel.field(st, L) as Item[]) ?? []);
    const r: Relation[] = [
      { fields: [T, L], desc: "total equals sum of price*qty", check: (st) => rel.near(rel.field(st, T), linesTotal(lines(st), s.priceField)) },
      { fields: [C, L], desc: "count equals sum of quantities", check: (st) => Number(rel.field(st, C)) === linesCount(lines(st)) },
    ];
    if (s.badgeStore) {
      const B = `${s.badgeStore}.${s.f.count}`;
      r.push({ fields: [B, C], desc: "badge equals cart count", check: (st) => Number(rel.field(st, B)) === Number(rel.field(st, C)) });
    }
    return r;
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const pc = `${s.id}:products`;
    const lc = `${s.id}:lines`;
    for (const p of s.products) db.insert(pc, p, `seed:${p[s.nameField]}`);
    const cartBody = () => {
      const lines = db.list(lc);
      return { [s.f.lines]: lines, total: linesTotal(lines, s.priceField) };
    };
    srv.route("GET", s.paths.products, () => ({ status: 200, body: api.list(db.list(pc)) }), { feature: s.id, kind: "read", idempotent: true, resource: `c:${pc}` });
    srv.route("GET", s.paths.cart, () => ({ status: 200, body: cartBody() }), { feature: s.id, kind: "read", idempotent: true, resource: `c:${lc}` });
    srv.route(
      "POST",
      s.paths.lines,
      (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const prod = db.get(pc, String(b.productId));
        if (!prod) return { status: 404, body: api.error("not_found", "no such product") };
        const existing = db.list(lc).find((l) => l.productId === prod.id);
        if (existing) db.update(lc, String(existing.id), { qty: Number(existing.qty) + Number(b.qty ?? 1) }, req.t);
        else db.insert(lc, { productId: prod.id!, [s.nameField]: prod[s.nameField]!, [s.priceField]: prod[s.priceField]!, qty: Number(b.qty ?? 1) }, `line:${String(prod.id)}`, req.t);
        return { status: 200, body: cartBody() };
      },
      { feature: s.id, kind: "write", idempotent: false, resource: `c:${lc}` },
    );
    srv.route(
      "PATCH",
      s.paths.line,
      (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const line = db.list(lc).find((l) => l.productId === req.params.id || l.id === req.params.id);
        if (!line) return { status: 404, body: api.error("not_found", "no such line") };
        if (Number(b.qty) <= 0) db.remove(lc, String(line.id), req.t);
        else db.update(lc, String(line.id), { qty: Number(b.qty) }, req.t);
        return { status: 200, body: cartBody() };
      },
      { feature: s.id, kind: "write", idempotent: true, resource: `c:${lc}` },
    );
    srv.route(
      "POST",
      s.paths.checkout,
      (req) => {
        const lines = db.list(lc);
        if (lines.length === 0) return { status: 409, body: api.error("empty", "cart is empty") };
        const order = db.insert(`${s.id}:orders`, { lines: lines.length, total: linesTotal(lines, s.priceField) }, JSON.stringify(lines.map((l) => [l.productId, l.qty])), req.t);
        for (const l of lines) db.remove(lc, String(l.id), req.t);
        return { status: 201, body: api.one({ id: order.id!, total: order.total! }) };
      },
      { feature: s.id, kind: "write", idempotent: false, resource: `c:${s.id}:orders` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const pf = s.priceField;
    const init: Record<string, unknown> = { [F.lines]: [] as Item[], [F.count]: 0, [F.sum]: 0, [F.busy]: false, [F.error]: null, [F.placed]: null };
    const book = new ContentBook(env.know);
    const linesKey = (lines: unknown) => (Array.isArray(lines) ? (lines as Item[]).map((l) => `${String(l.productId)}x${String(l.qty)}`).sort().join(",") : "");
    const S = env.store(s.store, s.id, init, {
      weights: weightsOf([[F.lines, 1], [F.count, 0.6], [F.sum, 0.8], [F.busy, 0.1], [F.error, 0], [F.placed, 0.8]]),
      resync: () => load(true),
    });
    const B = s.badgeStore ? env.store(s.badgeStore, s.id, { [F.count]: 0 } as Record<string, unknown>, { weights: weightsOf([[F.count, 0.4]]) }) : null;
    const key = `${s.id}.cart`;
    let pendingAdds = 0;
    let coInflight = 0;
    const products: Item[] = [];
    const derive = (lines: Item[], full: boolean) => {
      const o: Record<string, unknown> = { [F.lines]: lines };
      if (full) {
        o[F.count] = linesCount(lines);
        o[F.sum] = linesTotal(lines, pf);
      }
      return o;
    };
    const setBadge = (lines: Item[], meta: { role: string; op?: ReturnType<typeof kit.op>; intent?: number }) => {
      if (!B) return;
      const n = linesCount(lines);
      kit.write(B, (p) => ({ ...p, [F.count]: n }), { ...meta, key });
    };
    async function load(bg: boolean): Promise<void> {
      const op = kit.op({ role: "load", method: "GET", url: s.paths.cart, key, background: bg });
      const r = await kit.call(op);
      if (!r.ok) return;
      const lines = (((r.body ?? {}) as Record<string, unknown>)[F.lines] ?? []) as Item[];
      book.note(0, linesKey(lines));
      kit.write(S, (p) => ({ ...p, ...derive(lines, true) }), { role: "load", op, key });
      setBadge(lines, { role: "load", op });
    }
    function localLines(): Item[] {
      return ((S.get()[F.lines] as Item[]) ?? []).map((l) => ({ ...l }));
    }
    function change(intent: number, productIdx: number, delta: number, kind: "add" | "qty"): void {
      const prod = products[productIdx % Math.max(1, products.length)];
      if (!prod) return;
      if (kind === "add" && s.addGuard && pendingAdds > 0) return;
      const before = localLines();
      let line = before.find((l) => l.productId === prod.id);
      const nextQty = Math.max(0, Number(line?.qty ?? 0) + delta);
      let after: Item[];
      if (line) after = before.map((l) => (l.productId === prod.id ? { ...l, qty: nextQty } : l)).filter((l) => Number(l.qty) > 0);
      else after = nextQty > 0 ? [...before, { productId: prod.id!, [s.nameField]: prod[s.nameField]!, [pf]: prod[pf]!, qty: nextQty }] : before;
      book.note(intent, linesKey(after));
      const fullOnLocal = s.recompute !== "items-only-qty" || kind === "add";
      if (s.mode !== "server") {
        kit.write(S, (p) => ({ ...p, ...derive(after, true), ...(fullOnLocal ? {} : { [F.count]: p[F.count] }) }), { role: "optimistic", intent, key, ...(fullOnLocal ? {} : { anomaly: "partial" }) });
        setBadge(after, { role: "optimistic", intent });
      }
      pendingAdds++;
      kit.write(S, (p) => ({ ...p, [F.busy]: true }), { role: "busy", intent, key });
      const isAdd = kind === "add";
      const op = kit.op({
        role: isAdd ? "add" : "qty",
        method: isAdd ? "POST" : "PATCH",
        url: isAdd ? s.paths.lines : s.paths.line.replace(":id", String(prod.id)),
        body: isAdd ? { productId: prod.id, qty: delta } : { qty: nextQty },
        intent,
        key,
        idempotent: !isAdd,
        ...(env.know.getIntent(intent)?.accidental ? { dupOf: env.know.getIntent(intent)!.repeatOf } : {}),
      });
      kit.spawn(
        async () => {
          const r = await kit.call(op, { timeoutMs: 8000 });
          pendingAdds--;
          if (r.ok) {
            const lines = (((r.body ?? {}) as Record<string, unknown>)[F.lines] ?? []) as Item[];
            if (s.mode === "optimistic") {
              kit.write(S, (p) => ({ ...p, [F.busy]: pendingAdds > 0 }), { role: "confirm", op, intent, key });
              return;
            }
            // server / echo: replace with the server's cart.
            const full = s.recompute !== "skip-echo";
            const stale = () => {
              const shown = book.shown(linesKey(S.get()[F.lines]));
              const echoOf = book.shown(linesKey(lines));
              if (shown !== undefined && echoOf !== undefined && shown > echoOf) return "stale";
              return undefined;
            };
            kit.write(S, (p) => ({ ...p, ...derive(lines, full), [F.busy]: pendingAdds > 0 }), { role: "echo", op, intent, key, classify: stale, ...(full ? {} : { anomaly: "partial" }) });
            if (full) setBadge(lines, { role: "echo", op, intent });
            return;
          }
          // failure
          if (s.mode !== "server" && s.rollback) {
            const full = s.recompute !== "skip-rollback";
            kit.write(S, (p) => ({ ...p, ...derive(before, full), [F.busy]: pendingAdds > 0 }), { role: "rollback", op, intent, key, ...(full ? {} : { anomaly: "partial" }) });
            if (full) setBadge(before, { role: "rollback", op, intent });
          } else kit.write(S, (p) => ({ ...p, [F.busy]: pendingAdds > 0 }), { role: "busy", op, intent, key });
          kit.write(S, (p) => ({ ...p, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, intent, key });
          kit.shownError();
        },
        "uncaught",
        { cause: "cart-failed", diagnosis: "failing", op },
      );
    }
    function checkout(intent: number): void {
      if (s.checkout.disable && coInflight > 0) return;
      const it = env.know.getIntent(intent);
      const ref = it?.accidental && it.repeatOf !== undefined ? it.repeatOf : intent;
      const idem = s.checkout.idem ? `co${env.rng.fork("co", ref).token(10)}` : undefined;
      coInflight++;
      kit.write(S, (p) => ({ ...p, [F.busy]: true, [F.error]: null }), { role: "busy", intent, key: `${s.id}.checkout` });
      const attempt = async (n: number, retryOf?: number): Promise<void> => {
        const headers: Record<string, string> = {};
        if (idem && (n === 1 || s.checkout.retry === "same-key")) headers["idempotency-key"] = idem;
        const op = kit.op({
          role: "checkout",
          method: "POST",
          url: s.paths.checkout,
          body: { cart: linesKey(S.get()[F.lines]) },
          intent,
          key: `${s.id}.checkout`,
          idempotent: false,
          attempt: n,
          handled: s.checkout.retry !== "none",
          ...(retryOf !== undefined ? { retryOf } : {}),
          ...(it?.accidental ? { dupOf: it.repeatOf } : {}),
        });
        const opts: { headers: Record<string, string>; timeoutMs?: number } = { headers };
        if (s.checkout.timeoutMs) opts.timeoutMs = s.checkout.timeoutMs;
        const r = await kit.call(op, opts);
        if (!r.ok && (r.outcome === "timeout" || r.outcome === "neterr" || r.status >= 500) && s.checkout.retry !== "none" && n < 3) {
          await env.sleep(500 * n);
          return attempt(n + 1, op.id);
        }
        coInflight--;
        if (r.ok) {
          const o = kit.api.unone(r.body);
          kit.write(S, (p) => ({ ...p, ...derive([], true), [F.busy]: coInflight > 0, [F.placed]: String(o.id ?? "") ? "placed" : null }), { role: "placed", op, intent, key: `${s.id}.checkout` });
          setBadge([], { role: "placed", op, intent });
          return;
        }
        if (r.status === 409) {
          kit.write(S, (p) => ({ ...p, [F.busy]: coInflight > 0 }), { role: "busy", op, intent, key });
          return;
        }
        kit.write(S, (p) => ({ ...p, [F.busy]: coInflight > 0, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, intent, key });
        kit.shownError();
        if (r.outcome === "parse-error") throw errorFor(r, "checkout");
      };
      kit.spawn(() => attempt(1), "uncaught", { cause: "checkout-failed", diagnosis: "failing" });
    }
    return {
      init() {
        kit.spawn(async () => {
          const op = kit.op({ role: "products", method: "GET", url: s.paths.products, key: `${s.id}.products`, background: true });
          const r = await kit.call(op);
          if (r.ok) products.push(...kit.api.unlist(r.body).items);
          await load(true);
        }, "swallow");
      },
      handle(step: UserStep, intent: number) {
        const idx = Number(step.args?.product ?? 0);
        if (step.action === "add") change(intent, idx, 1, "add");
        else if (step.action === "inc") change(intent, idx, 1, "qty");
        else if (step.action === "dec") change(intent, idx, -1, "qty");
        else if (step.action === "checkout") checkout(intent);
      },
      cond(name) {
        return name === "adding" ? pendingAdds > 0 : name === "checkout" ? coInflight > 0 : false;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(0.8);
    const inCart = new Set<number>();
    let checkedOut = false;
    while (t < win.t1 - 1200) {
      const r = user.rng.next();
      const idx = user.rng.int(0, s.products.length - 1);
      if (r < 0.5 || inCart.size === 0) {
        const c = user.click(t, `${s.addLabel.slice(0, -1)} ${String(s.products[idx]![s.nameField])}"`.replace('" ', " "), "add", { kind: "add", key: `${s.id}.add.${idx}` }, { args: { product: idx }, pendingCond: "adding" });
        steps.push(...c.steps);
        inCart.add(idx);
        // intentional second add of the same product
        if (user.rng.bool(0.2)) {
          const c2 = user.click(t + user.rng.float(400, 2500), `${s.addLabel.slice(0, -1)} ${String(s.products[idx]![s.nameField])}"`.replace('" ', " "), "add", { kind: "add", key: `${s.id}.add.${idx}` }, { args: { product: idx }, doubleP: 0 });
          steps.push(...c2.steps);
        }
      } else if (r < 0.8) {
        const j = [...inCart][user.rng.int(0, inCart.size - 1)]!;
        const inc = user.rng.bool(0.6);
        const n = user.rng.int(1, 3);
        let tt = t;
        for (let i = 0; i < n; i++) {
          steps.push({ t: tt, feature: s.id, action: inc ? "inc" : "dec", ui: { kind: "click", target: `button "${inc ? "+" : "−"}"` }, args: { product: j }, intent: { kind: inc ? "inc" : "dec", key: `${s.id}.qty.${j}`, mode: "accumulate", accidental: false } });
          tt += user.rng.float(180, 700);
        }
        t = tt;
      } else if (!checkedOut && t > win.t0 + (win.t1 - win.t0) * 0.5) {
        const c = user.click(t, s.checkoutLabel, "checkout", { kind: "checkout", key: `${s.id}.checkout`, mode: "replace" }, { pendingCond: "checkout", kind: "submit" });
        steps.push(...c.steps);
        checkedOut = true;
        inCart.clear();
      }
      t += user.think();
    }
    return steps;
  },
};
