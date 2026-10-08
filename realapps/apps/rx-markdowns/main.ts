// Store markdown tool for retail floor managers (RxJS 7 streams + a hand-written DOM layer; fetch; state in runtime
// atoms). Search products by name or SKU (debounced) within a department, tick some, apply a percentage markdown to the
// ticked ones (POST /products/bulk with per-item results; other managers change markdowns too), restore one product's
// full price (versioned PATCH) and send shelf labels for the ticked products to the printer queue (POST /labels, at most
// two at a time). Latent bugs by flag: searches flattened with mergeMap (search=mergeMap: results for an older query
// land last), markdowns sent as a per-product relative delta computed from the list and retried after a 5xx
// (markdown=delta-retry: a delta that committed before the error is applied twice; a stale list gives the wrong delta),
// bulk results ignored (bulkResult=assume-all: products the server did not change show the new price), Apply
// flattened with mergeMap (apply=mergeMap: a double click sends the markdown twice) and an unbounded print queue
// (printConcurrency=0: every label is posted at once).
import { Subject, EMPTY, from, defer } from "rxjs";
import { catchError, debounceTime, exhaustMap, finalize, map, mergeMap, switchMap, tap } from "rxjs/operators";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Product = { id: number; sku: string; name: string; dept: string; basePrice: number; markdown: number; version: number };
type Label = { key: string; sku: string; name: string; price: number; status: "queued" | "sending" | "sent" | "failed" };
const SEARCH = flag("search", "switchMap");
const MARKDOWN = flag("markdown", "bulk-absolute");
const BULK = flag("bulkResult", "per-item");
const APPLY = flag("apply", "exhaustMap");
const PRINT = Number(flag("printConcurrency", 2));

const shelf = rt.atom("shelf", { q: "", dept: "all", rows: [] as Product[], selected: [] as number[], pct: 20, loading: true, applying: false, pending: [] as number[], error: "", notice: "" });
const printer = rt.atom("printer", { queue: [] as Label[], sending: 0 });
type S = ReturnType<typeof shelf.get>;
const priceOf = (p: Product) => Math.round(p.basePrice * (100 - p.markdown)) / 100;
const merge = (s: S, ps: Product[]): S => ({ ...s, rows: s.rows.map((r) => ps.find((p) => p.id === r.id) ?? r) });

// --------------------------------------------------------------------------------------------- search
type Query = { q: string; dept: string };
const query$ = new Subject<Query>();
const runQuery = ({ q, dept }: Query) =>
  from(api<{ items: Product[] }>(`/api/products?sort=name&limit=12${q ? `&q=${encodeURIComponent(q)}` : ""}${dept === "all" ? "" : `&dept=${dept}`}`)).pipe(
    map((body) => itemsOf<Product>(body)),
    catchError((e) => (shelf.update((s) => ({ ...s, loading: false, error: errText(e, "searching products") })), EMPTY)),
  );
query$
  .pipe(
    debounceTime(250),
    tap(() => shelf.update((s) => ({ ...s, loading: true, error: "" }))),
    SEARCH === "switchMap" ? switchMap(runQuery) : mergeMap(runQuery),
  )
  .subscribe((rows) => shelf.update((s) => ({ ...s, rows, selected: s.selected.filter((id) => rows.some((r) => r.id === id)), loading: false })));

// --------------------------------------------------------------------------------------------- markdowns
async function markdownDelta(p: Product, pct: number): Promise<Product> {
  // "add markdown" endpoint: relative to the product's current markdown as the list shows it
  const send = () => api<Product>(`/api/products/${p.id}/markdown`, "POST", { by: pct - p.markdown });
  try {
    return await send();
  } catch (e) {
    if (e instanceof HttpError && e.status > 0 && e.status < 500) throw e;
    return send();
  }
}
const apply$ = new Subject<void>();
const runApply = () =>
  defer(async () => {
    const s0 = shelf.get();
    const ids = s0.selected.slice();
    const pct = s0.pct;
    if (!ids.length) return;
    shelf.update((s) => ({ ...s, applying: true, pending: [...s.pending, ...ids], error: "", notice: "" }));
    try {
      if (MARKDOWN === "bulk-absolute") {
        const r = await api<{ results: { id: number; ok: boolean }[] }>(`/api/products/bulk`, "POST", { ids, op: "patch", patch: { markdown: pct } });
        const ok = new Set((BULK === "per-item" ? (r.results ?? []).filter((x) => x.ok).map((x) => Number(x.id)) : ids) as number[]);
        const failed = ids.length - (r.results ?? []).filter((x) => x.ok).length;
        shelf.update((s) => ({ ...s, rows: s.rows.map((p) => (ok.has(p.id) ? { ...p, markdown: pct } : p)), notice: `${ok.size} product(s) now ${pct}% off.`, error: BULK === "per-item" && failed ? `${failed} product(s) could not be marked down.` : "" }));
      } else {
        const rows = s0.rows.filter((p) => ids.includes(p.id));
        const settled = await Promise.allSettled(rows.map((p) => markdownDelta(p, pct)));
        const done = settled.flatMap((x) => (x.status === "fulfilled" ? [x.value] : []));
        shelf.update((s) => ({ ...merge(s, done), notice: `${done.length} product(s) marked down.`, error: done.length < rows.length ? `${rows.length - done.length} product(s) could not be marked down.` : "" }));
      }
    } catch (e) {
      shelf.update((s) => ({ ...s, error: errText(e, "applying the markdown") }));
    } finally {
      shelf.update((s) => ({ ...s, applying: false, pending: s.pending.filter((id) => !ids.includes(id)) }));
    }
  });
apply$.pipe(APPLY === "exhaustMap" ? exhaustMap(runApply) : mergeMap(runApply)).subscribe();

async function restore(p: Product) {
  if (shelf.get().pending.includes(p.id)) return;
  shelf.update((s) => ({ ...s, pending: [...s.pending, p.id], error: "", notice: "" }));
  try {
    const saved = await api<Product>(`/api/products/${p.id}`, "PATCH", { markdown: 0, version: p.version });
    shelf.update((s) => ({ ...merge(s, [saved]), notice: `${saved.name} is back to $${priceOf(saved).toFixed(2)}.` }));
  } catch (e) {
    const cur = e instanceof HttpError && e.status === 409 ? (e.body?.current as Product | undefined) : undefined;
    shelf.update((s) => ({ ...(cur ? merge(s, [cur]) : s), error: cur ? `${cur.name} was just changed by another manager (${cur.markdown}% off).` : errText(e, `restoring ${p.name}`) }));
  } finally {
    shelf.update((s) => ({ ...s, pending: s.pending.filter((x) => x !== p.id) }));
  }
}

// --------------------------------------------------------------------------------------------- labels
let labelN = 0;
const print$ = new Subject<Label>();
const setLabel = (key: string, status: Label["status"]) => printer.update((p) => ({ ...p, queue: p.queue.map((l) => (l.key === key ? { ...l, status } : l)) }));
print$
  .pipe(
    mergeMap(
      (l) =>
        defer(async () => {
          printer.update((p) => ({ ...p, sending: p.sending + 1 }));
          setLabel(l.key, "sending");
          try {
            await api(`/api/labels`, "POST", { sku: l.sku, name: l.name, price: l.price, store: "Store 214" });
            setLabel(l.key, "sent");
          } catch (e) {
            setLabel(l.key, "failed");
            shelf.update((s) => ({ ...s, error: errText(e, `printing the label for ${l.name}`) }));
          }
        }).pipe(finalize(() => printer.update((p) => ({ ...p, sending: p.sending - 1 })))),
      PRINT > 0 ? PRINT : Infinity,
    ),
  )
  .subscribe();
function printSelected() {
  const s = shelf.get();
  const ls: Label[] = s.rows.filter((p) => s.selected.includes(p.id)).map((p) => ({ key: `l${++labelN}`, sku: p.sku, name: p.name, price: priceOf(p), status: "queued" }));
  if (!ls.length) return;
  printer.update((p) => ({ ...p, queue: [...ls, ...p.queue].slice(0, 12) }));
  ls.forEach((l) => print$.next(l));
}

// --------------------------------------------------------------------------------------------- DOM
const root = document.getElementById("app")!;
root.innerHTML = `<main class="markdowns"><h1>Markdowns · Store 214</h1>
  <div class="search"><input name="q" placeholder="Product name or SKU"> <select name="dept"><option value="all">All departments</option><option>Outdoor</option><option>Kitchen</option><option>Footwear</option></select></div>
  <div class="actions"><select name="pct"><option value="10">10% off</option><option value="20" selected>20% off</option><option value="30">30% off</option><option value="50">50% off</option></select>
    <button type="button" class="apply">Apply markdown</button> <button type="button" class="print">Print labels</button></div>
  <div class="msg"></div><p class="summary"></p><ul class="products"></ul><h2>Label queue</h2><ul class="labels"></ul></main>`;
const q = <T extends Element>(s: string) => root.querySelector(s) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
shelf.subscribe((s) => {
  q("p.summary").textContent = s.loading ? "Searching…" : `${s.rows.length} products · ${s.selected.length} selected`;
  q("div.msg").innerHTML = s.error ? `<p role="alert">${esc(s.error)}</p>` : s.notice ? `<p class="notice">${esc(s.notice)}</p>` : "";
  q("ul.products").innerHTML = s.rows
    .map((p) => `<li class="product" data-id="${p.id}"><input type="checkbox" class="pick"${s.selected.includes(p.id) ? " checked" : ""}> <strong>${esc(p.name)}</strong> · ${esc(p.sku)} · ${esc(p.dept)}
      · $${priceOf(p).toFixed(2)}${p.markdown ? ` <s>$${p.basePrice.toFixed(2)}</s> (${p.markdown}% off)` : ""}${s.pending.includes(p.id) ? " · updating…" : ""}
      ${p.markdown ? `<button type="button" class="restore"${s.pending.includes(p.id) ? " disabled" : ""}>Restore price</button>` : ""}</li>`)
    .join("");
  q<HTMLButtonElement>("button.apply").disabled = !s.selected.length || (APPLY === "exhaustMap" && s.applying);
  q<HTMLButtonElement>("button.apply").textContent = s.applying ? "Applying…" : "Apply markdown";
  q<HTMLButtonElement>("button.print").disabled = !s.selected.length;
});
printer.subscribe((p) => {
  q("ul.labels").innerHTML = p.queue.map((l) => `<li class="label">${esc(l.name)} · $${l.price.toFixed(2)} · ${l.status}</li>`).join("");
});
const current = (): Query => ({ q: q<HTMLInputElement>("input[name=q]").value.trim(), dept: q<HTMLSelectElement>("select[name=dept]").value });
q("input[name=q]").addEventListener("input", () => {
  shelf.update((s) => ({ ...s, q: current().q, loading: true }));
  query$.next(current());
});
q("select[name=dept]").addEventListener("change", () => {
  shelf.update((s) => ({ ...s, dept: current().dept, loading: true, notice: "" }));
  query$.next(current());
});
q("select[name=pct]").addEventListener("change", (e) => shelf.update((s) => ({ ...s, pct: Number((e.target as HTMLSelectElement).value) })));
root.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.matches("button.apply")) return apply$.next();
  if (t.matches("button.print")) return printSelected();
  const id = Number(t.closest("li.product")?.getAttribute("data-id"));
  if (!id) return;
  if (t.matches("input.pick")) shelf.update((s) => ({ ...s, selected: s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id] }));
  else if (t.matches("button.restore")) {
    const p = shelf.get().rows.find((r) => r.id === id);
    if (p) void restore(p);
  }
});
query$.next({ q: "", dept: "all" });
// the list is refreshed every 8 s so other managers' markdowns show up (selection kept)
setInterval(() => {
  const s = shelf.get();
  if (s.loading || s.applying || s.pending.length) return;
  void api<{ items: Product[] }>(`/api/products?sort=name&limit=12${s.q ? `&q=${encodeURIComponent(s.q)}` : ""}${s.dept === "all" ? "" : `&dept=${s.dept}`}`).then(
    (b) => shelf.update((x) => (x.q !== s.q || x.dept !== s.dept || x.applying || x.pending.length ? x : merge(x, itemsOf<Product>(b)))),
    () => undefined,
  );
}, 8000);
