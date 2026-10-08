import type { AppManifest } from "../../src/shared/manifest.js";

const cities = ["Toronto", "Ottawa", "Montreal", "Waterloo"];
const kinds = ["condo", "townhouse", "semi", "bungalow", "loft", "duplex"];
const streets = ["Queen West", "the Glebe", "Plateau", "Uptown", "Leslieville", "Westboro", "Mile End", "Lakeshore", "Beechwood", "Little Italy"];
const listings = Array.from({ length: 30 }, (_, i) => {
  const beds = 1 + ((i * 7 + Math.floor(i / 4)) % 4);
  return { id: 2100 + i, title: `${beds}-bed ${kinds[i % kinds.length]} near ${streets[(i * 3) % streets.length]}`, city: cities[i % 4], beds, price: 420000 + ((i * 37) % 23) * 25000, sqft: 600 + ((i * 53) % 18) * 80, listedAt: 60 - i };
});

const manifest: AppManifest = {
  name: "valtio-homes",
  title: "Homes for sale",
  framework: "react",
  libs: ["react", "valtio", "useSnapshot", "axios", "rt.guard"],
  domain: "real-estate",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "listings", seed: listings, filters: ["city", "beds"], search: ["title"], envelope: "data", pageSize: 6, actions: { priceCut: { inc: "price" } } },
      { name: "favorites", seed: [{ id: 1, listingId: 2101 }, { id: 2, listingId: 2106 }], unique: ["listingId"], required: ["listingId"], envelope: "data", pageSize: 50 },
    ],
  },
  variants: {
    append: ["dedupe", "blind"],
    moreGuard: ["pending", "none"],
    filterSeq: ["latest", "blind"],
    fav: ["rollback", "optimistic"],
    favGuard: ["pending", "none"],
    favCount: ["derive", "incremental"],
  },
  affordances: [
    { id: "city", kind: "select", sel: "select[name=city]", values: ["all", ...cities], weight: 1.2, mode: "replace" },
    { id: "beds", kind: "select", sel: "select[name=beds]", values: ["any", "1", "2", "3", "4"], weight: 0.8, mode: "replace" },
    { id: "more", kind: "click", sel: "button.more", weight: 2.5, mode: "accumulate", dblclickP: 0.2, impatientP: 0.25, requires: "button.more" },
    { id: "fav", kind: "click", sel: "li.listing button.fav", nth: 8, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.15, requires: "li.listing button.fav" },
  ],
  external: [
    { kind: "create", target: "listings", perMin: 1.5, data: [{ title: "2-bed townhouse near Bloordale", city: "Toronto", beds: 2, price: 815000, sqft: 1100, listedAt: 100 }, { title: "1-bed condo near ByWard Market", city: "Ottawa", beds: 1, price: 399000, sqft: 610, listedAt: 100 }, { title: "3-bed duplex near Verdun", city: "Montreal", beds: 3, price: 629000, sqft: 1500, listedAt: 100 }, { title: "2-bed semi near Uptown Waterloo", city: "Waterloo", beds: 2, price: 579000, sqft: 1050, listedAt: 100 }, { title: "2-bed condo near the Distillery", city: "Toronto", beds: 2, price: 689000, sqft: 840, listedAt: 100 }, { title: "3-bed semi near Hintonburg", city: "Ottawa", beds: 3, price: 745000, sqft: 1420, listedAt: 100 }, { title: "1-bed loft near Griffintown", city: "Montreal", beds: 1, price: 459000, sqft: 690, listedAt: 100 }, { title: "4-bed bungalow near Laurelwood", city: "Waterloo", beds: 4, price: 899000, sqft: 2100, listedAt: 100 }] },
    { kind: "action", target: "listings", perMin: 2, verb: "priceCut", by: -15000 },
    { kind: "delete", target: "favorites", perMin: 0.3 },
  ],
  weights: { "homes.error": 0, "homes.notice": 0, "homes.loading": 0.1, "homes.loadingMore": 0.1, "homes.pending": 0.1, "homes.city": 0.3, "homes.beds": 0.3 },
  relations: [
    { name: "saved count = saved listings", fields: ["homes.favCount", "homes.favs"], check: (s) => !s.homes || s.homes.favCount === Object.keys(s.homes.favs).length },
    { name: "no listing twice", fields: ["homes.items"], check: (s) => !s.homes || new Set(s.homes.items.map((l: { id: number }) => l.id)).size === s.homes.items.length },
    {
      name: "results match the filters",
      fields: ["homes.items", "homes.city", "homes.beds"],
      check: (s) => !s.homes || s.homes.loading || s.homes.items.every((l: { city: string; beds: number }) => (s.homes.city === "all" || l.city === s.homes.city) && (s.homes.beds === "any" || String(l.beds) === s.homes.beds)),
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
