#!/bin/bash
# TRAIN helper for the Azure cluster (hosts in ~/.jev-local/azure_hosts). Mac-safe: ssh/rsync only.
#   training/node.sh HOST sync            rsync training/ -> ~/gcl-train/training/ and research/ -> ~/jev (jev_local, scripts)
#   training/node.sh HOST 'cmd'           run cmd in ~/gcl-train on HOST (PYTHONPATH=~/jev, venv python as $PY)
#   training/node.sh HOST get REMOTE LOCAL
#   training/node.sh HOST put LOCAL REMOTE
# Every call is wrapped in a timeout (TIMEOUT seconds, default 900).
set -euo pipefail
H="${1:?host}"; shift
IP=$(awk -v h="$H" '$1==h {print $2}' "$HOME/.jev-local/azure_hosts")
[ -n "$IP" ] || { echo "unknown host $H" >&2; exit 2; }
OPTS=(-i "${AZURE_SSH_KEY:-$HOME/.ssh/id_ed25519}" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=6)
HERE="$(cd "$(dirname "$0")" && pwd)"
JEV="${JEV_ROOT:-$(cd "$HERE/.." && pwd)/research}"   # research/ (jev_local, scripts, pyproject.toml)
T="${TIMEOUT:-900}"
DEST="azureuser@${IP}"
case "${1:-}" in
  sync)
    timeout 120 ssh "${OPTS[@]}" "${DEST}" "mkdir -p gcl-train/training jev"
    timeout 600 rsync -az --delete -e "ssh ${OPTS[*]}" --exclude '__pycache__' --exclude '.DS_Store' --exclude '.pytest_cache' \
      "${HERE}/" "${DEST}:gcl-train/training/"
    timeout 600 rsync -az -e "ssh ${OPTS[*]}" --exclude '__pycache__' --exclude '.DS_Store' \
      "${JEV}/jev_local" "${JEV}/scripts" "${JEV}/pyproject.toml" "${DEST}:jev/"
    ;;
  get) timeout "$T" scp -q -r "${OPTS[@]}" "${DEST}:${2:?remote}" "${3:?local}" ;;
  put) timeout "$T" scp -q -r "${OPTS[@]}" "${2:?local}" "${DEST}:${3:?remote}" ;;
  *) timeout "$T" ssh "${OPTS[@]}" "${DEST}" "mkdir -p ~/gcl-train && cd ~/gcl-train && export PYTHONPATH=\$HOME/jev:\$HOME/gcl-train/training PY=\$HOME/jev/.venv/bin/python HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false; $1" ;;
esac
