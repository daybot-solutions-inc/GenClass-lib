import type { WorldDef } from "../core.ts";
import { searchCities } from "../data/cities.ts";

interface SearchState {
  queries: number;
}

export const searchWorld: WorldDef<SearchState> = {
  demo: "search",
  create: () => ({ queries: 0 }),
  routes: [
    {
      method: "GET",
      pattern: /^\/search$/,
      key: () => "search",
      handle: (w, req) => {
        const q = req.query.get("q") ?? "";
        const r = searchCities(q);
        w.state.queries++;
        // Short prefixes match more cities and cost more to rank, like a real index.
        return {
          status: 200,
          json: { query: q, total: r.total, items: r.items },
          work: 10 + Math.min(r.total, 60) * 2.5,
          effect: `${r.total} matches`,
        };
      },
    },
  ],
  snapshot: (w) => ({ queries: w.state.queries }),
};
