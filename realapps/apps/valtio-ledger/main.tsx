// Household expense ledger (React 19 + Valtio proxy state, immer for the async updates, fetch). The Valtio proxy is
// registered with rt.guard (snapshot / subscribe): server responses are written through the guarded handle, form
// typing mutates the proxy directly (traced only). Category totals and the grand total are fields the code keeps up
// to date. Importing a bank statement posts each line; some fail under load. Latent bugs by flag: totals adjusted
// by deltas, forgetting to move an amount when an expense is recategorised or to give it back when a delete is
// rolled back (totals=incremental), an import that fails as a whole although some lines were saved, whose retry
// then posts every line again (importMode=all), double imports (importGuard=none), a background refresh that
// started before a local write lands over it (refresh=blind).
import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import { proxy, snapshot, subscribe, useSnapshot } from "valtio";
import { produce } from "immer";
import { rt, flag } from "../_shared/genclass";

type Cat = "groceries" | "rent" | "transport" | "dining" | "utilities" | "fun";
type Entry = { id: number | string; date: string; desc: string; category: Cat; amount: number; pending?: boolean };
type Line = Omit<Entry, "id">;
interface Ledger {
  entries: Entry[];
  byCategory: Record<string, number>;
  total: number;
  filter: string;
  draft: { desc: string; amount: string; category: Cat };
  importing: boolean;
  failedLines: Line[];
  saving: number;
  error: string;
}

const TOTALS = flag("totals", "recompute") as "recompute" | "incremental";
const IMPORT_MODE = flag("importMode", "settled") as "settled" | "all";
const IMPORT_GUARD = flag("importGuard", "disable") as "disable" | "none";
const REFRESH = flag("refresh", "skip-if-pending") as "skip-if-pending" | "blind";
const CATS: Cat[] = ["groceries", "rent", "transport", "dining", "utilities", "fun"];
const STATEMENT: Line[] = [
  { date: "2026-03-20", desc: "Card: Bakery Lux", category: "groceries", amount: 640 },
  { date: "2026-03-21", desc: "Card: Uber", category: "transport", amount: 1830 },
  { date: "2026-03-22", desc: "Card: Gym membership", category: "fun", amount: 3500 },
  { date: "2026-03-23", desc: "Card: Electricity", category: "utilities", amount: 7220 },
  { date: "2026-03-24", desc: "Card: Ramen bar", category: "dining", amount: 2600 },
  { date: "2026-03-25", desc: "Card: Corner shop", category: "groceries", amount: 915 },
];

const state = proxy<Ledger>({ entries: [], byCategory: {}, total: 0, filter: "all", draft: { desc: "", amount: "", category: "groceries" }, importing: false, failedLines: [], saving: 0, error: "" });
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const ledger = rt.guard<Ledger>("ledger", {
  get: () => snapshot(state) as Ledger,
  set: (v) => void Object.assign(state, clone(v)),
  subscribe: (fn) => subscribe(state, () => fn()),
});
/** Immer-style update through GenClass. */
const commit = (fn: (d: Ledger) => void) => ledger.update((s) => produce(s, fn));

const euros = (cents: number) => `€${(cents / 100).toFixed(2)}`;

function recount(d: Ledger) {
  d.total = d.entries.reduce((a, e) => a + e.amount, 0);
  d.byCategory = Object.fromEntries(CATS.map((c) => [c, d.entries.filter((e) => e.category === c).reduce((a, e) => a + e.amount, 0)]));
}
/** Totals after `entries` changed by +amount in category `cat` (or a recount). */
function adjust(d: Ledger, cat: Cat, amount: number) {
  if (TOTALS === "recompute") return recount(d);
  d.total += amount;
  d.byCategory[cat] = (d.byCategory[cat] ?? 0) + amount;
}

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (r.status === 204 ? null : await r.json()) as T;
}

// ---------------------------------------------------------------------------------------------- effects
let writes = 0;
let tmp = 0;

async function load() {
  const started = writes;
  try {
    const r = await http<{ data: Entry[] }>("/api/expenses?limit=200&sort=date");
    if (REFRESH === "skip-if-pending" && (ledger.get().saving > 0 || ledger.get().importing || writes !== started)) return;
    commit((d) => {
      d.entries = r.data;
      recount(d);
      if (d.error.startsWith("Could not load")) d.error = "";
    });
  } catch {
    commit((d) => void (d.error = "Could not load the ledger"));
  }
}

async function post(line: Line): Promise<Entry> {
  return http<Entry>("/api/expenses", { method: "POST", body: JSON.stringify(line) });
}

async function addExpense() {
  const dr = state.draft;
  const amount = Math.round(parseFloat(dr.amount.replace(",", ".")) * 100);
  if (!dr.desc.trim() || !Number.isFinite(amount) || amount <= 0) return;
  const line: Line = { date: "2026-03-30", desc: dr.desc.trim(), category: dr.category, amount };
  const tempId = `tmp-${++tmp}`;
  writes++;
  commit((d) => {
    d.entries.push({ ...line, id: tempId, pending: true });
    adjust(d, line.category, amount);
    d.draft.desc = "";
    d.draft.amount = "";
    d.saving++;
  });
  try {
    const saved = await post(line);
    commit((d) => {
      const i = d.entries.findIndex((e) => e.id === tempId);
      if (i >= 0) d.entries[i] = saved;
      else if (!d.entries.some((e) => e.id === saved.id)) {
        d.entries.push(saved);
        adjust(d, saved.category, saved.amount);
      }
      d.saving--;
    });
  } catch {
    commit((d) => {
      const i = d.entries.findIndex((e) => e.id === tempId);
      if (i >= 0) {
        d.entries.splice(i, 1);
        adjust(d, line.category, -amount);
      }
      d.saving--;
      d.error = `Could not save “${line.desc}”`;
    });
  }
}

async function removeEntry(e: Entry) {
  if (typeof e.id === "string") return;
  writes++;
  commit((d) => {
    d.entries = d.entries.filter((x) => x.id !== e.id);
    adjust(d, e.category, -e.amount);
    d.saving++;
  });
  try {
    await http(`/api/expenses/${e.id}`, { method: "DELETE" });
    commit((d) => void d.saving--);
  } catch (err) {
    commit((d) => {
      d.saving--;
      if ((err as Error).message === "HTTP 404" || d.entries.some((x) => x.id === e.id)) return;
      d.entries.push(e);
      // the rollback restores the row; the incremental path only fixes the grand total
      if (TOTALS === "recompute") recount(d);
      else d.total += e.amount;
      d.error = `Could not delete “${e.desc}”`;
    });
  }
}

async function recategorize(e: Entry, category: Cat) {
  if (typeof e.id === "string" || e.category === category) return;
  writes++;
  commit((d) => {
    const x = d.entries.find((y) => y.id === e.id);
    if (x) x.category = category;
    // moving an expense between categories keeps the grand total, so the incremental path changes nothing
    if (TOTALS === "recompute") recount(d);
    d.saving++;
  });
  try {
    await http<Entry>(`/api/expenses/${e.id}`, { method: "PATCH", body: JSON.stringify({ category }) });
    commit((d) => void d.saving--);
  } catch {
    commit((d) => {
      const x = d.entries.find((y) => y.id === e.id);
      if (x && x.category === category) x.category = e.category;
      if (TOTALS === "recompute") recount(d);
      d.saving--;
      d.error = `Could not move “${e.desc}” to ${category}`;
    });
  }
}

async function importLines(lines: Line[]) {
  if (IMPORT_GUARD === "disable" && state.importing) return;
  writes++;
  commit((d) => {
    d.importing = true;
    d.failedLines = [];
    d.error = "";
  });
  if (IMPORT_MODE === "all") {
    try {
      const saved = await Promise.all(lines.map(post));
      commit((d) => {
        for (const s of saved) if (!d.entries.some((e) => e.id === s.id)) (d.entries.push(s), adjust(d, s.category, s.amount));
        d.importing = false;
      });
    } catch {
      commit((d) => {
        d.importing = false;
        d.failedLines = lines;
        d.error = "Import failed, nothing was imported";
      });
    }
    return;
  }
  const results = await Promise.allSettled(lines.map(post));
  commit((d) => {
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        if (!d.entries.some((e) => e.id === r.value.id)) (d.entries.push(r.value), adjust(d, r.value.category, r.value.amount));
      } else d.failedLines.push(lines[i]!);
    });
    d.importing = false;
    if (d.failedLines.length) d.error = `${d.failedLines.length} of ${lines.length} statement lines failed`;
  });
}

// --------------------------------------------------------------------------------------------------- UI
function Ledger() {
  const s = useSnapshot(state);
  useEffect(() => {
    void load();
    const h = setInterval(() => void load(), 12000);
    return () => clearInterval(h);
  }, []);
  const shown = s.entries.filter((e) => s.filter === "all" || e.category === s.filter);
  return (
    <main className="ledger">
      <h1>Household ledger · March</h1>
      <p className="total">Total spent {euros(s.total)}</p>
      <ul className="categories">
        {CATS.map((c) => (
          <li key={c}>
            {c} {euros(s.byCategory[c] ?? 0)}
          </li>
        ))}
      </ul>
      {s.error && (
        <p role="alert">
          {s.error} <button onClick={() => void (state.error = "")}>Dismiss</button>
        </p>
      )}
      <form
        className="add"
        onSubmit={(e) => {
          e.preventDefault();
          void addExpense();
        }}
      >
        <input name="desc" value={s.draft.desc} onChange={(e) => void (state.draft.desc = e.target.value)} placeholder="What was it?" />
        <input name="amount" value={s.draft.amount} onChange={(e) => void (state.draft.amount = e.target.value)} placeholder="0.00" inputMode="decimal" />
        <select name="category" value={s.draft.category} onChange={(e) => void (state.draft.category = e.target.value as Cat)}>
          {CATS.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <button className="add" type="submit">
          Add expense
        </button>
      </form>
      <p className="import-bar">
        <button className="import" disabled={IMPORT_GUARD === "disable" && s.importing} onClick={() => void importLines(STATEMENT)}>
          {s.importing ? "Importing…" : "Import March statement"}
        </button>
        {s.failedLines.length > 0 && !s.importing && (
          <button className="retry-import" onClick={() => void importLines(clone(state.failedLines) as Line[])}>
            Retry {s.failedLines.length} lines
          </button>
        )}
      </p>
      <label>
        Show{" "}
        <select name="filter" value={s.filter} onChange={(e) => void (state.filter = e.target.value)}>
          {["all", ...CATS].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <ul className="entries">
        {shown.map((e) => (
          <li key={e.id} className={e.pending ? "entry pending" : "entry"}>
            {e.date} {e.desc} · {euros(e.amount)}{" "}
            <select className="recat" value={e.category} disabled={!!e.pending} onChange={(ev) => void recategorize(e as Entry, ev.target.value as Cat)}>
              {CATS.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>{" "}
            <button className="delete" disabled={!!e.pending} onClick={() => void removeEntry(e as Entry)}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<Ledger />);
