// Static server for built apps: http://<app>.localhost:<port>/ serves dist/apps/<app>/ (SPA fallback to
// index.html). Bundles are cacheable, so Chromium's HTTP and V8 code caches make repeated loads cheap.

import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };

export function serveApps(appsDir: string, port: number): Promise<Server> {
  const cache = new Map<string, Buffer>();
  const server = createServer((req, res) => {
    const host = String(req.headers.host ?? "").split(":")[0]!;
    const app = host.endsWith(".localhost") ? host.slice(0, -".localhost".length) : "";
    const root = join(appsDir, app);
    let p = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]!)).replace(/^(\.\.[/\\])+/, "");
    let file = join(root, p);
    if (!app || !file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
      file = join(root, "index.html");
      p = "/index.html";
    }
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end("no such app");
      return;
    }
    let body = cache.get(file);
    if (!body) {
      body = readFileSync(file);
      cache.set(file, body);
    }
    const html = p.endsWith(".html");
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": html ? "no-cache" : "public, max-age=31536000, immutable" });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
