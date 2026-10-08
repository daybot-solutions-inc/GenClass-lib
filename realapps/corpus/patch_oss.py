#!/usr/bin/env python3
"""Integrate GenClass into each open-source app the way a developer would (one init import; the app's own store
wrapped with the runtime's adapter where it has one). Idempotent: patched files carry a marker."""
import json, pathlib, re, sys

MARK = "/* realapps: GenClass integration */"

def patch(path, old, new):
    p = pathlib.Path(path)
    s = p.read_text()
    if MARK in s:
        return
    if old not in s:
        sys.exit(f"patch anchor not found in {path}: {old[:60]!r}")
    p.write_text(s.replace(old, new, 1))

def prepend(path, line):
    p = pathlib.Path(path)
    s = p.read_text()
    if MARK in s:
        return
    p.write_text(f"{MARK}\n{line}\n{s}")

def write_once(path, text):
    """A build-config file the app's own toolchain implied (never app code)."""
    p = pathlib.Path(path)
    if not p.exists():
        p.write_text(text)

def preinstall(name, d):
    """Dependency-spec fixes needed before `npm install` can run at all (never app code)."""
    d = pathlib.Path(d)
    if name == "oss-wc-conduit":
        # GitHub no longer serves git:// URLs; the same webcomponentsjs v1.0.0 release is on the npm registry
        pj = d / "package.json"
        cfg = json.loads(pj.read_text())
        if cfg["dependencies"].get("@webcomponents/webcomponentsjs", "").startswith("git://"):
            cfg["dependencies"]["@webcomponents/webcomponentsjs"] = "1.0.0"
            pj.write_text(json.dumps(cfg, indent=2) + "\n")

def main(name, d):
    d = pathlib.Path(d)
    if name == "oss-react-redux-conduit":
        patch(d / "src/store.js", "import reducer from './reducer';",
              f"import reducer from './reducer';\n{MARK}\nimport {{ genclassEnhancer }} from '@genclass/runtime/redux';\nimport {{ rt }} from '@realapps/genclass';")
        s = (d / "src/store.js").read_text()
        s = s.replace("reducer, composeWithDevTools(getMiddleware()));", "reducer, composeWithDevTools(getMiddleware(), genclassEnhancer(rt, { name: 'conduit' })));")
        assert "genclassEnhancer(rt" in s
        (d / "src/store.js").write_text(s)
    elif name == "oss-rtk-conduit":
        patch(d / "src/app/store.js", "import { configureStore } from '@reduxjs/toolkit';",
              f"import {{ configureStore }} from '@reduxjs/toolkit';\n{MARK}\nimport {{ genclassEnhancer }} from '@genclass/runtime/redux';\nimport {{ rt }} from '@realapps/genclass';")
        s = (d / "src/app/store.js").read_text()
        if "genclassEnhancer(rt" not in s:
            s = s.replace("    devTools: true,", "    devTools: true,\n    enhancers: (defaultEnhancers) => [...defaultEnhancers, genclassEnhancer(rt, { name: 'conduit' })],", 1)
        assert "genclassEnhancer(rt" in s
        (d / "src/app/store.js").write_text(s)
    elif name == "oss-vue3-conduit":
        prepend(d / "src/main.ts", "import '@realapps/genclass'")
    elif name == "oss-solid-conduit":
        prepend(d / "src/index.js", "import '@realapps/genclass';")
        html = d / "index.html"
        if not html.exists():
            html.write_text('<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Conduit</title></head>\n<body><script type="module" src="/src/index.js"></script></body></html>\n')
    elif name == "oss-mobx-conduit":
        prepend(d / "src/index.js", "import '@realapps/genclass';")
        # build config only: the app's babel setup (custom-react-scripts) compiles legacy decorators with
        # assignment-semantics class fields; esbuild gets the same through a tsconfig (jsconfig's baseUrl kept)
        write_once(d / "tsconfig.json", '{"compilerOptions": {"experimentalDecorators": true, "useDefineForClassFields": false, "baseUrl": "src", "jsx": "react"}}\n')
    elif name == "oss-vue2-conduit":
        prepend(d / "src/main.js", "import '@realapps/genclass';")
    elif name == "oss-angular-conduit":
        prepend(d / "src/main.ts", "import '@realapps/genclass';")
        # build config only (angular.json): the integration module is resolved by corpus/rebundle.mjs, not by the
        # Angular compiler; the theme stylesheet and media live in an uninitialised git submodule; stable file
        # names and no size budgets (the re-bundle adds the runtime)
        aj = d / "angular.json"
        cfg = json.loads(aj.read_text())
        b = cfg["projects"]["angular-conduit"]["architect"]["build"]
        b["options"].update({"externalDependencies": ["@realapps/genclass"], "styles": [], "assets": []})
        b["configurations"]["production"].pop("budgets", None)
        b["configurations"]["production"]["outputHashing"] = "none"
        # no build-time font inlining (a network fetch at build time; fonts never load in the harness anyway)
        b["configurations"]["production"]["optimization"] = {"scripts": True, "styles": {"minify": True, "inlineCritical": False}, "fonts": False}
        aj.write_text(json.dumps(cfg, indent=2) + "\n")
    elif name == "oss-elm-conduit":
        # The app boots from an inline <script> in index.html (Elm.Main.init + localStorage ports). Bundling needs a
        # module entry: the compiled program (elm make -> elm.js) plus that bootstrap script, unchanged, with the
        # one init import on top.
        boot = re.findall(r"<script>([\s\S]*?)</script>", (d / "index.html").read_text())
        assert len(boot) == 1, "expected one inline bootstrap script"
        write_once(d / "rw-main.js", f"{MARK}\nimport '@realapps/genclass';\nimport compiled from './elm.js';\nvar Elm = compiled.Elm;\n{boot[0].strip()}\n")
    elif name == "oss-svelte-conduit":
        prepend(d / "src/main.js", "import '@realapps/genclass';")
        # Vite entry page (the app's own public/index.html loads the rollup IIFE build/bundle.js)
        write_once(d / "index.html", '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Conduit</title></head>\n<body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>\n')
    elif name == "oss-angularjs-conduit":
        prepend(d / "src/js/app.js", "import '@realapps/genclass';")
    elif name == "oss-wc-conduit":
        prepend(d / "app/index.js", "import '@realapps/genclass';")
    elif name == "oss-rescript-conduit":
        # the ReScript way to add a side-effect JS import to the entry module
        p = d / "src/main.res"
        src = p.read_text()
        if "@realapps/genclass" not in src:
            p.write_text(f"// {MARK}\n%%raw(`import '@realapps/genclass'`)\n{src}")
    elif name == "oss-ember-conduit":
        # page-level integration: corpus/rebundle.mjs --scripts puts the init script before the app's scripts.
        # Build config only (ember-cli-build.js): ember-fetch's documented `preferNative` option. Its bundled
        # whatwg-fetch polyfill reads XHR blob bodies with FileReader, which completes on real time (the harness
        # virtualises Blob/Response reads but not FileReader), so request timing would not be reproducible.
        patch(d / "ember-cli-build.js", "    // Add options here\n", f"    // Add options here\n    {MARK}\n    'ember-fetch': {{ preferNative: true }},\n")
    elif name == "oss-halogen-conduit":
        prepend(d / "index.js", "import '@realapps/genclass';")
    else:
        sys.exit(f"unknown app {name}")

if __name__ == "__main__":
    if sys.argv[1] == "--preinstall":
        preinstall(sys.argv[2], sys.argv[3])
    else:
        main(sys.argv[1], sys.argv[2])
