// Leehuseung/realworld-svelte (MIT): Svelte 3 client-side SPA, svelte-navigator, svelte/store, axios (XHR);
// observe-only integration (one init import). Built with Vite + @sveltejs/vite-plugin-svelte (the app ships a
// rollup config; the Vite build applies the same production API-origin substitution).
import { conduitManifest } from "../_shared/conduit-manifest.js";

export default conduitManifest({
  name: "oss-svelte-conduit",
  framework: "svelte",
  libs: ["svelte@3", "svelte-navigator", "svelte/store", "axios(XHR)"],
  entry: "src/main.js",
  integration: "observe",
  source: { repo: "https://github.com/Leehuseung/realworld-svelte", commit: "39402e919042a8b176209190b7c3385682848628", license: "MIT", dir: "oss-svelte-conduit" },
  localStorage: { jwtToken: "demo-token" },
  build: { vite: true },
  domWeight: 2,
});
