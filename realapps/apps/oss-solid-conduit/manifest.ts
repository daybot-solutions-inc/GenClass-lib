// solidjs/solid-realworld (MIT): SolidJS + solid-js/store + fetch; observe-only integration (one init import).
import { conduitManifest } from "../_shared/conduit-manifest.js";

export default conduitManifest({
  name: "oss-solid-conduit",
  framework: "solid",
  libs: ["solid-js@1", "solid-js/store", "fetch"],
  entry: "src/index.js",
  integration: "observe",
  source: { repo: "https://github.com/solidjs/solid-realworld", commit: "f6e77ecd652bf32f0dc9238f291313fd1af7e98b", license: "MIT", dir: "oss-solid-conduit" },
  localStorage: { jwt: "demo-token" },
  build: { vite: true },
  domWeight: 2,
});
