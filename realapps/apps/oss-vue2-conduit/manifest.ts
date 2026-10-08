// gothinkster/vue-realworld-example-app (MIT) at its last Vue 2 commit: Vue 2.7 SFCs (Options API) + Vuex 3 +
// vue-router 3 + fetch; observe-only integration (one init import). Built with Vite + @vitejs/plugin-vue2.
import { conduitManifest } from "../_shared/conduit-manifest.js";

export default conduitManifest({
  name: "oss-vue2-conduit",
  framework: "vue",
  libs: ["vue@2.7", "vuex@3", "vue-router@3", "fetch"],
  entry: "src/main.js",
  integration: "observe",
  source: { repo: "https://github.com/gothinkster/vue-realworld-example-app", commit: "116b91944478860597b4fa2807ed99a2d873c734", license: "MIT", dir: "oss-vue2-conduit" },
  localStorage: { jwtToken: "demo-token" },
  build: { vite: true },
  domWeight: 2,
});
