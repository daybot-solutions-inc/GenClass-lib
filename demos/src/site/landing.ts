import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "../styles/system.css";
import "../styles/site.css";
import { DEMOS, DEMO_BY_ID, REPO_URL } from "../shared/demos.ts";
import { siteRoot } from "../shared/settings.ts";
import type { DemoId } from "../shared/types.ts";
import { ART } from "./art.ts";
import { applyTheme, renderTopbar } from "./chrome.ts";
import { esc, h, pct, toast } from "./dom.ts";
import { highlight } from "./highlight.ts";
import { icon } from "./icons.ts";

applyTheme();
const root = siteRoot();

const INSTALL = `<span class="p">$ </span>npm install @genclass/runtime

${highlight(`import { GenClass } from "@genclass/runtime";
GenClass.init();`)}`;

function hero(): HTMLElement {
  const copy = h("button", { class: "btn btn-xs copy-btn", type: "button", html: `${icon("copy")}Copy` });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(`npm install @genclass/runtime\n\nimport { GenClass } from "@genclass/runtime";\nGenClass.init();\n`);
      toast("Copied");
    } catch {
      toast("Clipboard is not available here");
    }
  });
  const consoleLines = [
    {
      tag: "Prevented a stale write",
      cls: "",
      text: "GET /api/search?q=sa (started 1.8 s ago) would have overwritten search.items written 0.4 s ago by a newer GET /api/search?q=san. Dropped it.",
      conf: "(stale, 0.97)",
      ev: "▸ evidence: 6 facts · timeline · model input · <b>undo</b>",
    },
    {
      tag: "Coalesced a duplicate",
      cls: "",
      text: "POST /api/orders was sent again 90 ms after an identical one from the same click. Reused the first response.",
      conf: "(duplicate, 0.95)",
      ev: "▸ evidence: identical body · same user action · 1 in flight",
    },
    {
      tag: "Flagged",
      cls: "flag",
      text: "POST /api/cart usually writes cart.items and cart.total (317 of 317 times); this time it wrote only cart.items.",
      conf: "(unusual, 0.88)",
      ev: "▸ evidence: transition profile · last consistent state 2.1 s ago",
    },
  ];
  return h(
    "section",
    { class: "hero" },
    h(
      "div",
      { class: "container hero-grid" },
      h(
        "div",
        null,
        h("div", { class: "eyebrow", html: `${icon("shield", 'width="14" height="14"')} GenClass Runtime · preview` }),
        h("h1", { html: "Install one library. <em>Find and prevent runtime failures</em> automatically." }),
        h(
          "p",
          { class: "lede" },
          "A small model runs in your users' browsers and watches what your app is doing: user actions, requests, state writes, timing and what caused what. When something is about to go wrong, like a stale response overwriting newer state, a duplicate order, a total that no longer adds up or a retry storm, it steps in. No server, no rules to write, and every change it makes is explained and reversible.",
        ),
        h(
          "div",
          { class: "hero-ctas" },
          h("a", { class: "btn btn-primary btn-lg", href: "#demos", html: `Try the six demos ${icon("arrowRight")}` }),
          h("a", { class: "btn btn-lg", href: "#results", html: `${icon("flask")}See the measurements` }),
        ),
        h("div", { class: "install", style: { position: "relative" } }, h("pre", { class: "codeblock", html: INSTALL }), copy),
      ),
      h(
        "div",
        { class: "console", role: "img", "aria-label": "Example GenClass console output" },
        h("div", { class: "console-head", html: `<div class="lights" style="display:flex;gap:6px"><i style="width:10px;height:10px;border-radius:50%;background:#3a3a46;display:block"></i><i style="width:10px;height:10px;border-radius:50%;background:#3a3a46;display:block"></i><i style="width:10px;height:10px;border-radius:50%;background:#3a3a46;display:block"></i></div><div class="tabs"><span aria-current="true">Console</span><span>Network</span><span>Sources</span></div>` }),
        consoleLines.map((l) =>
          h(
            "div",
            { class: "console-line" },
            h("span", { class: `tag ${l.cls}` }, "[GenClass]"),
            h("span", { html: `<b style="font-weight:600">${esc(l.tag)}:</b> ${esc(l.text)} <span class="conf">${esc(l.conf)}</span>` }),
            h("span", { class: "ev", html: l.ev }),
          ),
        ),
        h("div", { class: "console-line", html: `<span class="tag" style="color:var(--code-dim)">›</span><span style="color:var(--code-dim)">gc.explain("a12")  ·  gc.interventions()  ·  ?genclass=off</span>` }),
      ),
    ),
  );
}

function modes(): HTMLElement {
  const items = [
    {
      name: "Observe",
      color: "var(--mode-off)",
      text: "Find anomalies you did not know you had. GenClass records and reports, and never changes execution.",
      bullets: ["One console line per finding, with evidence", "No behaviour change, ever", "Learns your app's normal latency, failures and invariants"],
    },
    {
      name: "Guard",
      color: "var(--mode-guard)",
      badge: "default",
      text: "Prevent only the failures it is extremely sure about, with minimal, reversible actions.",
      bullets: ["Drop a stale write, defer it, or dedupe a request", "Back off a failing endpoint", "Needs a high calibrated confidence and a non-“expected” diagnosis"],
    },
    {
      name: "Heal",
      color: "var(--mode-heal)",
      text: "Broader autonomous recovery once you trust it.",
      bullets: ["Retry, hedge or serve the last good response", "Roll state back to its last consistent snapshot", "Reload a store through your own resync handler"],
    },
  ];
  return h(
    "section",
    { class: "section" },
    h(
      "div",
      { class: "container" },
      h(
        "div",
        { class: "section-title" },
        h("div", { class: "eyebrow" }, "Adoption path"),
        h("h2", null, "Start by watching. Turn on protection when you trust it."),
        h("p", null, "False positives are what make people uninstall tools like this, so the default mode only takes actions that withhold, deduplicate or slow something down, and only at very high confidence."),
      ),
      h(
        "div",
        { class: "modes" },
        items.map((m, i) =>
          h(
            "div",
            { class: "card mode" },
            h(
              "div",
              { class: "mode-top" },
              h("span", { class: "swatch", style: { background: m.color } }),
              h("h3", null, m.name),
              m.badge ? h("span", { class: "badge badge-accent" }, m.badge) : null,
            ),
            h("p", null, m.text),
            h(
              "ul",
              null,
              m.bullets.map((b) => h("li", null, b)),
            ),
            i < 2 ? h("span", { class: "arrow", html: icon("chevronRight") }) : null,
          ),
        ),
      ),
    ),
  );
}

function demos(): HTMLElement {
  return h(
    "section",
    { class: "section", id: "demos" },
    h(
      "div",
      { class: "container" },
      h(
        "div",
        { class: "section-title" },
        h("div", { class: "eyebrow" }, "Live demos"),
        h("h2", null, "Six small apps. Six different ways to break."),
        h(
          "p",
          null,
          "Each one is written the way real apps are, latent bugs included, and talks to a mock API in a Service Worker that you can make slow, flaky or down. Flip GenClass between Off, Guard and Heal, or run scripted trials and let each demo's own oracle count the bugs.",
        ),
      ),
      h(
        "div",
        { class: "demo-cards" },
        DEMOS.map((d) =>
          h(
            "a",
            { class: "card demo-card", href: new URL(`${d.id}/`, root).href },
            h("div", { class: "art", html: ART[d.id] }),
            h("span", { class: "n" }, d.n),
            h("h3", null, d.title),
            h("div", { class: "tag" }, d.tagline),
            h("p", null, d.summary),
            h("div", { class: "foot" }, h("span", null, d.stack), h("span", { class: "go", html: `Open ${icon("arrowRight", 'width="14" height="14"')}` })),
          ),
        ),
      ),
    ),
  );
}

interface ResultsFile {
  generatedAt?: string;
  runtime?: string;
  model?: { name?: string; note?: string; status?: string };
  trials?: { chaos: number; clean: number };
  demos?: Record<
    string,
    Partial<
      Record<
        "off" | "guard" | "heal",
        { chaos: { rate: number; k: number; n: number }; falseInterventions: number; cleanTrials: number; decisionP50: number | null }
      >
    >
  >;
}

function results(): HTMLElement {
  const host = h("div", { class: "card results-card" }, h("div", { class: "activity-empty" }, "Loading the latest measurements…"));
  void fetch(new URL("results.json", root).href, { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<ResultsFile>) : null))
    .then((data) => {
      if (!data?.demos) {
        host.replaceChildren(h("div", { class: "activity-empty" }, "No measurements ship with this build yet. Every demo page has a Run trials button."));
        return;
      }
      const rows = (Object.keys(data.demos) as DemoId[]).filter((id) => DEMO_BY_ID[id]).map((id) => {
        const m = data.demos![id]!;
        const cell = (mode: "off" | "guard" | "heal") => {
          const s = m[mode];
          return s ? `${pct(s.chaos.rate)} <span class="muted">(${s.chaos.k}/${s.chaos.n})</span>` : "–";
        };
        const fi = (mode: "guard" | "heal") => {
          const s = m[mode];
          if (!s) return "–";
          return `<span class="fp ${s.falseInterventions === 0 ? "zero" : "some"}">${s.falseInterventions}</span><span class="muted"> / ${s.cleanTrials} runs</span>`;
        };
        return `<tr><td><a href="${esc(new URL(`${id}/`, root).href)}">${esc(DEMO_BY_ID[id].title)}</a></td><td class="num">${cell("off")}</td><td class="num">${cell("guard")}</td><td class="num">${cell("heal")}</td><td class="num">${fi("guard")}</td><td class="num">${fi("heal")}</td></tr>`;
      });
      const table = h("table", {
        class: "table",
        html: `<thead><tr><th>Demo</th><th class="num">Bug rate · Off</th><th class="num">Guard</th><th class="num">Heal</th><th class="num">False interventions · Guard</th><th class="num">Heal</th></tr></thead><tbody>${rows.join("")}</tbody>`,
      });
      const note = h("div", {
        class: "note",
        html: `${esc(data.model?.note ?? "")} Bug rate: share of chaos trials where the demo's oracle found a bug. False interventions: non-passive actions GenClass took on clean runs (no chaos, correct behaviour); every one counts as a false positive. ${data.trials ? `${data.trials.chaos} chaos + ${data.trials.clean} clean trials per mode per demo.` : ""} ${data.generatedAt ? `Measured ${esc(new Date(data.generatedAt).toLocaleString())}.` : ""}`,
      });
      host.replaceChildren(h("div", { style: { overflowX: "auto" } }, table), note);
    })
    .catch(() => host.replaceChildren(h("div", { class: "activity-empty" }, "Could not load results.json.")));
  return h(
    "section",
    { class: "section", id: "results" },
    h(
      "div",
      { class: "container" },
      h(
        "div",
        { class: "section-title" },
        h("div", { class: "eyebrow" }, "Measured, not claimed"),
        h("h2", null, "Bug rate and false interventions, per demo"),
        h(
          "p",
          null,
          "A headless Chromium on a build VM drives every demo with real keyboard and mouse input: the same seeded sessions with GenClass Off, Guard and Heal, under randomized chaos and on clean runs. The numbers below are whatever came out.",
        ),
      ),
      host,
    ),
  );
}

function how(): HTMLElement {
  const steps = [
    ["Observe", "Wraps fetch, XHR, DOM events, errors and your stores. Every async operation gets a cause, so a write is traced back to the request and the click behind it."],
    ["Notice", "Cheap generic facts run all the time: versions, repeats, failure streaks, latency against learned baselines, invariants it learned from your own state. Only salient moments go further."],
    ["Ask", "The moment is written up as a short situation and a few typed questions for a local GenClass model, in a Web Worker on WebGPU or WASM. Nothing leaves the browser."],
    ["Act, and explain", "The answer picks a generic action: drop or defer a write, dedupe or delay a request, retry, roll back, resync. Each one prints a plain-English line with its evidence and an undo."],
  ];
  return h(
    "section",
    { class: "section" },
    h(
      "div",
      { class: "container" },
      h(
        "div",
        { class: "section-title" },
        h("div", { class: "eyebrow" }, "How it works"),
        h("h2", null, "No rules about your app. The model reads the situation."),
        h("p", null, "The runtime contains no hardcoded bug patterns. It computes the same generic facts for every app and lets the model decide whether anything is wrong and what to do."),
      ),
      h(
        "div",
        { class: "steps" },
        steps.map(([t, p], i) => h("div", { class: "card step" }, h("span", { class: "k" }, String(i + 1)), h("h3", null, t), h("p", null, p))),
      ),
    ),
  );
}

function observability(): HTMLElement {
  const code = highlight(`const gc = GenClass.init();            // mode: "guard"

gc.on("act", (a) => console.log(a.changed));
gc.explain(a.id);    // facts, timeline, model input, answers
a.undo?.();          // every reversible action can be undone
gc.interventions();  // what GenClass changed, so far

// ?genclass=off      kill switch for "was it GenClass?"`);
  return h(
    "section",
    { class: "section" },
    h(
      "div",
      { class: "container hero-grid", style: { alignItems: "start" } },
      h(
        "div",
        { class: "section-title", style: { marginBottom: "0" } },
        h("div", { class: "eyebrow" }, "Observability"),
        h("h2", null, "You always see what it saw and what it changed."),
        h(
          "p",
          null,
          "Every detection and intervention prints one plain-English console line with collapsible evidence. Responses it touched carry an x-genclass header. Reversible actions can be undone, and a URL flag turns the whole thing off when you need to rule it out.",
        ),
      ),
      h("pre", { class: "codeblock", html: code }),
    ),
  );
}

document.getElementById("page")!.replaceWith(
  renderTopbar("home"),
  h("main", null, hero(), modes(), demos(), results(), how(), observability()),
  h(
    "footer",
    { class: "footer" },
    h(
      "div",
      { class: "container footer-inner", html: `<span>GenClass Runtime · Apache-2.0 · the demos run entirely in your browser.</span><a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a>` },
    ),
  ),
);
