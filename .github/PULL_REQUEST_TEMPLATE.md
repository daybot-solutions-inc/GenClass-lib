## What

<!-- one or two sentences: the change and why -->

## Checks

- [ ] `npm run typecheck -w @genclass/runtime` and `npm run build -w @genclass/runtime` pass
- [ ] unit tests pass (`npx vitest run --exclude "test/browser/**" --exclude test/review-perf.test.ts` in `packages/runtime`), with new tests for new behaviour
- [ ] no `packages/runtime/test/review-*.test.ts` was edited to make it pass
- [ ] no model-visible text changed (`packages/runtime/src/situation/*`, facts, question and action wording, redaction output), or the PR says so and names the new situation tag
- [ ] `docs/runtime/API.md` and the JSDoc in `src/types.ts` updated for any public-surface change; `packages/runtime/CHANGELOG.md` has an entry
- [ ] a correct app is not made worse: no new hold, delay or action on clean traffic (CONTRIBUTING.md, "never worse")
- [ ] `sim/` and `demos/` authors did not read each other's code (CONTRIBUTING.md)
- [ ] a dependency change updates the root `package-lock.json` in the same commit

## Notes for the reviewer

<!-- what to look at first; what was not run and why -->
