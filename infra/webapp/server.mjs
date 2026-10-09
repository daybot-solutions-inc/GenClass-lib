// Static server for the GenClass demo site on Azure App Service (Linux, Node 22). Zero dependencies.
// Deployed next to the built demos/dist files (see infra/webapp/deploy.sh). App Service terminates HTTPS, which the
// demos need for their Service Worker mock backend; this adds the right MIME types (wasm, module workers), no-cache
// for sw.js and HTML, and Service-Worker-Allowed. Application Insights is attached by App Service's Node agent
// (APPLICATIONINSIGHTS_CONNECTION_STRING + ApplicationInsightsAgent_EXTENSION_VERSION=~3), not by code here.
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(process.env.SITE_ROOT || join(dirname(fileURLToPath(import.meta.url)), "site"));
const PORT = Number(process.env.PORT || 8080);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = normalize(join(ROOT, rel));
    if (!file.startsWith(ROOT)) return void res.writeHead(403).end("forbidden");
    const st = await stat(file).catch(() => null);
    if (st?.isDirectory()) return void res.writeHead(301, { location: url.pathname + "/" + url.search }).end();
    if (!st) return void res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    const name = rel.split("/").pop();
    const headers = {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "content-length": String(st.size),
      "cache-control": name === "sw.js" || file.endsWith(".html") || name === "build.json" ? "no-cache" : "public, max-age=3600",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    };
    if (name === "sw.js") headers["service-worker-allowed"] = "/";
    res.writeHead(200, headers);
    if (req.method === "HEAD") return void res.end();
    createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
}).listen(PORT, () => console.log(`genclass demos: ${ROOT} on :${PORT}`));
