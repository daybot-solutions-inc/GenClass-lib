// Warehouse pick station (jQuery 3 + $.ajax, DOM is the state; observe-only integration). A picker works through
// the lines of a wave: each scan is a relative POST /lines/:id/pick, a line can be shorted, and the wave is closed
// into a shipment once every line is picked or shorted. Other pickers work wave W2 at the same time. Latent bugs by
// flag: pick buttons not disabled while the scan posts (pickGuard=none: double scans overshoot the quantity), wave
// loads that are not aborted when the picker switches waves (waveLoad=none: the last response to land wins), and
// closing a wave from the counts on screen instead of re-reading the lines (closeCheck=trust-local).
import $ from "jquery";
import { flag } from "../_shared/genclass";

type Line = { id: number; wave: string; order: string; sku: string; name: string; bin: string; qty: number; picked: number; short: boolean };
const PICK_GUARD = flag("pickGuard", "disable");
const WAVE_LOAD = flag("waveLoad", "abort");
const CLOSE_CHECK = flag("closeCheck", "refetch");
const POLL_MS = Number(flag("pollMs", 4000));

let wave = "W1";
let waveXhr: JQuery.jqXHR | null = null;
const posting = new Set<number>();

$("#app").html(`<header><h1>Pick station 4</h1>
  <label>Wave <select name="wave"><option>W1</option><option>W2</option><option>W3</option></select></label>
  <span class="progress"></span> <button type="button" class="close-wave">Close wave</button></header>
  <div class="msg"></div>
  <table class="picklist"><thead><tr><th>Bin</th><th>SKU</th><th>Item</th><th>Order</th><th>Picked</th><th></th></tr></thead><tbody></tbody></table>`);

const esc = (t: unknown) => $("<i>").text(String(t)).html();
const alertMsg = (t: string) => $(".msg").html(`<p role="alert">${esc(t)}</p>`);
const note = (t: string) => $(".msg").html(`<p class="notice">${esc(t)}</p>`);
const failText = (x: JQuery.jqXHR, what: string) => (x.status === 0 ? `Scanner offline — ${what} not recorded.` : `${what} failed (${x.status}).`);

function rowHtml(l: Line) {
  const done = l.picked >= l.qty || l.short;
  return `<tr class="line${done ? " done" : ""}" data-id="${l.id}"><td>${esc(l.bin)}</td><td>${esc(l.sku)}</td><td>${esc(l.name)}</td><td>${esc(l.order)}</td>
    <td class="count">${l.picked} / ${l.qty}${l.short ? " (short)" : ""}</td>
    <td>${done ? "" : `<button type="button" class="pick">Scan</button> <button type="button" class="short">Short</button>`}${l.picked > 0 && !l.short ? ` <button type="button" class="unpick">Undo</button>` : ""}</td></tr>`;
}
function renderLine(l: Line) {
  const $row = $(`tr.line[data-id=${l.id}]`);
  if ($row.length) $row.replaceWith(rowHtml(l));
  $(`tr.line[data-id=${l.id}]`).data("line", l);
  progress();
}
function progress() {
  const ls = $("tr.line").map((_i, el) => $(el).data("line") as Line).get();
  const done = ls.filter((l) => l.picked >= l.qty || l.short).length;
  $(".progress").text(`${done} of ${ls.length} lines complete`);
}

function loadWave(w: string, background = false) {
  if (WAVE_LOAD === "abort" && waveXhr) {
    if (background) return;
    waveXhr.abort();
  }
  if (!background) $("tbody").html(`<tr><td colspan="6" class="muted">Loading wave ${esc(w)}…</td></tr>`);
  const xhr = $.ajax({ url: "/api/lines", data: { wave: w, limit: 50 }, dataType: "json" });
  waveXhr = xhr;
  xhr
    .done((body: { data: Line[] }) => {
      if (WAVE_LOAD === "abort" && w !== wave) return;
      const ls = Array.isArray(body.data) ? body.data : [];
      // background refreshes keep the rows that have a scan in flight
      const html = ls.map((l) => (background && posting.has(l.id) ? $("<tbody>").append($(`tr.line[data-id=${l.id}]`).clone()).html() : rowHtml(l))).join("");
      const keep = new Map(ls.map((l) => [l.id, background && posting.has(l.id) ? ($(`tr.line[data-id=${l.id}]`).data("line") as Line) ?? l : l]));
      $("tbody").html(html || `<tr><td colspan="6" class="muted">Wave is empty.</td></tr>`);
      $("tr.line").each((_i, el) => {
        $(el).data("line", keep.get(Number($(el).attr("data-id"))));
      });
      progress();
    })
    .fail((x) => {
      if (x.statusText !== "abort" && !background) alertMsg(failText(x, "Loading the wave"));
    })
    .always(() => {
      if (waveXhr === xhr) waveXhr = null;
    });
}

function act(id: number, verb: "pick" | "unpick" | "short", $btn: JQuery) {
  if (PICK_GUARD === "disable") {
    if (posting.has(id)) return;
    $btn.closest("tr").find("button").prop("disabled", true);
  }
  posting.add(id);
  $.ajax({ url: `/api/lines/${id}/${verb}`, method: "POST", dataType: "json" })
    .done((l: Line) => {
      posting.delete(id);
      renderLine(l);
      if (verb === "pick") note(`${l.sku} scanned (${l.picked}/${l.qty}) from ${l.bin}.`);
      else if (verb === "short") note(`${l.sku} marked short.`);
    })
    .fail((x) => {
      posting.delete(id);
      $(`tr.line[data-id=${id}] button`).prop("disabled", false);
      alertMsg(failText(x, verb === "pick" ? "The scan" : "The update"));
    });
}

function closeWave() {
  const $b = $(".close-wave").prop("disabled", true);
  const w = wave;
  const check: JQuery.Promise<Line[]> =
    CLOSE_CHECK === "refetch"
      ? $.ajax({ url: "/api/lines", data: { wave: w, limit: 50 }, dataType: "json" }).then((b: { data: Line[] }) => b.data ?? [])
      : $.Deferred<Line[]>().resolve($("tr.line").map((_i, el) => $(el).data("line") as Line).get()).promise();
  check
    .then((ls) => {
      const open = ls.filter((l) => l.picked < l.qty && !l.short);
      if (open.length) {
        alertMsg(`${open.length} line(s) still open in ${w}.`);
        return null;
      }
      return $.ajax({ url: "/api/shipments", method: "POST", contentType: "application/json", data: JSON.stringify({ wave: w, lines: ls.length, units: ls.reduce((a, l) => a + l.picked, 0) }), dataType: "json" }).then((s: { id: number }) => note(`Wave ${w} closed as shipment #${s.id}.`));
    })
    .fail((x: JQuery.jqXHR) => alertMsg(failText(x, "Closing the wave")))
    .always(() => $b.prop("disabled", false));
}

$("select[name=wave]").on("change", function () {
  wave = String($(this).val());
  $(".msg").empty();
  loadWave(wave);
});
$("tbody").on("click", "button", function () {
  const $b = $(this);
  const id = Number($b.closest("tr").attr("data-id"));
  act(id, $b.hasClass("pick") ? "pick" : $b.hasClass("unpick") ? "unpick" : "short", $b);
});
$(".close-wave").on("click", closeWave);

loadWave(wave);
setInterval(() => loadWave(wave, true), POLL_MS);
