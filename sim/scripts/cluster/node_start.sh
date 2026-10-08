#!/bin/bash
# Start (or resume) a SIM generation job on a cluster node. Run ON the node (e.g. via scripts/azvm.sh cNN 'bash -s' < this).
#   node_start.sh RUN MODE SEED ROWS [WORKERS] [CHUNK]
#     MODE: gold | unlabeled | onpolicy:<model dir> ; SEED: first seed of this node's disjoint range
#     env: GATE=shipping|explore (on-policy gate), MAXP (max labelled points per trajectory), REFRESH=1 (re-fetch bundle)
# Fetches the bundle from the train VM (10.0.0.4:8810) once (REFRESH=1 to re-fetch), runs the resumable parts mode
# (finished parts are skipped on restart) and serves ~/simgen/out on <private ip>:8811 for collection.
set -euo pipefail
RUN="${1:?run}"; MODE="${2:?mode}"; SEED="${3:?seed}"; ROWS="${4:?rows}"
WORKERS="${5:-$(( $(nproc) - 4 ))}"; CHUNK="${6:-100}"
ROOT="$HOME/simgen"
mkdir -p "$ROOT/out" && cd "$ROOT"
if [ ! -f .bundle-ok ] || [ "${REFRESH:-0}" = 1 ]; then
  rm -f .bundle-ok
  curl -sS --fail --max-time 900 http://10.0.0.4:8810/simbundle.tgz -o simbundle.tgz
  tar xzf simbundle.tgz && rm simbundle.tgz && touch .bundle-ok
fi
if pgrep -f "simgen/sim/dist/gen[.]js.*out/$RUN( |$)" > /dev/null; then echo "already running: $RUN"; exit 0; fi
FLAGS=(--parts --rows "$ROWS" --chunk "$CHUNK" --seed "$SEED" --workers "$WORKERS" --out "$ROOT/out/$RUN")
[ -n "${MAXP:-}" ] && FLAGS+=(--max-points "$MAXP")
case "$MODE" in
  gold) ;;
  unlabeled) FLAGS+=(--unlabeled) ;;
  onpolicy:*) FLAGS+=(--on-policy "${MODE#onpolicy:}" --gate "${GATE:-shipping}") ;;
  *) echo "bad mode $MODE" >&2; exit 2 ;;
esac
(SIM_FEATURE_HOLDOUT="${SIM_FEATURE_HOLDOUT:-on}" setsid nohup "$ROOT/node/bin/node" --max-old-space-size=8192 "$ROOT/sim/dist/gen.js" "${FLAGS[@]}" > "$ROOT/out/$RUN.log" 2>&1 < /dev/null &)
IP="$(hostname -I | awk '{print $1}')"
if ! ss -ltn | grep -q ':8811 '; then
  (setsid nohup python3 -m http.server 8811 --bind "$IP" --directory "$ROOT/out" > /tmp/simgen-serve.log 2>&1 < /dev/null &)
fi
sleep 2; tail -n 2 "$ROOT/out/$RUN.log" || true
echo "started $RUN ($MODE) seeds from $SEED, $ROWS rows, $WORKERS workers; serving $IP:8811"
