// Chaos controls for the mock server (applies to this page's server session only).
import { CALM, PRESETS, describeChaos, matchPreset, mergeChaos, withPreset, type Chaos, type PresetId, type RouteChaos } from "../shared/chaos.ts";
import { saveChaos } from "../shared/settings.ts";
import type { ServerLink } from "../shared/server.ts";
import type { DemoId } from "../shared/types.ts";
import { h } from "./dom.ts";
import { icon } from "./icons.ts";

interface SliderDef {
  key: keyof RouteChaos;
  label: string;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
  scale?: number;
}

const SLIDERS: SliderDef[] = [
  { key: "latency", label: "Latency", min: 5, max: 2000, step: 5, fmt: (v) => `${v} ms` },
  { key: "jitter", label: "Jitter", min: 0, max: 1500, step: 5, fmt: (v) => `±${v} ms` },
  { key: "failRate", label: "Failures (5xx)", min: 0, max: 60, step: 1, scale: 100, fmt: (v) => `${v}%` },
  { key: "commitFailRate", label: "Lost responses", min: 0, max: 30, step: 1, scale: 100, fmt: (v) => `${v}%` },
  { key: "spikeRate", label: "Slowdowns", min: 0, max: 40, step: 1, scale: 100, fmt: (v) => `${v}%` },
  { key: "spikeFactor", label: "Slowdown factor", min: 2, max: 12, step: 1, fmt: (v) => `×${v}` },
  { key: "reorder", label: "Reordering", min: 0, max: 100, step: 5, scale: 100, fmt: (v) => `${v}%` },
  { key: "timeoutRate", label: "Hangs (6–8 s)", min: 0, max: 20, step: 1, scale: 100, fmt: (v) => `${v}%` },
];

export interface ChaosPanel {
  el: HTMLElement;
  get(): Chaos;
  set(c: Chaos): void;
}

export function mountChaosPanel(demo: DemoId, link: ServerLink, initial: Chaos, extras?: HTMLElement | null): ChaosPanel {
  let chaos = initial;
  const presetBtns = new Map<PresetId, HTMLButtonElement>();
  const inputs = new Map<keyof RouteChaos, { input: HTMLInputElement; out: HTMLOutputElement; def: SliderDef }>();
  const summary = h("div", { class: "chaos-summary" });
  const outage = h("input", { type: "checkbox" });
  const offline = h("input", { type: "checkbox" });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const push = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void link.setChaos(chaos, true).catch(() => {});
      saveChaos(demo, chaos);
    }, 120);
  };

  const paint = () => {
    const p = matchPreset(chaos);
    for (const [id, b] of presetBtns) b.setAttribute("aria-pressed", String(p === id));
    for (const { input, out, def } of inputs.values()) {
      const raw = chaos[def.key] as number;
      const v = Math.round(raw * (def.scale ?? 1));
      input.value = String(v);
      out.value = def.fmt(v);
      input.style.setProperty("--pct", `${((v - def.min) / (def.max - def.min)) * 100}%`);
    }
    outage.checked = chaos.outage;
    offline.checked = chaos.offline;
    summary.textContent = describeChaos(chaos);
  };

  const presets = h(
    "div",
    { class: "presets", role: "group", "aria-label": "Chaos presets" },
    (Object.keys(PRESETS) as PresetId[]).map((id) => {
      const b = h("button", { class: "preset", type: "button", title: PRESETS[id].hint, "aria-pressed": "false" }, PRESETS[id].label);
      b.addEventListener("click", () => {
        chaos = { ...withPreset(id), routes: chaos.routes };
        paint();
        push();
      });
      presetBtns.set(id, b);
      return b;
    }),
  );

  const grid = h(
    "div",
    { class: "chaos-grid" },
    SLIDERS.map((def) => {
      const id = `chaos-${def.key}`;
      const input = h("input", { class: "range", type: "range", id, min: def.min, max: def.max, step: def.step });
      const out = h("output", { for: id });
      input.addEventListener("input", () => {
        const v = Number(input.value) / (def.scale ?? 1);
        chaos = mergeChaos(chaos, { [def.key]: v } as Partial<Chaos>);
        paint();
        push();
      });
      inputs.set(def.key, { input, out, def });
      return h("div", { class: "field" }, h("div", { class: "field-row" }, h("label", { for: id }, def.label), out), input);
    }),
  );

  outage.addEventListener("change", () => {
    chaos = mergeChaos(chaos, { outage: outage.checked });
    paint();
    push();
  });
  offline.addEventListener("change", () => {
    chaos = mergeChaos(chaos, { offline: offline.checked });
    paint();
    push();
  });

  const reset = h("button", { class: "btn btn-ghost btn-xs", type: "button", title: "Back to a calm network" }, "Reset");
  reset.addEventListener("click", () => {
    chaos = { ...CALM, routes: {} };
    paint();
    push();
  });

  const el = h(
    "section",
    { class: "panel", id: "chaos" },
    h("div", { class: "panel-head", html: `<h2>Network chaos</h2><div class="spacer"></div>` }, reset),
    h(
      "div",
      { class: "panel-body" },
      presets,
      grid,
      h(
        "div",
        { class: "chaos-toggles" },
        h("label", { class: "switch" }, outage, h("span", { class: "track" }), "API outage"),
        h("label", { class: "switch" }, offline, h("span", { class: "track" }), "Offline"),
      ),
      extras ? h("div", { class: "chaos-extra" }, extras) : null,
      h("div", { style: { marginTop: "14px", display: "flex", alignItems: "center", gap: "8px" }, html: `<span class="muted" style="display:inline-flex">${icon("zap", 'width="14" height="14"')}</span>` }, summary),
    ),
  );
  paint();

  return {
    el,
    get: () => chaos,
    set: (c) => {
      chaos = c;
      paint();
      push();
    },
  };
}
