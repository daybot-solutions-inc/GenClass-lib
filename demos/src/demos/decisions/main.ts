import { bootDemo } from "../../site/demo-page.ts";
import { highlight } from "../../site/highlight.ts";
import { mountDecisions } from "./app.ts";
import { jobs } from "./jobs.ts";
import { decisionsOracle } from "./oracle.ts";
import { backgroundWorkPlugin } from "./plugin.ts";
import { decisionsScenario } from "./scenario.ts";

bootDemo({
  id: "decisions",
  host: "journal.example/day-3",
  mount: mountDecisions,
  scenario: decisionsScenario,
  oracle: decisionsOracle,
  plugins: () => [backgroundWorkPlugin(jobs)],
  loaded: "loaded",
  settle: { idleMs: 600, timeoutMs: 15000, ignoreStreams: true },
  code: highlight(`const gc = GenClass.init({ plugins: [backgroundWork(jobs)] });

const now = await gc.ask({ type: "noul",
  instructions: "Is this a good moment to start a heavy upload?" });
if (now.noul >= 0.5) jobs.start();

const quality = await gc.decide("Which image quality to load?", {
  full: "requests are fast and reliable",
  reduced: "requests are slow",
  thumbnails: "requests are failing" });

// plugin: own observer (visibility, online, battery, jobs),
// facts, and an action: pause_background (heal tier)`),
});
