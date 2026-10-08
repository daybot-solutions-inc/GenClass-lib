// jihchi/rescript-react-realworld-example-app (MIT): ReScript 12 compiled to ES modules, @rescript/react (React 18
// hooks), rescript-fetch; observe-only integration (one %%raw init import in src/main.res). Built by the app's
// ReScript compiler, then Vite (corpus/prepare_oss.sh).
// Signed in as the demo user (the harness preloads the token; the mock's user object carries an id).
import { conduitManifest } from "../_shared/conduit-manifest.js";

export default conduitManifest({
  name: "oss-rescript-conduit",
  framework: "rescript-react",
  libs: ["rescript@12", "@rescript/react (react@18)", "rescript-fetch"],
  entry: "src/main.res",
  integration: "observe",
  source: { repo: "https://github.com/jihchi/rescript-react-realworld-example-app", commit: "bdd6fde5631a7e218251b49ebd061cbd7ba210b4", license: "MIT", dir: "oss-rescript-conduit" },
  cookies: { jwtToken: "demo-token" },
  build: { vite: true },
  domWeight: 2,
});
