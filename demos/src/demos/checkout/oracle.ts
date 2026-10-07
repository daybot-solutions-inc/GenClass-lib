// Checkout oracle (test code): orders created vs intended, what the customer was charged, whether the displayed
// total adds up, and whether the cart on screen matches the server.
import type { Oracle, OracleContext } from "../../shared/demo-def.ts";
import { epochNow } from "../../shared/server.ts";
import type { Score } from "../../shared/types.ts";
import type { ServerOrder } from "../../server/worlds/checkout.ts";

const DRIFT_BUG_MS = 1000;
const cents = (s: string | null | undefined) => Number((s ?? "").replace(/[^0-9]/g, "") || 0);

interface Sample {
  t: number;
  total: number;
  sum: number;
  lines: Record<string, number>;
  confirmed: number;
  error: boolean;
  placing: boolean;
}

export function checkoutOracle(ctx: OracleContext): Oracle {
  const $ = (sel: string) => ctx.el.querySelector<HTMLElement>(sel);
  const $$ = (sel: string) => [...ctx.el.querySelectorAll<HTMLElement>(sel)];
  const samples: Sample[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const read = (): Sample => {
    const lines: Record<string, number> = {};
    let sum = 0;
    for (const li of $$('[data-testid="cart-line"]')) {
      const q = Number(li.querySelector('[data-testid="line-qty"]')?.textContent ?? 0);
      const p = cents(li.querySelector('[data-testid="line-price"]')?.textContent);
      lines[li.dataset.sku ?? "?"] = q;
      sum += q * p;
    }
    return {
      t: epochNow(),
      total: cents($('[data-testid="cart-total"]')?.textContent),
      sum,
      lines,
      confirmed: $$('[data-testid="placed-order"]').length,
      error: Boolean($('[data-testid="order-error"]')),
      placing: Boolean($('[data-testid="place-order"]')?.classList.contains("busy")),
    };
  };

  return {
    start() {
      timer = setInterval(() => samples.push(read()), 30);
    },
    check(cond) {
      if (cond === "loaded") return $$('[data-testid^="add-"]').length > 0;
      if (cond === "orderDone") {
        const s = read();
        return (s.confirmed > 0 || s.error) && !s.placing;
      }
      return false;
    },
    async finish(): Promise<Score> {
      samples.push(read());
      clearInterval(timer);
      const truth = await ctx.link.truth<{ cart: Record<string, number>; orders: ServerOrder[] }>();
      const orders = truth.state.orders;
      const last = samples[samples.length - 1];
      const intended = Number(ctx.scenario.intent.orders ?? 1);

      let driftMs = 0;
      let maxDrift = 0;
      let run = 0;
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1];
        const dt = samples[i].t - a.t;
        if (a.total !== a.sum) {
          driftMs += dt;
          run += dt;
          maxDrift = Math.max(maxDrift, run);
        } else run = 0;
      }

      const wrongCharge = orders.filter((o) => o.total !== o.lines.reduce((a, l) => a + l.qty * l.price, 0));
      const reasons: string[] = [];
      if (orders.length > intended) reasons.push(`${orders.length} orders created for ${intended} intended`);
      if (last.confirmed > 0 && orders.length === 0) reasons.push("“Order placed” shown but no order exists");
      if (last.error && last.confirmed === 0 && orders.length > 0) reasons.push("told the order failed, but it was placed");
      if (last.placing) reasons.push("still “Placing order…” after everything settled");
      if (wrongCharge.length) reasons.push(`charged ${wrongCharge.map((o) => `$${(o.total / 100).toFixed(2)}`).join(", ")} for items worth a different amount`);
      if (last.total !== last.sum) reasons.push("displayed total ≠ sum of the lines at the end");
      else if (maxDrift > DRIFT_BUG_MS) reasons.push(`displayed total ≠ sum of the lines for ${(maxDrift / 1000).toFixed(1)} s`);
      if (orders.length === 0) {
        const server = truth.state.cart;
        const keys = new Set([...Object.keys(server), ...Object.keys(last.lines)]);
        const differs = [...keys].some((k) => (server[k] ?? 0) !== (last.lines[k] ?? 0));
        if (differs) reasons.push("cart on screen differs from the server cart");
      }

      const orderAt = ctx.marks.get("order");
      const confirmedAt = samples.find((s) => s.confirmed > 0)?.t;
      const errorsShown = samples.reduce((n, s, i) => n + (s.error && !(samples[i - 1]?.error ?? false) ? 1 : 0), 0);
      return {
        bug: reasons.length > 0,
        reasons,
        metrics: {
          ordersCreated: orders.length,
          duplicates: Math.max(0, orders.length - intended),
          wrongCharges: wrongCharge.length,
          driftMs: Math.round(driftMs),
          maxDriftMs: Math.round(maxDrift),
          errorsShown,
          latencyMs: orderAt && confirmedAt ? Math.round(confirmedAt - orderAt) : NaN,
        },
      };
    },
  };
}
