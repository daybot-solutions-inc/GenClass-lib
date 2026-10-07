import type { World, WorldDef } from "../core.ts";
import { now } from "../core.ts";

export interface JournalVersion {
  version: number;
  t: number;
  body: string;
}

interface DecisionsState {
  title: string;
  body: string;
  version: number;
  history: JournalVersion[];
  backups: { id: number; startedAt: number; endsAt: number; pausedAt?: number }[];
  photoLoads: { t: number; quality: string }[];
}

const PHOTOS = [
  ["Ridge at first light", 18],
  ["Lichen on basalt", 95],
  ["Trail marker 14", 32],
  ["Snowmelt creek", 200],
  ["Camp, night two", 240],
  ["Marmot, unimpressed", 40],
  ["Fog over the col", 210],
  ["Larches turning", 48],
  ["Summit cairn", 15],
  ["Tarn reflection", 190],
  ["Switchbacks", 30],
  ["Last light", 12],
] as const;

const BYTES = { full: 2_400_000, reduced: 380_000, thumbnails: 24_000 } as const;
const WORK = { full: 420, reduced: 150, thumbnails: 30 } as const;
export const BACKUP_MS = 8000;

function backupActive(w: World<DecisionsState>, t = now()): boolean {
  return w.state.backups.some((b) => t >= b.startedAt && t < b.endsAt && b.pausedAt === undefined);
}

/** A running backup competes for bandwidth: everything else gets slower. */
function contention(w: World<DecisionsState>): number {
  return backupActive(w) ? 350 : 0;
}

export const decisionsWorld: WorldDef<DecisionsState> = {
  demo: "decisions",
  create: () => {
    const body = "Day 3. Crossed the col before the weather turned.\n";
    return {
      title: "Ridge traverse",
      body,
      version: 1,
      history: [{ version: 1, t: now(), body }],
      backups: [],
      photoLoads: [],
    };
  },
  routes: [
    {
      method: "GET",
      pattern: /^\/journal$/,
      key: () => "journal",
      handle: (w) => ({
        status: 200,
        json: { id: "j1", title: w.state.title, body: w.state.body, version: w.state.version },
        work: contention(w),
      }),
    },
    {
      method: "PUT",
      pattern: /^\/journal$/,
      key: () => "journal/save",
      handle: (w, req) => {
        const b = req.body as { title?: string; body?: string } | undefined;
        if (!b || typeof b.body !== "string") return { status: 400, json: { error: "body must be a string" } };
        w.state.body = b.body;
        if (typeof b.title === "string") w.state.title = b.title;
        w.state.version += 1;
        w.state.history.push({ version: w.state.version, t: now(), body: b.body });
        return {
          status: 200,
          json: { id: "j1", title: w.state.title, body: w.state.body, version: w.state.version },
          work: 20 + contention(w),
          effect: `journal v${w.state.version} stored`,
        };
      },
    },
    {
      method: "GET",
      pattern: /^\/photos$/,
      key: () => "photos",
      handle: (w, req) => {
        const q = (req.query.get("quality") ?? "full") as keyof typeof BYTES;
        const quality = q in BYTES ? q : "full";
        w.state.photoLoads.push({ t: now(), quality });
        return {
          status: 200,
          json: {
            quality,
            photos: PHOTOS.map(([caption, hue], i) => ({ id: `p${i + 1}`, caption, hue, bytes: BYTES[quality] })),
          },
          work: WORK[quality] + contention(w),
          effect: `${PHOTOS.length} photos (${quality})`,
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/backup$/,
      key: () => "backup",
      handle: (w) => {
        const t = now();
        const job = { id: w.state.backups.length + 1, startedAt: t, endsAt: t + BACKUP_MS };
        w.state.backups.push(job);
        return { status: 202, json: { job }, work: 40, effect: `backup #${job.id} started` };
      },
    },
    {
      method: "POST",
      pattern: /^\/backup\/(pause|resume)$/,
      key: () => "backup/control",
      handle: (w, req) => {
        const t = now();
        const job = [...w.state.backups].reverse().find((b) => t < b.endsAt || b.pausedAt !== undefined);
        if (!job) return { status: 409, json: { error: "No backup is running" } };
        if (req.params[0] === "pause" && job.pausedAt === undefined) job.pausedAt = t;
        if (req.params[0] === "resume" && job.pausedAt !== undefined) {
          job.endsAt += t - job.pausedAt;
          job.pausedAt = undefined;
        }
        return { status: 200, json: { job }, effect: `backup #${job.id} ${req.params[0]}d` };
      },
    },
    {
      method: "GET",
      pattern: /^\/backup$/,
      key: () => "backup/status",
      handle: (w) => {
        const t = now();
        const job = [...w.state.backups].reverse().find((b) => t < b.endsAt) ?? w.state.backups[w.state.backups.length - 1];
        const at = job?.pausedAt ?? t;
        return {
          status: 200,
          json: job
            ? { active: t < job.endsAt, paused: job.pausedAt !== undefined, progress: Math.min(1, (at - job.startedAt) / BACKUP_MS), job }
            : { active: false, paused: false, progress: 0, job: null },
          work: contention(w),
        };
      },
    },
    {
      method: "GET",
      pattern: /^\/ping$/,
      key: () => "ping",
      handle: (w) => ({ status: 200, json: { ok: true, t: now() }, work: contention(w) * 0.5 }),
    },
  ],
  snapshot: (w) => ({
    body: w.state.body,
    version: w.state.version,
    history: w.state.history,
    backups: w.state.backups,
    photoLoads: w.state.photoLoads,
  }),
};
