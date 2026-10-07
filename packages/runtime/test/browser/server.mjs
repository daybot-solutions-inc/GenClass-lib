// Static server for the browser tests: the bundled test app, the model directory, onnxruntime-web's dist, and the
// same three under /coi/ with COOP/COEP headers (crossOriginIsolated pages: WASM threads). Logs every request.

import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".map": "application/json",
};

export function ortDistDir() {
  const require = createRequire(import.meta.url);
  // "./package.json" is not exported; the wasm files are (and live in dist/)
  return dirname(require.resolve("onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm"));
}

/** @returns {Promise<{ url: string, log: {path: string, t: number}[], close: () => Promise<void> }>} */
export async function startServer({ appDir, modelDir }) {
  const roots = { app: resolve(appDir), model: resolve(modelDir), ort: resolve(ortDistDir()) };
  const log = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    log.push({ path: u.pathname, t: Date.now() });
    let path = decodeURIComponent(u.pathname);
    const coi = path.startsWith("/coi/");
    if (coi) path = path.slice(4);
    const [, top, ...rest] = path.split("/");
    const root = roots[top];
    if (coi) {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    }
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cache-Control", "no-store");
    if (!root) {
      res.writeHead(404).end("not found");
      return;
    }
    const file = normalize(join(root, rest.join("/") || "index.html"));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    let st;
    try {
      st = statSync(file);
    } catch {
      res.writeHead(404).end("not found");
      return;
    }
    if (!st.isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Content-Length": st.size });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, log, close: () => new Promise((r) => server.close(() => r())) };
}
