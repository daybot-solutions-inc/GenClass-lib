// Residents' parking permit portal (jQuery 3 + $.ajax/$.getJSON; the DOM is the state; observe-only integration).
// Typing a plate looks the vehicle up as you type; the quote is computed from the zone tariff; applying POSTs a
// permit (retried once on a gateway error); permits can be renewed by a month (relative POST) or cancelled. Latent
// bugs by flag: plate lookups not aborted (plateLookup=none: an older lookup's vehicle is shown for the newer plate),
// the Apply button live while submitting (submitGuard=none), retries without an Idempotency-Key (submitKey=none: a
// permit created twice) and Renew live while posting (renewGuard=none: two months added).
import $ from "jquery";
import { flag } from "../_shared/genclass";

type Zone = { id: number; code: string; name: string; monthly: number };
type Permit = { id: number; plate: string; zone: string; months: number; status: string };
const PLATE_LOOKUP = flag("plateLookup", "abort");
const SUBMIT_GUARD = flag("submitGuard", "disable") === "disable";
const SUBMIT_KEY = flag("submitKey", "idempotency-key");
const RENEW_GUARD = flag("renewGuard", "disable") === "disable";

let zones: Zone[] = [];
let lookup: JQuery.jqXHR | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const esc = (t: unknown) => $("<i>").text(String(t)).html();
const fail = (x: JQuery.jqXHR, what: string) => (x.status === 0 ? `Can't reach the council server — ${what} did not go through.` : `${what} failed (${x.status}).`);
const say = (sel: string, t: string, alert = false) => $(sel).html(t ? `<p${alert ? ' role="alert"' : ' class="notice"'}>${esc(t)}</p>` : "");

$("#app").html(`<h1>Residents' parking permits</h1>
  <form class="apply"><label>Number plate <input name="plate" autocomplete="off"></label> <span class="vehicle muted"></span>
    <label>Zone <select name="zone"><option value="A">Zone A</option><option value="B">Zone B</option><option value="C">Zone C</option></select></label>
    <fieldset class="months"><legend>Duration</legend>${[1, 3, 6, 12].map((m) => `<label><input type="radio" name="months" value="${m}"${m === 3 ? " checked" : ""}> ${m} month${m > 1 ? "s" : ""}</label>`).join(" ")}</fieldset>
    <p class="quote"></p><button type="submit">Apply for permit</button><div class="form-msg"></div></form>
  <section><h2>Your permits</h2><div class="list-msg"></div><ul class="permits"></ul></section>`);

function quote() {
  const z = zones.find((x) => x.code === $("select[name=zone]").val());
  const months = Number($("input[name=months]:checked").val());
  $(".quote").text(z ? `${z.name}: ${months} × £${z.monthly} = £${z.monthly * months}` : "Loading tariffs…");
}

function lookupPlate() {
  const plate = String($("input[name=plate]").val()).trim().toUpperCase();
  if (PLATE_LOOKUP === "abort" && lookup) lookup.abort();
  if (plate.length < 3) return $(".vehicle").text("");
  $(".vehicle").text("Checking…");
  const x = $.getJSON("/api/vehicles", { q: plate });
  lookup = x;
  x.done((vs: { plate: string; model: string }[]) => {
    const v = vs.find((y) => y.plate === plate) ?? (vs.length === 1 ? vs[0] : undefined);
    $(".vehicle").text(v ? `${v.plate}: ${v.model}` : vs.length ? `${vs.length} matching vehicles` : "Vehicle not registered at this address");
  })
    .fail((r) => {
      if (r.statusText !== "abort") $(".vehicle").text("Lookup unavailable");
    })
    .always(() => {
      if (lookup === x) lookup = null;
    });
}

function renderPermits(ps: Permit[]) {
  $("ul.permits").html(
    ps.map((p) => `<li class="permit" data-id="${p.id}">${esc(p.plate)} · Zone ${esc(p.zone)} · <span class="months">${p.months}</span> month(s) · ${esc(p.status)} <button type="button" class="renew">Renew +1 month</button> <button type="button" class="cancel">Cancel</button></li>`).join("") || `<li class="muted">No permits yet.</li>`,
  );
}
function loadPermits() {
  $.getJSON("/api/permits").done(renderPermits).fail((x) => say(".list-msg", fail(x, "Loading your permits"), true));
}

function submit(ev: JQuery.SubmitEvent) {
  ev.preventDefault();
  const $btn = $("form.apply button[type=submit]");
  if (SUBMIT_GUARD && $btn.prop("disabled")) return;
  const plate = String($("input[name=plate]").val()).trim().toUpperCase();
  if (plate.length < 5) return say(".form-msg", "Enter the full number plate.", true);
  const body = { plate, zone: String($("select[name=zone]").val()), months: Number($("input[name=months]:checked").val()), status: "active" };
  const key = SUBMIT_KEY === "idempotency-key" ? `permit-${plate}-${Date.now()}` : "";
  const post = () => $.ajax({ url: "/api/permits", method: "POST", contentType: "application/json", data: JSON.stringify(body), dataType: "json", headers: key ? { "Idempotency-Key": key } : {} });
  if (SUBMIT_GUARD) $btn.prop("disabled", true).text("Submitting…");
  say(".form-msg", "");
  post()
    .catch((x: JQuery.jqXHR) => (x.status >= 502 && x.status <= 504 ? post() : $.Deferred().reject(x)))
    .then((p: Permit) => {
      say(".form-msg", `Permit #${p.id} issued for ${p.plate}.`);
      loadPermits();
    })
    .fail((x: JQuery.jqXHR) => say(".form-msg", fail(x, "The application"), true))
    .always(() => $btn.prop("disabled", false).text("Apply for permit"));
}

$("ul.permits").on("click", "button.renew", function () {
  const $b = $(this);
  if (RENEW_GUARD && $b.prop("disabled")) return;
  const $li = $b.closest("li");
  if (RENEW_GUARD) $b.prop("disabled", true);
  $.ajax({ url: `/api/permits/${$li.data("id")}/renew`, method: "POST", dataType: "json" })
    .done((p: Permit) => {
      $li.find(".months").text(String(p.months));
      say(".list-msg", `${p.plate} renewed — ${p.months} month(s) in total.`);
    })
    .fail((x) => say(".list-msg", fail(x, "The renewal"), true))
    .always(() => $b.prop("disabled", false));
});
$("ul.permits").on("click", "button.cancel", function () {
  const $li = $(this).closest("li");
  $(this).prop("disabled", true);
  $.ajax({ url: `/api/permits/${$li.data("id")}`, method: "DELETE" })
    .done(() => {
      $li.remove();
      say(".list-msg", "Permit cancelled.");
    })
    .fail((x) => {
      $(this).prop("disabled", false);
      say(".list-msg", fail(x, "Cancelling"), true);
    });
});
$("input[name=plate]").on("input", () => {
  clearTimeout(timer);
  timer = setTimeout(lookupPlate, 250);
});
$("select[name=zone], input[name=months]").on("change", quote);
$("form.apply").on("submit", submit);

$.getJSON("/api/zones")
  .done((zs: Zone[]) => {
    zones = zs;
    quote();
  })
  .fail(() => $(".quote").text("Tariffs unavailable right now."));
quote();
loadPermits();
