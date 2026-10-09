#!/bin/bash
# Node-side claim protocol (lead, 2026-10-08), run ON the node: scripts/azvm.sh <node> 'bash -s -- ACTION JOB' < claim.sh
#   claim JOB    take the node for SIM: refuse (exit 3) if another agent's processes run or its lock is live
#   release      remove SIM's lock (exit 3 if the lock belongs to another agent)
#   check        exit 0 only if the node can be deallocated: no other agent's processes and no other agent's lock
# The lock is ~/.gcl-claim/owner = "<agent> <job> <UTC time>". Patterns for other agents' work: TRAIN (jev_local
# training, the jev venv's python, training/ scripts) and REAL (realapps generators, browsers). This script is piped
# through stdin, so its own command line never matches them.
set -u
ACT="${1:?claim|release|check}"; JOB="${2:-}"
AGENT=SIM
L="$HOME/.gcl-claim"
foreign() { pgrep -fa "[j]ev_local\.train|[.]venv/bin/python|[t]raining/[a-z_]+\.py|[r]ealapps.*gen\.js|[c]hrom(e|ium)" | head -3; }
owner() { cat "$L/owner" 2>/dev/null; }
stamp() { echo "$AGENT $JOB $(date -u +%FT%TZ)" > "$L/owner"; }
case "$ACT" in
  claim)
    f="$(foreign)"
    if [ -n "$f" ]; then echo "BUSY: other agent's processes: $f"; exit 3; fi
    if mkdir "$L" 2>/dev/null; then stamp; echo "claimed: $(owner)"; exit 0; fi
    o="$(owner)"
    case "$o" in
      "$AGENT "*) stamp; echo "claimed (own lock was: $o)" ;;
      *) stamp; echo "claimed (stale lock, no live process: $o)" ;;
    esac ;;
  release)
    o="$(owner)"
    case "$o" in
      "") rm -rf "$L"; echo "no lock" ;;
      "$AGENT "*) rm -rf "$L"; echo "released: $o" ;;
      *) echo "lock held by another agent: $o"; exit 3 ;;
    esac ;;
  check)
    f="$(foreign)"
    if [ -n "$f" ]; then echo "NOT FREE: other agent's processes: $f"; exit 3; fi
    o="$(owner)"
    case "$o" in
      ""|"$AGENT "*) echo "ok to deallocate" ;;
      *) echo "NOT FREE: lock held by: $o"; exit 3 ;;
    esac ;;
  *) echo "unknown action" >&2; exit 2 ;;
esac
