#!/usr/bin/env node
// genclass-runtime CLI (Node >= 20, no dependencies). Also runs as `npx @genclass/runtime <command>`.
//
//   genclass-runtime init [--mode observe|guard|heal] [--yes] [--dry-run] [--no-install] [--no-devtools]
//   genclass-runtime remove [--yes] [--dry-run] [--keep-package]
//       Set GenClass up in a project (framework detection, install, one marked import in the entry file) and take it
//       out again. Implemented in bin/lib/ (owner: INSTALL).
//   genclass-runtime fetch-model <dir> [--from <baseUrl>] [--variant q8|fp16|all] [--force] [--quiet]
//       Download a GenClass model directory (model.json + model files) so an app can self-host it:
//       GenClass.init({ model: { baseUrl: "/genclass-model/" } }). Follows redirects (GitHub release URLs work),
//       verifies sizes and sha256, skips files that are already present and valid, and writes a model.json that
//       lists exactly the downloaded files with their sizes and hashes.
//   genclass-runtime info <dir>
//       Show the model card of a directory, verify every file it lists, and check each variant's ONNX graph against
//       the card rule "any fp16 tensor -> needs: shader-f16" (WebGPU without shader-f16 cannot run fp16 tensors).

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_FROM = "https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/";
const CARD_FORMAT = "genclass-runtime-model/1";
const ROLES = ["tokenizer", "calibration", "meta"];

const USAGE = `Usage:
  genclass-runtime init [--mode observe|guard|heal] [--yes] [--dry-run] [--no-install] [--no-devtools]
  genclass-runtime remove [--yes] [--dry-run] [--keep-package]
  genclass-runtime fetch-model <dir> [--from <baseUrl>] [--variant q8|fp16|all] [--force] [--quiet]
  genclass-runtime info <dir>

init sets GenClass up in the current project (shows the diff and asks first); remove undoes it
(\`genclass-runtime init --help\` for details).
fetch-model downloads a GenClass model directory for self-hosting (default --from ${DEFAULT_FROM},
default --variant all). Serve <dir> and point the runtime at it: GenClass.init({ model: { baseUrl: "/genclass-model/" } }).`;

class UsageError extends Error {}

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") flags.help = true;
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (["force", "quiet"].includes(key)) flags[key] = true;
      else {
        const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (v === undefined) throw new UsageError(`--${key} needs a value`);
        flags[key] = v;
      }
    } else pos.push(a);
  }
  return { pos, flags };
}

const mb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} kB` : `${n} B`);
const SHA_RE = /^[0-9a-f]{64}$/;

function fileSpec(raw, where, fallback) {
  const o = typeof raw === "string" ? { file: raw } : raw || {};
  const file = typeof o.file === "string" ? o.file : fallback;
  if (!file) throw new Error(`model card: ${where} has no file name`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(file) || /^[\\/]/.test(file) || file.split(/[\\/]/).some((p) => p === ".." || p === "")) {
    throw new Error(`model card: ${where} has an invalid file name ${JSON.stringify(file)}`);
  }
  const spec = { file };
  if (o.bytes !== undefined && o.bytes !== null) spec.bytes = Number(o.bytes);
  if (o.sha256) {
    const h = String(o.sha256).toLowerCase().replace(/^sha256:/, "");
    if (!SHA_RE.test(h)) throw new Error(`model card: ${where}.sha256 is not a sha256 hex digest`);
    spec.sha256 = h;
  }
  return spec;
}

/** Same normalisation as src/model/loader.ts parseCard (runtime card or the v0.1 extension card). */
function parseCard(j) {
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("model card must be a JSON object");
  if (!j.variants || typeof j.variants !== "object" || !Object.keys(j.variants).length) throw new Error("model card has no variants");
  const variants = {};
  for (const [name, raw] of Object.entries(j.variants)) {
    const v = fileSpec(raw, `variants.${name}`);
    if (typeof raw.provider === "string") v.provider = raw.provider;
    if (typeof raw.needs === "string" && raw.needs) v.needs = raw.needs;
    variants[name] = v;
  }
  const defaults = { tokenizer: "tokenizer.json", calibration: "calibration.json", meta: "meta.json" };
  const files = {};
  for (const role of ROLES) files[role] = fileSpec((j.files || {})[role], `files.${role}`, defaults[role]);
  return {
    format: typeof j.format === "string" ? j.format : CARD_FORMAT,
    name: typeof j.name === "string" && j.name ? j.name : "genclass-model",
    version: typeof j.version === "string" && j.version ? j.version : "0.0.0",
    ...(typeof j.license === "string" ? { license: j.license } : {}),
    variants,
    files,
  };
}

// ------------------------------------------------------------------------------------- ONNX graph scan

/** Protobuf fields of buf[start, end): {field, wire, value} or {field, wire, start, end} for length-delimited ones. */
function* pbFields(buf, start, end) {
  let p = start;
  const varint = () => {
    let x = 0;
    let mul = 1;
    let b;
    do {
      b = buf[p++];
      x += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return x;
  };
  while (p < end) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) yield { field, wire, value: varint() };
    else if (wire === 1) p += 8;
    else if (wire === 2) {
      const len = varint();
      yield { field, wire, start: p, end: p + len };
      p += len;
    } else if (wire === 5) p += 4;
    else throw new Error(`not an ONNX protobuf (wire type ${wire})`);
  }
}

const FLOAT16 = 10;
const INT8 = 3;
const tensorDtype = (buf, s, e) => {
  for (const f of pbFields(buf, s, e)) if (f.field === 2 && f.wire === 0) return f.value;
  return 0;
};

function scanGraph(buf, s, e, out) {
  for (const f of pbFields(buf, s, e)) {
    if (f.wire !== 2) continue;
    if (f.field === 5) {
      // initializer (TensorProto)
      const dt = tensorDtype(buf, f.start, f.end);
      if (dt === FLOAT16) out.fp16Initializers++;
      if (dt === INT8) out.int8Initializers++;
    } else if (f.field === 1) {
      // node (NodeProto): op_type 4, attribute 5 (AttributeProto: name 1, i 3, t 5, g 6)
      let op = "";
      let castToFp16 = false;
      let fp16Const = false;
      for (const g of pbFields(buf, f.start, f.end)) {
        if (g.field === 4 && g.wire === 2) op = buf.toString("utf8", g.start, g.end);
        else if (g.field === 5 && g.wire === 2) {
          let name = "";
          let i = null;
          for (const a of pbFields(buf, g.start, g.end)) {
            if (a.field === 1 && a.wire === 2) name = buf.toString("utf8", a.start, a.end);
            else if (a.field === 3 && a.wire === 0) i = a.value;
            else if (a.field === 5 && a.wire === 2 && tensorDtype(buf, a.start, a.end) === FLOAT16) fp16Const = true;
            else if (a.field === 6 && a.wire === 2) scanGraph(buf, a.start, a.end, out); // If/Loop bodies
          }
          if (name === "to" && i === FLOAT16) castToFp16 = true;
        }
      }
      out.ops[op] = (out.ops[op] || 0) + 1;
      if (op === "Cast" && castToFp16) out.castToFp16++;
      if (fp16Const) out.fp16Constants++;
    }
  }
}

/** Op counts and fp16/int8 tensor usage of an .onnx file (no dependencies; raw tensor data is skipped). */
function scanOnnx(buf) {
  const out = { ops: {}, fp16Initializers: 0, int8Initializers: 0, castToFp16: 0, fp16Constants: 0 };
  for (const f of pbFields(buf, 0, buf.length)) if (f.field === 7 && f.wire === 2) scanGraph(buf, f.start, f.end, out);
  out.usesFp16 = out.fp16Initializers + out.castToFp16 + out.fp16Constants > 0;
  return out;
}

/** One line about a variant's graph, plus a warning when it breaks the shader-f16 card rule. */
async function graphNote(path, spec) {
  let scan;
  try {
    scan = scanOnnx(await readFile(path));
  } catch (e) {
    return { line: `graph unreadable (${e.message})`, warn: null };
  }
  const top = Object.entries(scan.ops)
    .filter(([op]) => ["MatMulNBits", "MatMul", "Gather", "GatherBlockQuantized", "MatMulInteger", "DynamicQuantizeLinear"].includes(op))
    .map(([op, n]) => `${op}×${n}`)
    .join(" ");
  const f16 = scan.usesFp16 ? `fp16 tensors (${scan.fp16Initializers} initializers, ${scan.castToFp16} casts)` : "no fp16 tensors";
  const line = `${top}; ${f16}${scan.int8Initializers ? `; ${scan.int8Initializers} int8 initializers` : ""}`;
  let warn = null;
  if (scan.usesFp16 && spec.needs !== "shader-f16") {
    warn = `${spec.file} has fp16 tensors but the card does not say "needs": "shader-f16": WebGPU devices without shader-f16 will fail it (the runtime then falls back to WASM)`;
  }
  return { line, warn };
}

async function sha256File(path) {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

async function sizeOf(path) {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

function safeJoin(dir, file) {
  const p = resolve(dir, file);
  if (p !== dir && !p.startsWith(dir + sep)) throw new Error(`refusing to write outside ${dir}: ${file}`);
  return p;
}

async function fetchOk(url) {
  let res;
  try {
    res = await fetch(url, { redirect: "follow", headers: { "user-agent": "genclass-runtime-cli" } });
  } catch (e) {
    throw new Error(`download failed for ${url}: ${e.cause?.message || e.message}`);
  }
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  return res;
}

/** Download url to path atomically, verifying size and sha256. Returns {bytes, sha256}. */
async function download(url, path, spec, log) {
  const res = await fetchOk(url);
  const total = spec.bytes ?? (Number(res.headers.get("content-length")) || 0);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.part-${process.pid}`;
  const h = createHash("sha256");
  let got = 0;
  let lastPct = -1;
  const tty = process.stderr.isTTY && !log.quiet;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      h.update(chunk);
      got += chunk.length;
      if (tty && total) {
        const pct = Math.floor((got / total) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          process.stderr.write(`\r  ${spec.file}: ${pct}% of ${mb(total)}`);
        }
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(tmp));
    if (tty && total) process.stderr.write("\r\x1b[K");
    const sha = h.digest("hex");
    if (spec.bytes !== undefined && got !== spec.bytes) throw new Error(`size mismatch for ${spec.file}: got ${got} bytes, the card says ${spec.bytes}`);
    if (spec.sha256 && sha !== spec.sha256) throw new Error(`checksum mismatch for ${spec.file}: got ${sha}, the card says ${spec.sha256}`);
    await rename(tmp, path);
    return { bytes: got, sha256: sha };
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** A local copy is valid when it matches the card's sha256 (or size, when the card has no hash). */
async function validLocal(path, spec) {
  const size = await sizeOf(path);
  if (size === null) return null;
  if (spec.bytes !== undefined && size !== spec.bytes) return null;
  if (!spec.sha256 && spec.bytes === undefined) return null; // nothing to check against: download again
  const sha = await sha256File(path);
  if (spec.sha256 && sha !== spec.sha256) return null;
  return { bytes: size, sha256: sha };
}

async function fetchModel(dirArg, flags) {
  const dir = resolve(dirArg);
  const from = new URL(String(flags.from || DEFAULT_FROM).replace(/\/?$/, "/")).href;
  const want = String(flags.variant || "all");
  const log = { quiet: !!flags.quiet };
  const say = (s) => {
    if (!log.quiet) console.log(s);
  };
  await mkdir(dir, { recursive: true });

  const cardUrl = new URL("model.json", from).href;
  say(`model card  ${cardUrl}`);
  const rawCard = await (await fetchOk(cardUrl)).json();
  const card = parseCard(rawCard);
  const variantNames = want === "all" ? Object.keys(card.variants) : want.split(",").map((s) => s.trim()).filter(Boolean);
  for (const v of variantNames) {
    if (!card.variants[v]) throw new UsageError(`variant ${v} is not in the card (has ${Object.keys(card.variants).join(", ")})`);
  }
  say(`model       ${card.name} ${card.version}${card.license ? ` (${card.license})` : ""}`);

  const jobs = [
    ...ROLES.map((role) => ({ kind: "file", key: role, spec: card.files[role] })),
    ...variantNames.map((v) => ({ kind: "variant", key: v, spec: card.variants[v] })),
  ];
  const out = { format: CARD_FORMAT, name: card.name, version: card.version, ...(card.license ? { license: card.license } : {}), variants: {}, files: {}, source: from };
  let total = 0;
  for (const job of jobs) {
    const path = safeJoin(dir, job.spec.file);
    let got = !flags.force ? await validLocal(path, job.spec) : null;
    let note = "present, verified";
    if (!got) {
      got = await download(new URL(job.spec.file, from).href, path, job.spec, log);
      note = job.spec.sha256 ? "downloaded, sha256 ok" : "downloaded (no hash in the source card)";
    }
    total += got.bytes;
    const entry = { file: job.spec.file, bytes: got.bytes, sha256: got.sha256 };
    if (job.kind === "variant") {
      if (job.spec.provider) entry.provider = job.spec.provider;
      if (job.spec.needs) entry.needs = job.spec.needs;
      out.variants[job.key] = entry;
    } else out.files[job.key] = entry;
    say(`  ${job.spec.file.padEnd(28)} ${mb(got.bytes).padStart(9)}  ${note}`);
    if (job.kind === "variant") {
      const g = await graphNote(path, job.spec);
      if (g.warn) console.warn(`  warning: ${g.warn}`);
    }
  }
  // Keep variants an earlier run downloaded (same model) that this run did not ask for, if still valid on disk.
  let prev = null;
  try {
    prev = JSON.parse(await readFile(join(dir, "model.json"), "utf8"));
  } catch {
    prev = null;
  }
  if (prev && prev.name === card.name && prev.version === card.version && prev.variants && typeof prev.variants === "object") {
    for (const [name, pv] of Object.entries(prev.variants)) {
      const spec = card.variants[name];
      if (!spec || out.variants[name] || !pv || pv.file !== spec.file) continue;
      const local = await validLocal(safeJoin(dir, spec.file), { ...spec, sha256: spec.sha256 ?? pv.sha256, bytes: spec.bytes ?? pv.bytes });
      if (!local) continue;
      out.variants[name] = { file: spec.file, bytes: local.bytes, sha256: local.sha256, ...(spec.provider ? { provider: spec.provider } : {}), ...(spec.needs ? { needs: spec.needs } : {}) };
      say(`  ${spec.file.padEnd(28)} ${mb(local.bytes).padStart(9)}  kept from an earlier fetch, verified`);
    }
  }
  // variants in the source card's order
  out.variants = Object.fromEntries(Object.keys(card.variants).filter((v) => out.variants[v]).map((v) => [v, out.variants[v]]));
  await writeFile(join(dir, "model.json"), JSON.stringify(out, null, 2) + "\n");
  say(`wrote       ${join(dir, "model.json")} (${Object.keys(out.variants).join(", ")}; ${mb(total)} downloaded or verified)`);
}

async function info(dirArg) {
  const dir = resolve(dirArg);
  const raw = JSON.parse(await readFile(join(dir, "model.json"), "utf8"));
  const card = parseCard(raw);
  console.log(`model       ${card.name} ${card.version}${card.license ? ` (${card.license})` : ""}  [${card.format}]`);
  let ok = true;
  const check = async (label, spec) => {
    const path = safeJoin(dir, spec.file);
    const size = await sizeOf(path);
    let state;
    if (size === null) {
      state = "MISSING";
      ok = false;
    } else if (spec.bytes !== undefined && size !== spec.bytes) {
      state = `SIZE MISMATCH (card ${spec.bytes})`;
      ok = false;
    } else if (spec.sha256) {
      const sha = await sha256File(path);
      state = sha === spec.sha256 ? "sha256 ok" : "SHA256 MISMATCH";
      if (sha !== spec.sha256) ok = false;
    } else state = "present (no hash in card)";
    console.log(`  ${label.padEnd(12)} ${spec.file.padEnd(28)} ${size === null ? "" : mb(size).padStart(9)}  ${state}`);
  };
  const notes = [];
  for (const [name, v] of Object.entries(card.variants)) {
    await check(`${name}${v.needs ? `*` : ""}`, v);
    if ((await sizeOf(safeJoin(dir, v.file))) !== null) notes.push([name, await graphNote(safeJoin(dir, v.file), v)]);
  }
  for (const role of ROLES) await check(role, card.files[role]);
  try {
    const meta = JSON.parse(await readFile(safeJoin(dir, card.files.meta.file), "utf8"));
    const tok = JSON.parse(await readFile(safeJoin(dir, card.files.tokenizer.file), "utf8"));
    const vocab = Object.keys(tok.model?.vocab || {}).length + (tok.added_tokens || []).filter((t) => !(t.content in (tok.model?.vocab || {}))).length;
    console.log(`meta        max_len ${meta.max_len ?? "?"}, vocab ${vocab} tokens, ${tok.model?.merges?.length ?? "?"} merges, markers ${JSON.stringify(meta.markers ?? {})}`);
    if (Array.isArray(meta.inputs)) console.log(`graph       inputs ${meta.inputs.join(", ")}; outputs ${(meta.outputs || []).join(", ")}`);
  } catch (e) {
    console.log(`meta        unreadable: ${e.message}`);
    ok = false;
  }
  if (Object.values(card.variants).some((v) => v.needs)) console.log("            * needs a WebGPU feature (e.g. shader-f16)");
  for (const [name, n] of notes) {
    console.log(`graph ${name.padEnd(6)} ${n.line}`);
    if (n.warn) console.log(`WARNING     ${n.warn}`);
  }
  if (!ok) {
    console.error("some files are missing or invalid; run fetch-model again");
    process.exitCode = 1;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "init" || argv[0] === "remove") {
    const { run } = await import("./lib/init.mjs");
    process.exitCode = await run(argv[0], argv.slice(1));
    return;
  }
  const { pos, flags } = parseArgs(argv);
  const [cmd, dir] = pos;
  if (flags.help || !cmd) {
    console.log(USAGE);
    return;
  }
  if (cmd === "fetch-model") {
    if (!dir) throw new UsageError("fetch-model needs a directory");
    await fetchModel(dir, flags);
  } else if (cmd === "info") {
    if (!dir) throw new UsageError("info needs a directory");
    await info(dir);
  } else throw new UsageError(`unknown command ${cmd}`);
}

main().catch((e) => {
  if (e instanceof UsageError) {
    console.error(`genclass-runtime: ${e.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else {
    console.error(`genclass-runtime: ${e.message}`);
    process.exitCode = 1;
  }
});
