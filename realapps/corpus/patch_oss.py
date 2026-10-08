#!/usr/bin/env python3
"""Integrate GenClass into each open-source app the way a developer would (one init import; the app's own store
wrapped with the runtime's adapter where it has one). Idempotent: patched files carry a marker."""
import pathlib, sys

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
    else:
        sys.exit(f"unknown app {name}")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
