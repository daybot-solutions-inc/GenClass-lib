// Top bar shared by every page: brand, demo navigation, theme toggle, repository link.
import { DEMOS, REPO_URL } from "../shared/demos.ts";
import { getTheme, setTheme, siteRoot } from "../shared/settings.ts";
import type { DemoId } from "../shared/types.ts";
import { BRAND_MARK, icon } from "./icons.ts";
import { h } from "./dom.ts";

function currentTheme(): "light" | "dark" {
  const explicit = getTheme();
  if (explicit) return explicit;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(): void {
  const t = getTheme();
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

export function renderTopbar(active: DemoId | "home"): HTMLElement {
  const root = siteRoot();
  const themeBtn = h("button", {
    class: "btn btn-ghost btn-icon btn-sm",
    type: "button",
    title: "Toggle light/dark",
    "aria-label": "Toggle light or dark theme",
  });
  const paintTheme = () => {
    themeBtn.innerHTML = icon(currentTheme() === "dark" ? "sun" : "moon");
  };
  themeBtn.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    const system = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    setTheme(next === system ? null : next);
    applyTheme();
    if (next !== system) document.documentElement.dataset.theme = next;
    paintTheme();
  });
  paintTheme();

  const nav = h(
    "nav",
    { class: "nav", "aria-label": "Demos" },
    DEMOS.map((d) =>
      h(
        "a",
        { href: new URL(`${d.id}/`, root).href, "aria-current": active === d.id ? "page" : null },
        h("span", { class: "n" }, d.n),
        d.title,
      ),
    ),
  );

  const bar = h(
    "header",
    { class: "topbar" },
    h(
      "div",
      { class: "container topbar-inner" },
      h(
        "a",
        { class: "brand", href: root.href, html: `${BRAND_MARK}<span>GenClass Runtime</span>` },
        h("span", { class: "badge badge-accent" }, "preview"),
      ),
      nav,
      h("div", { class: "spacer" }),
      h(
        "div",
        { class: "topbar-actions" },
        themeBtn,
        h("a", {
          class: "btn btn-ghost btn-icon btn-sm",
          href: REPO_URL,
          target: "_blank",
          rel: "noopener",
          title: "Source on GitHub",
          "aria-label": "Source on GitHub",
          html: icon("github"),
        }),
      ),
    ),
  );
  return bar;
}
