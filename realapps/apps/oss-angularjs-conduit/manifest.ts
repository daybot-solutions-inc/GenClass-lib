// gothinkster/angularjs-realworld-example-app (MIT): AngularJS 1.x (ES2015 classes, components, strictDi),
// angular-ui-router 0.4 (hashbang), $http (XHR) + $q; observe-only integration (one init import). Built like its
// gulpfile (templatecache + babel es2015 + ng-annotate) by corpus/build_angularjs.mjs.
import { conduitManifest } from "../_shared/conduit-manifest.js";

export default conduitManifest({
  name: "oss-angularjs-conduit",
  framework: "angularjs",
  libs: ["angular@1", "angular-ui-router@0.4", "$http(XHR)", "$q"],
  entry: "src/js/app.js",
  integration: "observe",
  source: { repo: "https://github.com/gothinkster/angularjs-realworld-example-app", commit: "08755ca543e13cb26bc7086d0596ad58567a6f78", license: "MIT", dir: "oss-angularjs-conduit" },
  localStorage: { jwtToken: "demo-token" },
  // prebuilt by corpus/prepare_oss.sh (build.mjs skips `vite` apps)
  build: { vite: true },
  domWeight: 2,
});
