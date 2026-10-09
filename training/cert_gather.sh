#!/bin/bash
# Node-side (on R0): wait for every share of a distributed collection of certd:dev records for model M (K shares, IPs in
# share order, R0 first), gather them, then run profiles.sh. Polls helper http servers; never re-downloads R0's own part.
#   bash training/cert_gather.sh r17-v2d gain|mass "10.0.0.13 10.0.0.7 ..."
set -u
cd ~/gcl-train
M="$1"; KIND="$2"; IPS="$3"; MQ="$M-q8"; TAG="certd-dev"
set -- $IPS; K=$#
i=0
for ip in $IPS; do
  until curl -sf -o /dev/null "http://$ip:8808/${MQ}__done__${TAG}.$i"; do sleep 20; done
  [ $i -eq 0 ] || curl -sS --fail -o out/records/parts/${MQ}__certd__dev.$i.jsonl "http://$ip:8808/${MQ}__certd__dev.$i.jsonl"
  i=$((i + 1))
done
cat $(for j in $(seq 0 $((K - 1))); do echo out/records/parts/${MQ}__certd__dev.$j.jsonl; done) > out/records/${MQ}__certd__dev.jsonl
wc -l out/records/${MQ}__certd__dev.jsonl
bash training/profiles.sh "$M" "$KIND"
