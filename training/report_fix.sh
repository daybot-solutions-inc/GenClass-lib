#!/bin/bash
# Re-fit gate.report for model M from its q8 records with both REAL eval sets in full (outside REAL's test split) as
# the benign fit evidence (the per-trigger split used for action gates leaves too few benign rows), write it into
# out/export-M/meta.json and refresh model.json.     bash training/report_fix.sh r17-v2c
set -u
cd ~/gcl-train
M="$1"; MQ="$M-q8"; R=out/records; E=out/export-$M; C=$E/calibration.json
PY=$HOME/jev/.venv/bin/python
export PYTHONPATH=$HOME/jev:$HOME/gcl-train/training
$PY training/fit_report.py --cal $C --fit sim=data/sim2g/dev.jsonl:$R/${MQ}__sim2g__dev.jsonl --fit simb=data/onpbd/dev.jsonl:$R/${MQ}__onpbd__dev.jsonl --fit sima=data/onpad/dev.jsonl:$R/${MQ}__onpad__dev.jsonl \
  --fit real=data/realev/test.jsonl:$R/${MQ}__realev__test.jsonl:notest --fit real=data/realev3/test.jsonl:$R/${MQ}__realev3__test.jsonl:notest \
  --test simonpb=data/onpbe/test.jsonl:$R/${MQ}__onpbe__test.jsonl --test sim2e=data/sim2e/test.jsonl:$R/${MQ}__sim2e__test.jsonl --test sim2f=data/sim2f/test.jsonl:$R/${MQ}__sim2f__test.jsonl \
  --test sim3e=data/sim3e/test.jsonl:$R/${MQ}__sim3e__test.jsonl --test real2e=data/real2e/test.jsonl:$R/${MQ}__real2e__test.jsonl \
  --test realev=data/realev/test.jsonl:$R/${MQ}__realev__test.jsonl:test --test realev3=data/realev3/test.jsonl:$R/${MQ}__realev3__test.jsonl:test \
  --out out/gates/$MQ-report.json --write-meta $E > logs/report-$MQ.log 2>&1
$PY training/refresh_card.py $E > logs/card-$M.log 2>&1
tar cf ~/xfer/export-$M.tar --exclude=ref -C ~/gcl-train/out export-$M
head -1 logs/report-$MQ.log
