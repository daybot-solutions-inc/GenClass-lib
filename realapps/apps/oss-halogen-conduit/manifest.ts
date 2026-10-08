// thomashoneyman/purescript-halogen-realworld (MIT): PureScript 0.15, Halogen 7 + halogen-store, Aff, affjax-web
// (XHR), routing-duplex (hash routes); observe-only integration (one init import in the JS entry index.js).
// Built by spago (purs) and re-bundled from index.js by corpus/rebundle.mjs (as the app's own esbuild script does).
import { conduitManifest } from "../_shared/conduit-manifest.js";

export default conduitManifest({
  name: "oss-halogen-conduit",
  framework: "purescript-halogen",
  libs: ["purescript@0.15", "halogen@7", "halogen-store", "aff", "affjax-web (XHR)", "routing-duplex"],
  entry: "index.js",
  integration: "observe",
  source: { repo: "https://github.com/thomashoneyman/purescript-halogen-realworld", commit: "35f3d7363017fb3a2bd5fecfa1cba6d36f9b6211", license: "MIT", dir: "oss-halogen-conduit" },
  localStorage: { token: "demo-token" },
  // prebuilt by corpus/prepare_oss.sh (build.mjs skips `vite` apps)
  build: { vite: true },
  domWeight: 2,
});
