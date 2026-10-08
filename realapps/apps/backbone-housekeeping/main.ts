// Hotel housekeeping board (Backbone 1.6 models/collection/views + underscore templates; Backbone.sync over
// jQuery.ajax; the collection is registered with rt.guard). Attendants move rooms through dirty → cleaning → clean
// → inspected; the front desk turns inspected rooms back to dirty as guests check out. Supply requests are POSTed and
// retried once on a gateway error. Latent bugs by flag: optimistic status saves without rollback (save=optimistic),
// the next-step button live while a save is in flight (stepGuard=none: a double click skips a stage), retries
// without an Idempotency-Key (supplyKey=none: a request that committed before the 5xx is created twice) and a dirty
// counter adjusted by hand (counts=manual).
import Backbone from "backbone";
import _ from "underscore";
import $ from "jquery";
import { rt, flag } from "../_shared/genclass";

const SAVE = flag("save", "wait");
const STEP_GUARD = flag("stepGuard", "pending") === "pending";
const SUPPLY_KEY = flag("supplyKey", "idempotency-key");
const COUNTS = flag("counts", "listen");
const POLL_MS = Number(flag("pollMs", 5000));
const NEXT: Record<string, string> = { dirty: "cleaning", cleaning: "clean", clean: "inspected" };
const LABEL: Record<string, string> = { dirty: "Start cleaning", cleaning: "Mark clean", clean: "Inspect" };

(Backbone as any).$ = $;
const B = Backbone as any;
const Room = B.Model.extend({});
const Rooms = B.Collection.extend({ model: Room, url: "/api/rooms", comparator: "number", parse: (r: any) => r.items ?? r });
const rooms = new Rooms();
const ui = new B.Model({ floor: "all", dirty: 0, loading: true, pending: [] as number[], error: "", notice: "" });
const countDirty = () => rooms.filter((r: any) => r.get("status") === "dirty").length;

rt.guard(
  "board",
  {
    get: () => ({ ...ui.toJSON(), rooms: rooms.toJSON() }),
    set: (v: any) => {
      ui.set(_.omit(v, "rooms"));
      rooms.set(v.rooms ?? []);
    },
    subscribe: (fn) => {
      rooms.on("update reset change sort", fn);
      ui.on("change", fn);
      return () => {
        rooms.off("update reset change sort", fn);
        ui.off("change", fn);
      };
    },
  },
  { resync: () => load(false) },
);

let xhr: any = null;
function load(background: boolean) {
  if (xhr) {
    if (background) return;
    xhr.abort();
  }
  const floor = ui.get("floor");
  if (!background) ui.set({ loading: true, error: "" });
  const pending = ui.get("pending") as number[];
  const keep = pending.map((id) => rooms.get(id)?.toJSON()).filter(Boolean);
  const mine = (xhr = rooms.fetch({
    data: floor === "all" ? { limit: 40 } : { floor, limit: 40 },
    success: () => {
      for (const k of keep) rooms.get(k.id)?.set(k); // rooms with a save in flight keep their local status
      ui.set({ loading: false, ...(COUNTS === "listen" || !background ? { dirty: countDirty() } : {}) });
    },
    error: (_c: unknown, x: any) => {
      if (x.statusText !== "abort") ui.set({ loading: false, error: background ? ui.get("error") : `Rooms could not be loaded (${x.status}).` });
    },
  }));
  mine.always(() => {
    if (xhr === mine) xhr = null;
  });
}

function step(id: number) {
  const room = rooms.get(id);
  const next = room && NEXT[room.get("status")];
  if (!next) return;
  if (STEP_GUARD && ui.get("pending").includes(id)) return;
  const prev = room.get("status");
  ui.set({ pending: [...ui.get("pending"), id], error: "", notice: "" });
  if (COUNTS === "manual") ui.set({ dirty: ui.get("dirty") - (prev === "dirty" ? 1 : 0) });
  room.save(
    { status: next, attendant: next === "cleaning" ? "You" : room.get("attendant") },
    {
      patch: true,
      wait: SAVE === "wait",
      success: () => ui.set({ notice: `Room ${room.get("number")} is now ${room.get("status")}.` }),
      error: (_m: any, x: any) => {
        if (SAVE === "wait" && COUNTS === "manual" && prev === "dirty") ui.set({ dirty: ui.get("dirty") + 1 });
        ui.set({ error: x.status === 0 ? `Offline — room ${room.get("number")} was not updated.` : `Room ${room.get("number")} could not be updated (${x.status}).` });
      },
    },
  ).always(() => ui.set({ pending: _.without(ui.get("pending"), id) }));
}

function requestSupply(item: string, $btn: JQuery) {
  $btn.prop("disabled", true);
  const key = SUPPLY_KEY === "idempotency-key" ? `sup-${item}-${Date.now()}` : "";
  const send = () => $.ajax({ url: "/api/supplies", method: "POST", contentType: "application/json", data: JSON.stringify({ item, floor: ui.get("floor") }), dataType: "json", headers: key ? { "Idempotency-Key": key } : {} });
  send()
    .catch((x: any) => (x.status >= 502 && x.status <= 504 ? send() : $.Deferred().reject(x)))
    .then(() => ui.set({ notice: `Requested ${item} for floor ${ui.get("floor")}.`, error: "" }))
    .fail((x: any) => ui.set({ error: `Supply request failed (${x.status}).` }))
    .always(() => $btn.prop("disabled", false));
}

if (COUNTS === "listen") ui.listenTo(rooms, "update reset change:status", () => ui.set({ dirty: countDirty() }));

$("#app").html(`<header><h1>Housekeeping</h1><label>Floor <select name="floor"><option value="all">All floors</option><option value="2">Floor 2</option><option value="3">Floor 3</option></select></label>
  <span class="counts"></span></header><div class="msg"></div><ul class="rooms"></ul>
  <form class="supplies"><select name="item"><option>towels</option><option>linen</option><option>toiletries</option><option>minibar</option></select> <button type="button" class="request">Request supplies</button></form>`);
const tpl = _.template(`<li class="room <%- status %>" data-id="<%- id %>"><strong><%- number %></strong> <%- status %><% if (attendant) { %> · <%- attendant %><% } %><% if (checkout) { %> · checkout<% } %>
  <% if (label) { %><button type="button" class="next"<%= busy ? " disabled" : "" %>><%- label %></button><% } %></li>`);

const BoardView = B.View.extend({
  el: "#app",
  events: { "click li.room button.next": "onNext", "change select[name=floor]": "onFloor", "click button.request": "onSupply" },
  initialize() {
    this.listenTo(rooms, "update reset change sort", this.render);
    this.listenTo(ui, "change", this.render);
  },
  onNext(e: Event) {
    step(Number($(e.currentTarget as Element).closest("li").data("id")));
  },
  onFloor(e: Event) {
    ui.set({ floor: (e.target as HTMLSelectElement).value });
    load(false);
  },
  onSupply(e: Event) {
    requestSupply(String(this.$("select[name=item]").val()), $(e.currentTarget as Element));
  },
  render() {
    const pend = STEP_GUARD ? ui.get("pending") : [];
    this.$("ul.rooms").html(rooms.map((r: any) => tpl({ ...r.toJSON(), label: LABEL[r.get("status")] ?? "", busy: pend.includes(r.id) })).join(""));
    this.$(".counts").text(ui.get("loading") ? "Loading…" : `${ui.get("dirty")} room(s) waiting to be cleaned`);
    const err = ui.get("error");
    this.$(".msg").html(err ? `<p role="alert">${_.escape(err)}</p>` : ui.get("notice") ? `<p class="notice">${_.escape(ui.get("notice"))}</p>` : "");
  },
});
new BoardView().render();
load(false);
setInterval(() => load(true), POLL_MS);
