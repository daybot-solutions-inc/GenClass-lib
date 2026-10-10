// The compat apps: how to build and serve each one, its data layers, and which scenarios each layer implements.
// Every app installs @genclass/runtime from this checkout's packed tarball (compat/.pack/genclass-runtime.tgz) and
// starts it with the one line (`import "@genclass/runtime/auto"` first in the browser entry, or the script tag),
// where `npx @genclass/runtime init` puts it.
//
// `discovery` names the store source automatic state discovery should report for the layer's own state
// (README "Automatic state discovery"): "react" (hooks state), "redux" (Redux / RTK), "devtools" (Zustand through
// the Redux DevTools `connect` API), or null when the data layer is not covered (its state lives elsewhere: a query
// cache, Pinia, Svelte stores, signals, the DOM). The matrix reports what was found either way.

const ALL = ["a", "b", "c", "d", "e", "f", "g", "h"];

export const APPS = {
  "react-vite": {
    title: "React 19 + Vite 8",
    dir: "apps/react-vite",
    install: "the one import in src/main.tsx",
    build: "npm run build",
    serve: { static: "dist" },
    versions: ["react", "react-dom", "vite", "@tanstack/react-query", "zustand", "@reduxjs/toolkit", "react-redux", "@apollo/client", "graphql"],
    layers: {
      state: { title: "fetch + useState / useEffect", scenarios: ALL, discovery: "react" },
      tanstack: { title: "TanStack Query 5", scenarios: ALL, discovery: null },
      zustand: { title: "Zustand 5 (devtools middleware)", scenarios: ALL, discovery: "devtools" },
      "zustand-on": { title: "Zustand 5 (devtools middleware, `enabled: true`)", scenarios: ALL, discovery: "devtools" },
      redux: { title: "Redux Toolkit 2 + RTK Query", scenarios: ALL, discovery: "redux" },
      apollo: { title: "Apollo Client 4 (mock GraphQL)", scenarios: ALL, discovery: null },
    },
  },
  "next-app": {
    title: "Next.js 16 App Router (SSR)",
    dir: "apps/next-app",
    install: "instrumentation-client.ts",
    build: "npm run build",
    serve: { cmd: "npx next start -p {port} -H 127.0.0.1" },
    ssr: true,
    versions: ["next", "react", "react-dom", "swr"],
    layers: {
      state: { title: "fetch + useState / useEffect (client components)", scenarios: ALL, discovery: "react" },
      swr: { title: "SWR 2", scenarios: ALL, discovery: null },
    },
  },
  "vue-vite": {
    title: "Vue 3 + Vite 8",
    dir: "apps/vue-vite",
    install: "the one import in src/main.ts",
    build: "npm run build",
    serve: { static: "dist" },
    versions: ["vue", "pinia", "vite"],
    layers: {
      pinia: { title: "Pinia (setup stores)", scenarios: ALL, discovery: null },
    },
  },
  sveltekit: {
    title: "SvelteKit 3 (Svelte 5, SSR, adapter-node)",
    dir: "apps/sveltekit",
    install: "src/hooks.client.ts",
    build: "npm run build",
    serve: { cmd: "node build", env: { PORT: "{port}", HOST: "127.0.0.1" } },
    ssr: true,
    versions: ["svelte", "@sveltejs/kit", "@sveltejs/adapter-node", "vite"],
    layers: {
      stores: { title: "Svelte stores (writable)", scenarios: ALL, discovery: null },
    },
  },
  angular: {
    title: "Angular 22 (SSR + hydration, zoneless)",
    dir: "apps/angular",
    install: "the one import in src/main.ts",
    build: "npx ng build",
    serve: { cmd: "node dist/compat-angular/server/server.mjs", env: { PORT: "{port}", HOST: "127.0.0.1" } },
    ssr: true,
    versions: ["@angular/core", "@angular/ssr", "rxjs"],
    layers: {
      fetch: { title: "HttpClient (default FetchBackend) + signals", scenarios: ALL, discovery: null },
      xhr: { title: "HttpClient withXhr() (XMLHttpRequest) + signals", scenarios: ALL, discovery: null },
    },
  },
  "solid-vite": {
    title: "Solid 1.9 + Vite 8",
    dir: "apps/solid-vite",
    install: "the one import in src/index.tsx",
    build: "npm run build",
    serve: { static: "dist" },
    versions: ["solid-js", "vite", "vite-plugin-solid"],
    layers: {
      signals: { title: "signals + createResource", scenarios: ALL, discovery: null },
    },
  },
  "plain-html": {
    title: "Plain HTML, CDN script tag",
    dir: "apps/plain-html",
    install: "the script tag, first in <head>",
    build: null,
    serve: { static: "." },
    cdn: true,
    versions: [],
    layers: {
      fetch: { title: "fetch + DOM", scenarios: ALL, discovery: null },
      push: { title: "WebSocket + EventSource + DOM", scenarios: ["a", "c", "d", "g", "h"], discovery: null },
    },
  },
};
