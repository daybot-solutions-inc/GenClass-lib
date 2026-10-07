// Merch store cart + checkout in React 19, state through GenClass's React adapter.
// Latent bugs (deliberate, realistic):
//   - "Place order" stays clickable while the order is being placed (no double-submit guard);
//   - orders are retried after timeouts and 5xx, but POST /api/orders has no idempotency key;
//   - the cart total is maintained incrementally: when a quantity change fails, the line is reverted but the
//     total is not, and a revert restores the quantity captured at click time even if later clicks succeeded.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useGenClassState } from "@genclass/runtime/react";
import type { AppContext } from "../../shared/demo-def.ts";
import { api } from "../../shared/api.ts";
import "./app.css";

interface Product {
  sku: string;
  name: string;
  price: number;
  stock: number;
  hue: number;
  blurb: string;
}
interface Line {
  sku: string;
  name: string;
  price: number;
  qty: number;
}
interface Cart {
  lines: Line[];
  count: number;
  total: number;
}
interface Order {
  id: string;
  total: number;
  lines: { sku: string; qty: number; price: number }[];
  createdAt: number;
}
interface Orders {
  placing: boolean;
  placed: Order[];
  error: string | null;
}

const EMPTY: Cart = { lines: [], count: 0, total: 0 };
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

const JSON_HEADERS = { "content-type": "application/json" };

function Swatch({ hue, label, size = 44 }: { hue: number; label: string; size?: number }) {
  return (
    <span className="co-swatch" style={{ ["--h" as string]: hue, width: size, height: size }} aria-hidden="true">
      {label.slice(0, 1)}
    </span>
  );
}

function Store() {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useGenClassState<Cart>("cart", EMPTY, { resync: () => reloadCart() });
  const [orders, setOrders] = useGenClassState<Orders>("orders", { placing: false, placed: [], error: null });
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const notify = (msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  };

  async function reloadCart() {
    const res = await fetch(api("cart"));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { lines: Line[]; count: number; subtotal: number };
    setCart({ lines: data.lines, count: data.count, total: data.subtotal });
  }

  useEffect(() => {
    void (async () => {
      const res = await fetch(api("products"));
      if (res.ok) setProducts((await res.json()) as Product[]);
      await reloadCart().catch(() => {});
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function add(p: Product) {
    const had = cart.lines.find((l) => l.sku === p.sku);
    setCart((c) => ({
      lines: had ? c.lines.map((l) => (l.sku === p.sku ? { ...l, qty: l.qty + 1 } : l)) : [...c.lines, { sku: p.sku, name: p.name, price: p.price, qty: 1 }],
      count: c.count + 1,
      total: c.total + p.price,
    }));
    try {
      const res = await fetchWithTimeout(api("cart/lines"), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sku: p.sku, qty: 1 }) }, 4000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { line } = (await res.json()) as { line: Line };
      setCart((c) => ({ ...c, lines: c.lines.map((l) => (l.sku === line.sku ? { ...l, qty: line.qty } : l)) }));
    } catch {
      setCart((c) => ({ ...c, lines: c.lines.map((l) => (l.sku === p.sku ? { ...l, qty: l.qty - 1 } : l)).filter((l) => l.qty > 0) }));
      notify(`Couldn’t add ${p.name}. Please try again.`);
    }
  }

  async function changeQty(line: Line, delta: number) {
    const qty = line.qty + delta;
    if (qty <= 0) return remove(line);
    setCart((c) => ({
      ...c,
      lines: c.lines.map((l) => (l.sku === line.sku ? { ...l, qty } : l)),
      count: c.count + delta,
      total: c.total + delta * line.price,
    }));
    try {
      const res = await fetchWithTimeout(
        api(`cart/lines/${line.sku}`),
        { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ qty }) },
        4000,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { line: saved } = (await res.json()) as { line: Line };
      setCart((c) => ({ ...c, lines: c.lines.map((l) => (l.sku === saved.sku ? { ...l, qty: saved.qty } : l)) }));
    } catch {
      setCart((c) => ({ ...c, lines: c.lines.map((l) => (l.sku === line.sku ? { ...l, qty: line.qty } : l)) }));
      notify("Couldn’t update the quantity.");
    }
  }

  async function remove(line: Line) {
    setCart((c) => ({ lines: c.lines.filter((l) => l.sku !== line.sku), count: c.count - line.qty, total: c.total - line.qty * line.price }));
    try {
      const res = await fetchWithTimeout(api(`cart/lines/${line.sku}`), { method: "DELETE" }, 4000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      setCart((c) => ({ ...c, lines: [...c.lines, line] }));
      notify(`Couldn’t remove ${line.name}.`);
    }
  }

  async function placeOrder() {
    setOrders((o) => ({ ...o, placing: true, error: null }));
    const body = JSON.stringify({ lines: cart.lines.map((l) => ({ sku: l.sku, qty: l.qty, price: l.price })), total: cart.total });
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetchWithTimeout(api("orders"), { method: "POST", headers: JSON_HEADERS, body }, 5000);
        if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          setOrders((o) => ({ ...o, placing: false, error: err.error ?? "Your order could not be placed." }));
          return;
        }
        const { order } = (await res.json()) as { order: Order };
        setOrders((o) => ({ placing: false, error: null, placed: [order, ...o.placed] }));
        setCart(EMPTY);
        return;
      } catch {
        if (attempt === 3) {
          setOrders((o) => ({ ...o, placing: false, error: "We couldn’t reach the store. Your order was not placed, please try again." }));
          return;
        }
        await sleep(600 * attempt);
      }
    }
  }

  const last = orders.placed[0];
  return (
    <div className="co">
      <section className="co-shop">
        <header className="co-head">
          <div>
            <div className="co-brand">Field Supply Co.</div>
            <div className="co-sub">Small-batch goods for people who ship</div>
          </div>
          <span className="co-pill">{products.length ? `${products.length} products` : "Loading…"}</span>
        </header>
        <div className="co-grid">
          {products.map((p) => {
            const inCart = cart.lines.find((l) => l.sku === p.sku)?.qty ?? 0;
            return (
              <article key={p.sku} className="co-card">
                <div className="co-art" style={{ ["--h" as string]: p.hue }}>
                  <Swatch hue={p.hue} label={p.name} size={52} />
                </div>
                <div className="co-card-body">
                  <div className="co-name">{p.name}</div>
                  <div className="co-blurb">{p.blurb}</div>
                  <div className="co-row">
                    <span className="co-price">{money(p.price)}</span>
                    {p.stock <= 4 && <span className="co-stock">Only {p.stock} left</span>}
                  </div>
                  <button
                    className="co-add"
                    type="button"
                    data-testid={`add-${p.sku}`}
                    disabled={inCart >= p.stock}
                    onClick={() => void add(p)}
                  >
                    {inCart ? `Add another · ${inCart} in cart` : "Add to cart"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <aside className="co-cart" data-testid="cart">
        <div className="co-cart-head">
          <h3>Your cart</h3>
          <span className="co-count" data-testid="cart-count">
            {cart.count} {cart.count === 1 ? "item" : "items"}
          </span>
        </div>
        {cart.lines.length === 0 ? (
          <div className="co-empty">{last ? "Thanks! Your cart is empty." : "Your cart is empty."}</div>
        ) : (
          <ul className="co-lines">
            {cart.lines.map((l) => {
              const p = products.find((x) => x.sku === l.sku);
              return (
                <li key={l.sku} data-testid="cart-line" data-sku={l.sku}>
                  <Swatch hue={p?.hue ?? 200} label={l.name} size={36} />
                  <div className="co-line-main">
                    <div className="co-line-name">{l.name}</div>
                    <div className="co-line-each" data-testid="line-price">
                      {money(l.price)}
                    </div>
                  </div>
                  <div className="co-stepper">
                    <button type="button" aria-label={`One less ${l.name}`} data-testid={`dec-${l.sku}`} onClick={() => void changeQty(l, -1)}>
                      −
                    </button>
                    <span data-testid="line-qty">{l.qty}</span>
                    <button
                      type="button"
                      aria-label={`One more ${l.name}`}
                      data-testid={`inc-${l.sku}`}
                      disabled={!!p && l.qty >= p.stock}
                      onClick={() => void changeQty(l, +1)}
                    >
                      +
                    </button>
                  </div>
                  <button type="button" className="co-remove" aria-label={`Remove ${l.name}`} data-testid={`remove-${l.sku}`} onClick={() => void remove(l)}>
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <dl className="co-sum">
          <div>
            <dt>Shipping</dt>
            <dd>Free</dd>
          </div>
          <div className="co-total">
            <dt>Total</dt>
            <dd data-testid="cart-total">{money(cart.total)}</dd>
          </div>
        </dl>
        <button
          className={`co-place${orders.placing ? " busy" : ""}`}
          type="button"
          data-testid="place-order"
          disabled={cart.lines.length === 0 && !orders.placing}
          onClick={() => void placeOrder()}
        >
          {orders.placing ? (
            <>
              <span className="spinner" /> Placing order…
            </>
          ) : (
            `Place order · ${money(cart.total)}`
          )}
        </button>
        {orders.error && (
          <div className="co-error" role="alert" data-testid="order-error">
            {orders.error}
          </div>
        )}
        {orders.placed.length > 0 && (
          <div className="co-orders" data-testid="order-confirmation">
            <div className="co-orders-head">Order placed</div>
            {orders.placed.map((o) => (
              <div key={o.id} className="co-order" data-testid="placed-order">
                <b>{o.id}</b>
                <span>
                  {o.lines.reduce((a, l) => a + l.qty, 0)} items · {money(o.total)}
                </span>
              </div>
            ))}
          </div>
        )}
        {toast && (
          <div className="co-toast" role="status" data-testid="app-toast">
            {toast}
          </div>
        )}
      </aside>
    </div>
  );
}

export function mountCheckout({ el }: AppContext): void {
  createRoot(el).render(<Store />);
}
