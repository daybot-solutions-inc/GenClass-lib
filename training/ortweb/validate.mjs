// Validate an exported runtime model directory with onnxruntime-web (WASM backend in Node) and onnxruntime-node.
//   node validate.mjs <export dir> [variant=q8] [maxRequests=60]
// Feeds come from pack_fixtures.json (the Python packer's output, built exactly like genclass_export.plan_inputs);
// logits are compared with torch_fixtures.json (PyTorch FastEngine). Writes ortweb_report.json into the dir.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const dir = process.argv[2];
const variant = process.argv[3] || "q8";
const maxReq = Number(process.argv[4] || 60);
const card = JSON.parse(fs.readFileSync(path.join(dir, "model.json"), "utf8"));
const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
const packs = JSON.parse(fs.readFileSync(path.join(dir, "pack_fixtures.json"), "utf8")).slice(0, maxReq);
const torchFx = JSON.parse(fs.readFileSync(path.join(dir, "torch_fixtures.json"), "utf8")).slice(0, maxReq);
const modelPath = path.join(dir, card.variants[variant].file);
const modelBytes = fs.readFileSync(modelPath);

function feedsFor(ort, p) {
  const by = { choice: [], score: [], noul: [] };
  for (const qi of Object.values(p.q_index)) by[qi.kind].push(qi);
  const I64 = (arr, dims) => new ort.Tensor("int64", BigInt64Array.from(arr.map((x) => BigInt(x))), dims);
  const grp = (lst) => {
    if (!lst.length) return [I64([0], [1]), I64([0], [1, 1])];
    const k = Math.max(...lst.map((q) => q.item_pos.length));
    const items = [];
    for (const q of lst) for (let j = 0; j < k; j++) items.push(j < q.item_pos.length ? q.item_pos[j] : 0);
    return [I64(lst.map((q) => q.q_pos), [lst.length]), I64(items, [lst.length, k])];
  };
  const [cq, ci] = grp(by.choice);
  const [sq, si] = grp(by.score);
  const nl = by.noul;
  const L = p.input_ids.length;
  return {
    feeds: {
      input_ids: I64(p.input_ids, [1, L]), position_ids: I64(p.position_ids, [1, L]),
      q_group: I64(p.q_group, [1, L]), i_group: I64(p.i_group, [1, L]),
      choice_q: cq, choice_items: ci, score_q: sq, score_items: si,
      noul_q: I64(nl.length ? nl.map((q) => q.q_pos) : [0], [Math.max(nl.length, 1)]),
      noul_t: I64(nl.length ? nl.map((q) => q.item_pos[0]) : [0], [Math.max(nl.length, 1)]),
      noul_f: I64(nl.length ? nl.map((q) => q.item_pos[1]) : [0], [Math.max(nl.length, 1)]),
    },
    by,
  };
}

function unpack(by, outs, p) {
  const res = {};
  const idx = { choice: 0, score: 0, noul: 0 };
  for (const [qid, qi] of Object.entries(p.q_index)) {
    const g = idx[qi.kind]++;
    if (qi.kind === "noul") { res[qid] = [outs.noul_logits.data[g]]; continue; }
    const t = qi.kind === "choice" ? outs.choice_logits : outs.score_logits;
    const K = t.dims[1];
    res[qid] = Array.from(t.data.slice(g * K, g * K + qi.labels.length));
  }
  return res;
}

async function run(name, ort, opts) {
  const sess = await ort.InferenceSession.create(modelBytes, opts);
  const missing = meta.inputs.filter((x) => !sess.inputNames.includes(x));
  let worst = 0, agree = 0, tot = 0;
  const ms = [];
  for (let i = 0; i < packs.length; i++) {
    const p = packs[i];
    const { feeds } = feedsFor(ort, p);
    const t0 = performance.now();
    const outs = await sess.run(feeds);
    ms.push(performance.now() - t0);
    const got = unpack(null, outs, p);
    for (const [qid, z] of Object.entries(got)) {
      const ref = torchFx[i].logits[qid];
      for (let j = 0; j < z.length; j++) worst = Math.max(worst, Math.abs(z[j] - ref[j]));
      if (z.length > 1) {
        tot++;
        const am = (a) => a.indexOf(Math.max(...a));
        agree += am(z) === am(ref) ? 1 : 0;
      }
    }
  }
  ms.sort((a, b) => a - b);
  const tokens = packs.map((p) => p.input_ids.length).sort((a, b) => a - b);
  return { backend: name, missing_inputs: missing, requests: packs.length, max_abs_logit: worst,
           argmax_agree: agree, argmax_total: tot, ms_p50: ms[Math.floor(ms.length / 2)], ms_p90: ms[Math.floor(ms.length * 0.9)],
           tokens_p50: tokens[Math.floor(tokens.length / 2)] };
}

const report = { dir, variant, file: card.variants[variant].file, bytes: modelBytes.length, results: [] };
const require = createRequire(import.meta.url);
try {
  const ortNode = require("onnxruntime-node");
  report.results.push(await run("onnxruntime-node (cpu, 4 threads)", ortNode, { executionProviders: ["cpu"], intraOpNumThreads: 4 }));
  report.results.push(await run("onnxruntime-node (cpu, 1 thread)", ortNode, { executionProviders: ["cpu"], intraOpNumThreads: 1 }));
} catch (e) { report.results.push({ backend: "onnxruntime-node", error: String(e && e.message || e) }); }
for (const threads of [1, 4]) {
  try {
    const ortWeb = await import("onnxruntime-web");
    const ort = ortWeb.default || ortWeb;
    ort.env.wasm.numThreads = threads;
    ort.env.wasm.wasmPaths = path.join(path.dirname(require.resolve("onnxruntime-web")), "/");
    report.results.push(await run(`onnxruntime-web ${ort.env.versions?.web || ""} (wasm, ${threads} thread${threads > 1 ? "s" : ""})`, ort,
      { executionProviders: ["wasm"] }));
  } catch (e) { report.results.push({ backend: `onnxruntime-web wasm ${threads}t`, error: String(e && e.stack || e).slice(0, 600) }); }
}
const out = path.join(dir, `ortweb_report_${variant}.json`);
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
