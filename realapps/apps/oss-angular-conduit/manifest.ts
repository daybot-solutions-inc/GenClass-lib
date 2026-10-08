// gothinkster/angular-realworld-example-app (MIT): Angular 21 standalone components, zoneless change detection,
// signals + RxJS + rx-angular, HttpClient (XHR) with interceptors; observe-only integration (one init import).
// Built by the app's own Angular CLI (corpus/prepare_oss.sh) and re-bundled into one module (corpus/rebundle.mjs).
import { conduitManifest } from "../_shared/conduit-manifest.js";

export default conduitManifest({
  name: "oss-angular-conduit",
  framework: "angular",
  libs: ["@angular/core@21 (zoneless)", "rxjs@7", "@rx-angular/template", "HttpClient(XHR)"],
  entry: "src/main.ts",
  integration: "observe",
  source: { repo: "https://github.com/gothinkster/angular-realworld-example-app", commit: "dd99ed2cf39c805d719f943c5d7061a5683d98a8", license: "MIT", dir: "oss-angular-conduit" },
  localStorage: { jwtToken: "demo-token" },
  // prebuilt by corpus/prepare_oss.sh (build.mjs skips `vite` apps)
  build: { vite: true },
  domWeight: 2,
});
