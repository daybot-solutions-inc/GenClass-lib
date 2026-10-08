// Household budget envelopes (Mithril 2 + m.request over XHR; state in a runtime atom with m.redraw). Each month has
// envelopes with a budget; expenses are logged against an envelope (POST, retried once on a gateway error) and a
// partner logs expenses too (picked up by a poll). "Move £20" shifts budget from an envelope to the next one (two
// PATCHes). Latent bugs by flag: per-envelope spent totals cached and bumped only by our own expenses
// (spent=cached), the Add button live while posting (addGuard=none), retries without an Idempotency-Key
// (retryKey=none), budget moves that don't undo the first half when the second fails (transfer=none) and month loads
// applied in arrival order (monthSeq=blind).
import m from "mithril";
import { rt, flag } from "../_shared/genclass";

type Env = { id: number; month: string; name: string; budget: number };
type Exp = { id: number; month: string; envelopeId: number; note: string; amount: number };
const SPENT = flag("spent", "derive");
const ADD_GUARD = flag("addGuard", "disable") === "disable";
const RETRY_KEY = flag("retryKey", "idempotency-key");
const TRANSFER = flag("transfer", "compensate");
const MONTH_SEQ = flag("monthSeq", "latest");

const budget = rt.atom("budget", { month: "2026-10", envelopes: [] as Env[], expenses: [] as Exp[], spent: {} as Record<number, number>, envelope: "Groceries", amount: "", adding: false, loading: true, error: "", notice: "" });
type B = ReturnType<typeof budget.get>;
budget.subscribe(() => m.redraw());
const r2 = (n: number) => Math.round(n * 100) / 100;
const spentOf = (xs: Exp[]) => xs.reduce<Record<number, number>>((a, x) => ((a[x.envelopeId] = r2((a[x.envelopeId] ?? 0) + Number(x.amount))), a), {});
const code = (e: any) => Number(e?.code ?? 0);
const fail = (e: any, what: string) => (code(e) ? `${what} failed (${code(e)}).` : `Offline — ${what} did not go through.`);

let seq = 0;
async function loadMonth(month: string, background = false) {
  const my = background ? seq : ++seq;
  if (!background) budget.update((b) => ({ ...b, month, loading: true, error: "" }));
  try {
    const [envs, exps] = await Promise.all([m.request<{ items: Env[] }>({ url: "/api/envelopes", params: { month }, background: true }), m.request<{ items: Exp[] }>({ url: "/api/expenses", params: { month, limit: 100 }, background: true })]);
    if ((MONTH_SEQ === "latest" || background) && (my !== seq || budget.get().month !== month)) return;
    budget.update((b) => ({ ...b, envelopes: envs.items ?? [], expenses: exps.items ?? [], spent: SPENT === "derive" || !background ? spentOf(exps.items ?? []) : b.spent, loading: false }));
  } catch (e) {
    if (!background && my === seq) budget.update((b) => ({ ...b, loading: false, error: fail(e, "Loading the month") }));
  }
}

async function addExpense() {
  const b0 = budget.get();
  if (ADD_GUARD && b0.adding) return;
  const amount = r2(parseFloat(b0.amount.replace(/[£,]/g, "")));
  const env = b0.envelopes.find((e) => e.name === b0.envelope);
  if (!env || !(amount > 0)) return budget.update((b) => ({ ...b, error: "Enter an amount greater than zero." }));
  budget.update((b) => ({ ...b, adding: true, error: "", notice: "" }));
  const key = RETRY_KEY === "idempotency-key" ? `exp-${env.id}-${amount}-${Date.now()}` : "";
  const post = () => m.request<Exp>({ method: "POST", url: "/api/expenses", body: { month: b0.month, envelopeId: env.id, note: `${env.name} purchase`, amount }, headers: key ? { "Idempotency-Key": key } : {}, background: true });
  try {
    const x = await post().catch((e) => (code(e) >= 502 && code(e) <= 504 ? post() : Promise.reject(e)));
    budget.update((b) => {
      if (b.month !== x.month) return b;
      const expenses = [...b.expenses.filter((y) => y.id !== x.id), x];
      return { ...b, expenses, spent: SPENT === "derive" ? spentOf(expenses) : { ...b.spent, [x.envelopeId]: r2((b.spent[x.envelopeId] ?? 0) + amount) }, amount: "", notice: `£${amount.toFixed(2)} logged to ${env.name}.` };
    });
  } catch (e) {
    budget.update((b) => ({ ...b, error: fail(e, "Logging the expense") }));
  } finally {
    budget.update((b) => ({ ...b, adding: false }));
  }
}

async function move(from: Env) {
  const envs = budget.get().envelopes;
  const to = envs[(envs.findIndex((e) => e.id === from.id) + 1) % envs.length];
  if (!to || to.id === from.id || from.budget < 20) return;
  const put = (e: Env, budget: number) => m.request<Env>({ method: "PATCH", url: `/api/envelopes/${e.id}`, body: { budget }, background: true });
  const apply = (e: Env) => budget.update((b) => ({ ...b, envelopes: b.envelopes.map((x) => (x.id === e.id ? e : x)) }));
  try {
    apply(await put(from, from.budget - 20));
    try {
      apply(await put(to, to.budget + 20));
      budget.update((b) => ({ ...b, notice: `Moved £20 from ${from.name} to ${to.name}.`, error: "" }));
    } catch (e) {
      if (TRANSFER === "compensate") apply(await put(from, from.budget).catch(() => ({ ...from })));
      budget.update((b) => ({ ...b, error: fail(e, `Moving £20 to ${to.name}`) }));
    }
  } catch (e) {
    budget.update((b) => ({ ...b, error: fail(e, `Moving £20 from ${from.name}`) }));
  }
}

const App = {
  view() {
    const b = budget.get();
    const total = b.envelopes.reduce((a, e) => a + e.budget, 0);
    return m(".envelopes", [
      m("h1", "Budget envelopes"),
      m("label", ["Month ", m("select[name=month]", { onchange: (e: Event) => void loadMonth((e.target as HTMLSelectElement).value) }, ["2026-09", "2026-10"].map((x) => m("option", { value: x, selected: x === b.month }, x)))]),
      m("p.total", `Budgeted £${total} · spent £${r2(Object.values(b.spent).reduce((a, x) => a + x, 0)).toFixed(2)}`),
      b.loading ? m("p.muted", "Loading…") : null,
      b.error ? m("p[role=alert]", b.error) : b.notice ? m("p.notice", b.notice) : null,
      m("ul", b.envelopes.map((e) => m("li.env", { key: e.id }, [m("strong", e.name), ` £${(b.spent[e.id] ?? 0).toFixed(2)} of £${e.budget} `, m("button.move", { onclick: () => void move(e) }, "Move £20 →")]))),
      m("form.expense", { onsubmit: (ev: Event) => (ev.preventDefault(), void addExpense()) }, [
        m("select[name=envelope]", { onchange: (ev: Event) => budget.update((x) => ({ ...x, envelope: (ev.target as HTMLSelectElement).value })) }, b.envelopes.map((e) => m("option", { value: e.name, selected: e.name === b.envelope }, e.name))),
        m("input[name=amount][inputmode=decimal][placeholder=Amount]", { value: b.amount, oninput: (ev: Event) => budget.update((x) => ({ ...x, amount: (ev.target as HTMLInputElement).value })) }),
        m("button[type=submit]", { disabled: ADD_GUARD && b.adding }, b.adding ? "Adding…" : "Log expense"),
      ]),
    ]);
  },
};

m.mount(document.getElementById("app")!, App);
void loadMonth("2026-10");
setInterval(() => void loadMonth(budget.get().month, true), 5000);
