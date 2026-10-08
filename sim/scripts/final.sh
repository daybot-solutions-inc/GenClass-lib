#!/bin/bash
# Final data generation on the train VM (runtime frozen at tag situation-v1). Run from anywhere:
#   bash sim/scripts/final.sh a          phase A: 600k rows, seeds from 10,000,000
#                                        -> sim/out/final-a/{train,dev,test}.jsonl + stats.json
#   bash sim/scripts/final.sh b          phase B: 1.4M rows, seeds from 50,000,000, resumable parts
#                                        -> sim/out/final-b/parts/part-NNNNNN.<split>.jsonl (+ part-NNNNNN.json)
#   bash sim/scripts/final.sh merge-b    concatenate finished B parts into sim/out/final-b/{train,dev,test}.jsonl
# Resuming B after an interruption (e.g. the 03:00 UTC auto-shutdown): run `final.sh b` again. Finished parts (with a
# .json marker) are skipped; half-written parts (*.tmp) are discarded and regenerated; it stops at 1.4M rows total.
# Every finished part file is complete and usable on its own (seed ranges are disjoint from phase A).
set -euo pipefail
cd "$(dirname "$0")/.."
WORKERS=${WORKERS:-56}
case "${1:-}" in
  a) exec node dist/gen.js --rows 600000 --out out/final-a --seed 10000000 --workers "$WORKERS" ;;
  b) exec node dist/gen.js --parts --rows 1400000 --chunk 100 --seed 50000000 --workers "$WORKERS" --out out/final-b ;;
  merge-b) exec node dist/gen.js --merge-only --out out/final-b ;;
  *) echo "usage: final.sh a|b|merge-b" >&2; exit 2 ;;
esac
