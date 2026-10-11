// Demo registry: copy shared by the landing page, the page chrome (injected at build time) and the trial UI.
// Plain data only (also imported by vite.config.ts in Node).
import type { DemoId } from "./protocol.ts";

export interface DemoInfo {
  id: DemoId;
  n: string;
  title: string;
  tagline: string;
  stack: string;
  summary: string;
  wrong: string[];
  scored: string[];
  /** Short failure label for cards. */
  failure: string;
  /** How to see the failure by hand (HTML). */
  tryIt: string;
}

export const DEMOS: DemoInfo[] = [
  {
    id: "search",
    n: "01",
    title: "Search typeahead",
    tagline: "Out-of-order responses",
    failure: "stale responses",
    tryIt:
      'Pick <b>Busy</b> under Network chaos, then type a city such as <kbd>santiago</kbd> at normal speed. With GenClass <b>Off</b>, the list flickers back to older results and sometimes ends up showing the results for <i>sa</i> or <i>san</i>; the server log below shows the answers landing out of order. Then try <b>Guard</b>: GenClass is consulted about those late writes, and anything it does is listed under Activity.',
    stack: "Vanilla TS · gc.atom",
    summary:
      "A city search that fetches as you type. Short prefixes match more cities and take longer to answer, so an older response can land after a newer one and replace the right results with the wrong ones.",
    wrong: [
      "Typing sends GET /api/search?q=… after a 150 ms debounce, with no request ordering guard.",
      "Short prefixes match many cities and take longest to answer, so the answer for “sa” can arrive after the answer for “santiago” and overwrite it.",
      "The list then shows results for a query that is no longer in the box, sometimes until the next keystroke.",
    ],
    scored: [
      "The final list must equal the results for the final query.",
      "Mismatch time: how long the list showed another query's results after the current query's answer had arrived.",
      "Latency: last keystroke → correct results on screen.",
    ],
  },
  {
    id: "editor",
    n: "02",
    title: "Notes autosave",
    tagline: "Overlapping saves and stale echoes",
    failure: "lost edits",
    tryIt:
      'Pick <b>Busy</b>, then keep typing in the note for a few seconds. With <b>Off</b>, characters vanish when an older save echoes back, and “Saved” appears while the server still has an older text. Compare with <b>Guard</b>.',
    stack: "Vanilla TS · Redux + genclassEnhancer",
    summary:
      "A notes editor that autosaves while you type and replaces the note with the server's echo of each save. When saves overlap, the echo of an older save can wipe out what you typed since, and the “Saved” badge can lie.",
    wrong: [
      "Saves fire 700 ms after typing stops and at least every 3 s while typing, without waiting for the previous save.",
      "Each response replaces the note with the server copy unless the user typed in the last 300 ms, a guard that only works when saves answer quickly.",
      "Any successful response shows “Saved”, even the echo of an older version.",
      "Saves can reach the server out of order and leave an older text stored.",
    ],
    scored: [
      "The editor ends with exactly the text the user typed.",
      "The server copy equals the editor text once everything settles.",
      "“Saved” is only shown while the server holds the text on screen (time-integrated).",
    ],
  },
  {
    id: "checkout",
    n: "03",
    title: "Cart & checkout",
    tagline: "Double submits, retries, drifting totals",
    failure: "duplicate orders",
    tryIt:
      'Add a few items, set <b>Flaky</b> or raise <b>Lost responses</b>, then double-click <b>Place order</b>. With <b>Off</b> you can get two orders and a total that no longer matches the lines.',
    stack: "React 19 · useGenClassState",
    summary:
      "A cart with optimistic quantity changes and a Place order button. Impatient double clicks and retries after timeouts create duplicate orders; partial failures leave the total out of step with the lines.",
    wrong: [
      "Place order is not disabled while the request is in flight.",
      "Timeouts and 5xx are retried, but POST /api/orders has no idempotency key.",
      "The total is kept incrementally: when the server clamps a quantity to stock or a change fails, the line is corrected but the total is not.",
    ],
    scored: [
      "Orders created on the server = orders the user meant to place.",
      "The displayed total equals the sum of the displayed lines.",
      "The displayed cart equals the server cart; no “Order placed” without an order.",
    ],
  },
  {
    id: "status",
    n: "04",
    title: "Service status",
    tagline: "Failure streaks, latency spikes, retry storms",
    failure: "false alarms",
    tryIt:
      'Pick <b>Flaky</b> and watch the cards: with <b>Off</b>, healthy services flip to “Unreachable”, banners pile up and the server log fills with retries. Use the incident buttons below to start a real outage.',
    stack: "Vanilla TS · gc.guard over a custom store",
    summary:
      "An ops dashboard that polls six services every 2 s. The status API itself is flaky: one failed poll flips a healthy service to “Unreachable”, failures are retried immediately, and slow polls pile up.",
    wrong: [
      "Polling runs on setInterval and never waits for the previous round.",
      "Failed polls are retried right away, up to three attempts, with no backoff.",
      "A single failed poll marks the service unreachable and raises an error banner.",
    ],
    scored: [
      "Wrong-status time: how long a card disagreed with the true service status beyond one poll of grace.",
      "Error banners shown to the user.",
      "Requests sent compared with a steady one per service per interval.",
    ],
  },
  {
    id: "board",
    n: "05",
    title: "Team board",
    tagline: "Optimistic moves vs out-of-order live events",
    failure: "divergent state",
    tryIt:
      'Pick <b>Busy</b> (reordering), then move cards quickly with the arrow buttons while teammates move cards too. With <b>Off</b>, cards jump back to old columns and the board drifts from the server.',
    stack: "React 19 · Zustand + genclass middleware",
    summary:
      "A kanban board with optimistic card moves and a live event stream from teammates. Events can arrive out of order and moves can conflict; the app applies every event as it comes and rolls back failed moves from a stale snapshot.",
    wrong: [
      "Live events are applied without checking card versions.",
      "The echo of your own move can arrive after your next move of the same card.",
      "A failed move restores the whole board as it was before the move, discarding updates that arrived meanwhile.",
    ],
    scored: [
      "After everything settles, the board on screen equals the server's board.",
      "Divergence time: how long any card showed the wrong column beyond a 1 s grace.",
    ],
  },
  {
    id: "decisions",
    n: "06",
    title: "Runtime decisions",
    tagline: "Ask GenClass about the current moment",
    failure: "bad timing",
    tryIt:
      'Type in the journal, then press <b>Back up now</b> or <b>Load photos</b>; the app asks GenClass whether now is a good time and which quality to use. Try it with <b>Storm</b> chaos and while typing. With <b>Off</b> the app falls back to fixed defaults.',
    stack: "Vanilla TS · ask / decide · custom plugin",
    summary:
      "A field journal that asks GenClass typed questions about what is happening right now: is this a good moment for a heavy backup, which image quality to load, would leaving lose work, how healthy is the connection. A small plugin adds device and background-job signals and a pause action.",
    wrong: [
      "Without GenClass the app uses fixed defaults: start the backup on schedule, always load full quality, and warn on leave only when its dirty flag is set (the flag clears as soon as a save starts).",
      "Those defaults are wrong exactly when it matters: while the user types, on a struggling network, or when a save fails.",
    ],
    scored: [
      "Every decision is compared with the scenario's ground truth: user activity, in-flight work, server conditions and what the server actually stored.",
      "Bug rate = share of wrong decisions; also reported per question.",
    ],
  },
];

export const DEMO_BY_ID: Record<DemoId, DemoInfo> = Object.fromEntries(DEMOS.map((d) => [d.id, d])) as Record<
  DemoId,
  DemoInfo
>;

export const REPO_URL = "https://github.com/genclass-dev/GenClass-lib";
