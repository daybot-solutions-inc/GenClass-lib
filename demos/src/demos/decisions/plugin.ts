// A custom GenClass plugin, the way an app team would write one (CONTRACT §9):
//   - its own observer: page visibility, online/offline, the Battery API, and the app's background jobs
//     (recorded as ops so they show up in GenClass's timeline and concurrency facts);
//   - facts about those signals for every situation;
//   - its own action: pause the background upload (an app capability), offered while a job runs.
import type { Plugin } from "@genclass/runtime";
import type { BackgroundJobs } from "./jobs.ts";

interface BatteryLike extends EventTarget {
  level: number;
  charging: boolean;
}

export function backgroundWorkPlugin(jobs: BackgroundJobs): Plugin {
  let hiddenSince: number | null = null;
  let battery: { level: number; charging: boolean } | null = null;

  return {
    name: "background-work",

    setup(api) {
      const offs: (() => void)[] = [];
      const listen = (target: EventTarget, type: string, fn: EventListener) => {
        target.addEventListener(type, fn);
        offs.push(() => target.removeEventListener(type, fn));
      };

      hiddenSince = document.visibilityState === "hidden" ? api.clock.now() : null;
      listen(document, "visibilitychange", () => {
        hiddenSince = document.visibilityState === "hidden" ? api.clock.now() : null;
        api.emit("page.visibility", { state: document.visibilityState });
      });
      listen(window, "online", () => api.emit("network.online"));
      listen(window, "offline", () => api.emit("network.offline"));

      const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
      nav
        .getBattery?.()
        .then((b) => {
          const update = () => {
            battery = { level: b.level, charging: b.charging };
          };
          update();
          listen(b, "levelchange", update);
          listen(b, "chargingchange", () => {
            update();
            api.emit("battery", { level: b.level, charging: b.charging });
          });
        })
        .catch(() => {});

      // The app's background jobs become ops, so GenClass sees them start, run and end.
      let op: number | null = null;
      listen(jobs, "start", () => {
        op = api.recordOp("task", "background photo backup", { detail: "uploading the journal and photos" });
      });
      listen(jobs, "end", () => {
        if (op !== null) api.endOp(op, "ok");
        op = null;
      });
      listen(jobs, "pause", () => api.emit("backup.paused"));
      listen(jobs, "resume", () => api.emit("backup.resumed"));

      return () => offs.forEach((f) => f());
    },

    facts() {
      const out: string[] = [];
      const job = jobs.current;
      if (job) {
        const secs = ((performance.now() - job.startedAt) / 1000).toFixed(1);
        out.push(
          job.paused
            ? `A background photo backup is paused at ${Math.round(job.progress * 100)}%.`
            : `A background photo backup has been uploading for ${secs} s and is ${Math.round(job.progress * 100)}% done; it competes with the app's own requests for bandwidth.`,
        );
      }
      if (hiddenSince !== null) out.push("The page is in a background tab.");
      if (!navigator.onLine) out.push("The browser reports that the device is offline.");
      if (battery && !battery.charging && battery.level < 0.2) out.push(`The battery is at ${Math.round(battery.level * 100)}% and discharging.`);
      return out;
    },

    actions: [
      {
        name: "pause_background",
        description: "pause the app's background upload until requests succeed again",
        on: ["failure", "stall"],
        tier: "heal",
        risk: "low",
        applicable: () => jobs.running() !== null,
        async run(ctx) {
          await jobs.pause();
          ctx.describe("Paused the background photo backup so the app's own requests get the bandwidth.");
          ctx.onUndo(() => void jobs.resume());
        },
      },
    ],
  };
}
