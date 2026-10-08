// On-policy decider: the runtime's own model host (MODEL's src/model/host.ts, built unmodified into
// sim/dist/model-host by `npm run build:model-host`), inline in Node on onnxruntime-web WASM, reading a TRAIN export
// directory from disk. Used for DAgger-style rows: the model acts through the runtime's real §8 gate, and the
// situations its own actions create are counterfactual-labelled.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, normalize } from "node:path";
import type { DecisionProvider } from "../types.js";

const BASE = "https://model.local/";

export async function loadModelDecider(modelDir: string): Promise<DecisionProvider> {
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
  const host = mod.createModelHost({
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
  return host;
}
