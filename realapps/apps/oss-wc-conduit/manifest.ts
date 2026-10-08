// gothinkster/web-components-realworld-example-app (MIT): vanilla JS custom elements (light DOM, innerHTML
// templates, singletons), Navigo 7 hash routing, fetch; observe-only integration (one init import).
// Bundled with the app's own index.html by corpus/prepare_oss.sh + corpus/rebundle.mjs.
import { conduitManifest } from "../_shared/conduit-manifest.js";

export default conduitManifest({
  name: "oss-wc-conduit",
  framework: "web-components",
  libs: ["custom elements (vanilla)", "navigo@7", "markdown-js", "fetch"],
  entry: "app/index.js",
  integration: "observe",
  source: { repo: "https://github.com/gothinkster/web-components-realworld-example-app", commit: "8408c72d1d62c4d67416b1d6b28d1deb6c521af9", license: "MIT", dir: "oss-wc-conduit" },
  // the app's session format (Authentication.auth): the login response's user object as JSON under "auth"
  localStorage: { auth: JSON.stringify({ email: "demo@example.com", token: "demo-token", username: "demo", bio: "demo writes about the web", image: null }) },
  // prebuilt by corpus/prepare_oss.sh (build.mjs skips `vite` apps)
  build: { vite: true },
  domWeight: 2,
});
