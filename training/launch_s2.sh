#!/bin/bash
# Stage 2 (SIM r300k + curriculum replay), launched from the Mac. R17 gets more compute (MODEL: latency makes it the
# likely default). Rank-0 nodes hold the stage-1c trainer states used by --init-from.
set -euo pipefail
cd "$(dirname "$0")/../.."   # /Users/meharkhanna/jev (scripts/launch_run.sh)
G=/home/azureuser/gcl-train
COMMON="--stream $G/data/s2 $G/data/s1b $G/data/s1 --stream-cache $G/cache/s2 --mixture $G/training/configs/mix_s2.json \
--runs-dir $G/runs --max-len 2048 --batch-tokens 8192 --balance --amp --no-grad-ckpt --device cpu --log-every 10 \
--ckpt-every 50 --seed 2"
# shellcheck disable=SC2086
TIMEOUT=300 scripts/launch_run.sh r32-s2 10.0.0.7 8 10 "c02 c03 c04 c05" -- $COMMON --passes 1.5 --grad-accum 3 \
  --base $G/models/r32-v16k/backbone --init-from $G/runs/r32-s1c/ckpt --out $G/models/r32-s2 --lr 1e-4 --head-lr 4e-4 --resume
# shellcheck disable=SC2086
TIMEOUT=300 scripts/launch_run.sh r17-s2 10.0.0.14 8 10 "c09 c10 c11 c06 c07 c08" -- $COMMON --passes 4 --grad-accum 2 \
  --base $G/models/base/ettin-17m-v16k --init-from $G/runs/r17-s1c/ckpt --out $G/models/r17-s2 --lr 2e-4 --head-lr 1e-3 --resume
