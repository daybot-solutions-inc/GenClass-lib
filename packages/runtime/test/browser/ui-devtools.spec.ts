// Devtools overlay in a real browser: style isolation, keyboard, undo, mode switch, and the README screenshots
// (light + dark, collapsed + open, every view) written to test/browser/ui/screenshots/.
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const SHOTS = join(here, "ui", "screenshots");
let html = "";

type Scheme = "light" | "dark";
// The page's driver (see ui/page.ts); typed loosely here because it runs in the browser.
type Gc = {
  start(o?: Record<string, unknown>): Promise<void>;
  undos: string[];
  rt: { calls: { setMode: string[] }; mode: string; emitTo(t: string, v: unknown): void };
};

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  const out = await build({
    entryPoints: [join(here, "ui", "page.ts")],
    bundle: true,
    write: false,
    format: "iife",
    target: "es2022",
    logLevel: "error",
    external: ["onnxruntime-web", "onnxruntime-web/webgpu"], // the page uses a test decider, never the model
  });
  const font = (p: string): string => readFileSync(join(repo, "node_modules", p)).toString("base64");
  const fonts = `@font-face{font-family:Inter;font-style:normal;font-weight:100 900;font-display:block;src:url(data:font/woff2;base64,${font("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2")}) format("woff2")}
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:100 800;font-display:block;src:url(data:font/woff2;base64,${font("@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2")}) format("woff2")}`;
  html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>GenClass devtools</title><style id="fonts">${fonts}</style></head><body><script>${out.outputFiles[0].text}</script></body></html>`;
});

async function start(page: Page, scheme: Scheme, opts: Record<string, unknown> = {}): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
  await page.setContent(html);
  await page.evaluate(async (o) => (window as unknown as { __gc: Gc }).__gc.start(o), opts);
  await page.evaluate(async () => {
    await document.fonts.load('13px "Inter"');
    await document.fonts.load('11px "JetBrains Mono"');
    await document.fonts.ready;
  });
  await settle(page);
}

const settle = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

async function shotPanel(page: Page, name: string, pad = 28): Promise<void> {
  await page.mouse.move(1, 1); // no hover states in the pictures
  await settle(page);
  const box = await page.locator("genclass-devtools").boundingBox();
  if (!box) throw new Error("devtools not visible");
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), clip: { x, y, width: Math.min(vp.width - x, box.width + 2 * pad), height: Math.min(vp.height - y, box.height + 2 * pad) } });
}

test.describe("devtools overlay", () => {
  test("isolates its styles and leaves the page untouched", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.setContent(html);
    const before = await page.evaluate(async () => {
      const g = (window as unknown as { __gc: { start(o?: object): Promise<void> } }).__gc;
      await g.start({ hotkey: false, scenario: "mock" });
      (window as unknown as { __gc: { dt?: { unmount(): void } } }).__gc.dt?.unmount();
      const cta = document.querySelector(".cta") as HTMLElement;
      return { sheets: document.styleSheets.length, bg: getComputedStyle(cta).backgroundColor, font: getComputedStyle(document.body).fontFamily };
    });
    const after = await page.evaluate(async () => {
      const g = (window as unknown as { __gc: { start(o?: object): Promise<void> } }).__gc;
      // start() re-renders the app and mounts the overlay again, on the real runtime this time
      await g.start({ collapsed: false });
      const cta = document.querySelector(".cta") as HTMLElement;
      const host = document.querySelector("genclass-devtools") as HTMLElement;
      return {
        sheets: document.styleSheets.length,
        bg: getComputedStyle(cta).backgroundColor,
        font: getComputedStyle(document.body).fontFamily,
        shadow: !!host.shadowRoot,
        ignored: host.hasAttribute("data-genclass-ignore"),
        styleTags: document.querySelectorAll("style").length,
      };
    });
    expect(after.sheets).toBe(before.sheets);
    expect(after.bg).toBe(before.bg);
    expect(after.font).toBe(before.font);
    expect(after.shadow).toBe(true);
    expect(after.ignored).toBe(true);
    expect(after.styleTags).toBe(2); // fonts + the app's own stylesheet: nothing added by the overlay
  });

  test("keyboard: open from the pill, switch tabs and modes with arrows, Escape closes", async ({ page }) => {
    await start(page, "light", { scenario: "mock" });
    const pill = page.locator("genclass-devtools .pill");
    await pill.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("genclass-devtools .panel")).toBeVisible();
    await expect(page.locator('genclass-devtools [role=tab][aria-selected="true"]')).toHaveAttribute("data-tab", "interventions");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('genclass-devtools [role=tab][aria-selected="true"]')).toHaveAttribute("data-tab", "detections");
    await page.keyboard.press("End");
    await expect(page.locator('genclass-devtools [role=tab][aria-selected="true"]')).toHaveAttribute("data-tab", "now");
    await page.locator('genclass-devtools [role=radio][aria-checked="true"]').focus();
    await page.keyboard.press("ArrowRight");
    expect(await page.evaluate(() => (window as unknown as { __gc: Gc }).__gc.rt.mode)).toBe("heal");
    await page.keyboard.press("Escape");
    await expect(page.locator("genclass-devtools .panel")).toBeHidden();
    await expect(pill).toBeFocused();
    await page.keyboard.press("Alt+Shift+G");
    await expect(page.locator("genclass-devtools .panel")).toBeVisible();
  });

  test("undo calls the action's undo and marks the card", async ({ page }) => {
    await start(page, "light", { collapsed: false, scenario: "mock" });
    await page.locator('genclass-devtools [data-id="a1"] [data-act="undo"]').click();
    expect(await page.evaluate(() => (window as unknown as { __gc: Gc }).__gc.undos)).toEqual(["a1"]);
    await expect(page.locator('genclass-devtools [data-id="a1"] [data-act="undone"]')).toBeVisible();
  });

  for (const scheme of ["light", "dark"] as Scheme[]) {
    test(`screenshots (${scheme})`, async ({ page }) => {
      // collapsed pill, after something new happened
      await start(page, scheme);
      await shotPanel(page, `pill-${scheme}`, 24);

      // the panel over the app
      await start(page, scheme, { collapsed: false });
      await page.mouse.move(1, 1);
      await page.screenshot({ path: join(SHOTS, `overlay-${scheme}.png`) });
      await shotPanel(page, `interventions-${scheme}`);

      // evidence of the stale-write intervention
      const stale = page.locator("genclass-devtools article.card", { hasText: "search.results" }).first().locator('[data-act="evidence"]');
      await stale.click();
      await shotPanel(page, `evidence-${scheme}`);
      // further down the same evidence: the model's answers and the exact input it was given
      await page.evaluate(() => {
        const sr = document.querySelector("genclass-devtools")!.shadowRoot!;
        const pane = sr.querySelector('[data-pane="interventions"]') as HTMLElement;
        const ans = sr.querySelector(".card.open .ans") as HTMLElement;
        pane.scrollTop += ans.getBoundingClientRect().top - pane.getBoundingClientRect().top - 40;
      });
      await shotPanel(page, `evidence-answers-${scheme}`);
      await stale.click();

      for (const tab of ["detections", "activity", "now"]) {
        await page.locator(`genclass-devtools [data-tab="${tab}"]`).click();
        await shotPanel(page, `${tab}-${scheme}`);
      }

      // model download in progress + empty feed
      await start(page, scheme, { collapsed: false, scenario: "loading" });
      await shotPanel(page, `loading-${scheme}`);
    });
  }
});
