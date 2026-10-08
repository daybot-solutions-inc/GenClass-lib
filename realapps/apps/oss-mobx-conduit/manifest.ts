// gothinkster/react-mobx-realworld-example-app (MIT): React 16 + MobX 3 stores (legacy decorators) + superagent;
// observe-only integration (one init import; the MobX stores stay the app's own).
import { conduitManifest } from "../_shared/conduit-manifest.js";

export default conduitManifest({
  name: "oss-mobx-conduit",
  framework: "mobx-react",
  libs: ["react@16", "mobx@3", "mobx-react@4", "react-router@4 (hash)", "superagent(XHR)"],
  entry: "src/index.js",
  integration: "observe",
  source: { repo: "https://github.com/gothinkster/react-mobx-realworld-example-app", commit: "c90ac8fa4b1f5c6292ca796b9c1a162efaef6e9b", license: "MIT", dir: "oss-mobx-conduit" },
  localStorage: { jwt: "demo-token" },
  // .js files hold JSX and legacy decorators: the TS loader with the tsconfig written by corpus/patch_oss.py
  build: { jsxMode: "transform", rootId: "root", loader: { ".js": "tsx" } },
  domWeight: 2,
});
