// mutoe/vue3-realworld-example-app (MIT): Vue 3 SFCs + Pinia + vue-router; observe-only integration (one init import).
import { conduitManifest } from "../_shared/conduit-manifest.js";

export default conduitManifest({
  name: "oss-vue3-conduit",
  framework: "vue",
  libs: ["vue@3.5", "pinia@3", "vue-router", "fetch (generated client)"],
  entry: "src/main.ts",
  integration: "observe",
  source: { repo: "https://github.com/mutoe/vue3-realworld-example-app", commit: "741c215ef0f674f90fcb03c5493a1b3a3a7f1b03", license: "MIT", dir: "oss-vue3-conduit" },
  localStorage: { user: JSON.stringify({ email: "demo@example.com", token: "demo-token", username: "demo", bio: "demo writes about the web", image: null }) },
  build: { vite: true },
  domWeight: 2,
});
