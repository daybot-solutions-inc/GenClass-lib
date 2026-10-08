// Editor oracle (test code). Compares what the user typed, what the editor shows, what the server stored and
// what the save indicator claimed, over the whole session.
import type { Oracle, OracleContext } from "../../shared/demo-def.ts";
import { epochNow } from "../../shared/server.ts";
import type { Score } from "../../shared/types.ts";
import type { ServerNote } from "../../server/worlds/editor.ts";
import { nativeClearInterval, nativeSetInterval } from "../../shared/native.ts";

const LIE_BUG_MS = 1500;

interface Sample {
  t: number;
  text: string;
  status: string;
}

export function editorOracle(ctx: OracleContext): Oracle {
  const body = () => ctx.el.querySelector<HTMLTextAreaElement>('[data-testid="note-body"]');
  const status = () => ctx.el.querySelector<HTMLElement>('[data-testid="save-status"]')?.dataset.state ?? "";
  const samples: Sample[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const sample = () => samples.push({ t: epochNow(), text: body()?.value ?? "", status: status() });

  return {
    start() {
      timer = nativeSetInterval(sample, 25);
    },
    check(cond) {
      if (cond === "loaded") return (body()?.value.length ?? 0) > 0;
      return false;
    },
    async finish(): Promise<Score> {
      sample();
      nativeClearInterval(timer);
      const truth = await ctx.link.truth<{ notes: Record<string, ServerNote> }>();
      const id = String(ctx.scenario.intent.noteId ?? "n1");
      const note = truth.state.notes[id];
      const history = note.history;
      const intended = history[0].body + String(ctx.scenario.intent.typed ?? "");
      const last = samples[samples.length - 1];
      const serverAt = (t: number) => {
        let b = history[0].body;
        for (const h of history) if (h.t <= t) b = h.body;
        return b;
      };

      // How long did the indicator claim "saved" while the server held something else?
      let lieMs = 0;
      let maxLie = 0;
      let run = 0;
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1];
        const dt = samples[i].t - a.t;
        const claimsSaved = a.status === "saved" || a.status === "idle";
        if (a.t >= ctx.t0 && claimsSaved && serverAt(a.t) !== a.text) {
          lieMs += dt;
          run += dt;
          maxLie = Math.max(maxLie, run);
        } else run = 0;
      }

      // Visible text losses: the editor text got shorter without the user deleting (a revert).
      let reverts = 0;
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1].text;
        const b = samples[i].text;
        if (b.length < a.length - 1 && a.startsWith(b)) reverts++;
      }

      const lostLocal = last.text !== intended;
      const lostServer = note.body !== last.text;
      const finalLie = (last.status === "saved" || last.status === "idle") && lostServer;
      const lastKey = ctx.marks.get("lastKey") ?? ctx.t0;
      let latencyMs = NaN;
      if (!lostServer && !finalLie) {
        let j = samples.length - 1;
        const good = (s: Sample) => (s.status === "saved" || s.status === "idle") && serverAt(s.t) === s.text;
        while (j > 0 && good(samples[j - 1]) && samples[j - 1].t >= lastKey) j--;
        latencyMs = Math.max(0, samples[j].t - lastKey);
      }
      const reasons: string[] = [];
      if (lostLocal) reasons.push("the editor lost text the user typed");
      if (lostServer) reasons.push("the server copy differs from the editor");
      if (finalLie) reasons.push("“Saved” shown while the server holds older text");
      else if (maxLie > LIE_BUG_MS) reasons.push(`“Saved” was untrue for ${(maxLie / 1000).toFixed(1)} s`);
      return {
        bug: reasons.length > 0,
        reasons,
        metrics: {
          lostLocal: lostLocal ? 1 : 0,
          lostServer: lostServer ? 1 : 0,
          finalLie: finalLie ? 1 : 0,
          lieMs: Math.round(lieMs),
          maxLieMs: Math.round(maxLie),
          reverts,
          saves: history.length - 1,
          latencyMs: Number.isFinite(latencyMs) ? Math.round(latencyMs) : NaN,
        },
      };
    },
  };
}
