// gothinkster/react-redux-realworld-example-app (MIT), unmodified except the Redux store enhancer (corpus/patch_oss.py).
import { conduitManifest } from "../_shared/conduit-manifest.js";

export default conduitManifest({
  name: "oss-react-redux-conduit",
  framework: "react",
  libs: ["react@16", "redux@3", "react-redux@5", "react-router-redux", "superagent(XHR)", "genclassEnhancer"],
  entry: "src/index.js",
  integration: "stores",
  source: { repo: "https://github.com/gothinkster/react-redux-realworld-example-app", commit: "ee72eba4056392c95a27bc48d385d3f54ba38a18", license: "MIT", dir: "oss-react-redux-conduit" },
  localStorage: { jwt: "demo-token" },
  build: { jsxInJs: true, jsxMode: "transform", rootId: "root", define: { "process.env.REACT_APP_BACKEND_URL": "undefined" } },
  weights: { "conduit.common": 0.2, "conduit.router": 0.3, "conduit.editor": 0.4, "conduit.settings": 0.3, "conduit.auth": 0.3 },
});
