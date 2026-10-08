import type { AppManifest } from "../../src/shared/manifest.js";

const cats = ["cafe", "park", "museum", "market"];
const names: Record<string, string[]> = { cafe: ["Bean There", "Steam Room", "Daily Grind", "Kettle & Co"], park: ["Linden Green", "Mill Pond", "Fox Hill", "River Walk"], museum: ["City Museum", "Rail Heritage", "Glass House", "Map Archive"], market: ["Corn Exchange", "Night Market", "Flower Hall", "Fish Quay"] };
const pins: Record<string, unknown>[] = [];
let id = 1;
for (let tx = 0; tx < 4; tx++)
  for (let ty = 0; ty < 4; ty++)
    for (let k = 0; k < 2 + ((tx + ty) % 2); k++) {
      const cat = cats[(tx * 3 + ty + k) % 4]!;
      pins.push({ id: id++, tile: `${tx}-${ty}`, x: tx * 100 + ((k * 37 + ty * 11) % 100), y: ty * 100 + ((k * 53 + tx * 17) % 100), category: cat, name: `${names[cat]![(tx + k) % 4]} ${tx}${ty}` });
    }

const manifest: AppManifest = {
  name: "preact-mappins",
  title: "Neighbourhood map",
  framework: "preact",
  libs: ["preact", "@preact/signals", "fetch", "rt.atom", "atomSignal"],
  domain: "map-pins",
  entry: "main.tsx",
  integration: "stores",
  server: { base: "/api", collections: [{ name: "pins", seed: pins, filters: ["tile", "category"], envelope: "items", pageSize: 20, required: ["name", "tile"] }] },
  variants: {
    viewportSeq: ["latest", "blind"],
    cache: ["per-tile", "none"],
    addGuard: ["disable", "none"],
    clusterCount: ["derive", "incremental"],
  },
  affordances: [
    { id: "pan", kind: "click", sel: "nav.pan button", text: ["North", "South", "East", "West"], weight: 3, mode: "replace", key: "viewport", impatientP: 0.1 },
    { id: "category", kind: "select", sel: "select[name=category]", values: ["all", "cafe", "park", "museum", "market"], weight: 1.5, mode: "replace" },
    { id: "cluster", kind: "click", sel: "li.cluster button.expand", nth: 4, weight: 1.5, mode: "replace", key: "cluster" },
    { id: "pinName", kind: "type", sel: "input[name=pinName]", values: ["Book swap", "Bike repair", "Pop-up bakery", "Street piano"], clear: true, weight: 1.2, mode: "replace", then: ["addPin"] },
    { id: "addPin", kind: "click", sel: "form.add-pin button", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.18, impatientP: 0.2 },
  ],
  external: [{ kind: "create", target: "pins", perMin: 2, data: [{ tile: "1-1", x: 150, y: 140, category: "cafe", name: "New cafe 11" }, { tile: "2-1", x: 230, y: 120, category: "market", name: "Craft fair 21" }, { tile: "1-2", x: 160, y: 250, category: "park", name: "Pocket park 12" }] }],
  weights: { "map.error": 0, "map.notice": 0, "map.loading": 0.1, "map.adding": 0.1, "map.draft": 0.3 },
  relations: [
    { name: "cluster total = pins in view", fields: ["map.clustered", "map.pins"], check: (s) => !s.map || s.map.loading || s.map.clustered === s.map.pins.length },
    { name: "pins are in the viewport", fields: ["map.pins", "map.cx"], check: (s) => !s.map || s.map.loading || s.map.pins.every((p: { tile: string }) => { const [x, y] = p.tile.split("-").map(Number); return Math.abs(x! - s.map.cx - 0.5) <= 1 && Math.abs(y! - s.map.cy - 0.5) <= 1; }) },
  ],
  errorSelector: "[role=alert]",
  build: { jsx: "preact" },
  sessionMs: [25000, 60000],
};
export default manifest;
