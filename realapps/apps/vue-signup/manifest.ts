import type { AppManifest } from "../../src/shared/manifest.js";

const existing: [string, string, string][] = [
  ["alex", "Alex Moreau", "admin"],
  ["sam", "Sam Kowalski", "member"],
  ["priya", "Priya Natarajan", "member"],
  ["jordan", "Jordan Reyes", "viewer"],
  ["lee.chen", "Lee Chen", "member"],
  ["mika", "Mika Tanaka", "member"],
];
const users = existing.map(([username, displayName, role], i) => ({ id: 800 + i, username, email: `${username}@acme.test`, displayName, role }));

const manifest: AppManifest = {
  name: "vue-signup",
  title: "Add a teammate",
  framework: "vue",
  libs: ["vue", "fetch", "rt.atom"],
  domain: "onboarding",
  entry: "main.ts",
  integration: "stores",
  build: { vueCompiler: true },
  server: {
    base: "/api",
    collections: [{ name: "users", seed: users, filters: ["username", "email"], envelope: "items", pageSize: 50 }],
  },
  variants: {
    check: ["debounce-abort", "none", "reqid", "debounce", "none"],
    submitLock: [true, false],
    idemKey: [true, false],
  },
  affordances: [
    // one pass through the wizard: account, Continue, profile, Review, Create
    { id: "fill", kind: "type", sel: "input[name=username]", values: ["alexm", "sam.k", "priya.n", "jordan_r", "lee", "mika.t", "noah.b", "dana.w", "ravi", "alex"], weight: 3, mode: "replace", clear: true, then: ["email", "password", "next1", "displayName", "role", "next2", "create"] },
    { id: "email", kind: "type", sel: "input[name=email]", values: ["alex.m@acme.test", "sam.k@acme.test", "noah@acme.test", "mika.t@acme.test", "jr@acme.test", "dana@acme.test", "ravi.p@acme.test", "priya@acme.test"], weight: 0, mode: "replace", clear: true, followOnly: true },
    { id: "password", kind: "type", sel: "input[name=password]", values: ["harbor-lamp-42", "quiet-otter-77", "maple-stone-19", "orbit-fern-58", "cedar-moon-63", "violet-dune-25", "tiny1"], weight: 0, mode: "replace", clear: true, followOnly: true },
    { id: "next1", kind: "click", sel: "button.next1", weight: 0, mode: "replace", followOnly: true },
    { id: "displayName", kind: "type", sel: "input[name=displayName]", values: ["Alex M.", "Sam K", "Noah Baker", "Mika T.", "Jordan R."], weight: 0, mode: "replace", clear: true, followOnly: true },
    { id: "role", kind: "select", sel: "select[name=role]", values: ["member", "admin", "viewer"], weight: 0, mode: "replace", followOnly: true },
    { id: "next2", kind: "click", sel: "button.next2", weight: 0, mode: "replace", followOnly: true },
    // fixing what step 1 complained about, then moving on
    { id: "fixUsername", kind: "type", sel: "input[name=username]", values: ["alex.moreau", "samk", "noah", "jr", "mika.tanaka"], weight: 1.2, mode: "replace", clear: true, after: ["fill"], then: ["next1", "next2"] },
    { id: "fixEmail", kind: "type", sel: "input[name=email]", values: ["a.moreau@acme.test", "noah.baker@acme.test", "jr2@acme.test"], weight: 0.5, mode: "replace", clear: true, after: ["fill"], then: ["next1", "next2"] },
    { id: "fixPassword", kind: "type", sel: "input[name=password]", values: ["longer-pass-31", "river-stone-88"], weight: 0.4, mode: "replace", clear: true, after: ["fill"], then: ["next1", "next2"] },
    { id: "editRole", kind: "select", sel: "select[name=role]", values: ["member", "admin", "viewer"], weight: 0.4, mode: "replace", after: ["fill"] },
    { id: "create", kind: "click", sel: "button.submit", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.25, impatientP: 0.3 },
    { id: "submit", kind: "click", sel: "button.submit", weight: 1.5, mode: "accumulate", after: ["fill"], dblclickP: 0.25, impatientP: 0.3 },
    { id: "back", kind: "click", sel: "button.back", weight: 0.3, mode: "replace", after: ["fill"] },
    { id: "another", kind: "click", sel: "button.another", weight: 1, mode: "replace", after: ["fill"] },
  ],
  external: [
    // other admins add people at the same time, taking usernames this admin may be about to use
    {
      kind: "create",
      target: "users",
      perMin: 0.8,
      data: [
        { username: "noah.b", email: "noah.b@acme.test", displayName: "Noah B", role: "member" },
        { username: "mika.t", email: "mika.t@acme.test", displayName: "Mika T", role: "member" },
        { username: "alexm", email: "alexm@acme.test", displayName: "Alex M", role: "viewer" },
        { username: "sam.k", email: "sam.k@acme.test", displayName: "Sam K", role: "member" },
      ],
    },
  ],
  weights: {
    "signup.username": 0.3,
    "signup.email": 0.3,
    "signup.displayName": 0.3,
    "signup.role": 0.3,
    "signup.step": 0.5,
    "signup.hint": 0,
    "signup.error": 0,
    "signup.notice": 0.2,
    "team.loading": 0.1,
  },
  errorSelector: "[role=alert]",
  sessionMs: [30000, 75000],
};
export default manifest;
