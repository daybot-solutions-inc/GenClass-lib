#!/bin/bash
# Build/test GenClass-lib on the Azure `train` VM. The Mac only edits files (8 GB RAM; never run builds,
# browsers or models on it).
#
#   scripts/vm.sh sync SLOT                 rsync this repo to ~/gcl/SLOT on the VM (no node_modules/.git/data)
#   scripts/vm.sh run SLOT 'cmd'            sync, then run cmd in ~/gcl/SLOT (node 22 on PATH)
#   scripts/vm.sh exec SLOT 'cmd'           run cmd in ~/gcl/SLOT without syncing
#   scripts/vm.sh get SLOT REMOTE LOCAL     copy ~/gcl/SLOT/REMOTE back to LOCAL (recursive)
#
# SLOT is your own directory name on the VM (e.g. core, model, sim, demos) so parallel agents never clobber
# each other. Every command is wrapped in a timeout; pass TIMEOUT=seconds to change it (default 1800).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOSTS="$HOME/.jev-local/azure_hosts"
IP=$(awk '$1=="train" {print $2}' "$HOSTS")
[ -n "$IP" ] || { echo "train host missing from $HOSTS" >&2; exit 2; }
KEY="$HOME/.ssh/jev_azure"
SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=6)
T="${TIMEOUT:-1800}"
DEST="azureuser@${IP}"

cmd="${1:?sync|run|exec|get}"; slot="${2:?slot name}"
case "$slot" in *[!a-zA-Z0-9_-]*) echo "bad slot name" >&2; exit 2;; esac

do_sync() {
  timeout 300 ssh "${SSH_OPTS[@]}" "${DEST}" "mkdir -p gcl/${slot}"
  timeout 600 rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
    --exclude node_modules --exclude .git --exclude 'dist/' --exclude '.vite' --exclude '/data/' \
    --exclude 'test-results/' --exclude 'playwright-report/' --exclude '__pycache__' --exclude '.DS_Store' \
    --exclude '/models/' --exclude '/runs/' --exclude '/extension/' --exclude '/sim/out/' \
    "${ROOT}/" "${DEST}:gcl/${slot}/"
}

remote() {
  timeout "$T" ssh "${SSH_OPTS[@]}" "${DEST}" "export PATH=\$HOME/node/bin:\$PATH; cd ~/gcl/${slot} && $1"
}

case "$cmd" in
  sync) do_sync ;;
  run) do_sync; remote "${3:?command}" ;;
  exec) remote "${3:?command}" ;;
  get) timeout 600 scp -q -r "${SSH_OPTS[@]}" "${DEST}:gcl/${slot}/${3:?remote path}" "${4:?local path}" ;;
  *) echo "unknown command $cmd" >&2; exit 2 ;;
esac
