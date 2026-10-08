import type { AppManifest } from "../../src/shared/manifest.js";

const departments = [
  ["CS", "Computer Science", "Mathematics"], ["STAT", "Statistics", "Mathematics"], ["PMATH", "Pure Mathematics", "Mathematics"],
  ["ECE", "Electrical and Computer Engineering", "Engineering"], ["SYDE", "Systems Design Engineering", "Engineering"],
  ["ECON", "Economics", "Arts"], ["PSYCH", "Psychology", "Arts"], ["HIST", "History", "Arts"],
].map(([code, name, faculty], i) => ({ id: 300 + i, code, name, faculty }));

const courseRows: [string, string, string][] = [
  ["CS", "CS 241", "Foundations of Sequential Programs"], ["CS", "CS 341", "Algorithms"], ["CS", "CS 349", "User Interfaces"],
  ["STAT", "STAT 230", "Probability"], ["STAT", "STAT 341", "Computational Statistics"], ["PMATH", "PMATH 347", "Groups and Rings"],
  ["ECE", "ECE 222", "Digital Computers"], ["ECE", "ECE 358", "Computer Networks"], ["SYDE", "SYDE 322", "Software Design"],
  ["ECON", "ECON 201", "Microeconomic Theory"], ["ECON", "ECON 306", "Labour Economics"], ["PSYCH", "PSYCH 207", "Cognitive Processes"],
  ["PSYCH", "PSYCH 256", "Introduction to Cognitive Science"], ["HIST", "HIST 216", "Medieval Europe"],
];
const courses = courseRows.map(([dept, code, title], i) => ({ id: 6400 + i, dept, code, title, credits: 0.5 }));

const slots = ["MWF 08:30", "MWF 10:30", "TTh 13:00", "TTh 14:30", "MW 16:00", "F 11:30"];
const people = ["Prof. Ada Lin", "Prof. Omar Haddad", "Dr. Grace Kim", "Dr. Felix Ortiz", "Prof. Nia Brooks", "Dr. Ivan Petrov", "Prof. Mei Tanaka"];
const sections = courses.flatMap((c, i) =>
  Array.from({ length: 2 + (i % 2) }, (_, j) => {
    const cap = [40, 60, 90][(i + j) % 3]!;
    return { id: 7600 + i * 3 + j, courseId: c.id, kind: j === 2 ? "TUT" : "LEC", code: `00${j + 1}`, time: slots[(i + j * 2) % slots.length], instructor: people[(i * 2 + j) % people.length], cap, seats: [3, 12, 1, 25, 0, 6][(i + j) % 6] };
  }),
);

const manifest: AppManifest = {
  name: "backbone-enrollment",
  title: "Course registration",
  framework: "backbone",
  libs: ["backbone", "underscore templates", "jquery.ajax", "Backbone.sync", "rt.guard"],
  domain: "course-registration",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "departments", seed: departments, filters: ["faculty"], envelope: "items" },
      { name: "courses", seed: courses, filters: ["dept"], envelope: "items" },
      { name: "sections", seed: sections, filters: ["courseId"], envelope: "items", actions: { take: { inc: "seats", by: -1 }, release: { inc: "seats", by: 1 } } },
      { name: "enrollments", seed: [], unique: ["key"], required: ["student", "sectionId", "courseId"], filters: ["student"], envelope: "items" },
    ],
  },
  variants: {
    cascade: ["abort-stale", "blind"],
    enrollGuard: ["pending", "none"],
    seats: ["echo", "local"],
    drop: ["pessimistic", "optimistic-no-rollback"],
    credits: ["derive", "incremental"],
  },
  affordances: [
    { id: "faculty", kind: "select", sel: "select[name=faculty]", values: ["Mathematics", "Engineering", "Arts"], weight: 1, mode: "replace", key: "picker" },
    { id: "dept", kind: "select", sel: "select[name=dept]", nth: 3, weight: 1, mode: "replace", key: "picker" },
    { id: "course", kind: "select", sel: "select[name=course]", nth: 3, weight: 1.5, mode: "replace", key: "picker" },
    { id: "enroll", kind: "click", sel: "tr.section button.enroll", nth: 3, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.2, requires: "tr.section button.enroll:not([disabled])" },
    { id: "drop", kind: "click", sel: "li.enrolled button.drop", nth: 4, weight: 1, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: "li.enrolled button.drop:not([disabled])" },
  ],
  external: [
    { kind: "action", target: "sections", perMin: 12, verb: "take", where: { seats: { $gt: 0 } } },
    { kind: "action", target: "sections", perMin: 5, verb: "release", where: { seats: { $lt: 5 } } },
  ],
  weights: { "registration.error": 0, "registration.notice": 0, "registration.loading": 0.1, "registration.pending": 0.1 },
  relations: [
    { name: "credits = enrolled courses", fields: ["registration.credits", "registration.mine"], check: (s) => !s.registration || Math.abs(s.registration.credits - s.registration.mine.reduce((a: number, e: { credits: number }) => a + Number(e.credits), 0)) < 1e-9 },
    { name: "sections belong to the picked course", fields: ["registration.sections", "registration.course"], check: (s) => !s.registration || s.registration.loading || s.registration.sections.every((x: { courseId: number }) => x.courseId === s.registration.course) },
    { name: "courses belong to the picked department", fields: ["registration.courses", "registration.dept"], check: (s) => !s.registration || s.registration.loading || s.registration.courses.every((c: { dept: string }) => c.dept === s.registration.dept) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
