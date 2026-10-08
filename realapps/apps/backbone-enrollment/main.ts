// University course registration (Backbone.js 1.6 collections + a view with underscore templates; Backbone.sync /
// jQuery.ajax). Cascading pickers: faculty → department → course (each list fetched when its parent changes, the first
// entry picked automatically) → the course's sections with remaining seats. Enrolling is POST /enrollments (one per
// student and course) then POST /sections/:id/take; dropping deletes the enrollment and gives the seat back. Seat counts
// change as other students register, so the sections poll. The UI model and the collections are registered with
// rt.guard. Latent bugs by flag: picker fetches that never abort the previous one (cascade=blind: a slow answer for the
// faculty you left fills the pickers and the sections table), Enroll buttons live while posting (enrollGuard=none: the
// second POST answers 409), seats decremented locally instead of taken from the server's answer (seats=local), drops
// shown at once and never undone when they fail (drop=optimistic-no-rollback) and credits adjusted by hand
// (credits=incremental).
import Backbone from "backbone";
import _ from "underscore";
import $ from "jquery";
import { rt, flag } from "../_shared/genclass";

const CASCADE = flag("cascade", "abort-stale");
const ENROLL_GUARD = flag("enrollGuard", "pending") === "pending";
const SEATS = flag("seats", "echo");
const DROP = flag("drop", "pessimistic");
const CREDITS = flag("credits", "derive");
const ME = "you";

(Backbone as any).$ = $;
const B = Backbone as any;
const parse = (r: any) => r.items ?? r;
const depts = new (B.Collection.extend({ url: "/api/departments", parse }))();
const courses = new (B.Collection.extend({ url: "/api/courses", parse }))();
const sections = new (B.Collection.extend({ url: "/api/sections", parse, comparator: "code" }))();
const mine = new (B.Collection.extend({ url: "/api/enrollments", parse, comparator: "courseCode" }))();
const ui = new B.Model({ faculty: "Mathematics", dept: "", course: 0, loading: true, pending: [] as number[], credits: 0, error: "", notice: "" });
const creditsOf = () => Math.round(mine.reduce((a: number, e: any) => a + Number(e.get("credits")), 0) * 100) / 100;
const pend = (id: number, on: boolean) => ui.set({ pending: on ? [...ui.get("pending"), id] : _.without(ui.get("pending"), id) });
const fail = (x: any, what: string) => ui.set({ error: `${what} failed (${x?.status || "offline"}).` });

rt.guard(
  "registration",
  {
    get: () => ({ ...ui.toJSON(), depts: depts.toJSON(), courses: courses.toJSON(), sections: sections.toJSON(), mine: mine.toJSON() }),
    set: (v: any) => {
      ui.set(_.omit(v, "depts", "courses", "sections", "mine"));
      depts.set(v.depts ?? []);
      courses.set(v.courses ?? []);
      sections.set(v.sections ?? []);
      mine.set(v.mine ?? []);
    },
    subscribe: (fn) => {
      const all = [depts, courses, sections, mine];
      all.forEach((c) => c.on("update reset change sort", fn));
      ui.on("change", fn);
      return () => {
        all.forEach((c) => c.off("update reset change sort", fn));
        ui.off("change", fn);
      };
    },
  },
  { resync: () => loadSections(true) },
);
if (CREDITS === "derive") ui.listenTo(mine, "reset update change", () => ui.set({ credits: creditsOf() }));

// ------------------------------------------------------------------------------------------- cascade
const xhrs: Record<string, any> = {};
function fetchInto(level: string, coll: any, data: Record<string, unknown>, done: () => void) {
  if (CASCADE === "abort-stale") xhrs[level]?.abort();
  const mineXhr = (xhrs[level] = coll.fetch({ data, reset: true }));
  mineXhr
    .done(() => {
      if (CASCADE === "abort-stale" && xhrs[level] !== mineXhr) return;
      done();
    })
    .fail((x: any) => {
      if (x.statusText !== "abort") {
        ui.set({ loading: false });
        fail(x, `Loading ${level}`);
      }
    });
}
function pickFaculty(faculty: string) {
  ui.set({ faculty, loading: true, error: "", notice: "" });
  fetchInto("departments", depts, { faculty, sort: "code" }, () => pickDept(depts.first()?.get("code") ?? ""));
}
function pickDept(dept: string) {
  ui.set({ dept, loading: true });
  fetchInto("courses", courses, { dept, sort: "code" }, () => pickCourse(Number(courses.first()?.id ?? 0)));
}
function pickCourse(course: number) {
  ui.set({ course, loading: true });
  if (!course) return void (sections.reset([]), ui.set({ loading: false }));
  fetchInto("sections", sections, { courseId: course, limit: 20 }, () => ui.set({ loading: false }));
}
function loadSections(background: boolean) {
  const course = ui.get("course");
  if (!course || (background && (ui.get("loading") || ui.get("pending").length))) return;
  $.ajax({ url: "/api/sections", data: { courseId: course, limit: 20 }, dataType: "json" }).done((r: any) => {
    if (ui.get("course") === course && !ui.get("pending").length) sections.set(parse(r));
  });
}

// ------------------------------------------------------------------------------------------- writes
const post = (url: string, body: unknown = {}) => $.ajax({ url, method: "POST", contentType: "application/json", data: JSON.stringify(body), dataType: "json" });
function enroll(id: number) {
  const s = sections.get(id);
  const c = courses.get(s?.get("courseId"));
  if (!s || !c || (ENROLL_GUARD && ui.get("pending").includes(id))) return;
  pend(id, true);
  ui.set({ error: "", notice: "" });
  post("/api/enrollments", { student: ME, sectionId: id, courseId: c.id, courseCode: c.get("code"), title: c.get("title"), section: `${s.get("kind")} ${s.get("code")}`, time: s.get("time"), credits: c.get("credits"), key: `${ME}|${c.id}` })
    .then((e: any) =>
      post(`/api/sections/${id}/take`).then((saved: any) => {
        mine.add(e);
        if (CREDITS === "incremental") ui.set({ credits: Math.round((ui.get("credits") + Number(c.get("credits"))) * 100) / 100 });
        if (SEATS === "echo") sections.get(id)?.set(saved);
        else sections.get(id)?.set({ seats: s.get("seats") - 1 });
        ui.set({ notice: `Enrolled in ${c.get("code")} ${s.get("kind")} ${s.get("code")}.` });
      }, (x: any) => {
        $.ajax({ url: `/api/enrollments/${e.id}`, method: "DELETE" });
        return $.Deferred().reject(x).promise();
      }),
    )
    .fail((x: any) => (x?.status === 409 ? ui.set({ error: `You are already enrolled in ${c.get("code")}.` }) : fail(x, `Enrolling in ${c.get("code")}`)))
    .always(() => pend(id, false));
}
function drop(id: number) {
  const e = mine.get(id);
  if (!e || ui.get("pending").includes(-id)) return;
  pend(-id, true);
  ui.set({ error: "", notice: "" });
  if (DROP === "optimistic-no-rollback") mine.remove(e);
  if (CREDITS === "incremental") ui.set({ credits: Math.round((ui.get("credits") - Number(e.get("credits"))) * 100) / 100 });
  $.ajax({ url: `/api/enrollments/${id}`, method: "DELETE" })
    .then(() => post(`/api/sections/${e.get("sectionId")}/release`))
    .done((saved: any) => {
      mine.remove(e);
      sections.get(saved?.id)?.set(saved);
      ui.set({ notice: `Dropped ${e.get("courseCode")}.` });
    })
    .fail((x: any) => fail(x, `Dropping ${e.get("courseCode")}`))
    .always(() => pend(-id, false));
}

// ------------------------------------------------------------------------------------------- view
$("#app").html(`<h1>Course registration · Fall 2026</h1>
  <div class="pickers"><select name="faculty"><option>Mathematics</option><option>Engineering</option><option>Arts</option></select>
    <select name="dept"></select> <select name="course"></select></div>
  <div class="msg"></div><p class="status"></p>
  <table class="sections"><tbody></tbody></table>
  <h2>My schedule <span class="credits"></span></h2><ul class="schedule"></ul>`);
const rowTpl = _.template(`<tr class="section" data-id="<%- id %>"><td><%- kind %> <%- code %></td><td><%- time %></td><td><%- instructor %></td><td><%- seats %> of <%- cap %> seats left</td>
  <td><button type="button" class="enroll"<%= seats <= 0 || lock ? " disabled" : "" %>><%= busy ? "Enrolling…" : "Enroll" %></button></td></tr>`);
const mineTpl = _.template(`<li class="enrolled" data-id="<%- id %>"><strong><%- courseCode %></strong> <%- title %> · <%- section %> · <%- time %> · <%- credits %> cr
  <button type="button" class="drop"<%= busy ? " disabled" : "" %>>Drop</button></li>`);
const View = B.View.extend({
  el: "#app",
  events: {
    "change select[name=faculty]": (e: Event) => pickFaculty((e.target as HTMLSelectElement).value),
    "change select[name=dept]": (e: Event) => pickDept((e.target as HTMLSelectElement).value),
    "change select[name=course]": (e: Event) => pickCourse(Number((e.target as HTMLSelectElement).value)),
    "click tr.section button.enroll": (e: Event) => enroll(Number($(e.currentTarget as Element).closest("tr").data("id"))),
    "click li.enrolled button.drop": (e: Event) => drop(Number($(e.currentTarget as Element).closest("li").data("id"))),
  },
  initialize() {
    [depts, courses, sections, mine].forEach((c) => this.listenTo(c, "reset update change sort", this.render));
    this.listenTo(ui, "change", this.render);
  },
  render() {
    const pending = ui.get("pending") as number[];
    this.$("select[name=faculty]").val(ui.get("faculty"));
    this.$("select[name=dept]").html(depts.map((d: any) => `<option value="${_.escape(d.get("code"))}">${_.escape(d.get("code"))} · ${_.escape(d.get("name"))}</option>`).join("")).val(ui.get("dept"));
    this.$("select[name=course]").html(courses.map((c: any) => `<option value="${c.id}">${_.escape(c.get("code"))} · ${_.escape(c.get("title"))}</option>`).join("")).val(String(ui.get("course")));
    this.$("tbody").html(sections.map((s: any) => rowTpl({ ...s.toJSON(), busy: pending.includes(s.id), lock: ENROLL_GUARD && pending.includes(s.id) })).join(""));
    this.$("ul.schedule").html(mine.map((e: any) => mineTpl({ ...e.toJSON(), busy: pending.includes(-e.id) })).join(""));
    this.$(".credits").text(`(${ui.get("credits")} credits)`);
    this.$(".status").text(ui.get("loading") ? "Loading…" : `${sections.length} sections`);
    const err = ui.get("error");
    this.$(".msg").html(err ? `<p role="alert">${_.escape(err)}</p>` : ui.get("notice") ? `<p class="notice">${_.escape(ui.get("notice"))}</p>` : "");
    return this;
  },
});
new View().render();
pickFaculty("Mathematics");
mine.fetch({ data: { student: ME, limit: 20 }, reset: true }).done(() => CREDITS === "incremental" && ui.set({ credits: creditsOf() }));
setInterval(() => loadSections(true), 7000);
