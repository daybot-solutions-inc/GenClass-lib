// Payroll approvals (React 19 + Redux Toolkit createSlice/createAsyncThunk + axios; store through genclassEnhancer).
// A manager reviews a pay period's timesheets, approves or rejects each one (versioned PATCH) or approves every
// submitted sheet; supervisors keep adjusting hours. Latent bugs by flag: period loads applied whatever period is
// selected now (periodGuard=none), approve buttons live while the PATCH is in flight (approveGuard=none), conflicts
// "resolved" by re-sending without the version (conflict=force: approves hours the manager never saw) and an
// approved total stored in the slice and adjusted only by our own approvals (total=stored).
import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import { configureStore, createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { Provider, useDispatch, useSelector } from "react-redux";
import axios from "axios";
import { genclassEnhancer } from "@genclass/runtime/redux";
import { rt, flag } from "../_shared/genclass";

type Sheet = { id: number; period: string; name: string; team: string; rate: number; hours: number; status: string; version: number };
const PERIOD_GUARD = flag("periodGuard", "requestId");
const APPROVE_GUARD = flag("approveGuard", "pending") === "pending";
const CONFLICT = flag("conflict", "refetch");
const TOTAL = flag("total", "selector");
const POLL_MS = Number(flag("pollMs", 6000));
const pay = (x: Sheet) => x.hours * x.rate;
const approvedSum = (xs: Sheet[]) => xs.filter((x) => x.status === "approved").reduce((a, x) => a + pay(x), 0);
const msg = (e: any, what: string) => (e?.response ? `${what} failed (${e.response.status}).` : `Network problem — ${what} did not go through.`);

export const loadPeriod = createAsyncThunk("payroll/load", async ({ period }: { period: string; background?: boolean }) => (await axios.get(`/api/timesheets`, { params: { period, limit: 40 } })).data.items as Sheet[]);
export const decide = createAsyncThunk("payroll/decide", async ({ sheet, status }: { sheet: Sheet; status: string }, { rejectWithValue }) => {
  try {
    return (await axios.patch(`/api/timesheets/${sheet.id}`, { status, version: sheet.version })).data as Sheet;
  } catch (e: any) {
    if (e?.response?.status === 409 && CONFLICT === "force") return (await axios.patch(`/api/timesheets/${sheet.id}`, { status })).data as Sheet;
    return rejectWithValue({ status: e?.response?.status ?? 0, current: e?.response?.data?.current as Sheet | undefined, message: msg(e, `${status === "approved" ? "Approving" : "Rejecting"} ${sheet.name}`) });
  }
});

type St = { period: string; sheets: Sheet[]; approvedTotal: number; pending: number[]; loading: boolean; error: string; notice: string; reqId: string };
const initial: St = { period: "2026-09-B", sheets: [], approvedTotal: 0, pending: [], loading: true, error: "", notice: "", reqId: "" };
const replace = (s: St, x: Sheet) => {
  s.sheets = s.sheets.map((y) => (y.id === x.id ? x : y));
  if (TOTAL === "selector") s.approvedTotal = approvedSum(s.sheets);
};
const slice = createSlice({
  name: "payroll",
  initialState: initial,
  reducers: { clearMsg: (s) => void ((s.error = ""), (s.notice = "")) },
  extraReducers: (b) => {
    b.addCase(loadPeriod.pending, (s, a) => {
      if (a.meta.arg.background) return;
      s.period = a.meta.arg.period;
      s.loading = true;
      s.reqId = a.meta.requestId;
    });
    b.addCase(loadPeriod.fulfilled, (s, a) => {
      if (PERIOD_GUARD === "requestId" && (a.meta.arg.period !== s.period || (!a.meta.arg.background && a.meta.requestId !== s.reqId))) return;
      const mine = new Map(s.sheets.map((x) => [x.id, x]));
      s.sheets = a.payload.map((x) => (s.pending.includes(x.id) ? (mine.get(x.id) ?? x) : x));
      if (TOTAL === "selector" || !a.meta.arg.background) s.approvedTotal = approvedSum(s.sheets);
      s.loading = false;
    });
    b.addCase(loadPeriod.rejected, (s, a) => {
      if (a.meta.arg.background) return;
      s.loading = false;
      s.error = msg(a.error, "Loading the period");
    });
    b.addCase(decide.pending, (s, a) => {
      s.pending.push(a.meta.arg.sheet.id);
      s.error = "";
      s.notice = "";
    });
    b.addCase(decide.fulfilled, (s, a) => {
      s.pending = s.pending.filter((x) => x !== a.meta.arg.sheet.id);
      const before = s.sheets.find((x) => x.id === a.payload.id);
      if (TOTAL === "stored" && before) s.approvedTotal += (a.payload.status === "approved" ? pay(a.payload) : 0) - (before.status === "approved" ? pay(before) : 0);
      replace(s, a.payload);
      s.notice = `${a.payload.name}: ${a.payload.status}.`;
    });
    b.addCase(decide.rejected, (s, a) => {
      s.pending = s.pending.filter((x) => x !== a.meta.arg.sheet.id);
      const p = a.payload as { current?: Sheet; status: number; message: string } | undefined;
      if (p?.current) replace(s, p.current);
      s.error = p?.status === 409 ? `${a.meta.arg.sheet.name}'s timesheet was changed by a supervisor — review the new hours.` : (p?.message ?? "Something went wrong.");
    });
  },
});

const store = configureStore({ reducer: { payroll: slice.reducer }, enhancers: (g) => g().concat(genclassEnhancer(rt, { name: "payroll" })) });
type Root = ReturnType<typeof store.getState>;
type Dispatch = typeof store.dispatch;
const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

function App() {
  const s = useSelector((r: Root) => r.payroll);
  const dispatch = useDispatch<Dispatch>();
  useEffect(() => {
    void dispatch(loadPeriod({ period: s.period }));
    const iv = setInterval(() => void dispatch(loadPeriod({ period: store.getState().payroll.period, background: true })), POLL_MS);
    return () => clearInterval(iv);
  }, []);
  const act = (sheet: Sheet, status: string) => {
    if (APPROVE_GUARD && s.pending.includes(sheet.id)) return;
    void dispatch(decide({ sheet, status }));
  };
  const submitted = s.sheets.filter((x) => x.status === "submitted");
  return (
    <div className="payroll">
      <h1>Payroll approvals</h1>
      <label>Period <select name="period" value={s.period} onChange={(e) => { dispatch(slice.actions.clearMsg()); void dispatch(loadPeriod({ period: e.target.value })); }}>{["2026-09-A", "2026-09-B", "2026-10-A"].map((p) => <option key={p}>{p}</option>)}</select></label>
      <p className="total">Approved: {usd(s.approvedTotal)}</p>
      {s.error ? <p role="alert">{s.error}</p> : s.notice ? <p className="notice">{s.notice}</p> : null}
      {s.loading && <p className="muted">Loading timesheets…</p>}
      <table><tbody>
        {s.sheets.map((x) => (
          <tr key={x.id} className={`sheet ${x.status}`}>
            <td>{x.name}</td><td>{x.team}</td><td>{x.hours} h × ${x.rate}</td><td>{usd(pay(x))}</td><td>{x.status}</td>
            <td>{x.status !== "approved" && <button className="approve" disabled={APPROVE_GUARD && s.pending.includes(x.id)} onClick={() => act(x, "approved")}>Approve</button>}{" "}
              {x.status === "submitted" && <button className="reject" disabled={s.pending.includes(x.id)} onClick={() => act(x, "rejected")}>Reject</button>}</td>
          </tr>
        ))}
      </tbody></table>
      <button className="approve-all" disabled={!submitted.length || s.pending.length > 0} onClick={() => submitted.forEach((x) => act(x, "approved"))}>Approve all submitted ({submitted.length})</button>
    </div>
  );
}

createRoot(document.getElementById("app")!).render(<Provider store={store}><App /></Provider>);
