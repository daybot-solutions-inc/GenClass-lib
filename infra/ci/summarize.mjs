#!/usr/bin/env node
// Turns one nightly run (model-e2e-results.json from packages/runtime-model/scripts/e2e.mjs + exit codes) into the
// compact CI record stored in blob ci-results/<date>/ci-result.json and in Postgres table ci_results.
//   guard_fixed       trials in guard:balanced where the newer query is shown at the end (the bug was prevented)
//   observe_detected  trials in observe:balanced with at least one detection (observe never acts)
//   clean_calls       model calls on clean typing (slow + fast), summed over all modes: must be 0
//   latency_ms        median decision latency over every decision in every mode
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const out = args.out;
const file = join(out, "model-e2e-results.json");
const e2e = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
const ver = (tgz, re) => (tgz ? (re.exec(basename(tgz)) ?? [])[1] ?? null : null);
const modes = e2e?.modes ?? {};
const m = (k) => modes[k];
const allDecisions = Object.values(modes).flatMap((r) => (r.trials ?? []).flatMap((t) => t.decisions ?? []));
const lat = allDecisions.map((d) => d.latencyMs).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
const median = lat.length ? lat[Math.floor(lat.length / 2)] : null;
const guard = m("guard:balanced");
const observe = m("observe:balanced");

const record = {
  date: new Date().toISOString().slice(0, 10),
  finished_at: new Date().toISOString(),
  commit: args.commit ?? null,
  runtime_version: e2e?.versions?.["@genclass/runtime"] ?? ver(args["runtime-tgz"], /^genclass-runtime-(.+)\.tgz$/),
  model_version: e2e?.versions?.["@genclass/runtime-model"] ?? ver(args["model-tgz"], /^genclass-runtime-model-(.+)\.tgz$/),
  e2e_ok: args["e2e-rc"] === "0" && !!e2e,
  smoke_ok: args["smoke-rc"] === "0",
  trials: guard?.trials?.length ?? 0,
  guard_fixed: guard ? guard.trials.filter((t) => t.correctAtEnd).length : null,
  guard_actions: guard ? guard.trials.reduce((s, t) => s + t.actions, 0) : null,
  observe_detected: observe ? observe.trials.filter((t) => t.detections > 0).length : null,
  observe_correct_at_end: observe ? observe.trials.filter((t) => t.correctAtEnd).length : null,
  clean_calls: Object.keys(modes).length ? Object.values(modes).reduce((s, r) => s + (r.cleanSlow?.modelCalls ?? 0) + (r.cleanFast?.modelCalls ?? 0), 0) : null,
  latency_ms: median === null ? null : Math.round(median),
  model_state: guard?.status?.state ?? null,
  device: guard?.status?.device ?? null,
  per_mode: Object.fromEntries(
    Object.entries(modes).map(([k, r]) => [
      k,
      {
        fixed: r.trials.filter((t) => t.correctAtEnd).length,
        detected: r.trials.filter((t) => t.detections > 0).length,
        actions: r.trials.reduce((s, t) => s + t.actions, 0),
        clean_calls: (r.cleanSlow?.modelCalls ?? 0) + (r.cleanFast?.modelCalls ?? 0),
        errors: (r.errors ?? []).length,
      },
    ]),
  ),
  self_host_ok: e2e?.selfHost?.ok ?? null,
  seconds: Number(args.seconds) || null,
};
record.ok = record.e2e_ok && record.smoke_ok && record.clean_calls === 0;
writeFileSync(join(out, "ci-result.json"), JSON.stringify(record, null, 2));
console.log(JSON.stringify(record));
