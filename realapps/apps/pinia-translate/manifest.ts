import type { AppManifest } from "../../src/shared/manifest.js";

const source: [string, string][] = [
  ["nav.home", "Home"], ["nav.settings", "Settings"], ["cart.empty", "Your cart is empty"], ["cart.checkout", "Proceed to checkout"],
  ["auth.signin", "Sign in"], ["auth.forgot", "Forgot your password?"], ["error.network", "Check your connection and try again"], ["order.shipped", "Your order has shipped"],
];
const fr = ["Accueil", "Paramètres", "", "Passer à la caisse", "Se connecter", "", "", "Votre commande a été expédiée"];
const de = ["Startseite", "", "Ihr Warenkorb ist leer", "", "Anmelden", "Passwort vergessen?", "", ""];
const es = ["Inicio", "Ajustes", "Tu carrito está vacío", "", "", "", "Revisa tu conexión e inténtalo de nuevo", ""];
const strings: Record<string, unknown>[] = [];
let id = 100;
for (const [locale, arr] of [["fr", fr], ["de", de], ["es", es]] as [string, string[]][]) source.forEach(([key, en], i) => strings.push({ id: id++, key, locale, en, text: arr[i], reviewed: false }));
const suggestions: Record<string, unknown>[] = [];
for (const s of strings) suggestions.push({ id: Number(s.id) + 1000, key: s.key, locale: s.locale, text: `[${s.locale}] ${s.en}` });

const manifest: AppManifest = {
  name: "pinia-translate",
  title: "Translation editor",
  framework: "vue",
  libs: ["vue", "pinia", "rt.guard", "fetch"],
  domain: "translation-editor",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "strings", seed: strings, versioned: true, filters: ["locale", "key"], envelope: "items", pageSize: 40 },
      { name: "suggestions", seed: suggestions, filters: ["locale", "key"], envelope: "items" },
    ],
  },
  variants: {
    suggest: ["if-untouched", "always"],
    localeSeq: ["latest", "blind"],
    saveGuard: ["pending", "none"],
    conflict: ["reload", "overwrite"],
    progress: ["getter", "stored"],
  },
  affordances: [
    { id: "locale", kind: "select", sel: "select[name=locale]", values: ["fr", "de", "es"], weight: 1.2, mode: "replace" },
    { id: "pick", kind: "click", sel: "li.string button.edit", nth: 8, weight: 3, mode: "replace", key: "pick" },
    { id: "suggest", kind: "click", sel: "button.suggest", weight: 1.5, mode: "accumulate", after: ["pick"], requires: "form.editor", then: ["draft"] },
    { id: "draft", kind: "type", sel: "textarea[name=draft]", values: ["Bonjour", " (v2)", "Weiter", "Listo"], clear: true, weight: 2.5, mode: "replace", after: ["pick"], requires: "form.editor", then: ["save"] },
    { id: "save", kind: "click", sel: "form.editor button.save", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.15, impatientP: 0.25 },
  ],
  external: [{ kind: "update", target: "strings", perMin: 2.5, where: { locale: "fr" }, data: [{ text: "Accueil (relu)" }, { reviewed: true }, { text: "Votre panier est vide" }] }],
  weights: { "editor.error": 0, "editor.notice": 0, "editor.saving": 0.1, "editor.draft": 0.3, "editor.suggesting": 0.1, "catalog.loading": 0.1 },
  relations: [
    { name: "progress = translated strings", fields: ["catalog.translated", "catalog.items"], check: (s) => !s.catalog || s.catalog.loading || s.catalog.translated === s.catalog.items.filter((x: { text: string }) => x.text).length },
    { name: "strings belong to the locale", fields: ["catalog.items", "catalog.locale"], check: (s) => !s.catalog || s.catalog.loading || s.catalog.items.every((x: { locale: string }) => x.locale === s.catalog.locale) },
  ],
  errorSelector: "[role=alert]",
  build: { vueCompiler: true },
  sessionMs: [25000, 60000],
};
export default manifest;
