// Worker process: one headless Chromium; labels the trajectories the main process hands it.

import { APPS } from "./apps.gen.js";
import { Runner } from "./browser.js";
import { generateTrajectory, type GenOptions } from "./trajectory.js";

const port = Number(process.env.RW_PORT ?? 8790);
const opts = JSON.parse(process.env.RW_OPTS ?? "{}") as GenOptions;
const runner = new Runner(port);
await runner.start();
process.send!({ type: "ready" });
process.on("message", async (m: { type: string; seed?: number }) => {
  if (m.type === "stop") {
    await runner.close();
    process.exit(0);
  }
  if (m.type === "seed" && m.seed !== undefined) {
    try {
      const out = await generateTrajectory(m.seed, APPS, runner, opts);
      process.send!({ type: "done", out });
    } catch (e) {
      process.send!({ type: "failed", seed: m.seed, error: String((e as Error)?.stack ?? e).slice(0, 600) });
    }
  }
});
