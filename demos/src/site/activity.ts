// "GenClass activity": every report the runtime prints to the console, mirrored in the page, with the evidence
// (explain), Undo for reversible actions, and a banner over the app whenever GenClass changes something.
import type { ActionRecord, Decision, Explanation, Report, Runtime } from "@genclass/runtime";
import type { GcMode } from "../shared/types.ts";
import { ago, esc, fmtMs, h, toast } from "./dom.ts";
import { icon } from "./icons.ts";
import { nativeSetInterval, nativeSetTimeout } from "../shared/native.ts";

const ACTION_TITLE: Record<string, string> = {
  discard: "Dropped a write",
  defer: "Deferred a write",
  coalesce: "Reused an identical request",
  delay: "Delayed a request",
  block: "Blocked a request",
  serve_cached: "Served the last good response",
  retry: "Retried a failed request",
  hedge: "Hedged a slow request",
  rollback: "Rolled back state",
  resync: "Reloaded state from its source",
};

const DIAG_TITLE: Record<string, string> = {
  stale: "Stale data",
  conflict: "Conflicting operations",
  duplicate: "Duplicate",
  inconsistent: "Inconsistent state",
  failing: "Repeated failures",
  slow: "Slow operation",
  transient: "Transient failure",
  overload: "Overload",
  unusual: "Unusual behaviour",
};

function titleFor(r: Report): string {
  if (r.kind === "intervene" && r.action) return ACTION_TITLE[r.action.action] ?? `Ran ${r.action.action.replace(/_/g, " ")}`;
  if (r.kind === "detect" && r.decision) return `Flagged: ${(DIAG_TITLE[r.decision.diagnosis] ?? r.decision.diagnosis).toLowerCase()}`;
  return "GenClass";
}

/** The runtime's line without the "[GenClass] " prefix. */
function body(r: Report): string {
  return r.message.replace(/^\[GenClass\]\s*/, "");
}

function probBars(probs: Record<string, number>, top: string): HTMLElement {
  const entries = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  return h(
    "div",
    { class: "probs" },
    entries.map(([k, v]) =>
      h(
        "div",
        { class: `prob${k === top ? " top" : ""}` },
        h("span", { class: "mono" }, k),
        h("span", { class: "track" }, h("i", { style: { width: `${Math.round(v * 100)}%` } })),
        h("span", { class: "v" }, v.toFixed(2)),
      ),
    ),
  );
}

function evidence(gc: Runtime, r: Report): HTMLElement {
  const id = r.action?.id ?? r.decision?.id;
  let ex: Explanation | null = null;
  try {
    ex = id ? gc.explain(id) : null;
  } catch {
    ex = null;
  }
  const d: Decision | undefined = ex?.decision ?? r.decision;
  const wrap = h("div", { class: "evidence" });
  if (ex?.changed || r.action?.changed) {
    wrap.append(h("h4", null, "What changed"), h("div", null, ex?.changed ?? r.action?.changed ?? ""));
  }
  const facts = ex?.facts ?? d?.facts ?? [];
  if (facts.length) wrap.append(h("h4", null, "What GenClass saw"), h("ul", null, facts.map((f) => h("li", null, f))));
  if (d) {
    wrap.append(h("h4", null, `Diagnosis · ${d.diagnosis}`), probBars(d.diagnosisProbabilities, d.diagnosis));
    if (Object.keys(d.probabilities).length) wrap.append(h("h4", null, `Action · ${d.action}${d.executed ? "" : " (not run)"}`), probBars(d.probabilities, d.action));
    if (!d.executed && d.reason) wrap.append(h("div", { class: "muted", style: { marginTop: "6px" } }, `Passive action ran: ${d.reason}`));
  }
  if (ex?.timeline?.length) wrap.append(h("h4", null, "Timeline"), h("pre", null, ex.timeline.join("\n")));
  if (ex?.situationText) {
    const pre = h("pre", { hidden: true }, ex.situationText);
    const btn = h("button", { class: "btn btn-ghost btn-xs", type: "button" }, "Show the exact situation sent to the model");
    btn.addEventListener("click", () => {
      pre.hidden = !pre.hidden;
      btn.textContent = pre.hidden ? "Show the exact situation sent to the model" : "Hide situation";
    });
    wrap.append(h("h4", null, "Model input"), btn, pre);
  }
  if (!wrap.childElementCount) wrap.append(h("div", { class: "muted" }, "No explanation is available for this entry any more."));
  return wrap;
}

export interface ActivityPanel {
  el: HTMLElement;
  counts: { prevented: number; flagged: number };
}

export function mountActivity(gc: Runtime, mode: GcMode, overlayHost: HTMLElement | null): ActivityPanel {
  const counts = { prevented: 0, flagged: 0 };
  const prevented = h("span", { class: "badge badge-accent", title: "Interventions (non-passive actions that ran)" }, "0 prevented");
  const flagged = h("span", { class: "badge badge-warn", title: "Detections" }, "0 flagged");
  const list = h("div", { class: "activity-list", role: "log", "aria-live": "polite" });
  const observed = h("div", { class: "trial-note num" }, "Observed nothing yet.");
  const consulted = h("div", { class: "trial-note num", hidden: true });

  const emptyText =
    mode === "off"
      ? "GenClass is installed in observe mode with no model: it records what the app does but never decides or changes anything. This is the baseline."
      : "Watching. Nothing has needed GenClass yet. Turn up the chaos and use the app.";
  const empty = h("div", { class: "activity-empty", html: `${icon(mode === "off" ? "eye" : "shield")}<div>${esc(emptyText)}</div>` });
  list.append(empty);

  const el = h(
    "section",
    { class: "panel", id: "activity" },
    h("div", { class: "panel-head" }, h("h2", null, "GenClass activity"), h("div", { class: "spacer" }), h("div", { class: "activity-counters" }, prevented, flagged)),
    list,
    consulted,
    observed,
  );

  const shieldHost = overlayHost ? h("div", { class: "shield-toasts" }) : null;
  if (overlayHost && shieldHost) overlayHost.appendChild(shieldHost);

  const items: { at: number; time: HTMLTimeElement }[] = [];
  nativeSetInterval(() => {
    const now = performance.now();
    for (const it of items) it.time.textContent = ago(now - it.at);
  }, 5000);

  // Model status: one row, updated in place (the runtime may report the same status more than once).
  let statusRow: HTMLElement | null = null;
  let statusMsg = h("div", { class: "act-msg" });
  const add = (r: Report) => {
    if (r.kind === "status") {
      if (statusMsg.textContent === body(r)) return;
      statusMsg.textContent = body(r);
      if (!statusRow) {
        statusRow = h("div", { class: "act", "data-kind": "status" });
        statusRow.innerHTML = `<div class="act-icon">${icon("info")}</div>`;
        statusMsg = h("div", { class: "act-msg" }, body(r));
        statusRow.append(h("div", { class: "act-main" }, statusMsg));
        empty.remove();
        list.append(statusRow);
      }
      return;
    }
    const a: ActionRecord | undefined = r.action;
    const d: Decision | undefined = r.decision;
    if (r.kind === "intervene") counts.prevented++;
    else counts.flagged++;
    prevented.textContent = `${counts.prevented} prevented`;
    flagged.textContent = `${counts.flagged} flagged`;

    const at = performance.now();
    const time = h("time", null, "just now");
    items.push({ at, time });
    const tier = a?.tier ?? d?.tier ?? "guard";
    const row = h("div", { class: "act fresh", "data-kind": r.kind, "data-tier": tier });
    row.innerHTML = `<div class="act-icon">${icon(r.kind === "intervene" ? (tier === "heal" ? "heal" : "shield") : "flag")}</div>`;
    const meta = h("div", { class: "act-meta" });
    if (d) {
      meta.append(h("span", { class: "badge badge-outline" }, `${d.diagnosis} ${d.diagnosisConfidence.toFixed(2)}`));
      if (r.kind === "intervene") meta.append(h("span", { class: tier === "heal" ? "badge badge-heal" : "badge badge-accent" }, `${a?.action ?? d.action} · ${tier}`));
      else if (d.action) {
        const what = d.action.replace(/_/g, " ");
        meta.append(h("span", { class: "badge", title: d.reason ?? "" }, d.executed ? `chose ${what}` : `chose ${what} · not run`));
      }
      meta.append(h("span", { class: "muted", style: { fontSize: "11.5px" } }, fmtMs(d.latencyMs)));
    }
    meta.append(h("span", { class: "grow" }));
    let undoBtn: HTMLButtonElement | null = null;
    if (a?.undo) {
      undoBtn = h("button", { class: "btn btn-secondary btn-xs", type: "button", html: `${icon("undo")}Undo` });
      undoBtn.addEventListener("click", () => {
        try {
          a.undo!();
          row.classList.add("undone");
          undoBtn!.disabled = true;
          undoBtn!.textContent = "Undone";
          toast(`Undone: ${a.changed}`);
        } catch (e) {
          toast(`Undo failed: ${String(e)}`);
        }
      });
      meta.append(undoBtn);
    }
    const evBtn = h("button", { class: "btn btn-ghost btn-xs", type: "button", "aria-expanded": "false" }, "Evidence");
    let ev: HTMLElement | null = null;
    evBtn.addEventListener("click", () => {
      if (ev) {
        ev.remove();
        ev = null;
        row.classList.remove("open");
        evBtn.setAttribute("aria-expanded", "false");
        return;
      }
      ev = evidence(gc, r);
      row.querySelector(".act-main")!.appendChild(ev);
      row.classList.add("open");
      evBtn.setAttribute("aria-expanded", "true");
    });
    meta.append(evBtn);
    row.append(h("div", { class: "act-main" }, h("div", { class: "act-title" }, titleFor(r), time), h("div", { class: "act-msg" }, body(r)), meta));
    empty.remove();
    list.prepend(row);
    nativeSetTimeout(() => row.classList.remove("fresh"), 2500);

    if (r.kind === "intervene" && overlayHost) {
      overlayHost.classList.remove("gc-flash");
      void overlayHost.offsetWidth;
      overlayHost.classList.add("gc-flash");
    }
    if (r.kind === "intervene" && shieldHost) {
      const card = h("div", { class: "shield-toast", "data-tier": tier, role: "status" });
      card.innerHTML = `<div class="icon">${icon(tier === "heal" ? "heal" : "shield")}</div>`;
      const row2 = h("div", { class: "row" });
      if (a?.undo && undoBtn) {
        const u = h("button", { class: "btn btn-xs", type: "button", html: `${icon("undo")}Undo` });
        u.addEventListener("click", () => {
          undoBtn!.click();
          close();
        });
        row2.append(u);
      }
      const more = h("button", { class: "btn btn-ghost btn-xs", type: "button" }, "Details");
      more.addEventListener("click", () => {
        row.scrollIntoView({ block: "nearest", behavior: "smooth" });
        if (!ev) evBtn.click();
        close();
      });
      row2.append(more);
      card.append(h("div", { class: "title" }, `GenClass: ${titleFor(r).toLowerCase()}`), h("div", { class: "msg" }, a?.changed || body(r)), row2);
      shieldHost.prepend(card);
      while (shieldHost.childElementCount > 3) shieldHost.lastElementChild?.remove();
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        card.classList.add("leaving");
        nativeSetTimeout(() => card.remove(), 240);
      };
      nativeSetTimeout(close, 7000);
    }
  };

  gc.on("report", add);

  // Every model consultation, including the ones that never became a report (passive, too late, low confidence).
  const dec = { n: 0, acted: 0, passive: 0, late: 0, low: 0, expected: 0, mode: 0, lat: [] as number[] };
  let decDirty = false;
  gc.on("decide", (d) => {
    dec.n++;
    dec.lat.push(d.latencyMs);
    if (d.executed && d.tier !== "passive") dec.acted++;
    else if (d.executed) dec.passive++;
    else if (d.reason?.includes("hold budget")) dec.late++;
    else if (d.reason?.includes("below the")) dec.low++;
    else if (d.reason?.includes("expected")) dec.expected++;
    else dec.mode++;
    decDirty = true;
  });
  nativeSetInterval(() => {
    if (!decDirty) return;
    decDirty = false;
    const sorted = dec.lat.slice().sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const parts = [`Model consulted ${dec.n}× (median ${Math.round(med)} ms)`];
    if (dec.acted) parts.push(`${dec.acted} acted`);
    if (dec.passive) parts.push(`${dec.passive} chose to let it be`);
    if (dec.late) parts.push(`${dec.late} answered after the hold budget`);
    if (dec.low) parts.push(`${dec.low} below the confidence threshold`);
    if (dec.expected) parts.push(`${dec.expected} judged expected`);
    if (dec.mode) parts.push(`${dec.mode} not allowed in this mode`);
    consulted.hidden = false;
    consulted.textContent = parts.join(" · ");
  }, 500);

  // What the observation layer has seen (works in every mode).
  const seen = { events: 0, requests: 0, writes: 0, user: 0 };
  let dirty = false;
  gc.on("event", (e) => {
    seen.events++;
    if (e.kind === "op.start" && /^(GET|POST|PUT|PATCH|DELETE|HEAD)\b/.test(e.name)) seen.requests++;
    else if (e.kind === "state") seen.writes++;
    else if (e.kind === "user") seen.user++;
    dirty = true;
  });
  nativeSetInterval(() => {
    if (!dirty) return;
    dirty = false;
    observed.textContent = `Observed ${seen.user} user actions · ${seen.requests} requests · ${seen.writes} state writes · ${seen.events} events`;
  }, 500);

  return { el, counts };
}
