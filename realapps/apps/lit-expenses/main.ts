// Expense report builder (Lit 3 element with shadow DOM; AtomController binds a runtime atom; fetch). The open draft
// report collects receipts: attaching one is a two-step upload (POST /receipts, then POST /receipts/:id/ocr starts
// text recognition), the OCR service marks it read or unreadable later, so the list polls while anything is scanning.
// The report can be submitted once every receipt is read; then a new draft starts. Latent bugs by flag: a total
// adjusted by hand that a failed attach never gives back (total=incremental), an Attach button that stays live while
// the upload posts (attachGuard=none: the same receipt twice), Submit enabled while receipts are still scanning
// (submit=early), polls that overwrite receipts with a removal in flight (poll=blind: a removed receipt comes back)
// and removals not rolled back when the DELETE fails (remove=optimistic).
import { LitElement, html, nothing } from "lit";
import { rt, flag } from "../_shared/genclass";
import { AtomController } from "../_shared/lit-atom";
import { api, itemsOf, errText } from "../_shared/w3-http";

type Receipt = { id: number; reportId: number; merchant: string; amount: number; category: string; status: string };
type Report = { id: number; title: string; status: string };
const TOTAL = flag("total", "derive");
const ATTACH_GUARD = flag("attachGuard", "pending") === "pending";
const SUBMIT = flag("submit", "after-scans");
const POLL = flag("poll", "pending-aware");
const REMOVE = flag("remove", "optimistic-rollback");
const SAMPLES = [
  { merchant: "Air Canada", amount: 41200, category: "travel" },
  { merchant: "Hotel Le Germain", amount: 28950, category: "lodging" },
  { merchant: "Uber", amount: 3420, category: "transport" },
  { merchant: "Bistro 990", amount: 8675, category: "meals" },
  { merchant: "Staples", amount: 2199, category: "supplies" },
  { merchant: "Porter Airlines", amount: 19800, category: "travel" },
];

const exp = rt.atom("expenses", { reportId: 0, title: "", status: "draft", receipts: [] as Receipt[], total: 0, pick: SAMPLES[0]!.merchant, attaching: false, pending: [] as number[], submitting: false, error: "", notice: "" });
type X = ReturnType<typeof exp.get>;
const sum = (rs: Receipt[]) => rs.reduce((a, r) => a + r.amount, 0);
const withReceipts = (x: X, receipts: Receipt[], delta: number): X => ({ ...x, receipts, total: TOTAL === "derive" ? sum(receipts) : x.total + delta });
const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
const allRead = (x: X) => x.receipts.length > 0 && x.receipts.every((r) => r.status === "read");
/** Receipts from the phone inbox not attached to this report yet. */
const inbox = (x: X) => SAMPLES.filter((r) => !x.receipts.some((y) => y.merchant === r.merchant));

async function openDraft() {
  try {
    let [draft] = itemsOf<Report>(await api(`/api/reports?status=draft&limit=5`));
    if (!draft) draft = await api<Report>(`/api/reports`, "POST", { title: "April conference trip", status: "draft", total: 0 });
    const receipts = itemsOf<Receipt>(await api(`/api/receipts?reportId=${draft.id}&limit=40`));
    exp.update((x) => ({ ...x, reportId: draft!.id, title: draft!.title, status: draft!.status, receipts, total: sum(receipts), error: "" }));
  } catch (e) {
    exp.update((x) => ({ ...x, error: errText(e, "opening your draft report") }));
  }
}

async function attach() {
  const x0 = exp.get();
  if (!x0.reportId || x0.status !== "draft" || (ATTACH_GUARD && x0.attaching)) return;
  const sample = inbox(x0).find((r) => r.merchant === x0.pick) ?? inbox(x0)[0];
  if (!sample) return;
  exp.update((x) => ({ ...x, attaching: true, error: "", notice: "", ...(TOTAL === "incremental" ? { total: x.total + sample.amount } : {}) }));
  try {
    const r = await api<Receipt>(`/api/receipts`, "POST", { reportId: x0.reportId, ...sample, status: "uploaded" });
    const scanning = await api<Receipt>(`/api/receipts/${r.id}/ocr`, "POST");
    exp.update((x) => ({ ...withReceipts(x, [...x.receipts.filter((y) => y.id !== scanning.id), scanning], 0), total: TOTAL === "derive" ? sum([...x.receipts.filter((y) => y.id !== scanning.id), scanning]) : x.total, notice: `${sample.merchant} attached — reading the receipt…` }));
  } catch (e) {
    exp.update((x) => ({ ...x, error: errText(e, `attaching the ${sample.merchant} receipt`) }));
  } finally {
    exp.update((x) => ({ ...x, attaching: false }));
  }
}

async function remove(r: Receipt) {
  if (exp.get().pending.includes(r.id)) return;
  exp.update((x) => ({ ...withReceipts(x, x.receipts.filter((y) => y.id !== r.id), -r.amount), pending: [...x.pending, r.id], error: "" }));
  try {
    await api(`/api/receipts/${r.id}`, "DELETE");
  } catch (e) {
    exp.update((x) => ({ ...(REMOVE === "optimistic-rollback" && !x.receipts.some((y) => y.id === r.id) ? withReceipts(x, [...x.receipts, r], r.amount) : x), error: errText(e, `removing the ${r.merchant} receipt`) }));
  } finally {
    exp.update((x) => ({ ...x, pending: x.pending.filter((id) => id !== r.id) }));
  }
}

async function submit() {
  const x0 = exp.get();
  if (x0.submitting || x0.status !== "draft") return;
  exp.update((x) => ({ ...x, submitting: true, error: "", notice: "" }));
  try {
    const rep = await api<Report>(`/api/reports/${x0.reportId}/submit`, "POST", {});
    exp.update((x) => ({ ...x, status: rep.status, notice: `“${rep.title}” sent to your manager (${dollars(x.total)}).` }));
  } catch (e) {
    exp.update((x) => ({ ...x, error: errText(e, "submitting the report") }));
  } finally {
    exp.update((x) => ({ ...x, submitting: false }));
  }
}

async function newReport() {
  exp.update((x) => ({ ...x, reportId: 0, title: "", status: "draft", receipts: [], total: 0, notice: "" }));
  try {
    const draft = await api<Report>(`/api/reports`, "POST", { title: "New expense report", status: "draft", total: 0 });
    exp.update((x) => ({ ...x, reportId: draft.id, title: draft.title, status: draft.status }));
  } catch (e) {
    exp.update((x) => ({ ...x, error: errText(e, "starting a new report") }));
  }
}

async function poll() {
  const x0 = exp.get();
  if (!x0.reportId || !x0.receipts.some((r) => r.status === "scanning" || r.status === "uploaded")) return;
  try {
    const fresh = itemsOf<Receipt>(await api(`/api/receipts?reportId=${x0.reportId}&limit=40`));
    exp.update((x) => {
      if (x.reportId !== x0.reportId || x.attaching) return x;
      const receipts = POLL === "pending-aware" ? fresh.filter((r) => !x.pending.includes(r.id)) : fresh;
      return { ...x, receipts, total: TOTAL === "derive" ? sum(receipts) : x.total };
    });
  } catch {
    /* try again on the next tick */
  }
}

class ExpenseApp extends LitElement {
  private x = new AtomController(this, exp);
  render() {
    const x = this.x.value;
    const canSubmit = x.status === "draft" && x.receipts.length > 0 && (SUBMIT === "early" || allRead(x)) && !x.submitting;
    return html`<h1>${x.title || "Expense report"}</h1>
      <p class="summary">${x.receipts.length} receipt(s) · total ${dollars(x.total)} · ${x.status}</p>
      ${x.error ? html`<p role="alert">${x.error}</p>` : x.notice ? html`<p class="notice">${x.notice}</p>` : nothing}
      ${x.status === "draft"
        ? html`<div class="attach-row"><label>Receipt <select name="receipt" @change=${(e: Event) => exp.update((s) => ({ ...s, pick: (e.target as HTMLSelectElement).value }))}>
              ${inbox(x).map((r) => html`<option value=${r.merchant} ?selected=${r.merchant === x.pick}>${r.merchant} · ${dollars(r.amount)}</option>`)}</select></label>
            <button type="button" class="attach" ?disabled=${!x.reportId || !inbox(x).length || (ATTACH_GUARD && x.attaching)} @click=${() => void attach()}>${x.attaching ? "Uploading…" : "Attach"}</button></div>`
        : nothing}
      <ul class="receipts">${x.receipts.map(
        (r) => html`<li class="receipt ${r.status}">${r.merchant} · ${r.category} · ${dollars(r.amount)} · ${r.status === "scanning" || r.status === "uploaded" ? "reading…" : r.status}
          ${x.status === "draft" ? html`<button type="button" class="remove" ?disabled=${x.pending.includes(r.id)} @click=${() => void remove(r)}>Remove</button>` : nothing}</li>`,
      )}</ul>
      ${x.status === "draft"
        ? html`<button type="button" class="submit" ?disabled=${!canSubmit} @click=${() => void submit()}>${x.submitting ? "Submitting…" : "Submit for approval"}</button>`
        : html`<button type="button" class="new-report" @click=${() => void newReport()}>Start a new report</button>`}`;
  }
}
customElements.define("expense-app", ExpenseApp);
document.getElementById("app")!.appendChild(document.createElement("expense-app"));
void openDraft();
setInterval(() => void poll(), 2500);
