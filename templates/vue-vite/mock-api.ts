// A tiny search API for the starter, served by Vite's dev and preview servers: GET /api/search?q=...
// Each answer takes a random 50-900 ms, so answers to earlier keystrokes can arrive after later ones, as on a
// slow network. Replace it with your own backend.
import type { Plugin } from "vite";

const CITIES = ["Amsterdam", "Athens", "Auckland", "Barcelona", "Berlin", "Bern", "Bogota", "Boston", "Brussels", "Budapest", "Cairo", "Lagos", "Lima", "Lisbon", "London", "Lyon", "Madrid", "Manila", "Melbourne", "Milan", "Montreal", "Munich", "Paris", "Porto", "Prague", "San Diego", "San Francisco", "San Jose", "Santiago", "Seattle", "Seoul", "Sydney", "Toronto", "Vienna", "Warsaw", "Zurich"];

export function mockApi(): Plugin {
  const handler = (req: { url?: string }, res: { setHeader(k: string, v: string): void; end(s: string): void }, next: () => void) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/search") return next();
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const results = q ? CITIES.filter((c) => c.toLowerCase().startsWith(q)) : [];
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ q, results }));
    }, 50 + Math.random() * 850);
  };
  return {
    name: "mock-api",
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  };
}
