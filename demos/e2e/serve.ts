// Static server for the built site under a sub-path (like GitHub Pages: https://user.github.io/<repo>/).
//   node e2e/serve.ts dist --base /genclass/ --port 4173
import { createServer, type Server } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

export function serveStatic(rootDir: string, base: string, port: number): Promise<Server> {
  const root = resolve(rootDir);
  const prefix = base.endsWith("/") ? base : base + "/";
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/" || url.pathname === prefix.slice(0, -1)) {
        res.writeHead(302, { location: prefix });
        res.end();
        return;
      }
      if (!url.pathname.startsWith(prefix)) {
        res.writeHead(404).end("not found");
        return;
      }
      let rel = decodeURIComponent(url.pathname.slice(prefix.length));
      if (rel === "" || rel.endsWith("/")) rel += "index.html";
      const file = normalize(join(root, rel));
      if (!file.startsWith(root)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      let st = await stat(file).catch(() => null);
      let path = file;
      if (st?.isDirectory()) {
        res.writeHead(301, { location: url.pathname + "/" });
        res.end();
        return;
      }
      if (!st) {
        // GitHub Pages serves 404.html; we just 404.
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      const headers: Record<string, string> = {
        "content-type": TYPES[extname(path)] ?? "application/octet-stream",
        "content-length": String(st.size),
        "cache-control": rel === "sw.js" || rel.endsWith(".html") ? "no-cache" : "public, max-age=600",
      };
      res.writeHead(200, headers);
      if (req.method === "HEAD") return res.end();
      createReadStream(path).pipe(res);
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => ok(server));
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--")) ?? "dist";
  const get = (k: string, d: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : d;
  };
  const base = get("base", "/genclass/");
  const port = Number(get("port", "4173"));
  await serveStatic(dir, base, port);
  console.log(`serving ${dir} at http://127.0.0.1:${port}${base}`);
}
