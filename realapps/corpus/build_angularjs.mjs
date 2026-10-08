// Build gothinkster/angularjs-realworld-example-app the way its gulpfile does, without gulp 3 (which no longer
// runs on current Node): the "views" task (gulp-angular-templatecache, standalone module "templates" written to
// src/js/config/app.templates.js) and the "browserify" task (babelify es2015 + browserify-ngannotate, from the
// app's own node_modules), with esbuild doing the bundling (corpus/rebundle.mjs) instead of browserify.
//   node corpus/build_angularjs.mjs <app dir> <out dir>
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { rebundle } from "./rebundle.mjs";

const [appArg, out] = process.argv.slice(2);
if (!appArg || !out) {
  console.error("usage: node corpus/build_angularjs.mjs <app dir> <out dir>");
  process.exit(2);
}
const app = resolve(appArg);
const js = join(app, "src/js");

// views: every src/js/**/*.html into $templateCache, keyed by its path relative to src/js (templateUrl values)
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const views = walk(js).filter((f) => f.endsWith(".html")).sort();
const puts = views.map((f) => `$templateCache.put(${JSON.stringify(relative(js, f).split(sep).join("/"))},${JSON.stringify(readFileSync(f, "utf8"))});`);
writeFileSync(join(js, "config/app.templates.js"), `angular.module("templates", []).run(["$templateCache", function($templateCache) {${puts.join("\n")}}]);`);

// browserify transforms: babel es2015 then ng-annotate ('ngInject' prologues -> $inject; the app bootstraps strictDi)
const req = createRequire(join(app, "package.json"));
const babel = req("babel-core");
const es2015 = req.resolve("babel-preset-es2015");
const ngAnnotate = req("ng-annotate");
const transforms = {
  name: "angularjs-app-transforms",
  setup(b) {
    b.onLoad({ filter: /[\\/]src[\\/]js[\\/].*\.js$/ }, (args) => {
      const code = babel.transform(readFileSync(args.path, "utf8"), { presets: [es2015], filename: args.path, babelrc: false }).code;
      const r = ngAnnotate(code, { add: true });
      if (r.errors) return { errors: r.errors.map((text) => ({ text })) };
      return { contents: r.src, loader: "js" };
    });
  },
};
await rebundle({ entry: join(js, "app.js"), out: resolve(out), html: join(app, "src/index.html"), plugins: [transforms], nodePaths: [join(app, "node_modules")] });
