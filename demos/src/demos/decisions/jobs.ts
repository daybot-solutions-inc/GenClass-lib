// The app's background jobs (the backup upload). Shared by the app and the plugin that tells GenClass about it.
import { api } from "../../shared/api.ts";

export interface JobInfo {
  id: number;
  name: string;
  startedAt: number;
  progress: number;
  paused: boolean;
}

export class BackgroundJobs extends EventTarget {
  current: JobInfo | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;

  running(): JobInfo | null {
    return this.current && !this.current.paused ? this.current : null;
  }

  private emitChange(type: "start" | "progress" | "end" | "pause" | "resume") {
    this.dispatchEvent(new CustomEvent(type, { detail: this.current }));
    this.dispatchEvent(new CustomEvent("change", { detail: this.current }));
  }

  async start(): Promise<void> {
    if (this.current) return;
    const res = await fetch(api("backup"), { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { job } = (await res.json()) as { job: { id: number } };
    this.current = { id: job.id, name: "photo backup", startedAt: performance.now(), progress: 0, paused: false };
    this.emitChange("start");
    this.timer = setInterval(() => void this.poll(), 1000);
  }

  private async poll(): Promise<void> {
    if (!this.current) return;
    try {
      const res = await fetch(api("backup"));
      if (!res.ok) return;
      const s = (await res.json()) as { active: boolean; paused: boolean; progress: number };
      if (!this.current) return;
      this.current = { ...this.current, progress: s.progress, paused: s.paused };
      if (!s.active && !s.paused) {
        clearInterval(this.timer);
        this.current = { ...this.current, progress: 1 };
        this.emitChange("end");
        this.current = null;
        this.dispatchEvent(new CustomEvent("change", { detail: null }));
      } else this.emitChange("progress");
    } catch {
      /* keep polling */
    }
  }

  async pause(): Promise<void> {
    if (!this.current) return;
    await fetch(api("backup/pause"), { method: "POST" });
    if (this.current) this.current = { ...this.current, paused: true };
    this.emitChange("pause");
  }

  async resume(): Promise<void> {
    if (!this.current) return;
    await fetch(api("backup/resume"), { method: "POST" });
    if (this.current) this.current = { ...this.current, paused: false };
    this.emitChange("resume");
  }
}

/** One controller per page. */
export const jobs = new BackgroundJobs();
