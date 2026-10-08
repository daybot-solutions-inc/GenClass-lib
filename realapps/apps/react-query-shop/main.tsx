// Homeware shop (React 19 + TanStack Query v5 for server data, a Zustand cart with the GenClass middleware, filters
// in useGenClassState). Catalog queries are keyed per filter (no response races by construction), default retries
// kept. Adding to the cart is optimistic; the server answers every cart write with the whole cart. Checkout POSTs
// an order. Latent bugs by flag: failed adds rolled back to an older snapshot that also wipes a concurrent add
// (rollback=snapshot) or not rolled back (none), late cart echoes overwriting newer ones (echo=always), double
// submits (submitGuard=none), duplicate orders from a timeout retry without an Idempotency-Key
// (checkout=retry-no-key) and no recovery from a lost response at all (checkout=plain).
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider, keepPreviousData, useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { genclass } from "@genclass/runtime/zustand";
import { useGenClassState } from "@genclass/runtime/react";
import { rt, flag } from "../_shared/genclass";

type Product = { id: number; name: string; category: string; price: number; stock: number };
type Line = { id?: number; productId: number; name: string; price: number; qty: number; pending?: boolean };
type CartView = { items: Line[]; count: number; total: number };
type Order = { id: number; total: number };
const ROLLBACK = flag("rollback", "refetch") as "refetch" | "snapshot" | "none";
const ECHO = flag("echo", "latest") as "latest" | "always";
const SUBMIT_GUARD = flag("submitGuard", "disable") as "disable" | "none";
const CHECKOUT = flag("checkout", "key+retry") as "key+retry" | "plain" | "retry-no-key";

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

async function http<T>(url: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(url, { ...init, headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
  if (!r.ok) throw new HttpError(r.status);
  return (await r.json()) as T;
}

// ------------------------------------------------------------------------------------------------- cart
interface CartState extends CartView {
  status: "idle" | "submitting" | "placed" | "failed";
  orderId: number | null;
  checkoutKey: string;
  error: string;
}
const useCart = create<CartState>()(
  genclass(rt, "cart")(() => ({ items: [] as Line[], count: 0, total: 0, status: "idle" as CartState["status"], orderId: null as number | null, checkoutKey: "", error: "" })),
);
let cartSeq = 0;

const totals = (items: Line[]) => ({ items, count: items.reduce((a, l) => a + l.qty, 0), total: Math.round(items.reduce((a, l) => a + l.qty * l.price, 0) * 100) / 100 });
const fromServer = (v: CartView): Partial<CartState> => ({ items: v.items, count: v.count, total: v.total });

async function refetchCart() {
  const seq = ++cartSeq;
  try {
    const v = await http<CartView>("/api/cart/summary");
    if (seq === cartSeq) useCart.setState(fromServer(v));
  } catch {
    useCart.setState({ error: "Could not refresh the cart" });
  }
}

function optimisticAdd(p: Product) {
  return (s: CartState): Partial<CartState> => {
    const has = s.items.some((l) => l.productId === p.id);
    const items = has ? s.items.map((l) => (l.productId === p.id ? { ...l, qty: l.qty + 1 } : l)) : [...s.items, { productId: p.id, name: p.name, price: p.price, qty: 1, pending: true }];
    return { ...totals(items), checkoutKey: "", error: "" };
  };
}

function useAddToCart() {
  return useMutation({
    mutationKey: ["cart"],
    mutationFn: (p: Product) => http<CartView>("/api/cart", { method: "POST", body: JSON.stringify({ productId: p.id, name: p.name, price: p.price, qty: 1 }) }),
    onMutate: (p: Product) => {
      const snapshot = useCart.getState();
      useCart.setState(optimisticAdd(p));
      return { snapshot: { items: snapshot.items, count: snapshot.count, total: snapshot.total }, seq: ++cartSeq };
    },
    onSuccess: (view, _p, ctx) => {
      if (ECHO === "latest" && ctx && ctx.seq !== cartSeq) return; // a newer cart write will answer with a newer cart
      useCart.setState(fromServer(view));
    },
    onError: (_e, p, ctx) => {
      useCart.setState({ error: `Could not add ${p.name} to the cart` });
      if (ROLLBACK === "snapshot" && ctx) useCart.setState(ctx.snapshot);
      else if (ROLLBACK === "refetch") void refetchCart();
    },
  });
}

function useRemoveLine() {
  return useMutation({
    mutationKey: ["cart"],
    mutationFn: (l: Line) => http<CartView>(`/api/cart/${l.id}`, { method: "DELETE" }),
    onMutate: (l: Line) => {
      useCart.setState((s) => ({ ...totals(s.items.filter((x) => x.productId !== l.productId)), checkoutKey: "" }));
      return { seq: ++cartSeq };
    },
    onSuccess: (view, _l, ctx) => {
      if (ECHO === "latest" && ctx && ctx.seq !== cartSeq) return;
      useCart.setState(fromServer(view));
    },
    onError: (_e, l) => {
      useCart.setState({ error: `Could not remove ${l.name}` });
      if (ROLLBACK !== "none") void refetchCart();
    },
  });
}

function useCheckout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, items, total }: { key: string; items: Line[]; total: number }) =>
      http<Order>("/api/orders", {
        method: "POST",
        body: JSON.stringify({ lines: items.map((l) => ({ productId: l.productId, qty: l.qty, price: l.price })), total }),
        headers: CHECKOUT === "key+retry" ? { "Idempotency-Key": key } : {},
        signal: AbortSignal.timeout(4000),
      }),
    retry: (n, err) => CHECKOUT !== "plain" && n < 1 && (err as Error).name === "TimeoutError",
    retryDelay: 300,
    onMutate: () => useCart.setState({ status: "submitting", error: "" }),
    onSuccess: async (order, vars) => {
      useCart.setState({ status: "placed", orderId: order.id, checkoutKey: "" });
      void qc.invalidateQueries({ queryKey: ["products"] });
      const ids = vars.items.map((l) => l.id).filter((x) => x !== undefined);
      try {
        await http("/api/cart/bulk", { method: "POST", body: JSON.stringify({ ids, op: "delete" }) });
      } finally {
        void refetchCart();
      }
    },
    onError: (e) => useCart.setState({ status: "failed", error: (e as Error).name === "TimeoutError" ? "Checkout timed out" : "Checkout failed, please try again" }),
  });
}

// --------------------------------------------------------------------------------------------------- UI
function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const h = setTimeout(() => setD(v), ms);
    return () => clearTimeout(h);
  }, [v, ms]);
  return d;
}

function Catalog() {
  const [shop, setShop] = useGenClassState("shop", { q: "", category: "all", selected: 0 });
  const q = useDebounced(shop.q.trim(), 250);
  const add = useAddToCart();
  const list = useQuery({
    queryKey: ["products", { category: shop.category, q }],
    queryFn: ({ signal }) => http<{ items: Product[]; total: number }>(`/api/products?${new URLSearchParams({ ...(q ? { q } : {}), ...(shop.category !== "all" ? { category: shop.category } : {}) })}`, { signal }),
    placeholderData: keepPreviousData,
  });
  const detail = useQuery({ queryKey: ["product", shop.selected], queryFn: () => http<Product>(`/api/products/${shop.selected}`), enabled: shop.selected > 0 });
  return (
    <section className="catalog">
      <input name="q" value={shop.q} onChange={(e) => setShop((s) => ({ ...s, q: e.target.value }))} placeholder="Search" aria-label="Search products" />
      <select name="category" value={shop.category} onChange={(e) => setShop((s) => ({ ...s, category: e.target.value }))}>
        {["all", "home", "office", "kitchen", "garden"].map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      {list.isFetching && <span className="loading">Loading…</span>}
      {list.isError && <p role="alert">Could not load products</p>}
      <p className="count">{list.data?.total ?? 0} products</p>
      <ul>
        {(list.data?.items ?? []).map((p) => (
          <li key={p.id} className="product">
            {p.name} · ${p.price} {p.stock === 0 && <em>(back-order)</em>}
            <button className="view" onClick={() => setShop((s) => ({ ...s, selected: p.id }))}>
              View
            </button>
            <button className="add" onClick={() => add.mutate(p)}>
              Add to cart
            </button>
          </li>
        ))}
      </ul>
      {shop.selected > 0 && (
        <aside className="detail">
          {detail.isPending && <p>Loading product…</p>}
          {detail.isError && <p role="alert">Product unavailable</p>}
          {detail.data && (
            <>
              <h2>{detail.data.name}</h2>
              <p>
                {detail.data.category} · ${detail.data.price} · {detail.data.stock} in stock
              </p>
              <button className="add" onClick={() => add.mutate(detail.data!)}>
                Add to cart
              </button>
            </>
          )}
          <button className="close" onClick={() => setShop((s) => ({ ...s, selected: 0 }))}>
            Close
          </button>
        </aside>
      )}
    </section>
  );
}

function Cart() {
  const cart = useCart();
  const remove = useRemoveLine();
  const checkout = useCheckout();
  const cartWrites = useIsMutating({ mutationKey: ["cart"] });
  const submit = () => {
    const now = useCart.getState();
    if (!now.items.length) return;
    // one key per cart content: a double submit of the same cart is the same order
    let key = now.checkoutKey;
    if (!key) {
      key = crypto.randomUUID();
      useCart.setState({ checkoutKey: key });
    }
    checkout.mutate({ key, items: now.items, total: now.total });
  };
  return (
    <aside className="cart">
      <h2>
        Cart ({cart.count}) · ${cart.total}
      </h2>
      {cart.error && <p role="alert">{cart.error}</p>}
      {cart.status === "placed" && <p className="placed">Order #{cart.orderId} placed</p>}
      <ul>
        {cart.items.map((l) => (
          <li key={l.productId} className={l.pending ? "cart-line pending" : "cart-line"}>
            {l.name} × {l.qty} = ${l.price * l.qty}
            {l.id !== undefined && (
              <button className="remove" onClick={() => remove.mutate(l)}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      <button className="checkout" disabled={!cart.items.length || (SUBMIT_GUARD === "disable" && (checkout.isPending || cartWrites > 0))} onClick={submit}>
        {checkout.isPending ? "Placing order…" : "Checkout"}
      </button>
    </aside>
  );
}

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5000 } } });

function App() {
  useEffect(() => void refetchCart(), []);
  return (
    <QueryClientProvider client={queryClient}>
      <main className="shop">
        <h1>Homeware</h1>
        <Catalog />
        <Cart />
      </main>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
