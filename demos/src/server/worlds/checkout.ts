import type { WorldDef } from "../core.ts";
import { now } from "../core.ts";

export interface Product {
  sku: string;
  name: string;
  /** Price in cents. */
  price: number;
  stock: number;
  hue: number;
  blurb: string;
}

export interface ServerOrder {
  id: string;
  lines: { sku: string; qty: number; price: number }[];
  total: number;
  createdAt: number;
}

interface CheckoutState {
  products: Product[];
  cart: Map<string, number>;
  orders: ServerOrder[];
  nextOrder: number;
  /** Cart contents over time (for the oracle). */
  cartHistory: { t: number; lines: Record<string, number> }[];
}

export const PRODUCTS: Product[] = [
  { sku: "mug", name: "Ceramic mug", price: 1800, stock: 8, hue: 28, blurb: "Stoneware, 350 ml" },
  { sku: "tee", name: "Logo tee", price: 2900, stock: 5, hue: 220, blurb: "Organic cotton" },
  { sku: "cap", name: "Dad cap", price: 2400, stock: 3, hue: 150, blurb: "Washed twill" },
  { sku: "tote", name: "Canvas tote", price: 1600, stock: 10, hue: 45, blurb: "Heavy canvas" },
  { sku: "notebook", name: "Dot notebook", price: 1200, stock: 6, hue: 280, blurb: "A5, 160 pages" },
  { sku: "stickers", name: "Sticker pack", price: 600, stock: 4, hue: 340, blurb: "Five vinyl stickers" },
];

function cartJson(s: CheckoutState) {
  const lines = [...s.cart.entries()].map(([sku, qty]) => {
    const p = s.products.find((x) => x.sku === sku)!;
    return { sku, name: p.name, price: p.price, qty };
  });
  return {
    lines,
    count: lines.reduce((a, l) => a + l.qty, 0),
    subtotal: lines.reduce((a, l) => a + l.qty * l.price, 0),
  };
}

function record(s: CheckoutState) {
  s.cartHistory.push({ t: now(), lines: Object.fromEntries(s.cart) });
  if (s.cartHistory.length > 1000) s.cartHistory.splice(0, s.cartHistory.length - 1000);
}

function lineJson(s: CheckoutState, sku: string) {
  const p = s.products.find((x) => x.sku === sku)!;
  return { sku, name: p.name, price: p.price, qty: s.cart.get(sku) ?? 0 };
}

export const checkoutWorld: WorldDef<CheckoutState> = {
  demo: "checkout",
  create: () => {
    const s: CheckoutState = {
      products: PRODUCTS.map((p) => ({ ...p })),
      cart: new Map(),
      orders: [],
      nextOrder: 1041,
      cartHistory: [],
    };
    record(s);
    return s;
  },
  routes: [
    {
      method: "GET",
      pattern: /^\/products$/,
      key: () => "products",
      handle: (w) => ({ status: 200, json: w.state.products }),
    },
    {
      method: "GET",
      pattern: /^\/cart$/,
      key: () => "cart",
      handle: (w) => ({ status: 200, json: cartJson(w.state) }),
    },
    {
      method: "POST",
      pattern: /^\/cart\/lines$/,
      key: () => "cart/lines",
      handle: (w, req) => {
        const { sku, qty } = (req.body ?? {}) as { sku?: string; qty?: number };
        const p = w.state.products.find((x) => x.sku === sku);
        if (!p || typeof qty !== "number" || qty <= 0) return { status: 400, json: { error: "unknown product" } };
        const want = (w.state.cart.get(p.sku) ?? 0) + Math.floor(qty);
        const got = Math.min(want, p.stock);
        w.state.cart.set(p.sku, got);
        record(w.state);
        return {
          status: 200,
          json: { line: lineJson(w.state, p.sku), clamped: got < want },
          effect: `${p.sku} → ${got}${got < want ? " (clamped to stock)" : ""}`,
        };
      },
    },
    {
      method: "PATCH",
      pattern: /^\/cart\/lines\/([\w-]+)$/,
      key: () => "cart/lines",
      handle: (w, req) => {
        const sku = req.params[0];
        const p = w.state.products.find((x) => x.sku === sku);
        const { qty } = (req.body ?? {}) as { qty?: number };
        if (!p || typeof qty !== "number") return { status: 400, json: { error: "bad request" } };
        const want = Math.max(0, Math.floor(qty));
        const got = Math.min(want, p.stock);
        if (got === 0) w.state.cart.delete(sku);
        else w.state.cart.set(sku, got);
        record(w.state);
        return {
          status: 200,
          json: { line: lineJson(w.state, sku), clamped: got < want },
          effect: `${sku} → ${got}${got < want ? " (clamped to stock)" : ""}`,
        };
      },
    },
    {
      method: "DELETE",
      pattern: /^\/cart\/lines\/([\w-]+)$/,
      key: () => "cart/lines",
      handle: (w, req) => {
        const sku = req.params[0];
        w.state.cart.delete(sku);
        record(w.state);
        return { status: 200, json: { line: { sku, qty: 0 } }, effect: `${sku} removed` };
      },
    },
    {
      method: "POST",
      pattern: /^\/orders$/,
      key: () => "orders",
      handle: (w, req) => {
        const body = (req.body ?? {}) as { lines?: { sku: string; qty: number; price: number }[]; total?: number };
        if (!Array.isArray(body.lines) || body.lines.length === 0)
          return { status: 400, json: { error: "An order needs at least one line" } };
        const order: ServerOrder = {
          id: `A-${w.state.nextOrder++}`,
          lines: body.lines.map((l) => ({ sku: String(l.sku), qty: Number(l.qty), price: Number(l.price) })),
          total: Number(body.total),
          createdAt: now(),
        };
        w.state.orders.push(order);
        w.state.cart.clear();
        record(w.state);
        return { status: 201, json: { order }, work: 120, effect: `order ${order.id} created (${order.total} cents)` };
      },
    },
    {
      method: "GET",
      pattern: /^\/orders$/,
      key: () => "orders/list",
      handle: (w) => ({ status: 200, json: w.state.orders.slice(-10).reverse() }),
    },
  ],
  snapshot: (w) => ({
    cart: Object.fromEntries(w.state.cart),
    orders: w.state.orders,
    products: w.state.products,
    cartHistory: w.state.cartHistory,
  }),
};
