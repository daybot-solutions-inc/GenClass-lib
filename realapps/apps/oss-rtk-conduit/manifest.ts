// khaledosman/react-redux-realworld-example-app (MIT; Redux Toolkit modernisation), unmodified except the store enhancer.
import { conduitManifest } from "../_shared/conduit-manifest.js";

export default conduitManifest({
  name: "oss-rtk-conduit",
  framework: "react",
  libs: ["react@18", "@reduxjs/toolkit@1.9", "react-router@6", "fetch", "genclassEnhancer"],
  entry: "src/index.js",
  integration: "stores",
  source: { repo: "https://github.com/khaledosman/react-redux-realworld-example-app", commit: "53b0b4c0b8c371053a8d082ff9a42bfae68f3755", license: "MIT", dir: "oss-rtk-conduit" },
  localStorage: { jwt: "demo-token" },
  build: { jsxInJs: true, rootId: "root", define: { "process.env.REACT_APP_BACKEND_URL": "undefined", "window.Cypress": "undefined" } },
  weights: { "conduit.common": 0.2, "conduit.auth": 0.3 },
  heldOut: true,
});
