// "Run trials": scripted user sessions in fresh iframes (each with its own runtime and server session), the same
// seeds in every mode, scored by the demo's oracle. Chaos trials measure the bug rate; clean trials (no chaos,
// calm user, correct behaviour) count false interventions.
import { summarizeMode, type ModeSummary } from "../shared/aggregate.ts";
import { DEMO_BY_ID } from "../shared/demos.ts";
import { MODES, type DemoId, type GcMode, type TrialKind, type TrialResult } from "../shared/types.ts";
import { esc, fmtMs, h, pct, toast } from "./dom.ts";
import { icon } from "./icons.ts";
import { nativeClearInterval, nativeClearTimeout, nativeSetInterval, nativeSetTimeout } from "../shared/native.ts";

const MODE_LABEL: Record<GcMode, string> = { off: "Off", observe: "Observe", guard: "Guard", heal: "Heal" };

interface Job {
  seed: number;
  kind: TrialKind;
  mode: GcMode;
}

function plan(n: number, clean: number, base: number): Job[] {
  const jobs: Job[] = [];
  for (let i = 0; i < n; i++) for (const mode of MODES) jobs.push({ seed: base + i, kind: "chaos", mode });
  for (let i = 0; i < clean; i++) for (const mode of MODES) jobs.push({ seed: base + 500 + i, kind: "clean", mode });
  return jobs;
}

function runInFrame(stage: HTMLElement, job: Job, timeoutMs: number): Promise<TrialResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(location.href);
    const keep = ["budget", "model", "coi"].map((k) => [k, url.searchParams.get(k)] as const).filter(([, v]) => v !== null);
    url.search = "";
    url.hash = "";
    for (const [k, v] of keep) url.searchParams.set(k, v!);
    url.searchParams.set("embed", "trial");
    url.searchParams.set("mode", job.mode);
    url.searchParams.set("kind", job.kind);
    url.searchParams.set("seed", String(job.seed));
    url.searchParams.set("run", Math.random().toString(36).slice(2, 8));
    const frame = h("iframe", { src: url.href, title: "Trial session", tabindex: "-1" });
    stage.querySelector(".placeholder")?.remove();
    stage.querySelector("iframe")?.remove();
    stage.appendChild(frame);
    let done = false;
    const timer = nativeSetTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`trial timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    const poll = nativeSetInterval(async () => {
      const w = frame.contentWindow;
      if (!w || done) return;
      if (w.__trialError) {
        nativeClearInterval(poll);
        nativeClearTimeout(timer);
        done = true;
        reject(new Error(w.__trialError));
        return;
      }
      if (!w.__trialReady) return;
      nativeClearInterval(poll);
      try {
        const harness = await w.__trialReady;
        const r = await harness.runSynthetic();
        if (done) return;
        done = true;
        nativeClearTimeout(timer);
        resolve(r);
      } catch (e) {
        if (done) return;
        done = true;
        nativeClearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    }, 50);
  });
}

function meter(rate: number, label: string, color = "var(--bad)"): HTMLElement {
  return h(
    "div",
    { class: "meter" },
    h("span", { class: "track" }, h("i", { style: { width: `${Math.round(rate * 100)}%`, background: color } })),
    h("span", { class: "v" }, label),
  );
}

function renderTable(summaries: ModeSummary[]): HTMLElement {
  const off = summaries.find((s) => s.mode === "off");
  const table = h(
    "table",
    { class: "table results-table" },
    h(
      "thead",
      null,
      h(
        "tr",
        null,
        h("th", null, "Mode"),
        h("th", { title: "Share of chaos trials where the oracle found a bug" }, "Bug rate (chaos)"),
        h("th", { class: "num", title: "Non-passive actions GenClass took on clean runs. Each one is a false positive." }, "False interventions"),
        h("th", { class: "num", title: "Bug rate on clean runs (no chaos, calm user)" }, "Clean bugs"),
        h("th", { class: "num", title: "Paired with Off on the same seeds: bugs fixed / bugs introduced" }, "Fixed / new"),
        h("th", { class: "num", title: "The demo's user-visible latency, median over clean runs" }, "Latency"),
        h("th", { class: "num", title: "Median time the runtime waited for a model decision" }, "Model"),
      ),
    ),
  );
  const body = h("tbody");
  for (const s of summaries) {
    const fpClass = s.falseInterventions === 0 ? "fp zero" : "fp some";
    const delta = off && s.mode !== "off" && s.latencyMs !== null && off.latencyMs !== null ? s.latencyMs - off.latencyMs : null;
    body.append(
      h(
        "tr",
        null,
        h("td", null, h("span", { class: "mode-name", "data-mode": s.mode }, h("span", { class: "swatch" }), MODE_LABEL[s.mode])),
        h("td", null, meter(s.chaos.rate, `${pct(s.chaos.rate)} · ${s.chaos.k}/${s.chaos.n}`)),
        h(
          "td",
          { class: "num" },
          h("span", { class: fpClass }, String(s.falseInterventions)),
          h("span", { class: "muted" }, ` / ${s.cleanTrials} runs`),
        ),
        h("td", { class: "num" }, `${s.clean.k}/${s.clean.n}`),
        h("td", { class: "num" }, s.mode === "off" ? "–" : `${s.fixed} / ${s.introduced}`),
        h("td", { class: "num" }, fmtMs(s.latencyMs), delta !== null ? h("span", { class: "muted" }, ` ${delta >= 0 ? "+" : "−"}${Math.abs(Math.round(delta))}`) : null),
        h("td", { class: "num" }, s.decisionP50 === null ? "–" : fmtMs(s.decisionP50)),
      ),
    );
  }
  table.append(body);
  return table;
}

function renderLog(results: TrialResult[]): HTMLElement {
  const rows = results
    .slice()
    .reverse()
    .map((r) =>
      h(
        "tr",
        null,
        h("td", { class: "num" }, String(r.seed)),
        h("td", null, r.kind),
        h("td", null, h("span", { class: "mode-name", "data-mode": r.mode }, h("span", { class: "swatch" }), MODE_LABEL[r.mode])),
        h("td", null, r.label),
        h("td", null, r.error ? h("span", { class: "badge badge-warn" }, "error") : r.bug ? h("span", { class: "badge badge-bad" }, "bug") : h("span", { class: "badge badge-ok" }, "ok")),
        h("td", { class: "dim" }, r.error ?? r.reasons.join("; ")),
        h("td", { class: "num" }, String(r.gc.interventions.length)),
      ),
    );
  return h(
    "div",
    { class: "trial-log" },
    h(
      "table",
      { class: "table" },
      h(
        "thead",
        null,
        h("tr", null, h("th", { class: "num" }, "Seed"), h("th", null, "Kind"), h("th", null, "Mode"), h("th", null, "Session"), h("th", null, "Result"), h("th", null, "Why"), h("th", { class: "num" }, "Acts")),
      ),
      h("tbody", null, rows),
    ),
  );
}

export function mountTrials(demo: DemoId): HTMLElement {
  const info = DEMO_BY_ID[demo];
  const nSel = h(
    "select",
    { class: "select", style: { width: "auto", height: "36px" }, "aria-label": "Chaos trials per mode" },
    [3, 6, 10, 20, 30].map((n) => h("option", { value: n, selected: n === 6 }, `${n} chaos trials per mode`)),
  );
  const cleanBox = h("input", { type: "checkbox", checked: true });
  const runBtn = h("button", { class: "btn btn-primary", type: "button", html: `${icon("play")}Run trials` });
  const exportBtn = h("button", { class: "btn btn-sm btn-ghost", type: "button", disabled: true, html: `${icon("copy")}Copy JSON` });
  const bar = h("i");
  const status = h("span", null, "Not started");
  const eta = h("span", { class: "num" }, "");
  const stage = h("div", { class: "trial-stage" }, h("div", { class: "placeholder" }, "Each trial opens the app in a fresh frame with its own GenClass runtime and server session. Keep this tab visible while trials run."));
  const emptyTable = h("div", { class: "activity-empty" }, "Results appear here as trials finish: the same seeds run with GenClass Off, Guard and Heal.");
  const tableHost = h("div", null, emptyTable);
  const logHost = h("div");
  const note = h("div", { class: "trial-note" });

  let running = false;
  let stop = false;
  let results: TrialResult[] = [];

  const paint = () => {
    const summaries = MODES.map((m) => summarizeMode(results, m)).filter((s): s is ModeSummary => Boolean(s));
    tableHost.replaceChildren(summaries.length ? h("div", { class: "table-scroll" }, renderTable(summaries)) : emptyTable);
    logHost.replaceChildren(results.length ? renderLog(results) : h("div"));
    const rt = [...new Set(results.map((r) => r.gc.runtime))];
    const st = [...new Set(results.filter((r) => r.mode !== "off").map((r) => r.gc.status))];
    note.innerHTML = results.length
      ? `${results.length} trials · runtime: <b>${esc(rt.join(", "))}</b>${st.length ? ` · model: <b>${esc(st.join(", "))}</b>` : ""} · synthetic DOM events (the headless eval uses real input) · ${esc(info.scored[0])}`
      : "";
    exportBtn.disabled = results.length === 0;
  };

  exportBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(results, null, 2));
      toast("Trial results copied as JSON");
    } catch {
      toast("Clipboard is not available here");
    }
  });

  runBtn.addEventListener("click", async () => {
    if (running) {
      stop = true;
      runBtn.disabled = true;
      status.textContent = "Stopping after this trial…";
      return;
    }
    const n = Number(nSel.value);
    const clean = cleanBox.checked ? Math.max(2, Math.ceil(n / 2)) : 0;
    const jobs = plan(n, clean, 1000);
    running = true;
    stop = false;
    results = [];
    paint();
    runBtn.innerHTML = `${icon("stop")}Stop`;
    const t0 = performance.now();
    for (let i = 0; i < jobs.length && !stop; i++) {
      const job = jobs[i];
      bar.style.width = `${(i / jobs.length) * 100}%`;
      status.textContent = `Trial ${i + 1}/${jobs.length} · ${MODE_LABEL[job.mode]} · ${job.kind} · seed ${job.seed}`;
      if (i > 0) {
        const per = (performance.now() - t0) / i;
        eta.textContent = `~${Math.ceil((per * (jobs.length - i)) / 60000)} min left`;
      }
      try {
        results.push(await runInFrame(stage, job, 150000));
      } catch (e) {
        results.push({
          demo,
          mode: job.mode,
          kind: job.kind,
          seed: job.seed,
          label: "–",
          durationMs: 0,
          bug: false,
          reasons: [],
          metrics: {},
          driver: "synthetic",
          error: e instanceof Error ? e.message : String(e),
          gc: { runtime: "real", status: "error", decisions: 0, detections: 0, notExecuted: {}, interventions: [], decisionLatencyMs: [], diagnoses: {} },
        });
      }
      paint();
    }
    stage.querySelector("iframe")?.remove();
    stage.append(h("div", { class: "placeholder" }, stop ? "Stopped." : "Done. Same seeds, three modes; see the table."));
    bar.style.width = "100%";
    status.textContent = `${results.length} trials in ${Math.round((performance.now() - t0) / 1000)} s`;
    eta.textContent = "";
    running = false;
    runBtn.disabled = false;
    runBtn.innerHTML = `${icon("play")}Run trials`;
  });

  return h(
    "section",
    { class: "trials", id: "trials" },
    h(
      "div",
      { class: "section-head" },
      h(
        "div",
        null,
        h("div", { class: "eyebrow", html: `${icon("flask", 'width="14" height="14"')} Measure it` }),
        h("h2", { style: { marginTop: "6px" } }, "Run trials"),
        h(
          "p",
          null,
          "Scripted sessions type and click through real DOM events under randomized chaos, then this demo's oracle scores each one. Every seed runs with GenClass Off, Guard and Heal. Clean runs have no chaos and a calm user, so any action GenClass takes there is a false positive.",
        ),
      ),
      h("div", { class: "trial-controls" }, nSel, h("label", { class: "switch" }, cleanBox, h("span", { class: "track" }), "Clean runs"), runBtn),
    ),
    h(
      "div",
      { class: "trials-body" },
      h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("h3", null, "Results"), h("div", { class: "spacer" }), exportBtn), tableHost, logHost, note),
      h(
        "div",
        { class: "panel" },
        h("div", { class: "trial-progress" }, h("div", { class: "line" }, status, eta), h("div", { class: "bar" }, bar)),
        stage,
      ),
    ),
  );
}
