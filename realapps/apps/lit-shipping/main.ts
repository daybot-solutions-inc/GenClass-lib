// Parcel shipping calculator (Lit 3 element rendering into light DOM; AtomController; fetch with AbortController).
// Changing the zone or the weight re-quotes (rates per zone from the server, price = base + per-kg × weight); the
// user picks a service and creates a label (POST, retried once on a gateway error). Latent bugs by flag: quotes not
// aborted when the parcel changes (quoteSeq=none: an older zone's quotes land last), a chosen service kept at its
// old price when the parcel changes (staleRate=keep: the label is bought at the wrong price), Create label live
// while posting (labelGuard=none) and retries without an Idempotency-Key (labelKey=none: two labels).
import { LitElement, html, nothing } from "lit";
import { rt, flag } from "../_shared/genclass";
import { AtomController } from "../_shared/lit-atom";
import { api, itemsOf, errText, isAbort, HttpError } from "../_shared/w3-http";

type Rate = { id: number; zone: string; service: string; base: number; perKg: number };
type Quote = { zone: string; service: string; kg: number; price: number };
const QUOTE_SEQ = flag("quoteSeq", "abort");
const STALE_RATE = flag("staleRate", "requote");
const LABEL_GUARD = flag("labelGuard", "disable") === "disable";
const LABEL_KEY = flag("labelKey", "idempotency-key");

const ship = rt.atom("ship", { zone: "domestic", weight: "1", quotes: [] as Quote[], chosen: null as Quote | null, labels: [] as { id: number; service: string; price: number }[], quoting: false, creating: false, error: "", notice: "" });
const price = (r: Rate, kg: number) => Math.round((r.base + r.perKg * kg) * 100) / 100;

let ctl: AbortController | null = null;
async function quote() {
  if (QUOTE_SEQ === "abort") ctl?.abort();
  const mine = (ctl = new AbortController());
  const { zone, weight } = ship.get();
  const kg = Number(weight);
  if (!(kg > 0)) return ship.update((s) => ({ ...s, quotes: [], error: "Enter a weight in kg." }));
  ship.update((s) => ({ ...s, quoting: true, error: "", ...(STALE_RATE === "requote" ? { chosen: null } : {}) }));
  try {
    const rates = itemsOf<Rate>(await api(`/api/rates?zone=${zone}`, "GET", undefined, {}, mine.signal));
    ship.update((s) => ({ ...s, quotes: rates.map((r) => ({ zone: r.zone, service: r.service, kg, price: price(r, kg) })), quoting: ctl === mine ? false : s.quoting }));
  } catch (e) {
    if (isAbort(e)) return;
    ship.update((s) => ({ ...s, quoting: false, error: errText(e, "getting quotes") }));
  }
}

async function createLabel() {
  const s0 = ship.get();
  if (!s0.chosen || (LABEL_GUARD && s0.creating)) return;
  const q = s0.chosen;
  ship.update((s) => ({ ...s, creating: true, error: "", notice: "" }));
  const key = LABEL_KEY === "idempotency-key" ? `label-${q.zone}-${q.service}-${q.kg}-${Date.now()}` : "";
  const post = () => api<{ id: number; service: string; price: number }>(`/api/labels`, "POST", { zone: q.zone, service: q.service, kg: q.kg, price: q.price }, key ? { "Idempotency-Key": key } : {});
  try {
    const l = await post().catch((e) => (e instanceof HttpError && e.status >= 502 && e.status <= 504 ? post() : Promise.reject(e)));
    ship.update((s) => ({ ...s, labels: [...s.labels, l], notice: `Label #${l.id}: ${l.service}, £${l.price.toFixed(2)}.` }));
  } catch (e) {
    ship.update((s) => ({ ...s, error: errText(e, "creating the label") }));
  } finally {
    ship.update((s) => ({ ...s, creating: false }));
  }
}

let debounce: ReturnType<typeof setTimeout> | undefined;
class ShippingCalc extends LitElement {
  private s = new AtomController(this, ship);
  createRenderRoot() {
    return this;
  }
  render() {
    const s = this.s.value;
    return html`<h1>Ship a parcel</h1>
      <label>Destination <select name="zone" @change=${(e: Event) => { ship.update((x) => ({ ...x, zone: (e.target as HTMLSelectElement).value, ...(STALE_RATE === "requote" ? { chosen: null } : {}) })); void quote(); }}>
        ${["domestic", "eu", "world"].map((z) => html`<option value=${z} ?selected=${z === s.zone}>${z === "eu" ? "Europe" : z === "world" ? "Rest of world" : "Domestic"}</option>`)}</select></label>
      <label>Weight (kg) <input name="weight" inputmode="decimal" .value=${s.weight} @input=${(e: Event) => { ship.update((x) => ({ ...x, weight: (e.target as HTMLInputElement).value, ...(STALE_RATE === "requote" ? { chosen: null } : {}) })); clearTimeout(debounce); debounce = setTimeout(() => void quote(), 300); }}></label>
      ${s.quoting ? html`<span class="muted">Quoting…</span>` : nothing}
      ${s.error ? html`<p role="alert">${s.error}</p>` : s.notice ? html`<p class="notice">${s.notice}</p>` : nothing}
      <ul class="rates">${s.quotes.map((q) => html`<li class="rate ${s.chosen?.service === q.service ? "chosen" : ""}">${q.service} · ${q.kg} kg · £${q.price.toFixed(2)} <button class="choose" @click=${() => ship.update((x) => ({ ...x, chosen: q, notice: "" }))}>Choose</button></li>`)}</ul>
      <p class="summary">${s.chosen ? `Selected: ${s.chosen.service} for ${s.chosen.kg} kg, £${s.chosen.price.toFixed(2)}` : "Choose a service"}</p>
      <button class="create-label" ?disabled=${!s.chosen || (LABEL_GUARD && s.creating)} @click=${() => void createLabel()}>${s.creating ? "Creating…" : "Create label"}</button>
      <h2>Labels today (${s.labels.length})</h2><ul class="labels">${s.labels.map((l) => html`<li>#${l.id} ${l.service} £${l.price.toFixed(2)}</li>`)}</ul>`;
  }
}
customElements.define("shipping-calc", ShippingCalc);
document.getElementById("app")!.appendChild(document.createElement("shipping-calc"));
void quote();
