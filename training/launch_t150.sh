#!/bin/bash
# Teacher T150 (ettin-encoder-150m, MIT, pruned vocab, fresh heads) on gold SIM rows + curriculum replay.
#   training/launch_t150.sh RUN PASSES "nodes" MASTER_IP [extra trainer args...]
# Every node first prunes the 150m base locally (models/base/ettin-150m-v16k) if missing. 6 ranks × 13 threads per node
# (16.5 GB RSS per rank at 2048-token rows; the als/alds nodes have 160 GB).
set -euo pipefail
RUN="${1:?run}"; PASSES="${2:?passes}"; NODES="${3:?nodes}"; MASTER="${4:?master ip}"; shift 4
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.."
for n in $NODES; do
  TIMEOUT=300 "$HERE/node.sh" "$n" 'test -f models/base/ettin-150m-v16k/config.json || $PY training/prune_vocab.py prune \
    --src $HOME/jev/models/base/ettin-encoder-150m --out models/base/ettin-150m-v16k --merges 16000 > /dev/null; ls models/base/ettin-150m-v16k/config.json'
done
G=/home/azureuser/gcl-train
TIMEOUT=300 scripts/launch_run.sh "$RUN" "$MASTER" "${RANKS:-8}" "${THREADS:-10}" "$NODES" -- --stream $G/data/s3 --stream-cache $G/cache/$RUN \
  --mixture $G/training/configs/mix_t150.json --runs-dir $G/runs --max-len 2048 --batch-tokens 8192 --grad-accum 2 --balance \
  --amp --no-grad-ckpt --device cpu --log-every 10 --ckpt-every 25 --seed 4 --passes "$PASSES" \
  --base $G/models/base/ettin-150m-v16k --out $G/models/$RUN --lr 2e-4 --head-lr 1e-3 --resume "$@"
