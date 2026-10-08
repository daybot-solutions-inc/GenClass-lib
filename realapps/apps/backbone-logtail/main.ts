// Live log tail (Backbone.js 1.6 collection + view with underscore templates, Backbone.sync over jQuery.ajax, a
// WebSocket for new lines; nothing registered with GenClass: observe-only). New lines stream in at the top; "Load
// older" pages back with offset/limit (so lines that arrived meanwhile shift every page); level and service filters
// refetch; the tail can be paused; lines can be pinned. The view updates the DOM incrementally, Backbone-style.
// Latent bugs by flag: older pages appended to the DOM as they come back (older=blind: the shifted page repeats lines
// already shown), a Load older button live while a page loads (olderGuard=none: the same page twice), filter fetches
// that don't abort the previous one (filterFetch=none: the slower answer wins and the list shows the other level),
// reconnects that don't reload (reconnect=naive: lines logged while the socket was down are missing) and a pause
// that drops lines instead of buffering them (pause=drop).
import Backbone from "backbone";
import _ from "underscore";
import $ from "jquery";
import { flag } from "../_shared/genclass";
import { liveTopic } from "../_shared/w3-http";

const OLDER = flag("older", "dedupe");
const OLDER_GUARD = flag("olderGuard", "pending") === "pending";
const FILTER_FETCH = flag("filterFetch", "abort-previous");
const RECONNECT = flag("reconnect", "resync");
const PAUSE = flag("pause", "buffer");
const PAGE = 15;

(Backbone as any).$ = $;
const B = Backbone as any;
type LineAttrs = { id: number; service: string; level: string; msg: string; createdAt: string };
const Lines = B.Collection.extend({ url: "/api/logs", parse: (r: any) => r.items ?? r });
const lines = new Lines();
const ui = new B.Model({ level: "all", service: "all", loading: true, loadingOlder: false, exhausted: false, paused: false, buffered: 0, live: false, error: "", notice: "" });
const pinned = new Map<number, number>();
const buffer: LineAttrs[] = [];

const tpl = _.template(`<li class="line <%- level %>" data-id="<%- id %>"><code><%- createdAt.slice(11, 19) %></code> <strong><%- service %></strong> <em><%- level %></em> <%- msg %>
  <button type="button" class="pin"<%= pinned ? " disabled" : "" %>><%- pinned ? "Pinned" : "Pin" %></button></li>`);
const row = (a: LineAttrs) => tpl({ ...a, pinned: pinned.has(a.id) });
const matches = (a: LineAttrs) => (ui.get("level") === "all" || a.level === ui.get("level")) && (ui.get("service") === "all" || a.service === ui.get("service"));
const params = (offset: number) => ({ sort: "-createdAt", limit: PAGE, offset, ...(ui.get("level") === "all" ? {} : { level: ui.get("level") }), ...(ui.get("service") === "all" ? {} : { service: ui.get("service") }) });

$("#app").html(`<header><h1>Log tail · production</h1><p class="status"></p></header>
  <div class="toolbar"><label>Level <select name="level"><option value="all">All</option><option value="warn">warn</option><option value="error">error</option></select></label>
    <label>Service <select name="service"><option value="all">All</option><option>api</option><option>worker</option><option>db</option></select></label>
    <button type="button" class="pause">Pause</button></div>
  <div class="msg"></div><ul class="lines"></ul><button type="button" class="older">Load older</button>`);

const TailView = B.View.extend({
  el: "#app",
  events: { "change select[name=level]": "onFilter", "change select[name=service]": "onFilter", "click button.pause": "onPause", "click button.older": "onOlder", "click li.line button.pin": "onPin" },
  initialize() {
    this.listenTo(lines, "reset", this.renderAll);
    this.listenTo(lines, "add", (m: any, _c: any, opts: any) => (opts.at === 0 ? this.$("ul.lines").prepend(row(m.toJSON())) : this.$("ul.lines").append(row(m.toJSON()))));
    this.listenTo(ui, "change", this.renderChrome);
  },
  renderAll() {
    this.$("ul.lines").html(lines.map((m: any) => row(m.toJSON())).join(""));
    this.renderChrome();
  },
  renderChrome() {
    this.$(".status").text(`${ui.get("live") ? (ui.get("paused") ? `paused (${ui.get("buffered")} new)` : "live") : "reconnecting…"} · ${lines.length} lines loaded`);
    this.$("button.pause").text(ui.get("paused") ? "Resume" : "Pause");
    this.$("button.older").prop("disabled", ui.get("exhausted") || (OLDER_GUARD && ui.get("loadingOlder"))).text(ui.get("loadingOlder") ? "Loading…" : ui.get("exhausted") ? "No older lines" : "Load older");
    const err = ui.get("error");
    this.$(".msg").html(err ? `<p role="alert">${_.escape(err)}</p>` : ui.get("notice") ? `<p class="notice">${_.escape(ui.get("notice"))}</p>` : ui.get("loading") ? `<p class="muted">Loading…</p>` : "");
  },
  onFilter(e: Event) {
    const t = e.target as HTMLSelectElement;
    ui.set({ [t.name]: t.value, notice: "" });
    loadFirst();
  },
  onPause() {
    if (!ui.get("paused")) return ui.set({ paused: true });
    ui.set({ paused: false, buffered: 0 });
    const pending = buffer.splice(0).filter(matches);
    if (pending.length) lines.add(pending.reverse(), { at: 0 });
    this.renderAll();
  },
  onOlder() {
    loadOlder();
  },
  onPin(e: Event) {
    const id = Number($(e.currentTarget as Element).closest("li").data("id"));
    void pin(id, $(e.currentTarget as Element));
  },
});
new TailView().renderChrome();

let firstXhr: any = null;
function loadFirst() {
  if (FILTER_FETCH === "abort-previous") firstXhr?.abort();
  ui.set({ loading: true, exhausted: false, error: "" });
  const mine = (firstXhr = lines.fetch({
    reset: true,
    data: params(0),
    success: (_c: any, resp: any) => ui.set({ loading: false, exhausted: (resp.items ?? []).length < PAGE }),
    error: (_c: any, x: any) => {
      if (x.statusText !== "abort") ui.set({ loading: false, error: `Logs could not be loaded (${x.status || "offline"}).` });
    },
  }));
  mine.always(() => {
    if (firstXhr === mine) firstXhr = null;
  });
}

function loadOlder() {
  if (OLDER_GUARD && ui.get("loadingOlder")) return;
  ui.set({ loadingOlder: true, error: "" });
  $.ajax({ url: "/api/logs", data: params(lines.length), dataType: "json" })
    .done((resp: any) => {
      const page: LineAttrs[] = (resp.items ?? []).filter(matches);
      if (OLDER === "dedupe") lines.add(page);
      else {
        lines.add(page, { silent: true });
        $("ul.lines").append(page.map(row).join(""));
      }
      ui.set({ exhausted: page.length < PAGE });
    })
    .fail((x: any) => ui.set({ error: `Older lines could not be loaded (${x.status || "offline"}).` }))
    .always(() => ui.set({ loadingOlder: false }));
}

async function pin(id: number, $btn: JQuery) {
  if (pinned.has(id)) return;
  $btn.prop("disabled", true);
  $.ajax({ url: "/api/pins", method: "POST", contentType: "application/json", data: JSON.stringify({ logId: id }), dataType: "json" })
    .done((p: any) => {
      pinned.set(id, p.id);
      $(`li.line[data-id="${id}"] button.pin`).text("Pinned").prop("disabled", true);
      ui.set({ notice: "Line pinned to the incident board.", error: "" });
    })
    .fail((x: any) => {
      $btn.prop("disabled", false);
      ui.set({ error: x.status === 409 ? "That line is already pinned." : `Pinning failed (${x.status || "offline"}).` });
    });
}

let everUp = false;
liveTopic(
  "logs",
  (m) => {
    if (m.type !== "created" || !m.item) return;
    const a = m.item as LineAttrs;
    if (!matches(a)) return;
    if (ui.get("paused")) {
      if (PAUSE === "buffer") buffer.push(a);
      ui.set({ buffered: ui.get("buffered") + 1 });
      return;
    }
    lines.add(a, { at: 0 });
    ui.trigger("change");
  },
  (up) => {
    ui.set({ live: up });
    if (up && everUp && RECONNECT === "resync") loadFirst();
    if (up) everUp = true;
  },
);
loadFirst();
