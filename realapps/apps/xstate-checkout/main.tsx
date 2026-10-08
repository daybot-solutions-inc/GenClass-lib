// Checkout wizard (React 19 + XState v5 machine + @xstate/react useSelector, fetch). The machine owns the flow:
// cart → shipping (rate quote) → payment → processing (invoked charge promise, retried with backoff for transient
// failures) → done | failed. Its context is mirrored into a GenClass atom on every transition. Latent bugs by flag:
// the Pay button guarded by a ref instead of the machine state, with a "restart a stuck payment" PAY transition
// in processing that re-invokes the charge (payGuard=ref: the aborted first request was already sent), an
// idempotency key per attempt or none at all (idemKey=per-attempt|none: retries and re-entries can charge twice),
// no automatic retry (retry=none), rate quotes fetched by a React effect without cleanup whose late answers set
// the shipping for a newer speed (quote=effect), the total not recomputed when a coupon is removed (total=...).
import { createRoot } from "react-dom/client";
import { useEffect, useRef } from "react";
import { assign, createActor, fromPromise, setup, type SnapshotFrom } from "xstate";
import { useSelector } from "@xstate/react";
import { rt, flag } from "../_shared/genclass";

type Line = { id: number; sku: string; name: string; price: number; qty: number };
type Speed = "standard" | "express" | "overnight" | "pickup";
type Rate = { id: Speed; label: string; price: number };
type Rule = { id: string; percent?: number; freeShipping?: boolean };
interface Ctx {
  orderRef: string;
  lines: Line[];
  subtotal: number;
  speed: Speed;
  shipping: number;
  quoting: boolean;
  couponDraft: string;
  coupon: Rule | null;
  discount: number;
  total: number;
  cardholder: string;
  attempt: number;
  payKey: string;
  orderId: number;
  error: string;
}
type Ev =
  | { type: "NEXT" }
  | { type: "BACK" }
  | { type: "RELOAD" }
  | { type: "SPEED"; speed: Speed }
  | { type: "QUOTED"; price: number }
  | { type: "COUPON_DRAFT"; value: string }
  | { type: "APPLY_COUPON" }
  | { type: "REMOVE_COUPON" }
  | { type: "NAME"; value: string }
  | { type: "PAY" }
  | { type: "NEW" };

const PAY_GUARD = flag("payGuard", "state") as "state" | "ref";
const IDEM = flag("idemKey", "per-order") as "per-order" | "per-attempt" | "none";
const RETRY = flag("retry", "machine") as "machine" | "none";
const QUOTE = flag("quote", "invoke") as "invoke" | "effect";
const TOTAL = flag("total", "recompute") as "recompute" | "forget-on-remove";

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}
async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new HttpError(r.status);
  return (await r.json()) as T;
}
async function charge(input: { amount: number; orderRef: string; cardholder: string; key: string }, signal: AbortSignal) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal.addEventListener("abort", onAbort);
  const timer = setTimeout(() => ctl.abort(new DOMException("The payment timed out", "TimeoutError")), 6000);
  try {
    const r = await fetch("/api/payments", {
      method: "POST",
      headers: { "content-type": "application/json", ...(input.key ? { "Idempotency-Key": input.key } : {}) },
      body: JSON.stringify({ orderRef: input.orderRef, amount: input.amount, cardholder: input.cardholder, method: "card" }),
      signal: ctl.signal,
    });
    if (!r.ok) throw new HttpError(r.status);
    return (await r.json()) as { id: number };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
const transient = (e: unknown) => (e instanceof HttpError ? e.status >= 500 || e.status === 429 || e.status === 408 : (e as Error)?.name === "TimeoutError" || e instanceof TypeError);

function priced(c: Ctx): Pick<Ctx, "discount" | "total"> {
  const discount = !c.coupon ? 0 : c.coupon.freeShipping ? c.shipping : Math.round((c.subtotal * (c.coupon.percent ?? 0)) / 100);
  return { discount, total: c.subtotal + c.shipping - discount };
}
let orders = 0;
const newKey = () => (IDEM === "none" ? "" : crypto.randomUUID());
const fresh = (): Ctx => ({ orderRef: `ord-${++orders}`, lines: [], subtotal: 0, speed: "standard", shipping: 0, quoting: false, couponDraft: "", coupon: null, discount: 0, total: 0, cardholder: "", attempt: 0, payKey: "", orderId: 0, error: "" });

// -------------------------------------------------------------------------------------------- machine
const machine = setup({
  types: { context: {} as Ctx, events: {} as Ev },
  actors: {
    loadCart: fromPromise(({ signal }) => getJson<{ items: Line[] }>("/api/cartlines", signal)),
    fetchRate: fromPromise(({ input, signal }: { input: { speed: Speed }; signal: AbortSignal }) => getJson<Rate>(`/api/rates/${input.speed}`, signal)),
    lookupCoupon: fromPromise(({ input, signal }: { input: { code: string }; signal: AbortSignal }) => getJson<Rule>(`/api/coupons/${encodeURIComponent(input.code)}`, signal)),
    charge: fromPromise(({ input, signal }: { input: { amount: number; orderRef: string; cardholder: string; key: string }; signal: AbortSignal }) => charge(input, signal)),
  },
  guards: {
    canRetry: ({ context, event }) => RETRY === "machine" && context.attempt < 3 && transient((event as { error?: unknown }).error),
    hasName: ({ context }) => context.cardholder.trim().length > 1,
  },
  delays: { backoff: ({ context }) => 600 * 2 ** (context.attempt - 1) },
}).createMachine({
  id: "checkout",
  context: fresh,
  initial: "cart",
  states: {
    cart: {
      initial: "loading",
      states: {
        loading: {
          invoke: {
            src: "loadCart",
            onDone: { target: "ready", actions: assign(({ context, event }) => ({ lines: event.output.items, subtotal: event.output.items.reduce((a, l) => a + l.price * l.qty, 0), ...priced({ ...context, subtotal: event.output.items.reduce((a, l) => a + l.price * l.qty, 0) }), error: "" })) },
            onError: { target: "error", actions: assign({ error: "Your cart could not be loaded" }) },
          },
        },
        ready: { on: { NEXT: { target: "#checkout.shipping" } } },
        error: { on: { RELOAD: { target: "loading" } } },
      },
    },
    shipping: {
      initial: QUOTE === "invoke" ? "quoting" : "ready",
      // quote=effect: the component fetches the rate when it sees the shipping step
      entry: QUOTE === "effect" ? assign({ quoting: true }) : undefined,
      states: {
        quoting: {
          entry: assign({ quoting: true }),
          invoke: {
            src: "fetchRate",
            input: ({ context }) => ({ speed: context.speed }),
            onDone: { target: "ready", actions: assign(({ context, event }) => ({ shipping: event.output.price, quoting: false, ...priced({ ...context, shipping: event.output.price }) })) },
            onError: { target: "ready", actions: assign({ quoting: false, error: "Shipping rate unavailable, please pick again" }) },
          },
        },
        ready: {},
        coupon: {
          invoke: {
            src: "lookupCoupon",
            input: ({ context }) => ({ code: context.couponDraft.trim().toUpperCase() }),
            onDone: { target: "ready", actions: assign(({ context, event }) => ({ coupon: event.output, couponDraft: "", ...priced({ ...context, coupon: event.output }), error: "" })) },
            onError: { target: "ready", actions: assign(({ event }) => ({ error: (event.error as HttpError)?.status === 404 ? "That coupon code is not valid" : "Could not check the coupon" })) },
          },
        },
      },
      on: {
        SPEED: QUOTE === "invoke" ? { target: ".quoting", actions: assign(({ event }) => ({ speed: event.speed, error: "" })) } : { actions: assign(({ context, event }) => ({ speed: event.speed, quoting: context.quoting || event.speed !== context.speed, error: "" })) },
        QUOTED: { actions: assign(({ context, event }) => ({ shipping: event.price, quoting: false, ...priced({ ...context, shipping: event.price }) })) },
        COUPON_DRAFT: { actions: assign(({ event }) => ({ couponDraft: event.value })) },
        APPLY_COUPON: { target: ".coupon" },
        REMOVE_COUPON: { actions: assign(({ context }) => (TOTAL === "recompute" ? { coupon: null, ...priced({ ...context, coupon: null }) } : { coupon: null, discount: 0 })) },
        BACK: { target: "cart.ready" },
        NEXT: { target: "payment", guard: ({ context }) => !context.quoting },
      },
    },
    payment: {
      entry: assign(() => (IDEM === "per-order" ? { payKey: newKey() } : {})),
      on: {
        NAME: { actions: assign(({ event }) => ({ cardholder: event.value })) },
        PAY: { target: "processing", guard: "hasName", actions: assign({ attempt: 0, error: "" }) },
        BACK: { target: "shipping.ready" },
      },
    },
    processing: {
      entry: assign(({ context }) => ({ attempt: context.attempt + 1, ...(IDEM === "per-attempt" ? { payKey: newKey() } : {}) })),
      invoke: {
        src: "charge",
        input: ({ context }) => ({ amount: context.total, orderRef: context.orderRef, cardholder: context.cardholder, key: context.payKey }),
        onDone: { target: "done", actions: assign(({ event }) => ({ orderId: event.output.id, error: "" })) },
        onError: [
          { guard: "canRetry", target: "retrying" },
          { target: "failed", actions: assign(({ event }) => ({ error: (event.error as Error)?.name === "TimeoutError" ? "The payment timed out" : "The payment did not go through" })) },
        ],
      },
      // "restart a stuck payment": only reachable when the button is not disabled by the machine state
      on: PAY_GUARD === "ref" ? { PAY: { target: "processing", reenter: true } } : {},
    },
    retrying: { after: { backoff: { target: "processing" } } },
    failed: {
      on: {
        PAY: { target: "processing", actions: assign({ attempt: 0, error: "" }) },
        BACK: { target: "payment" },
      },
    },
    done: { on: { NEW: { target: "cart", actions: assign(() => fresh()) } } },
  },
});

const stepOf = (s: SnapshotFrom<typeof machine>) => (typeof s.value === "string" ? s.value : Object.keys(s.value)[0]!);
const actor = createActor(machine);
const checkout = rt.atom("checkout", { step: "cart", ...actor.getSnapshot().context });
actor.subscribe((s) => checkout.set({ step: stepOf(s), ...s.context }));
actor.start();

// --------------------------------------------------------------------------------------------------- UI
const euros = (c: number) => `€${(c / 100).toFixed(2)}`;
const SPEEDS: Speed[] = ["standard", "express", "overnight", "pickup"];

function Totals({ c }: { c: Ctx }) {
  return (
    <p className="totals">
      Subtotal {euros(c.subtotal)} · Shipping {c.quoting ? "…" : euros(c.shipping)} {c.discount > 0 && `· Discount −${euros(c.discount)} `}· Total {euros(c.total)}
    </p>
  );
}

function Checkout() {
  const snap = useSelector(actor, (s) => s);
  const c = snap.context;
  const step = stepOf(snap);
  const paying = useRef(false);
  useEffect(() => {
    paying.current = false;
  }, [step]);
  // quote=effect: the rate is fetched by the component whenever the speed changes
  useEffect(() => {
    if (QUOTE !== "effect" || step !== "shipping") return;
    void getJson<Rate>(`/api/rates/${c.speed}`)
      .then((r) => actor.send({ type: "QUOTED", price: r.price }))
      .catch(() => actor.send({ type: "QUOTED", price: c.shipping }));
  }, [step, c.speed]);
  const send = (e: Ev) => actor.send(e);
  const pay = () => {
    if (PAY_GUARD === "ref") {
      if (paying.current) return;
      paying.current = true;
    }
    send({ type: "PAY" });
    if (stepOf(actor.getSnapshot()) === "payment") paying.current = false; // the machine refused it (no name yet)
  };
  const busy = step === "processing" || step === "retrying";
  return (
    <main className="checkout">
      <h1>Checkout</h1>
      {c.error && <p role="alert">{c.error}</p>}
      {step === "cart" && (
        <section className="step-cart">
          {snap.matches({ cart: "loading" }) && <p>Loading your cart…</p>}
          <ul>
            {c.lines.map((l) => (
              <li key={l.id}>
                {l.name} × {l.qty} · {euros(l.price * l.qty)}
              </li>
            ))}
          </ul>
          <p>Subtotal {euros(c.subtotal)}</p>
          {snap.matches({ cart: "error" }) ? (
            <button className="reload" onClick={() => send({ type: "RELOAD" })}>
              Retry
            </button>
          ) : (
            <button className="next-shipping" disabled={!snap.matches({ cart: "ready" })} onClick={() => send({ type: "NEXT" })}>
              Continue to shipping
            </button>
          )}
        </section>
      )}
      {step === "shipping" && (
        <section className="step-shipping">
          <label>
            Delivery{" "}
            <select name="speed" value={c.speed} onChange={(e) => send({ type: "SPEED", speed: e.target.value as Speed })}>
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          {c.coupon ? (
            <p className="coupon">
              Coupon {c.coupon.id} applied{" "}
              <button className="remove-coupon" onClick={() => send({ type: "REMOVE_COUPON" })}>
                Remove coupon
              </button>
            </p>
          ) : (
            <p className="coupon">
              <input name="coupon" value={c.couponDraft} onChange={(e) => send({ type: "COUPON_DRAFT", value: e.target.value })} placeholder="Coupon code" />
              <button className="apply-coupon" disabled={snap.matches({ shipping: "coupon" })} onClick={() => send({ type: "APPLY_COUPON" })}>
                Apply
              </button>
            </p>
          )}
          <Totals c={c} />
          <button className="back" onClick={() => send({ type: "BACK" })}>
            Back
          </button>
          {c.quoting ? (
            <p className="quoting">Calculating shipping…</p>
          ) : (
            <button className="next-payment" onClick={() => send({ type: "NEXT" })}>
              Continue to payment
            </button>
          )}
        </section>
      )}
      {(step === "payment" || busy || step === "failed") && (
        <section className={`step-${step === "failed" ? "failed" : step === "payment" ? "payment" : "processing"}`}>
          <input name="cardholder" value={c.cardholder} disabled={step !== "payment"} onChange={(e) => send({ type: "NAME", value: e.target.value })} placeholder="Name on card" />
          <Totals c={c} />
          {busy && <p className="processing">Processing payment… (attempt {c.attempt})</p>}
          <button className="pay" disabled={PAY_GUARD === "state" && !(snap.can({ type: "PAY" }) && !busy)} onClick={pay}>
            {step === "failed" ? "Try again" : busy ? "Processing…" : `Pay ${euros(c.total)}`}
          </button>
          {!busy && (
            <button className="back" onClick={() => send({ type: "BACK" })}>
              Back
            </button>
          )}
        </section>
      )}
      {step === "done" && (
        <section className="step-done">
          <p className="confirmed">
            Payment #{c.orderId} confirmed · {euros(c.total)} · {c.orderRef}
          </p>
          <button className="new-order" onClick={() => send({ type: "NEW" })}>
            Start a new order
          </button>
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<Checkout />);
