// General journal for a small bakery (Mithril 2: hyperscript views, m.request over XHR, m.redraw; state in runtime
// atoms). Each journal entry debits one account and credits another by the same amount; the trial balance and the
// debit/credit totals are kept in the ledger store. The journal is polled so a second bookkeeper's entries appear.
// Latent bugs by flag: "Post entry" not locked while posting (submitGuard=none: a double click books the entry twice;
// submitGuard=idem-key relies on the server replaying instead), totals kept as running sums that are only computed on
// the first load and bumped on every echo even when the poll already brought that entry (totals=incremental), poll
// results applied while a post or void is still in flight (poll=blind: the entry blinks out and back in).
import m from "mithril";
import { rt, flag } from "../_shared/genclass";

type Entry = { id: number; memo: string; debit: string; credit: string; amount: number; voided?: boolean; createdAt?: string };
type Totals = { totalDebits: number; totalCredits: number; balances: Record<string, number> };

const SUBMIT_GUARD = flag("submitGuard", "disable") as "disable" | "none" | "idem-key";
const TOTALS = flag("totals", "recompute") as "recompute" | "incremental";
const POLL = flag("poll", "skip-while-busy") as "skip-while-busy" | "blind";
const POLL_MS = 6000;

const ACCOUNTS: [string, string][] = [
  ["1000", "Cash"],
  ["1100", "Accounts receivable"],
  ["1200", "Inventory"],
  ["2000", "Accounts payable"],
  ["3000", "Owner's equity"],
  ["4000", "Sales revenue"],
  ["5100", "Rent expense"],
  ["5200", "Supplies expense"],
  ["5300", "Wages expense"],
];
const nameOf = (code: string) => ACCOUNTS.find(([c]) => c === code)?.[1] ?? code;
const cents = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;

function totalsOf(entries: Entry[]): Totals {
  const balances: Record<string, number> = {};
  let sum = 0;
  for (const e of entries) {
    if (e.voided) continue;
    const a = Number(e.amount) || 0;
    sum += a;
    balances[e.debit] = cents((balances[e.debit] ?? 0) + a);
    balances[e.credit] = cents((balances[e.credit] ?? 0) - a);
  }
  return { totalDebits: cents(sum), totalCredits: cents(sum), balances };
}
function shift(t: Totals, e: Entry, sign: 1 | -1): Totals {
  const a = sign * (Number(e.amount) || 0);
  const balances = { ...t.balances, [e.debit]: cents((t.balances[e.debit] ?? 0) + a), [e.credit]: cents((t.balances[e.credit] ?? 0) - a) };
  return { totalDebits: cents(t.totalDebits + a), totalCredits: cents(t.totalCredits + a), balances };
}

const ledger = rt.atom("ledger", { entries: [] as Entry[], totalDebits: 0, totalCredits: 0, balances: {} as Record<string, number>, loaded: false, posting: false, notice: "", error: "" });
const journal = rt.atom("journal", { memo: "", amount: "", debit: "5200", credit: "1000", error: "" });

let posting = 0;
let voiding = 0;
let writesSent = 0;
let postKey: string | null = null;

// ------------------------------------------------------------------------------------------------ server
async function load(first = false) {
  const sent = writesSent;
  try {
    const body = await m.request<{ items: Entry[] }>({ method: "GET", url: "/api/entries", params: { limit: 50, sort: "-createdAt" }, background: !first });
    if (!first && POLL === "skip-while-busy" && (posting > 0 || voiding > 0 || sent !== writesSent)) return; // a write is on its way; next tick
    const items = Array.isArray(body.items) ? body.items : [];
    ledger.update((l) => ({ ...l, entries: items, ...(TOTALS === "recompute" || !l.loaded ? totalsOf(items) : {}), loaded: true, error: first ? "" : l.error }));
  } catch {
    if (first) ledger.update((l) => ({ ...l, error: "The journal couldn't be loaded. Retrying shortly." }));
  }
}

function setField(k: "memo" | "amount" | "debit" | "credit", v: string) {
  journal.update((j) => ({ ...j, [k]: v, error: "" }));
}

async function post() {
  const j = journal.get();
  const amount = cents(parseFloat(j.amount.replace(/[$,]/g, "")));
  if (!j.memo.trim() || !(amount > 0)) return journal.update((x) => ({ ...x, error: "Enter a memo and an amount greater than zero." }));
  if (j.debit === j.credit) return journal.update((x) => ({ ...x, error: "Debit and credit must be different accounts." }));
  if (SUBMIT_GUARD === "disable" && posting > 0) return;
  const key = SUBMIT_GUARD === "idem-key" ? (postKey ??= crypto.randomUUID()) : null;
  posting++;
  writesSent++;
  ledger.update((l) => ({ ...l, posting: true, notice: "", error: "" }));
  try {
    const saved = await m.request<Entry>({ method: "POST", url: "/api/entries", body: { memo: j.memo.trim(), debit: j.debit, credit: j.credit, amount, voided: false }, headers: key ? { "Idempotency-Key": key } : {} });
    postKey = null;
    journal.update((x) => ({ ...x, memo: "", amount: "", error: "" }));
    ledger.update((l) => {
      const have = l.entries.some((e) => e.id === saved.id);
      const entries = have ? l.entries : [saved, ...l.entries];
      const totals = TOTALS === "recompute" ? totalsOf(entries) : shift(l, saved, 1);
      return { ...l, entries, ...totals, notice: `Posted “${saved.memo}” for ${usd(Number(saved.amount))}.` };
    });
  } catch {
    ledger.update((l) => ({ ...l, error: "The entry wasn't posted. Check the journal before trying again." }));
  } finally {
    posting--;
    ledger.update((l) => ({ ...l, posting: posting > 0 }));
  }
}

const voidingIds = new Set<number>();
async function voidEntry(e: Entry) {
  if (e.voided || (SUBMIT_GUARD === "disable" && voidingIds.has(e.id))) return;
  voidingIds.add(e.id);
  voiding++;
  writesSent++;
  ledger.update((l) => ({ ...l, notice: "", error: "" }));
  try {
    const saved = await m.request<Entry>({ method: "POST", url: `/api/entries/${e.id}/void` });
    ledger.update((l) => {
      const entries = l.entries.map((x) => (x.id === saved.id ? { ...x, ...saved } : x));
      const totals = TOTALS === "recompute" ? totalsOf(entries) : shift(l, saved, -1);
      return { ...l, entries, ...totals, notice: `Voided “${saved.memo}”.` };
    });
  } catch {
    ledger.update((l) => ({ ...l, error: `Couldn't void “${e.memo}”.` }));
  } finally {
    voiding--;
    voidingIds.delete(e.id);
  }
}

// --------------------------------------------------------------------------------------------------- views
const field = (k: "memo" | "amount") => (ev: Event) => setField(k, (ev.target as HTMLInputElement).value);
const pickAcct = (k: "debit" | "credit") => (ev: Event) => setField(k, (ev.target as HTMLSelectElement).value);
const options = (sel: string) => ACCOUNTS.map(([code, name]) => m("option", { value: code, selected: code === sel }, `${code} ${name}`));
const day = (iso?: string) => (iso ? iso.slice(5, 10) : "—");

const EntryForm: m.Component = {
  view: () => {
    const j = journal.get();
    const busy = ledger.get().posting;
    return m("form.entry", { onsubmit: (e: Event) => (e.preventDefault(), void post()) }, [
      m("label", ["Memo ", m("input[name=memo][autocomplete=off]", { value: j.memo, oninput: field("memo") })]),
      m("label", ["Amount ", m("input[name=amount][inputmode=decimal]", { value: j.amount, oninput: field("amount") })]),
      m("label", ["Debit ", m("select[name=debit]", { onchange: pickAcct("debit") }, options(j.debit))]),
      m("label", ["Credit ", m("select[name=credit]", { onchange: pickAcct("credit") }, options(j.credit))]),
      m("button.post[type=submit]", { disabled: SUBMIT_GUARD === "disable" && busy }, busy ? "Posting…" : "Post entry"),
      j.error ? m("p.form-error[role=alert]", j.error) : null,
    ]);
  },
};

const Journal: m.Component = {
  view: () => {
    const l = ledger.get();
    return m("section.journal", [
      m("h2", ["Journal ", m("button.refresh", { onclick: () => void load() }, "Refresh")]),
      !l.loaded && !l.error ? m("p", "Loading entries…") : null,
      m(
        "table",
        m("tbody", [
          m("tr", [m("th", "Date"), m("th", "Memo"), m("th", "Debit"), m("th", "Credit"), m("th", "Amount"), m("th", "")]),
          ...l.entries.map((e) =>
            m("tr.entry", { key: e.id, class: e.voided ? "voided" : "" }, [
              m("td", day(e.createdAt)),
              m("td", e.memo),
              m("td", nameOf(e.debit)),
              m("td", nameOf(e.credit)),
              m("td", usd(Number(e.amount))),
              m("td", e.voided ? "void" : m("button.void", { disabled: SUBMIT_GUARD === "disable" && voidingIds.has(e.id), onclick: () => void voidEntry(e) }, "Void")),
            ]),
          ),
        ]),
      ),
    ]);
  },
};

const TrialBalance: m.Component = {
  view: () => {
    const l = ledger.get();
    return m("section.trial", [
      m("h2", "Trial balance"),
      m(
        "ul",
        ACCOUNTS.filter(([c]) => (l.balances[c] ?? 0) !== 0).map(([c, name]) => m("li.balance", `${c} ${name}: ${(l.balances[c] ?? 0) > 0 ? "Dr" : "Cr"} ${usd(Math.abs(l.balances[c] ?? 0))}`)),
      ),
      m("p.totals", `Debits ${usd(l.totalDebits)} · Credits ${usd(l.totalCredits)}${Math.abs(l.totalDebits - l.totalCredits) > 0.005 ? " · OUT OF BALANCE" : ""}`),
    ]);
  },
};

const App: m.Component = {
  view: () => {
    const l = ledger.get();
    return m("main.ledger", [
      m("header", [m("h1", "General journal"), m("p.period", "Harbour Street Bakery · April 2026")]),
      m(EntryForm),
      l.error ? m("p[role=alert]", l.error) : null,
      l.notice ? m("p.notice", l.notice) : null,
      m(Journal),
      m(TrialBalance),
    ]);
  },
};

m.mount(document.getElementById("app")!, App);
ledger.subscribe(() => m.redraw());
journal.subscribe(() => m.redraw());
void load(true);
setInterval(() => void load(), POLL_MS);
