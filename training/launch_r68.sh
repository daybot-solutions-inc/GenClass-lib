#!/bin/bash
# R68 student benchmark (ettin-68m MIT base, pruned vocab, fresh heads; no stage-1 curriculum, so 20% curriculum replay).
#   training/launch_r68.sh RUN PASSES "nodes" MASTER_IP
set -euo pipefail
RUN="${1:?run}"; PASSES="${2:?passes}"; NODES="${3:?nodes}"; MASTER="${4:?master ip}"; shift 4
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.."
for n in $NODES; do
  TIMEOUT=300 "$HERE/node.sh" "$n" 'test -f models/base/ettin-68m-v16k/config.json || $PY training/prune_vocab.py prune \
    --src $HOME/jev/models/base/ettin-encoder-68m --out models/base/ettin-68m-v16k --merges 16000 > /dev/null; ls models/base/ettin-68m-v16k/config.json' >/dev/null
done
G=/home/azureuser/gcl-train
TIMEOUT=300 scripts/launch_run.sh "$RUN" "$MASTER" 8 10 "$NODES" -- --stream $G/data/s3 $G/data/s1 --stream-cache $G/cache/$RUN \
  --mixture $G/training/configs/mix_r68.json --runs-dir $G/runs --max-len 2048 --batch-tokens 8192 --grad-accum 2 --balance \
  --amp --no-grad-ckpt --device cpu --log-every 10 --ckpt-every 25 --seed 5 --passes "$PASSES" \
  --base $G/models/base/ettin-68m-v16k --out $G/models/$RUN --lr 3e-4 --head-lr 1e-3 --resume "$@"
