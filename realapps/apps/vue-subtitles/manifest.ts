import type { AppManifest } from "../../src/shared/manifest.js";

const lines: [string, string][] = [
  ["NARRATOR", "The harbour had been quiet for eleven winters."],
  ["MAYA", "Theo, the lamp is out again."],
  ["THEO", "Then somebody climbed the tower last night."],
  ["MAYA", "Nobody climbs that tower in a storm."],
  ["THEO", "Look at the footprints on the stairs."],
  ["DR. OKONJO", "Those prints are older than they look."],
  ["MAYA", "How would you know that, doctor?"],
  ["DR. OKONJO", "Salt dries white on fresh boots."],
  ["THEO", "So whoever it was came from the sea."],
  ["NARRATOR", "The ferry bell rang once, then stopped."],
  ["MAYA", "That bell hasn't rung since the wreck."],
  ["THEO", "Stay close to the railing."],
  ["DR. OKONJO", "Bring the logbook from the office."],
  ["MAYA", "The last entry is in my father's hand."],
  ["THEO", "Read it out loud, slowly."],
  ["MAYA", "Light the lamp whatever happens."],
  ["NARRATOR", "Below them, the tide began to turn."],
  ["THEO", "Something is moving under the pier."],
  ["DR. OKONJO", "Seals, most likely. Or driftwood."],
  ["MAYA", "Driftwood doesn't swim against the current."],
  ["THEO", "Get the torch from the boat shed."],
  ["MAYA", "The shed door is locked from inside."],
  ["DR. OKONJO", "Then someone is still in there."],
  ["NARRATOR", "No one answered when they knocked."],
  ["THEO", "Hello? We only want to talk."],
  ["MAYA", "Listen. Footsteps on the roof."],
  ["DR. OKONJO", "Back to the tower, all of you."],
  ["THEO", "Not without the logbook."],
  ["MAYA", "I have it. Run!"],
  ["NARRATOR", "The lamp flickered on by itself."],
  ["THEO", "Who turned that on?"],
  ["MAYA", "Nobody. Nobody is up there."],
  ["DR. OKONJO", "Write down the time, exactly."],
  ["THEO", "Two minutes past midnight."],
  ["MAYA", "Same as the night of the wreck."],
  ["NARRATOR", "To be continued."],
];
const cues = lines.map(([speaker, text], i) => {
  const start = 1200 + i * 4900 + ((i * 370) % 900);
  return { id: 6400 + i, n: i + 1, start, end: start + 3600, speaker, text };
});

const manifest: AppManifest = {
  name: "vue-subtitles",
  title: "Subtitle editor",
  framework: "vue",
  libs: ["vue", "@tanstack/vue-query", "axios", "rt.guard", "rt.atom"],
  domain: "subtitle-editor",
  entry: "main.ts",
  integration: "stores",
  build: { vueCompiler: true },
  server: {
    base: "/api",
    collections: [{ name: "cues", seed: cues, versioned: true, envelope: "items", pageSize: 50, actions: { nudge: { inc: "start" } } }],
  },
  variants: {
    echo: ["keep-newer-typing", "blind"],
    save: ["serial", "parallel"],
    windowSeq: ["latest", "blind"],
    debounce: [600, 0],
    nudgeGuard: ["pending", "none"],
  },
  affordances: [
    { id: "edit", kind: "click", sel: "li.cue button.edit", nth: 6, intent: "nth", weight: 2.2, mode: "replace", key: "edit" },
    { id: "retype", kind: "type", sel: "form.cue-editor textarea[name=text]", values: ["Head back before the tide.", "Did you hear that?", "Keep the lamp lit.", "The ferry isn't coming."], clear: true, weight: 2, mode: "replace", key: "text", after: ["edit"], requires: "form.cue-editor textarea" },
    { id: "append", kind: "type", sel: "form.cue-editor textarea[name=text]", values: [" (whispers)", " Right?", " Over.", "…"], weight: 1.5, mode: "replace", key: "text", after: ["edit"], requires: "form.cue-editor textarea" },
    { id: "done", kind: "click", sel: "form.cue-editor button.done", weight: 0.5, mode: "replace", after: ["edit"], resets: ["edit"], requires: "form.cue-editor button.done" },
    { id: "nudge", kind: "click", sel: "li.cue button.nudge", nth: 12, intent: "nth", weight: 2, mode: "accumulate", dblclickP: 0.2, impatientP: 0.15, requires: "li.cue button.nudge:not([disabled])" },
    { id: "next", kind: "click", sel: "button.next-window", weight: 1.3, mode: "accumulate", dblclickP: 0.06, impatientP: 0.08, requires: "button.next-window:not([disabled])" },
    { id: "prev", kind: "click", sel: "button.prev-window", weight: 0.8, mode: "accumulate", dblclickP: 0.05, requires: "button.prev-window:not([disabled])" },
  ],
  external: [
    // collaborators working on other cues of the same episode
    { kind: "update", target: "cues", perMin: 3, data: [{ text: "Can you hear the bell?" }, { text: "Stay where I can see you." }, { text: "[thunder rumbling]" }, { text: "We're not alone here." }] },
    { kind: "action", target: "cues", perMin: 1.5, verb: "nudge", by: 100 },
  ],
  weights: { "editor.error": 0, "editor.status": 0, "editor.saving": 0.1, drafts: 0.3, "editor.label": 0, "editor.from": 0.5 },
  relations: [{ name: "no cue listed twice", fields: ["cues.items"], check: (s) => !s.cues || new Set(s.cues.items.map((c: { id: number }) => c.id)).size === s.cues.items.length }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
