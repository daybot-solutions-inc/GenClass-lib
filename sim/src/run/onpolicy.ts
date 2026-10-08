// On-policy decider: the runtime's own model host (MODEL's src/model/host.ts, built unmodified into
// sim/dist/model-host by `npm run build:model-host`), inline in Node on onnxruntime-web WASM, reading a TRAIN export
// directory from disk. Used for DAgger-style rows: the model acts through the runtime's real §8 gate, and the
// situations its own actions create are counterfactual-labelled.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, normalize } from "node:path";
import type { DecisionProvider } from "../types.js";

const BASE = "https://model.local/";

/**
 * Native onnxruntime-node behind the model host's ORT interface (SIM_ORT=node, the default when it is installed):
 * same tokenizer, packing, calibration and graph as the browser path, CPU execution provider, one intra-op thread per
 * worker. SIM_ORT=web forces onnxruntime-web WASM (the browser's numerics).
 */
async function nodeOrt(): Promise<unknown> {
  const ort = (await import("onnxruntime-node")) as unknown as {
    Tensor: unknown;
    InferenceSession: { create(b: Uint8Array, o: Record<string, unknown>): Promise<unknown> };
    env: { versions?: { node?: string; common?: string } };
  };
  return {
    Tensor: ort.Tensor,
    InferenceSession: {
      create: (bytes: Uint8Array, _o?: Record<string, unknown>) =>
        ort.InferenceSession.create(bytes, { executionProviders: ["cpu"], graphOptimizationLevel: "all", intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: "sequential" }),
    },
    // The host configures env.wasm (threads, proxy) and prefetches the .wasm; harmless no-ops here.
    env: { logLevel: "error", versions: { web: ort.env.versions?.common ?? "1.30.0" }, wasm: {} },
  };
}

export async function loadModelDecider(modelDir: string): Promise<{ host: DecisionProvider; name: string; ort: string }> {
  const hostUrl = new URL("./model-host/host.js", import.meta.url);
  const mod = (await import(hostUrl.href)) as { createModelHost: (o: Record<string, unknown>) => DecisionProvider };
  const require = createRequire(import.meta.url);
  // The package's exports hide package.json; its main entry lives in dist/.
  const ortDist = dirname(require.resolve("onnxruntime-web"));
  const fileFetch = async (input: unknown): Promise<Response> => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    let path: string;
    if (u.startsWith(BASE + "ort/")) path = join(ortDist, u.slice(BASE.length + 4).split("?")[0]!);
    else if (u.startsWith(BASE)) path = join(modelDir, normalize(u.slice(BASE.length).split("?")[0]!));
    else return new Response("not found", { status: 404 });
    try {
      const bytes = await readFile(path);
      return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  };
  let useNode = process.env.SIM_ORT !== "web";
  if (useNode) {
    try {
      require.resolve("onnxruntime-node");
    } catch {
      useNode = false;
    }
  }
  const host = mod.createModelHost({
    ...(useNode ? { ortLoader: () => nodeOrt() } : {}),
    baseUrl: BASE,
    worker: false,
    device: "wasm",
    preload: "eager",
    fetch: fileFetch,
    ortWasmPaths: BASE + "ort/",
    timeoutMs: 600_000,
    maxQueue: 10_000,
  });
  await host.ready();
  let name = "?";
  try {
    const card = JSON.parse(await readFile(join(modelDir, "model.json"), "utf8")) as { name?: string; version?: string };
    name = `${card.name ?? "?"}@${card.version ?? "?"}`;
  } catch {
    /* ignore */
  }
  return { host, name, ort: useNode ? "node" : "web" };
}
