# Contributing

Thanks for looking. This repository holds `@genclass/runtime` (the library), its model package, and everything
used to train and evaluate the model. Issues and pull requests are welcome; the rules below keep the measurements
honest.

## Where things are

- `packages/runtime/` is the library: `src/` (observers, causality, stores, facts, triage, the policy gate, actions,
  the model host, devtools), `test/` (vitest), `bin/` (the `init` / `remove` / `fetch-model` CLI). Read
  `docs/runtime/CONTRACT.md` (binding design rules), `docs/runtime/API.md` and `packages/runtime/INTERCEPTION.md`
  before changing behaviour.
- `packages/runtime-model/` is the data-only model package and its model card.
- `sim/`, `realapps/`, `training/` produce and train on the model's data; `demos/`, `compat/`, `bench/heal/`
  evaluate the result. `docs/runtime/RESULTS.md` is where every measured number lives.
- `AGENTS.md` is the short guide for coding agents; it applies to people too.

## Build and test

Node ≥ 20. CI (`.github/workflows/ci.yml`) runs exactly this on every pull request:

```bash
ONNXRUNTIME_NODE_INSTALL=skip npm ci
npm run typecheck -w @genclass/runtime
npm run build -w @genclass/runtime
cd packages/runtime
NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**" --exclude test/review-perf.test.ts
NODE_OPTIONS=--expose-gc npx vitest run test/review-perf.test.ts --retry=2   # timing budgets; reported, not blocking
```

One test: `npx vitest run test/delivery.test.ts -t "<name>"`. Playwright tests (`npm run test:browser`), the
tarball smoke test (`test/smoke/smoke.sh`), the sim, the real-app corpus, the demos' evaluation and training are
not run in CI; say in the PR which of them you could not run.

## The rules

1. **Never make a correct app worse.** Observe mode never holds, delays or changes anything. In guard and heal,
   an action runs only when the model's gate clears, and every action is logged and, where possible, undoable.
   False interventions on clean runs are a first-class metric: report FIR next to every recall number. A change
   that adds a hold, a delay or an action on clean traffic needs a measurement, not an argument.
2. **No hardcoded bug patterns.** The runtime computes generic facts and decides what is salient; it never maps a
   fact pattern to a diagnosis or an action with an if/then. Actions are chosen only by the policy gate from the
   model's answers.
3. **Model-visible text is frozen.** Anything the model reads (`packages/runtime/src/situation/*`, facts, question,
   action and diagnosis wording, redaction output, op and event names) is tagged (`situation-v2.3`). Changing it
   means a new tag, regenerated data, an updated `training/curriculum/rt.py` mirror and retraining. Open an issue
   first.
4. **`sim/` and `demos/` authors never read each other's code.** The simulator and the real-app corpus generate
   training data; the demos and the compatibility apps are the evaluation. Neither side may be tuned to the other:
   `sim/` and `realapps/` never read or model `demos/` or `compat/`, and the demos and compat apps contain nothing
   beyond a normal integration. If you work on one side in a PR, do not touch the other.
5. **Determinism.** Runtime code uses the injected `Clock`, never `Math.random`, `Date.now`, `performance.now` or
   the global `setTimeout`. Same inputs give byte-identical situations.
6. **`packages/runtime/test/review-*.test.ts` are a contract.** Fix `src/`, never the test.
7. **Dependencies.** `onnxruntime-web` is the only runtime dependency; ask before adding another. Keep the committed
   root `package-lock.json` in sync.
8. **Releases** are published only by `.github/workflows/release.yml` from a `v*` tag, with npm provenance. Do not
   publish from a laptop.

## Pull requests

- One change per PR, with tests in the house style (`test/helpers.ts` → `setup()`; drive time with
  `clock.advance`; name the CONTRACT section in the `describe`).
- Update `docs/runtime/API.md` and the JSDoc in `src/types.ts` for public-surface changes, and add a line to
  `packages/runtime/CHANGELOG.md`.
- New numbers go to `docs/runtime/RESULTS.md`, with the FIR next to the recall and what was and was not compared.
- The PR template lists the checks. CI must be green.

## Reporting a false flag

GenClass flagged or acted on code that was right? That is a bug we want: use the "False flag or false
intervention" issue template and include the console group and `rt.explain(id)`.

## Security

See [SECURITY.md](SECURITY.md). Do not open public issues for vulnerabilities.
