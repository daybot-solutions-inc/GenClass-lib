// Field journal that asks GenClass about the current moment before doing things:
//   ask (noul)   "is this a good moment to start the heavy backup?"
//   decide       "which image quality should the gallery load?"
//   ask (noul)   "would leaving now lose unsaved work?"
//   ask (score)  "how healthy is the connection?"
// Without a model (GenClass Off) every question rejects and the app uses the fixed defaults most apps ship:
// start the backup now, load full quality, warn on leave only when its dirty flag is set (the flag clears as soon
// as a save starts), and report the connection as good while the browser says it is online.
import type { AppContext } from "../../shared/demo-def.ts";
import { api } from "../../shared/api.ts";
import { jobs } from "./jobs.ts";
import "./app.css";

const LEVELS = ["failing", "poor", "fair", "good", "excellent"] as const;
type Level = (typeof LEVELS)[number];
type Quality = "full" | "reduced" | "thumbnails";

interface Photo {
  id: string;
  caption: string;
  hue: number;
  bytes: number;
}

export interface DecisionEntry {
  id: number;
  q: "backup" | "quality" | "leave" | "health";
  question: string;
  answer: string;
  source: "genclass" | "default";
  detail: string;
  askedAt: number;
  ms: number;
}

const QUESTION_TEXT: Record<DecisionEntry["q"], string> = {
  backup: "Good moment to start the backup?",
  quality: "Which photo quality to load?",
  leave: "Would leaving now lose work?",
  health: "How healthy is the connection?",
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function kb(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.round(bytes / 1000)} KB`;
}

export function mountDecisions({ gc, el }: AppContext): void {
  const journal = gc.atom("journal", { title: "Ridge traverse", body: "", version: 0, dirty: false, save: "idle" as "idle" | "saving" | "saved" | "error" });
  const gallery = gc.atom("gallery", { quality: null as Quality | null, photos: [] as Photo[], loading: false });
  const decisions: DecisionEntry[] = [];
  let decisionSeq = 0;

  el.innerHTML = `
    <div class="dj">
      <header class="dj-head">
        <div class="dj-brand"><span class="dj-logo">⛰</span><div><b>Field Journal</b><small>Day 3 · North ridge</small></div></div>
        <div class="dj-head-right">
          <button class="dj-health" type="button" data-testid="health" data-level=""><i></i><span>Check connection</span></button>
          <button class="dj-leave" type="button" data-testid="leave">Leave</button>
        </div>
      </header>
      <div class="dj-body">
        <section class="dj-editor">
          <div class="dj-editor-bar"><span class="dj-save" data-testid="journal-save" data-state="idle"></span></div>
          <textarea data-testid="journal-body" spellcheck="false" aria-label="Journal entry"></textarea>
        </section>
        <aside class="dj-side">
          <section class="dj-card">
            <div class="dj-card-head"><b>Photo backup</b><span class="dj-chip" data-testid="backup-state">Idle</span></div>
            <div class="dj-progress"><i data-testid="backup-progress"></i></div>
            <p class="dj-note" data-testid="backup-note">Uploads the journal and 12 photos (about 30 MB).</p>
            <button class="dj-btn" type="button" data-testid="backup">Back up now</button>
          </section>
          <section class="dj-card">
            <div class="dj-card-head"><b>Photos</b><span class="dj-chip" data-testid="quality">Not loaded</span></div>
            <div class="dj-photos" data-testid="photos"></div>
            <button class="dj-btn" type="button" data-testid="load-photos">Load photos</button>
          </section>
        </aside>
      </div>
      <section class="dj-log">
        <div class="dj-log-head"><b>Decisions this session</b><span>asked to GenClass, or answered by the app's defaults</span></div>
        <ol data-testid="decisions"></ol>
      </section>
      <div class="dj-overlay" data-testid="leave-confirm" hidden>
        <div class="dj-dialog" role="dialog" aria-modal="true" aria-labelledby="dj-leave-title">
          <h3 id="dj-leave-title">Leave with unsaved changes?</h3>
          <p>Some of your journal has not reached the server yet.</p>
          <div class="dj-dialog-row"><button class="dj-btn ghost" type="button" data-testid="leave-anyway">Leave anyway</button><button class="dj-btn" type="button" data-testid="stay">Stay</button></div>
        </div>
      </div>
      <div class="dj-overlay" data-testid="closed" hidden>
        <div class="dj-dialog"><h3>Journal closed</h3><p>See you on the trail.</p><div class="dj-dialog-row"><button class="dj-btn" type="button" data-testid="reopen">Open again</button></div></div>
      </div>
    </div>`;

  const $ = <T extends HTMLElement>(id: string) => el.querySelector<T>(`[data-testid="${id}"]`)!;
  const bodyEl = $<HTMLTextAreaElement>("journal-body");
  const saveEl = $("journal-save");
  const logEl = $("decisions");

  // ------------------------------------------------------------------ asking, with the app's fallbacks
  async function decide<T>(
    q: DecisionEntry["q"],
    ask: () => Promise<{ value: T; detail: string }>,
    fallback: () => T,
    show: (v: T) => string,
  ): Promise<T> {
    const askedAt = Date.now();
    const t0 = performance.now();
    let value: T;
    let source: DecisionEntry["source"] = "genclass";
    let detail = "";
    try {
      const r = await ask();
      value = r.value;
      detail = r.detail;
    } catch (e) {
      value = fallback();
      source = "default";
      detail = (e as Error)?.name === "GenClassUnavailableError" ? "no model: app default" : "no answer in time: app default";
    }
    const entry: DecisionEntry = { id: ++decisionSeq, q, question: QUESTION_TEXT[q], answer: show(value), source, detail, askedAt, ms: Math.round(performance.now() - t0) };
    decisions.push(entry);
    renderLog();
    return value;
  }

  function renderLog() {
    logEl.innerHTML = decisions
      .slice()
      .reverse()
      .map(
        (d) => `<li data-testid="decision" data-q="${d.q}" data-answer="${esc(d.answer)}" data-source="${d.source}" data-asked-at="${d.askedAt}" data-ms="${d.ms}">
          <span class="dj-q">${esc(d.question)}</span>
          <span class="dj-a">${esc(d.answer)}</span>
          <span class="dj-src ${d.source}">${d.source === "genclass" ? "GenClass" : "default"}</span>
          <span class="dj-detail">${esc(d.detail)} · ${d.ms} ms</span>
        </li>`,
      )
      .join("");
  }

  // ------------------------------------------------------------------ journal autosave
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  async function saveJournal() {
    const j = journal.get();
    journal.set((s) => ({ ...s, dirty: false, save: "saving" }));
    try {
      const res = await fetch(api("journal"), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: j.title, body: j.body }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const saved = (await res.json()) as { version: number };
      journal.set((s) => ({ ...s, version: saved.version, save: s.dirty ? s.save : "saved" }));
    } catch {
      journal.set((s) => ({ ...s, save: "error" }));
    }
  }
  bodyEl.addEventListener("input", () => {
    journal.set((s) => ({ ...s, body: bodyEl.value, dirty: true, save: "idle" }));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveJournal, 800);
  });

  // ------------------------------------------------------------------ backup
  let postponedOnce = false;
  async function backup(trigger: "click" | "retry") {
    if (jobs.current) return;
    const go = await decide(
      "backup",
      async () => {
        const a = await gc.ask(
          {
            type: "noul",
            instructions: "Is this a good moment to start a heavy background upload without slowing down what the user is doing?",
            criteria: { true: "yes: the user is idle and requests are fast and succeeding", false: "no: the user is busy, work is in flight, or the network is struggling" },
          },
          { timeoutMs: 2500 },
        );
        return { value: a.noul >= 0.5, detail: `P(good moment) = ${a.noul.toFixed(2)}` };
      },
      () => true,
      (v) => (v ? "start now" : "postpone"),
    );
    if (!go) {
      $("backup-state").textContent = "Postponed";
      $("backup-note").textContent = "Not now: GenClass thinks it would get in the way. Trying again in 6 s.";
      if (trigger === "click" && !postponedOnce) {
        postponedOnce = true;
        setTimeout(() => void backup("retry"), 6000);
      }
      return;
    }
    postponedOnce = false;
    try {
      await jobs.start();
    } catch {
      $("backup-state").textContent = "Failed";
      $("backup-note").textContent = "The backup could not start. It will be retried later.";
    }
  }
  jobs.addEventListener("change", () => {
    const j = jobs.current;
    const state = $("backup-state");
    const bar = $("backup-progress");
    if (!j) {
      state.textContent = "Done";
      bar.style.width = "100%";
      $("backup-note").textContent = "Backed up just now.";
      return;
    }
    state.textContent = j.paused ? "Paused" : `${Math.round(j.progress * 100)}%`;
    bar.style.width = `${Math.round(j.progress * 100)}%`;
    $("backup-note").textContent = j.paused ? "Paused so the app stays responsive." : "Uploading in the background…";
  });

  // ------------------------------------------------------------------ photos
  async function loadPhotos() {
    const q = await decide<Quality>(
      "quality",
      async () => {
        const v = await gc.decide(
          "Which image quality should the photo gallery load right now?",
          {
            full: "full resolution: requests are fast and reliable",
            reduced: "reduced resolution: requests are slow or the connection is busy",
            thumbnails: "thumbnails only: requests are failing or extremely slow",
          },
          { timeoutMs: 2500 },
        );
        return { value: v, detail: "chosen by GenClass" };
      },
      () => "full",
      (v) => v,
    );
    gallery.set((g) => ({ ...g, quality: q, loading: true }));
    $("quality").textContent = q === "full" ? "Full quality" : q === "reduced" ? "Reduced" : "Thumbnails";
    try {
      const res = await fetch(api(`photos?quality=${q}`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { photos: Photo[] };
      gallery.set((g) => ({ ...g, photos: data.photos, loading: false }));
    } catch {
      gallery.set((g) => ({ ...g, loading: false }));
      $("quality").textContent = "Failed to load";
    }
  }
  gallery.subscribe((g) => {
    $("photos").innerHTML = g.loading
      ? Array.from({ length: 12 }, () => `<span class="dj-ph skeleton"></span>`).join("")
      : g.photos.map((p) => `<span class="dj-ph" style="--h:${p.hue}" title="${esc(p.caption)} · ${kb(p.bytes)}"><em>${esc(p.caption)}</em></span>`).join("");
  });

  // ------------------------------------------------------------------ connection health
  async function checkHealth() {
    const level = await decide<Level>(
      "health",
      async () => {
        const a = await gc.ask({ type: "score", instructions: "How healthy is the connection between this page and its server right now?", criteria: [...LEVELS] }, { timeoutMs: 2500 });
        const i = Math.max(0, Math.min(LEVELS.length - 1, Math.round(a.score)));
        return { value: LEVELS[i], detail: `expected level ${a.score.toFixed(2)} of 0–4` };
      },
      () => (navigator.onLine ? "good" : "failing"),
      (v) => v,
    );
    const btn = $("health");
    btn.dataset.level = level;
    btn.querySelector("span")!.textContent = `Connection: ${level}`;
  }

  // ------------------------------------------------------------------ leave
  async function leave() {
    const lose = await decide(
      "leave",
      async () => {
        const a = await gc.ask(
          {
            type: "noul",
            instructions: "If the user closed this page right now, would they lose changes that the server has not stored yet?",
            criteria: { true: "yes: there are edits the server does not have", false: "no: everything the user typed is stored" },
          },
          { timeoutMs: 2500 },
        );
        return { value: a.noul >= 0.5, detail: `P(would lose work) = ${a.noul.toFixed(2)}` };
      },
      () => journal.get().dirty,
      (v) => (v ? "warn" : "let go"),
    );
    if (lose) $("leave-confirm").hidden = false;
    else $("closed").hidden = false;
  }

  $("backup").addEventListener("click", () => void backup("click"));
  $("load-photos").addEventListener("click", () => void loadPhotos());
  $("health").addEventListener("click", () => void checkHealth());
  $("leave").addEventListener("click", () => void leave());
  $("stay").addEventListener("click", () => ($("leave-confirm").hidden = true));
  $("leave-anyway").addEventListener("click", () => {
    $("leave-confirm").hidden = true;
    $("closed").hidden = false;
  });
  $("reopen").addEventListener("click", () => ($("closed").hidden = true));

  journal.subscribe((j) => {
    if (bodyEl.value !== j.body) bodyEl.value = j.body;
    saveEl.dataset.state = j.save;
    saveEl.textContent = j.save === "saving" ? "Saving…" : j.save === "saved" ? `Saved · v${j.version}` : j.save === "error" ? "Couldn’t save" : j.dirty ? "Edited" : "";
  });

  // A small heartbeat, like most apps have, to show sync state.
  setInterval(() => void fetch(api("ping")).catch(() => {}), 2500);

  void (async () => {
    const res = await fetch(api("journal"));
    if (res.ok) {
      const j = (await res.json()) as { title: string; body: string; version: number };
      journal.set((s) => ({ ...s, title: j.title, body: j.body, version: j.version, save: "saved" }));
    }
  })();
  renderLog();
}
