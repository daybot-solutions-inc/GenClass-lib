// gothinkster/ember-realworld (MIT): Ember 3.24 Octane (Glimmer components, @tracked), Ember Data (RESTAdapter),
// ember-concurrency, fetch; observe-only integration: the GenClass init script loads before the app's scripts (as an
// SDK <script> in index.html would). Built by ember-cli; scripts concatenated by corpus/rebundle.mjs --scripts.
// Signed in as the demo user (the harness preloads the token; the mock's user object carries an id).
import { conduitManifest } from "../_shared/conduit-manifest.js";

export default conduitManifest({
  name: "oss-ember-conduit",
  framework: "ember",
  libs: ["ember-source@3.24", "ember-data@3.24", "ember-concurrency", "fetch"],
  entry: "app/app.js",
  integration: "observe",
  source: { repo: "https://github.com/gothinkster/ember-realworld", commit: "b7a8421b32384a0017dec30be28f4c3eaf74623a", license: "MIT", dir: "oss-ember-conduit" },
  localStorage: { "realworld.ember.token": "demo-token" },
  build: { prebuilt: true },
  domWeight: 2,
});
