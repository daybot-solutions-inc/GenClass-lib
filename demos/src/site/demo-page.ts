// Boots a demo page: the interactive page (app + mode switch + activity + chaos + trials) or, with
// ?embed=trial, a bare trial page driven by the trial panel or by Playwright.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "../styles/system.css";
import "../styles/site.css";
import { mountDevtools } from "@genclass/runtime/devtools";
import type { Runtime } from "@genclass/runtime";
import { DEMO_BY_ID } from "../shared/demos.ts";
import type { DemoDefinition } from "../shared/demo-def.ts";
import { startGenClass, statusText, RUNTIME_KIND } from "../shared/genclass.ts";
import { TrialHarness } from "../shared/harness.ts";
import { ServerLink, ensureServiceWorker, wait } from "../shared/server.ts";
import { getMode, loadChaos, modelBaseUrl, sessionId, setMode, siteRoot, trialParams, urlParams, type TrialParams } from "../shared/settings.ts";
import { MODES, type GcMode } from "../shared/types.ts";
import { mountActivity } from "./activity.ts";
import { mountChaosPanel } from "./chaos-panel.ts";
import { applyTheme, renderTopbar } from "./chrome.ts";
import { esc, h, toast } from "./dom.ts";
import { icon } from "./icons.ts";
import { mountNetLane } from "./netlane.ts";
import { mountTrials } from "./trials-panel.ts";

const MODE_LABEL: Record<GcMode, string> = { off: "Off", guard: "Guard", heal: "Heal" };
const MODE_HINT: Record<GcMode, string> = {
  off: "Baseline: the runtime is installed in observe mode with no model and never changes anything.",
  guard: "Default: only minimal, reversible actions (drop, defer, dedupe, back off) at very high confidence.",
  heal: "Also recovers: retries, cached responses, rollbacks and resyncs, at high confidence.",
};

function appFrame(def: DemoDefinition, mode: GcMode): { frame: HTMLElement; body: HTMLElement } {
  const body = h("div", { class: "app-body" });
  const frame = h(
    "div",
    { class: "app-frame" },
    h(
      "div",
      { class: "app-chrome", html: `<div class="lights"><i></i><i></i><i></i></div>` },
      h("div", { class: "url", html: `${icon("lock")}<span>${esc(def.host)}</span>` }),
      h("span", {
        class: "gc-chip",
        "data-mode": mode,
        title: MODE_HINT[mode],
        html: `${icon(mode === "off" ? "eye" : mode === "heal" ? "heal" : "shield", 'width="13" height="13"')}GenClass ${MODE_LABEL[mode]}`,
      }),
    ),
    body,
  );
  return { frame, body };
}

function fatal(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  window.__trialError = msg;
  document.body.replaceChildren(
    h(
      "div",
      { class: "card boot-error" },
      h("h2", null, "This demo could not start"),
      h("p", null, msg),
      h("p", { class: "muted" }, "The demos run a mock API inside a Service Worker. Service Workers need a normal (non-private) window and http(s)."),
    ),
  );
}

function modeCard(gc: Runtime, mode: GcMode): HTMLElement {
  const seg = h(
    "div",
    { class: "seg", role: "group", "aria-label": "GenClass mode" },
    MODES.map((m) => {
      const b = h("button", { type: "button", "data-mode": m, "aria-pressed": String(m === mode), title: MODE_HINT[m] }, h("span", { class: "swatch" }), MODE_LABEL[m]);
      b.addEventListener("click", () => {
        if (m !== mode) setMode(m);
      });
      return b;
    }),
  );
  const kill = urlParams.get("genclass");
  const hint = h(
    "div",
    { class: "mode-hint" },
    kill ? `Runtime kill switch in the URL (?genclass=${kill}): the runtime follows it, not this switch.` : MODE_HINT[mode],
  );
  const dot = h("span", { class: "dot" });
  const txt = h("span", null, "");
  const fill = h("i");
  const barWrap = h("span", { class: "bar", hidden: true }, fill);
  const status = h("div", { class: "model-status" }, dot, txt, barWrap);
  const paint = () => {
    const st = gc.status;
    status.dataset.state = st.state;
    dot.classList.toggle("dot-pulse", st.state === "loading");
    if (mode === "off" || st.state === "off") {
      txt.textContent = RUNTIME_KIND === "shim" ? "Development stand-in runtime · no model" : "No model · observing only";
      barWrap.hidden = true;
    } else if (st.state === "loading") {
      const p = st.progress;
      txt.textContent = p && p.total ? `Loading model · ${Math.round((p.loaded / p.total) * 100)}%` : "Loading model…";
      barWrap.hidden = !(p && p.total);
      if (p && p.total) fill.style.width = `${(p.loaded / p.total) * 100}%`;
    } else if (st.state === "ready") {
      txt.textContent = `Model ready · ${[st.device, st.variant].filter(Boolean).join(" · ")}${st.loadMs ? ` · ${(st.loadMs / 1000).toFixed(1)} s` : ""}`;
      barWrap.hidden = true;
    } else {
      txt.textContent = `Model unavailable${st.error ? `: ${st.error}` : ""} · acting passively`;
      barWrap.hidden = true;
    }
  };
  gc.on("status", paint);
  paint();
  const t = setInterval(() => {
    paint();
    if (gc.status.state !== "loading") clearInterval(t);
  }, 400);
  return h(
    "div",
    { class: "mode-card" },
    h("div", { class: "mode-card-top" }, h("span", { class: "label" }, "GenClass"), seg),
    hint,
    status,
  );
}

function explainCards(def: DemoDefinition): HTMLElement {
  const info = DEMO_BY_ID[def.id];
  return h(
    "div",
    { class: "explain" },
    h(
      "div",
      { class: "card" },
      h("h3", { html: `${icon("alert")}What can go wrong` }),
      h(
        "ul",
        null,
        info.wrong.map((w) => h("li", null, w)),
      ),
    ),
    h(
      "div",
      { class: "card" },
      h("h3", { html: `${icon("target")}What the trials score` }),
      h(
        "ul",
        null,
        info.scored.map((w) => h("li", null, w)),
      ),
    ),
    h("div", { class: "card" }, h("h3", { html: `${icon("code")}How it is wired` }), h("pre", { class: "codeblock", html: def.code })),
  );
}

async function bootInteractive(def: DemoDefinition): Promise<void> {
  const info = DEMO_BY_ID[def.id];
  const root = siteRoot();
  const mode = getMode();
  const link = new ServerLink(sessionId(def.id), def.id);
  const chaos = loadChaos(def.id);
  const hello = await link.hello({ chaos, params: def.serverParams, seed: 7 });
  if (!hello.created) await link.setChaos(chaos, true);
  link.startHeartbeat();
  link.onRestart = () => {
    toast("The mock server restarted and its data was reset. Reloading…");
    setTimeout(() => location.reload(), 1500);
  };
  addEventListener("pagehide", () => link.stop());

  const gcs = startGenClass(mode, { baseUrl: modelBaseUrl(root), plugins: def.plugins?.() });
  const gc = gcs.gc;

  const { frame, body } = appFrame(def, mode);
  const activity = mountActivity(gc, mode, frame);
  const chaosPanel = mountChaosPanel(def.id, link, chaos, def.chaosExtras?.(link) ?? null);
  frame.append(mountNetLane(link));

  const tryIt = h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", null, "Try it")), h("div", { class: "panel-body", style: { fontSize: "13.5px", color: "var(--text-2)" }, html: info.tryIt }));

  document.body.replaceChildren(
    renderTopbar(def.id),
    h(
      "main",
      { class: "container" },
      h(
        "section",
        { class: "demo-hero" },
        h(
          "div",
          null,
          h("div", { class: "eyebrow" }, `${info.n} · ${info.tagline}`),
          h("h1", null, info.title),
          h("p", { class: "lede" }, info.summary),
          h(
            "div",
            { class: "stack" },
            info.stack.split(" · ").map((s) => h("span", { class: "badge badge-outline" }, s)),
          ),
        ),
        modeCard(gc, mode),
      ),
      h("div", { class: "demo-grid" }, h("div", { class: "demo-main" }, frame, explainCards(def)), h("aside", { class: "demo-side" }, tryIt, activity.el, chaosPanel.el)),
      mountTrials(def.id),
    ),
    h("footer", { class: "footer" }, h("div", { class: "container footer-inner", html: `<span>GenClass Runtime demos · the API is a mock server in a Service Worker; GenClass runs locally in this tab.</span><a href="${esc(new URL("./", root).href)}">All demos</a>` })),
  );

  await def.mount({ gc, el: body, mode, embed: false });

  // Hooks for the screenshot tour (e2e/eval.ts): scripted sessions on the interactive page.
  (window as unknown as { __demo: unknown }).__demo = {
    scenario: def.scenario,
    setChaos: (p: Parameters<ServerLink["setChaos"]>[0]) => link.setChaos(p),
    world: (a: string, args?: unknown) => link.world(a, args),
  };

  try {
    const opts = urlParams.get("devtools") === "open" ? { open: true } : {};
    (mountDevtools as (rt: Runtime, o?: Record<string, unknown>) => unknown)(gc, opts);
  } catch (e) {
    console.warn("devtools overlay failed to mount", e);
  }
}

async function bootTrial(def: DemoDefinition, trial: TrialParams): Promise<void> {
  const root = siteRoot();
  document.body.classList.add("embed");
  const scenario = def.scenario(trial.seed, trial.kind);
  const link = new ServerLink(`trial-${def.id}-${trial.run}`, def.id);
  await link.hello({ reset: true, seed: trial.seed, chaos: scenario.chaos, params: scenario.params });
  link.startHeartbeat();
  addEventListener("pagehide", () => void link.bye());

  const gcs = startGenClass(trial.mode, { baseUrl: modelBaseUrl(root), plugins: def.plugins?.() });
  if (trial.mode !== "off") await Promise.race([gcs.gc.ready.catch(() => undefined), wait(120000)]);

  const { frame, body } = appFrame(def, trial.mode);
  document.body.replaceChildren(frame);
  await def.mount({ gc: gcs.gc, el: body, mode: trial.mode, embed: true });

  const harness = new TrialHarness(def, gcs, link, scenario, trial, body);
  if (def.loaded) {
    const t0 = performance.now();
    while (!harness.check(def.loaded) && performance.now() - t0 < 15000) await wait(25);
  } else {
    await link.quiet(250, 10000, true);
  }
  harness.start();
  window.__trial = harness;
}

export function bootDemo(def: DemoDefinition): void {
  applyTheme();
  const trial = trialParams();
  const run = async () => {
    await ensureServiceWorker(siteRoot());
    if (trial) {
      const ready = bootTrial(def, trial).then(() => window.__trial!);
      window.__trialReady = ready;
      await ready;
    } else {
      await bootInteractive(def);
    }
  };
  run().catch((e) => {
    console.error(e);
    fatal(e);
  });
}

export { statusText };
