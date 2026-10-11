---
name: Bug report
about: Something in @genclass/runtime is broken (crash, wrong behaviour, install problem)
title: ""
labels: bug
---

**Versions**

- `@genclass/runtime`: (from `rt.status` or `package.json`)
- model: (the `[GenClass] Model ready (...)` console line, or `rt.status.model`)
- browser and OS:
- framework and bundler (or "script tag"):
- mode (`observe` / `guard` / `heal`) and `aggressiveness`:

**What happened**

**What you expected**

**How to reproduce**

A minimal page, repository or StackBlitz if you can. Otherwise: how GenClass was installed (`init`, `/auto`,
script tag, `GenClass.init()`), the options passed, and the steps.

**Console output**

Paste the `[GenClass]` lines (expand the collapsed groups). If GenClass took an action, include `rt.explain(id)`
for that decision and `rt.audit()` if you can.

**Does it reproduce with `?genclass=off` in the URL?** (yes / no)
