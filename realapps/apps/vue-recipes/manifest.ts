import type { AppManifest } from "../../src/shared/manifest.js";

const R: [string, string, string[]][] = [
  ["Lemon herb chicken", "chicken", ["chicken thighs", "lemon", "thyme", "garlic"]],
  ["Mushroom risotto", "vegetarian", ["arborio rice", "mushrooms", "parmesan", "stock"]],
  ["Chickpea curry", "vegan", ["chickpeas", "coconut milk", "spinach", "curry paste"]],
  ["Salmon tray bake", "fish", ["salmon", "potatoes", "lemon", "dill"]],
  ["Beef tacos", "beef", ["beef mince", "tortillas", "salsa", "cheddar"]],
  ["Pesto pasta", "vegetarian", ["pasta", "basil pesto", "parmesan", "pine nuts"]],
  ["Tofu stir fry", "vegan", ["tofu", "broccoli", "soy sauce", "rice"]],
  ["Shakshuka", "vegetarian", ["eggs", "tomatoes", "peppers", "feta"]],
  ["Thai green curry", "chicken", ["chicken breast", "green curry paste", "coconut milk", "rice"]],
  ["Lentil soup", "vegan", ["red lentils", "carrots", "stock", "cumin"]],
  ["Fish tacos", "fish", ["white fish", "tortillas", "cabbage", "lime"]],
  ["Halloumi salad", "vegetarian", ["halloumi", "rocket", "tomatoes", "lemon"]],
];
const recipes = R.map(([title, tag, ingredients], i) => ({ id: 800 + i, title, tag, ingredients, minutes: 20 + (i % 4) * 10 }));

const manifest: AppManifest = {
  name: "vue-recipes",
  title: "Meal planner",
  framework: "vue",
  libs: ["vue", "fetch", "rt.atom", "useAtom"],
  domain: "recipe-planner",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "recipes", seed: recipes, search: ["title", "tag"], filters: ["tag"], envelope: "items", pageSize: 20 }],
    docs: [{ name: "plan", init: { mon: 800, tue: 0, wed: 0, thu: 802, fri: 0, sat: 0, sun: 0 }, versioned: true }],
  },
  variants: {
    searchSeq: ["latest", "blind"],
    planSave: ["refetch", "overwrite", "refetch"],
    assignGuard: ["pending", "none"],
    shopping: ["derive", "incremental"],
    pollMs: [5000, 8000],
  },
  affordances: [
    { id: "day", kind: "click", sel: "nav.days button.day", text: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], weight: 2, mode: "replace", key: "day" },
    { id: "search", kind: "type", sel: "input[name=q]", values: ["curry", "tacos", "veg", "fish", "pa", "le"], weight: 1.5, mode: "replace", clear: true, waitMs: 1 },
    { id: "assign", kind: "click", sel: "li.recipe button.assign", nth: 6, weight: 3, mode: "replace", key: "assign", intent: "aff", dblclickP: 0.12, impatientP: 0.2 },
    { id: "clearDay", kind: "click", sel: "button.clear-day", weight: 0.8, mode: "accumulate", requires: "button.clear-day" },
  ],
  external: [{ kind: "doc", target: "plan", perMin: 1.5, data: [{ thu: 805 }, { sat: 810 }, { fri: 0 }, { tue: 806 }, { sun: 803 }] }],
  weights: { "planner.error": 0, "planner.notice": 0, "planner.saving": 0.1, "planner.version": 0, "search.loading": 0.1, "search.q": 0.3 },
  relations: [
    {
      name: "shopping list = ingredients of planned meals",
      fields: ["planner.shopping", "planner.plan", "planner.catalog"],
      check: (s) => {
        const p = s.planner;
        if (!p || !p.catalog.length) return true;
        const want = new Set<string>();
        for (const id of Object.values(p.plan)) for (const r of p.catalog) if (r.id === id) for (const g of r.ingredients) want.add(g);
        return want.size === p.shopping.length && p.shopping.every((g: string) => want.has(g));
      },
    },
  ],
  errorSelector: "[role=alert]",
  build: { vueCompiler: true },
  sessionMs: [25000, 60000],
};
export default manifest;
