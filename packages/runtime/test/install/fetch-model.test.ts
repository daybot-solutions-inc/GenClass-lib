// `genclass-runtime fetch-model` self-hosting: the model directory plus the onnxruntime-web files the runtime loads
// (into <dir>/ort/, the version the runtime bundles), so a page with `connect-src 'self'` can run the model (Troy
// trial, 2026-10-09). Served from a local HTTP server: no network.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORT_GLUE_FILES, ORT_WASM_FILES } from "../../src/model/backend.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, "..", "..", "bin", "genclass-runtime.mjs");
const PKG = JSON.parse(readFileSync(resolve(HERE, "..", "..", "package.json"), "utf8")) as { dependencies: Record<string, string> };
const run = promisify(execFile);

const enc = new TextEncoder();
const body = (s: string) => Buffer.from(enc.encode(s));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const MODEL: Record<string, Buffer> = {
  "tokenizer.json": body("{}"),
  "calibration.json": body("{}"),
  "meta.json": body("{}"),
  "m-q8.onnx": Buffer.alloc(64, 1),
};
const spec = (f: string) => ({ file: f, bytes: MODEL[f].length, sha256: sha(MODEL[f]) });
MODEL["model.json"] = body(
  JSON.stringify({
    format: "genclass-runtime-model/1",
    name: "toy",
    version: "1.0.0",
    variants: { q8: { ...spec("m-q8.onnx"), provider: "wasm" } },
    files: { tokenizer: spec("tokenizer.json"), calibration: spec("calibration.json"), meta: spec("meta.json") },
  }),
);
const ORT: Record<string, Buffer> = Object.fromEntries([...Object.values(ORT_WASM_FILES), ...Object.values(ORT_GLUE_FILES)].map((f, i) => [f, Buffer.alloc(100 + i, i)]));

let server: Server;
let base = "";
const hits: string[] = [];
const dirs: string[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    hits.push(url);
    const [, where, file] = /^\/(model|ort)\/(.+)$/.exec(url) ?? [];
    const b = where === "model" ? MODEL[file] : where === "ort" ? ORT[file] : undefined;
    if (!b) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-length": b.length }).end(b);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address() as { port: number };
  base = `http://127.0.0.1:${a.port}`;
});
afterAll(() => {
  server.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const fetchModel = async (...args: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), "gc-model-"));
  dirs.push(dir);
  const r = await run(process.execPath, [BIN, "fetch-model", join(dir, "genclass-model"), "--from", `${base}/model/`, "--ort-from", `${base}/ort/`, ...args], { encoding: "utf8" });
  return { dir: join(dir, "genclass-model"), out: r.stdout };
};

describe("fetch-model --ort", () => {
  it("the runtime's onnxruntime-web is pinned to an exact version (what fetch-model downloads)", () => {
    expect(PKG.dependencies["onnxruntime-web"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("default (all): model plus both ORT builds' wasm and glue in <dir>/ort/, with ort.json, and prints the init options", async () => {
    const { dir, out } = await fetchModel();
    for (const f of Object.keys(ORT)) expect(readFileSync(join(dir, "ort", f))).toEqual(ORT[f]);
    const rec = JSON.parse(readFileSync(join(dir, "ort", "ort.json"), "utf8"));
    expect(rec).toMatchObject({ name: "onnxruntime-web", version: PKG.dependencies["onnxruntime-web"] });
    expect(Object.keys(rec.files).sort()).toEqual(Object.keys(ORT).sort());
    expect(existsSync(join(dir, "model.json"))).toBe(true);
    expect(out).toContain(`GenClass.init({ model: { baseUrl: "/genclass-model/", ortWasmPaths: "/genclass-model/ort/" } })`);
    expect(out).toContain("25 MiB");
  });

  it("--ort wasm: only the WASM build, and the printed options pin device wasm; a second run re-downloads nothing", async () => {
    const { dir, out } = await fetchModel("--ort", "wasm");
    expect(existsSync(join(dir, "ort", ORT_WASM_FILES.wasm))).toBe(true);
    expect(existsSync(join(dir, "ort", ORT_WASM_FILES.webgpu))).toBe(false);
    expect(out).toContain(`device: "wasm"`);
    const n = hits.length;
    const again = await run(process.execPath, [BIN, "fetch-model", dir, "--from", `${base}/model/`, "--ort-from", `${base}/ort/`, "--ort", "wasm"], { encoding: "utf8" });
    expect(again.stdout).toContain("present, verified");
    expect(hits.slice(n).filter((u) => u.startsWith("/ort/"))).toEqual([]);
  });

  it("--ort none keeps loading ORT from jsDelivr (no ort/ directory, no ortWasmPaths)", async () => {
    const { dir, out } = await fetchModel("--ort", "none");
    expect(existsSync(join(dir, "ort"))).toBe(false);
    expect(out).toContain(`GenClass.init({ model: { baseUrl: "/genclass-model/" } })`);
  });
});
