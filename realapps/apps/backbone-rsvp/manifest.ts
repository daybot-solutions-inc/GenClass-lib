import type { AppManifest } from "../../src/shared/manifest.js";

const first = ["Ada", "Ben", "Cleo", "Dmitri", "Esme", "Farah", "Gil", "Hana", "Ines", "Jamal", "Kira", "Lars", "Mina", "Nico", "Oona", "Pedro", "Quinn", "Rhea", "Soren", "Tess", "Umar", "Vera", "Wes", "Xia"];
const rsvps = ["pending", "yes", "pending", "no", "yes", "maybe"];
const guests = first.map((name, i) => ({ id: 3100 + i, name: `${name} ${["Okafor", "Lindqvist", "Moreau", "Santos", "Novak", "Tanaka"][i % 6]}`, side: i % 2 ? "groom" : "bride", rsvp: rsvps[i % 6], plusOnes: i % 4 === 1 ? 1 : 0, reminded: false, meal: i % 3 ? "standard" : "vegetarian" }));

const manifest: AppManifest = {
  name: "backbone-rsvp",
  title: "Wedding RSVPs",
  framework: "backbone",
  libs: ["backbone", "underscore", "jquery", "Backbone.sync($.ajax)", "rt.guard"],
  domain: "event-rsvp",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "guests", seed: guests, filters: ["side", "rsvp"], envelope: "items", pageSize: 6, actions: { plus: { inc: "plusOnes", by: 1 }, minus: { inc: "plusOnes", by: -1 } } },
    ],
  },
  variants: {
    save: ["patch", "put"],
    plusGuard: ["pending", "none"],
    headcount: ["listen", "manual"],
    fetch: ["abort-previous", "none"],
    remind: ["per-item", "assume-all"],
  },
  affordances: [
    { id: "side", kind: "select", sel: "select[name=side]", values: ["all", "bride", "groom"], weight: 0.8, mode: "replace", key: "list" },
    { id: "page", kind: "click", sel: "nav.pages button", nth: 4, weight: 2, mode: "replace", key: "list" },
    { id: "rsvp", kind: "select", sel: "li.guest select.rsvp", nth: 6, values: ["yes", "no", "maybe", "pending"], weight: 3, mode: "replace", intent: "nth", key: "rsvp" },
    { id: "plus", kind: "click", sel: "li.guest button.plus", nth: 6, weight: 2, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.15 },
    { id: "minus", kind: "click", sel: "li.guest button.minus", nth: 6, weight: 0.8, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: "li.guest button.minus:not([disabled])" },
    { id: "remindAll", kind: "click", sel: "button.remind-all", weight: 0.8, mode: "accumulate", dblclickP: 0.1, impatientP: 0.2, requires: "button.remind-all:not([disabled])" },
  ],
  external: [
    { kind: "update", target: "guests", perMin: 3, where: { rsvp: "pending" }, data: [{ rsvp: "yes" }, { rsvp: "no" }, { rsvp: "yes", meal: "vegetarian" }] },
    { kind: "update", target: "guests", perMin: 1.5, where: { rsvp: "maybe" }, data: [{ rsvp: "yes" }, { rsvp: "no" }] },
  ],
  weights: { "rsvp.error": 0, "rsvp.notice": 0, "rsvp.loading": 0.1, "rsvp.pending": 0.1, "rsvp.side": 0.3 },
  relations: [
    {
      name: "page headcount = attending guests on the page",
      fields: ["rsvp.attending", "rsvp.guests"],
      check: (s) => !s.rsvp || s.rsvp.loading || s.rsvp.attending === s.rsvp.guests.filter((g: { rsvp: string }) => g.rsvp === "yes").reduce((a: number, g: { plusOnes: number }) => a + 1 + g.plusOnes, 0),
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
