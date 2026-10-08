#!/bin/bash
# Run ON a freshly created cluster node: pull the node kit (venv cloned from an existing node, ettin MIT bases, pruned
# bases, TRAIN data) from KIT_URL and verify torch. Same Ubuntu 24.04 image + same user/path, so the venv is relocatable.
#   bash node_init.sh http://10.0.0.15:8801/kit.tar
set -euo pipefail
URL="${1:?kit url}"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq rsync zstd pigz >/dev/null 2>&1 || true
cd ~ && curl -sS --fail "$URL" | tar x
mkdir -p ~/gcl-train/logs ~/gcl-train/out ~/gcl-train/runs ~/jev/runs
~/jev/.venv/bin/python -c "import torch, transformers, tokenizers; print('ok', torch.__version__, transformers.__version__, torch.get_num_threads())"
touch ~/.node_init_ok
