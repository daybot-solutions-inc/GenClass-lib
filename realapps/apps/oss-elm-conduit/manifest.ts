// rtfeldman/elm-spa-example (MIT): Elm 0.19.1 Browser.application, elm/http (XHR), localStorage through ports;
// observe-only integration (one init import in the module that carries index.html's bootstrap script).
// Built by elm make (corpus/prepare_oss.sh) and re-bundled into one module (corpus/rebundle.mjs).
import { conduitManifest } from "../_shared/conduit-manifest.js";

export default conduitManifest({
  name: "oss-elm-conduit",
  framework: "elm",
  libs: ["elm@0.19.1", "elm/http@1 (XHR)", "elm/browser (Browser.application)", "ports(localStorage)"],
  entry: "rw-main.js",
  integration: "observe",
  source: { repo: "https://github.com/rtfeldman/elm-spa-example", commit: "cb32acd73c3d346d0064e7923049867d8ce67193", license: "MIT", dir: "oss-elm-conduit" },
  // the app's own session format (Api.storeCredWith): a JSON string under "store"
  localStorage: { store: JSON.stringify({ user: { username: "demo", token: "demo-token", image: null } }) },
  // prebuilt by corpus/prepare_oss.sh (build.mjs skips `vite` apps)
  build: { vite: true },
  domWeight: 2,
});
