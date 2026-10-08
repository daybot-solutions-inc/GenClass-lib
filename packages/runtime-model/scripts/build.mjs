#!/usr/bin/env node
// Assembles the publishable model directory files/ (model.json at its root, as the runtime's default URL
// https://cdn.jsdelivr.net/npm/@genclass/runtime-model@<version>/files/ expects) from a TRAIN export.
//
//   node scripts/build.mjs [--from <export dir>]
//
// Source (first that exists): --from, $GENCLASS_MODEL_SRC, ~/gcl/train-out/v2b/r17 (train VM), files/r17 (where
// TRAIN delivers on the Mac). Only model.json and the files it lists are copied; each is checked against its sha256
// in the source and again after copying. Subdirectories of files/ (TRAIN's drop zone) stay and are kept out of the
// package by files/.npmignore; `npm pack --dry-run` must then list exactly the expected files.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, verifyDir } from "./verify.mjs";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(PKG, "files");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const candidates = [arg("--from"), process.env.GENCLASS_MODEL_SRC, join(homedir(), "gcl/train-out/v2b/r17"), join(OUT, "r17")].filter(Boolean);
const src = candidates.map((c) => resolve(c)).find((c) => existsSync(join(c, "model.json")));
if (!src) {
  console.error(`no model export found (looked for model.json in: ${candidates.join(", ")})`);
  process.exit(1);
}

// 1. the source must be complete and match its own card
const { card, files } = await verifyDir(src);
console.log(`source  ${src}\nmodel   ${card.name} ${card.version} (${card.license ?? "no licence"})`);

// 2. a clean files/: remove top-level files (subdirectories are TRAIN's drop zone), copy the card and its files
mkdirSync(OUT, { recursive: true });
for (const e of readdirSync(OUT, { withFileTypes: true })) if (e.isFile()) rmSync(join(OUT, e.name));
for (const f of [{ file: "model.json" }, ...files]) copyFileSync(join(src, f.file), join(OUT, f.file));
writeFileSync(join(OUT, ".npmignore"), "# only the model files at this level ship; subdirectories are TRAIN's export drop zone\n*/\n");

// 3. verify the copy, strictly (nothing unlisted at the top level)
await verifyDir(OUT, { strict: true });
for (const f of files) console.log(`  ${f.file.padEnd(34)} ${(f.bytes / 1e6).toFixed(2).padStart(7)} MB  sha256 ${f.sha256.slice(0, 12)}… ok`);

// 4. what npm would publish: exactly the package files and files/<listed>
const expected = new Set(["package.json", "README.md", "MODEL_CARD.md", "LICENSE", "files/model.json", ...files.map((f) => `files/${f.file}`)]);
const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: PKG, encoding: "utf8" }))[0];
const got = new Set(packed.files.map((f) => f.path));
const extra = [...got].filter((p) => !expected.has(p));
const missing = [...expected].filter((p) => !got.has(p));
if (extra.length || missing.length) {
  console.error(`npm pack would ship the wrong files:${extra.length ? `\n  extra: ${extra.join(", ")}` : ""}${missing.length ? `\n  missing: ${missing.join(", ")}` : ""}`);
  process.exit(1);
}
console.log(`package ${packed.name}@${packed.version}: ${packed.entryCount} files, ${(packed.unpackedSize / 1e6).toFixed(2)} MB unpacked, ${(packed.size / 1e6).toFixed(2)} MB packed`);
console.log(`ok      jsDelivr: https://cdn.jsdelivr.net/npm/${packed.name}@${packed.version}/files/model.json`);
// keep the source card's hash in the log: it is the model's identity
console.log(`model.json sha256 ${await sha256(join(OUT, "model.json"))}`);
