// Wedding RSVP manager for the couple (Backbone.js 1.6 collection + view, underscore templates, Backbone.sync over
// jQuery.ajax; the collection and a UI model are registered with rt.guard). Guests page by 6 with a bride/groom filter;
// the couple records RSVPs by phone (model.save, wait: true), adjusts plus-ones (POST /guests/:id/plus|minus: relative)
// and nudges everyone still pending on the page (POST /guests/bulk, per-item results). Guests also answer online, so
// the page refreshes. Latent bugs by flag: RSVPs saved with a full PUT of the model as loaded (save=put: a meal choice
// the guest made online meanwhile is overwritten), plus/minus buttons live while posting (plusGuard=none: the
// max-2 check reads a stale count), a headcount adjusted by hand at click time and never undone (headcount=manual),
// page fetches that don't abort the previous one (fetch=none: the slower page wins) and bulk results ignored
// (remind=assume-all: guests the server could not mark still show "reminded").
import Backbone from "backbone";
import _ from "underscore";
import $ from "jquery";
import { rt, flag } from "../_shared/genclass";

const SAVE = flag("save", "patch");
const PLUS_GUARD = flag("plusGuard", "pending") === "pending";
const HEADCOUNT = flag("headcount", "listen");
const FETCH = flag("fetch", "abort-previous");
const REMIND = flag("remind", "per-item");
const PER = 6;
const MAX_PLUS = 2;

(Backbone as any).$ = $;
const B = Backbone as any;
const Guest = B.Model.extend({ urlRoot: "/api/guests" });
const Guests = B.Collection.extend({ model: Guest, url: "/api/guests", parse: (r: any) => r.items ?? r });
const guests = new Guests();
const ui = new B.Model({ side: "all", page: 1, total: 0, attending: 0, loading: true, pending: [] as number[], reminding: false, error: "", notice: "" });
const attendingOf = () => guests.filter((g: any) => g.get("rsvp") === "yes").reduce((a: number, g: any) => a + 1 + Number(g.get("plusOnes")), 0);
const pend = (id: number, on: boolean) => ui.set({ pending: on ? [...ui.get("pending"), id] : _.without(ui.get("pending"), id) });

rt.guard(
  "rsvp",
  {
    get: () => ({ ...ui.toJSON(), guests: guests.toJSON() }),
    set: (v: any) => {
      ui.set(_.omit(v, "guests"));
      guests.set(v.guests ?? []);
    },
    subscribe: (fn) => {
      guests.on("update reset change", fn);
      ui.on("change", fn);
      return () => {
        guests.off("update reset change", fn);
        ui.off("change", fn);
      };
    },
  },
  { resync: () => load(false) },
);
if (HEADCOUNT === "listen") ui.listenTo(guests, "reset update change:rsvp change:plusOnes", () => ui.set({ attending: attendingOf() }));

let xhr: any = null;
function load(background: boolean) {
  if (xhr && background) return;
  if (xhr && FETCH === "abort-previous") xhr.abort();
  const data = { page: ui.get("page"), limit: PER, ...(ui.get("side") === "all" ? {} : { side: ui.get("side") }) };
  if (!background) ui.set({ loading: true, error: "" });
  const mine = (xhr = $.ajax({ url: "/api/guests", data, dataType: "json" }));
  mine
    .done((r: any) => {
      const items = (r.items ?? []).map((g: any) => (ui.get("pending").includes(g.id) ? (guests.get(g.id)?.toJSON() ?? g) : g));
      if (background) guests.set(items);
      else guests.reset(items);
      ui.set({ total: Number(r.total ?? items.length), loading: false, ...(HEADCOUNT === "manual" ? { attending: attendingOf() } : {}) });
    })
    .fail((x: any) => {
      if (x.statusText !== "abort" && !background) ui.set({ loading: false, error: `The guest list could not be loaded (${x.status || "offline"}).` });
    })
    .always(() => {
      if (xhr === mine) xhr = null;
    });
}

function setRsvp(id: number, value: string) {
  const g = guests.get(id);
  if (!g || ui.get("pending").includes(id)) return;
  const prev = g.get("rsvp");
  if (HEADCOUNT === "manual") ui.set({ attending: ui.get("attending") + (value === "yes" && prev !== "yes" ? 1 + g.get("plusOnes") : prev === "yes" && value !== "yes" ? -(1 + g.get("plusOnes")) : 0) });
  pend(id, true);
  ui.set({ error: "", notice: "" });
  g.save({ rsvp: value }, {
    wait: true,
    ...(SAVE === "patch" ? { patch: true } : {}),
    success: () => ui.set({ notice: `${g.get("name")}: ${value}.` }),
    error: (_m: any, x: any) => {
      ui.set({ error: `${g.get("name")}'s RSVP was not saved (${x.status || "offline"}).` });
      view.render();
    },
  }).always(() => pend(id, false));
}

function bump(id: number, dir: 1 | -1) {
  const g = guests.get(id);
  if (!g || (PLUS_GUARD && ui.get("pending").includes(id))) return;
  const n = Number(g.get("plusOnes"));
  if ((dir > 0 && n >= MAX_PLUS) || (dir < 0 && n <= 0)) return;
  if (HEADCOUNT === "manual" && g.get("rsvp") === "yes") ui.set({ attending: ui.get("attending") + dir });
  pend(id, true);
  ui.set({ error: "", notice: "" });
  $.ajax({ url: `/api/guests/${id}/${dir > 0 ? "plus" : "minus"}`, method: "POST", contentType: "application/json", data: "{}", dataType: "json" })
    .done((saved: any) => g.set(saved))
    .fail((x: any) => ui.set({ error: `Plus-ones for ${g.get("name")} were not updated (${x.status || "offline"}).` }))
    .always(() => pend(id, false));
}

function remindAll() {
  const ids = guests.filter((g: any) => g.get("rsvp") === "pending" && !g.get("reminded")).map((g: any) => g.id);
  if (!ids.length || ui.get("reminding")) return;
  ui.set({ reminding: true, error: "", notice: "" });
  $.ajax({ url: "/api/guests/bulk", method: "POST", contentType: "application/json", data: JSON.stringify({ ids, op: "patch", patch: { reminded: true } }), dataType: "json" })
    .done((r: any) => {
      const results: { id: number; ok: boolean }[] = r.results ?? [];
      const ok = REMIND === "per-item" ? results.filter((x) => x.ok).map((x) => Number(x.id)) : ids;
      ok.forEach((id: number) => guests.get(id)?.set({ reminded: true }));
      const failed = ids.length - results.filter((x) => x.ok).length;
      ui.set({ notice: `Sent ${ok.length} reminder(s).`, error: REMIND === "per-item" && failed ? `${failed} reminder(s) could not be sent.` : "" });
    })
    .fail((x: any) => ui.set({ error: `Reminders failed (${x.status || "offline"}).` }))
    .always(() => ui.set({ reminding: false }));
}

$("#app").html(`<header><h1>Wedding RSVPs</h1><p class="headcount"></p></header>
  <div class="toolbar"><label>Side <select name="side"><option value="all">Everyone</option><option value="bride">Bride's side</option><option value="groom">Groom's side</option></select></label>
    <button type="button" class="remind-all">Remind pending guests</button></div>
  <div class="msg"></div><ul class="guests"></ul><nav class="pages"></nav>`);
const tpl = _.template(`<li class="guest <%- rsvp %>" data-id="<%- id %>"><strong><%- name %></strong> · <%- side %> · <%- meal %>
  <select class="rsvp"<%= busy ? " disabled" : "" %>><% _.each(["pending", "yes", "no", "maybe"], function (o) { %><option value="<%- o %>"<%= o === rsvp ? " selected" : "" %>><%- o %></option><% }); %></select>
  · +<%- plusOnes %> <button type="button" class="minus"<%= plusOnes <= 0 || lock ? " disabled" : "" %>>−</button><button type="button" class="plus"<%= lock ? " disabled" : "" %>>+</button><% if (reminded) { %> · reminded<% } %></li>`);

const View = B.View.extend({
  el: "#app",
  events: {
    "change select[name=side]": "onSide",
    "click nav.pages button": "onPage",
    "change li.guest select.rsvp": "onRsvp",
    "click li.guest button.plus": "onPlus",
    "click li.guest button.minus": "onMinus",
    "click button.remind-all": () => remindAll(),
  },
  initialize() {
    this.listenTo(guests, "reset update change", this.render);
    this.listenTo(ui, "change", this.render);
  },
  idOf: (e: Event) => Number($(e.currentTarget as Element).closest("li").data("id")),
  onSide(e: Event) {
    ui.set({ side: (e.target as HTMLSelectElement).value, page: 1, notice: "" });
    load(false);
  },
  onPage(e: Event) {
    ui.set({ page: Number($(e.currentTarget as Element).data("page")) });
    load(false);
  },
  onRsvp(e: Event) {
    setRsvp(this.idOf(e), (e.target as HTMLSelectElement).value);
  },
  onPlus(e: Event) {
    bump(this.idOf(e), 1);
  },
  onMinus(e: Event) {
    bump(this.idOf(e), -1);
  },
  render() {
    const pending = ui.get("pending") as number[];
    this.$("ul.guests").html(guests.map((g: any) => tpl({ ...g.toJSON(), busy: pending.includes(g.id), lock: PLUS_GUARD && pending.includes(g.id) })).join(""));
    const pages = Math.max(1, Math.ceil(ui.get("total") / PER));
    this.$("nav.pages").html(_.range(1, pages + 1).map((p) => `<button type="button" data-page="${p}"${p === ui.get("page") ? ' class="current"' : ""}>${p}</button>`).join(""));
    this.$(".headcount").text(ui.get("loading") ? "Loading…" : `${ui.get("attending")} attending on this page · ${ui.get("total")} invited`);
    this.$("button.remind-all").prop("disabled", ui.get("reminding") || !guests.some((g: any) => g.get("rsvp") === "pending" && !g.get("reminded")));
    const err = ui.get("error");
    this.$(".msg").html(err ? `<p role="alert">${_.escape(err)}</p>` : ui.get("notice") ? `<p class="notice">${_.escape(ui.get("notice"))}</p>` : "");
    return this;
  },
});
const view = new View().render();
load(false);
setInterval(() => load(true), 6000);
