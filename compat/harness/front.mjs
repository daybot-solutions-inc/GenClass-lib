// The origin the browser talks to in a compat trial: one HTTP server per runner worker that
//   - answers /api/*, /graphql, /sse/* and the /ws WebSocket from that worker's mock backend (same origin as the
//     app, as in production: GenClass treats cross-origin requests as passive);
//   - serves /__genclass/* from the extracted @genclass/runtime tarball (the plain-HTML app's "CDN");
//   - proxies everything else to the app's own server (Next.js, SvelteKit, Angular SSR, vite preview), or serves a
//     static build directory with an SPA fallback;
//   - optionally adds a Content-Security-Policy header to HTML responses (the CSP boot check).

import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

function serveFile(res, file, extraHeaders = {}) {
  const type = MIME[extname(file)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": "no-store", ...(type.startsWith("text/html") ? extraHeaders : {}) });
  createReadStream(file).pipe(res);
}

function safeJoin(root, urlPath) {
  const p = normalize(join(root, decodeURIComponent(urlPath)));
  return p.startsWith(resolve(root)) ? p : null;
}

function serveStatic(root, urlPath, res, { fallback, headers }) {
  let f = safeJoin(root, urlPath);
  if (f && existsSync(f) && statSync(f).isDirectory()) f = join(f, "index.html");
  if (f && existsSync(f) && statSync(f).isFile()) return serveFile(res, f, headers), true;
  if (fallback && !extname(urlPath)) {
    const fb = join(root, fallback);
    if (existsSync(fb)) return serveFile(res, fb, headers), true;
  }
  return false;
}

/**
 * startFront({ backend, upstream?: "http://127.0.0.1:port", staticDir?, pkgDir?, port? })
 * -> { url, port, setCsp(policy|null), close() }
 */
export function startFront({ backend, upstream = null, staticDir = null, pkgDir = null, port = 0 }) {
  let csp = null;
  const htmlHeaders = () => (csp ? { "content-security-policy": csp } : {});
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    try {
      if (await backend.handle(req, res, url)) return;
      if (pkgDir && url.pathname.startsWith("/__genclass/")) {
        res.setHeader?.("access-control-allow-origin", "*");
        if (serveStatic(pkgDir, url.pathname.slice("/__genclass".length), res, {})) return;
        res.writeHead(404).end();
        return;
      }
      if (staticDir) {
        if (serveStatic(staticDir, url.pathname, res, { fallback: "index.html", headers: htmlHeaders() })) return;
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      if (upstream) return proxy(req, res);
      res.writeHead(404).end();
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(e?.stack ?? e));
    }
  });

  function proxy(req, res) {
    const u = new URL(upstream);
    const headers = { ...req.headers, host: u.host };
    delete headers["accept-encoding"]; // keep HTML bodies readable for the CSP header and SSR checks
    const preq = http.request({ hostname: u.hostname, port: u.port, path: req.url, method: req.method, headers }, (pres) => {
      const h = { ...pres.headers };
      if (csp && String(h["content-type"] ?? "").includes("text/html")) h["content-security-policy"] = csp;
      res.writeHead(pres.statusCode ?? 502, h);
      pres.pipe(res);
    });
    preq.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`upstream error: ${e.message}`);
    });
    req.pipe(preq);
  }

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/ws") return backend.handleUpgrade(req, socket, head);
    socket.destroy();
  });

  return new Promise((resolveP) => {
    server.listen(port, "127.0.0.1", () => {
      const p = server.address().port;
      resolveP({
        url: `http://127.0.0.1:${p}`,
        port: p,
        setCsp: (policy) => (csp = policy),
        close: () =>
          new Promise((r) => {
            server.close(() => r());
            server.closeAllConnections?.();
          }),
        server,
      });
    });
  });
}
