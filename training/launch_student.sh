#!/bin/bash
# Generic DDP launcher for students and teachers (stream mode over data/s3 + data/s1; pruned 16k vocabulary).
#   training/launch_student.sh RUN ARCH PASSES MIX "nodes" [INIT] [-- extra trainer args]
#   ARCH: r17 | r32 | r68 | t150   (base + lr + ranks/threads + grad-accum defaults below)
#   MIX:  a file under training/configs/ (e.g. mix_v2_distill.json)
#   INIT: optional trainer state or servable to start from (must exist on the FIRST node = rank 0)
# Rank 0 = first node; master = its private IP. Every run is resumable (--resume, checkpoints every 25 steps).
set -euo pipefail
RUN="${1:?run}"; ARCH="${2:?arch}"; PASSES="${3:?passes}"; MIX="${4:?mix}"; NODES="${5:?nodes}"; INIT="${6:-}"
shift $(( $# >= 6 ? 6 : 5 )); [ "${1:-}" = "--" ] && shift
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.."
G=/home/azureuser/gcl-train
case "$ARCH" in
  r17)  BASE=$G/models/base/ettin-17m-v16k; LR=2e-4; HLR=1e-3; GA=2; R=8; T=10 ;;
  r32)  BASE=$G/models/r32-v16k/backbone;  LR=1e-4; HLR=4e-4; GA=3; R=8; T=10 ;;
  r68)  BASE=$G/models/base/ettin-68m-v16k; LR=2e-4; HLR=1e-3; GA=2; R=8; T=10 ;;
  t150) BASE=$G/models/base/ettin-150m-v16k; LR=2e-4; HLR=1e-3; GA=2; R=8; T=10 ;;
  *) echo "unknown arch $ARCH" >&2; exit 2 ;;
esac
FIRST=$(echo $NODES | awk '{print $1}')
MASTER=$(awk -v h="$FIRST" '$1==h {print $3}' "$HOME/.jev-local/azure_hosts")
for n in $NODES; do  # pruned bases are made locally from the MIT ettin bases when missing
  TIMEOUT=300 "$HERE/node.sh" "$n" "for m in 68m 150m; do test -f models/base/ettin-\$m-v16k/config.json || \
    \$PY training/prune_vocab.py prune --src \$HOME/jev/models/base/ettin-encoder-\$m --out models/base/ettin-\$m-v16k --merges 16000 >/dev/null; done; true" >/dev/null
done
INIT_ARGS=(); [ -n "$INIT" ] && INIT_ARGS=(--init-from "$INIT")
TIMEOUT=300 scripts/launch_run.sh "$RUN" "$MASTER" "${RANKS:-$R}" "${THREADS:-$T}" "$NODES" -- --stream $G/data/s3 $G/data/s1 \
  --stream-cache $G/cache/$RUN --mixture $G/training/configs/$MIX --runs-dir $G/runs --max-len 2048 --batch-tokens 8192 \
  --grad-accum "${GA_OVERRIDE:-$GA}" --balance --amp --no-grad-ckpt --device cpu --log-every 10 --ckpt-every 25 --seed 7 \
  --passes "$PASSES" --base $BASE --out $G/models/$RUN --lr "${LR_OVERRIDE:-$LR}" --head-lr "${HLR_OVERRIDE:-$HLR}" \
  ${INIT_ARGS[@]+"${INIT_ARGS[@]}"} --resume "$@"
