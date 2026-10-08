// Invoice / quote editor with derived money fields: lines (qty × unit price), discount %, tax rate, shipping. The
// client recomputes subtotal, discount, tax and total on every edit (half-up to cents) and autosaves the editable
// part (PATCH); the server recomputes the same way and echoes the whole quote. Knobs: rounding (half-up vs float
// accumulation: off by fractions of a cent until the echo replaces it, benign), which path forgets to recompute
// totals (line removal, rollback, echo = partial update), how the echo is applied (in full = an older echo
// overwrites newer local edits when saves overlap; only the latest/unchanged = guard; totals only = older totals
// next to newer lines), immediate vs debounced saves, rollback on failure.

import type { Item } from "../../net/server.js";
import { itemName, numIn, rel, type FeatureDef, type Relation, type UserStep } from "../feature.js";
import { apiOf, errMsg, weightsOf } from "./common.js";

export interface MoneySpec {
  id: string;
  api: string;
  store: string;
  f: { lines: string; subtotal: string; discount: string; pct: string; tax: string; rate: string; shipping: string; total: string; saving: string; error: string };
  qty: string;
  unit: string;
  desc: string;
  docId: string;
  path: string;
  catalog: { name: string; price: number }[];
  lines0: Item[];
  pct0: number;
  rate: number;
  pcts: number[];
  ships: number[];
  rounding: "half-up" | "float";
  recompute: "always" | "skip-remove" | "skip-rollback" | "skip-echo";
  echo: "full" | "if-latest" | "totals";
  saveMode: "immediate" | "debounce";
  debounceMs: number;
  rollback: boolean;
}

/** Round half-up to cents. */
const cents = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const sumLines = (s: MoneySpec, lines: Item[]) => lines.reduce((a, l) => a + Number(l[s.qty]) * Number(l[s.unit]), 0);

function totals(s: MoneySpec, lines: Item[], pct: number, ship: number, round: boolean): Record<string, number> {
  const R = round ? cents : (v: number) => v;
  const subtotal = R(sumLines(s, lines));
  const discount = R((subtotal * pct) / 100);
  const tax = R((subtotal - discount) * s.rate);
  return { [s.f.subtotal]: subtotal, [s.f.discount]: discount, [s.f.tax]: tax, [s.f.total]: R(subtotal - discount + tax + ship) };
}

export const money: FeatureDef<MoneySpec> = {
  kind: "money",
  make({ rng, entity, naming, id, api, clean }) {
    const pn = entity.nums.find((n) => /price|amount|fee|cost|rate|fare|gross|balance|value/.test(n[0]));
    const catalog = Array.from({ length: rng.int(3, 6) }, (_, i) => ({ name: itemName(rng, entity, i), price: pn ? numIn(rng, Math.max(0.5, pn[1]), Math.min(pn[2], 2500), 2) : numIn(rng, 1, 300, 2) }));
    const w = (x: string) => naming.word(x);
    const f = {
      lines: naming.field("list", id),
      subtotal: w(rng.pick(["subtotal", "netAmount", "itemsTotal"])),
      discount: w(rng.pick(["discount", "discountAmount", "savings"])),
      pct: w(rng.pick(["discountPct", "discountPercent", "promoPct"])),
      tax: w(rng.pick(["tax", "vat", "taxAmount"])),
      rate: w(rng.pick(["taxRate", "vatRate"])),
      shipping: w(rng.pick(["shipping", "delivery", "freight"])),
      total: w(rng.pick(["total", "grandTotal", "amountDue"])),
      saving: naming.field("saving", id),
      error: naming.field("error", id),
    };
    const qty = w(rng.pick(["qty", "quantity", "units"]));
    const unit = w(rng.pick(["unitPrice", "rate", "price", "unitCost"]));
    const desc = w(rng.pick(["description", "item", "name", "label"]));
    const lines0 = rng.sample(catalog, rng.int(1, 3)).map((c, i) => ({ sku: `sku-${i + 1}${c.name.length}`, [desc]: c.name, [qty]: rng.int(1, 4), [unit]: c.price }) as Item);
    return {
      id,
      api: api.name,
      store: naming.store(rng.pick(["invoice", "quote", "estimate", "order"]), rng.pick(["editor", "draft", ""]) || "draft"),
      f,
      qty,
      unit,
      desc,
      docId: String(rng.int(1000, 99999)),
      path: naming.route(rng.pick(["invoices", "quotes", "estimates"]), ":id"),
      catalog,
      lines0,
      pct0: rng.pick([0, 0, 5, 10]),
      rate: rng.pick([0.05, 0.07, 0.0825, 0.13, 0.2]),
      pcts: [0, 5, 10, 12.5, 15, 20],
      ships: [0, 4.99, 9.95, 14.5],
      rounding: clean ? "half-up" : rng.weighted([["half-up", 3], ["float", 1]] as const),
      recompute: clean ? "always" : rng.weighted([["always", 4], ["skip-remove", 2], ["skip-rollback", 2], ["skip-echo", 2]] as const),
      echo: clean ? "if-latest" : rng.weighted([["full", 4], ["if-latest", 3], ["totals", 2]] as const),
      saveMode: rng.weighted([["immediate", 2], ["debounce", 3]] as const),
      debounceMs: rng.int(300, 1200),
      rollback: rng.bool(0.6),
    };
  },
  pattern(s) {
    return [`round:${s.rounding}`, `recompute:${s.recompute}`, `echo:${s.echo}`, `save:${s.saveMode}`, s.rollback ? "rollback" : "norollback"];
  },
  relations(s) {
    const P = (x: string) => `${s.store}.${x}`;
    const F = s.f;
    const n = (st: Record<string, unknown>, x: string) => Number(rel.field(st, P(x)));
    const near = (a: number, b: number) => rel.near(a, cents(b));
    const r: Relation[] = [
      { fields: [P(F.subtotal), P(F.lines)], desc: "subtotal equals the sum of qty × unit price", check: (st) => near(n(st, F.subtotal), sumLines(s, (rel.field(st, P(F.lines)) as Item[]) ?? [])) },
      { fields: [P(F.discount), P(F.subtotal), P(F.pct)], desc: "discount is subtotal × discount %", check: (st) => near(n(st, F.discount), (n(st, F.subtotal) * n(st, F.pct)) / 100) },
      { fields: [P(F.tax), P(F.subtotal), P(F.discount), P(F.rate)], desc: "tax is charged on the discounted subtotal", check: (st) => near(n(st, F.tax), (n(st, F.subtotal) - n(st, F.discount)) * n(st, F.rate)) },
      { fields: [P(F.total), P(F.subtotal), P(F.discount), P(F.tax), P(F.shipping)], desc: "total = subtotal − discount + tax + shipping", check: (st) => near(n(st, F.total), n(st, F.subtotal) - n(st, F.discount) + n(st, F.tax) + n(st, F.shipping)) },
    ];
    return r;
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const F = s.f;
    const name = `${s.id}:quote:${s.docId}`;
    db.doc(name, { [F.lines]: s.lines0, [F.pct]: s.pct0, [F.rate]: s.rate, [F.shipping]: 0, ...totals(s, s.lines0, s.pct0, 0, true) });
    const out = () => ({ id: s.docId, ...db.doc(name).fields, version: db.doc(name).version });
    srv.route("GET", s.path, () => ({ status: 200, body: api.one(out()) }), { feature: s.id, kind: "read", idempotent: true, resource: `d:${name}` });
    srv.route(
      "PATCH",
      s.path,
      (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const d = db.doc(name).fields;
        const lines = (Array.isArray(b[F.lines]) ? b[F.lines] : d[F.lines]) as Item[];
        const pct = typeof b[F.pct] === "number" ? (b[F.pct] as number) : Number(d[F.pct]);
        const ship = typeof b[F.shipping] === "number" ? (b[F.shipping] as number) : Number(d[F.shipping]);
        if (lines.some((l) => !(Number(l[s.qty]) > 0) || !(Number(l[s.unit]) >= 0))) return { status: 422, body: api.error("invalid", "quantities must be positive") };
        db.writeDoc(name, { [F.lines]: lines, [F.pct]: pct, [F.shipping]: ship, ...totals(s, lines, pct, ship, true) }, req.t);
        return { status: 200, body: api.one(out()) };
      },
      { feature: s.id, kind: "write", idempotent: true, resource: `d:${name}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const key = `${s.id}.quote`;
    const url = s.path.replace(":id", s.docId);
    const round = s.rounding === "half-up";
    const linesOf = (p: Record<string, unknown>) => ((p[F.lines] as Item[]) ?? []).map((l) => ({ ...l }));
    const derive = (p: Record<string, unknown>, lines: Item[]) => totals(s, lines, Number(p[F.pct]), Number(p[F.shipping]), round);
    const editable = (p: Record<string, unknown>) => ({ [F.lines]: p[F.lines], [F.pct]: p[F.pct], [F.shipping]: p[F.shipping] });
    const init: Record<string, unknown> = { [F.lines]: s.lines0, [F.pct]: s.pct0, [F.rate]: s.rate, [F.shipping]: 0, [F.saving]: false, [F.error]: null };
    Object.assign(init, derive(init, s.lines0));
    const S = env.store(s.store, s.id, init, {
      weights: weightsOf([[F.lines, 1], [F.subtotal, 0.5], [F.discount, 0.4], [F.tax, 0.4], [F.total, 0.8], [F.pct, 0.4], [F.rate, 0.2], [F.shipping, 0.4], [F.saving, 0.1], [F.error, 0]]),
      resync: () => load(true),
    });
    let confirmed: Record<string, unknown> | null = null;
    let seq = 0;
    let appliedSeq = 0;
    let edits = 0;
    let inflight = 0;
    let timer: unknown = null;
    const serverPart = (doc: Record<string, unknown>) => {
      const o: Record<string, unknown> = {};
      for (const k of [F.lines, F.pct, F.rate, F.shipping, F.subtotal, F.discount, F.tax, F.total]) if (doc[k] !== undefined) o[k] = doc[k];
      return o;
    };
    async function load(bg: boolean): Promise<void> {
      const op = kit.op({ role: "load", method: "GET", url, key, background: bg });
      const r = await kit.call(op, { timeoutMs: 8000 });
      if (!r.ok) return;
      confirmed = serverPart(kit.api.unone(r.body));
      const c = confirmed;
      kit.write(S, (p) => ({ ...p, ...c }), { role: "load", op, key });
    }
    function save(intent: number | undefined): void {
      const cur = S.get();
      const sentEdits = edits;
      const my = ++seq;
      const withIntent = intent !== undefined ? { intent } : {};
      inflight++;
      kit.write(S, (p) => ({ ...p, [F.saving]: true, [F.error]: null }), { role: "saving", key, ...withIntent });
      const op = kit.op({ role: "save", method: "PATCH", url, body: editable(cur), key, idempotent: true, ...withIntent });
      kit.spawn(
        async () => {
          const r = await kit.call(op, { timeoutMs: 8000 });
          inflight--;
          const busy = inflight > 0;
          if (r.ok) {
            const doc = serverPart(kit.api.unone(r.body));
            confirmed = doc;
            // The echo reflects the quote as sent: older than the screen if the user edited since, or if a newer
            // save's echo was already applied.
            const changed = edits !== sentEdits;
            const older = changed || appliedSeq > my;
            const classify = () => (edits !== sentEdits || appliedSeq > my ? "stale" : undefined);
            if (s.echo === "if-latest" && (my !== seq || changed)) {
              kit.write(S, (p) => ({ ...p, [F.saving]: busy }), { role: "saving", op, key });
              return;
            }
            if (s.echo === "totals") {
              // Server totals of the state as sent, next to whatever lines the user has now.
              const t = { [F.subtotal]: doc[F.subtotal], [F.discount]: doc[F.discount], [F.tax]: doc[F.tax], [F.total]: doc[F.total] };
              kit.write(S, (p) => ({ ...p, ...t, [F.saving]: busy }), { role: "echo", op, key, classify, ...withIntent, ...(older ? { anomaly: "partial" } : {}) });
              appliedSeq = Math.max(appliedSeq, my);
              return;
            }
            const keepTotals = s.recompute === "skip-echo";
            kit.write(S, (p) => ({ ...p, ...doc, ...(keepTotals ? derive(p, linesOf(p)) : {}), [F.saving]: busy }), { role: "echo", op, key, classify, ...withIntent, ...(keepTotals && older ? { anomaly: "partial" } : {}) });
            appliedSeq = Math.max(appliedSeq, my);
            return;
          }
          if (s.rollback && confirmed && my === seq) {
            const c = confirmed;
            const partial = s.recompute === "skip-rollback";
            const breaks = partial && JSON.stringify(c[F.lines]) !== JSON.stringify(S.get()[F.lines]);
            kit.write(S, (p) => ({ ...p, ...editable(c), ...(partial ? {} : derive(c, linesOf(c))), [F.saving]: busy, [F.error]: errMsg(r.status, r.outcome) }), { role: "rollback", op, key, ...withIntent, ...(breaks ? { anomaly: "partial" } : {}) });
          } else kit.write(S, (p) => ({ ...p, [F.saving]: busy, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, key, ...withIntent });
          kit.shownError();
        },
        "uncaught",
        { cause: "save-failed", diagnosis: "failing", op },
      );
    }
    function edit(intent: number, change: (p: Record<string, unknown>, lines: Item[]) => { lines: Item[]; patch?: Record<string, unknown>; removed?: boolean }): void {
      const cur = S.get();
      const res = change(cur, linesOf(cur));
      edits++;
      const partial = !!res.removed && s.recompute === "skip-remove";
      kit.write(S, (p) => {
        const next = { ...p, ...(res.patch ?? {}), [F.lines]: res.lines };
        return partial ? next : { ...next, ...derive(next, res.lines) };
      }, { role: "input", intent, key, ...(partial ? { anomaly: "partial" } : {}) });
      if (s.saveMode === "immediate") return save(intent);
      if (timer) env.clearTimeout(timer);
      timer = env.setTimeout(() => {
        timer = null;
        save(intent);
      }, s.debounceMs);
    }
    return {
      init() {
        kit.spawn(() => load(true), "swallow");
      },
      handle(step: UserStep, intent: number) {
        const a = step.action;
        const i = Number(step.args?.line ?? 0);
        if (a === "pct" || a === "ship") return edit(intent, (_, lines) => ({ lines, patch: { [a === "pct" ? F.pct : F.shipping]: Number(step.ui.value) } }));
        if (a === "add") {
          const c = s.catalog[Number(step.args?.item ?? 0) % s.catalog.length]!;
          return edit(intent, (_, lines) => {
            const at = lines.findIndex((l) => l[s.desc] === c.name);
            if (at >= 0) lines[at]![s.qty] = Number(lines[at]![s.qty]) + 1;
            else lines.push({ sku: `sku-${c.name.replace(/\W+/g, "-")}`, [s.desc]: c.name, [s.qty]: 1, [s.unit]: c.price });
            return { lines };
          });
        }
        edit(intent, (_, lines) => {
          const l = lines[i % Math.max(1, lines.length)];
          if (!l) return { lines };
          if (a === "price") {
            const v = parseFloat(String(step.ui.value ?? ""));
            if (Number.isFinite(v)) l[s.unit] = v;
            return { lines };
          }
          const q = a === "remove" ? 0 : Number(l[s.qty]) + (a === "inc" ? 1 : -1);
          if (q > 0) {
            l[s.qty] = q;
            return { lines };
          }
          return { lines: lines.filter((x) => x !== l), removed: true };
        });
      },
      cond() {
        return inflight > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let n = s.lines0.length;
    const step = (t: number, action: string, target: string, key: string, mode: "replace" | "accumulate", args?: Record<string, unknown>, value?: string): UserStep => {
      const st: UserStep = { t, feature: s.id, action, ui: { kind: value !== undefined ? "change" : "click", target }, intent: { kind: action, key, mode, accidental: false } };
      if (value !== undefined) st.ui.value = value;
      if (args) st.args = args;
      return st;
    };
    let t = win.t0 + user.think(0.8);
    while (t < win.t1 - 800) {
      const r = user.rng.next();
      if (r < 0.4 && n > 0) {
        // Rapid +/− clicks on one line.
        const i = user.rng.int(0, n - 1);
        const inc = user.rng.bool(0.7);
        for (let k = user.rng.int(1, 4); k > 0; k--) {
          steps.push(step(t, inc ? "inc" : "dec", `button "${inc ? "+" : "−"}"`, `${s.id}.line.${i}`, "accumulate", { line: i }));
          t += user.rng.float(150, 600);
        }
      } else if (r < 0.55) {
        const j = user.rng.int(0, s.catalog.length - 1);
        steps.push(...user.click(t, `button "Add ${s.catalog[j]!.name}"`, "add", { kind: "add", key: `${s.id}.add` }, { args: { item: j } }).steps);
        n++;
      } else if (r < 0.63 && n > 1) {
        const i = user.rng.int(0, n - 1);
        steps.push(step(t, "remove", `button "Remove line ${i + 1}"`, `${s.id}.line.${i}`, "accumulate", { line: i }));
        n--;
      } else if (r < 0.77) steps.push(step(t, "pct", `select "Discount %"`, `${s.id}.pct`, "replace", undefined, String(user.rng.pick(s.pcts))));
      else if (r < 0.87) steps.push(step(t, "ship", `select "Shipping"`, `${s.id}.ship`, "replace", undefined, String(user.rng.pick(s.ships))));
      else if (n > 0) {
        const i = user.rng.int(0, n - 1);
        const typed = user.type(t, "", user.rng.float(1, 400).toFixed(2), `input "Unit price (line ${i + 1})"`, "price", `${s.id}.price.${i}`, { line: i });
        steps.push(...typed.steps);
        t = typed.t;
      }
      t += user.think(1.1);
    }
    return steps;
  },
};
