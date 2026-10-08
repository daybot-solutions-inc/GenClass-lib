import type { AppManifest } from "../../src/shared/manifest.js";

const manifest: AppManifest = {
  name: "solid-settings",
  title: "Account settings",
  framework: "solid",
  libs: ["solid-js", "solid-js/html", "fetch", "rt.atom"],
  domain: "settings",
  entry: "main.ts",
  integration: "stores",
  build: { jsx: "solid-html" },
  server: {
    base: "/api",
    collections: [{ name: "profiles", seed: [{ id: "me", displayName: "Rae Okafor", bio: "Product designer.", location: "Lisbon", version: 3 }], idStyle: "slug", versioned: true, envelope: "bare" }],
    docs: [
      {
        name: "settings",
        init: { theme: "system", density: "comfortable", language: "en", digest: "weekly", notifyComments: true, notifyMentions: true, notifyFollows: false, productNews: false, publicProfile: true, showActivity: true },
      },
    ],
  },
  variants: {
    saveMode: ["sequence", "blind", "serialize", "blind"],
    conflict: ["merge", "overwrite", "stuck"],
    profileLock: [true, false],
  },
  affordances: [
    { id: "toggle", kind: "check", sel: "input.pref-toggle", nth: 6, intent: "nth", weight: 4, mode: "replace", dblclickP: 0.1 },
    // flipping several switches in a row (each one auto-saves)
    { id: "toggles", kind: "check", sel: "input.pref-toggle", nth: 6, intent: "nth", weight: 2, mode: "replace", then: ["toggle2", "toggle3"] },
    { id: "toggle2", kind: "check", sel: "input.pref-toggle", nth: 6, intent: "nth", weight: 0, mode: "replace", followOnly: true },
    { id: "toggle3", kind: "check", sel: "input.pref-toggle", nth: 6, intent: "nth", weight: 0, mode: "replace", followOnly: true },
    { id: "theme", kind: "select", sel: "select[name=theme]", values: ["light", "dark", "system"], weight: 1.2, mode: "replace" },
    { id: "density", kind: "select", sel: "select[name=density]", values: ["comfortable", "compact"], weight: 0.8, mode: "replace" },
    { id: "language", kind: "select", sel: "select[name=language]", values: ["en", "fr", "de", "es"], weight: 0.8, mode: "replace" },
    { id: "digest", kind: "select", sel: "select[name=digest]", values: ["off", "daily", "weekly"], weight: 1, mode: "replace" },
    { id: "displayName", kind: "type", sel: "input[name=displayName]", values: ["Rae Okafor", "Rae O.", "R. Okafor", "Rae"], weight: 1.2, mode: "replace", clear: true, then: ["saveProfile"] },
    { id: "bio", kind: "type", sel: "textarea[name=bio]", values: [" Coffee first.", " Speaker at JSConf.", " She/her.", " Hiring!"], weight: 1.2, mode: "replace", then: ["saveProfile"] },
    { id: "location", kind: "type", sel: "input[name=location]", values: ["Lisbon", "Porto", "Berlin", "Remote"], weight: 0.8, mode: "replace", clear: true, then: ["saveProfile"] },
    { id: "saveProfile", kind: "click", sel: "button.save-profile", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.2, impatientP: 0.2 },
    { id: "discard", kind: "click", sel: "button.discard-profile", weight: 0.3, mode: "replace" },
  ],
  external: [
    // the same account edited from the mobile app
    { kind: "doc", target: "settings", perMin: 0.8, data: [{ digest: "daily" }, { theme: "dark" }, { notifyFollows: true }] },
    { kind: "update", target: "profiles", perMin: 1.2, data: [{ bio: "Product designer. Updated from mobile." }, { location: "Remote" }] },
  ],
  weights: {
    "prefsStatus.error": 0,
    "prefsStatus.loaded": 0.1,
    "profile.error": 0,
    "profile.notice": 0.1,
    "profile.version": 0,
    "profile.dirty": 0.2,
    "profile.displayName": 0.3,
    "profile.bio": 0.3,
    "profile.location": 0.3,
  },
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
