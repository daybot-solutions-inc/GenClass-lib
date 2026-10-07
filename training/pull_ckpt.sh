#!/bin/bash
# Copy a servable checkpoint dir ~/gcl-train/models/NAME from a training node to c01 over the private network.
#   training/pull_ckpt.sh NAME NODE      (NODE = host name in ~/.jev-local/azure_hosts, e.g. c02)
set -euo pipefail
NAME="${1:?checkpoint name}"; NODE="${2:?node}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PRIV=$(awk -v h="$NODE" '$1==h {print $3}' "$HOME/.jev-local/azure_hosts")
[ -n "$PRIV" ] || { echo "unknown node $NODE" >&2; exit 2; }
TIMEOUT=300 "$HERE/node.sh" "$NODE" "mkdir -p ~/xfer && tar cf ~/xfer/$NAME.tar -C ~/gcl-train/models $NAME && \
  (ss -ltn | grep -q ':8801 ' || (setsid nohup python3 -m http.server 8801 --bind $PRIV --directory /home/azureuser/xfer \
   > /tmp/xfer8801.log 2>&1 < /dev/null &)); sleep 1; ls -la ~/xfer/$NAME.tar"
TIMEOUT=600 "$HERE/node.sh" c01 "mkdir -p ~/gcl-train/models && rm -rf ~/gcl-train/models/$NAME && \
  curl -sS --fail http://$PRIV:8801/$NAME.tar | tar x -C ~/gcl-train/models && ls ~/gcl-train/models/$NAME"
