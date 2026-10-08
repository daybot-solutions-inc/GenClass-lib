// Food bank pickup desk for distribution day (Backbone.js 1.6 collections + view, underscore templates, Backbone.sync
// over jQuery.ajax; the collections and a UI model are registered with rt.guard). Volunteers find today's households
// (8 per page, search by name or HH number), mark one as collected (model.save: a versioned PATCH, other desks and
// caseworkers change households too) and hand out its parcel (POST /parcels/:id/handout: relative, the stock is shared
// by every desk). At closing time the desk marks everyone still waiting on the page as a no-show (POST
// /households/bulk, per-item results). The page and the stock poll. Latent bugs by flag: households saved with a full
// PUT of the model as loaded and no version (save=put: a household collected at another desk is collected again and
// gets a second parcel; a caseworker's parcel change is reverted), collect buttons live while saving (pickupGuard=none:
// a double click sends two saves), the parcel stock kept as a local tally decremented at click time (stock=local:
// never sees other desks or deliveries, not undone on failure), bulk results ignored (bulk=assume-all: households the
// server could not mark show "no-show") and searches that don't abort the previous request (fetch=none: a slower
// earlier search overwrites the newer one).
import Backbone from "backbone";
import _ from "underscore";
import $ from "jquery";
import { rt, flag } from "../_shared/genclass";

const SAVE = flag("save", "patch-if-match");
const PICKUP_GUARD = flag("pickupGuard", "pending") === "pending";
const STOCK = flag("stock", "server");
const BULK = flag("bulk", "per-item");
const FETCH = flag("fetch", "abort-previous");
const PER = 8;

(Backbone as any).$ = $;
const B = Backbone as any;
// server bookkeeping fields are not sent back
const Household = B.Model.extend({ urlRoot: "/api/households", toJSON() { return _.omit(this.attributes, "version", "createdAt", "updatedAt"); } });
const Households = B.Collection.extend({ model: Household, url: "/api/households", parse: (r: any) => r.items ?? r });
const Parcels = B.Collection.extend({ url: "/api/parcels", parse: (r: any) => r.items ?? r });
const households = new Households();
const parcels = new Parcels();
const ui = new B.Model({ q: "", page: 1, total: 0, loading: true, pending: [] as number[], bulkBusy: false, error: "", notice: "" });
const pend = (id: number, on: boolean) => ui.set({ pending: on ? [...ui.get("pending"), id] : _.without(ui.get("pending"), id) });
const fail = (x: any) => x.status || "offline";

rt.guard(
  "desk",
  {
    get: () => ({ ...ui.toJSON(), households: households.map((h: any) => _.pick(h.attributes, "id", "name", "ref", "parcel", "status")), parcels: parcels.toJSON() }),
    set: (v: any) => {
      ui.set(_.omit(v, "households", "parcels"));
      if (v.households) households.set(v.households);
      if (v.parcels) parcels.set(v.parcels);
    },
    subscribe: (fn) => {
      households.on("update reset change", fn);
      parcels.on("update reset change", fn);
      ui.on("change", fn);
      return () => {
        households.off("update reset change", fn);
        parcels.off("update reset change", fn);
        ui.off("change", fn);
      };
    },
  },
  { resync: () => load(false) },
);

let xhr: any = null;
let writes = 0;
function load(background: boolean) {
  if (xhr && background) return;
  if (xhr && FETCH === "abort-previous") xhr.abort();
  const q = ui.get("q");
  const epoch = writes;
  const data = { page: ui.get("page"), limit: PER, sort: "name", ...(q ? { q } : {}) };
  if (!background) ui.set({ loading: true, error: "" });
  const mine = (xhr = $.ajax({ url: "/api/households", data, dataType: "json" }));
  mine
    .done((r: any) => {
      // a poll that read the page before one of our saves landed would bring the old status back
      if (background && epoch !== writes) return;
      // households with a save in flight keep what the desk just did
      const items = (r.items ?? []).map((h: any) => (ui.get("pending").includes(h.id) ? (households.get(h.id)?.attributes ?? h) : h));
      if (background) households.set(items);
      else households.reset(items);
      ui.set({ total: Number(r.total ?? items.length), ...(background ? {} : { loading: false }) });
    })
    .fail((x: any) => {
      if (x.statusText !== "abort" && !background) ui.set({ loading: false, error: `Households could not be loaded (${fail(x)}).` });
    })
    .always(() => {
      if (xhr === mine) xhr = null;
    });
}
let handouts = 0;
function loadStock() {
  const epoch = handouts;
  $.ajax({ url: "/api/parcels", dataType: "json" }).done((r: any) => epoch === handouts && parcels.set(r.items ?? []));
}

function handOut(h: any, id: number) {
  const p = parcels.get(h.get("parcel"));
  const kind = p?.get("kind") ?? "parcel";
  $.ajax({ url: `/api/parcels/${h.get("parcel")}/handout`, method: "POST", contentType: "application/json", data: "{}", dataType: "json" })
    .done((saved: any) => {
      handouts++;
      if (STOCK === "server") p?.set(saved);
      ui.set({ notice: `${h.get("name")} collected a ${kind}.` });
    })
    .fail((x: any) => ui.set({ error: `${h.get("name")} is collected but the ${kind} stock was not updated (${fail(x)}).` }))
    .always(() => pend(id, false));
}

function collect(id: number) {
  const h = households.get(id);
  if (!h || h.get("status") !== "waiting") return;
  if (PICKUP_GUARD && ui.get("pending").includes(id)) return;
  pend(id, true);
  ui.set({ error: "", notice: "" });
  if (STOCK === "local") parcels.get(h.get("parcel"))?.set({ stock: parcels.get(h.get("parcel")).get("stock") - 1 });
  const save = (version: number) => h.save({ status: "collected" }, SAVE === "patch-if-match" ? { patch: true, wait: true, headers: { "If-Match": String(version) } } : { wait: true });
  const failed = (x: any) => {
    ui.set({ error: `${h.get("name")} could not be marked collected (${fail(x)}).` });
    pend(id, false);
  };
  save(h.get("version"))
    .always(() => writes++)
    .done(() => handOut(h, id))
    .fail((x: any) => {
      const cur = x.status === 409 ? x.responseJSON?.current : null;
      if (!cur) return failed(x);
      h.set(cur);
      // a caseworker changed the household meanwhile: still waiting, so collect on top of their version
      if (cur.status === "waiting") return void save(cur.version).always(() => writes++).done(() => handOut(h, id)).fail(failed);
      ui.set({ error: `${h.get("name")} was already marked ${cur.status} at another desk.` });
      pend(id, false);
    });
}

function markNoShows() {
  const ids = households.filter((h: any) => h.get("status") === "waiting" && !ui.get("pending").includes(h.id)).map((h: any) => h.id);
  if (!ids.length || ui.get("bulkBusy")) return;
  ui.set({ bulkBusy: true, error: "", notice: "" });
  $.ajax({ url: "/api/households/bulk", method: "POST", contentType: "application/json", data: JSON.stringify({ ids, op: "patch", patch: { status: "no-show" } }), dataType: "json" })
    .done((r: any) => {
      writes++;
      const results: { id: number; ok: boolean }[] = r.results ?? [];
      const ok = BULK === "per-item" ? results.filter((x) => x.ok).map((x) => Number(x.id)) : ids;
      ok.forEach((id: number) => households.get(id)?.set({ status: "no-show" }));
      const failed = ids.length - results.filter((x) => x.ok).length;
      ui.set({ notice: `Marked ${ok.length} household(s) as no-show.`, error: BULK === "per-item" && failed ? `${failed} household(s) could not be marked.` : "" });
    })
    .fail((x: any) => ui.set({ error: `No-shows were not recorded (${fail(x)}).` }))
    .always(() => ui.set({ bulkBusy: false }));
}

$("#app").html(`<header><h1>Pickup desk · Eastside Food Bank</h1><p class="muted">Saturday distribution, 10:00 to 14:00</p></header>
  <ul class="stock"></ul>
  <div class="toolbar"><input name="q" placeholder="Search name or HH number" autocomplete="off">
    <button type="button" class="no-show">Mark everyone waiting here as no-show</button></div>
  <div class="msg"></div>
  <table><thead><tr><th>Household</th><th>Ref</th><th>Size</th><th>Parcel</th><th>Status</th><th></th></tr></thead><tbody class="households"></tbody></table>
  <nav class="pages"></nav>`);
const rowTpl = _.template(`<tr class="household <%- status %>" data-id="<%- id %>"><td><%- name %></td><td><%- ref %></td><td>×<%- size %></td><td><%- parcelKind %></td>
  <td><%- status === "collected" ? "collected ✓" : status %></td>
  <td><% if (status === "waiting") { %><button type="button" class="pickup"<%= lock ? " disabled" : "" %>>Collected</button><% } %></td></tr>`);
const stockTpl = _.template(`<li class="parcel<%= stock < 5 ? " low" : "" %>"><%- kind %>: <%- stock %> left</li>`);

const View = B.View.extend({
  el: "#app",
  events: {
    "input input[name=q]": "onSearch",
    "click nav.pages button": "onPage",
    "click tr.household button.pickup": "onCollect",
    "click button.no-show": () => markNoShows(),
  },
  initialize() {
    this.onSearch = _.debounce(this.onSearch, 300);
    this.listenTo(households, "reset update change", this.render);
    this.listenTo(parcels, "update reset change", this.render);
    this.listenTo(ui, "change", this.render);
  },
  onSearch() {
    ui.set({ q: String(this.$("input[name=q]").val() ?? "").trim(), page: 1, notice: "" });
    load(false);
  },
  onPage(e: Event) {
    ui.set({ page: Number($(e.currentTarget as Element).data("page")) });
    load(false);
  },
  onCollect(e: Event) {
    collect(Number($(e.currentTarget as Element).closest("tr").data("id")));
  },
  render() {
    const pending = ui.get("pending") as number[];
    const kind = (id: number) => parcels.get(id)?.get("kind") ?? "…";
    this.$("tbody.households").html(households.map((h: any) => rowTpl({ ...h.attributes, parcelKind: kind(h.get("parcel")), lock: PICKUP_GUARD && pending.includes(h.id) })).join(""));
    this.$("ul.stock").html(parcels.map((p: any) => stockTpl(p.attributes)).join(""));
    const pages = Math.max(1, Math.ceil(ui.get("total") / PER));
    this.$("nav.pages").html(_.range(1, pages + 1).map((p) => `<button type="button" data-page="${p}"${p === ui.get("page") ? ' class="current"' : ""}>${p}</button>`).join(""));
    this.$("button.no-show").prop("disabled", ui.get("bulkBusy") || !households.some((h: any) => h.get("status") === "waiting"));
    const err = ui.get("error");
    this.$(".msg").html(err ? `<p role="alert">${_.escape(err)}</p>` : ui.get("loading") ? `<p class="muted">Loading…</p>` : ui.get("notice") ? `<p class="notice">${_.escape(ui.get("notice"))}</p>` : "");
    return this;
  },
});
new View().render();
load(false);
loadStock();
setInterval(() => load(true), 6000);
// the local tally never asks the server again
setInterval(() => STOCK === "server" && loadStock(), 6000);
