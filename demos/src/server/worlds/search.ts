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
        // Short prefixes match more rows and cost more to rank, like a real search backend (1 letter ≈ 0.4 s).
        return {
          status: 200,
          json: { query: q, total: r.total, items: r.items },
          work: 20 + Math.min(r.total, 60) * 9,
          effect: `${r.total} matches`,
        };
      },
    },
  ],
  snapshot: (w) => ({ queries: w.state.queries }),
};
