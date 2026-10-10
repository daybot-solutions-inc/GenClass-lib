// Debug helper: one line per trial of a compat results JSON (node compat/scripts/summarize-dev.cjs <json> [filter]).
const r = require(require("node:path").resolve(process.argv[2]));
const f = process.argv[3] ? new RegExp(process.argv[3]) : null;
for (const [n, a] of Object.entries(r.apps)) {
  const b = a.boot || {};
  for (const k of ["boot", "killswitch", "devtools", "csp", "cspAll", "ssr"]) if (b[k] && !b[k].pass) console.log("BOOT", n, k, JSON.stringify({ ...b[k], genclass: undefined }).slice(0, 1500));
  if (b.ssr) console.log("SSR", n, JSON.stringify(b.ssr).slice(0, 600));
  for (const k of ["install", "build", "serve"]) if (a.steps?.[k]?.ok === false) console.log("STEP", n, k, (a.steps[k].out || a.steps[k].error || "").slice(-1500));
}
const key = (t) => `${t.app} ${t.layer} ${t.scenario} ${t.mode}`;
for (const t of r.trials.sort((a, b) => key(a).localeCompare(key(b)))) {
  if (t.mode === "offR") continue;
  const line = [
    t.app.slice(0, 8), t.layer, t.scenario, t.mode, t.seed,
    t.ok ? "" : `FAIL ${String(t.error).slice(0, 150)}`,
    `bug=${(t.bug || "-").slice(0, 70)}`,
    `ev=${(t.events || []).filter((e) => e.k !== "decide").map((e) => `${e.k}:${e.diagnosis || e.action}`).join(",").slice(0, 80)}`,
    `dec=${(t.events || []).filter((e) => e.k === "decide").length}`,
    `st=${(t.stores || []).map((s) => `${s.name}/${s.source}/${s.fields}`).join(",").slice(0, 80)}`,
    `err=${(t.errors || []).join("|").slice(0, 200)}`,
    `ms=${t.ms}`,
  ].join(" ");
  if (!f || f.test(line)) console.log(line);
}
