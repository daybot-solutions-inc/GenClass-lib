#!/bin/bash
# Mac-side helper for realapps generation on Azure VMs (ssh/rsync only; nothing heavy runs on the Mac).
#   TAG=situation-v2 realapps/scripts/cluster.sh sync HOST    rsync realapps + runtime + sim sources to HOST:~/gcl/real,
#                                                            plus `git archive $TAG packages/runtime/src` (the pinned
#                                                            runtime the apps are built against; required for data)
#   realapps/scripts/cluster.sh setup HOST                    sync, then scripts/node_setup.sh on HOST
#   realapps/scripts/cluster.sh run HOST NAME SEED N [WORKERS] [extra gen args...]
#                                                            detached gen into HOST:~/gcl/real-out/NAME (resumable)
#   realapps/scripts/cluster.sh status HOST [NAME]            progress lines + stats summary
#   realapps/scripts/cluster.sh stop HOST                     stop gen workers (results so far are kept)
# HOST names come from ~/.jev-local/azure_hosts. Deallocate nodes you started when they are idle.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cmd="${1:?sync|setup|run|status|stop}"; H="${2:?host}"
IP=$(awk -v h="$H" '$1==h {print $2}' "$HOME/.jev-local/azure_hosts")
[ -n "$IP" ] || { echo "unknown host $H" >&2; exit 2; }
KEY="$HOME/.ssh/jev_azure"
OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=6)
DEST="azureuser@${IP}"
r() { timeout "${T:-600}" ssh "${OPTS[@]}" "${DEST}" "export PATH=\$HOME/node/bin:\$PATH; $1"; }
sync() {
  r "mkdir -p ~/gcl/real/packages ~/gcl/real/realapps ~/gcl/real/sim"
  for d in realapps packages/runtime sim; do
    timeout 600 rsync -az --delete -e "ssh ${OPTS[*]}" --exclude node_modules --exclude 'dist/' --exclude .git --exclude '/out/' --exclude '__pycache__' --exclude '.DS_Store' \
      "${ROOT}/${d}/" "${DEST}:gcl/real/${d}/"
  done
  if [ -n "${TAG:-}" ]; then
    local tmp
    tmp="$(mktemp -d)"
    (cd "$ROOT" && git archive --format=tar "$TAG" packages/runtime/src | tar -x -C "$tmp")
    r "mkdir -p ~/gcl/real-cache/runtime/${TAG}"
    timeout 600 rsync -az --delete -e "ssh ${OPTS[*]}" "$tmp/packages/runtime/src/" "${DEST}:gcl/real-cache/runtime/${TAG}/src/"
    rm -rf "$tmp"
    r "echo ${TAG} > ~/gcl/real-cache/runtime/current"
  fi
  r "grep -c . ~/gcl/real/realapps/src/harness/trajectory.ts >/dev/null && echo synced to ${H} (runtime: \$(cat ~/gcl/real-cache/runtime/current 2>/dev/null || echo working-tree))"
}
case "$cmd" in
  sync) sync ;;
  setup) sync; T=3000 r "bash ~/gcl/real/realapps/scripts/node_setup.sh 2>&1 | tail -15" ;;
  run)
    name="${3:?name}"; seed="${4:?seed}"; n="${5:?trajectories}"; w="${6:-0}"; shift 6 2>/dev/null || shift $#
    extra="$*"
    r "mkdir -p ~/gcl/real-out/${name} && cd ~/gcl/real/realapps && W=${w}; [ \"\$W\" -gt 0 ] || W=\$(( \$(nproc) * 3 / 4 )); nohup node dist/harness/gen.js --out ~/gcl/real-out/${name} --seed ${seed} --trajectories ${n} --workers \$W ${extra} > ~/gcl/real-out/${name}/gen.log 2>&1 < /dev/null & echo launched gen ${name} on ${H} pid \$! workers \$W"
    ;;
  status)
    name="${3:-}"
    r "uptime; for d in ~/gcl/real-out/${name:-*}/; do [ -f \$d/gen.log ] || continue; echo \"== \$d\"; tail -2 \$d/gen.log; wc -l \$d/*.jsonl 2>/dev/null | tail -1; done; pgrep -fc 'harness/gen[.]js' || true"
    ;;
  stop) r "pkill -f 'harness/gen[.]js' || true; pkill -f 'harness/worker[.]js' || true; echo stopped" ;;
  *) echo "unknown command $cmd" >&2; exit 2 ;;
esac
