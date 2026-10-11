#!/bin/bash
# Final round 1 (frozen runtime, SIM phase A + 15% frozen-wording curriculum replay), launched from the Mac.
# Both candidates start from their stage-1c weights (the pilots saw pre-freeze text). Rank 0 must be the node holding
# runs/<model>-s1c/ckpt (c02 for R32, c09 for R17): only rank 0 reads --init-from.
#   training/launch_final1.sh R32_PASSES R17_PASSES
set -euo pipefail
P32="${1:?r32 passes}"; P17="${2:?r17 passes}"
cd "$(dirname "$0")/.."   # repo root (scripts/launch_run.sh)
G=/home/azureuser/gcl-train
COMMON="--stream $G/data/s3 $G/data/s1 --stream-cache $G/cache/final1 --mixture $G/training/configs/mix_final1.json \
--runs-dir $G/runs --max-len 2048 --batch-tokens 8192 --balance --amp --no-grad-ckpt --device cpu --log-every 10 \
--ckpt-every 50 --seed 3"
# shellcheck disable=SC2086
TIMEOUT=300 scripts/launch_run.sh r32-final1 10.0.0.7 8 10 "c02 c03 c04 c05 c06 c07" -- $COMMON --passes "$P32" --grad-accum 3 \
  --base $G/models/r32-v16k/backbone --init-from $G/runs/r32-s1c/ckpt --out $G/models/r32-final1 --lr 1e-4 --head-lr 4e-4 --resume
# shellcheck disable=SC2086
TIMEOUT=300 scripts/launch_run.sh r17-final1 10.0.0.14 8 10 "c09 c10 c11 c08" -- $COMMON --passes "$P17" --grad-accum 2 \
  --base $G/models/base/ettin-17m-v16k --init-from $G/runs/r17-s1c/ckpt --out $G/models/r17-final1 --lr 2e-4 --head-lr 1e-3 --resume
