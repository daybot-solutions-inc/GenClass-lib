import type { AppManifest } from "../../src/shared/manifest.js";

const works: [string, string, string, number, string][] = [
  ["Portrait of a Woman in Blue", "Elin Hart", "paintings", 1911, "Gallery 4"], ["Harbour at Dusk", "Tomas Weir", "paintings", 1887, "Gallery 2"],
  ["Study of Hands", "Clara Voss", "drawings", 1902, "Storage B"], ["River Crossing, Winter", "Jun Takeda", "prints", 1931, "Gallery 7"],
  ["Lidded Tea Vase", "Kiln of Arita", "ceramics", 1690, "Gallery 9"], ["Walnut Writing Desk", "Hollis & Sons", "furniture", 1774, "Gallery 11"],
  ["Market Square, Morning", "Elin Hart", "paintings", 1915, "Conservation"], ["Fishermen Mending Nets", "Paul Roux", "photographs", 1926, "Storage A"],
  ["Embroidered Wedding Coverlet", "Unknown maker", "textiles", 1820, "Gallery 12"], ["Self-portrait with Hat", "Tomas Weir", "paintings", 1893, "Gallery 2"],
  ["Mountain Pass Study", "Clara Voss", "drawings", 1907, "Storage B"], ["Night Ferry", "Jun Takeda", "prints", 1934, "Storage C"],
  ["Celadon Bowl", "Longquan kilns", "ceramics", 1300, "Gallery 9"], ["Lacquered Cabinet", "Workshop of Ito", "furniture", 1850, "Gallery 11"],
  ["Street Musicians", "Paul Roux", "photographs", 1929, "Gallery 6"], ["Still Life with Lemons", "Marta Aalto", "paintings", 1938, "Gallery 5"],
  ["Silk Panel with Cranes", "Unknown maker", "textiles", 1780, "Storage D"], ["Quarry Workers", "Marta Aalto", "drawings", 1936, "Gallery 5"],
  ["Orchard in Bloom", "Tomas Weir", "paintings", 1899, "Gallery 3"], ["Tin-glazed Charger", "Delft workshop", "ceramics", 1700, "Gallery 10"],
];
const objects = works.map(([title, maker, dept, year, location], i) => ({
  id: 4100 + i,
  accession: `19${String(10 + i).padStart(2, "0")}.${(i * 7) % 40}`,
  title,
  maker,
  dept,
  year,
  location,
  label: `${title} — ${maker}, ${year}.`,
}));

const manifest: AppManifest = {
  name: "mithril-museum",
  title: "Collection catalogue",
  framework: "mithril",
  libs: ["mithril", "m.request(XHR)", "rt.atom", "hover prefetch cache"],
  domain: "museum-collection-catalogue",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "objects", seed: objects, versioned: true, search: ["title", "maker"], filters: ["dept"], envelope: "items", pageSize: 8 },
      { name: "loans", seed: [], unique: ["key"], required: ["objectId", "venue"], filters: ["curator"], envelope: "items" },
    ],
  },
  variants: {
    prefetch: ["newer-only", "blind"],
    detailSeq: ["latest", "blind"],
    labelSave: ["if-match", "force"],
    echo: ["keep-newer-typing", "blind"],
    loanGuard: ["pending", "none"],
  },
  affordances: [
    { id: "dept", kind: "select", sel: "select[name=dept]", values: ["all", "paintings", "paper", "objects"], weight: 0.8, mode: "replace", key: "list" },
    { id: "search", kind: "type", sel: "input[name=q]", values: ["hart", "voss", "aalto", "roux", "portrait", "study"], clear: true, weight: 0.8, mode: "replace", key: "list" },
    { id: "page", kind: "click", sel: "nav.pages button", nth: 3, weight: 0.6, mode: "replace", key: "list" },
    { id: "hover", kind: "hover", sel: "tr.object", nth: 8, weight: 1.5, mode: "replace", key: "hover", intent: "nth" },
    { id: "open", kind: "click", sel: "tr.object button.open", nth: 8, weight: 2.5, mode: "replace", key: "open", dblclickP: 0.1, requires: "tr.object button.open" },
    { id: "hoverOpen", kind: "hover", sel: "tr.object.open", weight: 1, mode: "replace", key: "hover", requires: "tr.object.open", after: ["open"] },
    { id: "label", kind: "type", sel: "section.detail textarea[name=label]", values: [" Gift of the artist's family.", " On view after conservation.", " Purchased 1952.", " Lent by a private collection."], weight: 3, mode: "replace", key: "label", requires: "section.detail textarea[name=label]", after: ["open"] },
    { id: "venue", kind: "select", sel: "section.detail select[name=venue]", values: ["Tate Liverpool", "Rijksmuseum", "Art Institute of Chicago", "National Gallery of Canada"], weight: 1, mode: "replace", requires: "section.detail select[name=venue]", after: ["open"], then: ["loan"] },
    { id: "loan", kind: "click", sel: "section.detail button.loan", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.2, impatientP: 0.2 },
  ],
  external: [
    { kind: "update", target: "objects", perMin: 3, where: { dept: "paintings" }, data: [{ label: "Label revised by the registrar." }, { location: "Conservation" }, { location: "Gallery 4" }] },
    { kind: "update", target: "objects", perMin: 2, data: [{ location: "Storage A" }, { location: "On loan" }] },
  ],
  weights: { "catalogue.error": 0, "catalogue.notice": 0, "catalogue.loading": 0.1, "catalogue.q": 0.3, "detail.loading": 0.1, "detail.saving": 0.1, "detail.dirty": 0.1, "detail.draft": 0.3, "loans.busy": 0.1, "loans.venue": 0.3 },
  relations: [
    { name: "the open record is the object opened", fields: ["detail.obj", "detail.id"], check: (s) => !s.detail || !s.detail.obj || s.detail.obj.id === s.detail.id },
    {
      name: "rows belong to the department filter",
      fields: ["catalogue.rows", "catalogue.group"],
      check: (s) => {
        const g: Record<string, string[]> = { paintings: ["paintings"], paper: ["prints", "drawings", "photographs"], objects: ["ceramics", "furniture", "textiles"] };
        return !s.catalogue || s.catalogue.loading || s.catalogue.group === "all" || s.catalogue.rows.every((r: { dept: string }) => (g[s.catalogue.group] ?? []).includes(r.dept));
      },
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
