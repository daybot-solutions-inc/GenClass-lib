# Release procedure: `@genclass/runtime` and `@genclass/runtime-model`

> **Scope:** publishing `@genclass/runtime` (`packages/runtime`) and the planned `@genclass/runtime-model` (`packages/runtime-model`) to npm, their git tags and GitHub releases, and the checks before and after each publish.
> **Read this when:** you are asked to cut a release, prepare a tarball for the user to publish, or package a trained model.
> **Source of truth:** the code. Verified against branch `mvp-v2` at b435acb (origin/runtime 74f17c0 = situation-v2, plus default mode observe and CI), 2026-10-08. If this doc and the code disagree, the code wins.

## TL;DR

- **Two releases, in this order.**
  - **Part A (now, no model).** An optional `@genclass/runtime@0.1.0-alpha.1` from `mvp-v2`, published under dist-tag `alpha`. It ships the NaN fix (ad24804), the situation-v2 runtime (batch 4 fcd1e68, batch 5 6e5e86e), the `observe` default (f3636b2) and updated docs.
  - **Part B (after a situation-v2 model exists).** First `@genclass/runtime-model@0.1.0` plus the GitHub release `runtime-model-v0.1.0`. Then a demos eval (Off / Observe / Guard). Last, `@genclass/runtime@0.1.0-beta.0` or `0.1.0`.
- **Who runs what.** Agents prepare and check everything: worktree, install, typecheck, build, unit tests, `npm pack`, the exact commands. **Only the user publishes** (`npm publish` and `npm dist-tag` need their npm 2FA). The user also approves every `git push`, tag push and `gh release`. Agents must ask before Playwright and `smoke.sh`, model downloads, demos eval, and anything that touches training or Azure. Those runs belong to Mehar's setup (`HANDOFF.md`).
- **Registry today** (`npm view`, 2026-10-08):
  - `@genclass/runtime` has versions `0.0.0-stage` and `0.1.0-alpha.0`, with `latest` = `0.1.0-alpha.0`. That build is situation-v1, defaults to `guard`, still has the NaN crash, and has no model.
  - `@genclass/runtime-model` is **404**.
  - The npm org `genclass` has two members: `meharpro` (owner) and `karanvir1729` (developer). Both have read-write access to `@genclass/runtime`.
- **The default model URL is pinned.** `packages/runtime/src/model/host.ts` -> `DEFAULT_MODEL_BASE_URL` = `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/`. `packages/runtime/bin/genclass-runtime.mjs` -> `DEFAULT_FROM` = `https://github.com/daybot-solutions-inc/GenClass-lib/releases/download/runtime-model-v0.1.0/`. Both 404 today. npm versions are immutable, so **whatever is published as `@genclass/runtime-model@0.1.0` is what every default `GenClass.init()` loads, permanently**. Validate before publishing.
- **Never publish the round-1 R17 (`situation-v1`) as `0.1.0`.** The loader does not check a situation version: `packages/runtime/src/model/loader.ts` checks only the card format `genclass-runtime-model/1`. A v1 model would therefore load into the v2 runtime without any error and decide on text it was never trained on.
- **npm 11 refuses to publish a prerelease without `--tag`.** npm 11.8.0 `lib/commands/publish.js` throws "You must specify a tag using --tag when publishing a prerelease version.", so `HANDOFF.md`'s bare `npm publish <tgz> --access public` fails for `0.1.0-alpha.1`. A non-prerelease needs no tag: the first one (`0.1.0`) becomes `latest`, because prereleases are left out of npm's "higher version" check.

## Files

| path | role in a release |
|---|---|
| `packages/runtime/package.json` | `@genclass/runtime`, `version` `0.1.0-alpha.0` on `mvp-v2`. `files`: `dist`, `bin`, `README.md`, `LICENSE`. No `prepublishOnly`, no `publishConfig`, no publish script |
| `package-lock.json` (root) | committed (b435acb). Records the workspace versions, so a version bump changes it. CI's `npm ci` fails if it is out of sync |
| `packages/runtime/README.md` | the npm page. Packed into the tarball, so it must be correct **before** packing |
| `packages/runtime/LICENSE` | Apache-2.0. Packed |
| `packages/runtime/bin/genclass-runtime.mjs` | CLI shipped in the tarball (`fetch-model`, `info`) and used here to validate model directories. Mode 100755 |
| `packages/runtime/test/smoke/smoke.sh` | packs the tarball, installs it into a fresh Vite 8 app, builds it, and loads it in headless Chromium (Playwright 1.63.0) |
| `packages/runtime/test/model/helpers.ts` | `GENCLASS_MODEL_DIR` (default `<repo>/.cache-model`, gitignored). `FIXTURES_FROM_MODEL` switches the parity fixtures to the model directory's own `requests.json`, `pack_fixtures.json` and `torch_fixtures.json` |
| `packages/runtime-model/MODEL_CARD.md` | the only tracked file of the model package. It still describes round 1 (situation-v1) |
| `packages/runtime-model/files/` | gitignored (`.gitignore` line `packages/runtime-model/files/`). Holds the model directory to pack. **Does not exist in this checkout**. `training/LOG.md` says round 1 R17 sits in `files/r17/` on Mehar's Mac only |
| `training/final_post.sh`, `training/export_runtime.py`, `training/pull_on_train.sh`, `training/deliver_final.sh`, `training/ortweb/validate.mjs` | TRAIN's eval -> export -> delivery -> onnxruntime-web check chain (Part B, step B1) |
| `demos/scripts/vm-eval.sh`, `demos/e2e/eval.ts`, `demos/src/shared/{types,genclass}.ts` | demos eval (Part B, step B6) |
| `.gitignore` | ignores `*.tgz` and `.publish/`, so packed tarballs never get committed |

## Concepts

| term | meaning |
|---|---|
| dist-tag | npm label pointing at one version. `latest` is what `npm i @genclass/runtime` installs. `alpha` and `beta` are opt-in: `npm i @genclass/runtime@alpha` |
| prerelease | a version with a `-` suffix (`0.1.0-alpha.1`, `0.1.0-beta.0`). npm 11 requires `--tag` to publish one |
| release worktree | a clean `git worktree` of the commit being released. The main checkout may hold other agents' uncommitted edits (on 2026-10-08 it had the uncommitted DL-7 fix in `packages/runtime/src/state/hub.ts` plus a new `test/atoms.test.ts` test; it ships only if committed before A2), and `tsup` bundles whatever is on disk |
| model export | the directory `training/export_runtime.py` writes: `model.json` (card `genclass-runtime-model/1`, with `bytes` and `sha256`), `<name>-q8.onnx` (WASM), `<name>-fp16.onnx` (WebGPU, `needs: shader-f16`), `tokenizer.json`, `calibration.json`, `meta.json`, plus the parity files `parity.json`, `requests.json`, `pack_fixtures.json` and `torch_fixtures.json`. The fp32 reference in `ref/` is left out of the delivered tar |
| `ortweb_report_q8.json` | written into the export by `training/ortweb/validate.mjs <dir> q8 <n>`. It holds onnxruntime-web (WASM in Node) and onnxruntime-node logits compared with PyTorch, per backend: `argmax_agree`, `argmax_total`, `max_abs_logit`, `est_ms_at_seq_tokens`, `error` |

Step markers used below: **[agent]** is light and allowed locally. **[ask first]** needs the user's OK in chat. **[user only]** is run by the user with their npm 2FA, or by Mehar on his Azure setup.

## Part A: `@genclass/runtime@0.1.0-alpha.1` (now, no model)

### A0. Decisions for the user (before any work)

1. **Publish alpha.1 at all?** It is optional (`OPEN_TASKS.md` "Needs the user" asks for it only for the NaN fix). Without a model it observes only. Nothing it decides can change an app.
2. **Dist-tag.** `--tag alpha` leaves `latest` on `0.1.0-alpha.0`. That build has the NaN crash, is situation-v1 and defaults to `guard`. To make plain `npm i @genclass/runtime` get the fix, the user can also move `latest` after the publish (step A7).
3. **Which commit and branch.** `mvp-v2` (b435acb plus the doc commits) is not pushed. Mehar's working branch is `origin/runtime` (74f17c0). The release commit and tag must reach `origin`, and the user picks the branch: push `mvp-v2`, or merge into `runtime` with Mehar.
4. **Known open issues.** The 2026-10-08 review found several issues; see [Drift and open issues](#drift-and-open-issues). None of them can change app behaviour in alpha.1, because no model exists and the default is `observe`. They go into the release notes, not the blocker list. Part B treats them as blockers.

### A1. Fix what the tarball ships (docs) **[agent, edits owned by the docs task]**

The npm README is packed, so these must be committed before packing:

- `packages/runtime/README.md`:
  - status line: `0.1.0-alpha.0` becomes `0.1.0-alpha.1`;
  - "Modes" table: already says `observe` is the default (matches `packages/runtime/src/runtime.ts`: `o.mode ?? "observe"`); re-check only the status/version text;
  - it mentions `npx genclass-runtime fetch-model`; confirm the "none for this runtime yet" caveat is still present before packing (`DEFAULT_FROM` 404s and no v2 model exists).
- Root `README.md`: re-check the status box and alpha version (the default-mode text already says `observe`).

Check:

```sh
grep -n "(default)\|alpha\|fetch-model" packages/runtime/README.md README.md
```

### A2. Clean release worktree **[agent]**

```sh
cd /Users/karanvirkhanna/GenClass-lib                    # the main checkout
git status --short                                        # note other agents' edits; they must not be in the release
git worktree add -b release/runtime-0.1.0-alpha.1 ../GenClass-lib-release mvp-v2
cd ../GenClass-lib-release
git log --oneline -1                                      # the commit being released (must include A1)
git status --porcelain                                    # must print nothing
```

### A3. Pre-flight checks **[agent]** (all in the release worktree; same steps as `.github/workflows/ci.yml`)

```sh
npm ci --no-audit --no-fund                               # committed lockfile; on Linux prefix ONNXRUNTIME_NODE_INSTALL=skip as CI does
npm run typecheck -w @genclass/runtime                    # tsc -p tsconfig.json --noEmit over src/
npm run build -w @genclass/runtime                        # tsup -> packages/runtime/dist (6 entries)
cd packages/runtime
NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**" --exclude test/review-perf.test.ts
NODE_OPTIONS=--expose-gc npx vitest run test/review-perf.test.ts --retry=2
npm pack --dry-run
```

Expected at b435acb, with no `.cache-model`:

- the unit run reports "Test Files 40 passed | 1 skipped (41)" and "Tests 332 passed | 14 skipped (346)" at b435acb; if the release commit includes the `packages/runtime/src/state/hub.ts` DL-7 fix and its new `test/atoms.test.ts` test, expect "Tests 333 passed | 14 skipped (347)";
- the perf run reports 4 passed;
- `npm pack --dry-run` lists 26 files: `LICENSE`, `README.md`, `bin/genclass-runtime.mjs`, `package.json` and 22 files under `dist/`.

The 14 skips are model-parity tests that need a model directory. If counts differ, check for untracked `test/zz-*.test.ts` files from parallel agents; a fresh worktree has none. Node 25 prints an EBADENGINE warning for vitest 5, which is harmless. CI uses Node 22.

### A4. Version bump **[agent]**

```sh
cd ../GenClass-lib-release                                # repo root of the worktree
npm version 0.1.0-alpha.1 -w @genclass/runtime --no-git-tag-version
git diff --stat                                           # expect packages/runtime/package.json and package-lock.json only
```

`npm version -w` updates both the workspace `package.json` and the root lockfile's `packages/runtime` entry. This was checked with npm 11.8.0 on a scratch monorepo. Nothing in `src/`, `dist/` or `bin/` embeds the version, so no rebuild is needed for the bump. Commit:

```sh
git add packages/runtime/package.json package-lock.json
git commit -m "release: @genclass/runtime 0.1.0-alpha.1

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### A5. Pack, and smoke-test the exact tarball

```sh
cd packages/runtime
bash test/smoke/smoke.sh          # [ask first] Playwright + registry installs; prints "SMOKE OK: <path>/genclass-runtime-0.1.0-alpha.1.tgz"
# without the smoke test [agent]:
npm run build && npm pack         # -> genclass-runtime-0.1.0-alpha.1.tgz in packages/runtime (gitignored *.tgz)
shasum -a 1 genclass-runtime-0.1.0-alpha.1.tgz            # keep it; compare with dist.shasum after the publish
```

`smoke.sh` runs `npm run build` and `npm pack` itself, so the tarball it leaves behind is the one to publish. It needs Chromium for Playwright 1.63.0 (revision 1243) in the Playwright cache; this machine has `chromium-1243` and `chromium_headless_shell-1243` in `~/Library/Caches/ms-playwright`. It leaves a temp Vite app behind (`mktemp -d`). It asserts no page or console errors, a mounted `genclass-devtools` element, and `rt.history().length >= 3`. None of these depend on the mode (not re-run on `mvp-v2`).

Optional **[agent, tell the user first: it is an `npm publish` invocation, but it uploads nothing]**:

```sh
npm publish genclass-runtime-0.1.0-alpha.1.tgz --access public --tag alpha --dry-run
```

### A6. Publish **[user only]**

On a machine logged in to npm as `karanvir1729` or `meharpro` (`npm whoami`), from `packages/runtime` in the release worktree:

```sh
npm whoami
npm publish genclass-runtime-0.1.0-alpha.1.tgz --access public --tag alpha
```

npm asks for the 2FA code, or opens the browser; `--otp <code>` also works. Publishing the tarball file publishes exactly what was smoke-tested. Running `npm publish` without a file would pack again from whatever `dist/` holds. A version can never be republished, even after an unpublish.

### A7. Optional: move `latest` **[user only, decision A0.2]**

```sh
npm dist-tag add @genclass/runtime@0.1.0-alpha.1 latest
```

### A8. Verify **[agent]**

```sh
npm view @genclass/runtime dist-tags                      # alpha: 0.1.0-alpha.1 (latest: alpha.0 or alpha.1 per A7)
npm view @genclass/runtime@0.1.0-alpha.1 version dist.shasum dist.fileCount   # shasum = A5's; fileCount 26
T=$(mktemp -d) && cd "$T" && npm init -y >/dev/null \
  && npm i --no-audit --no-fund @genclass/runtime@0.1.0-alpha.1 \
  && node -e "import('@genclass/runtime').then(m => console.log(Object.keys(m).length, m.DEFAULT_MODEL_BASE_URL))" \
  && npx genclass-runtime --help | head -3
```

The import check works in Node: it was checked against the workspace build, which exports 30 names. The registry may take a minute to show the new version.

### A9. Tag, push, GitHub release **[ask first for every push; `gh release` is the user's call]**

These follow the `0.1.0-alpha.0` precedent: an annotated tag "@genclass/runtime 0.1.0-alpha.0 (npm)", and a GitHub pre-release with the `.tgz` as an asset.

```sh
cd ../GenClass-lib-release                                # repo root of the worktree
git tag -a v0.1.0-alpha.1 -m "@genclass/runtime 0.1.0-alpha.1 (npm)"
git push origin release/runtime-0.1.0-alpha.1             # or the branch agreed in A0.3
git push origin v0.1.0-alpha.1
gh release create v0.1.0-alpha.1 packages/runtime/genclass-runtime-0.1.0-alpha.1.tgz \
  -R daybot-solutions-inc/GenClass-lib --verify-tag --prerelease \
  --title "@genclass/runtime 0.1.0-alpha.1" --notes-file <notes.md>
```

Release notes, compared with `0.1.0-alpha.0`:

- NaN in app state no longer recurses forever (`test/nan.test.ts`);
- the default mode is `observe` (was `guard`; `guard` is opt-in and `heal` is experimental);
- decisions happen at the network boundary (`delivery` trigger), and store writes are not held by default (`policy.holdWrites`);
- EventSource is observed;
- synthetic DOM events are ignored unless `observe: { untrustedEvents: true }` is set;
- the situation format is v2;
- no model is published yet, so the runtime only observes;
- known issues: list the open review findings from [Drift](#drift-and-open-issues).

Then bring the release commit back to `mvp-v2`: `git -C /Users/karanvirkhanna/GenClass-lib merge --ff-only release/runtime-0.1.0-alpha.1`. If other agents' uncommitted edits touch the same files, the merge refuses: commit or stash them first, with the user's say. Then remove the worktree: `git worktree remove ../GenClass-lib-release`.

### A10. Bookkeeping **[agent]**

Update every place that still lists `0.1.0-alpha.0` as latest or alpha.1 as pending:

- `OPEN_TASKS.md`: move "Needs the user: Patch release `0.1.0-alpha.1`" to "Done";
- `HANDOFF.md`: the "Current state" npm row;
- `AGENTS.md`: the npm line;
- `docs/agents/runtime/build-test-release.md`: "Publish history";
- `docs/agents/status-and-known-issues.md`.

Find them with `git grep -n "0.1.0-alpha" -- '*.md'`.

## Part B: model package, then `@genclass/runtime@0.1.0` (after a situation-v2 model exists)

Order from `HANDOFF.md` "How to continue": v2 data, then the teacher, then distillation (R17 default, R32), then DAgger via SIM `--on-policy`, then EVAL, then **`@genclass/runtime-model@0.1.0`**, then the demos rerun, then **`@genclass/runtime@0.1.0`**. Everything up to EVAL is TRAIN's work on Azure (Mehar). Nobody on our side touches it.

### B0. Gates before packaging anything

- **EVAL exists for a situation-v2 model.** It must be in `training/EVAL.md` and `docs/runtime/RESULTS.md`, with the false-intervention rate (guard and heal) next to every recall number (`HANDOFF.md` rule "Report honestly"). The default is R17 (`HANDOFF.md`, round-1 choice in `training/LOG.md`). Choosing R32 for WebGPU is a separate user decision (`OPEN_TASKS.md` item 9).
- **TRAIN's post-processing is v2-correct.** `training/final_post.sh` is hard-wired to the situation-v1 eval set `simAe`: it runs `eval_sim.sh simAe`, uses `--calibration out/cal/$M-simAe.json`, and uses `--data-rows data/simAe/dev.jsonl,...`. It also does not stop when an eval fails (`set -u` only). `training/eval_runtime.py` caches logits by checkpoint and data *name* only. Unless these are fixed (TRAIN/Mehar), the export's `calibration.json` can be fitted on v1 situations or on stale logits. Confirm which eval set and which checkpoint the calibration came from before trusting the export.
- **Version.** The card's `version` must be `0.1.0`, and the npm package version must be exactly `0.1.0`, because `DEFAULT_MODEL_BASE_URL` pins `@0.1.0`. Any other version also needs a code change in `packages/runtime/src/model/host.ts` -> `DEFAULT_MODEL_BASE_URL` and `packages/runtime/bin/genclass-runtime.mjs` -> `DEFAULT_FROM`, and therefore a runtime release.

### B1. Get the export **[user only (Mehar) for the Azure side; ask first to copy it here: model download]**

TRAIN's chain, from the scripts:

1. On the model's rank-0 node, `bash training/final_post.sh <M> <NAME> <VER>` (header example: `final_post.sh r17-final1 genclass-runtime-r17 1.0.0-rc1`). For the v2 release, use `<NAME>` = `genclass-runtime-r17` and `<VER>` = `0.1.0`. The script:
   - runs the SIM eval and fits the temperatures;
   - runs `training/export_runtime.py --ckpt models/<M> --out out/export-<M> --name <NAME> --version <VER> --calibration ...`;
   - touches `out/.post-done-<M>`;
   - tars `out/export-<M>` without `ref/` into `~/xfer/export-<M>.tar` and serves it on port 8801.
2. On the `train` VM, `training/pull_on_train.sh <IP> <M> <ROUND> <SUB>` (or `training/deliver_final.sh <M> <NODE> <ROUND> <SUB>` from the Mac) does the following:
   - unpacks the tar into `~/gcl/train-out/<ROUND>/<SUB>/`;
   - checks every file's sha256 against `model.json`;
   - runs `ortweb/validate.mjs <dir> q8 120`, which writes `ortweb_report_q8.json` there.

   Round 1 landed in `~/gcl/train-out/final1/{r17,r32}/`. The v2 round's directory name is not decided yet (unverified).
3. Copy it to the release machine as `<repo>/.cache-model/`. That path is gitignored, and it is the default `GENCLASS_MODEL_DIR` of the model tests. On Mehar's setup, `scripts/vm.sh get` copies from `~/gcl/<SLOT>/<REMOTE>`, so `scripts/vm.sh get train-out <ROUND>/<SUB> .cache-model` should work (unverified; it needs his hosts file and key).

Expected contents, from `export_runtime.py`:

- `model.json`;
- `genclass-runtime-r17-q8.onnx` and `genclass-runtime-r17-fp16.onnx`;
- `tokenizer.json`, `calibration.json`, `meta.json`; `meta.json`'s `name` is `genclass-runtime-r17-0.1.0`;
- `parity.json`, `requests.json`, `pack_fixtures.json`, `torch_fixtures.json`, `ortweb_report_q8.json`.

### B2. Validate **[agent once the directory is here; ask first where marked]**

```sh
cd /Users/karanvirkhanna/GenClass-lib                     # or the release worktree
node packages/runtime/bin/genclass-runtime.mjs info .cache-model
node -e "const c=require('./.cache-model/model.json'); console.log(c.format, c.name, c.version, Object.keys(c.variants))"
cd packages/runtime
GENCLASS_MODEL_DIR=$PWD/../../.cache-model NODE_OPTIONS=--expose-gc npx vitest run test/model
GENCLASS_MODEL_DIR=$PWD/../../.cache-model NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**"
```

- **`info`** must exit 0:
  - every listed file reads `sha256 ok`;
  - `fp16*` is marked "needs a WebGPU feature";
  - there are no `WARNING` lines (the graph check is "any fp16 tensor -> needs: shader-f16");
  - the card prints `genclass-runtime-model/1`, name `genclass-runtime-r17`, version `0.1.0`, and variants `q8` and `fp16`.
- **Model unit tests.** Because the export contains `requests.json`, `pack_fixtures.json` and `torch_fixtures.json`, `FIXTURES_FROM_MODEL` is true. The packer, engine and calibration tests then compare the TypeScript packer and ONNX engine (onnxruntime-node CPU, and onnxruntime-web WASM in Node) with the export's own PyTorch fixtures and its `parity.json`. Without a model directory these tests skip (14 skips). With one, they should run. Which ones stay skipped, and whether the py-fixture cases tied to the v0.1 tokenizer still pass, has not been checked on any v2 export (unverified). Read failures before dismissing them.
- **`ortweb_report_q8.json`.** For every backend in `results`: `argmax_agree` equals `argmax_total`, and there is no `error`. Note `est_ms_at_seq_tokens`, the latency for the model card. Round 1 got 233/233 decisions on both runtimes (`training/LOG.md`). To re-run it here **[ask first; installs onnxruntime-node/web in `training/ortweb`]**: `cd training/ortweb && npm install && node validate.mjs ../../.cache-model q8 120`.
- **Browser model specs [ask first; Playwright]:** `GENCLASS_MODEL_DIR=$PWD/../../.cache-model npm run test:browser` in `packages/runtime`. Caveat (from the code, not run): `test/browser/model-helpers.ts` always loads the **v0.1** `requests50.json`, `pack_fixtures.json` and `torch_fixtures.json` from `test/fixtures/model/`. It has no `FIXTURES_FROM_MODEL` switch, so the parity part of the first `model.spec.ts` test ("loads over WASM ... matches PyTorch ...") is expected to fail on a v2 model. The other specs (fallbacks, preload modes, WebGPU probe, latency) are model-agnostic. To make that test meaningful, teach `model-helpers.ts` to use the export's fixtures.

### B3. Package `@genclass/runtime-model@0.1.0` **[agent]**

1. Fill `files/` with **only** the card's files, flat. `model.json` must sit directly in `files/`, because the runtime fetches `<baseUrl>model.json` (`packages/runtime/src/model/loader.ts`). Remove anything else, especially a leftover `files/r17/` (the situation-v1 round-1 model).

   ```sh
   cd /Users/karanvirkhanna/GenClass-lib
   rm -rf packages/runtime-model/files && mkdir -p packages/runtime-model/files
   cp .cache-model/{model.json,tokenizer.json,calibration.json,meta.json,genclass-runtime-r17-q8.onnx,genclass-runtime-r17-fp16.onnx} packages/runtime-model/files/
   node packages/runtime/bin/genclass-runtime.mjs info packages/runtime-model/files
   cp packages/runtime/LICENSE packages/runtime-model/LICENSE
   ```

2. Create `packages/runtime-model/package.json`:

   ```json
   {
     "name": "@genclass/runtime-model",
     "version": "0.1.0",
     "description": "The GenClass runtime model for @genclass/runtime (situation-v2): q8 ONNX for WASM, fp16 ONNX for WebGPU, tokenizer and calibration. Loaded from jsDelivr as the runtime's default model.",
     "license": "Apache-2.0",
     "repository": {
       "type": "git",
       "url": "git+https://github.com/daybot-solutions-inc/GenClass-lib.git",
       "directory": "packages/runtime-model"
     },
     "homepage": "https://github.com/daybot-solutions-inc/GenClass-lib#readme",
     "files": ["files/", "MODEL_CARD.md"]
   }
   ```

   `files/` stays gitignored but **is packed**. Listing it in `files` overrides the ignore rule; this was checked with npm 11.8.0 on a scratch monorepo with the same `.gitignore` line, from the package directory and with `-w`. npm always adds `package.json`, `LICENSE` and any `README*`. With no README the npm page shows none, so optionally add a short `README.md` that links to `MODEL_CARD.md`.

3. The new `package.json` makes `packages/runtime-model` a workspace (root `workspaces: ["packages/*"]`). Update and commit the lockfile, or CI's `npm ci` fails:

   ```sh
   npm install --no-audit --no-fund                       # adds packages/runtime-model to package-lock.json
   cd packages/runtime-model && npm pack --dry-run        # expect LICENSE, MODEL_CARD.md, package.json + the 6 files/ entries
   ```

4. Rewrite `packages/runtime-model/MODEL_CARD.md` for the v2 model. It still says "final round 1 on the frozen runtime (situation-v1)" and quotes round-1 numbers. Take the numbers from the v2 `training/EVAL.md`. Keep false-intervention rates next to recall. Give the sizes and latencies from `parity.json` and `ortweb_report_q8.json`.
5. Commit `packages/runtime-model/{package.json,LICENSE,MODEL_CARD.md}` and `package-lock.json` (never `files/`). The npm package size is about 23 MB for R17 (round-1 q8 9.58 MB plus fp16 13.57 MB). Whether jsDelivr's npm size limit matters for adding R32 too is unverified. `training/LOG.md` only notes that "R32 + R17 would exceed 60 MB".

### B4. Publish the model **[user only]**

```sh
cd packages/runtime-model
npm pack                                                  # genclass-runtime-model-0.1.0.tgz (gitignored)
shasum -a 1 genclass-runtime-model-0.1.0.tgz
npm publish genclass-runtime-model-0.1.0.tgz --access public
```

- `--access public` is required: scoped packages default to restricted.
- No `--tag` is needed: `0.1.0` is not a prerelease, and it becomes `latest`.
- `karanvir1729` has the developer role in the `genclass` org. Whether that role may *create* a new package in the scope is unverified. If npm refuses, `meharpro` (owner) publishes.
- **This publish is irreversible:** `0.1.0` can never be reused, and every runtime that uses the default URL loads it.

### B5. GitHub release `runtime-model-v0.1.0` **[ask first; user's call]**

`fetch-model` resolves each card file as `new URL(file, from)`. The assets must therefore be the same six files, flat, with exactly the card's names:

```sh
git tag -a runtime-model-v0.1.0 -m "@genclass/runtime-model 0.1.0 (npm)"
git push origin runtime-model-v0.1.0
gh release create runtime-model-v0.1.0 packages/runtime-model/files/* \
  -R daybot-solutions-inc/GenClass-lib --verify-tag --latest=false \
  --title "@genclass/runtime-model 0.1.0" --notes-file packages/runtime-model/MODEL_CARD.md
```

### B6. Verify the CDN and the release

```sh
npm view @genclass/runtime-model dist-tags version dist.shasum dist.fileCount     # [agent] shasum = B4's
curl -fsSI https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/model.json \
  | grep -i -E "^HTTP|access-control-allow-origin|content-type"                   # [agent] 200, CORS allowed
curl -fsS https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/model.json \
  | diff - packages/runtime-model/files/model.json && echo "CDN card identical"     # [agent]
# [ask first: model downloads] end-to-end bytes + sha256 from both sources, then the card check
node packages/runtime/bin/genclass-runtime.mjs fetch-model /tmp/gc-cdn --from https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/
node packages/runtime/bin/genclass-runtime.mjs info /tmp/gc-cdn
node packages/runtime/bin/genclass-runtime.mjs fetch-model /tmp/gc-gh            # default --from = DEFAULT_FROM (the GitHub release)
node packages/runtime/bin/genclass-runtime.mjs info /tmp/gc-gh
```

`fetch-model` checks bytes and sha256 against the remote card and writes a normalised `model.json`. `info` checks again and exits 1 on any mismatch. Use a scratch directory instead of `/tmp` when the agent's rules require it.

### B7. Demos eval: Off / Observe / Guard **[ask first; runs on Mehar's VM; needs two code changes first]**

What it answers: does the shipped default (`observe` with the model) or `guard` make the six demos worse than the baseline, and what does guard fix? The demos are honest evaluation: never tune them for a result (`HANDOFF.md`).

Prerequisites (code changes, not done at b435acb):

1. **`demos/src/server/data/cities.ts` is missing from git.** The root `.gitignore` rule `data/` ignores it. The search world, scenario and oracle import it, so a fresh clone cannot build the demos. Recreate it with the exports `searchCities(q)` and `TYPED_TARGETS` (see [docs/agents/demos.md](docs/agents/demos.md)), and add it with `git add -f` or narrow the ignore rule.
2. **An `observe` demo mode.**
   - `GcMode` in `demos/src/shared/types.ts` is `"off" | "guard" | "heal"`. Today demo **Off** = `GenClass.init({ mode: "observe", model: false })` (`demos/src/shared/genclass.ts` -> `startGenClass`).
   - Add `"observe"` to `GcMode` and `MODES`, `demos/e2e/eval.ts` -> `ALL_MODES`, and the `MODE_LABEL`/`MODE_HINT` records in `demos/src/site/demo-page.ts` and `demos/src/site/trials-panel.ts`; `tsc` flags any `Record<GcMode, ...>` you miss.
   - `startGenClass` already passes any non-off mode through as `GenClass.init({ mode, model: { baseUrl, preload: "eager" } })`, so `observe` gets the model loaded.
   - While there, fix the stale "guard (the default)" comment in `genclass.ts`.

Run (from `demos/scripts/vm-eval.sh`'s header; arguments pass through to `e2e/eval.ts`):

```sh
scripts/vm.sh run demos 'GENCLASS_MODEL_URL=cdn setsid nohup bash demos/scripts/vm-eval.sh --modes off,observe,guard --tag runtime-model-0.1.0 > ~/gcl/logs/demos-eval.log 2>&1 < /dev/null &'
```

- `GENCLASS_MODEL_URL=cdn` makes the pages load the runtime's default URL, which tests the published package itself. `GENCLASS_MODEL_FROM=https://github.com/daybot-solutions-inc/GenClass-lib/releases/download/runtime-model-v0.1.0/` serves a local copy instead.
- The results go to `demos/results-runtime-model-0.1.0.{json,md}`.
- Gate for B8: on clean runs, Observe and Guard introduce no bugs that Off does not have. Report every fixed count with its false interventions.
- Record the result in `docs/runtime/RESULTS.md` §5 (it currently holds the v0.1-model baseline).

### B8. `@genclass/runtime@0.1.0-beta.0` or `0.1.0` **[same steps as Part A]**

Blockers to clear or explicitly accept with the user and Mehar first:

- the high-severity review findings: the F2 redaction bypass, the redactor regression, and the redux/zustand discard no-op;
- the observe-mode delivery holds, which affect the default.

All are listed in [Drift](#drift-and-open-issues). Fixes under `packages/runtime/src/situation/*` change the model's input. They mean a new frozen tag after `situation-v2` and regenerated data, so coordinate with Mehar (`HANDOFF.md` "The training format is frozen").

Then repeat A1–A10 with:

- **README status:** the model is published; the "Modes" table says what observe, guard and heal do *with* the model.
- **Version:**
  - `npm version 0.1.0-beta.0 -w @genclass/runtime --no-git-tag-version`, published with `--tag beta`; optionally `npm dist-tag add @genclass/runtime@0.1.0-beta.0 latest`;
  - **or** `npm version 0.1.0 -w @genclass/runtime --no-git-tag-version`, published with **no** `--tag`. It becomes `latest`, because no non-prerelease version exists yet (npm 11.8.0 leaves prereleases out of its "higher version" check).
- **Smoke with the model [ask first]:** in a page built from the tarball, `GenClass.init()` (default `observe`) should reach `GenClass.runtime.status.state === "ready"`, with `status.model`/`status.version` from the CDN card and `status.variant` `q8` (WASM) or `fp16` (WebGPU). `smoke.sh` passes `model: false`, so this check needs a variant of it, or the demos.
- **Tag:** `v0.1.0-beta.0` or `v0.1.0`. Make it a GitHub pre-release only for the beta.
- **Bookkeeping:** `OPEN_TASKS.md` item 11 (and item 9 for the model) to "Done"; `HANDOFF.md` npm/model rows; `packages/runtime/README.md`, `docs/runtime/API.md` and `docs/runtime/CONTRACT.md` where they say no model is published.

## Invariants and gotchas

- **Publish only tarballs you checked.** Run `npm publish <file>.tgz`, not a bare `npm publish`. A bare publish packs again from the current `dist/`, and `tsup`'s `clean: true` means a failed build leaves a half-empty `dist/`.
- **Build from a clean tree.** The main checkout can hold other agents' uncommitted runtime edits; use the release worktree (A2).
- **Never commit `files/` or `*.tgz`.** Both are gitignored. The model package is reproducible only from the export, so keep the export directory (and its sha256s in `model.json`) on the train VM.
- **Lockfile.** A version bump or a new workspace changes `package-lock.json`. Commit it in the same commit, or CI's `npm ci` fails.
- **Dist-tags.** A prerelease without `--tag` is refused (npm 11). A non-prerelease that is not the highest non-prerelease is also refused without `--tag` ("Cannot implicitly apply the \"latest\" tag ..."). `npm dist-tag add` moves a tag without republishing.
- **The default model URL is a contract.** `DEFAULT_MODEL_BASE_URL` (`@0.1.0/files/`) and `DEFAULT_FROM` (`runtime-model-v0.1.0`) are pinned in code. Changing either means a runtime release.
- **2FA and accounts.** Agents never run `npm login`, handle tokens, or publish. Hand the user the exact command.
- **Run policy.** On machines other than Mehar's 8 GB Mac, `npm ci`, `tsc`, `tsup`, vitest and `npm pack` are fine. The `HANDOFF.md` rule "never run npm/tsc/vitest on the Mac" is about his machine. Ask first before Playwright, `smoke.sh`, model downloads, the demos eval, training, realapps, Azure, `git push`, `gh release` and `npm publish`.

## Tests

| step | what proves it |
|---|---|
| A3 | CI-equivalent run: 332 passed + 14 skipped (346) at b435acb, or 333 + 14 (347) with the DL-7 fix committed, then perf 4 passed; `npm pack --dry-run` lists 26 files |
| A5 | `smoke.sh` prints `SMOKE OK: <tgz>` |
| A8 | `dist-tags`, `dist.shasum` equal to the local tarball's sha1, a clean install that imports, `npx genclass-runtime --help` |
| B2 | `genclass-runtime info` exits 0; `vitest run test/model` with `GENCLASS_MODEL_DIR` (export fixtures); `ortweb_report_q8.json` with full argmax agreement |
| B6 | CDN card identical to the packed one; `fetch-model` from the CDN and from the GitHub release verifies every sha256 |
| B7 | demos eval Off / Observe / Guard, with no clean-run regressions |

## Drift and open issues

- **Stale release text elsewhere (as of b435acb):**
  - `HANDOFF.md` gives the publish command without `--tag`, which fails for prereleases;
  - `packages/runtime/README.md` mentions `fetch-model`, whose default source is 404; confirm the "none for this runtime yet" caveat is still present before packing;
  - `MODEL_CARD.md` describes round 1.
- **Open review findings (2026-10-08) that matter for B8**, by `path` -> `symbol`:
  - **high:**
    - `packages/runtime/src/situation/content.ts` -> `contentFacts`: the F2 fact prints raw text of redacted fields through `stringDiff`;
    - `packages/runtime/src/state/hub.ts` -> `StoreHub.applyFilter`: a delivery discard is a no-op on redux/zustand stores but is recorded as a drop.
  - **medium:**
    - `packages/runtime/src/runtime.ts` -> `RuntimeImpl.runDelivery`: observe mode (the default) still holds deliveries up to 100 ms, and XHR listeners run outside dispatch;
    - background delivery decisions are dropped as stale;
    - discard marks catch later chained polls (`RuntimeImpl.dropFilter`);
    - a delivery `defer` can stall a push channel for 20 s;
    - held WS/SSE messages are delivered after `close()` (`packages/runtime/src/observe/messages.ts` -> `MessageGate.pump`).
  - **low:**
    - `packages/runtime/src/util.ts` -> `isSensitivePath`/`defaultRedact` no longer redacts numbers or arrays under secret-named containers;
    - `packages/runtime/src/situation/evidence.ts` -> `NOT_PROCESSED` treats 502 as "not processed".
  - **TRAIN-side (they affect the model's quality, not the packaging):**
    - unlabeled rows keep `expected` diagnoses that S1 would relabel (`sim/src/gen/trajectory.ts` -> `unlabeledTrajectory`, `training/label_teacher.py`);
    - `training/label_cluster.sh` can report done without labelling anything;
    - `training/final_post.sh` is tied to `simAe` (see B0);
    - SIM still samples the v1 3,200-char budget (`sim/src/world/scenario.ts`);
    - several `training/curriculum/rt.py` divergences from the frozen renderer.
- **Real-app claims.** The "0/396 changed" never-worse sweep (`docs/runtime/RESULTS.md` §4) compares only final visible text and server content. It covers 66 of the now 91 apps, and it never compares observe mode against no runtime. Quote it that way in release notes; see [docs/agents/realapps.md](docs/agents/realapps.md).
- **Unverified:**
  - the v2 round's delivery directory name on the train VM;
  - whether the `genclass` developer role can create `@genclass/runtime-model`;
  - jsDelivr's size limit for a larger model package;
  - which model tests skip with a v2 export;
  - `smoke.sh` on `mvp-v2`.

## Related docs

- [docs/agents/runtime/build-test-release.md](docs/agents/runtime/build-test-release.md): build, tests, CI, publish history.
- [docs/agents/runtime/model-host.md](docs/agents/runtime/model-host.md): the model card, loader, CLI and default URL.
- [docs/agents/model-io-contract.md](docs/agents/model-io-contract.md): what a model must accept to match the runtime.
- [docs/agents/training.md](docs/agents/training.md): TRAIN's eval and export chain.
- [docs/agents/demos.md](docs/agents/demos.md): the demos eval, `cities.ts`, demo modes.
- [docs/agents/realapps.md](docs/agents/realapps.md): the real-app corpus and the never-worse sweep.
- [docs/agents/playbooks.md](docs/agents/playbooks.md): recipes 19 and 20.
- [HANDOFF.md](HANDOFF.md), [OPEN_TASKS.md](OPEN_TASKS.md), [docs/runtime/RESULTS.md](docs/runtime/RESULTS.md), [packages/runtime/STATUS.md](packages/runtime/STATUS.md), [packages/runtime-model/MODEL_CARD.md](packages/runtime-model/MODEL_CARD.md).
