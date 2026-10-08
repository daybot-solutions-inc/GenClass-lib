# Chrome extension, benchmarks and ops scripts (adjacent to the runtime library)

> **Scope:** `extension/**`, `bench/**`, `jev_local/bench/**`, `BENCHMARKS.md`, `results/**`, `scripts/**`, `docs/benchmax-research/**` (summarised).
> **Read this when:** you touch the GenClass voice-control Chrome extension; you need to know where the runtime's model engine/packer/tokenizer came from and how parity was proven; you run, extend or quote a benchmark (jevbench, benchmax, the computer-use head-to-head); you need to know what a script in `scripts/` does and whether it touches Azure, money or secrets.
> **Source of truth:** the code. Verified against branch `mvp-v2` at b435acb (origin/runtime 74f17c0 = situation-v2, plus default mode observe and CI), 2026-10-08. If this doc and the code disagree, the code wins.
>
> **What changed since 654d822:** nothing under `extension/`, `bench/`, `jev_local/bench/`, `BENCHMARKS.md`, `results/`, `scripts/` or `docs/benchmax-research/` (`git diff --stat 654d822 b435acb` over those paths is empty). What changed is who calls into this area: three new training launchers (`training/{launch_student,launch_t150,launch_r68}.sh`) call `scripts/launch_run.sh`, the new `training/cluster_expand.sh` reuses `scripts/cluster_up.sh`'s VM settings, the new `realapps/` README builds and pilot-runs through `scripts/vm.sh` (slot `real`; its cluster-scale runs use `realapps/scripts/cluster.sh`, which does its own ssh/rsync and calls nothing in `scripts/`), and the new CI workflow (`.github/workflows/ci.yml`) covers only `@genclass/runtime`, not the extension or any Python here.

## TL;DR

- **This whole area is adjacent/legacy relative to `@genclass/runtime`.** It is the pre-runtime GenClass project (the "jev-local" era): a voice-controlled MV3 Chrome extension (GenClass 0.1.0), the Python benchmark harnesses that compared the model with TypeSafe's hosted Jev, and the Azure/Mac ops scripts. `docs/runtime/CONTRACT.md` says "Existing GenClass content (jev_local/, extension/, docs/, etc.) stays as is. Do not edit it."
- **What the runtime work actually depends on here:** (1) `scripts/vm.sh` (the original team's build/test path: every workstream built/tested on the `train` VM through it, and `realapps/README.md` runs the realapps build, debug runs and pilot generator through it with slot `real`, see [realapps.md](realapps.md); our CI and the lead's local checks on a 16 GB machine do not use it); (2) `scripts/azvm.sh` (training scripts `training/{deliver_final,import_sim,import_final}.sh` call it, see [training.md](training.md)), `scripts/launch_run.sh` (called by `training/launch_s2.sh`, `training/launch_final1.sh`, and (new since 654d822) `training/launch_student.sh`, `training/launch_t150.sh` and `training/launch_r68.sh`, plus the `training/README.md` recipes, to start multi-node torchrun jobs), `scripts/cluster_up.sh` (whose VNet/subnet/NSG/PPG/image/key settings `training/cluster_expand.sh` copies when it adds nodes) and `scripts/genclass_export.py`, whose `ExportModel`/`plan_inputs`/`unpack` `training/export_runtime.py` imports; (3) the **v0.1 GenClass ONNX model** that the extension shipped (GitHub release `MeharPro/GenClass` v0.1.0) is the model the runtime's model tests and parity work were developed against (`docs/runtime/CONTRACT.md` §10: "Until the runtime model exists, develop against the v0.1 GenClass ONNX"), and its card format is accepted by `packages/runtime/src/model/loader.ts` -> `parseCard`. It is **not** the runtime's default model: that is `packages/runtime/src/model/host.ts` -> `DEFAULT_MODEL_BASE_URL` (`https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/`), and `packages/runtime/bin/genclass-runtime.mjs` -> `DEFAULT_FROM` points at the same directory (until 2026-10-08 the `runtime-model-v0.1.0` release of GenClass-lib) (both 404 as of 2026-10-08: no situation-v2 model exists yet, and the situation-v1 R17-final1 does not match the v2 runtime; see [status-and-known-issues.md](status-and-known-issues.md)). The v0.1 extension model reads the extension's own `state` serialisation, not runtime situation text (v1 or v2), so it is useful only for engine/packer/loader mechanics, never for decision quality; (4) the runtime's `src/model/{engine,packer,tokenizer,serialize,pyutil,calibrate}.ts` are TypeScript ports of `extension/src/core/{engine,packer,tokenizer,serialize,pyutil}.js` (calibration lives inside `engine.js` in the extension), and both are tested against the **same** Python-generated parity fixtures. No runtime/sim/demos/realapps/training code imports anything from `extension/` or `jev_local/bench/` or `bench/` (checked with grep; `packages/runtime/src/model/{engine,serialize,pyutil,loader}.ts` mention the extension only in comments). Besides this area's own tests (`tests/test_bench_*.py`, `tests/test_bm_*.py`), the only importers of `jev_local/bench` are the legacy `jev_local` data tests `tests/test_data_s.py`, `tests/test_data_s_intent_topic.py` and `tests/test_data_s_verify.py`.
- **Extension architecture:** service worker (`src/background/sw.js`: tabs, navigation, feature plumbing) + offscreen document "brain" (`src/offscreen/offscreen.js`: model, speech, decision loop) + content script (`src/content/content.js`: page observation, in-page actions, ad hiding) + side panel (`src/sidepanel/panel.js`: view + settings). Pure-JS decision logic lives in `src/core/`: `types`, `catalog`, `questions`, `state`, `spans`, `stream`, `policy`, `safety` and `controller` port the Python macOS harness `jev_local/harness/*`; `tokenizer`, `packer` and `engine` port `jev_local/engine/encoder/{tokenize_pack,engine,calibrate}.py` plus `jev_local/confidence.py`; `serialize` ports `jev_local/serialize.py`; `features`, `sites` and the numbered-pick/rescue code are GenClass-only additions.
- **The model is asked typed questions** (choice / noul / score) about a `state` object (screen, focused element, recent actions, pending, transcript). Questions are block-isolated in the attention mask, so the extension asks in two exact stages (intent/complete/is_command/destructive first, then only the argument question the intent needs).
- **Mid-sentence acting is safe** because of a consumed-prefix transcript cursor (`core/stream.js` -> `Stream`), stability gates (`core/policy.js` -> `evaluatePolicy`), deterministic safety rules plus spoken confirmation (`core/safety.js` -> `gate`), and a 3 actions/s rate limit.
- **Benchmarks** come in three generations: the computer-use head-to-head vs Jev (`results/genclass-vs-jev-computer-use.md`, summarised in `BENCHMARKS.md`); **jevbench v1** (25 public datasets, pre-registered in `bench/PREREG-jevbench.md`, release read M0 in `results/jevbench-m0.md`, Jev pass blocked by billing); **benchmax** (549 published Jev numbers, 154 counted; 19 publisher-harness adapter specs; pre-registered draft in `bench/PREREG-benchmax.md`; no test-split scoreboard exists in the repo).
- **Headline numbers:** v1 32M model beats Jev on mid-sentence intent (90.4% vs 66.4%, n=664) and typed span (94.9% vs 75.5%, n=98); Jev wins on held-out generic questions (94.7% vs 80.5%, n=451) and AG News (0.882 vs 0.315). jevbench M0 skill index for v1 = 10.1 [9.7, 10.7].
- **Rules that bind anyone touching this area:** the original team rule (CONTRACT §0 rule 5, repeated in `HANDOFF.md`) was that the colleague's 8 GB Mac only edits files; that rule is about that machine. The current agent policy ([../../AGENTS.md](../../AGENTS.md) §4) requires the user's OK for Playwright (which includes the extension's e2e), model downloads and any script that touches Azure (`scripts/*.sh`); nothing else in this area (extension `npm ci`/`npm test`, the Python tests, `scripts/*.py`, benchmarks) is in the verified command set either, so ask first; Jev outputs are evaluation-only; OpenRouter/Jev calls cost real money (lifetime cap $5 per the benchmax PLAN) and need the user's OK; benchmark test splits are read once per release.

## Files

### Extension (`extension/`, GenClass 0.1.0, not an npm workspace)

| path | role | key exports / entry points |
|---|---|---|
| `extension/README.md`, `MODEL_CARD.md`, `RELEASE.md`, `NOTICE`, `LICENSE` | product docs, model card, manual release checklist (legacy extension checklist; not the runtime release procedure in the root `RELEASE.md`), third-party notices, Apache-2.0 text | — |
| `extension/package.json` (+ own `package-lock.json`) | scripts `build`, `package`, `test`, `test:e2e`; deps `onnxruntime-web ^1.31.0-dev.20260914-8d85527a0`, `@huggingface/transformers ^4.3.0`; dev `@playwright/test ^1.63.0`, `esbuild ^0.28.2` | not in root `package.json` `workspaces` |
| `extension/static/manifest.json` | MV3 manifest; `minimum_chrome_version` 116; permissions `sidePanel offscreen storage scripting alarms system.memory`; host `<all_urls>`; `content.js` declared as a content script for `http://*/*` and `https://*/*` at `document_idle` (tabs opened before install get it via `sw.js` -> `ensureContent`); commands `toggle-listening` (Alt+Shift+G), `kill-switch` (Alt+Shift+K); CSP `script-src 'self' 'wasm-unsafe-eval'`; COEP `require-corp`, COOP `same-origin` | — |
| `extension/static/{panel.html,panel.css,offscreen.html,welcome.html,audio-worklet.js,icons/}` | pages, styles, mic AudioWorklet (`genclass-capture`, posts 1600-sample = 100 ms chunks) | — |
| `extension/src/background/sw.js` | service worker: side panel, offscreen lifecycle, observe/execute routing, tab ops, content filter rules, focus/RAM plumbing | module-internal (nothing exported): `ensureBrain`, `observe`, `execute`, `tabOp`, `filterBlocks`, `ramTick`, `RESTRICTED_RE`, `DENY_SITE_RE`, `DEFAULT_FEATURES` |
| `extension/src/offscreen/offscreen.js` | "brain": model download/cache/load, speech, `Controller` wiring, message handlers | module-internal (nothing exported): `loadEngine`, `fetchCached`, `observer`, `executor`, `buildController`, `textCommand`, `benchModel`, `benchSpeech`, `playAudio`, `CACHE` |
| `extension/src/offscreen/speech.js` | speech sources: local ASR (transformers.js, energy VAD, re-decoded partials) and Web Speech | `SPEECH_ENGINES`, `speechPlan`, `gpuInfo`, `LocalAsr`, `LocalSpeechSource`, `WebSpeechSource`, `summarizeStats` |
| `extension/src/offscreen/features_rt.js` | model-backed content filter, focus mode, tab relevance | `Features` |
| `extension/src/content/content.js` | page observation (numbered elements), in-page actions, overlays/badges, content-block hiding, Esc kill switch | IIFE; message types `observe execute badges listening ping page_info filter_set filter_unhide_all` |
| `extension/src/sidepanel/{panel.js,welcome.js}` | panel view + settings; welcome/mic-permission page | `DEFAULTS`, `FEAT_DEFAULTS` |
| `extension/src/core/types.js` | shapes, `Kind`, `Risk`, thresholds, default config | `Kind`, `KINDS`, `Risk`, `DEFAULT_THRESHOLDS`, `defaultConfig`, `makeAction`, `describeAction` |
| `extension/src/core/catalog.js` | closed vocabularies (model input, do not edit) | `INTENTS`, `BROWSER_EXTRA_INTENTS`, `KEYS`, `FOLDERS`, `SCROLL_LEVELS`, `RISK_WORDS`, `RISK_RE`, `DENY_APP_*`, `SECURE_FIELD_RE`, `FILLERS`, `CHAIN_WORDS` |
| `extension/src/core/questions.js` | fixed question schema per transcript update | `buildQuestions`, `elementLine`, `rankApps`, `INSTR`, `Q_*` ids |
| `extension/src/core/state.js` | the `state` object | `buildState` |
| `extension/src/core/spans.js` | verbatim text/URL candidates, numbered picks, word consumption | `extractTextCandidates`, `extractUrlCandidates`, `parseCandidatePick`, `consumedFor`, `endsSentence` |
| `extension/src/core/stream.js` | consumed-prefix transcript cursor | `Stream`, `matchPrefix`, `coreWords` |
| `extension/src/core/policy.js` | answers -> verdict (pure) | `evaluatePolicy`, `ARG_QUESTIONS`, `pickOf`, `newPolicyContext` |
| `extension/src/core/safety.js` | deny / risk / confirm gating, rate limit | `gate`, `classifyRisk`, `denyReason`, `confirmationAllowed`, `RateLimiter`, `CONFIRM_REACTION_S` |
| `extension/src/core/controller.js` | incremental decision loop | `Controller`, `rescueTarget`, `silenceGatesFor`, `MAX_LOOPS`, `MAX_DEBOUNCE_MS` |
| `extension/src/core/{tokenizer,packer,engine,serialize,pyutil}.js` | model engine (ancestor of the runtime's `src/model`) | `Tokenizer`, `Packer`, `planInputs`, `unpackLogits`, `Engine`, `calibrateLogits`, `buildAnswer`, `headerKey`, `stateSegments`, `questionBlock`, `pyRound` |
| `extension/src/core/{features,sites,fuzz}.js` | feature questions/verdicts; tab/site catalogue for `app`; rapidfuzz `partial_ratio` port | `filterRequest`, `focusRequest`, `focusVerdict`, `protectedTab`, `discardOrder`, `appCatalog`, `SITES`, `extract` |
| `extension/src/model/{model.json,tokenizer.json,calibration.json,meta.json}` | model card (URLs, sha256) + bundled small files | — |
| `extension/release-assets/{tokenizer,calibration,meta,parity}.json` | export outputs: `tokenizer/calibration/meta.json` are byte-identical to `src/model/` (checked with `cmp`), plus `parity.json`; there is no `model.json` here; `*.onnx` are gitignored and absent | — |
| `extension/scripts/build.mjs` | esbuild bundle -> `dist/genclass/`; `--zip`, `--bundle-model`, `--release`, `--dev` | — |
| `extension/scripts/{make_icons.mjs,compose_screens.mjs}` | icon PNGs (no image libs); 1280x800 store screenshots from e2e raw shots | — |
| `extension/scripts/make_py_fixtures.py` | regenerates `test/fixtures/{spans,questions,policy,stream}_py.json` from `jev_local.harness` | — |
| `extension/tools/genclass_export.py` | PyTorch -> ONNX export (fp32/fp16/q8), parity, `pack_fixtures.json`, `torch_fixtures.json` (VM, torch) | `ExportModel`, `make_q8`, `plan_inputs`, `unpack` |
| `extension/test/unit/*.test.mjs`, `test/e2e/*.spec.mjs`, `test/eval/*` | see [Tests](#tests) | — |
| `extension/test/unit/helpers.mjs` | `ROOT`, `FIX`, `ASSETS`, `readJson`, `questionsFromJson` (rebuilds choice criteria as `Map`s in Python label order, because `JSON.parse` reorders integer-like keys) | — |
| `extension/test/e2e/fixtures.mjs` | Playwright launcher: persistent Chromium context with the unpacked extension (`GENCLASS_EXT`, default `dist/genclass`), the local server, the panel as a page; `say()` waits 700 ms before each command (the `Stream` treats an identical command within 350 ms of a final as a recognizer duplicate) | `launch`, `setSettings`, `shot`, `EXT`, `SHOTS` |
| `extension/test/e2e/server.mjs` | static server with COEP-compatible headers (`cross-origin-resource-policy: cross-origin`, `access-control-allow-origin: *`); mounts `/site/` (test pages), `/assets/` (`release-assets/`), `/audio/`, `/fixtures/`, `/shots/`; standalone `node test/e2e/server.mjs [port]` defaults to port 8737 | `startServer` |
| `extension/test/e2e/playwright.config.mjs` | `testMatch` `*.spec.mjs`, `timeout` 600000 ms, `workers` 1, reporter `list` | — |
| `extension/test/e2e/site/{shop,notes,recipes}.html` | local test pages: `shop` = voice commands and marked ads; `notes` = an on-task tab (laptop battery notes); `recipes` = the off-task tab in the focus test; both also serve as idle tabs in the RAM test | — |
| `extension/test/fixtures/{requests50,pack_fixtures,torch_fixtures}.json` | the 50 harness requests (with `gold`, `screen_type`) and the export's Python/PyTorch parity outputs | — |
| `extension/test/fixtures/{spans,questions,policy,stream}_py.json` | Python-harness parity fixtures (from `extension/scripts/make_py_fixtures.py`, not the runtime's `packages/runtime/test/fixtures/model/make_py_fixtures.py`) | — |
| `extension/test/fixtures/audio/{click,scroll,type}.wav` | 16 kHz mono 16-bit speech clips; `speech.spec.mjs` uses `scroll.wav` (`bench_speech`) and `click.wav` (`play_audio`); `type.wav` is not referenced by any test or script | — |
| `extension/.gitignore` | ignores `node_modules/`, `dist/`, `release-assets/*.onnx`, `test-results/`, `playwright-report/`, `.DS_Store` | — |
| `extension/store/{listing,permissions,privacy}.md`, `store/screenshots/*.png` (01–09, 1280x800), `store/icon-128.png` | Chrome Web Store material; `permissions.md` justifies each manifest permission and lists what is **not** requested (`tabs`, `debugger`, `history`, `cookies`, `webRequest`, `clipboardRead`) | — |
| `extension/static/icons/store-icon-128.png` | store icon; `build.mjs` deletes it from `dist/genclass/icons/` | — |

### Benchmarks

| path | role | key exports / entry points |
|---|---|---|
| `BENCHMARKS.md` | public summary: CU head-to-head, speed/cost, wire compatibility, order robustness, where Jev wins, caveats | — |
| `results/genclass-vs-jev-computer-use.md` | full CU head-to-head table (1,280 examples) | — |
| `results/jevbench-m0.md` | jevbench v1 release read M0 report | — |
| `results/z68m-dev-notes.md` | Z-68m (benchmax zero-shot retrain) dev check and calibration-transfer finding | — |
| `bench/PREREG-jevbench.md` | jevbench v1 pre-registration (sha256 `a35004c6…6fe457`, matches the hash M0 quotes) | — |
| `bench/PREREG-benchmax.md` | benchmax phase-0 freeze (DRAFT, local only) | — |
| `bench/public/targets.json` | 549 targets, schema `benchmax-targets/1` | `targets[]` |
| `bench/public/jev_published.json` | 549 published Jev numbers (list of rows) | — |
| `bench/public/exclusions.json` | registry manifest, schema `benchmax-exclusions/1` | — |
| `jev_local/bench/registry.py` | jevbench datasets + training-exclusion rules (decontamination stage 1), stdlib only | `TEST`, `DEV`, `REF`, `RETIRED_DEV`, `exclusion_reason`, `is_excluded`, `s_allow_reason`, `exclusion_manifest`, `manifest_sha256` |
| `jev_local/bench/templates.py` | dataset row -> Jev request mappers, variants | `m_<key>`, `MAPPERS`, `bare`, `shuffled`, `validate_request`, `TEMPLATE_VERSION`, `FIN_TOPIC_NAMES` |
| `jev_local/bench/build.py` | download, pin, sample, render jevbench files (VM) | `build_dataset`, `sample_items`, `main` |
| `jev_local/bench/metrics.py` | scoring, indices, bootstrap, decision rule (numpy) | `collect`, `score_dataset`, `index`, `decision_rule`, `flip_rate`, `skill`, `decision_score` |
| `jev_local/bench/ours.py` | run a FastEngine checkpoint with exact option/question chunking (VM, torch) | `OursRunner` |
| `jev_local/bench/baselines.py` | open-baseline adapter contract; only the HTTP adapter is implemented | `SystemOneHTTP`, `BASELINES`, `run_rows` |
| `jev_local/bench/benchmax/__init__.py` | spec registry | `Spec`, `register`, `load_specs`, `get_spec`, `runner_adapter_class` |
| `jev_local/bench/benchmax/{specs_a,specs_b}.py` | the 19 registered specs (4 group A + 15 group B) | `DEUSSER`, `DECISION_INDEX`, `TYPED_DECISIONS`, `JEVBENCH_HF`, `SPECS_B` |
| `jev_local/bench/benchmax/runner.py` | engine clients, wire answers W1–W3, refusals W4, overflow W5, `run.json`, determinism W11 | `LocalClient`, `HttpClient`, `HeuristicClient`, `wire_answers`, `refusal_body`, `RunContext`, `Session`, `check_model_id` |
| `jev_local/bench/benchmax/bridge_b.py` | wraps group-B adapters into the runner contract | `bridge_class`, `is_group_b_class` |
| `jev_local/bench/benchmax/adapters_a/*.py` | Deußer, Decision Index, typed-decisions, jev-bench (HF) | `DeusserAdapter`, `DecisionIndexAdapter`, `TypedDecisionsAdapter`, `JevbenchHfAdapter` |
| `jev_local/bench/benchmax/adapters_b/<suite>.py` (15 modules, see [the spec table](#benchmax-spec-registry-19-specs)) | group-B suites | module-level `SPEC_ID`, `TARGETS` (target row ids like `"T308"`), usually `TASKS`; class `Adapter(AdapterB)` constructed as `Adapter(spec, args)` (`args.work`, `args.limit`, `args.tasks`) with class attributes `SPLITS`, `TASKS`, `EVAL_SPLIT` and methods `prepare(split)`, `items(split, limit, tasks)`, `score(items, answers, split, thresholds)`, optional `fit(items, answers)` (registered as `"<module>:Adapter"` in `specs_b.py`) |
| `jev_local/bench/benchmax/adapters_b/common.py` | shared `Item` record, `AdapterB` base class, pinned fetching (commit/revision + sha256), HF parquet reading, publisher metrics (F1, ECE, nDCG, Wilson CIs, bootstrap) | `Item`, `AdapterB`, `work_dir`, `repos_dir`, `hf_home`, `DEFAULT_WORK`, `MODEL_ID`, `VENDOR` |
| `jev_local/bench/benchmax/adapters_b/driver.py` | group-B standalone CLI (`python -m jev_local.bench.benchmax.adapters_b.driver prepare\|items\|run\|score\|fit\|selfcheck`); writes `items.jsonl`, `answers.jsonl`, `scores.json`, a lighter `run.json`; `selfcheck` refuses the test split | — |
| `jev_local/bench/benchmax/adapters_b/engine_client.py` | answerers: `HttpAnswerer` (POST `/v1/systemone`), `LocalAnswerer` (VM; `OursRunner` + `jev_local.confidence.build_answer` at 12 digits), resumable `run_items` | `HttpAnswerer`, `LocalAnswerer`, `run_items`, `AnswerError` |
| `jev_local/bench/benchmax/adapters_b/vendor/` | pinned upstream label/prompt/policy files per publisher (11 directories; each carries the upstream `LICENSE` except `dmb/`, whose repo has no licence); `UPSTREAM_SHA256.txt` lists 34 sha256 lines for upstream caches/candidate files | — |
| `jev_local/bench/__init__.py`, `benchmax/adapters_a/__init__.py`, `adapters_b/__init__.py` | package markers (`adapters_b/__init__.py` documents a module-level function contract that the adapters no longer follow; the real contract is in `specs_b.py`'s docstring and `common.py` -> `AdapterB`, see Drift) | — |

### Research notes (`docs/benchmax-research/`, read-only background; all reference their old home `docs/research/benchmax/`)

| file | lines | what it holds |
|---|---|---|
| `PLAN.md` | 971 | the binding benchmax plan (2026-10-03): 154 counted benchmarks, two tracks, test hygiene (§2), data acquisition, model ladder 68m/150m/400m/1b, compute budget (≈ $2.9–5.1k Azure, 12x F80as_v7 + D64), harness per suite (§6), predicted outcome, decisions for the user. $5 lifetime cap on Jev, $0 planned. |
| `feasibility-targets.md` | 876 | rev 2: per-benchmark W/T/L verdicts by size and track, significance bar formula (§1.2), the §3 verdict table parsed by `scripts/benchmax_build_targets.py` |
| `jev-published.md` | 2206 | census of every published Jev number (549 rows in `bench/public/jev_published.json`), tiers A/B/C/X and `protocol=zero-shot\|uses-train-data` notes |
| `suite-reproduction-specs.md` | 768 | how to reproduce each of the 9 suites byte-exactly, pinned commits, engine requirements W1–W11 (§1.2), the contamination-audit pattern list that fed the registry's sibling/`public_jev` rules (§1.5) |
| `train-data-and-supervised-ceilings.md` | 936 | train splits, licences, supervised ceilings and contamination traps (§7) per dataset; feeds the S allow-list |

### Scripts (`scripts/`): one row per script

"Azure" = needs an Azure VM / the `az` CLI / the private 10.0.0.x network. "Mac-only" = needs macOS/MLX/the 8 GB Mac. Nothing here should be run by an agent without the user's go-ahead; anything marked **$** spends money.

| script | purpose | where it runs | Azure? | notes |
|---|---|---|---|---|
| `azvm.sh` | `azvm.sh HOST 'cmd'` (ssh), `--put LOCAL REMOTE` (single-file scp), `--get REMOTE LOCAL` (recursive scp), `--sync` (rsync `--delete` of `jev_local scripts tests pyproject.toml` to `~/jev/`) for a named VM from `~/.jev-local/azure_hosts` (user `azureuser`, key `~/.ssh/jev_azure`) | Mac | yes | used by most other ops scripts and by `training/*.sh` (via `$JEV/scripts/azvm.sh` in the parent-repo layout; `HANDOFF.md` names the colleague's copy `/Users/meharkhanna/jev/scripts/azvm.sh` as the ssh helper); **no timeout of its own** (a `TIMEOUT=` prefix is ignored); `--sync` does **not** copy `bench/` or `docs/` |
| `vm.sh` | subcommands `sync SLOT`, `run SLOT 'cmd'` (sync then run), `exec SLOT 'cmd'` (no sync), `get SLOT REMOTE LOCAL`: rsync `-az --delete` of this repo to `~/gcl/SLOT` on VM `train` (host from `azure_hosts`), run commands in it with `$HOME/node/bin` on PATH; SLOT must match `[a-zA-Z0-9_-]+` | Mac | yes | **the runtime build/test path**; `TIMEOUT` default 1800 s per remote command (sync: 300 s mkdir + 600 s rsync; `get`: 600 s); rsync excludes `node_modules`, `.git`, `dist/`, `.vite`, `/data/`, `test-results/`, `playwright-report/`, `__pycache__`, `.DS_Store`, `/models/`, `/runs/`, **`/extension/`**, `/sim/out/`, `.cache-model/`; `--delete` removes slot files that are not in your local working copy unless they are under an excluded path; model dirs under `.cache-model/` or `<slot>/models/` survive |
| `cluster_up.sh` | `cluster_up.sh NAME:SIZE …`: `az vm create` training nodes `vm-jev-<NAME>` (Ubuntu 24.04, resource group `rg-jev-train`, 256 GB Premium disk, proximity group `ppg-jev`), appends `NAME PUBLIC_IP PRIVATE_IP SIZE` to `azure_hosts`, auto-shutdown 18:00 UTC | Mac | yes **$** | serial `az` only, no `timeout` wrapper; `training/cluster_expand.sh` (new since 654d822) creates further nodes with the same VNet/subnet/NSG/PPG/image/key (retrying without the PPG if it lacks capacity, each `az` call under `timeout`) but, instead of `az vm auto-shutdown`, adds a DevTestLab schedule (03:00 UTC) in **Disabled** state; per `training/NEEDS.md`, c12–c23 were created that way, and `HANDOFF.md` says the nightly schedules are currently disabled for the training push (re-enable when it ends) |
| `vm_bootstrap.sh` | one-time Ubuntu 24.04 VM setup: venv, CPU torch, data tooling | on a VM | yes | |
| `node_setup.sh` | on a fresh node: bootstrap + pull `v2_bundle.tar` from data VM `10.0.0.5:8797` | on a VM | yes | |
| `launch_run.sh` | `launch_run.sh RUN MASTER_PRIV_IP NPROC THREADS "node1 node2 …" -- <train args>`: detached (`setsid nohup nice -n 5`) multi-node `torch.distributed.run -m jev_local.train.train --ddp` over `azvm.sh`, master port 29500, env `OMP_NUM_THREADS=THREADS GLOO_SOCKET_IFNAME=eth0 JEV_ENCODER=banded TOKENIZERS_PARALLELISM=false HF_HUB_OFFLINE=1` | Mac | yes **$** | logs `~/jev/runs/<RUN>/rank<k>.out`; calls `scripts/azvm.sh` by a relative path, so run it from the repo root; reads no `TIMEOUT`; **also used by the runtime model training** (`training/launch_s2.sh`, `training/launch_final1.sh`, `training/launch_student.sh`, `training/launch_t150.sh`, `training/launch_r68.sh`, `training/README.md`) and by `launch_z68m.sh` / `stage1_speedtest.sh` |
| `launch_z68m.sh` | phase-2 benchmax Z-68m retrain: sync, distribute Z bundle (sha256 `a333fd88…`), launch 8 nodes x 4 ranks x 20 threads | Mac | yes **$** | expects `bench/public/mix_z_run.json` (not in repo) |
| `stage1_speedtest.sh` | PLAN-excel stage 1: 20-step 8-node DDP timing runs, copies timing logs to `runs/stage1/<RUN>/` | Mac | yes **$** | |
| `watch_runs.sh` | `watch_runs.sh INTERVAL_S "run:node …"`: poll rank-0 logs, print step/loss/tok/s, exit with `EVENT:` on DONE/ERROR/STOPPED | Mac | yes | |
| `phase3_eval.sh` | benchmax phase 3: start VM `train`, pull checkpoint from `c01`, dev eval + global calibration, write `~/phase3_run_all.sh` that runs every spec | Mac | yes **$** | prints manual steps; fitting the calibration is manual; the generated `phase3_run_all.sh` (`--threads 48`) skips a spec only if `run.json` contains `"complete": true`, which `RunContext` never writes (it writes `"status": "complete"`), so a second pass re-runs every spec and trips `benchmax.py`'s `--rerun-reason` guard (see Drift) |
| `benchmax.py` | benchmax CLI: `list`, `verify --spec`, `run --spec` (writes `runs/benchmax/<ckpt>/<spec>/run.json`) | `list`/`--help` anywhere; `verify`/`run` on VM `train` | yes (run) | default `--model-id genclass-68m`, `--threads 8`, `--determinism 20` |
| `benchmax/stage0_validation.sh` | `stage0_validation.sh CKPT OUT [MODEL_ID=genclass-68m] [THREADS=32]`: PLAN-excel stage 0, every adapter on NON-evaluated splits, `<OUT>/summary.tsv`; skips runs whose `run.json` is finished | VM `train` (launched via `azvm.sh train`) | yes | never passes `--allow-test`; `LIMIT` default 1000, per-run timeout 3600 s, `--determinism 5`; the skip test is `grep -q '"finished"'`, which matches **any** existing `run.json` (the key is always written, as `null` until the end), so failed/incomplete runs are skipped too (see Drift) |
| `benchmax/dry_pass_validation.sh` | `dry_pass_validation.sh [CKPT=~/jev/models/jev-local-fast-v2] [OUT] [THREADS=16]`: bm-integrate dry pass of all 19 specs on non-evaluated items | VM `train` | yes | eval-only suites get `verify` only |
| `benchmax/engine_determinism.py` | W11 determinism report on synthetic requests (in-process and optional live uvicorn) | VM | yes | loads torch |
| `benchmax_build_targets.py` | regenerate `targets.json` + `exclusions.json` from `jev_published.json` and the feasibility note; `--write-registry`, `--check` | anywhere (stdlib) | no | reads `docs/research/benchmax/feasibility-targets.md` (path moved, see Drift) |
| `jevbench.py` | jevbench CLI with subcommands `build`, `run-ours`, `run-jev`, `score`, `report` | `build`/`run-ours`/`score` on VM; `run-jev` on Mac; `report` anywhere | yes (VM steps) | `run-jev` calls OpenRouter **$** with key `~/.jev-local/secrets/openrouter.key` |
| `compare_jev.py` | CU head-to-head behind `results/genclass-vs-jev-computer-use.md`: Jev via OpenRouter vs `models/jev-local-fast` on `data/cu`, `data/gen` test samples; flags `--n-cu` 1000, `--n-gen` 300, `--seed` 7, `--workers` 6, `--skip-local`, `--jev-only`, `--local-only`; Jev cache `runs/compare/jev.jsonl`, ours `runs/compare/ours.json` | Mac (local CPU torch) | no | **$** OpenRouter; data/models not in repo |
| `openrouter_key.sh` | `set` (hidden prompt) / `check` balance of the OpenRouter key | Mac | no | handles a secret: never run on an agent's own initiative |
| `dev_to_calib.py` | jevbench clean-dev request files -> calibration-fitter rows (`CLEAN_DEV` 10 keys) | anywhere | no | needs `bench/jevbench/dev` files (VM) |
| `genclass_export.py` | **older** export variant: fp32/fp16 + dynamic **int8** (`genclass-int8.onnx`) | VM (torch) | yes | superseded for the extension's q8 export by `extension/tools/genclass_export.py`, but still imported by `training/export_runtime.py` |
| `bench_encoder.py` | FastEngine inference regimes (first/uncached/partials/warm) + training step benchmark; `runs/bench_encoder.json` | Mac (mps/cpu) | no | |
| `bench_decoder.py` | MLX decoder engine (`jev-local-general`) latency/accuracy; `runs/bench_decoder.json` | Mac-only (MLX) | no | |
| `bench_laya.py` | zero-shot Laya (`convaiinnovations/laya`) on the 20 harness cases | Mac | no | |
| `overnight.py` | memory-gated overnight job runner for the 8 GB Mac (`--daemon`, `--check`, `--status`, `--ignore-window`); control files in `~/.jev-local/overnight/` (`PAUSE`, `STOP`, `HOLD` expiring after 2 h, `status.json`) | Mac-only | no | start only if all hold for 60 s: swap < 3 GB, RAM free ≥ peak + 2 GB, swap-ins < 100/s, disk ≥ 4 GB, inside 23:00–09:30; stop if RAM free < 12 %, swap-ins ≥ 1000/s on 2 samples, or disk < 2.5 GB; SIGKILL at < 8 % free or ≥ 3000 swap-ins/s; tested by `tests/test_overnight.py` |
| `demo.py` | entry for the macOS voice computer-use demo (`jev_local.demo.main`; `--live`, `--text`, `--say`) | Mac-only | no | |
| `demo_proof.sh` | offline mid-sentence proof with the real model, gated by `overnight.py --check` (RAM free ≥ 2.5 GB, swap-ins < 300/s); env `MODEL` (`v1` default, `v2`), `ENGINE` (`fast` default, `rule` = no-weights check) | Mac-only | no | writes `docs/build/demo-proof/` |

## Concepts and data structures

The runtime terms (op, trigger, facts, situation, mode, tier, hold, …) do **not** apply to the extension; it predates the runtime. Its closest analogues: the extension's `state` object plays the role of the runtime's **situation**, and `Engine` plays the role of the runtime's **model host**/decider. New terms used in this doc:

| term | definition |
|---|---|
| harness | the extension's decision loop and its Python original `jev_local/harness/*` (macOS voice computer-use) |
| `Element` | `{eid, role, label, value?, context?, focused?, enabled?, secure?, submits?, inForm?, searchForm?}`; `eid` is `e01…` in screen order (`content.js` -> `observe`) |
| `Snapshot` | `{id, appName:"Google Chrome", windowTitle, url, browser:true, elements[], focusedEid, walkMs, takenAt}` plus `tabId`, `deniedSite`, `restricted`, `error` added by `sw.js` -> `observe` |
| `Tail` | the unconsumed transcript: `{vid, text, words[], cursor, isFinal, silentMs, uid, joined}` (`Stream.current`) |
| `vid` | virtual utterance id `"<uid>+<gen>"`; `gen` increments on every consume |
| `Action` | `{kind, sourceVid, confidence, targetEid, targetLabel, app, text, key, url, folder, amount, consumedWords}` (`types.js` -> `makeAction`) |
| `Decision` | `{verdict, action, reason, seq, retryInMs, answers, latencyMs, risk}`; verdicts `act wait ignore clarify confirm deny need_args` |
| `Kind` | `open_app quit_app click type_text search_web open_url press_key scroll_down scroll_up open_folder go_back go_forward new_tab close_tab undo confirm cancel` |
| `Risk` | `LOW 0, MEDIUM 1, HIGH 2, DENY 3` |
| question ids | `intent complete is_command destructive target app key folder text_span url_span scroll_amount`; `folder` omitted in browser mode; `target` only with elements; `text_span`/`url_span` only with candidates |
| staged evaluation | pass 1 = `STAGE1` (`intent complete is_command destructive`); if policy returns `need_args`, pass 2 asks only `ARG_QUESTIONS[intent]` |
| consumed prefix | words already acted on; later partials must still start with them (fillers/chain words ignored) or the stream freezes (`revised_after_act`) |
| rescue | `controller.js` -> `rescueTarget`: for intent `click`, if the target answer is `none`/weak and exactly one on-screen label (≥ 3 chars) occurs verbatim, overwrite the answer (p 0.9) and log `rescue` |
| numbered pick | after "which element?", top-3 candidates get page badges; "number two"/"the second one" within 10 s and ≤ 5 words clicks it without a model call (still through `gate`) |
| pending | a risky action waiting for spoken "confirm" (`Controller.propose`), expires after `confirm_timeout_ms` |
| header key | `sha1(header)[:12]`, the calibration `by_header` key (`engine.js` -> `headerKey`) |
| jevbench | v1 benchmark: 25 test datasets in 7 areas (A Topic … G Multi-question), dev and reference rows (`registry.py` -> `TEST`, `DEV`, `REF`) |
| variant | jevbench request flavour: `main` (counted), `shuffle` (option-order rotation), `bare` (no descriptions), `choice` (SST-2 only) |
| skill | `clip((m − c)/(1 − c), 0, 1)` for primary metric `m` and chance `c` (`metrics.py` -> `skill`) |
| Decision Score | `clip(1 − mean Brier / mean Brier_prior, −1, 1)` per dataset (`metrics.py` -> `decision_score`) |
| benchmax | campaign to beat every published Jev number through each publisher's own harness |
| target row | `targets.json` `targets[]` entry, fields: `id, row, suite, dataset, hf_id, config, split, n, metric, higher_is_better, jev_score, jev_model, jev_protocol, tier, date, source_url, raw_outputs_url, raw_outputs_use, group, category, benchmark_key, role, counted, bar_z, bar_s, bar_source, s_bar_rows, verdict{S:{68m,150m,400m,1b}, Z:{…}, source}, track{Z,S}, train_sources, z_contamination_flags, spec_id, spec_status, note` |
| role | `headline` (154, counted), `s_bar` (10), `secondary` (58), `context` (300), `composite` (4), `diagnostic` (23) |
| track Z / S | Z = zero-shot (no benchmark data of any split); S = supervised (official train splits allowed, disclosed) |
| `Spec` | `{id, suite, adapter, harness, verification, counted_rows, description, owner}`; `id` equals a `targets.json` `spec_id` byte for byte |
| W1–W11 | engine/wire requirements from `suite-reproduction-specs.md` §1.2 (choice argmax of unrounded p, confidence formula, precision, refusal bodies, overflow, …, W10 model id, W11 determinism) |
| `run.json` | per-run record, schema `benchmax-run/1` (`runner.py` -> `RunContext`) |
| decontamination stage 1 | name-level exclusion of training sources (`registry.py` -> `is_excluded(name, track)`) |
| meharsjev / genclass-<size> | model ids used for benchmax runs; `jev-*` and `typesafe/*` are rejected (`runner.py` -> `check_model_id`) |
| CU / GEN | in the head-to-head: CU = synthetic computer-use harness examples (the extension's domain); GEN = generic questions from task families held out of training |
| `jev-local-fast` (v1) / v2-68m / Z-68m | v1 = the 32M Ettin computer-use checkpoint the extension ships (`jev-local-fast-0.1.0`); v2-68m = `jev-local-fast-v2` (68m checkpoint whose training mix contains public-Jev train splits, so no S or Z model may be initialised from it, PLAN §2.3 item 5, and it cannot back a Z claim on about 25 counted rows, PLAN §0); Z-68m = `meharsjev-68m-z`, the clean zero-shot benchmax retrain |
| release read (M0) | one pre-registered scoring of jevbench test splits for a release tag (`--release m0`); test splits are read once per release |
| group A / group B | benchmax adapter families: A (4 specs, `adapters_a`, own `add_arguments/verify/run`), B (15 specs, `adapters_b`, `prepare/items/score/fit`, wrapped by `bridge_b`). "Eval-only" B suites (`asevlad_injection`, `mbburabak_safety`) have no non-test split, so dry passes only `verify` them |

Message routing in the extension: every `chrome.runtime.sendMessage` carries `{to: "sw"|"brain"|"panel"|"content", type, …}`.

| receiver | message types |
|---|---|
| `sw` (`sw.js`) | `ensure_brain observe execute tabs badges listening filter_enabled_for filter_blocks filter_count filter_site tab_list_full tab_get page_info tab_op ram_tick active_host open_mic_page` |
| `brain` (`offscreen.js`, two listeners) | `init settings start stop toggle kill text confirm cancel status log bench_speech bench_model play_audio clear_cache`; features: `filter_classify focus_config tab_event focus_keep focus_state relevance` |
| `panel` (`panel.js`) | `status progress ui{event}` with events `transcript decision executed pending picks error info denied killed` (the controller also emits `halted`, which the panel ignores; the brain refreshes `status` instead); `lists_changed focus` |
| `content` (`content.js`) | `observe execute badges listening ping page_info filter_set filter_unhide_all` |

Storage (`chrome.storage.local`): `settings` (panel `DEFAULTS` + `filter/focus/ram`), `parked` and `ramFreed` undo lists (max 50 via `sw.js` -> `pushList`), `ramStatus`. Cache Storage: `genclass-models-v1` (decision model) and transformers.js caches (speech models). `brain clear_cache` deletes `genclass-models-v1` and every cache whose name starts with `transformers`.

### Extension model I/O (v0.1 ONNX graph)

Defined by `extension/tools/genclass_export.py` (docstring) and `src/model/meta.json` `inputs`/`outputs`; fed by `core/engine.js` -> `Engine.feeds`. Batch is always 1, no padding; all inputs `int64`.

| tensor | shape | meaning |
|---|---|---|
| `input_ids`, `position_ids`, `q_group`, `i_group` | `[1, L]` | packed sequence; `q_group` = -1 for state else question ordinal; `i_group` = -1 for state and header tokens else item ordinal (`core/packer.js` -> `Packer.layout`) |
| `choice_q` `[G]`, `choice_items` `[G, K]` | | flat index of each choice question's `[Q]` marker and its `[O]` item markers (padded with 0) |
| `score_q` `[S]`, `score_items` `[S, K2]` | | `[Q]` and `[L]` markers |
| `noul_q`, `noul_t`, `noul_f` | `[M]` | `[Q]`, `[T]`, `[F]` markers |
| outputs `choice_logits [G, K]`, `score_logits [S, K2]`, `noul_logits [M]` | fp32 | raw logits at temperature 1; padding columns are garbage (`unpackLogits` slices to `labels.length`). An absent kind is fed a dummy `[0]` |

Calibration and answers (`core/engine.js`, mirrors `jev_local/engine/encoder/calibrate.py` and `jev_local/confidence.py`):

1. Temperature for choice/score: `by_header[headerKey]` -> `by_bucket["<kind>:<k-bucket>"]` -> `tau_k` (`a + b·ln(max(K,2))`, clamped to `bucket_clamp` default `[0.5, 5.0]`) -> the kind's scalar (`choice` 0.6835, `score` 0.8572 in v0.1) -> 1.0.
2. Noul: `sigmoid(a·logit + b)` with `a = 1/by_header[hk]`, else `noul_platt {a, b}`, else `a = 1/noul` (1.468 in v0.1), `b = 0`.
3. Choice answer: `choice` = argmax of the unrounded p (first wins ties); `confidence = clip01((K·pmax − 1)/(K − 1))`; probabilities rounded to 2 dp (`pyRound`, half-even).
4. Score answer: `score = Σ i·pᵢ`; `confidence = max(0, 1 − Σ pᵢ·|i − mode| / MAD_uniform(K))`.

Tokenizer (`src/model/tokenizer.json`): byte-level BPE, 50,280 vocab entries, 121 added tokens (12 special: `<|padding|>`, `<|endoftext|>`, `[UNK]`, `[CLS]`, `[SEP]`, `[PAD]`, `[MASK]`, `[Q]`, `[O]`, `[L]`, `[T]`, `[F]`; 109 non-special: `|||IP_ADDRESS|||`-style placeholders, `[unusedN]`, space runs of 2–24).

### Extension feature questions (`core/features.js`)

| feature | request | answer -> verdict |
|---|---|---|
| content filter | one `choice` per block (`b<id>`), instruction "What kind of page block is this? Block: \"<text ≤ 220 chars>\"", criteria `BLOCK_KINDS` = `ad`, `sponsored`, `clickbait`, `off_topic` (only when a focus task is set), `normal`; state `{site, page, task}` | `filterResults`: hide when choice ≠ `normal` and p ≥ `minP` 0.6. Presets skip the model: iframe host matches `AD_HOST_RE` (doubleclick, googlesyndication, taboola, outbrain, criteo, …) -> `ad`; a ≤ 24-char leaf label matching `LABEL_RE` (`sponsored`, `promoted`, `advertisement`, `ad`, `ads`, `paid partnership`, `anzeige`, `publicité`) -> `sponsored` |
| focus mode | one `noul` per tab (`t<id>`), "Does this browser tab help with \`task\`? Tab: \"<title ≤ 90>\" (<host>) - <description ≤ 140>", criteria `RELEVANT`; state `{task ≤ 200 chars}` | `focusVerdict`: on-task if p ≥ `FOCUS_MODEL_MIN` 0.04 or `keywordOverlap` > 0 (content words ≥ 4 chars, not in `STOP`, first 6 letters) |
| RAM relevance | same as focus (`Features.relevance`, chunks of 16) | `discardOrder`: relevance (default 0.5) ascending when the gap > 0.15, else `lastAccessed` ascending |

### jevbench v1.1 datasets (`jev_local/bench/registry.py`)

| role | keys (area letter) |
|---|---|
| `TEST` (25, counted; index runs over the 24 built) | A Topic: `ag_news`, `yahoo_topics`, `fin_topic`; B Sentiment: `sst2`, `fin_phrasebank`, `sst5`, `yelp5`; C Emotion: `dair_emotion`, `tweeteval_emotion`, `go_emotions`; D Intent: `banking77`, `clinc150`, `massive`; E Inference: `boolq`, `rte`, `anli`, `paws`, `stsb`; F Fact & safety: `llm_aggrefact` (gated, not built), `climate_fever`, `toxic_chat`, `openai_moderation`; G Multi-question: `typed_decisions`, `unfair_tos`, `helpsteer2` |
| `DEV` (10, clean set `clean-2026-10-03`; selection and calibration only) | `newsgroups20`, `tweeteval_sentiment`, `atis`, `snips`, `mrpc`, `scitail`, `cb`, `tweeteval_offensive`, `scifact`, `tasksource_heldout` (same list as `scripts/dev_to_calib.py` -> `CLEAN_DEV`) |
| `RETIRED_DEV` (5, moved to `public_jev`) | `tweet_topic`, `app_reviews`, `hwu64`, `toxigen`, `prompt_injections` |
| `REF` (area `K`, shown, not counted) | `hellaswag`, `winogrande`, `mmlu_pro`, `bbh` (M0 reports the first three) |

Exclusion categories (`registry.py` -> `exclusion_reason(name, track)`, Z precedence in `_z_reason`; first match wins, in this order): exact ids (`EXCLUDED_DATASET_IDS`), then the rule families `test:<key>`, `dev:<key>`, `sibling:<key>`, `jev_labelled`, then `public_jev:<key>` (hand rules, then the generated hf-id / repo-segment / key-token tables; sources of the 549 published rows), then `reserved:<key>` (external typed-decision suites), then held-out tasksource dev families. On track S, `s_allow_reason` (the S allow-list: train-split targets and their `train_sources`) waives `test`/`sibling`/`public_jev` matches; `jev_labelled`, `reserved`, `S_DENY_RULES` (reported as `s_deny:<rule> (<reason>)`), `dev:tasksource_heldout` and the clean dev sets are never waived (a clean dev set is waived only when that dataset is itself a train-split target).

### benchmax spec registry (19 specs)

`Spec.id` equals `targets.json` `spec_id`. "Headline rows" = `role == "headline"` rows of `targets.json` carrying that `spec_id` (132 of 154 in total).

| spec id | group / module | suite | headline rows |
|---|---|---|---|
| `deusser_exact@6bbdeb33` | A / `adapters_a/deusser.py` -> `DeusserAdapter` | Deußer, Sparrenberg & Sifa 2026 (37 tasks; CI bootstrap 500, seed 0; overflow truncate) | 37 |
| `decision_index_0.2.1@87d4650b` | A / `adapters_a/decision_index.py` -> `DecisionIndexAdapter` | Decision Index 0.2.1 kit (overflow refuse; unrounded p) | 41 |
| `typed_decisions_card@d0e2f0c4` | A / `adapters_a/typed_decisions.py` -> `TypedDecisionsAdapter` | LocalLLaMA/typed-decisions (400 cases; scorer pinned by Prior/Uniform rows) | 1 |
| `jevbench_hf_praveenrajus_v0.1.1` | A / `adapters_a/jevbench_hf.py` -> `JevbenchHfAdapter` | Praveenrajus/jev-bench v0.1.1 (22 configs) | 13 |
| `chepyle_lexglue_systemone_v1` | B / `chepyle_lexglue` | LexGLUE 7 tasks + BANKING77 + CLINC150 | 7 |
| `mbburabak_safety` | B / `mbburabak_safety` (eval-only) | HateCheck, ToxicChat, Aegis v1/v2, WildGuardTest, HarmBench | 7 |
| `dmb_expanded@eabd88b0` | B / `dmb_expanded` | DMB expanded: BANKING77, CLINC150+OOS, NLU++ | 1 |
| `rerank_scripts` | B / `rerank_scripts` | rerank scripts: denser-org (BEIR SciFact/NFCorpus), hev (SciFact/NFCorpus/FiQA), anessbelbati (8 sets + NevIR) | 4 |
| `elcronos_plain` | B / `elcronos` | emotion, TweetTopic, fin topic, DailyDialog | 3 |
| `zhuyansen_batch20` | B / `zhuyansen` (multi-stage) | 20 texts per call: AG News, SST-2, BANKING77, TweetEval emotion, PAWS, arXiv | 2 |
| `thisisandreeeee` | B / `thisisandreeeee` | BANKING77, CLINC150, HWU64, SST-2 noul, STS-B score | 1 |
| `asevlad_injection` | B / `asevlad_injection` (eval-only) | combined prompt-injection corpus (11,900 rows) | 1 |
| `stperic_medhallu` | B / `stperic_medhallu` | MedHallu 1,000 items | 1 |
| `goya_rm_eval` | B / `goya_rm` | RewardBench 1/2, RM-Bench, RubricBench, PPE, ProcessBench, PRMBench | 8 |
| `study:earino_zero_shot_complaint_benchmark_cfpb_113_cl` | B / `study_cfpb` | CFPB complaints, 113 issues | 1 |
| `study:do_system_one_decisions_add_up_arxiv_2609_33971` | B / `study_trec50` | TREC-50 | 1 |
| `study:jev_for_network_traffic_classification_arxiv_261` | B / `study_cesnet` | CESNET-QUICEXT-25 | 1 |
| `study:koa_action_arxiv_2609_36115` | B / `study_amazon_polarity` | SST-2, Amazon Reviews Polarity | 1 |
| `study:jev_ids_arxiv_2610_01079` | B / `study_nslkdd` | NSL-KDD | 1 |

Win rule (`bench/PREREG-benchmax.md` §1): Win iff `ours − jev_score > bar`, with `bar = bar_z` (Z) or `bar_s` (S) from `targets.json`; the bar is √2 x the publisher's CI half-width where one is published (the 37 Deußer rows), else `1.96·√(2p(1−p)/n)`; for `higher_is_better: false` metrics the inequality is reversed. The S bar uses `max(Jev zero-shot, Jev given train data) + margin` where a `s_bar` row exists. Where publishers disagree on Jev's value, the stricter one is used.

## How it works

### 1. Extension boot and model load

1. Panel opens -> `panel.js` loads `settings`, sends `{to:"sw", type:"ensure_brain"}`; `sw.js` -> `ensureBrain` creates `offscreen.html` (reasons `USER_MEDIA`, `WORKERS`).
2. Panel sends `brain init` -> `offscreen.js` -> `init` runs `loadEngine` and (unless `speechEngine === "chrome"` or `preloadSpeech === false`) `loadSpeech` in parallel.
3. `loadEngine`: reads `model/{model.json,tokenizer.json,calibration.json,meta.json}`; `gpuInfo()`; plan list: if `settings.compute !== "wasm"` and WebGPU is available -> `["fp16","webgpu"]` when `shader-f16` else `["q8","webgpu"]`; `["q8","wasm"]` is always the last plan (the only one when `compute === "wasm"` or there is no WebGPU).
4. Per plan: bundled `model/genclass-<v>.onnx` if present (HEAD probe) else download `settings.modelBaseUrl || card.default_base_url` + file via `fetchCached` (Cache `genclass-models-v1`, size check on hits, sha256 check on download, progress to panel).
5. `ort.InferenceSession.create(buf, {executionProviders:[provider], graphOptimizationLevel:"all"})` -> `new Engine(...)` -> two warm-up `evaluate` calls on a realistic request; `B.engineInfo = {variant, provider, threads, loadMs, warmMs}`. First failing plan falls through to the next.
6. `buildController()` wires `Controller` with `observer` (snapshot via `sw observe`, 1200 ms cache), `executor` (`sw execute`, undo stack of 20), `appsFor` (`sites.js` -> `appCatalog`), `ui` and `log` (ring of 2000 entries).

### 2. Spoken (or typed) command -> action

1. Speech source emits `{kind: speech_start|partial|final|speech_end|error, uid, text}`. Local engines (`LocalSpeechSource`): energy VAD (voiced if RMS > max(0.012, noise x 3.5)), 300 ms pre-roll, the whole open utterance is re-transcribed roughly every `stepMs` (a `tick` timer at max(50, stepMs/2) ms decodes once ≥ 0.8·stepMs of new audio has arrived; `cadenceMs` = max(stepMs, last decode ms)); utterance ends after 600 ms of silence or 25 s. Panel text input (`brain text`) streams one partial per word every 230 ms, then a final after 350 ms (`textCommand`).
2. `offscreen.js` -> `onSpeech` sets `controller.cadenceMs` from the local source; `Controller.onEvent` -> `Stream.update(ev, now)` returns the unconsumed tail (or null if frozen/dropped/too short).
3. Final -> immediate `request("final")`; partial -> `debounceRequest` (120 ms, capped at 300 ms since the first pending partial; 0 ms once `cadenceMs` is set). `armSilence` schedules re-decisions at `payload_silence_ms` and `silence_complete_ms` (+15 ms).
4. One decision in flight; newer requests coalesce into one `want` (`drainWants`). `decide` loops `decideOnce` up to `MAX_LOOPS` = 4 times after actions (`post_action`).
5. `decideOnce`: absorb leftover words of the last action (`absorbLeftovers`), skip if the key `[vid, cursor, text, isFinal, silenceBucket, pendingId]` repeats, snapshot, `buildState` + `buildQuestions(..., {browser:true})`, numbered pick shortcut, then `ask()` (staged by default).
6. Stale check: if the stream's `vid`/`cursor` changed during inference -> `stale_dropped`; if only the text grew -> `stale: true` (closed-set commands may still act; payload and silence gates are treated as not met).
7. `rescueTarget`, then `policy.js` -> `evaluatePolicy` (gate order: pending confirm/cancel; `is_command` < 0.5 -> ignore; intent `none`/`wait`/low -> ignore/wait; `complete` < 0.65 unless final or ≥ 900 ms silence -> wait; `type_text`/`search_web` wait for final or ≥ 600 ms silence; `open_url` also waits unless the address is closed by "and/then"; argument gates; stability: on an unsettled partial a closed-set act needs `complete` ≥ 0.85 or the same pick twice).
8. `safety.js` -> `gate(decision, snap, cfg, said)`: deny rules -> `deny`; HIGH risk -> `confirm` if intent p ≥ 0.85 and (for clicks) target p ≥ 0.75 else `clarify`; `destructive` ≥ 0.5 -> `confirm`.
9. `Controller.apply`: `wait`/`ignore` may skip leftover words; `clarify` on "which element"/"not sure enough" offers numbered picks; duplicates are suppressed by the fired-key set `[vid, cursor, n]` and `stream.matches`; `deny` drops the utterance; `confirm` -> `propose` + drop utterance; `act` -> rate limit (3 per 1.0 s) -> consume words -> `execute`.
10. `executor.run` -> `sw.js` -> `execute`: tab-level kinds (`new_tab close_tab go_back go_forward open_url search_web open_app quit_app undo`, `press_key cmd+r`/`cmd+n`) run in the SW; everything else is forwarded to the content script (`content.js` -> `execute`: click, type into focused/best field via `execCommand("insertText")`, key emulation, scroll). Dry run (`settings.dryRun`, default **true**) executes nothing: click/type targets are highlighted, every other kind only returns a "dry run: would …" detail.
11. Page observation (`content.js` -> `observe`, called via `sw.js` -> `observe`, which injects the content script on demand with `ensureContent` and short-circuits restricted URLs to `{restricted: true}`): collects `SELECTOR` matches (links, buttons, inputs, selects, textareas, summaries, ARIA widgets, contenteditable, `[onclick]`); drops invisible/occluded ones, controls nested in an already-collected control, and secure inputs unless focused (their `value` is never sent). Over the `max` cap (default 60) it keeps the highest score: focused +100, each label word (> 2 chars) the speaker used +10, in viewport +1. Elements are sorted by top (8 px tolerance) then left, numbered `e01…`, and repeated `role|label` pairs get " (k of n)". The last 5 snapshots' eid -> node maps are kept for `execute`.
12. Undo (`sw.js` -> `execute`, case `undo`, on the last entry of the brain's undo stack): a tab it opened is closed (`undo.closeTab`); a navigation goes back (`undo.back`); a scroll scrolls the other way by the same amount; typing runs `execCommand("undo")` in the page (`undo_type`); anything else sends `cmd+z`. `open_folder` always fails in the browser. `open_app` switches to a matching tab (`sites.js` -> `appCatalog` resolve) or opens the site URL, reusing an empty/new-tab page; `quit_app` closes the matching tab.
13. Lifecycle: on install `sw.js` sets `openPanelOnActionClick` and opens `welcome.html` (mic permission page; `open_mic_page` reopens it at `#mic`); `chrome.commands` `toggle-listening` -> `ensureBrain` + `brain toggle`, `kill-switch` -> `brain kill {from:"shortcut"}`.

### 3. Confirmation and kill switch

1. `propose` stores `pending`, `pendingMark = [uid, heardWords, now]`, starts an 8 s timer, shows the panel card.
2. A later tail with intent `confirm` passes only if `confirmationAllowed` (different `vid`, not `joined`, same-uid tails must start after the mark and be heard ≥ `CONFIRM_REACTION_S` = 0.8 s after it), `AFFIRM_RE` matches, intent p ≥ 0.8, and the phrase is settled or `complete` ≥ 0.85. Intent `cancel` with p ≥ `CANCEL_TOP_P` (0.5), or a `NEGATE_RE` match while the intent is `cancel`/`confirm`/`none`/`wait`, drops it (`policy.js` -> `pendingDecision`). The panel's Confirm button counts as an explicit yes (`confirmFromUi`).
3. Kill: Esc on a page while listening (trusted event), panel "Stop all", or Alt+Shift+K -> `brain kill` -> `Controller.halt()` (cancels everything, drops pending, skips stream to end) + stop listening + abort a streaming text command. `resume()` on the next start.

### 4. Opt-in features (all off by default)

- **Content filter:** content script `collectBlocks` (≤ 30 blocks, ≥ 120x30 px, ≥ 25 chars unless ad marker, outside nav/header/footer/form) -> `sw filter_blocks` -> `filterRequest` presets: ad-network iframe hosts -> `ad`, small labels like "Sponsored"/"Promoted" -> `sponsored`, known ad selectors -> `ad`; only if `filter.model` is on are the rest sent to the brain (`classifyBlocks`, chunks of 10, hide non-`normal` picks with p ≥ 0.6). Hidden blocks get a "show" link; the badge counts them; per-site toggle `filter.sites[host] = false`. `content.js` -> `runFilter` is debounced (`scheduleFilter`): 600 ms after load when enabled, 1200 ms after scroll, 1500 ms after DOM mutations (`MutationObserver`), 100 ms after `filter_set`; blocks already sent once (`classified`) are not re-sent. Settings changes are pushed by `sw.js` `storage.onChanged` (`setFilterForAll`, `configureAlarms`, `brain focus_config`).
- **Focus mode:** `focusRequest` asks one noul per tab ("Does this browser tab help with `task`?"), chunks of 16; `focusVerdict` = on-task if p ≥ `FOCUS_MODEL_MIN` (0.04) **or** any shared content word (≥ 4 chars, first 6 letters). Off-task tabs are discarded/closed after `graceMin` (default 5 min; `features_rt.js` floors it at 0.25 min, the panel input at 1 min) unless used during the session, opened from an on-task tab, or protected (`protectedTab`: pinned, audible, active, unsaved input, browser pages).
- **RAM manager:** alarm `genclass-ram` every 1 min -> `ramTick` reads `chrome.system.memory`; below `minFreePct` (15%) it discards up to `maxPerRound` (3) idle (> `idleMin` 10 min) unprotected http(s) tabs in `discardOrder` (lowest focus relevance first when relevance differs by > 0.15, default 0.5, then least recently used; relevance is only computed while focus mode is on with a task).

### 5. Model lineage and parity (extension -> runtime)

1. The model is the v1 32M checkpoint `jev-local-fast-0.1.0` (Ettin-32m, 10 layers, hidden 384, layer pattern full, then (sliding, sliding, full) x 3; `meta.json`). Python reference: `jev_local/engine/encoder/{tokenize_pack,engine,calibrate}.py` (see [genclass-model-lineage.md](genclass-model-lineage.md)).
2. `extension/tools/genclass_export.py` (VM, torch) exports `ExportModel` with the block attention mask built in-graph from `q_group`/`i_group`/`position_ids` (sliding layers also need `|pos_q − pos_k| ≤ window` = 64), writes fp32/fp16/q8 ONNX, `parity.json`, `pack_fixtures.json`, `torch_fixtures.json`, `tokenizer.json`, `calibration.json`, `meta.json`.
3. `release-assets/parity.json` (50 requests, 353 choice/score + 150 noul answers): fp32 max |Δlogit| 2.05e-5, 353/353 + 150/150; fp16 0.0177, 353/353 + 150/150; q8 0.365, 352/353 + 150/150. Tokens per request min 1065, median 1274, max 1661. ORT CPU p50 at 8 threads: fp32 126.9 ms, fp16 157.4 ms, q8 136.2 ms (PyTorch banded 152.4 ms); file sizes 134.2 / 67.2 / 56.9 MB. q8 = `MatMulNBits` 8-bit weight-only, block 32, symmetric, fp16 embedding table (`genclass_export.py` -> `make_q8`); export opset default 17.
4. Extension JS (`tokenizer.js`, `packer.js`, `engine.js`) is checked against these fixtures by `test/unit/pack_parity.test.mjs` and `engine_parity.test.mjs`.
5. `packages/runtime/src/model/*.ts` was ported from the extension JS and is tested against the **same** fixtures (`packages/runtime/test/fixtures/model/{pack_fixtures,torch_fixtures}.json` hold the same JSON values as the extension's, re-serialised without whitespace, so `cmp` differs but a parsed comparison is equal; `requests50.json` is the same 50 requests minus the `gold`/`screen_type` keys). Differences in the port: heap-based BPE merges and tokenizer options read from the file (pruned vocabularies work), markers/ids from `meta.json`, graph inputs built from `meta.json` `inputs`, typed errors, default precision `"exact"` (the extension always rounds to 2 dp, `round2`). See [runtime/model-host.md](runtime/model-host.md) and [model-io-contract.md](model-io-contract.md).
6. The runtime's loader still accepts the v0.1 extension card (`bundled`, `default_base_url`, no `files`): `packages/runtime/src/model/loader.ts` -> `parseCard` falls back to `tokenizer.json`/`calibration.json`/`meta.json` without hashes (cache-keyed by `name@version`).

### 6. Building and releasing the extension

1. `npm ci` in `extension/` (own lockfile; not a root workspace).
2. `node scripts/build.mjs`: esbuild bundles `sw.js` (esm), `content.js` (iife), `panel.js`, `welcome.js`, `offscreen.js` (conditions `onnxruntime-web-use-extern-wasm`) for `chrome116`, minified unless `--dev`; rewrites transformers.js' jsDelivr ORT wasm path to `/ort/` and **throws if any `cdn.jsdelivr.net` URL remains** (MV3: no remote code); copies `static/`, sets `manifest.version` from `package.json`, copies `ort-wasm-simd-threaded.asyncify.{mjs,wasm}` into `ort/`, copies `src/model/*` small files; `--bundle-model` also copies `release-assets/genclass-{q8,fp16}.onnx`.
3. `--zip` (also `npm run package`) -> `dist/genclass-<version>.zip` (uses the system `zip`); `--release` implies the zip, verifies each `release-assets/<variant>.onnx` sha256 against `src/model/model.json` (throws on mismatch, warns if missing), writes `dist/release/` (ONNX files, the four model JSONs, the zip, `ASSETS.json` with names/bytes/sha256 plus the Hugging Face speech files fetched at runtime) and `dist/store/` (copy of `store/` + `privacy.html` rendered by the built-in `mdToHtml`). Every build also copies `LICENSE` and `NOTICE` into `dist/genclass/`.
4. Load for development: `chrome://extensions` -> Developer mode -> Load unpacked -> `dist/genclass/`. Screenshots: run the e2e specs (they write raw shots to `dist/store/screenshots/raw/`), then `node scripts/compose_screens.mjs` (Playwright Chromium) composes the 1280x800 store images; `node scripts/make_icons.mjs` regenerates `static/icons/*.png`.
5. Manual publication steps are in `extension/RELEASE.md` (GitHub release `v0.1.0` asset names must match exactly; q8 must be 56,931,453 bytes; Web Store: upload the zip, declare no remote code).

### 7. jevbench v1 pipeline (`scripts/jevbench.py`)

1. `build` (VM): `jev_local/bench/build.py` downloads pinned HF revisions, samples with seed 20261001 (`build.py` -> `sample_items`: `all`, `random`, or `strat` / `strat_by_source` with largest-remainder proportional quotas), renders `templates.py` mappers, writes `bench/jevbench/<role>/<key>__<variant>.jsonl` rows `{id, dataset, variant, item, stratum, request, gold, meta}` and `manifest.json`.
2. `run-ours` (VM): `ours.py` -> `OursRunner.answer` packs with exact chunking (options and questions are attention-isolated, so splitting a request into passes that repeat the state and concatenating raw logits is exact), truncates the longest state field only if the state + one unit cannot fit.
3. `run-jev` (Mac, OpenRouter `https://openrouter.ai/api/alpha/decisions`, model `typesafe/jev-1.13`): ≤ 6 workers, 6 attempts, retries on 408/409/425/429/5xx, aborts on 401/402/403, append-only cache, `--max-cost` 8.0 $.
4. `score` (VM): `metrics.py` aligns probabilities to canonical labels, rounds to 2 dp, failures = wrong/uniform, paired item-clustered stratified bootstrap B = 2000; `report` renders `REPORT.md`.
5. Claim rule (pre-registered): (a) CI lower bound of index(ours) − index(Jev) > 0 for both indices, (b) strictly higher primary metric on ≥ 13 datasets, (c) no area trails by > 10 skill points.
6. File layout (`scripts/jevbench.py` docstring and constants `BENCH`, `RUNS`): requests `bench/jevbench/<role>/<key>__<variant>.jsonl[.gz]` (VM; the Mac copy for `run-jev` is `runs/jevbench/requests/`); results `runs/jevbench/<release>/{jev.jsonl, ours__<name>.jsonl, scores.json, REPORT.md}`. Request files are read variant-major (`main`, `choice`, `shuffle`, `bare`) so the primary pass completes first. None of these are in the repo.

| subcommand | flags (defaults) |
|---|---|
| `build` | `--out bench/jevbench`, `--keys ""`, `--roles test,dev,ref` |
| `run-ours` | `--ckpt` (required), `--release` (required), `--name ""`, `--requests bench/jevbench`, `--roles test,ref`, `--variants main,choice,shuffle,bare`, `--keys`, `--workers 8`, `--threads 2`, `--chunk 64`, `--max-tokens 0` |
| `run-jev` | `--release` (required), `--requests runs/jevbench/requests`, `--roles test`, `--variants main,choice,shuffle,bare`, `--keys`, `--workers 6`, `--attempts 6`, `--limit-per-file 0`, `--max-cost 8.0` |
| `score` | `--release` (required), `--requests bench/jevbench`, `--ours`, `--jev`, `--roles test,ref`, `-B 2000`, `--seed 20261001`, `--out scores.json` |
| `report` | `--release` (required), `--scores scores.json`, `--note` (repeatable release-note bullet) |

### 8. benchmax pipeline

1. `scripts/benchmax_build_targets.py` builds `targets.json` (549 rows) from `jev_published.json` + the feasibility verdict tables, derives the registry's `public_jev` family and writes `exclusions.json`; `--write-registry` rewrites the generated block in `registry.py`; `--check` exits 1 when anything is stale.
2. `PREREG-benchmax.md` freezes the hashes of those files plus the research notes (decision rules: Win only if `ours − jev_score > bar_z|bar_s`; Ahead (n.s.), Tie (< 1 pt), Behind; Z and S scoreboards never merged; no Jev output ever enters training/selection/calibration).
3. `scripts/benchmax.py run --spec <id> (--ckpt | --base-url | --engine heuristic)` loads the spec (`load_specs`), wraps group-B classes with `bridge_b.bridge_class`, builds a client (`runner.build_client`), runs, writes `run.json`, replays the first N requests for W11. Group-B test splits need `--allow-test`; reruns into a complete `--out` need `--rerun-reason`.
4. `scripts/phase3_eval.sh` is the runbook for a finished checkpoint: global calibration on the clean dev set (no `by_header`), then every spec serially on VM `train`.
5. Validation passes before any test read: `scripts/benchmax/stage0_validation.sh` (non-evaluated splits, `summary.tsv`) and `scripts/benchmax/dry_pass_validation.sh` (all 19 specs; DI uses synthetic smoke rows since it has no non-test split); `scripts/benchmax/engine_determinism.py` reports W11 on synthetic requests only.
6. Group-B adapters can also be driven without the shared runner via `python -m jev_local.bench.benchmax.adapters_b.driver prepare|items|run|score|fit|selfcheck --spec <id> --split <split>` (`--engine local|http`, `--ckpt` default `$JEV_LOCAL_FAST_CKPT`, `--url` default `http://127.0.0.1:8765`, `--threads 8`, `--allow-test`, `--no-resume`, `--rebuild-items`); `selfcheck` refuses the test split. Its `run.json` is lighter than `benchmax-run/1`.

`scripts/benchmax.py run` flags (`_common`, `_engine`):

| flag | default | meaning |
|---|---|---|
| `--spec` | required | spec id (`list` prints them) |
| `--out` | `runs/benchmax/<ckpt>/<spec>/` | run directory |
| `--model-id` | `genclass-68m` | W10 wire model id (checked by `check_model_id`) |
| `--threads` | 8 | torch threads for the local engine |
| `--ckpt` / `--base-url` / `--engine local\|http\|heuristic` | local if `--ckpt`, http if `--base-url` | engine client |
| `--wire-model` | — | model id put on the wire for `--base-url` (disclosed) |
| `--calib` | checkpoint's file | W9 calibration override |
| `--max-tokens` | engine limit | context override |
| `--overflow refuse\|truncate` | the spec's rule | W5 |
| `--precision unrounded\|2dp` | `unrounded` | W3 |
| `--refusal-status 400\|422` | 400 | W4 HTTP status of in-process refusals |
| `--determinism N` | 20 | W11: re-send the first N requests at the end |
| `--trace` | off | write every request/response to `<out>/trace.jsonl` |
| `--rerun-reason` | — | required when `<out>/run.json` is already complete (old one kept as `run.<timestamp>.json`) |
| `--track Z\|S` | `Z` | recorded only |
| group-B extras (`bridge_b`) | — | `--split`, `--limit`, `--tasks`, `--work`, `--thresholds`, `--fit`, `--allow-test`, `--skip-prepare`, `--resume` |

### 9. Headline results (what may be quoted, with caveats)

All are documents in the repo; none can be reproduced from the repo alone (the data, models and run directories live on the VMs).

| source | result |
|---|---|
| `results/genclass-vs-jev-computer-use.md` (1,280 examples: 1,000 CU + 300 GEN sampled, seed 7; Jev = `typesafe/jev-1.13` via OpenRouter; ours = `jev-local-fast` v1 32M) | fair rows: intent complete 91.4 % vs 92.0 % (tie, n=336); intent mid-sentence 66.4 % vs **90.4 %** (n=664); target real element **86.6 %** vs 82.4 % (n=119, ±7 pts); text span real payload 75.5 % vs **94.9 %** (n=98); GEN held-out families **94.7 %** vs 80.5 % (n=451). Latency p50/p95: Jev 177/311 ms (incl. network), ours 187/204 ms (Azure EPYC CPU, 4 threads). Jev cost $0.1049 for 2,498,287 input tokens. 20 GEN examples excluded (OpenRouter 400 on object criteria). |
| same file, wire conformance vs 1,280 real Jev responses | choice confidence 6,239/6,244 within 0.02; score confidence 1,053/1,053 within 0.03; score value 1,051/1,053 within 0.02 |
| `BENCHMARKS.md` | public summary of the above plus per-question rows (is_command 82.4 vs 96.1, complete 72.7 vs 93.3, destructive 94.1 vs 99.4, app 96.5 vs 99.0, key 89.4 vs 98.7, URL 81.6 vs 100 (n=49), scroll 59.3 vs 98.1 (n=54)); order robustness (GenClass 0 flips by construction; Jev 10.3 % / 13 % per third-party tests); AG News 0.882 (Jev) vs 0.315 |
| `results/jevbench-m0.md` (release read M0, 2026-10-02) | `jev-local-fast` v1: skill index **10.1** [9.7, 10.7], Decision-Score index **−27.9** [−28.6, −27.1]; 0 option-order flips on 11 choice datasets; noul polarity broken on general yes/no (SST-2 noul 0.491 vs 0.735 as a 2-option choice; BoolQ 0.384). Jev valid only on AG News (0.882) and Yahoo (0.743) after HTTP 402; no claim evaluated. `llm_aggrefact` not built (gated), so indices span 24 datasets. Harness sanity: AG News 0.882 vs Deußer's 0.885 (n=7,600). |
| `results/z68m-dev-notes.md` | Z-68m (clean zero-shot 68m retrain) final step 2010: clean-dev skill 40.2, decision-score 5.6, mean of 7 shared dev sets 0.602 vs v2-68m 0.604 (parity); fitted calibration does not transfer (split-half 0.023 -> 0.029), so ship identity calibration |
| `bench/public/targets.json` `counts` (predictions, not results) | 549 rows, 154 counted (groups A 37, B 41, C 7, E-A 33, E-B 13, G 23). Predicted W/T/L of 154: S-68m 21/31/102, S-150m 29/37/88, S-400m 37/48/69, S-1b 43/55/56; Z-68m 0/14/138 (+2 n/a), Z-1b 2/42/108 (+2 n/a). No benchmax test-split result exists in the repo. |
| `extension/README.md` (not re-measured) | commands eval 16/18; Moonshine first partial 149 ms, RTF 0.08, Whisper base.en 1238 ms, RTF 0.48 (CPU-only Linux VM, WASM x4); decision latency WASM x4: staged pass 1 212 ms p50, full fan-out 713 ms, 251 ms p50 end-to-end; WebGPU not measured |

## Configuration and constants

### Extension

| name | type | value | defined in | effect |
|---|---|---|---|---|
| `DEFAULT_THRESHOLDS.is_command` | number | 0.5 | `core/types.js` | below -> `ignore` |
| `.intent_conf` / `.intent_top_p` | number | 0.45 / 0.55 | `core/types.js` | below -> `wait` |
| `.complete` / `.stable_complete` | number | 0.65 / 0.85 | `core/types.js` | completeness gate / act on a partial without a second agreeing pick |
| `.target_conf` / `.target_top_p` | number | 0.45 / 0.35 | `core/types.js` | click target gates |
| `.span_top_p` / `.app_top_p` / `.key_top_p` / `.folder_top_p` | number | 0.35 / 0.5 / 0.6 / 0.5 | `core/types.js` | argument gates |
| `.destructive` | number | 0.5 | `core/types.js` | ≥ -> confirm |
| `.high_risk_intent_p` / `.high_risk_target_p` | number | 0.85 / 0.75 | `core/types.js` | HIGH risk below these -> clarify |
| `.confirm_p` | number | 0.8 | `core/types.js` | min intent p for a spoken confirm |
| `.silence_complete_ms` / `.payload_silence_ms` | ms | 900 / 600 | `core/types.js` | silence gates (raised for local ASR, below) |
| `.debounce_ms` / `.confirm_timeout_ms` | ms | 120 / 8000 | `core/types.js` | partial debounce; pending expiry |
| `defaultConfig()` | object | `dryRun:true, searchUrl:"https://www.google.com/search?q={q}", allowApps:[], maxElements:60, maxApps:24` | `core/types.js` | controller config |
| `silenceGatesFor(c)` | fn | payload = round(2c + 150), complete = max(payload, 900) | `core/controller.js` | applied when `cadenceMs` is set; also forces `debounce_ms` 0 |
| `MAX_LOOPS` / `MAX_DEBOUNCE_MS` / `SILENCE_MARGIN_MS` | int | 4 / 300 / 15 | `core/controller.js` | re-decide loops; debounce cap; silence timer margin |
| `RATE_MAX` / `RATE_WINDOW_S` | int / s | 3 / 1.0 | `core/controller.js` | executions per window |
| numbered pick window | s / words | 10 / ≤ 5, top 3 | `core/controller.js` -> `numberedPick`, `offerPicks` | badge picks |
| `CONFIRM_REACTION_S` | s | 0.8 | `core/safety.js` | min delay between prompt and "yes" |
| `CANCEL_TOP_P` | number | 0.5 | `core/policy.js` | cancel pending |
| `Stream` echo / dup windows | s | 2.0 / 0.35; closed-uid memory 64 | `core/stream.js` | uid echo inheritance |
| `Packer` options | int | `maxPositions` 1536 (from `meta.max_len`), `maxTotal` 8192, `cacheSize` 8192 | `core/packer.js`, `core/engine.js` | `max_tokens_exceeded` |
| `MAX_ARRAY_SEGMENTS` | int | 64 | `core/serialize.js` | array state segments |
| `K_BUCKETS` / `BUCKET_CLAMP` | consts | `[[2,2],[3,5],[6,10],[11,30],[31,100],[101,255]]` / `[0.5, 5.0]` | `core/engine.js` | calibration lookup |
| `calibration.json` | temps | noul 1.468, choice 0.6835, score 0.8572, 11 `by_header` entries | `src/model/calibration.json` | answer calibration |
| `meta.json` | model meta | `max_len` 1536, `window` 64, `hidden_size` 384, markers `[Q]` 50368 … `[F]` 50372, cls 50281, sep 50282, pad 50283 | `src/model/meta.json` | packer/engine |
| model variants | card | fp16 67,154,907 B (webgpu, needs shader-f16); q8 56,931,453 B (wasm); base `https://github.com/MeharPro/GenClass/releases/download/v0.1.0/` | `src/model/model.json` | download + sha256 |
| `CACHE` | string | `genclass-models-v1` | `offscreen/offscreen.js` | model cache name |
| ORT threads | int | `min(4, hardwareConcurrency)` if `crossOriginIsolated` else 1 | `offscreen/offscreen.js` | WASM speed |
| snapshot cache | ms | 1200 | `offscreen/offscreen.js` -> `observer` | observe calls |
| `SPEECH_ENGINES` | table | moonshine stepMs 250 (WebGPU 154 MB / WASM 63 MB); whisper-base 500 (206 / 77 MB); whisper-turbo 900, WebGPU only (q4 759 MB / q4f16 564 MB); chrome (cloud) | `offscreen/speech.js` | speech choice |
| `LocalSpeechSource` | opts | `endSilenceMs` 600, `maxUtteranceS` 25, `preRollMs` 300, noise init 0.004, threshold max(0.012, 3.5 x noise) | `offscreen/speech.js` | VAD |
| panel `DEFAULTS` | object | `speechEngine "moonshine", dryRun true, compute "auto", searchUrl "https://www.google.com/search?q={q}", maxElements 60 (clamped 10–100), staged true, modelBaseUrl "", lang "en-US"` | `sidepanel/panel.js` | settings |
| brain-only settings | keys | `targetTabId` (act on a fixed tab instead of the active one; set by e2e), `preloadSpeech` (`false` skips speech load in `init`) | `offscreen/offscreen.js` | not in the panel UI |
| `DEFAULT_FEATURES` | object | filter `{enabled:false, hide:{ad:true, sponsored:true, clickbait:false, off_topic:false}, sites:{}, model:false}`; focus `{enabled:false, task:"", action:"discard", graceMin:5}`; ram `{enabled:false, minFreePct:15, idleMin:10, maxPerRound:3}` | `background/sw.js` (copy in `panel.js` `FEAT_DEFAULTS`) | features |
| RAM alarm | string / min | `genclass-ram`, `periodInMinutes` 1 | `background/sw.js` -> `configureAlarms` | created only while `ram.enabled` |
| `Engine` defaults | ctor | `provider "wasm"`, `variant "int8"` (name `genclass-<variant>`; the brain always passes `q8`/`fp16`), packer `maxPositions = meta.max_len` | `core/engine.js` | `model` field of answers |
| `textCommand` pacing | ms | `wordMs` 230, `finalAfterMs` 350 | `offscreen/offscreen.js` | typed commands streamed as partials |
| undo stack / brain log | entries | 20 / 2000 (spliced by 500) | `offscreen/offscreen.js` | `executor`, `brain log` |
| e2e/test env vars | env | `GENCLASS_EXT` (unpacked dir, default `dist/genclass`), `HEADED` (headed Chromium), `SWIFTSHADER` (software WebGPU flags), `GENCLASS_COMPUTE` (default `auto`), `ENGINES` (speech bench, default `moonshine,whisper-base,whisper-turbo`), `CMD` (`\|`-separated, default `click the laptops link`), `LIVE`, `LIVE_AFTER` (debug spec); unit: `GENCLASS_VARIANTS` (default `q8`), `GENCLASS_THREADS` (default 1) | `test/e2e/*.mjs`, `test/unit/engine_parity.test.mjs` | test behaviour |
| `FOCUS_MODEL_MIN` / filter `minP` | number | 0.04 / 0.6 | `core/features.js` | focus and filter verdicts |
| `MAX_LABEL` / snapshots kept | int | 60 chars / last 5 | `content/content.js` | observation |
| scroll amounts | px | level 0 = 160; 1 = 0.85 x viewport; 2 = full height | `content/content.js` -> `scroll` | `scroll_*` |
| `RESTRICTED_RE`, `DENY_SITE_RE` | regex | chrome/extension/devtools/about/file/data/javascript schemes, Web Store; banks, payments, crypto, password managers, Google/Apple/Microsoft account pages | `background/sw.js` | never act inside |

### Benchmarks

| name | type | value | defined in | effect |
|---|---|---|---|---|
| `SEED` | int | 20261001 | `jev_local/bench/registry.py` | every sample/shuffle/bootstrap |
| `REGISTRY_VERSION` / `DEV_SET_VERSION` | string | `jevbench-v1.1` / `clean-2026-10-03` | `registry.py` | manifest identity |
| `TEMPLATE_VERSION` | string | `jevbench-v1-t1` | `templates.py` | request rendering |
| `DEUSSER_COMMIT` / `BTZSC_REVISION` | sha | `6bbdeb33…` / `fef2a2ac…` | `templates.py` | label-text sources |
| `DEV_PER_FAMILY` | int | 200 | `build.py` | held-out tasksource rows per family |
| `NLL_FLOOR` / `SUM_TOL` | float | 0.005 / 0.02 | `metrics.py` | scoring |
| bootstrap B | int | 2000 | `scripts/jevbench.py score -B` | CIs |
| `run-jev` limits | — | workers 6, attempts 6, `--max-cost` 8.0 | `scripts/jevbench.py` | Jev spend |
| `KBUCKETS` | tuple | `(2,2),(3,5),(6,10),(11,30),(31,100),(101,255)` | `baselines.py` | baseline refit buckets |
| `MAX_CHOICE_OPTIONS` | int | 255 | `benchmax/runner.py` | option cap refusal |
| `MODEL_ID_RE` | regex | `^(?:genclass\|meharsjev)-[a-z0-9][A-Za-z0-9._-]*$` | `benchmax/runner.py` | W10 |
| `PRECISIONS` / `OVERFLOWS` | tuple | `unrounded, 2dp` / `refuse, truncate` | `benchmax/runner.py` | W3 / W5 |
| `DEFAULT_WORK` | path | `$BENCHMAX_WORK` or `~/bench_work` (group B: `~/bench_work_b`) | `runner.py`, `adapters_b/common.py` | harness checkouts |
| `MODEL_ID` (group B) | string | `$BENCHMAX_MODEL` or `genclass-68m` | `adapters_b/common.py` | wire model id |
| `RUN_SCHEMA` / `TARGETS_PATH` | string / path | `benchmax-run/1` / `<repo>/bench/public/targets.json` | `benchmax/runner.py` | `run.json` schema; adapters read targets at run time |
| `RETRY_HTTP` | tuple | `408 409 425 429 500 502 503 504 520 522 524 529` | `benchmax/runner.py` (same list as `scripts/jevbench.py` `RETRY_STATUS`) | retried HTTP statuses |
| `CAPACITY_MARKERS` | tuple | `options per choice`, `a choice needs at least two options`, `a score takes 2 to 10 levels`, `the canvas holds`, `maximum context length`, … | `benchmax/runner.py` | W4 refusal texts the publishers' harnesses recognise as `unsupported` |
| other benchmax env vars | env | `BENCHMAX_REPOS` (default `<work>/repos`), `BENCHMAX_HF_HOME` (default `<work>/hf`), `BENCHMAX_API_KEY` (bearer for `HttpClient`), `JEV_LOCAL_API_KEY` / `JEV_LOCAL_FAST_CKPT` (group-B driver), `BENCHMAX_DMB_INSTRUCTIONS`, `BENCHMAX_HARMBENCH_COMMIT`, `HF_TOKEN` / `JSB_HF_TOKEN` (gated safety sets); `JEV_CACHE_DB` is **set** by the Deußer adapter for the upstream code | `benchmax/**` | — |
| jevbench Jev endpoint | consts | `URL https://openrouter.ai/api/alpha/decisions`, `MODEL typesafe/jev-1.13`, `KEY_PATH ~/.jev-local/secrets/openrouter.key`, `ACCOUNT_STATUS (401, 402, 403)` abort the run (retried on the next run) | `scripts/jevbench.py` | **$** |
| `TASKSOURCE_JEV` / `_REV` | string | `tasksource/tasksource-jev-typed-decisions` @ `8173a06c…` | `jev_local/bench/build.py` | held-out dev family source |
| `SEP` | string | `"\x1f"` (`<qid>\x1f<chunk>` sub-block ids) | `jev_local/bench/ours.py` | exact chunking |
| baseline adapters | — | only `SystemOneHTTP` works; `GLiNER2Adapter`, `NLIZeroShotAdapter`, `QwenRerankerAdapter` are stubs | `jev_local/bench/baselines.py` | open-baseline comparisons |

## Invariants and gotchas

- **Catalog strings are model input.** `catalog.js` `INTENTS`, `KEYS`, `FOLDERS`, `SCROLL_LEVELS`, `questions.js` `INSTR` and criteria texts are what the model was trained on; editing a word changes predictions. `BROWSER_EXTRA_INTENTS` (`go_forward`) is appended rather than trained; it is safe only because options are scored in isolation (it changes the softmax total, not other options' logits).
- **Python parity is the contract for `src/core`.** `spans.js`, `questions.js`, `state.js`, `policy.js`, `safety.js`, `stream.js` must reproduce `jev_local/harness/*` exactly, including reason strings (asserted for 700 synthetic policy cases). Python-semantics helpers: `pyutil.js` (`pyRound` half-even, `split`/`split1` = `str.split`, `strip`/`rstrip`, `isAlnum`, `clip01`) and `serialize.js` (`pyRepr` = `repr`, `pyJson` = `json.dumps(ensure_ascii=False, separators=(", ", ": "))`). Choice criteria must be `Map`s: plain objects reorder integer-like labels.
- **Staged evaluation is exact only because of the block mask.** If a future model shares attention across questions, stage 1 + stage 2 answers would differ from a single pass.
- **Special tokens are never matched in text** (`tokenizer.js`): a user saying "[Q]" cannot forge a marker; non-special added tokens (space runs of 2–24, `|||EMAIL_ADDRESS|||`) are split out leftmost-longest.
- **Positions restart per question branch**, so `max_len` (1536) bounds state + longest branch, not the whole sequence; total length is bounded by `maxTotal` (8192). The model card's "128-token local window" is `window` = 64 on each side.
- **One inference at a time per session** (`Engine.busy` chain). The comment in `features_rt.js` ("voice always wins") is not enforced: feature requests and voice requests share the engine FIFO.
- **v0.1 q8 on WebGPU:** the q8 export keeps an fp16 embedding table, which per `packages/runtime/src/model/README.md` needs `shader-f16` on onnxruntime's WebGPU provider; the extension card does not declare `needs` for q8, so on an adapter without `shader-f16` the extension tries `webgpu+q8`, fails at warm-up, and falls back to `wasm+q8`.
- **MV3 rules:** no remotely hosted code (build guard on jsDelivr URLs); COEP `require-corp` means every fetched model/asset needs CORP/CORS-compatible headers (the e2e server sets `cross-origin-resource-policy: cross-origin`).
- **Safety layers are deterministic first:** never type/paste into secure fields (`SECURE_FIELD_RE`, `autocomplete` password/cc/OTP), never act on restricted or denied sites, `close_tab`/`quit_app` always HIGH, submit buttons and Return in non-search forms HIGH. Do not move a check behind a model probability.
- **Words are consumed once.** Any change to `consumedFor`, `Stream.consume` or the fired-key set can make an action run twice or swallow the next command.
- **Fixture regeneration:** `pack_fixtures.json`/`torch_fixtures.json` come from an exporter run (`extension/tools/genclass_export.py` or the older `scripts/genclass_export.py`, whose fixture-writing code is identical; which one produced the committed files is not recorded) (torch, VM); the `*_py.json` fixtures from `extension/scripts/make_py_fixtures.py` (torch-free; it also reads `tests/fixtures/harness_cases.json` and `requests50.json`). Do not hand-edit them.
- **Cache names differ:** extension `genclass-models-v1`, runtime `genclass-runtime-v1`. They never share entries.
- **Mac safety:** `scripts/vm.sh` excludes `/extension/` from its rsync, so the standard runtime VM path cannot build or test the extension; there is no script for it, and CI does not build or test it either (see Drift item 4). Running the extension's `npm ci`/`npm test`/e2e anywhere needs the user's OK.
- **`vm.sh` mirrors with `rsync --delete`.** Anything you create only on the VM in `~/gcl/<SLOT>` (outside the excluded paths) is deleted on the next `sync`/`run`; that is why `demos/` keeps model directories outside the synced tree.
- **`azvm.sh` has no timeout.** Unlike `vm.sh`, it never reads `TIMEOUT`; the `TIMEOUT=… "$JEV/scripts/azvm.sh" …` prefixes in `training/{deliver_final,import_sim}.sh` and the `TIMEOUT=300 scripts/launch_run.sh …` prefixes in `training/{launch_s2,launch_final1,launch_student,launch_t150,launch_r68}.sh` have no effect (`launch_run.sh` reads no `TIMEOUT` either; `training/node.sh`, default 900 s, and `vm.sh`, default 1800 s, do honour it). A hung ssh blocks until the connection drops (`ServerAliveInterval=30`, `ServerAliveCountMax=6`).
- **`azvm.sh --sync` copies only `jev_local scripts tests pyproject.toml`** to `~/jev/`. The benchmax adapters read `bench/public/targets.json` at run time (`runner.py` -> `TARGETS_PATH`, used by `deusser.py`, `jevbench_hf.py`, `bridge_b.py`), so the VM needs that file from some other copy (how it got there is unverified).
- **Extension state lives in the offscreen document.** The undo stack (`B.undo`, max 20), the decision log and the loaded engine are module state in `offscreen.js`; if Chrome closes the offscreen document they are gone and `ensure_brain` recreates a fresh one. Only settings, `parked`, `ramFreed` and `ramStatus` persist in `chrome.storage.local`.
- **The model is not a general classifier.** `MODEL_CARD.md` and `test/eval/features_eval_q8.json` (4/18 exact) show zero-shot ad/clickbait classification near chance; that is why `filter.model` is off by default and deterministic markers decide ads. Focus mode leans on keyword overlap and session use for the same reason.
- **Jev hygiene:** Jev outputs are evaluation-only (never train, select, calibrate, filter); Jev is never run on dev; raw Jev outputs are not republished; Deußer's Zenodo `responses.db` (per-item Jev outputs) is never downloaded or used (the Deußer adapter's own `cache/responses.<model_id>.db`, set through `JEV_CACHE_DB`, holds our answers only).
- **Money:** `jevbench.py run-jev` and `compare_jev.py` call OpenRouter (paid). The benchmax PLAN sets a $5 lifetime cap on Jev; M0 already used $0.217 lifetime per `results/jevbench-m0.md`. Azure scripts marked $ create or run billed VMs.
- **Test splits are read once per release.** benchmax: group-B `--allow-test`, `--rerun-reason`; adapters are debugged on validation/dev/train items only.
- **Pre-registration hashes:** editing any frozen file (`targets.json`, `jev_published.json`, `exclusions.json`, `registry.py`, `benchmax_build_targets.py`, and four of the five `docs/benchmax-research/*.md` notes: `PLAN.md`, `suite-reproduction-specs.md`, `feasibility-targets.md`, `train-data-and-supervised-ceilings.md`; `jev-published.md` is not in the frozen table) invalidates the benchmax freeze; jevbench registered code hashes for `registry.py`, `templates.py`, `build.py`, `metrics.py`, `scripts/jevbench.py` already differ (only `ours.py` still matches), so a new jevbench read needs a new pre-registration or a release note re-scoring earlier reads.
- **Model ids:** never `jev-*` or `typesafe/*` for our runs (`check_model_id`).

## How to change it safely

1. **Change harness logic in the extension (`policy`, `safety`, `spans`, `stream`, `questions`, `state`).** Change `jev_local/harness/*.py` the same way first (the Python is the reference), regenerate `extension/test/fixtures/*_py.json` with `extension/scripts/make_py_fixtures.py` (fix its `ROOT`/`OUT` paths first, see Drift), then run `npm test` in `extension/` on the VM. Browser-only rules (things guarded by `snap.browser`) need no Python change but must not alter Mac-harness verdicts (the parity fixtures have no `browser` flag).
2. **Add a browser-only intent.** Add it to `catalog.js` `BROWSER_EXTRA_INTENTS`, `types.js` `Kind`, `spans.js` `NO_ARG_INTENTS` (if argument-free), `controller.js` `LEFTOVER_WORDS`, `safety.js` `IN_APP_KINDS`/risk sets as appropriate, `policy.js` `ARG_QUESTIONS` (if it reads an argument), and an executor branch in `sw.js` -> `execute` or `content.js` -> `execute`. Add an eval row to `test/eval/commands_eval.mjs`.
3. **Ship a new model in the extension.** Export on the VM with `tools/genclass_export.py --ckpt … --requests test/fixtures/requests50.json --out …`; copy `tokenizer/calibration/meta.json` into `src/model/` and `release-assets/`; update `src/model/model.json` bytes/sha256 (and `needs` if any fp16 tensor remains); copy `pack_fixtures.json`/`torch_fixtures.json` into `test/fixtures/`; run `GENCLASS_VARIANTS=q8,fp16 npm test`; then `node scripts/build.mjs --release` (it re-verifies sha256).
4. **Fix an engine/packer/tokenizer bug.** The runtime copy (`packages/runtime/src/model/`) is the maintained one; fix it there with its tests ([runtime/model-host.md](runtime/model-host.md)). Port to the extension only if the extension is still being released, and re-run `pack_parity` + `engine_parity`.
5. **Build and test the extension.** Only with the user's OK; historically on the VM (never the colleague's 8 GB Mac): get `extension/` onto the VM yourself (not covered by `scripts/vm.sh`), `npm ci`, `npm test` (unit; ONNX-dependent tests skip without `release-assets/genclass-*.onnx`), put `genclass-q8.onnx` (and `-fp16.onnx` for WebGPU) into `release-assets/` (from the v0.1.0 GitHub release, or `packages/runtime/bin/genclass-runtime.mjs fetch-model <dir> --from https://github.com/MeharPro/GenClass/releases/download/v0.1.0/` and copy the `.onnx` files over), `npm run build`, `npm run test:e2e` (Playwright Chromium with the unpacked extension; `SWIFTSHADER=1` for software WebGPU; `speech.spec.mjs` needs network to Hugging Face).
6. **Add a benchmax spec.** Use the exact `spec_id` string from `targets.json`; group A: a class with `add_arguments`/`verify`/`run` (subclass of `runner.py` -> `Adapter`, with `default_overflow`/`allow_truncate`) registered in `specs_a.py`; group B: a module `adapters_b/<suite>.py` with `SPEC_ID`, `TARGETS` and a class `Adapter(AdapterB)` implementing `prepare(split)`, `items(split, limit, tasks)`, `score(...)` and optionally `fit(...)`, registered in `specs_b.py` -> `SPECS_B` as `"<module>:Adapter"` (bridged automatically because `bridge_b.is_group_b_class` sees `prepare/items/score` and no `verify/run/add_arguments`). Pin every upstream commit/revision and sha256. Add pure-Python tests (`tests/test_bm_adapters_*.py`), then `scripts/benchmax.py verify --spec <id>` and a validation-split `run` on the VM.
7. **Update targets or the published-Jev list.** Edit `bench/public/jev_published.json`, run `scripts/benchmax_build_targets.py --write-registry` then `--check` (fix the feasibility-note path first), run `tests/test_bench_registry.py`; this changes frozen hashes, so write a new freeze before any test read.
8. **Score a new checkpoint on jevbench.** `scripts/jevbench.py run-ours --ckpt … --release <r>` then `score` and `report` on the VM; do not run `run-jev` without the user's OK (cost) and a funded key.
9. **Re-measure the extension's model-backed behaviour.** On the VM with `release-assets/genclass-q8.onnx` present: `node test/eval/commands_eval.mjs`, `node test/eval/features_eval.mjs`, `node test/eval/focus_heldout.mjs` (each rewrites its JSON: `commands_eval.json`, `features_eval_<variant>.json`, `focus_heldout.json`). If a threshold such as `FOCUS_MODEL_MIN` or filter `minP` changes, update the eval JSON and the README numbers together.
10. **Touch an ops script.** Keep `vm.sh`'s rsync exclusions (`/extension/`, `/models/`, `/runs/`, `/data/`, `/sim/out/`, `.cache-model/`) and `--delete` semantics in mind: every workstream depends on them. Do not change `launch_run.sh`'s argument order (`RUN MASTER NPROC THREADS "nodes" -- args`): `training/{launch_s2,launch_final1,launch_student,launch_t150,launch_r68}.sh` call it positionally. Keep `vm.sh`'s slot layout too: `realapps/README.md` uses slot `real` and keeps its outputs in `~/gcl/real-out` outside the synced tree. Anything that calls `az vm create/start` or OpenRouter needs the user's go-ahead.

## Tests

| test file | what it asserts | needs |
|---|---|---|
| `extension/test/unit/pack_parity.test.mjs` | JS tokenizer + `Packer` reproduce Python `Packer` ids, positions, `q_group`, `i_group`, `n_state`, question order, marker positions on 50 requests (> 50k tokens); "[Q]" in text is not the marker; space-run and `EMAIL_ADDRESS` (pipe-delimited) added tokens; non-ASCII encodes | `release-assets/tokenizer.json` (committed) |
| `extension/test/unit/engine_parity.test.mjs` | `headerKey` = Python `sha1[:12]`; JS calibration of PyTorch logits = PyTorch probs (< 1e-9); per variant (`GENCLASS_VARIANTS`, default `q8`): ONNX via onnxruntime-web WASM vs PyTorch (fp32 max logit < 1e-3; fp16/q8 decision agreement ≥ 0.99) | ONNX tests skip without `release-assets/genclass-<v>.onnx` |
| `extension/test/unit/harness_parity.test.mjs` | spans (> 100 fixtures), questions + state + `rankApps`, policy + gate on exactly 700 synthetic responses (verdict, reason, retry, action, pick, gate verdict/reason/risk), stream records | `*_py.json` fixtures |
| `extension/test/unit/controller_model.test.mjs` | real q8 model, streamed text: scroll fires once before the last word then search runs once with a verbatim span; "click buy now" waits for a later "confirm"; side talk ignored; "no cancel that" drops pending | `genclass-q8.onnx` (skips otherwise) |
| `extension/test/unit/rescue.test.mjs` | `rescueTarget`: verbatim label rescues `none`; confident answer kept; ordinal among "(k of n)" duplicates and longest label wins; ambiguous duplicates not guessed; only for `click` | — |
| `extension/test/e2e/voice.spec.mjs` | unpacked extension in Chromium on the local shop page: model loads from `modelBaseUrl` and is cached; dry run does nothing; live click/type/scroll and mid-sentence chain `[click, scroll_down]`; risky click waits for confirm, cancel drops; never types into password field; kill switch; never acts on `chrome://` | built `dist/genclass`, `release-assets/*.onnx` |
| `extension/test/e2e/features.spec.mjs` | content filter hides 2 marked ads, badge "2", per-site off restores; focus mode closes the off-task recipes tab after 0.25 min and restores it; RAM manager preview never picks pinned/active tabs | same |
| `extension/test/e2e/speech.spec.mjs` | speech benchmark on `scroll.wav` (Moonshine final contains "scroll down"); `click.wav` through Moonshine clicks the laptops link | network (Hugging Face) |
| `extension/test/e2e/{webgpu,wasm_bench}.spec.mjs` | `bench_model` latency on 8 requests per provider + one click executes (titles over-claim, see Drift) | same |
| `extension/test/e2e/debug.spec.mjs` | dev helper: run `CMD` commands and print the brain log | — |
| `extension/test/eval/commands_eval.mjs` (+ `.json`) | 18 everyday commands with the shipped q8: **16/18** (misses: "open github" -> wait; "click the first result") | model |
| `extension/test/eval/features_eval.mjs` (+ `features_eval_q8.json`) | zero-shot filter: 4/18 exact, 11/18 hide-vs-keep; focus: 8/14 at 0.5, AUC 0.938 | model |
| `extension/test/eval/focus_heldout.mjs` (+ `.json`) | `focusVerdict` on 36 held-out tabs / 3 tasks: on-task kept 11/17, off-task flagged 18/19, model-only at 0.04: 22/36 | model |
| `extension/test/eval/phrasing_probe.mjs` | dev tool: alternative feature-question phrasings | model |
| `packages/runtime/test/model/*.test.ts` | the runtime port against the same pack/torch fixtures (see [runtime/build-test-release.md](runtime/build-test-release.md)) | `GENCLASS_MODEL_DIR` for model-file tests |
| `tests/test_bench_registry.py` (15) | registry v1.1 invariants, clean dev set, stage-1 exclusion on Z and S, generated `public_jev` family vs `targets.json`, manifest | pure Python |
| `tests/test_bench_templates.py` (9), `test_bench_build_dev_v11.py` (8) | mappers produce valid string-only requests; variants; ATIS/SciFact dev mappers | pure Python |
| `tests/test_bench_metrics.py` (6), `test_bench_cli.py` (2), `test_bench_baselines.py` (3) | scorer primitives, failures, indices, bootstrap; jevbench cache semantics and file order; baseline option mapping | numpy |
| `tests/test_bench_ours.py` (4) | `OursRunner` equals `FastEngine.evaluate`; chunking exact | weights, VM |
| `tests/test_bm_engine.py` (34), `test_bm_engine_vm.py` (10) | W1–W11 on stub/heuristic engines; on the real v2 checkpoint | VM for `_vm` |
| `tests/test_bm_adapters_a_runner.py` (22), `_a_suites.py` (14), `_a_typed_decisions.py` (9), `_b.py` (19), `_b_goya.py` (3), `test_bm_integrate.py` (9) | runner plumbing, group-A adapters, typed-decisions scorer pinning, group-B adapters, bridge + CLI for every spec, `run.json` fields | pure Python |
| `tests/test_data_bm_eval_suites.py` (13), `test_data_bm_z.py` (6) | benchmax eval-suite fetch and Z mixture accounting | import `jev_local.data`, which is not in this repo |
| `tests/test_overnight.py` (7) | `scripts/overnight.py` gate logic against the 2026-09-27 crash readings | pure Python (loads the script by path) |
| `tests/test_mlx_scorer.py` (24) | the MLX decoder engine; borrows prompt helpers from `scripts/bench_decoder.py` | mlx tiers need Apple Silicon; real-model tier marked `model`/`slow` |

Run commands: extension unit tests `npm test` = `node --test --test-concurrency=1 test/unit/*.test.mjs`; e2e `npm run test:e2e` = `playwright test --config test/e2e/playwright.config.mjs` (needs `npm run build` first); Python tests with `pytest tests/test_bench_*.py tests/test_bm_*.py` (on the VM per the contract; the counts above are `def test_` occurrences).

## Drift and open issues

1. `docs/runtime/CONTRACT.md` §10 cites the extension engine at `extension/genclass/src/core/{engine,packer,tokenizer,serialize,pyutil,runtime}.js` "in the parent jev repo" (read-only reference `/Users/meharkhanna/jev/extension/genclass/src/`) and the card at `extension/genclass/src/model/model.json`. In this repo the path is `extension/src/core/` and there is no `runtime.js`.
2. `extension/package.json` says `"license": "MIT"`; `extension/README.md`, `LICENSE`, `NOTICE` and the store listing say Apache-2.0.
3. `extension/scripts/make_py_fixtures.py` assumes the old `extension/genclass/` layout: `ROOT = parents[3]` resolves to the directory above the repo and `OUT` is `extension/genclass/test/fixtures`. `extension/tools/genclass_export.py` usage text and `RELEASE.md` ("push the contents of `extension/genclass/`") have the same stale path.
4. `scripts/vm.sh` excludes `/extension/` from its rsync, while `extension/README.md` documents `npm ci` / `npm test` / `npm run test:e2e` and the runtime contract forbids running them on the Mac. There is no supported way to build or test the extension. The new CI workflow (`.github/workflows/ci.yml`, job `runtime`) does not fill the gap: it runs only typecheck, build and unit tests of `@genclass/runtime`; `extension/` is not an npm workspace (root `package.json` workspaces are `packages/*`, `sim`, `demos`) and no Python test runs in CI.
5. `extension/README.md` lists q8 for "WASM, and WebGPU without f16". The runtime's WebGPU notes (`packages/runtime/src/model/README.md`) found that the v0.1 q8 needs `shader-f16` on WebGPU; `src/model/model.json` declares no `needs` for q8.
6. `extension/README.md` says a closed-set command acts "as soon as the model says the command is complete and two partials agree". The code (`policy.js` -> `evaluatePolicy`) acts on a partial when `complete` ≥ 0.65 and (`complete` ≥ 0.85 **or** the same pick twice), or once the phrase is settled. For local ASR the 600 ms payload gate is raised to `round(2 x cadence + 150)` ms (`controller.js` -> `silenceGatesFor`), where cadence = max(`stepMs`, last decode ms), so at least 650 ms for Moonshine (`stepMs` 250).
7. `features_rt.js` -> `Features.run` says "voice always wins"; nothing gives voice priority over feature requests on the shared engine queue.
8. `test/e2e/webgpu.spec.mjs` is titled "agrees with the WASM run and parity fixtures" and `wasm_bench.spec.mjs` "with the WASM run and parity fixtures". Neither compares answers: they record `bench_model` latency and check that one click executes.
9. `extension/README.md` says `release-assets/` model files are "not committed"; the JSON files (`tokenizer`, `calibration`, `meta`, `parity`) are committed and only `*.onnx` is ignored.
10. `scripts/genclass_export.py` is an older export (dynamic int8 `genclass-int8.onnx`). The shipped model and `extension/tools/genclass_export.py` use q8 (MatMulNBits, block 32, fp16 embeddings). The `extension/tools/genclass_export.py` -> `make_q8` docstring explains why: dynamic int8 lost 7% argmax agreement (activation outliers); q8 keeps 99.8%.
11. `bench/PREREG-benchmax.md` cites `bench/public/PREREG.sha256`, which is missing, and `docs/research/benchmax/*.md`, which is now `docs/benchmax-research/*.md`. The frozen sha256 of every moved file still matches (checked with `shasum`): `targets.json`, `jev_published.json`, `exclusions.json`, `registry.py`, PLAN, specs, feasibility, train-data, `benchmax_build_targets.py`.
12. `scripts/benchmax_build_targets.py` reads `FEAS = docs/research/benchmax/feasibility-targets.md`, which does not exist here; the script opens it unconditionally, so regeneration (and `--check`) would fail with a missing-file error (from the code; unverified). Its docstring says "131 counted benchmarks"; `targets.json` `counts.counted` is 154.
13. `bench/PREREG-jevbench.md`, `results/jevbench-m0.md`, the `metrics.py` docstring and `scripts/jevbench.py` -> `_prereg_check` expect `bench/jevbench/PREREG.md`. The file is now `bench/PREREG-jevbench.md` (hash unchanged), so `_prereg_check` would report "No PREREG.md found." The `bench/jevbench/` request files, manifest and `runs/` are not in the repo; they live on the VM.
14. jevbench §11 registered hashes: `registry.py`, `templates.py`, `build.py`, `metrics.py` and `scripts/jevbench.py` now differ from the registered values; only `ours.py` matches. The M0 release notes cover only `metrics.py` and `scripts/jevbench.py`. The `registry.py` change is the v1.1 clean-dev-set + `public_jev` change (its `REGISTRY_VERSION` comment says so); that the `templates.py`/`build.py` changes are only the new dev mappers is likely but unverified hunk by hunk.
15. Model id naming: `PREREG-benchmax.md` and `docs/benchmax-research` say `meharsjev-<size>`. `runner.py` -> `MODEL_ID_RE` accepts `genclass-` or `meharsjev-`, and `scripts/benchmax.py` and `adapters_b/common.py` default to `genclass-68m`.
16. `scripts/launch_z68m.sh` needs `bench/public/mix_z_run.json`, which is not in the repo.
17. `jev_local/data/` is absent, but `tests/test_data_bm_eval_suites.py` and `tests/test_data_bm_z.py` import it and `registry.py` mentions `jev_local.data.v2.decontam`. Those tests cannot import here.
18. `BENCHMARKS.md` points to "`runs/compare/report.md` in the development repo", which is not here. It also promises that in-browser WebGPU latency "will be published with the first extension release". The extension README says WebGPU is not measured (no GPU in CI). Still open.
19. jevbench M0 is incomplete. OpenRouter returned 402 after 4,420 Jev responses, so Jev is valid only on AG News and Yahoo, and no claim was evaluated. Finishing it needs about $4.50 of credit, which is a user action (`results/jevbench-m0.md`).
20. The benchmax freeze is DRAFT and its hash is unpublished (user decision). No test-split scoreboard exists in the repo. 132 of the 154 headline rows have a registered spec; 22 rows (16 `study:*` spec ids) have no adapter. Z-68m trained and converged at v2's dev level. Its calibration does not transfer, so it ships with identity calibration (`results/z68m-dev-notes.md`).
21. `training/{deliver_final,import_sim,import_final,node}.sh` set `JEV="$(cd "$HERE/../.." && pwd)"` with `HERE` = `training/`, i.e. the directory **above** this repo (the parent-repo layout; `node.sh` comments it as `/Users/meharkhanna/jev`). The first three then call `$JEV/scripts/azvm.sh`; `node.sh` rsyncs `$JEV/jev_local`, `$JEV/scripts` and `$JEV/pyproject.toml` to the node. In this standalone checkout those paths are outside the repo; whether a jev checkout exists there is machine-dependent (see [training.md](training.md)). The same applies to `scripts/launch_run.sh`: `training/launch_s2.sh` and `training/launch_final1.sh` `cd "$(dirname "$0")/../.."` (commented `/Users/meharkhanna/jev`) and then call `scripts/launch_run.sh` relative to that directory. The launchers added since 654d822, `training/{launch_student,launch_t150,launch_r68}.sh`, do the same (`cd "$HERE/../.."`, then `scripts/launch_run.sh`).
22. `training/{deliver_final,import_sim}.sh` prefix `azvm.sh` calls with `TIMEOUT=<s>`, but `scripts/azvm.sh` never reads `TIMEOUT` (it has no timeout wrapper), so those calls are unbounded. The same holds for `TIMEOUT=300 scripts/launch_run.sh …` in `training/{launch_s2,launch_final1,launch_student,launch_t150,launch_r68}.sh` (the last three are new since 654d822). `training/import_final.sh` uses coreutils `timeout 120` for its `azvm.sh` call instead, which does work, and its `TIMEOUT=2400` / `training/label_cluster.sh`'s `TIMEOUT=` prefixes go to `training/node.sh`, which honours them.
23. Docstrings point at research paths that are not in this repo: `jev_local/bench/__init__.py` and `scripts/jevbench.py` cite `docs/research/v2/PLAN.md`; `jev_local/bench/benchmax/__init__.py`, `scripts/benchmax_build_targets.py` (as a real input path, item 12), `bench/PREREG-*.md`, `bench/public/targets.json` and the `docs/benchmax-research/*.md` notes cite `docs/research/benchmax/*` or `docs/research/v2/*` (the benchmax notes now live in `docs/benchmax-research/`; the v2 notes are absent). There is no `docs/research/` directory.
24. `docs/GENCLASS.md` (outside this scope) says both that the extension zip and weights "are in the v0.1.0 release" and, further down, that they "are coming in the first release". `extension/README.md` and `RELEASE.md` treat v0.1.0 as released; whether the GitHub release exists cannot be checked from the repo (unverified).
25. `jev_local/bench/benchmax/adapters_b/__init__.py` documents a **module-level** function contract (`prepare(work, split)`, `items(work, split, limit, tasks)`, `SPLITS` at module level). The 15 adapters actually expose module-level `SPEC_ID`/`TARGETS` plus a class `Adapter(AdapterB)` whose methods take no `work` argument (`args.work` is passed to the constructor), as `specs_b.py`'s docstring and `common.py` -> `AdapterB` describe. Follow the class contract.
26. `scripts/benchmax/stage0_validation.sh` says it "Skips a run whose run.json is already complete", but it tests `grep -q '"finished"'`. `runner.py` -> `RunContext.to_dict` always writes a `finished` key (`null` until `finish()`), and `benchmax.py run` writes `run.json` before the adapter runs, so any existing `run.json`, including a failed or interrupted one, is skipped on a rerun.
27. `scripts/phase3_eval.sh` writes a `phase3_run_all.sh` that skips specs whose `run.json` contains `"complete": true`. `RunContext` writes `"status": "complete"` instead, so nothing is ever skipped: a second pass re-runs every spec into a complete `--out`, `benchmax.py` exits with "a rerun needs --rerun-reason", and the loop logs `FAILED <spec>`.
28. `extension/test/fixtures/audio/type.wav` is committed but unused.

## Related docs

- [README.md](README.md), [overview.md](overview.md), [repo-map.md](repo-map.md), [glossary.md](glossary.md), [playbooks.md](playbooks.md), root [AGENTS.md](../../AGENTS.md)
- [runtime/model-host.md](runtime/model-host.md): the maintained TS port of the extension engine
- [model-io-contract.md](model-io-contract.md): situation text -> packed request -> heads -> calibrated answers
- [genclass-model-lineage.md](genclass-model-lineage.md): `jev_local` (Python model, server, macOS harness, training)
- [training.md](training.md): curriculum, R17/R32, export (`training/export_runtime.py`)
- [runtime/build-test-release.md](runtime/build-test-release.md): `scripts/vm.sh` usage, runtime tests and release, and the CI workflow
- [realapps.md](realapps.md): the real-app corpus and generator, built and pilot-run on the `train` VM through `scripts/vm.sh` (slot `real`) and run at scale on F80 nodes through `realapps/scripts/cluster.sh` (own ssh/rsync)
- [sim.md](sim.md): the situation-v2 data generator that the current training push runs on the F80 cluster nodes (c12–c23 were added with `training/cluster_expand.sh`'s settings per `training/NEEDS.md`; that c01–c11 came from `scripts/cluster_up.sh` is unverified)
- [status-and-known-issues.md](status-and-known-issues.md)
- Sources: [extension/README.md](../../extension/README.md), [extension/MODEL_CARD.md](../../extension/MODEL_CARD.md), [extension/RELEASE.md](../../extension/RELEASE.md), [BENCHMARKS.md](../../BENCHMARKS.md), [bench/PREREG-jevbench.md](../../bench/PREREG-jevbench.md), [bench/PREREG-benchmax.md](../../bench/PREREG-benchmax.md), [results/jevbench-m0.md](../../results/jevbench-m0.md), [results/genclass-vs-jev-computer-use.md](../../results/genclass-vs-jev-computer-use.md), [docs/benchmax-research/PLAN.md](../benchmax-research/PLAN.md), [packages/runtime/src/model/README.md](../../packages/runtime/src/model/README.md), [docs/runtime/CONTRACT.md](../runtime/CONTRACT.md)
