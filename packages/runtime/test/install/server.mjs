// Static file server for the install tests: mounts directories under URL prefixes, optional CORS (a CDN) and
// COOP/COEP (crossOriginIsolated pages), SPA fallback, and a request log.

import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
};

/**
 * @param {{ mounts: Record<string, string>, host?: string, port?: number, cors?: boolean, coi?: boolean | ((path: string) => boolean), fallback?: string, routes?: Record<string, (req, res) => void> }} o
 *   mounts: { "/": dir, "/model/": dir }; fallback: file served (from "/") for unknown paths without an extension
 */
export async function serve(o) {
  const mounts = Object.entries(o.mounts)
    .map(([prefix, dir]) => [prefix.endsWith("/") ? prefix : `${prefix}/`, resolve(dir)])
    .sort((a, b) => b[0].length - a[0].length);
  const log = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const path = decodeURIComponent(u.pathname);
    log.push(path);
    if (o.cors) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    }
    if (typeof o.coi === "function" ? o.coi(path) : o.coi) {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    }
    res.setHeader("Cache-Control", "no-store");
    if (o.routes?.[path]) return o.routes[path](req, res, u);
    const m = mounts.find(([prefix]) => path.startsWith(prefix) || `${path}/` === prefix);
    let file = null;
    if (m) {
      const [prefix, dir] = m;
      const rest = path.slice(prefix.length);
      const f = normalize(join(dir, rest || "index.html"));
      if (f === dir || f.startsWith(dir + sep)) {
        file = f;
        try {
          if (statSync(file).isDirectory()) file = join(file, "index.html");
        } catch {
          /* missing */
        }
      }
    }
    let st = null;
    try {
      st = file ? statSync(file) : null;
    } catch {
      st = null;
    }
    if ((!st || !st.isFile()) && o.fallback && !extname(path)) {
      file = o.fallback;
      try {
        st = statSync(file);
      } catch {
        st = null;
      }
    }
    if (!st || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Content-Length": st.size });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(o.port ?? 0, o.host ?? "127.0.0.1", r));
  const { port } = server.address();
  const host = o.host === "localhost" || !o.host ? (o.host ?? "127.0.0.1") : o.host;
  return { url: `http://${host}:${port}`, port, log, close: () => new Promise((r) => server.close(() => r())) };
}
