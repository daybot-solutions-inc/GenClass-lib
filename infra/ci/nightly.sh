#!/bin/bash
# Nightly GenClass CI (root part; cron 06:00 UTC on vm-genclass-ci, see genclass-ci.cron).
#   1. run-tests.sh as azureuser            -> /var/lib/genclass-ci/runs/<date>/ci-result.json (+ logs, e2e JSON)
#   2. ai-summary.mjs (Foundry Models, managed identity) -> ai-summary.json
#   3. upload the run to blob  <storage>/ci-results/<date>/  and  ci-results/latest.json  (managed identity)
#      + mirror-models.sh: every published @genclass/runtime-model / @genclass/runtime version -> public `models`
#   4. insert one row into Postgres  genclass.ci_results  (password from the root-only /etc/genclass-ci.env)
# Never prints secrets. Exit code = 0 only if the run passed (ok=true) and every step succeeded.
set -uo pipefail
umask 077
# shellcheck disable=SC1091
source /etc/genclass-ci.env   # PGHOST PGUSER PGPASSWORD PGDATABASE PGSSLMODE STORAGE_ACCOUNT AOAI_ENDPOINT AOAI_DEPLOYMENT
export PGHOST PGUSER PGPASSWORD PGDATABASE PGSSLMODE AOAI_ENDPOINT AOAI_DEPLOYMENT
export PGOPTIONS="-c client_min_messages=warning"
CI_DIR=/opt/genclass-ci
DATE=$(date -u +%F)
OUT=/var/lib/genclass-ci/runs/$DATE
REPO=/var/lib/genclass-ci/GenClass-lib
install -d -m 755 -o azureuser -g azureuser /var/lib/genclass-ci /var/lib/genclass-ci/runs "$OUT"
RC=0

sudo -u azureuser -H bash "$CI_DIR/run-tests.sh" "$OUT"
[ -s "$OUT/ci-result.json" ] || { echo '{"ok":false,"error":"run-tests produced no record"}' > "$OUT/ci-result.json"; RC=1; }

# previous night's record + the last 24 h of commits, for the AI notes
psql -At -c "select detail from ci_results order by run_at desc limit 1" > "$OUT/prev.json" 2>/dev/null || : > "$OUT/prev.json"
git -C "$REPO" log --since="24 hours ago" --stat --format='--- %h %an %ad%n%s%n%b' --date=iso origin/runtime > "$OUT/commits.txt" 2>/dev/null || :
node "$CI_DIR/ai-summary.mjs" "$OUT" "$OUT/prev.json" "$OUT/commits.txt" > /dev/null || RC=1

# blob upload (system-assigned identity has Storage Blob Data Contributor on the account)
az login --identity --output none 2>/dev/null || RC=1
for f in ci-result.json ai-summary.json model-e2e-results.json run.log e2e.log smoke.log; do
  [ -f "$OUT/$f" ] && { az storage blob upload --auth-mode login --account-name "$STORAGE_ACCOUNT" -c ci-results -n "$DATE/$f" -f "$OUT/$f" --overwrite --no-progress --only-show-errors --output none || RC=1; }
done
tar -C "$OUT" -czf "/tmp/genclass-ci-$DATE-app.tgz" e2e 2>/dev/null && {
  az storage blob upload --auth-mode login --account-name "$STORAGE_ACCOUNT" -c ci-results -n "$DATE/e2e-app.tgz" -f "/tmp/genclass-ci-$DATE-app.tgz" --overwrite --no-progress --only-show-errors --output none || RC=1
  rm -f "/tmp/genclass-ci-$DATE-app.tgz"
}
az storage blob upload --auth-mode login --account-name "$STORAGE_ACCOUNT" -c ci-results -n latest.json -f "$OUT/ci-result.json" --overwrite --no-progress --only-show-errors --output none || RC=1
# public mirror of every published model/runtime version (new versions only)
bash "$CI_DIR/mirror-models.sh" "$STORAGE_ACCOUNT" >> "$OUT/mirror.log" 2>&1 || RC=1

# Postgres row
psql -v ON_ERROR_STOP=1 -q -f "$CI_DIR/schema.sql" || RC=1
psql -v ON_ERROR_STOP=1 -q -v rec="$(cat "$OUT/ci-result.json")" -v ai="$(cat "$OUT/ai-summary.json" 2>/dev/null || echo '{}')" <<'SQL' || RC=1
insert into ci_results (run_date, commit, runtime_version, model_version, trials, guard_fixed, observe_detected,
                        clean_calls, latency_ms, e2e_ok, smoke_ok, ok, summary, commits_digest, ai_usage, detail)
select coalesce((r->>'date')::date, current_date), r->>'commit', r->>'runtime_version', r->>'model_version',
       (r->>'trials')::int, (r->>'guard_fixed')::int, (r->>'observe_detected')::int, (r->>'clean_calls')::int,
       (r->>'latency_ms')::int, (r->>'e2e_ok')::bool, (r->>'smoke_ok')::bool, coalesce((r->>'ok')::bool, false),
       a->>'ci_sentence', a->>'commits_digest', a->'usage', r
from (select :'rec'::jsonb as r, :'ai'::jsonb as a) x;
SQL

# keep 30 nights on the VM (the blob copy is the archive)
find /var/lib/genclass-ci/runs -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
OK=$(jq -r '.ok // false' "$OUT/ci-result.json")
echo "nightly $DATE: ok=$OK steps_rc=$RC"
[ "$OK" = "true" ] && [ "$RC" = 0 ]
