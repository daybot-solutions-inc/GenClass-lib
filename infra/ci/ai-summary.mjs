#!/usr/bin/env node
// Nightly AI notes (Foundry Models, Azure OpenAI deployment on the existing OpenAI-Daybot resource, called with the
// VM's managed identity; no key on disk). Two small calls:
//   1. ci_sentence:     one sentence on tonight's result, flagging any change against the previous night
//   2. commits_digest:  up to 6 bullets on what changed on the `runtime` branch in the last 24 h (from git log)
// Usage: ai-summary.mjs <out-dir> <prev-record.json|-> <commits.txt>
// Env: AOAI_ENDPOINT (https://<name>.cognitiveservices.azure.com/), AOAI_DEPLOYMENT, AOAI_API_VERSION (optional).
// Writes <out-dir>/ai-summary.json. Never fails the CI: errors are recorded in the file.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [out, prevFile, commitsFile] = process.argv.slice(2);
const endpoint = (process.env.AOAI_ENDPOINT || "").replace(/\/?$/, "/");
const deployment = process.env.AOAI_DEPLOYMENT || "gpt-5.6-sol";
const apiVersion = process.env.AOAI_API_VERSION || "2025-04-01-preview";
const read = (f, max = 1e6) => (f && f !== "-" && existsSync(f) ? readFileSync(f, "utf8").slice(0, max) : "");

async function token() {
  const u = "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fcognitiveservices.azure.com";
  const r = await fetch(u, { headers: { Metadata: "true" } });
  if (!r.ok) throw new Error(`IMDS ${r.status}`);
  return (await r.json()).access_token;
}

async function chat(tok, system, user, maxTokens) {
  const r = await fetch(`${endpoint}openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "system", content: system }, { role: "user", content: user }], max_completion_tokens: maxTokens }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return { text: (j.choices?.[0]?.message?.content ?? "").trim(), usage: j.usage };
}

const result = { deployment, at: new Date().toISOString(), usage: [] };
try {
  const tok = await token();
  const record = read(join(out, "ci-result.json"));
  const e2e = JSON.parse(read(join(out, "model-e2e-results.json")) || "{}");
  for (const r of Object.values(e2e.modes ?? {})) delete r.consoleLines; // keep the input small
  const prev = read(prevFile);
  const a = await chat(
    tok,
    "You write the one-line status for a nightly CI of @genclass/runtime (a client-side runtime that prevents stale writes in web apps) tested against its published npm packages. Be factual and terse. Mention versions, guard fixes out of trials, observe detections, clean-run model calls (must be 0) and decision latency; flag any regression against the previous night. One sentence, no markdown.",
    `Tonight's record:\n${record}\n\nPrevious night's record (may be empty):\n${prev}\n\nFull e2e results (JSON, truncated):\n${JSON.stringify(e2e).slice(0, 40000)}`,
    1500,
  );
  result.ci_sentence = a.text;
  result.usage.push(a.usage);
  const commits = read(commitsFile, 50000);
  if (commits.trim()) {
    const b = await chat(
      tok,
      "Summarise the last 24 hours of commits on the GenClass-lib `runtime` branch for the team: at most 6 short plain-text bullets, most important first (runtime behaviour, model, releases, benchmarks). No speculation.",
      commits,
      2000,
    );
    result.commits_digest = b.text;
    result.usage.push(b.usage);
  } else result.commits_digest = "No commits in the last 24 hours.";
} catch (e) {
  result.error = String(e.message ?? e).slice(0, 500);
}
writeFileSync(join(out, "ai-summary.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
