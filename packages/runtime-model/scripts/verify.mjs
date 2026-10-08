#!/usr/bin/env node
// Checks a model directory: model.json is a genclass-runtime-model/1 card, every file it lists exists with the
// listed size and sha256, and (for the package's files/) nothing else ships next to them.
//   node scripts/verify.mjs [dir]        (default: files/; also run by `npm pack` / `npm publish` as prepack)
// No dependencies (Node >= 20).

import { createHash } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORMAT = "genclass-runtime-model/1";
const ROLES = ["tokenizer", "calibration", "meta"];

export async function sha256(path) {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

/** The files a card lists: [{ key, file, bytes, sha256 }] (variants first, then tokenizer/calibration/meta). */
export function listed(card) {
  if (!card || card.format !== FORMAT) throw new Error(`model.json: format must be "${FORMAT}" (got ${JSON.stringify(card?.format)})`);
  const out = [];
  const add = (key, spec) => {
    if (!spec || typeof spec.file !== "string" || !spec.file) throw new Error(`model.json: ${key} has no file`);
    if (/^[a-z][a-z0-9+.-]*:/i.test(spec.file) || /^[\\/]/.test(spec.file) || spec.file.split(/[\\/]/).some((p) => p === ".." || p === "")) throw new Error(`model.json: ${key} has an invalid file name ${spec.file}`);
    if (!Number.isInteger(spec.bytes) || !/^[0-9a-f]{64}$/.test(String(spec.sha256 ?? ""))) throw new Error(`model.json: ${key} needs bytes and a sha256`);
    out.push({ key, file: spec.file, bytes: spec.bytes, sha256: spec.sha256 });
  };
  const variants = Object.entries(card.variants ?? {});
  if (!variants.length) throw new Error("model.json: no variants");
  for (const [name, spec] of variants) add(`variants.${name}`, spec);
  for (const role of ROLES) add(`files.${role}`, card.files?.[role]);
  return out;
}

/** Throws unless every listed file matches; returns the list with sizes. `strict`: no other top-level files. */
export async function verifyDir(dir, { strict = false } = {}) {
  const card = JSON.parse(readFileSync(join(dir, "model.json"), "utf8"));
  const files = listed(card);
  const problems = [];
  for (const f of files) {
    const p = join(dir, f.file);
    let size;
    try {
      size = statSync(p).size;
    } catch {
      problems.push(`${f.file}: missing`);
      continue;
    }
    if (size !== f.bytes) problems.push(`${f.file}: ${size} bytes, model.json says ${f.bytes}`);
    else if ((await sha256(p)) !== f.sha256) problems.push(`${f.file}: sha256 differs from model.json`);
  }
  if (strict) {
    const allowed = new Set(["model.json", ".npmignore", ...files.map((f) => f.file)]);
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isFile() && !allowed.has(e.name)) problems.push(`${e.name}: not listed in model.json`);
  }
  if (problems.length) throw new Error(`${dir}:\n  ${problems.join("\n  ")}`);
  return { card, files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? join(PKG, "files"));
  verifyDir(dir, { strict: !process.argv[2] }).then(
    ({ card, files }) => {
      const total = files.reduce((s, f) => s + f.bytes, 0);
      console.log(`ok  ${card.name} ${card.version}: ${files.length} files, ${(total / 1e6).toFixed(2)} MB, every sha256 matches model.json`);
    },
    (e) => {
      console.error(`verify failed: ${e.message}`);
      process.exitCode = 1;
    },
  );
}
