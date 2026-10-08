// Branch library catalogue (Backbone.js 1.6 Models / Collections / Views with underscore templates; Backbone.sync
// over jQuery.ajax). The Backbone collections are the app's stores, registered with rt.guard (their own mutations
// are traced, a resync reloads them). Latent bugs by flag: catalogue fetches that race each other
// (fetchMode=reset: whichever response lands last fills the shelf; fetchMode=merge: fetch({remove:false}) keeps the
// books of earlier filters on the shelf), checkout / hold buttons that stay clickable while the non-idempotent POST
// is in flight (checkoutGuard=none), optimistic saves without rollback (save=optimistic: a renewal the server refused
// stays on screen, a loan the server never stored stays as a phantom), renew / return buttons without an in-flight
// guard (loanGuard=none: double returns, 409s on double renewals) and a loan counter kept by hand (counter=manual).
import Backbone from "backbone";
import _ from "underscore";
import $ from "jquery";
import { rt, flag } from "../_shared/genclass";

const FETCH = flag("fetchMode", "abort-previous") as "abort-previous" | "reset" | "merge";
const CHECKOUT_GUARD = flag("checkoutGuard", "disable") as "disable" | "none";
const SAVE = flag("save", "wait") as "wait" | "optimistic-rollback" | "optimistic";
const LOAN_GUARD = flag("loanGuard", "pending") as "pending" | "none";
const COUNTER = flag("counter", "listen") as "listen" | "manual";
const POLL_MS = Number(flag("pollMs", 6000));
const LOAN_DAYS = 21;
const RENEW_DAYS = 14;
const MAX_RENEWALS = 2;
const WAIT = SAVE === "wait";

(Backbone as any).$ = $;
const B = Backbone as any;

const Book = B.Model.extend({ defaults: { available: 0, copies: 1, holds: 0 } });
const Books = B.Collection.extend({ model: Book, url: "/api/books", comparator: "title", parse: (resp: any) => resp.items ?? resp });
const Loan = B.Model.extend({ defaults: { renewals: 0 } });
const Loans = B.Collection.extend({ model: Loan, url: "/api/loans", comparator: "due", parse: (resp: any) => resp.items ?? resp });

const books = new Books();
const loans = new Loans();
const shelf = new B.Model({ genre: "all", q: "", loading: true, error: "" });
const desk = new B.Model({ onLoan: 0, checkingOut: [] as number[], returning: [] as number[], renewing: [] as number[], error: "", notice: "" });

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const without = (key: string, id: number) => desk.set({ [key]: _.without(desk.get(key), id) });
const withId = (key: string, id: number) => desk.set({ [key]: [...desk.get(key), id] });

// --------------------------------------------------------------------------------------- GenClass stores
const watch = (fn: () => void, pairs: [any, string][]) => {
  for (const [obj, ev] of pairs) obj.on(ev, fn);
  return () => pairs.forEach(([obj, ev]) => obj.off(ev, fn));
};
rt.guard(
  "catalogue",
  {
    get: () => ({ ...shelf.toJSON(), books: books.toJSON() }),
    set: (v: any) => {
      shelf.set(_.pick(v, "genre", "q", "loading", "error"));
      books.set(v.books ?? []);
    },
    subscribe: (fn) => watch(fn, [[books, "update reset change sort"], [shelf, "change"]]),
  },
  { resync: () => refreshShelf(true) },
);
rt.guard(
  "desk",
  {
    get: () => ({ ...desk.toJSON(), loans: loans.toJSON() }),
    set: (v: any) => {
      desk.set(_.omit(v, "loans"));
      loans.set(v.loans ?? []);
    },
    subscribe: (fn) => watch(fn, [[loans, "update reset change sort"], [desk, "change"]]),
  },
  { resync: () => loans.fetch({ reset: true }) },
);

// ------------------------------------------------------------------------------------------ catalogue sync
let shelfXhr: any = null;

function refreshShelf(fromUser: boolean, patch: Record<string, string> = {}) {
  if (FETCH === "abort-previous" && shelfXhr) {
    // a background refresh never interrupts a running search; a new search replaces it
    if (!fromUser) return shelfXhr;
    shelfXhr.abort();
  }
  const { genre, q } = { ...shelf.attributes, ...patch };
  const data: Record<string, string> = { sort: "title", limit: "50" };
  if (genre !== "all") data.genre = genre;
  if (q.trim()) data.q = q.trim();
  shelf.set({ ...patch, loading: true, error: "" });
  const xhr = books.fetch({
    data,
    reset: FETCH === "reset",
    remove: FETCH !== "merge",
    success: () => {
      if (FETCH !== "abort-previous" || shelfXhr === xhr) shelf.set({ loading: false });
    },
    error: (_c: unknown, x: any) => {
      if (x.statusText === "abort") return;
      shelf.set({ loading: false, error: x.status === 0 ? "The catalogue is offline. Showing the last results." : `The catalogue could not be searched (${x.status}).` });
    },
  });
  shelfXhr = xhr;
  xhr.always(() => {
    if (shelfXhr === xhr) shelfXhr = null;
  });
  return xhr;
}

// ----------------------------------------------------------------------------------------- circulation
function failMsg(x: any, what: string) {
  if (x.status === 0) return `The library system is unreachable — ${what} did not go through.`;
  if (x.status === 409) return `Someone else changed this record — ${what} was not saved. Reloaded your loans.`;
  return `Sorry, ${what} failed (${x.status}). Please try again.`;
}

function checkout(id: number) {
  const book = books.get(id);
  if (!book || book.get("available") <= 0) return;
  if (CHECKOUT_GUARD === "disable" && desk.get("checkingOut").includes(id)) return;
  withId("checkingOut", id);
  desk.set({ error: "", notice: "" });
  const title = book.get("title");
  B.ajax({ url: `/api/books/${id}/checkout`, type: "POST", dataType: "json" })
    .done((saved: any) => {
      book.set(saved);
      if (COUNTER === "manual") desk.set({ onLoan: desk.get("onLoan") + 1 });
      loans.create(
        { bookId: id, title, due: addDays(today(), LOAN_DAYS) },
        {
          wait: WAIT,
          success: () => desk.set({ notice: `"${title}" is checked out to you.` }),
          error: (m: any, x: any) => {
            if (SAVE === "optimistic-rollback") loans.remove(m);
            desk.set({ error: failMsg(x, "recording the loan") });
          },
        },
      );
    })
    .fail((x: any) => desk.set({ error: failMsg(x, `checking out "${title}"`) }))
    .always(() => without("checkingOut", id));
}

function hold(id: number) {
  const book = books.get(id);
  if (!book) return;
  if (CHECKOUT_GUARD === "disable" && desk.get("checkingOut").includes(id)) return;
  withId("checkingOut", id);
  B.ajax({ url: `/api/books/${id}/hold`, type: "POST", dataType: "json" })
    .done((saved: any) => {
      book.set(saved);
      desk.set({ notice: `Hold placed on "${book.get("title")}". You are number ${saved.holds} in the queue.` });
    })
    .fail((x: any) => desk.set({ error: failMsg(x, "placing the hold") }))
    .always(() => without("checkingOut", id));
}

function renew(loanId: number) {
  const loan = loans.get(loanId);
  if (!loan || loan.get("renewals") >= MAX_RENEWALS) return;
  if (LOAN_GUARD === "pending" && desk.get("renewing").includes(loanId)) return;
  const prev = loan.toJSON();
  withId("renewing", loanId);
  desk.set({ error: "", notice: "" });
  loan.save(
    { renewals: loan.get("renewals") + 1, due: addDays(loan.get("due"), RENEW_DAYS) },
    {
      wait: WAIT,
      success: () => {
        without("renewing", loanId);
        desk.set({ notice: `Renewed "${loan.get("title")}" until ${loan.get("due")}.` });
      },
      error: (_m: any, x: any) => {
        without("renewing", loanId);
        if (SAVE === "optimistic-rollback") loan.set(prev);
        desk.set({ error: failMsg(x, "the renewal") });
        if (x.status === 409) loan.fetch();
      },
    },
  );
}

function giveBack(loanId: number) {
  const loan = loans.get(loanId);
  if (!loan || loan.isNew()) return;
  if (LOAN_GUARD === "pending" && desk.get("returning").includes(loanId)) return;
  const bookId = loan.get("bookId");
  withId("returning", loanId);
  desk.set({ error: "", notice: "" });
  B.ajax({ url: `/api/books/${bookId}/return`, type: "POST", dataType: "json" })
    .done((saved: any) => {
      books.get(bookId)?.set(saved);
      if (COUNTER === "manual") desk.set({ onLoan: Math.max(0, desk.get("onLoan") - 1) });
      loan.destroy({
        wait: WAIT,
        success: () => desk.set({ notice: `Returned "${loan.get("title")}". Thank you!` }),
        error: (m: any, x: any) => {
          if (SAVE === "optimistic-rollback" && !loans.get(m.id)) loans.add(m);
          desk.set({ error: failMsg(x, "closing the loan") });
        },
      });
    })
    .fail((x: any) => desk.set({ error: failMsg(x, "the return") }))
    .always(() => without("returning", loanId));
}

if (COUNTER === "listen") desk.listenTo(loans, "update reset", () => desk.set({ onLoan: loans.length }));

// ---------------------------------------------------------------------------------------------- views
$("#app").html(`
  <header class="masthead"><h1>Riverside Branch Library</h1><p class="tagline">Catalogue · My account</p></header>
  <section class="search">
    <label>Genre <select name="genre"><option value="all">All genres</option><option value="fiction">Fiction</option><option value="mystery">Mystery</option><option value="history">History</option><option value="science">Science</option><option value="children">Children</option></select></label>
    <input name="q" placeholder="Title or author" aria-label="Search the catalogue"> <button type="button" class="clear-q">Clear</button>
    <button type="button" class="refresh">Refresh availability</button>
    <span class="shelf-status"></span>
  </section>
  <div class="shelf-error"></div>
  <ul id="shelf" class="books"></ul>
  <aside id="account"><h2>My loans (<span class="on-loan">0</span>)</h2><div class="desk-msg"></div><ul id="loans"></ul></aside>`);

const bookTpl = _.template(
  `<li class="book" data-id="<%- id %>"><strong class="title"><%- title %></strong> <span class="author">by <%- author %></span> · <span class="genre"><%- genre %></span> · ` +
    `<span class="avail"><% if (available > 0) { %><%- available %> of <%- copies %> available<% } else { %>All copies on loan<% } %><% if (holds > 0) { %>, <%- holds %> hold(s)<% } %></span> ` +
    `<% if (available > 0) { %><button type="button" class="checkout"<%= busy ? " disabled" : "" %>><%= busy ? "Checking out…" : "Check out" %></button><% } else { %><button type="button" class="hold"<%= busy ? " disabled" : "" %>>Place hold</button><% } %></li>`,
);
const loanTpl = _.template(
  `<li class="loan" data-id="<%- id %>"><span class="title"><%- title %></span> — due <%- due %><% if (renewals > 0) { %> (renewed <%- renewals %>×)<% } %><% if (!id) { %> <em>saving…</em><% } %> ` +
    `<button type="button" class="renew"<%= renewals >= max || renewing ? " disabled" : "" %>><%= renewing ? "Renewing…" : "Renew" %></button> <button type="button" class="return"<%= returning ? " disabled" : "" %>>Return</button></li>`,
);

const ShelfView = B.View.extend({
  el: "#shelf",
  events: { "click button.checkout": "onCheckout", "click button.hold": "onHold" },
  initialize() {
    this.listenTo(books, "update reset change sort", this.render);
    this.listenTo(desk, "change:checkingOut", this.render);
  },
  idOf(e: Event) {
    return Number($(e.currentTarget as Element).closest("li.book").data("id"));
  },
  onCheckout(e: Event) {
    checkout(this.idOf(e));
  },
  onHold(e: Event) {
    hold(this.idOf(e));
  },
  render() {
    const busy = CHECKOUT_GUARD === "disable" ? desk.get("checkingOut") : [];
    this.$el.html(books.map((b: any) => bookTpl({ ...b.toJSON(), busy: busy.includes(b.id) })).join("") || `<li class="muted">No books match your search.</li>`);
    return this;
  },
});

const LoansView = B.View.extend({
  el: "#loans",
  events: { "click button.renew": "onRenew", "click button.return": "onReturn" },
  initialize() {
    this.listenTo(loans, "update reset change sort", this.render);
    this.listenTo(desk, "change", this.render);
  },
  idOf(e: Event) {
    return Number($(e.currentTarget as Element).closest("li.loan").data("id"));
  },
  onRenew(e: Event) {
    renew(this.idOf(e));
  },
  onReturn(e: Event) {
    giveBack(this.idOf(e));
  },
  render() {
    const guard = LOAN_GUARD === "pending";
    const rows = loans.map((l: any) => loanTpl({ ...l.toJSON(), id: l.id ?? "", max: MAX_RENEWALS, renewing: guard && desk.get("renewing").includes(l.id), returning: guard && desk.get("returning").includes(l.id) }));
    this.$el.html(rows.join("") || `<li class="muted">You have nothing on loan.</li>`);
    $(".on-loan").text(String(desk.get("onLoan")));
    const err = desk.get("error");
    $(".desk-msg").html(err ? `<p role="alert">${_.escape(err)}</p>` : desk.get("notice") ? `<p class="notice">${_.escape(desk.get("notice"))}</p>` : "");
    return this;
  },
});

const SearchView = B.View.extend({
  el: "section.search",
  events: { "change select[name=genre]": "onGenre", "input input[name=q]": "onQuery", "click button.refresh": "onRefresh", "click button.clear-q": "onClear" },
  initialize() {
    this.debouncedSearch = _.debounce(() => refreshShelf(true), 300);
    this.listenTo(shelf, "change", this.renderStatus);
    this.listenTo(books, "update reset", this.renderStatus);
  },
  onGenre(e: Event) {
    refreshShelf(true, { genre: (e.target as HTMLSelectElement).value });
  },
  onQuery(e: Event) {
    shelf.set({ q: (e.target as HTMLInputElement).value });
    this.debouncedSearch();
  },
  onRefresh() {
    refreshShelf(true);
  },
  onClear() {
    this.$("input[name=q]").val("");
    this.debouncedSearch.cancel();
    refreshShelf(true, { q: "" });
  },
  renderStatus() {
    this.$(".shelf-status").text(shelf.get("loading") ? "Searching the catalogue…" : `${books.length} title(s)`);
    $(".shelf-error").html(shelf.get("error") ? `<p role="alert">${_.escape(shelf.get("error"))}</p>` : "");
  },
});

new ShelfView().render();
new LoansView().render();
new SearchView().renderStatus();

$(() => {
  refreshShelf(true);
  loans.fetch({
    reset: true,
    success: () => {
      if (COUNTER === "manual") desk.set({ onLoan: loans.length });
    },
    error: () => desk.set({ error: "Your loans could not be loaded." }),
  });
  setInterval(() => refreshShelf(false), POLL_MS);
});
