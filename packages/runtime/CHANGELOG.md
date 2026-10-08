# Changelog

## 0.1.0-alpha.1

- **One-command install:** `npx @genclass/runtime init` detects your framework and installs GenClass. Tested in
  fresh Vite (React, Vue, Svelte), Next.js App and Pages Router, Create React App, SvelteKit, Astro, Nuxt,
  React Router, Angular and plain-HTML projects. `remove` restores every file byte for byte.
- **One import:** `import "@genclass/runtime/auto"` (also `/auto/observe` and `/auto/heal`).
- **One script tag:** `<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime"></script>`, with the model
  worker loaded cross-origin.
- **Never reorders your app's writes.** Decisions now happen at the network boundary (the new `delivery` trigger
  for fetch, XHR, WebSocket and EventSource), which looks like latency to the app. Store holds are opt-in
  (`policy.holdWrites`). With a model that never intervenes, GenClass changed 0 of 396 clean runs across 66 real
  apps.
- **New facts:** "would put back a value a newer write replaced", "would replace text the user typed", "response
  changes nothing", stale-value provenance, refresh/save cadence, failure scope, commit ambiguity, repeat-click
  evidence, and count-by-group relations.
- **Fixes:**
  - an infinite recursion when app state contains `NaN`;
  - clicks inside shadow DOM were described as the host element;
  - nested-label element names included the text of their options;
  - redaction is now by field name, so a store named `auth` is no longer hidden wholesale;
  - 34 review findings, each with a regression test.

## 0.1.0-alpha.0

First alpha.
