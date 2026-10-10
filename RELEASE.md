# Release procedure: `@genclass/runtime` and `@genclass/runtime-model`

> **Scope:** the next release. That is a model-backed `@genclass/runtime` (proposed `0.1.0-beta.0`) carrying the one-command install, published after the first situation-v2 model as `@genclass/runtime-model@0.1.0`. It also covers git tags, GitHub releases, and the checks before and after each publish. The `0.1.0-alpha.1` publish is kept as a record at the end.
> **Read this when:** you are asked to cut a release, prepare a tarball for the user to publish, or package a trained model.
> **Source of truth:** the code. Verified 2026-10-08 (~07:00 UTC) against branch `mvp-v2-merge` at f107013. That branch is `mvp-v2` (release commit 806a296), merged with origin/runtime eff18cb (dabbce2), plus the two runtime fixes 054da38 and f107013. Newer commits on origin/runtime (up to 5bc40c9) were read with `git show` and are not merged on this branch. If this doc and the code disagree, the code wins.

> **Next release: `@genclass/runtime@0.1.0-beta.4` (prepared on `mvp-v2-b6`, not published).** `0.1.0-beta.3`
> plus the Troy trial fixes (CHANGELOG): no ORT wasm in app builds, one clear warning for a CSP-blocked model,
> `fetch-model` self-hosting ORT, `init --no-telemetry` / `--telemetry` / `--model-url`, CSP detection and telemetry
> disclosure in `init`, no ORT `console.error` noise, `status.scope` = effective mode, smaller first load. The alias
> `genclass-runtime@0.1.0-beta.4` pins it. Publish from `packages/runtime`:
> `npm publish genclass-runtime-0.1.0-beta.4.tgz --access public --tag latest`, then from `packages/genclass-runtime`:
> `npm publish genclass-runtime-0.1.0-beta.4.tgz --access public --tag latest`. onnxruntime-web is now pinned to
> exactly `1.30.0` (tsup refuses another installed version).
>
> **Previous: `@genclass/runtime@0.1.0-beta.3` (prepared on `mvp-v2-b6`, not published; privacy-relevant).**
> `0.1.0-beta.2` plus default-on anonymous telemetry (`packages/runtime/TELEMETRY.md`, collector `telemetry-worker/`
> deployed at `https://genclass-telemetry.mehar-144.workers.dev`). The alias `genclass-runtime@0.1.0-beta.3` pins it.
> Publish from `packages/runtime`: `npm publish genclass-runtime-0.1.0-beta.3.tgz --access public --tag latest`, then
> from `packages/genclass-runtime`: `npm publish genclass-runtime-0.1.0-beta.3.tgz --access public --tag latest`.
> `src/version.ts` -> `RUNTIME_VERSION` must equal `package.json` `version` on every bump (a unit test checks it).
>
> **Previous: `@genclass/runtime@0.1.0-beta.2` (prepared on `mvp-v2-b6`).** It merges
> `0.1.0-beta.1` (published by Mehar from `runtime` at 696b1b4 with `@genclass/runtime-model@0.2.0`, defaulting to
> `guard`) with the `0.1.0-beta.0` fixes: observe default, observe never delaying deliveries, redaction, install CLI,
> jsDelivr `fetch-model` default (model `0.2.0`). The alias `genclass-runtime@0.1.0-beta.2` pins it. Publish from
> `packages/runtime`: `npm publish genclass-runtime-0.1.0-beta.2.tgz --access public --tag latest`, then from
> `packages/genclass-runtime`: `npm publish genclass-runtime-0.1.0-beta.2.tgz --access public --tag latest`. Model
> `0.2.0` is already on npm and jsDelivr (`model.json` 200); no model publish is needed.

> **Done 2026-10-08 (~13:40 UTC): Part B and Part C.** Published `@genclass/runtime-model@0.1.0` (dist-tag `latest`, same session; `r17-v2b` = `genclass-runtime-r17` 2.0.0-rc2 with gates guard 0.80 (mutation 0.95), heal 0.85 (failure 0.95, inconsistency 0.85), report 0.85; 9 files, 21.7 MB, shasum 84f3334428f0eea4d0e1a2a636b0003d8df3175f; local tag `runtime-model-v0.1.0`) and `@genclass/runtime@0.1.0-beta.0` (dist-tag `latest`, published 2026-10-08 ~13:40 UTC by `karanvir1729` with 2FA, from the clean release worktree at 1f0f617, branch `release/runtime-0.1.0-beta.0`, local annotated tag `v0.1.0-beta.0` not pushed; 52 files, 1.1 MB, shasum a15d2fb0d054ded5df81e9cb2ae87b1fd3f67e88). `@genclass/runtime@0.1.0-alpha.0` deprecated: "Old situation-v1 build that defaults to guard; use 0.1.0-beta.0 or later". jsDelivr serves `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/` (`model.json` 200; all 5 files' sha256 match `model.json`). Browser check: a plain HTML page with the jsDelivr script tag (`genclass.global.min.js` @0.1.0-beta.0) in Chromium: mode `observe`, model ready in a Web Worker on WebGPU (fp16), `loadMs` 4750, every gate's source `model`, `decide()` 72 ms. Nothing was pushed and no GitHub release was created (the user's GitHub account is read-only on daybot-solutions-inc/GenClass-lib); the CLI's `fetch-model` default is the jsDelivr model directory. Still open: push `mvp-v2-b6` and the tags (needs an account with write access); the GitHub releases (B5, C7) are optional. The rest of this doc is the procedure as planned.

## TL;DR

- **Versions.**
  - `0.1.0-alpha.1` is **taken**: our publish (05:33 UTC, dist-tag `latest`). It has the NaN fix, the situation-v2 runtime, the `observe` default and the docs. It does **not** have Mehar's one-command install.
  - **Proposed:** `0.1.0-beta.0` for the model-backed release, or `0.1.0-alpha.2` if a release without the model goes out first. Both carry the install features.
  - The tree still says `0.1.0-alpha.1` (`packages/runtime/package.json`, `packages/genclass-runtime/package.json`). Bump before any build or pack (step C3).
- **Order.**
  1. Validate the `r17-v2a` export, with gate thresholds fitted (B0–B2).
  2. Publish `@genclass/runtime-model@0.1.0` (B3, B4, B6). The GitHub release `runtime-model-v0.1.0` (B5) is optional: the CLI no longer defaults to it.
  3. Run the demos eval: Off / Observe / Guard (B7).
  4. Publish `@genclass/runtime@0.1.0-beta.0` and move `latest` to it (Part C).
- **The model needs batch 6, which is not on this branch.**
  - `r17-v2a`'s results are in origin/runtime 416e374 (`docs/runtime/RESULTS.md`). On held-out sim (`sim2e`): diagnosis 84.4%, action 77.9%, guard FIR 0.00%, heal FIR 0.46%. On the real-app eval set (16,600 rows): guard and heal FIR 0.00%. But at the fixed 0.9 / 0.8 gates it almost never acts: real-app recall is 0.6% for duplicates and 1.0% for stale.
  - origin/runtime 5bc40c9 ("Runtime batch 6", tag `situation-v2.1`) makes the runtime use the gate thresholds in the model's `meta.json` (`gate`). TRAIN fits them with `training/fit_gates.py --write-meta`.
  - So the beta needs 5bc40c9 merged, and an export whose `meta.json` has a fitted `gate`. Without batch 6 the runtime ignores `gate` and keeps 0.9 / 0.8.
  - A local branch `mvp-v2-b6` (merge commit 4e95373) merges 5bc40c9 onto f107013. It was not checked here.
- **Format drift since the model's training data.** `r17-v2a` trained on situation-v2 data (tag `situation-v2` = 6e5e86e). Since then, two things change what the runtime sends the model:
  - f107013, on this branch: redacted values. The F2 fact prints `[redacted] → [redacted]` instead of a diff. Numbers and arrays under a secret-named container are now `[redacted]` (STATUS.md: curriculum store names such as `pin.total` and `pass.content` hit this).
  - 5bc40c9: one new fact on stalls without a latency baseline (additive, `situation-v2.1`).

  The user and Mehar decide whether to accept this drift for the beta or tag a new format and regenerate (`HANDOFF.md`, "The training format is frozen").
- **Install blockers.** The 2026-10-08 install review is listed under [Blockers](#blockers-for-the-runtime-release). The high-severity one: `init --mode guard` writes the observe import.
- **Dist-tag.** The README tells users to run `npx @genclass/runtime init` and to use the unversioned script tag `https://cdn.jsdelivr.net/npm/@genclass/runtime`. Both resolve `latest`. So the new version must become `latest`; until it does, users get alpha.1, which has no `init` and no script-tag build.
- **Who runs what.**
  - Agents prepare and check everything: worktree, install, typecheck, build, unit tests, `npm pack`, the exact commands.
  - **Only the user publishes.** `npm publish` and `npm dist-tag` need their npm 2FA. The user also approves every `git push`, tag push and `gh release`.
  - Agents ask first before Playwright, `smoke.sh`, the install end-to-end runs, model downloads, the demos eval, and anything that touches training or Azure. Mehar runs Azure (`HANDOFF.md`).
- **Registry** (`npm view`, 2026-10-08 ~07:00 UTC):
  - `@genclass/runtime`: versions `0.0.0-stage`, `0.1.0-alpha.0`, `0.1.0-alpha.1`; `latest` = `0.1.0-alpha.1`, no other dist-tags.
  - `@genclass/runtime-model`: **404**. (Since 2026-10-08 ~13:40 UTC: `0.1.0` is `latest`; `@genclass/runtime` `latest` = `0.1.0-beta.0`, `0.1.0-alpha.0` deprecated. See the note at the top.)
  - `genclass-runtime` (unscoped alias): **404**, so the name is unregistered.
- **The default model URL is pinned.**
  - `packages/runtime/src/model/host.ts` -> `DEFAULT_MODEL_BASE_URL` = `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/`.
  - `packages/runtime/bin/genclass-runtime.mjs` -> `DEFAULT_FROM` = the same jsDelivr directory (`fetch-model`'s default `--from`; `test/install/cli.test.ts` keeps the two equal). It used to be the GitHub release `runtime-model-v0.1.0`, which we cannot create (no write access to the repo's releases); the published `0.1.0-alpha.1` CLI still defaults to that release, so with alpha.1 pass `--from` explicitly.
  - npm versions are immutable, so **whatever is published as `@genclass/runtime-model@0.1.0` is what every default `GenClass.init()` loads, permanently.** That includes alpha.1, which is `latest` today: it starts loading the model the moment the package exists (in observe mode, so it only reports).
- **Never publish a round-1 (`situation-v1`) model as `0.1.0`.** `packages/runtime/src/model/loader.ts` checks only the card format `genclass-runtime-model/1`, never a situation version. A v1 model would load into the v2 runtime without any error.
- **npm 11 refuses to publish a prerelease without `--tag`.** npm 11.8.0 `lib/commands/publish.js` throws "You must specify a tag using --tag when publishing a prerelease version." A non-prerelease (`0.1.0`) needs no tag and becomes `latest`.

## Versions

| package | on npm | next | why |
|---|---|---|---|
| `@genclass/runtime` | `0.1.0-alpha.1` (`latest`), `0.1.0-alpha.0`, `0.0.0-stage` | **`0.1.0-beta.0`** with the model; `0.1.0-alpha.2` if released before the model | `alpha.1` is taken by our publish, which has no install features |
| `@genclass/runtime-model` | none | **`0.1.0`** (no other choice) | pinned by `DEFAULT_MODEL_BASE_URL` and `DEFAULT_FROM` |
| `genclass-runtime` (alias, `packages/genclass-runtime`) | none | same version as `@genclass/runtime`, if published at all | its `dependencies` pins `@genclass/runtime` **exactly** (today `0.1.0-alpha.1`, which has no `init`), so it must be bumped together |

Later: `@genclass/runtime@0.1.0` (no prerelease tag; OPEN_TASKS.md "Next"). Proposed: only after the beta has run on a real app (OPEN_TASKS.md, "Install on Polar Parts").

## What the next runtime release contains (since 806a296)

From `git log 806a296..f107013` and `git diff 806a296 f107013 -- packages/runtime packages/genclass-runtime`:

- **One-command install** (f3a9dd1, Mehar; owner INSTALL, `packages/runtime/INSTALL-NEEDS.md`):
  - `init` / `remove` in `packages/runtime/bin/lib/{init,plan,detect,edit,ui}.mjs`;
  - the `./auto`, `./auto/observe`, `./auto/guard` and `./auto/heal` exports (`src/auto.ts`, `src/cdn/auto-*.ts`);
  - the script-tag build (`src/cdn/*`): `dist/genclass.global{,.min}.js` plus `dist/cdn/{worker,ort-wasm,ort-webgpu}.js`, from extra configs in `packages/runtime/tsup.config.ts`;
  - the `sideEffects` list, and `unpkg` / `jsdelivr` fields pointing at `dist/genclass.global.min.js`;
  - the unscoped alias `packages/genclass-runtime`;
  - tests in `packages/runtime/test/install/*`.
- **Observe mode never holds or delays a delivery** (054da38). See `packages/runtime/src/runtime.ts`:
  - `RuntimeImpl.deliveryHoldable` returns false in observe mode;
  - `RuntimeImpl.runDelivery` then releases the delivery before any body read;
  - the decision is still made in the background and recorded (`executed: false`, reason "observe mode never changes execution");
  - standing questions on `delivery` are answered;
  - the delivery's own writes are not decided a second time (`RuntimeImpl.covered`).

  Tests: `packages/runtime/test/observe-delivery.test.ts`.
- **Redaction fixes** (f107013):
  - `src/situation/content.ts` -> `contentFacts` uses `src/state/fields.ts` -> `redactedStringDiff`;
  - `src/util.ts` -> `isSensitivePath` redacts numbers, bigints and arrays under a strong secret-named container.

  Tests: `packages/runtime/test/redaction-v2.test.ts`. Remaining gaps are in `packages/runtime/STATUS.md` and the runtime README's known limitations.
- A `situation()` purity regression test (29b7f28), the rewritten npm README (d05abc1), and more real apps (the eff18cb tree has 128 app manifests).
- **To merge first (not on this branch):** origin/runtime ca08174 (realapps wave 4), 6d6eb00 (REAL v2 data done), 416e374 (`r17-v2a` results) and 5bc40c9 (batch 6: model gate thresholds, no-baseline stall fallback, `runtime.gates()`, `training/fit_gates.py`).

## Blockers for the runtime release

From the 2026-10-08 install review (each finding was reproduced by a second reviewer). Most are user-visible and are listed in the runtime README's known limitations until fixed.

| severity | where (`path` -> `symbol`) | problem | fix proposed by the review |
|---|---|---|---|
| high | `packages/runtime/bin/lib/plan.mjs` -> `AUTO`, `scriptTag`; `bin/lib/init.mjs` USAGE and the "Mode" row | `AUTO` and `scriptTag` treat `guard` as the default, but the runtime default is `observe` (`src/runtime.ts`: `o.mode ?? "observe"`). `init --mode guard` prints "Mode guard" and writes the bare `/auto` import (observe); the script tag gets no `data-mode`. `test/install/INSTALL-README-SNIPPET.md` still says guard is the default | `AUTO = (mode) => mode ? "@genclass/runtime/auto/" + mode : "@genclass/runtime/auto"`; emit `data-mode` whenever a mode is set; say `observe (default)`; add `cli.test.ts` cases for `--mode guard` and for no flag |
| medium | `packages/runtime/package.json` `version`; `packages/runtime/CHANGELOG.md` | The tree is `0.1.0-alpha.1`. A build bakes that into the global build (`tsup.config.ts` -> `globalBuild`, `__GENCLASS_VERSION__`), so `src/cdn/global.ts` -> `assetBase` and `bin/lib/plan.mjs` -> `scriptTag` point at alpha.1 on the CDN. That version has no `dist/cdn/*` and no global build. `init` would install `^0.1.0-alpha.1`, which has no `./auto` export. The CHANGELOG lists the install features under `0.1.0-alpha.1` | Step C3: bump, then rebuild; move those CHANGELOG bullets to the new version's section |
| medium | `packages/runtime/bin/lib/edit.mjs` -> `removeMarked` | A formatter that rewraps an inserted line (the dev-only devtools line; the one-line Next.js layout form) makes `remove` leave code that does not compile | start/end markers around multi-line insertions; `remove` checks its result and refuses if it looks broken |
| medium | `packages/runtime/package.json` `exports` | No `typesVersions`, so TypeScript with `"moduleResolution": "node"` (CRA TypeScript) cannot find the types of `/auto`, `/devtools` or `/react` (TS2307) after `init` | add `typesVersions` for every subpath; add a node10-resolution check |
| medium | `packages/runtime/bin/lib/detect.mjs` -> `detectProject` | Any esbuild, rollup, parcel or webpack dependency means "browser app", so `init` edits Node server and library entries | require evidence of a browser app (an HTML entry), else `manualHelp` |
| medium | `packages/runtime/bin/lib/plan.mjs` -> `integrityFor` | `--cdn <url>` gets the SRI hash of the CLI's own dist file whatever version the URL names, so the browser blocks the script | add SRI only for the default URL or one pinned to exactly this version; list `--no-sri` in USAGE |
| low | `bin/lib/edit.mjs` -> `removeMarked`; `bin/lib/init.mjs` -> `remove` | `remove` deletes user code inside marked blocks and created files, everything after a start marker whose end is lost, and any line containing `genclass:init` | hash created blocks; treat an unclosed block as an error; match markers exactly |
| low | `bin/lib/detect.mjs` -> `walkSources`; `bin/lib/init.mjs` -> `remove` | `remove` uninstalls the package while dot-folders (`.storybook`), `tmp`, `out` or `build` still import it, or when the user installed it before `init` | uninstall only what `init` installed; scan dot-folders |
| low | `packages/runtime/package.json` `sideEffects` | `./dist/worker.js` (the public `./worker` export, side effects only) is missing, so a bare `import "@genclass/runtime/worker"` bundles to nothing | **add** `./dist/worker.js` and **keep** `./src/model/worker.ts`; removing that entry empties `dist/cdn/worker.js` (reproduced by the reviewer) |
| low | `packages/runtime/src/cdn/config.ts` -> `readMetaConfig`; `bin/lib/plan.mjs` -> `integrityFor` | Every `<meta name="genclass">` in the document is read, including the body, and may set `ort` / `model` URLs. SRI covers only the loader, not the worker, ONNX glue or devtools it loads | read only `head > meta`; no remote URLs from meta; document what SRI covers |
| low | `bin/lib/init.mjs` -> `init`; `src/index.ts` -> `GenClass.init` | Re-running `init` with another `--mode` prints "Nothing to do"; a later `GenClass.init(options)` after `/auto` is silently ignored | compare the existing import with `AUTO(o.mode)` (after the `AUTO` fix); warn once on differing options |

Also decide (INSTALL-NEEDS.md item 1): publish the `genclass-runtime` alias with this release, or drop `npx genclass-runtime` from the docs. The name is unregistered on npm. Until it is published by us, anyone can register it, and `npx genclass-runtime init` would then run their code.

Runtime review findings still open (2026-10-08 review; see [Drift and open issues](#drift-and-open-issues)): the Redux/Zustand discard no-op, the 10 s discard mark, long `defer` on push channels, held WS/SSE messages after `close()`, and 502 described as "not processed". None of them affects observe mode, the default. Fix or accept them with the user and Mehar before the beta. The observe-mode holds and the two redaction leaks from the same review are fixed (054da38, f107013).

## Files

| path | role in a release |
|---|---|
| `packages/runtime/package.json` | `@genclass/runtime`, `version` `0.1.0-alpha.1` (not bumped since 806a296). `files`: `dist`, `bin`, `README.md`, `LICENSE`. `bin`: `genclass-runtime` only. No `prepublishOnly`, no `publishConfig` |
| `packages/genclass-runtime/package.json` | unscoped alias `genclass-runtime`, `version` `0.1.0-alpha.1`, `dependencies` `"@genclass/runtime": "0.1.0-alpha.1"` (exact). `bin` `genclass-runtime` -> `cli.mjs`, which imports `@genclass/runtime`'s `bin/genclass-runtime.mjs` |
| `package-lock.json` (root) | committed. Records both workspace versions and the alias's dependency, so a bump changes it. CI's `npm ci` fails if it is out of sync |
| `packages/runtime/README.md` | the npm page. Packed, so it must be correct **before** packing |
| `packages/runtime/CHANGELOG.md` | not packed. Its `0.1.0-alpha.1` section wrongly lists the install features |
| `packages/runtime/tsup.config.ts` | four configs: the main ESM build, the global build twice (plain and `.min`, with `__GENCLASS_VERSION__` from `package.json`), and `dist/cdn/*` |
| `packages/runtime/bin/genclass-runtime.mjs`, `packages/runtime/bin/lib/*.mjs` | CLI: `init`, `remove`, `fetch-model`, `info`. `bin/lib/init.mjs` reads the version from `package.json` at run time and hashes the local `dist/genclass.global*.js` for SRI |
| `packages/runtime/test/smoke/smoke.sh` | packs, installs the tarball into a fresh Vite 8 app, builds it, loads it in headless Chromium (Playwright 1.63.0) with `model: false`. It does not exercise `init`, `/auto` or the script tag |
| `packages/runtime/test/install/run-all.sh`, `cdn-check.mjs`, `frameworks.mjs`, `scaffold.sh` | install end-to-end: build, pack, CLI tests, script-tag and `/auto` checks in Chromium, real scaffolds through `init` / build / browse / `remove`. Runs on Mehar's VM ("the Mac never runs this"). Last run: against `0.1.0-alpha.0` (`test/install/RESULTS.md`), when `/auto` defaulted to guard |
| `packages/runtime/test/model/helpers.ts` | `GENCLASS_MODEL_DIR` (default `<repo>/.cache-model`, gitignored). `FIXTURES_FROM_MODEL` switches the parity fixtures to the export's own `requests.json`, `pack_fixtures.json`, `torch_fixtures.json` |
| `packages/runtime-model/MODEL_CARD.md` | the only tracked file of the model package. Still describes round 1 (situation-v1) |
| `packages/runtime-model/files/` | gitignored; holds the model directory to pack. Does not exist in this checkout |
| `training/v2_post.sh` (6d6eb00 on origin/runtime adds the real-app evals; this branch has the eff18cb version), `training/fit_gates.py` and `training/collect_gate_set.sh` (5bc40c9; not on this branch), `training/export_runtime.py`, `training/pull_on_train.sh`, `training/ortweb/validate.mjs` | TRAIN's eval -> export -> gates -> delivery -> onnxruntime-web check chain (B1) |
| `demos/scripts/vm-eval.sh`, `demos/e2e/eval.ts`, `demos/src/shared/{types,genclass}.ts` | demos eval (B7) |
| `.gitignore` | ignores `*.tgz` and `.publish/` |

## Concepts

| term | meaning |
|---|---|
| dist-tag | npm label pointing at one version. `latest` is what `npm i @genclass/runtime`, `npx @genclass/runtime` and the unversioned jsDelivr URL resolve. `alpha` and `beta` are opt-in |
| prerelease | a version with a `-` suffix (`0.1.0-alpha.2`, `0.1.0-beta.0`). npm 11 requires `--tag` to publish one |
| release worktree | a clean `git worktree` of the commit being released. Other checkouts hold other agents' uncommitted edits (on 2026-10-08 this one had uncommitted `docs/agents/*` edits), and `tsup` bundles whatever is on disk |
| model export | the directory `training/export_runtime.py` writes: `model.json` (card `genclass-runtime-model/1`, with `bytes` and `sha256`), `<name>-q8.onnx` (WASM), `<name>-fp16.onnx` (WebGPU, `needs: shader-f16`), `tokenizer.json`, `calibration.json`, `meta.json`, plus the parity files `parity.json`, `requests.json`, `pack_fixtures.json`, `torch_fixtures.json`. `ref/` is left out of the delivered tar |
| `gate` (meta.json) | `{ report?, guard: { default, byTrigger? }, heal: { default, byTrigger? } }`, written by `training/fit_gates.py --write-meta <export>`, which also rewrites the card's sha256 for `meta.json`. Read only by a runtime with batch 6 (5bc40c9: `src/decide/policy.ts` -> `parseGate`, `effectiveGates`) |
| `ortweb_report_q8.json` | written into the export by `training/ortweb/validate.mjs <dir> q8 <n>`: onnxruntime-web (WASM in Node) and onnxruntime-node logits compared with PyTorch per backend (`argmax_agree`, `argmax_total`, `max_abs_logit`, `est_ms_at_seq_tokens`, `error`) |

Step markers: **[agent]** is light and allowed locally. **[ask first]** needs the user's OK in chat. **[user only]** is run by the user with their npm 2FA, or by Mehar on his Azure setup.

## Part B: `@genclass/runtime-model@0.1.0` (done 2026-10-08 with `r17-v2b`; see the note at the top)

### B0. Gates before packaging anything

- **EVAL for the model being shipped.** `r17-v2a`'s numbers are in `docs/runtime/RESULTS.md` on origin/runtime (416e374), with FIR next to every recall. They must also go into `training/EVAL.md` (`HANDOFF.md` rule "Report honestly"). Targets (RESULTS.md §1): guard FIR ≤ 0.1% (met by `r17-v2a` on every set). Heal FIR ≤ 0.5%: met on `sim2e` (0.46%) and on the real-app set (0.00%), missed on `sim2f`, held-out app features (0.75%). Diagnosis ≥ 95% and clear-case recall ≥ 80%: not met. These are at the fixed 0.9 / 0.8 gates; fitted gates change FIR and recall, so measure again at them.
- **Fitted gates in the export.** `training/collect_gate_set.sh r17-v2a`, then `training/fit_gates.py ... --write-meta out/export-r17-v2a` (TRAIN, Azure). Check that `meta.json` has a `gate` object, and record the FIR and recall at those gates on the test sets.
- **Which model.** `r17-v2a` is the first situation-v2 R17. It was not distilled from a teacher and saw no real-app gold (`mix_v2a`: sim2 0.86, cur5 0.11, cur1 0.02, gen 0.01). The 150M teacher `t150-v2a` (ETA ≈ 08:30 UTC) and distillation come later. **Decision for the user and Mehar:** ship `r17-v2a` as the permanent `0.1.0`, or wait for the distilled model. Either way, only one model can ever be `0.1.0`.
- **Format.** Accept or resolve the drift listed in the TL;DR (f107013, 5bc40c9) before publishing.
- **Calibration source.** `training/v2_post.sh` calibrates on `sim2e` (`--calibration out/cal/$M-sim2e.json`), not the v1 set `simAe` that `training/final_post.sh` is tied to. Confirm that the export was made by `v2_post.sh`. `training/eval_runtime.py` caches logits by checkpoint and data *name*, so confirm that no stale cache was reused.
- **Version fields.** The npm package must be exactly `0.1.0` (pinned URL). The card's `version` is not checked by the runtime; `loader.ts` -> `cardId` (`name@version`) uses it as a cache key. Make it `0.1.0` anyway. `v2_post.sh`'s header example passes `2.0.0-rc1`, and the version actually used for `r17-v2a` is unverified.

### B1. Get the export **[user only (Mehar) for the Azure side; ask first to copy it here: model download]**

1. On the model's rank-0 node, `training/v2_post.sh <M> <NAME> <VER>` (origin/runtime version) waits for the final checkpoint and then:
   - evaluates `sim2e` and `sim2f`, the expected gain (`eval_gain.py`) and the real-app sets (`eval_real_sets.sh`, added in 6d6eb00);
   - runs `export_runtime.py --ckpt models/<M> --out out/export-<M> --name <NAME> --version <VER> --calibration out/cal/<M>-sim2e.json`;
   - tars `out/export-<M>` without `ref/` into `~/xfer/export-<M>.tar` and serves it on port 8801.

   For `r17-v2a` it runs detached on c09.
2. Gates (B0) are written into the export, so they must come before the tar that is delivered. If the tar was made first, rebuild it.
3. On the `train` VM, `training/pull_on_train.sh <IP> <M> <ROUND> <SUB>` unpacks into `~/gcl/train-out/<ROUND>/<SUB>/`, checks every sha256 against `model.json`, and runs `ortweb/validate.mjs <dir> q8 120`. Round 1 used `~/gcl/train-out/final1/{r17,r32}/`. The v2 directory name is not decided (unverified).
4. Copy it to the release machine as `<repo>/.cache-model/` (gitignored; the model tests' default `GENCLASS_MODEL_DIR`). On Mehar's setup, `scripts/vm.sh get train-out <ROUND>/<SUB> .cache-model` should work (unverified).

Expected contents: `model.json`; `<NAME>-q8.onnx` and `<NAME>-fp16.onnx`; `tokenizer.json`, `calibration.json`, `meta.json` (with `gate`); `parity.json`, `requests.json`, `pack_fixtures.json`, `torch_fixtures.json`, `ortweb_report_q8.json`.

### B2. Validate **[agent once the directory is here; ask first where marked]**

Run in a worktree that has batch 6 merged, so the runtime reads `gate`:

```sh
node packages/runtime/bin/genclass-runtime.mjs info .cache-model
node -e "const c=require('./.cache-model/model.json'); console.log(c.format, c.name, c.version, Object.keys(c.variants))"
node -e "console.log(JSON.stringify(require('./.cache-model/meta.json').gate))"
cd packages/runtime
GENCLASS_MODEL_DIR=$PWD/../../.cache-model NODE_OPTIONS=--expose-gc npx vitest run test/model
GENCLASS_MODEL_DIR=$PWD/../../.cache-model NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**" --exclude test/review-perf.test.ts
```

- **`info`** must exit 0: every file `sha256 ok`; `fp16*` marked "needs a WebGPU feature"; no `WARNING` lines; card `genclass-runtime-model/1` with variants `q8` and `fp16`.
- **Model unit tests.** With the export's fixtures, `FIXTURES_FROM_MODEL` is true, and the packer, engine and calibration tests compare the TypeScript side with the export's own PyTorch fixtures and `parity.json`. Without a model directory they skip (14 skips at f107013). Which tests still skip with a v2 export has not been checked (unverified). Read failures before dismissing them.
- **`ortweb_report_q8.json`:** for every backend, `argmax_agree` equals `argmax_total`, and there is no `error`. Note `est_ms_at_seq_tokens` for the model card. To re-run here **[ask first; installs onnxruntime-node/web in `training/ortweb`]**: `cd training/ortweb && npm install && node validate.mjs ../../.cache-model q8 120`.
- **Gates reach the runtime:** batch 6's `test/gates.test.ts` covers this with a stub. With the real model, check that `GenClass.runtime.gates()` reports `source.guard === "model"` in a page (next step).
- **Browser model specs [ask first; Playwright]:** `GENCLASS_MODEL_DIR=$PWD/../../.cache-model npm run test:browser`. `test/browser/model-helpers.ts` always loads the v0.1 fixtures from `test/fixtures/model/`, so the parity part of the first `model.spec.ts` test is expected to fail on a v2 model. The other specs do not depend on the model.

### B3. Package **[agent]**

1. Fill `packages/runtime-model/files/` with **only** the card's files, flat (`model.json` directly in `files/`; `loader.ts` fetches `<baseUrl>model.json`):

   ```sh
   rm -rf packages/runtime-model/files && mkdir -p packages/runtime-model/files
   cp .cache-model/{model.json,tokenizer.json,calibration.json,meta.json,<NAME>-q8.onnx,<NAME>-fp16.onnx} packages/runtime-model/files/
   node packages/runtime/bin/genclass-runtime.mjs info packages/runtime-model/files
   cp packages/runtime/LICENSE packages/runtime-model/LICENSE
   ```

2. Create `packages/runtime-model/package.json`:

   ```json
   {
     "name": "@genclass/runtime-model",
     "version": "0.1.0",
     "description": "The GenClass runtime model for @genclass/runtime (situation-v2): q8 ONNX for WASM, fp16 ONNX for WebGPU, tokenizer, calibration and gate thresholds. Loaded from jsDelivr as the runtime's default model.",
     "license": "Apache-2.0",
     "repository": { "type": "git", "url": "git+https://github.com/daybot-solutions-inc/GenClass-lib.git", "directory": "packages/runtime-model" },
     "homepage": "https://github.com/daybot-solutions-inc/GenClass-lib#readme",
     "files": ["files/", "MODEL_CARD.md"]
   }
   ```

   `files/` stays gitignored but is packed: listing it in `files` overrides the ignore rule (checked with npm 11.8.0 on a scratch monorepo).
3. The new `package.json` makes it a workspace (root `workspaces: ["packages/*", "sim", "demos"]`). Run `npm install --no-audit --no-fund` to add it to `package-lock.json`, then `cd packages/runtime-model && npm pack --dry-run` (expect `LICENSE`, `MODEL_CARD.md`, `package.json` and the 6 `files/` entries).
4. Rewrite `MODEL_CARD.md` for the v2 model: numbers from `training/EVAL.md`, FIR next to every recall, the gates and what they were fitted on, sizes and latency from `parity.json` and `ortweb_report_q8.json`.
5. Commit `packages/runtime-model/{package.json,LICENSE,MODEL_CARD.md}` and `package-lock.json`. Never commit `files/`. Round 1's R17 was 9.58 MB (q8) plus 13.57 MB (fp16) (`training/LOG.md`).

### B4. Publish the model **[user only]**

```sh
cd packages/runtime-model
npm pack                                                  # genclass-runtime-model-0.1.0.tgz (gitignored)
shasum -a 1 genclass-runtime-model-0.1.0.tgz
npm publish genclass-runtime-model-0.1.0.tgz --access public
```

- `--access public` is required for a scoped package. No `--tag` is needed: `0.1.0` becomes `latest`.
- Whether `karanvir1729` (developer role in the `genclass` org) may create a new package in the scope is unverified. If npm refuses, `meharpro` (owner) publishes.
- **Irreversible.** Every runtime on the default URL starts loading this model, including the published `0.1.0-alpha.1` and `0.1.0-alpha.0` (both pin `@genclass/runtime-model@0.1.0/files/`; checked at tags `v0.1.0-alpha.1` and `v0.1.0-alpha.0`).
  - alpha.1 defaults to observe, so it only reports.
  - alpha.0 defaults to **guard**, holds store writes, and renders `situation-v1` text, which this model was not trained on. In apps still on alpha.0 it can act on that text.
  - Consider `npm deprecate @genclass/runtime@0.1.0-alpha.0 "<message>"` **[user only]** before this publish.

### B5. GitHub release `runtime-model-v0.1.0` **[optional; ask first; user's call]**

Not needed by the CLI any more (`DEFAULT_FROM` is the jsDelivr directory). Only the published `0.1.0-alpha.1` CLI defaults to this release; it needs write access to the repo's releases.

`fetch-model` resolves each card file as `new URL(file, from)`, so the assets must be the same six files, flat, with the card's names:

```sh
git tag -a runtime-model-v0.1.0 -m "@genclass/runtime-model 0.1.0 (npm)"
git push origin runtime-model-v0.1.0
gh release create runtime-model-v0.1.0 packages/runtime-model/files/* \
  -R daybot-solutions-inc/GenClass-lib --verify-tag --latest=false \
  --title "@genclass/runtime-model 0.1.0" --notes-file packages/runtime-model/MODEL_CARD.md
```

### B6. Verify the CDN and the release

```sh
npm view @genclass/runtime-model dist-tags version dist.shasum dist.fileCount       # [agent] shasum = B4's
curl -fsSI https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/model.json \
  | grep -i -E "^HTTP|access-control-allow-origin|content-type"                     # [agent] 200, CORS allowed
curl -fsS https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/model.json \
  | diff - packages/runtime-model/files/model.json && echo "CDN card identical"       # [agent]
# [ask first: model downloads] into a scratch directory
node packages/runtime/bin/genclass-runtime.mjs fetch-model <scratch>/gc-cdn         # default --from = DEFAULT_FROM = the jsDelivr directory
node packages/runtime/bin/genclass-runtime.mjs info <scratch>/gc-cdn
# only if B5 was done:
node packages/runtime/bin/genclass-runtime.mjs fetch-model <scratch>/gc-gh --from https://github.com/daybot-solutions-inc/GenClass-lib/releases/download/runtime-model-v0.1.0/
node packages/runtime/bin/genclass-runtime.mjs info <scratch>/gc-gh
```

### B7. Demos eval: Off / Observe / Guard **[ask first; Mehar's VM; two code changes first]**

Does the shipped default (`observe` with the model) or `guard` make the six demos worse than the baseline, and what does guard fix? Never tune the demos for a result (`HANDOFF.md`).

Prerequisites (code changes, not done on this branch):

1. **`demos/src/server/data/cities.ts` is missing from git** (the root `.gitignore` rule `data/` ignores it). Recreate it with `searchCities(q)` and `TYPED_TARGETS` (see [docs/agents/demos.md](docs/agents/demos.md)), and add it with `git add -f` or narrow the rule.
2. **An `observe` demo mode.** `GcMode` in `demos/src/shared/types.ts` is `"off" | "guard" | "heal"`, and demo **Off** = `GenClass.init({ mode: "observe", model: false })` (`demos/src/shared/genclass.ts` -> `startGenClass`). Add `"observe"` to `GcMode` and `MODES`, `demos/e2e/eval.ts` -> `ALL_MODES`, and the `MODE_LABEL` / `MODE_HINT` records in `demos/src/site/demo-page.ts` and `demos/src/site/trials-panel.ts`.

```sh
scripts/vm.sh run demos 'GENCLASS_MODEL_URL=cdn setsid nohup bash demos/scripts/vm-eval.sh --modes off,observe,guard --tag runtime-model-0.1.0 > ~/gcl/logs/demos-eval.log 2>&1 < /dev/null &'
```

`GENCLASS_MODEL_URL=cdn` loads the published package. Results go to `demos/results-runtime-model-0.1.0.{json,md}`; record them in `docs/runtime/RESULTS.md` §5. **Gate for Part C:** on clean runs, Observe and Guard introduce no bugs that Off does not have; report every fix count with its false interventions.

## Part C: `@genclass/runtime@0.1.0-beta.0` (done 2026-10-08; see the note at the top)

Replace `0.1.0-beta.0` with `0.1.0-alpha.2` throughout if it goes out before Part B.

### C0. Decisions for the user (and Mehar)

1. **Version:** `0.1.0-beta.0` (with the model) or `0.1.0-alpha.2` (before it).
2. **Format drift** (TL;DR): accept f107013 and 5bc40c9 against a model trained on `situation-v2`, or tag and regenerate.
3. **Which blockers to fix** (table above). At least the high-severity `init --mode` mapping and the version bump. Every fix to `bin/lib/*` needs a `cli.test.ts` case.
4. **Alias:** publish `genclass-runtime` too, or remove `npx genclass-runtime` from the README.
5. **Branch:** the release commit must reach `origin`. This branch (`mvp-v2-merge`) and `mvp-v2` (806a296, tag `v0.1.0-alpha.1` local only) are not pushed.

### C1. Merge and docs **[agent]**

- Merge origin/runtime (5bc40c9 or later), resolve, `npm install --no-audit --no-fund` if the lockfile changed, and run C2.
- `packages/runtime/README.md`:
  - status: the model is published, and what it measures;
  - "Modes": what observe, guard and heal do *with* the model and its gates (batch 6 adds `rt.gates()`);
  - the install section loses "Next release";
  - known limitations: drop what the blockers fixed.
- `packages/runtime/CHANGELOG.md`: a `## 0.1.0-beta.0` section with the install features, 054da38, f107013 and batch 6. The `0.1.0-alpha.1` section keeps only what was published (NaN fix, situation-v2 runtime, observe default, docs).
- `test/install/INSTALL-README-SNIPPET.md`: observe is the default.

### C2. Clean release worktree and pre-flight **[agent]**

```sh
git worktree add -b release/runtime-0.1.0-beta.0 ../GenClass-lib-release-beta <release-branch>
cd ../GenClass-lib-release-beta && git status --porcelain   # must print nothing
npm ci --no-audit --no-fund                                 # on Linux: ONNXRUNTIME_NODE_INSTALL=skip, as CI does
npm run typecheck -w @genclass/runtime
npm run build -w @genclass/runtime
cd packages/runtime
NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**" --exclude test/review-perf.test.ts
NODE_OPTIONS=--expose-gc npx vitest run test/review-perf.test.ts --retry=2
npm pack --dry-run
```

Mind the disk: a worktree plus `npm ci` needs several hundred MB. On 2026-10-08 this machine had under 3 GB free, and `/Users/karanvirkhanna/GenClass-lib-release` (the alpha.1 worktree) still exists. Remove it first (`git worktree remove ../GenClass-lib-release`) once nobody needs it.

Measured at f107013 (version still `0.1.0-alpha.1`):

- unit run: "Test Files 44 passed | 1 skipped (45)", "Tests 375 passed | 14 skipped (389)";
- perf: 4 passed;
- `npm pack --dry-run`: 52 files, 1.1 MB packed, 4.2 MB unpacked. That includes `dist/genclass.global.min.js` (254.5 kB; 86 kB gzip) and `dist/cdn/{worker,ort-wasm,ort-webgpu}.js` (16 / 24 / 39 kB gzip).

With batch 6 merged, the counts change. Batch 6 alone reported 45 files and 375 tests on the VM, without our two fixes. Write down the new numbers here.

### C3. Version bump, then rebuild **[agent]**

```sh
npm version 0.1.0-beta.0 -w @genclass/runtime -w genclass-runtime --no-git-tag-version
# then set packages/genclass-runtime/package.json dependencies["@genclass/runtime"] to "0.1.0-beta.0" (npm version leaves it)
npm install --no-audit --no-fund                             # resync the lockfile's alias dependency
git diff --stat                                              # expect the two package.json files and package-lock.json only
npm run build -w @genclass/runtime                           # required: the global build bakes the version
grep -o '0\.1\.0-[a-z]*\.[0-9]*' packages/runtime/dist/genclass.global.min.js | sort -u   # expect only the new version
```

Unlike alpha.1, **the version is in the build**: `tsup.config.ts` -> `globalBuild` defines `__GENCLASS_VERSION__`, which `src/cdn/global.ts` -> `assetBase` uses for every CDN URL. `init` writes `^<version>` and a CDN URL pinned to `<version>`, and hashes the local `dist/genclass.global*.js` for SRI. So pack only after the rebuild. The `-w genclass-runtime` form and the lockfile step for the alias are unverified; check the diff. Commit:

```sh
git add packages/runtime/package.json packages/genclass-runtime/package.json package-lock.json
git commit -m "release: @genclass/runtime 0.1.0-beta.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### C4. Pack and smoke-test the exact tarball

```sh
cd packages/runtime
npm run build && npm pack                                    # [agent] genclass-runtime-0.1.0-beta.0.tgz (gitignored)
shasum -a 1 genclass-runtime-0.1.0-beta.0.tgz
bash test/smoke/smoke.sh                                     # [ask first] Playwright; packs again, prints "SMOKE OK: <tgz>"
```

- `smoke.sh` runs `npm run build` and `npm pack` itself; publish the tarball it leaves. It uses `model: false` and does not cover `init`, `/auto` or the script tag.
- **Install end-to-end [ask first; Mehar's VM]:** `bash test/install/run-all.sh` (`cdn-check.mjs` plus the real scaffolds). Its last results (`test/install/RESULTS.md`) are from `0.1.0-alpha.0`, when `/auto` meant guard. Re-run it on the beta tarball and update RESULTS.md.
- **Smoke with the model [ask first]:** a page built from the tarball, default `GenClass.init()`. Expect `GenClass.runtime.status.state === "ready"`, the card's model and version in the status, `status.variant` `q8` (WASM) or `fp16` (WebGPU), and `GenClass.runtime.gates().source.guard === "model"` (batch 6).
- Optional **[agent; tell the user first: it is an `npm publish` call that uploads nothing]**: `npm publish genclass-runtime-0.1.0-beta.0.tgz --access public --tag beta --dry-run`.

### C5. Publish **[user only]**

```sh
npm whoami
npm publish genclass-runtime-0.1.0-beta.0.tgz --access public --tag beta
npm dist-tag add @genclass/runtime@0.1.0-beta.0 latest      # so npx @genclass/runtime init and the script tag get it
# alias, if C0.4 says so (from packages/genclass-runtime, after the runtime is on npm):
npm pack && npm publish genclass-runtime-0.1.0-beta.0.tgz --access public --tag beta && npm dist-tag add genclass-runtime@0.1.0-beta.0 latest
```

A version can never be republished, even after an unpublish. Publish the checked tarball, never a bare `npm publish`.

### C6. Verify **[agent]**

```sh
npm view @genclass/runtime dist-tags                         # beta and latest: 0.1.0-beta.0
npm view @genclass/runtime@0.1.0-beta.0 version dist.shasum dist.fileCount   # shasum = C4's
curl -fsSI https://cdn.jsdelivr.net/npm/@genclass/runtime@0.1.0-beta.0/dist/genclass.global.min.js | head -1   # 200
curl -fsSI https://cdn.jsdelivr.net/npm/@genclass/runtime@0.1.0-beta.0/dist/cdn/worker.js | head -1           # 200
```

Then, in a scratch directory **[agent]**: `npm init -y`, `npm i @genclass/runtime@0.1.0-beta.0`, an import check, and `npx @genclass/runtime init --dry-run --yes` on a scratch Vite project. It must print `npm install @genclass/runtime@^0.1.0-beta.0`.

### C7. Tag, push, GitHub release **[ask first for every push; `gh release` is the user's call]**

```sh
git tag -a v0.1.0-beta.0 -m "@genclass/runtime 0.1.0-beta.0 (npm)"
git push origin <release-branch> && git push origin v0.1.0-beta.0
gh release create v0.1.0-beta.0 packages/runtime/genclass-runtime-0.1.0-beta.0.tgz \
  -R daybot-solutions-inc/GenClass-lib --verify-tag --prerelease \
  --title "@genclass/runtime 0.1.0-beta.0" --notes-file <notes.md>
```

Release notes, compared with `0.1.0-alpha.1`:

- the first situation-v2 model (`@genclass/runtime-model@0.1.0`) and its measured numbers, with FIR;
- the model's own gate thresholds (batch 6);
- one-command install (`init` / `remove`), the `/auto` entries, the script tag;
- observe mode never holds or delays a response, and its delivery decisions are recorded;
- the F2 and container redaction fixes;
- the no-baseline stall fallback;
- known issues: the remaining blockers and the open runtime findings.

### C8. Bookkeeping **[agent]**

Update every place that lists `0.1.0-alpha.1` as latest or the model as unpublished. Find them with `git grep -n "0.1.0-alpha\|runtime-model" -- '*.md'`. That includes:

- `OPEN_TASKS.md` ("Next" items for the model package and the next prerelease; "Needs the user");
- `HANDOFF.md`;
- `AGENTS.md`;
- `docs/agents/runtime/build-test-release.md` ("Publish history");
- `docs/agents/status-and-known-issues.md`;
- `docs/runtime/API.md` and `docs/runtime/CONTRACT.md`;
- both READMEs.

## Part A (done): `@genclass/runtime@0.1.0-alpha.1`

- **Published** 2026-10-08 05:33 UTC by `karanvir1729` under dist-tag `latest` (planned `alpha`). The first attempt got a 403 (no 2FA on the account); after 2FA it went through browser approval.
- **Source:** release commit 806a296 on `mvp-v2`; local annotated tag `v0.1.0-alpha.1`, not pushed; built in the worktree `/Users/karanvirkhanna/GenClass-lib-release` (branch `release/runtime-0.1.0-alpha.1`).
- **Tarball:** 26 files, 486.8 kB; shasum 9e3e82bcf752d6eb34db0620d072e6a913508dff (`npm view` agrees: `dist.fileCount` 26, unpacked 1,967,322 bytes).
- **Contents:** the NaN fix (ad24804), the situation-v2 runtime (batch 4 fcd1e68, batch 5 6e5e86e), the `observe` default (f3636b2) and docs. No `./auto` exports, no `dist/cdn/*`, no global build, and no `init` in `bin/genclass-runtime.mjs`.
- **Still to do:** push `mvp-v2` and the tag (user). There is no GitHub release for alpha.1.

## Invariants and gotchas

- **Publish only tarballs you checked:** `npm publish <file>.tgz`. A bare publish packs again from the current `dist/`, and `tsup`'s `clean` means a failed build leaves a half-empty `dist/`.
- **Bump, then build, then pack.** The global build and `init`'s SRI depend on the version and the built files (C3).
- **Build from a clean tree** (C2). Other checkouts hold other agents' uncommitted edits.
- **Never commit `files/` or `*.tgz`.** Both are gitignored. Keep the export directory (and its sha256s) on the train VM.
- **Lockfile.** A version bump, the alias's dependency or a new workspace changes `package-lock.json`. Commit it in the same commit.
- **Dist-tags.** A prerelease without `--tag` is refused (npm 11). `npm dist-tag add` moves a tag without republishing. The README's commands resolve `latest`.
- **The default model URL is a contract.** `DEFAULT_MODEL_BASE_URL` and `DEFAULT_FROM` (both `@genclass/runtime-model@0.1.0/files/` on jsDelivr) are pinned. Changing either means a runtime release, and every older runtime keeps loading `0.1.0`.
- **2FA and accounts.** Agents never run `npm login`, handle tokens, or publish. Hand the user the exact command.
- **Run policy.** On machines other than Mehar's 8 GB Mac, `npm ci`, `tsc`, `tsup`, vitest and `npm pack` are fine. Ask first before Playwright, `smoke.sh`, `test/install/run-all.sh`, model downloads, the demos eval, training, realapps, Azure, `git push`, `gh release` and `npm publish`.

## Tests

| step | what proves it |
|---|---|
| B2 | `genclass-runtime info` exits 0; `vitest run test/model` with `GENCLASS_MODEL_DIR` (export fixtures); `ortweb_report_q8.json` with full argmax agreement; `meta.json` has `gate` |
| B6 | the CDN card is identical to the packed one; `fetch-model` with the default `--from` (the CDN), and from the GitHub release if B5 was done, verifies every sha256 |
| B7 | demos eval Off / Observe / Guard with no clean-run regressions |
| C2 | the CI-equivalent run (375 passed + 14 skipped at f107013; re-measure after the merge), perf 4 passed, `npm pack --dry-run` file list |
| C3 | the built global file contains only the new version |
| C4 | `smoke.sh` prints `SMOKE OK`; `run-all.sh` results updated; status `ready` and model gates with the published model |
| C6 | `dist-tags`, `dist.shasum` equal to the local sha1, CDN 200s, `init --dry-run` installs `^<new version>` |

## Drift and open issues

- **Stale text elsewhere:**
  - `packages/runtime/CHANGELOG.md` lists the install features under `0.1.0-alpha.1`;
  - `test/install/INSTALL-README-SNIPPET.md` and `bin/lib/init.mjs` USAGE say guard is the default;
  - `test/install/RESULTS.md` was run on alpha.0;
  - `packages/runtime-model/MODEL_CARD.md` describes round 1;
  - `HANDOFF.md` gives the publish command without `--tag`.
- **Open runtime review findings (2026-10-08), by `path` -> `symbol`:**
  - `packages/runtime/src/state/hub.ts` -> `StoreHub.applyFilter`: a delivery discard is a no-op on Redux/Zustand stores but is recorded as a drop (high);
  - `packages/runtime/src/runtime.ts` -> `RuntimeImpl.dropFilter`: discard marks catch later chained polls for 10 s (medium);
  - a delivery `defer` can stall a push channel (medium);
  - `packages/runtime/src/observe/messages.ts` -> `MessageGate.pump`: held WS/SSE messages are delivered after `close()` (medium);
  - `packages/runtime/src/situation/evidence.ts` -> `NOT_PROCESSED`: 502 is treated as "not processed" (low).
- **Fixed since the review:** observe-mode delivery holds and dropped background delivery decisions (054da38); the F2 diff of redacted text and numbers/arrays under secret containers (f107013).
- **Redaction gaps that remain** (`packages/runtime/STATUS.md`, "Fix after 0.1.0-alpha.1"):
  - a container named by a secret word pair (`cardNumber`, `apiKey`) counts as broad, so `payment.cardNumber.value` is shown;
  - the "is back to V" fact compares rendered text;
  - the curriculum's Python renderer (`training/curriculum/rt.py`) has no redactor.
- **TRAIN-side (model quality, not packaging):**
  - unlabeled rows keep `expected` diagnoses that S1 would relabel (`sim/src/gen/trajectory.ts` -> `unlabeledTrajectory`, `training/label_teacher.py`);
  - `training/label_cluster.sh` can report done without labelling;
  - SIM samples the v1 3,200-char budget (`sim/src/world/scenario.ts`);
  - several `training/curriculum/rt.py` divergences from the runtime's renderer.
- **Real-app claims.** The "0/396 changed" never-worse sweep (`docs/runtime/RESULTS.md` §4) compares only final visible text and server content, covers 66 apps (the tree now has 128 app manifests), and never compares observe mode with no runtime. It predates 054da38. Quote it that way.
- **Unverified:**
  - the version string `r17-v2a` was exported with;
  - whether its tar already includes fitted gates;
  - the v2 delivery directory on the train VM;
  - whether the `genclass` developer role can create `@genclass/runtime-model`;
  - which model tests skip with a v2 export;
  - `mvp-v2-b6` (4e95373);
  - `smoke.sh` and `run-all.sh` on the merged tree.

## Publishing from CI with provenance

`.github/workflows/release.yml` (added 2026-10-10, not run yet) publishes `@genclass/runtime` from a version tag with
npm provenance, so anyone can check that a tarball was built from this repository at the tagged commit. It runs on a
pushed tag `v<version>` that equals `packages/runtime/package.json` and `src/version.ts`, then: `npm ci`, typecheck,
build, the unit tests, `npm pack` (the tarball and its file list are kept as a workflow artifact, with sha1 and sha512
printed in the log), `npm publish <tgz> --provenance --access public --tag <dist-tag>` (a prerelease goes to the
dist-tag named after it, `0.1.0-beta.5` → `beta`; `latest` only for a plain version), and finally `npm audit
signatures` on a fresh install. It authenticates with npm trusted publishing (OIDC, `permissions: id-token: write`);
no npm token is stored anywhere.

**Owner steps before the first run [user only]:**

1. npmjs.com → `@genclass/runtime` → Settings → Trusted publishing → add a GitHub Actions publisher: organization
   `daybot-solutions-inc`, repository `GenClass-lib`, workflow `release.yml`, environment `npm-publish`.
2. GitHub → repository Settings → Environments → create `npm-publish`, with required reviewers (a second person
   approves each publish) and the deployment branch/tag rule `v*`.
3. Optionally, on npmjs.com, require 2FA and disallow tokens for publishing once the first CI publish worked.
4. Release: bump the version (C3), commit, then `git tag -a v<version> -m "@genclass/runtime <version>" && git push
   origin v<version>`. Approve the `npm-publish` environment when the run asks. Move `latest` by hand afterwards
   if it was a prerelease: `npm dist-tag add @genclass/runtime@<version> latest`.

The unscoped alias `genclass-runtime` and `@genclass/runtime-model` are still published by hand (C5, B4).

## Verifying a published tarball

Anyone can check a published version against this repository. For a version published by the release workflow:

```sh
# 1. registry signatures and the provenance attestation (in any project that installed it)
npm install @genclass/runtime@<version>
npm audit signatures                    # counts packages with verified registry signatures and verified attestations
npm view @genclass/runtime@<version> dist.attestations   # the provenance bundle URL
# npmjs.com shows "Built and signed on GitHub Actions" with links to the workflow run, the commit and release.yml
```

The provenance names the repository, the workflow file, the tag and the commit SHA the tarball was built from. To
compare the contents with that commit yourself (any published version, also the hand-published ones):

```sh
V=<version>
mkdir -p /tmp/gc-verify && cd /tmp/gc-verify
npm pack @genclass/runtime@$V                       # the published tarball, byte for byte
npm view @genclass/runtime@$V dist.shasum dist.integrity gitHead
shasum -a 1 genclass-runtime-$V.tgz                 # equals dist.shasum
mkdir published && tar -xzf genclass-runtime-$V.tgz -C published
git clone https://github.com/daybot-solutions-inc/GenClass-lib.git src && cd src
git checkout v$V                                    # or the commit in the provenance / gitHead
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime
cd packages/runtime && npm pack && mkdir ../../../rebuilt && tar -xzf genclass-runtime-$V.tgz -C ../../../rebuilt
cd /tmp/gc-verify && diff -r published/package rebuilt/package && echo "same files, same contents"
```

`npm pack` normalises timestamps and file modes, and the build is deterministic for a given lockfile and Node major
version (the workflow uses Node 22), so the two trees should be identical; when they are not, `diff` shows where. The
model files are verified separately: every file under `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@<v>/files/`
must match the `sha256` its `model.json` lists (the runtime checks this on every load), and `rt.status.sha256` /
`rt.audit()` name the variant digest a page actually used.

## Related docs

- [docs/agents/runtime/build-test-release.md](docs/agents/runtime/build-test-release.md): build, tests, CI, publish history.
- [docs/agents/runtime/model-host.md](docs/agents/runtime/model-host.md): the model card, loader, CLI and default URL.
- [docs/agents/model-io-contract.md](docs/agents/model-io-contract.md): what a model must accept to match the runtime.
- [docs/agents/training.md](docs/agents/training.md): TRAIN's eval and export chain.
- [docs/agents/demos.md](docs/agents/demos.md): the demos eval, `cities.ts`, demo modes.
- [docs/agents/realapps.md](docs/agents/realapps.md): the real-app corpus and the never-worse sweep.
- [packages/runtime/INSTALL-NEEDS.md](packages/runtime/INSTALL-NEEDS.md): the install owner's decisions and package.json notes.
- [HANDOFF.md](HANDOFF.md), [OPEN_TASKS.md](OPEN_TASKS.md), [docs/runtime/RESULTS.md](docs/runtime/RESULTS.md), [packages/runtime/STATUS.md](packages/runtime/STATUS.md), [packages/runtime-model/MODEL_CARD.md](packages/runtime-model/MODEL_CARD.md).
