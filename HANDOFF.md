# HANDOFF: continue the GenClass Runtime work

Read this first if you are a Claude session picking up this project. Updated 2026-10-08.
Also read [OPEN_TASKS.md](OPEN_TASKS.md) (what's left), [docs/runtime/CONTRACT.md](docs/runtime/CONTRACT.md)
(binding spec) and [packages/runtime/STATUS.md](packages/runtime/STATUS.md) (current runtime state + example
situations).

## What this is

`@genclass/runtime` is a client-side AI runtime for web apps:

```ts
import { GenClass } from "@genclass/runtime";
GenClass.init();
```

It observes user actions, async ops, network, state writes, errors, timing and causality. When a situation is
salient it asks a small local GenClass model (ONNX on WebGPU or WASM, in a Web Worker) for a diagnosis and a
generic action. It has no hardcoded bug rules.

- **Modes:** observe (default since mvp-v2; reports only) → guard (opt-in; minimal reversible actions at ≥ 0.9 with the balanced profile) → heal (experimental).
- **Product principle:** never make a correct app worse; false positives kill it; everything must be observable
  and undoable.

## Current state

| piece | state |
|---|---|
| npm | `@genclass/runtime@0.1.0-beta.0` is `latest` (published 2026-10-08 ~13:40 UTC from 1f0f617; default `observe`, loads the model by default) and `@genclass/runtime-model@0.1.0` is `latest` (`r17-v2b` = `genclass-runtime-r17` 2.0.0-rc2; the default model URL `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/` resolves). `0.1.0-alpha.1` (806a296, no model) was `latest` before; `0.1.0-alpha.0` (older v1 build) is deprecated (org `genclass`, owner meharpro). Each publish needs the user's 2FA, so give them the exact `npm publish <tgz> --access public` command. |
| git | Branch `runtime` (also fast-forwarded into `main` once). Tags: `situation-v1` (old format), `situation-v2` (**current frozen training format**, commit 6e5e86e), `v0.1.0-alpha.0` (GitHub pre-release). |
| runtime | Batch 5 done; 346 tests pass. Decisions happen at the network boundary (`delivery` trigger). Store writes are never held by default. The never-worse sweep over 66 real apps with an always-passive model changed 0/396 clean runs. |
| model | Round 1 (v1 data): R17 9.6 MB, guard false-intervention rate (FIR) 0.05%, recall on clear cases only ~8%. The cause is analysed in `sim/SEPARABILITY.md`; the fixes are in v2. Since 2026-10-08 the v2 model `r17-v2b` is published as `@genclass/runtime-model@0.1.0` (gates guard 0.80 {mutation 0.95}, heal 0.85 {failure 0.95, inconsistency 0.85}, report 0.85). |
| data | SIM is generating about 10M gold + 50M unlabeled rows on v2 (20 Azure nodes) into `train:/data/sim-out/v2-*`. REAL is generating about 495k real-browser gold rows (c01, c10, c11) into `train:/data/real-out/`. Locations are in `training/NEEDS.md`. |
| training | Next: 150M teacher on v2 gold, then teacher-labels the unlabeled rows, then distil R17 (default) and R32, then DAgger via SIM `--on-policy`. Plan: `training/PLAN-v1.md`; log: `training/LOG.md`; eval: `training/EVAL.md`. |

## Repo map

- `packages/runtime`: the library. See `STATUS.md`, plus the npm README and the tests in `test/`, including
  `test/review-*` (regression tests for review findings) and `test/smoke/smoke.sh` (npm tarball → fresh Vite
  app → Chromium).
- `sim/`: the deterministic training-data simulator. Counterfactual labels with S1 (labels by the cause of the
  divergence) and S2 (futures re-draw latents the runtime can't observe). See `README.md` and `SEPARABILITY.md`.
- `realapps/`: 66 real apps across 23 stacks, run in headless Chromium, with the same labels. See `README.md`.
- `training/`: vocabulary pruning, curriculum (`curriculum/rt.py` mirrors the runtime renderer at
  situation-v2), Azure launch scripts, ONNX export, eval.
- `demos/`: six demo apps with a Service Worker chaos backend and Playwright trials (`results.md`). They are
  honest evaluation: never tune them, and don't let sim/ or realapps/ read them.
- `docs/runtime`: `CONTRACT.md`, `ARCHITECTURE.md`, `API.md`, `RESULTS.md` (comparisons + training log; update it with every result).

## Rules (hard-won)

- **The Mac has 8 GB RAM and is near OOM.** Never run npm, tsc, vitest, node, browsers, torch or models on it.
  Edit locally; build and test on the Azure `train` VM with `scripts/vm.sh run|exec|get <slot> '<cmd>'`. Large
  artifacts go to `/data` on train (1 TB disk).
- **Azure** (rg-jev-train, eastus, quota 2,048 vCPU):
  - Nodes are c01–c23 F80 plus `data` and `train`; hosts are in `~/.jev-local/azure_hosts`, and the ssh helper is
    `/Users/meharkhanna/jev/scripts/azvm.sh`.
  - Run `az` calls one at a time, each wrapped in `timeout`.
  - **The nightly auto-shutdown schedules are DISABLED** (the user OK'd it for the training push). Deallocate every
    idle node yourself, and **re-enable the schedules when the push ends**:
    `az resource update -g rg-jev-train --resource-type Microsoft.DevTestLab/schedules -n shutdown-computevm-vm-jev-<vm> --set properties.status=Enabled`.
  - **Node lock protocol.** Before using a node:
    - check for other agents' processes:
      `pgrep -f "sim/dist/gen|realapps.*gen.js|jev_local.train.train"`;
    - claim the node with `mkdir ~/.gcl-claim && echo "<agent> <job> <time>" > ~/.gcl-claim/owner`, and take
      it only if the existing owner's process is gone;
    - remove the lock before you deallocate.

    Also record claims in `training/NEEDS.md`. Never delete VMs.
- **zsh:** write rsync/scp destinations as `"user@${IP}:dir/"`; an unbraced `$IP:` silently copies locally.
- **The training format is frozen** at `situation-v2`. Any change to `packages/runtime/src/situation/*` changes
  the model's input, so it means a new tag and regenerated data. Coordinate before touching it.
- **Licensing:** train only from v1 `jev-local-fast` or MIT ettin bases, plus synthetic/sim/realapps data. Never
  use v2/Z/S checkpoints or benchmark datasets.
- **Commits** use the user's identity with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push to `origin runtime` as you go. Keep
  `OPEN_TASKS.md` and this file current.

## How to continue

1. `git pull origin runtime`. Read `OPEN_TASKS.md`, `training/LOG.md` (tail) and `training/NEEDS.md`.
2. Check what's running:

   ```bash
   az vm list -g rg-jev-train -d --query "[?powerState!='VM deallocated'].name" -o tsv
   ```

   Then check the job logs on the nodes, as described in each agent's README/LOG.
3. Pick up the next unfinished item in `OPEN_TASKS.md`. The usual order was: v2 data collected → teacher →
   distillation → EVAL → model package `@genclass/runtime-model@0.1.0` (the default CDN URL the runtime loads;
   published 2026-10-08 together with `@genclass/runtime@0.1.0-beta.0`) → rerun the demos with the trained model →
   `@genclass/runtime@0.1.0` (2FA by the user).
4. Report honestly: false-intervention rate next to every recall or bug-fix number.
