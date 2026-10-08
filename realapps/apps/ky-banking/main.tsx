// Online banking transfers (React 19 + ky over fetch: prefixUrl, timeout, retry, beforeRequest/beforeRetry hooks;
// state in a GenClass atom read with useAtom). Balances are the opening balance plus the account's transfers; the
// activity list is refreshed every 15 s. A transfer is reviewed, then confirmed with a POST. Latent bugs by flag:
// ky configured to retry POSTs, including after a timeout (retry=post-on-timeout), with no Idempotency-Key
// (idemKey=none), so a slow or failed-after-commit transfer is sent twice; balances derived locally after a
// transfer and not recomputed when the refresh brings in transfers the client did not make (balance=derive); a
// Confirm button that stays enabled while the transfer is being sent (confirmGuard=none).
import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import ky, { HTTPError } from "ky";
import { useAtom } from "@genclass/runtime/react";
import { rt, flag } from "../_shared/genclass";

type Account = { id: string; name: string; opening: number; balance: number };
type Payee = { id: string; name: string };
type Transfer = { id: number; from: string; to: string; amount: number; memo: string; date: string };
type Review = { key: string; from: string; to: string; amount: number; memo: string };
interface Bank {
  accounts: Account[];
  payees: Payee[];
  transfers: Transfer[];
  form: { from: string; to: string; amount: string; memo: string };
  review: Review | null;
  sending: boolean;
  retrying: number;
  notice: string;
  error: string;
}

const RETRY = flag("retry", "get-only") as "get-only" | "post-on-timeout";
const IDEM = flag("idemKey", "per-review") as "per-review" | "none";
const BALANCE = flag("balance", "refetch") as "refetch" | "derive";
const CONFIRM_GUARD = flag("confirmGuard", "disable") as "disable" | "none";

const bank = rt.atom<Bank>("bank", { accounts: [], payees: [], transfers: [], form: { from: "chk", to: "sav", amount: "", memo: "" }, review: null, sending: false, retrying: 0, notice: "", error: "" });

const api = ky.create({
  prefixUrl: "/api",
  timeout: 3500,
  retry: RETRY === "get-only" ? { limit: 2, methods: ["get"] } : { limit: 2, methods: ["get", "post"], retryOnTimeout: true },
  hooks: {
    beforeRequest: [(req) => void req.headers.set("X-Client", "bank-web/4.1")],
    beforeRetry: [({ request, retryCount }) => void (request.method === "POST" && bank.update((b) => ({ ...b, retrying: retryCount })))],
  },
});

const euros = (c: number) => `€${(c / 100).toFixed(2)}`;
function withBalances(accounts: Account[], transfers: Transfer[]): Account[] {
  return accounts.map((a) => ({ ...a, balance: transfers.reduce((x, t) => x + (t.to === a.id ? t.amount : 0) - (t.from === a.id ? t.amount : 0), a.opening) }));
}
const nameOf = (b: Bank, id: string) => (id === "ext" ? "External" : b.accounts.find((a) => a.id === id)?.name ?? b.payees.find((p) => p.id === id)?.name ?? id);

// --------------------------------------------------------------------------------------------- requests
async function loadAll() {
  try {
    const [accounts, payees, page] = await Promise.all([api.get("accounts").json<Account[]>(), api.get("payees").json<Payee[]>(), api.get("transfers", { searchParams: { limit: 200 } }).json<{ items: Transfer[] }>()]);
    bank.update((b) => ({ ...b, payees, transfers: page.items, accounts: withBalances(accounts, page.items) }));
  } catch {
    bank.update((b) => ({ ...b, error: "Your accounts could not be loaded" }));
  }
}

async function refreshActivity() {
  try {
    const page = await api.get("transfers", { searchParams: { limit: 200 } }).json<{ items: Transfer[] }>();
    // derive: balances are kept up to date by our own transfers, so only the list is replaced
    bank.update((b) => ({ ...b, transfers: page.items, accounts: BALANCE === "refetch" ? withBalances(b.accounts, page.items) : b.accounts, error: b.error.startsWith("Activity") ? "" : b.error }));
  } catch {
    bank.update((b) => ({ ...b, error: "Activity could not be refreshed" }));
  }
}

function startReview() {
  const b = bank.get();
  const amount = Math.round(parseFloat(b.form.amount.replace(",", ".")) * 100);
  if (!Number.isFinite(amount) || amount <= 0) return bank.set({ ...b, error: "Enter an amount" });
  if (b.form.from === b.form.to) return bank.set({ ...b, error: "Pick two different accounts" });
  const from = b.accounts.find((a) => a.id === b.form.from);
  if (from && from.balance < amount) return bank.set({ ...b, error: `Insufficient funds in ${from.name}` });
  bank.set({ ...b, error: "", notice: "", review: { key: IDEM === "per-review" ? crypto.randomUUID() : "", from: b.form.from, to: b.form.to, amount, memo: b.form.memo.trim() || "Transfer" } });
}

async function confirmTransfer() {
  const b0 = bank.get();
  const r = b0.review;
  if (!r || (CONFIRM_GUARD === "disable" && b0.sending)) return;
  bank.set({ ...b0, sending: true, retrying: 0, error: "" });
  try {
    const t = await api.post("transfers", { json: { from: r.from, to: r.to, amount: r.amount, memo: r.memo, date: "2026-04-01" }, headers: r.key ? { "Idempotency-Key": r.key } : {} }).json<Transfer>();
    bank.update((b) => {
      const transfers = b.transfers.some((x) => x.id === t.id) ? b.transfers : [...b.transfers, t];
      const accounts =
        BALANCE === "derive"
          ? b.accounts.map((a) => (a.id === t.from ? { ...a, balance: a.balance - t.amount } : a.id === t.to ? { ...a, balance: a.balance + t.amount } : a))
          : withBalances(b.accounts, transfers);
      return { ...b, transfers, accounts, sending: false, review: b.review?.key === r.key ? null : b.review, form: { ...b.form, amount: "" }, notice: `Sent ${euros(t.amount)} to ${nameOf(b, t.to)}` };
    });
    if (BALANCE === "refetch") void refreshActivity();
  } catch (e) {
    const timeout = (e as Error).name === "TimeoutError";
    const status = e instanceof HTTPError ? e.response.status : 0;
    bank.update((b) => ({ ...b, sending: false, error: timeout ? "We could not confirm the transfer in time. Check your activity before trying again." : status === 422 ? "The transfer was rejected" : "The transfer failed, please try again" }));
  }
}

// --------------------------------------------------------------------------------------------------- UI
function App() {
  const [b, setB] = useAtom(bank);
  useEffect(() => {
    void loadAll();
    const h = setInterval(() => void refreshActivity(), 15000);
    return () => clearInterval(h);
  }, []);
  const setForm = (patch: Partial<Bank["form"]>) => setB((x) => ({ ...x, form: { ...x.form, ...patch }, review: null }));
  return (
    <main className="bank">
      <h1>Accounts</h1>
      <ul className="accounts">
        {b.accounts.map((a) => (
          <li key={a.id} className="account">
            {a.name} · {euros(a.balance)}
          </li>
        ))}
      </ul>
      {b.error && <p role="alert">{b.error}</p>}
      {b.notice && <p className="notice">{b.notice}</p>}
      <section className="transfer">
        <h2>Move money</h2>
        <select name="from" value={b.form.from} onChange={(e) => setForm({ from: e.target.value })}>
          {b.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select name="to" value={b.form.to} onChange={(e) => setForm({ to: e.target.value })}>
          {[...b.accounts, ...b.payees].map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <input name="amount" value={b.form.amount} onChange={(e) => setForm({ amount: e.target.value })} placeholder="0.00" inputMode="decimal" />
        <input name="memo" value={b.form.memo} onChange={(e) => setForm({ memo: e.target.value })} placeholder="Reference" />
        <button className="review" onClick={startReview}>
          Review transfer
        </button>
      </section>
      {b.review && (
        <section className="review-panel">
          <p>
            Send {euros(b.review.amount)} from {nameOf(b, b.review.from)} to {nameOf(b, b.review.to)} · “{b.review.memo}”
          </p>
          {b.sending && <p className="sending">Sending…{b.retrying > 0 && ` (retry ${b.retrying})`}</p>}
          <button className="confirm" disabled={CONFIRM_GUARD === "disable" && b.sending} onClick={() => void confirmTransfer()}>
            Confirm transfer
          </button>
          <button className="cancel" disabled={b.sending} onClick={() => setB((x) => ({ ...x, review: null }))}>
            Cancel
          </button>
        </section>
      )}
      <section className="activity">
        <h2>
          Recent activity <button className="refresh" onClick={() => void refreshActivity()}>Refresh</button>
        </h2>
        <ul>
          {[...b.transfers].reverse().slice(0, 8).map((t) => (
            <li key={t.id} className="tx">
              {t.date} · {t.memo} · {nameOf(b, t.from)} → {nameOf(b, t.to)} · {euros(t.amount)}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
