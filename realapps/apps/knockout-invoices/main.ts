// Invoice editor for a small consultancy (Knockout 3.5 observables / computeds bound to the DOM with data-bind,
// fetch for the API). The Knockout view model is the store, registered with rt.guard: typing writes observables
// directly (traced); everything that comes back from the server goes through the guarded handle. Edits autosave
// (rate-limited computed) as versioned PATCHes. Latent bugs by flag: totals kept in plain observables recalculated
// from a few handlers only (totals=manual: price edits, removed lines and tax changes leave stale totals), autosaves
// that overlap instead of queueing (autosave=overlap: the second PATCH carries a stale version), save echoes applied
// to the editor (echo=apply: an older echo reverts newer typing), 409 handling that overwrites the other user's
// change or throws local edits away (conflict=overwrite|reload), invoice switches without flushing the pending save or
// checking the response is still wanted (switchGuard=none: one invoice's lines saved onto another) and a "Record
// payment" button that stays enabled while posting (payGuard=none: duplicate payments).
import ko from "knockout";
import { rt, flag } from "../_shared/genclass";

const TOTALS = flag("totals", "computed") as "computed" | "manual";
const AUTOSAVE = flag("autosave", "serial") as "serial" | "overlap";
const DELAY = Number(flag("saveDelayMs", 800));
const ECHO = flag("echo", "version-only") as "version-only" | "apply";
const CONFLICT = flag("conflict", "rebase") as "rebase" | "overwrite" | "reload";
const SWITCH_GUARD = flag("switchGuard", "token") as "token" | "none";
const PAY_GUARD = flag("payGuard", "disable") as "disable" | "none";

type LineJS = { lid: string; desc: string; qty: number; price: number };
type Invoice = { id: number; number: string; customer: string; taxRate: number; lines: LineJS[]; status: string; version: number; subtotal: number; tax: number; total: number };
type Summary = { id: number; number: string; customer: string; total: number; status: string };

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const money = (n: unknown) => `$${num(n).toFixed(2)}`;

class LineVM {
  desc = ko.observable("");
  qty = ko.observable<string | number>(1);
  price = ko.observable<string | number>(0);
  amount = ko.pureComputed(() => r2(num(this.qty()) * num(this.price())));
  constructor(public lid: string, l?: Partial<LineJS>) {
    if (l) this.assign(l);
    if (TOTALS === "manual") this.qty.subscribe(() => recalc()); // quantities are the usual edit
  }
  assign(l: Partial<LineJS>) {
    if (l.desc !== undefined && l.desc !== this.desc()) this.desc(l.desc);
    if (l.qty !== undefined && num(l.qty) !== num(this.qty())) this.qty(l.qty);
    if (l.price !== undefined && num(l.price) !== num(this.price())) this.price(l.price);
  }
  toJS(): LineJS {
    return { lid: this.lid, desc: this.desc(), qty: num(this.qty()), price: num(this.price()) };
  }
}

const sumLines = () => r2(vm.lines().reduce((s, l) => s + l.amount(), 0));
const vm = {
  money,
  list: ko.observableArray<Summary>([]),
  listLoading: ko.observable(true),
  currentId: ko.observable(0),
  number: ko.observable(""),
  customer: ko.observable(""),
  taxRate: ko.observable("0.08"),
  status: ko.observable("draft"),
  version: ko.observable(0),
  lines: ko.observableArray<LineVM>([]),
  subtotal: null as unknown as ko.Observable<number> | ko.PureComputed<number>,
  tax: null as unknown as ko.Observable<number> | ko.PureComputed<number>,
  total: null as unknown as ko.Observable<number> | ko.PureComputed<number>,
  paid: ko.observable(0),
  loading: ko.observable(false),
  saving: ko.observable(false),
  saveState: ko.observable(""),
  paying: ko.observable(false),
  error: ko.observable(""),
};
if (TOTALS === "computed") {
  vm.subtotal = ko.pureComputed(sumLines);
  vm.tax = ko.pureComputed(() => r2(vm.subtotal() * num(vm.taxRate())));
  vm.total = ko.pureComputed(() => r2(vm.subtotal() + vm.tax()));
} else {
  vm.subtotal = ko.observable(0);
  vm.tax = ko.observable(0);
  vm.total = ko.observable(0);
}
function recalc() {
  if (TOTALS !== "manual") return;
  const sub = sumLines();
  const tax = r2(sub * num(vm.taxRate()));
  (vm.subtotal as ko.Observable<number>)(sub);
  (vm.tax as ko.Observable<number>)(tax);
  (vm.total as ko.Observable<number>)(r2(sub + tax));
}

// ---------------------------------------------------------------------------------------- GenClass stores
let applying = false; // a server value is being written into the observables (not a user edit)

function applyInvoice(v: Partial<Invoice> & { paid?: number }) {
  applying = true;
  try {
    if (v.id !== undefined) vm.currentId(v.id);
    if (v.number !== undefined) vm.number(v.number);
    if (v.customer !== undefined && v.customer !== vm.customer()) vm.customer(v.customer);
    if (v.taxRate !== undefined && num(v.taxRate) !== num(vm.taxRate())) vm.taxRate(String(v.taxRate));
    if (v.status !== undefined) vm.status(v.status);
    if (v.version !== undefined) vm.version(v.version);
    if (v.paid !== undefined) vm.paid(v.paid);
    if (Array.isArray(v.lines)) {
      const cur = vm.lines();
      const same = cur.length === v.lines.length && cur.every((l, i) => l.lid === v.lines![i]!.lid);
      if (same) cur.forEach((l, i) => l.assign(v.lines![i]!));
      else vm.lines(v.lines.map((l) => new LineVM(l.lid, l)));
    }
    if (TOTALS === "manual" && v.subtotal !== undefined) {
      (vm.subtotal as ko.Observable<number>)(num(v.subtotal));
      (vm.tax as ko.Observable<number>)(num(v.tax));
      (vm.total as ko.Observable<number>)(num(v.total));
    }
  } finally {
    applying = false;
  }
}
const editorJS = () => ({
  id: vm.currentId(),
  number: vm.number(),
  customer: vm.customer(),
  taxRate: num(vm.taxRate()),
  status: vm.status(),
  version: vm.version(),
  lines: vm.lines().map((l) => l.toJS()),
  subtotal: vm.subtotal(),
  tax: vm.tax(),
  total: vm.total(),
  paid: vm.paid(),
  loading: vm.loading(),
  saving: vm.saving(),
  saveState: vm.saveState(),
  error: vm.error(),
});
function guardKo<T>(name: string, read: () => T, write: (v: T) => void, resync?: () => unknown) {
  const watcher = ko.computed(read);
  return rt.guard<T>(name, { get: () => watcher.peek(), set: write, subscribe: (fn) => { const s = watcher.subscribe(() => fn()); return () => s.dispose(); } }, resync ? { resync } : {});
}
const invoice = guardKo("invoice", editorJS, (v) => {
  applyInvoice(v);
  vm.loading(v.loading);
  vm.saving(v.saving);
  vm.saveState(v.saveState);
  vm.error(v.error);
}, () => vm.currentId() && loadInvoice(vm.currentId()));
const invoices = guardKo("invoices", () => ({ items: vm.list().map((x) => ({ ...x })), loading: vm.listLoading() }), (v) => {
  vm.list(v.items);
  vm.listLoading(v.loading);
}, () => loadList());

// ------------------------------------------------------------------------------------------------- api
class HttpError extends Error {
  constructor(readonly status: number, readonly body?: any) {
    super(`HTTP ${status}`);
  }
}
async function api<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw new HttpError(r.status, data);
  return data as T;
}

async function loadList() {
  try {
    const d = await api<{ items: Invoice[] }>("/api/invoices?sort=number");
    invoices.update((s) => ({ ...s, loading: false, items: d.items.map(({ id, number, customer, total, status }) => ({ id, number, customer, total, status })) }));
  } catch {
    invoices.update((s) => ({ ...s, loading: false }));
    invoice.update((s) => ({ ...s, error: "The invoice list could not be loaded." }));
  }
}

let openSeq = 0;
async function loadInvoice(id: number) {
  const mine = ++openSeq;
  invoice.update((s) => ({ ...s, loading: true, error: "" }));
  try {
    const [inv, pays] = await Promise.all([api<Invoice>(`/api/invoices/${id}`), api<{ items: { amount: number }[] }>(`/api/payments?invoiceId=${id}`)]);
    if (SWITCH_GUARD === "token" && mine !== openSeq) return;
    const paid = r2(pays.items.reduce((s, p) => s + num(p.amount), 0));
    savedSeq = editSeq; // whatever was typed into the previous invoice has been saved or abandoned
    knownVersion = inv.version;
    conflicts = 0;
    invoice.update((s) => ({ ...s, ...inv, paid, loading: false, saveState: "" }));
  } catch {
    if (SWITCH_GUARD === "token" && mine !== openSeq) return;
    invoice.update((s) => ({ ...s, loading: false, error: "This invoice could not be opened." }));
  }
}

// --------------------------------------------------------------------------------------------- autosave
let editSeq = 0;
let savedSeq = 0;
let inflight = 0;
let again = false;
let forceNext = false;
let knownVersion = 0; // newest version this tab has seen for the open invoice
let conflicts = 0;
let pendingOpen = 0; // switch requested while the current invoice had unsaved edits
const draft = ko.pureComputed(() => ({ customer: vm.customer(), taxRate: num(vm.taxRate()), lines: vm.lines().map((l) => l.toJS()) }));
draft.subscribe(() => {
  if (!applying) editSeq++;
});
ko.pureComputed(() => draft())
  .extend({ rateLimit: { timeout: DELAY, method: "notifyWhenChangesStop" } })
  .subscribe(() => {
    if (editSeq > savedSeq) void save();
  });

async function save(): Promise<void> {
  const id = vm.currentId();
  if (!id) return;
  if (AUTOSAVE === "serial" && inflight > 0) {
    again = true;
    return;
  }
  const force = forceNext;
  forceNext = false;
  const seq = editSeq;
  const body = { ...draft(), subtotal: vm.subtotal(), tax: vm.tax(), total: vm.total(), ...(force ? {} : { version: Math.max(knownVersion, vm.version()) }) };
  inflight++;
  invoice.update((s) => ({ ...s, saving: true, saveState: "Saving…", error: "" }));
  try {
    const saved = await api<Invoice>(`/api/invoices/${id}`, "PATCH", body);
    savedSeq = Math.max(savedSeq, seq);
    conflicts = 0;
    if (vm.currentId() !== id) return;
    knownVersion = Math.max(knownVersion, saved.version);
    invoice.update((s) => (ECHO === "apply" ? { ...s, ...saved } : { ...s, version: Math.max(s.version, saved.version), status: saved.status }));
    invoices.update((l) => ({ ...l, items: l.items.map((x) => (x.id === id ? { ...x, customer: saved.customer, total: saved.total, status: saved.status } : x)) }));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 0;
    if (status === 409 && vm.currentId() === id && conflicts++ < 2) {
      const current = (e as HttpError).body?.current as Invoice | undefined;
      if (CONFLICT === "reload" && current) {
        savedSeq = editSeq;
        knownVersion = current.version;
        invoice.update((s) => ({ ...s, ...current, error: "Another user changed this invoice. Their version was loaded; your last edits were discarded." }));
      } else if (CONFLICT === "overwrite") {
        // ours is the latest edit: send it again without a version
        forceNext = true;
        again = true;
      } else if (current) {
        // rebase: take the other user's status/version, keep our draft, save again
        knownVersion = current.version;
        invoice.update((s) => ({ ...s, version: current.version, status: current.status }));
        again = true;
      }
    } else if (vm.currentId() === id) {
      invoice.update((s) => ({ ...s, error: status ? `Autosave failed (${status}). Your changes are kept and will be saved again.` : "You're offline — changes will be saved when the connection returns." }));
      setTimeout(() => {
        if (editSeq > savedSeq) void save();
      }, 3000);
    }
  } finally {
    inflight = Math.max(0, inflight - 1);
    invoice.update((s) => ({ ...s, saving: inflight > 0, saveState: inflight > 0 ? "Saving…" : editSeq > savedSeq ? "Unsaved changes" : s.error ? "" : "All changes saved" }));
    if (again && inflight === 0) {
      again = false;
      if (editSeq > savedSeq) return void save();
    }
    if (pendingOpen && inflight === 0) {
      const next = pendingOpen;
      pendingOpen = 0;
      void loadInvoice(next);
    }
  }
}

// ------------------------------------------------------------------------------------------------ actions
const actions = {
  open(row: Summary) {
    if (row.id === vm.currentId()) return;
    if (SWITCH_GUARD === "token" && (inflight > 0 || editSeq > savedSeq)) {
      // save this invoice's pending edits before opening the next one
      pendingOpen = row.id;
      invoice.update((s) => ({ ...s, saveState: "Saving before switching…" }));
      if (inflight === 0) void save();
      return;
    }
    void loadInvoice(row.id);
  },
  addLine() {
    const n = vm.lines().reduce((m, l) => Math.max(m, Number(l.lid.slice(1)) || 0), 0) + 1;
    vm.lines.push(new LineVM(`L${n}`, { desc: "", qty: 1, price: 0 }));
    recalc();
  },
  removeLine(line: LineVM) {
    vm.lines.remove(line);
  },
  async send() {
    const id = vm.currentId();
    if (!id || vm.status() === "paid") return;
    try {
      const saved = await api<Invoice>(`/api/invoices/${id}/send`, "POST", {});
      invoice.update((s) => ({ ...s, status: saved.status, version: Math.max(s.version, saved.version) }));
      invoices.update((l) => ({ ...l, items: l.items.map((x) => (x.id === id ? { ...x, status: saved.status } : x)) }));
    } catch {
      invoice.update((s) => ({ ...s, error: "The invoice could not be sent. Try again in a moment." }));
    }
  },
  async pay() {
    const id = vm.currentId();
    const due = r2(num(vm.total()) - vm.paid());
    if (!id || due <= 0 || (PAY_GUARD === "disable" && vm.paying())) return;
    vm.paying(true);
    try {
      await api(`/api/payments`, "POST", { invoiceId: id, amount: due, method: "bank transfer" });
      const pays = await api<{ items: { amount: number }[] }>(`/api/payments?invoiceId=${id}`);
      if (vm.currentId() === id) invoice.update((s) => ({ ...s, paid: r2(pays.items.reduce((t, p) => t + num(p.amount), 0)) }));
    } catch {
      invoice.update((s) => ({ ...s, error: "The payment could not be recorded." }));
    } finally {
      vm.paying(false);
    }
  },
};

// ------------------------------------------------------------------------------------------------- view
document.getElementById("app")!.innerHTML = `
  <header class="bar"><h1>Ledgerly — Invoices</h1><span class="save-state" data-bind="text: saveState"></span></header>
  <nav class="invoice-list"><h2>Invoices</h2>
    <p class="muted" data-bind="visible: listLoading">Loading invoices…</p>
    <ul data-bind="foreach: list"><li><button type="button" class="open-invoice" data-bind="click: $root.open, css: { current: id === $root.currentId() }"><span data-bind="text: number"></span> · <span data-bind="text: customer"></span> · <span data-bind="text: $root.money(total)"></span> <em data-bind="text: status"></em></button></li></ul>
  </nav>
  <section class="editor">
    <p class="muted" data-bind="visible: !currentId()">Select an invoice to edit it.</p>
    <div data-bind="visible: currentId">
      <h2>Invoice <span data-bind="text: number"></span> <small data-bind="text: status"></small> <small data-bind="visible: loading">(loading…)</small></h2>
      <label>Customer <input name="customer" data-bind="textInput: customer"></label>
      <label>Tax <select name="tax" data-bind="value: taxRate"><option value="0">No tax</option><option value="0.05">5%</option><option value="0.08">8%</option><option value="0.2">20% VAT</option></select></label>
      <table class="lines"><thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Amount</th><th></th></tr></thead>
        <tbody data-bind="foreach: lines"><tr class="line"><td><input class="desc" data-bind="textInput: desc"></td><td><input class="qty" data-bind="textInput: qty"></td><td><input class="price" data-bind="textInput: price"></td><td class="amount" data-bind="text: $root.money(amount())"></td><td><button type="button" class="remove-line" data-bind="click: $root.removeLine">Remove</button></td></tr></tbody>
      </table>
      <button type="button" class="add-line" data-bind="click: addLine">Add line</button>
      <dl class="totals"><dt>Subtotal</dt><dd data-bind="text: money(subtotal())"></dd><dt>Tax</dt><dd data-bind="text: money(tax())"></dd><dt>Total</dt><dd class="total" data-bind="text: money(total())"></dd><dt>Paid</dt><dd data-bind="text: money(paid())"></dd><dt>Balance due</dt><dd class="balance" data-bind="text: money(total() - paid())"></dd></dl>
      <button type="button" class="send" data-bind="click: send, disable: status() !== 'draft'">Send to customer</button>
      <button type="button" class="pay" data-bind="click: pay, disable: ${PAY_GUARD === "disable" ? "paying() || " : ""}total() - paid() <= 0, text: paying() ? 'Recording…' : 'Record payment'"></button>
      <div data-bind="if: error"><p role="alert" data-bind="text: error"></p></div>
    </div>
  </section>`;

ko.applyBindings({ ...vm, ...actions }, document.getElementById("app"));
void loadList().then(() => {
  const first = vm.list()[0];
  if (first) void loadInvoice(first.id);
});
