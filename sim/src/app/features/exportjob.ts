// Async export job: POST /exports (non-idempotent: every call creates a job) → job id; the client polls
// GET /exports/:id until the job is done (the server finishes it a while after creation, computed from req.t vs the
// creation time) and then shows the download link. Knobs: start button disabled while a job runs / idempotency
// key (guards) vs neither (defect: a double click creates two jobs); create timeout + retry with the same key or
// without one (duplicate job when the first attempt committed); poll interval (fast = overload) and backoff; stop
// polling on done (defect: keeps polling); stop polling when the dialog closes (defect: polls after navigating
// away); overall time limit (defect: none).

import { hashAll } from "../../rng.js";
import { AppEnv } from "../env.js";
import type { FeatureDef, UserStep } from "../feature.js";
import { apiOf, errMsg, weightsOf } from "./common.js";

export interface ExportjobSpec {
  id: string;
  api: string;
  store: string;
  f: { jobs: string; status: string; progress: string; link: string; busy: string; open: string; error: string };
  noun: string;
  createPath: string;
  jobPath: string;
  formats: string[];
  durMs: [number, number];
  dedupe: "disable" | "idem" | "none";
  createTimeoutMs: number;
  retry: "none" | "same-key" | "no-key";
  pollMs: number;
  backoff: boolean;
  stopOnDone: boolean;
  cleanupOnClose: boolean;
  maxWaitMs: number;
  openLabel: string;
  closeLabel: string;
}

const RANK: Record<string, number> = { queued: 1, running: 2, done: 3, failed: 3 };

export const exportjob: FeatureDef<ExportjobSpec> = {
  kind: "exportjob",
  make({ rng, entity, naming, id, api, clean }) {
    const dedupe = rng.weighted([["disable", 3], ["idem", 2], ["none", 3]] as const);
    const retry = rng.weighted([["none", 3], ["same-key", 2], ["no-key", 2]] as const);
    const fast = rng.bool(0.25);
    const stopOnDone = rng.bool(0.75);
    const cleanupOnClose = rng.bool(0.5);
    const maxWait = rng.weighted([[0, 2], [rng.int(30000, 90000), 3]] as const);
    const lo = rng.int(1500, 6000);
    return {
      id,
      api: api.name,
      store: naming.store(rng.pick(["export", "report", "download"]), rng.pick(["job", "dialog", "panel", ""]) || "job"),
      f: { jobs: rng.pick(["jobs", "exports", "history", "recent"]), status: naming.field("status", id), progress: rng.pick(["progress", "percent", "pct"]), link: rng.pick(["downloadUrl", "fileUrl", "link", "href"]), busy: naming.field("loading", id), open: rng.pick(["open", "visible", "showDialog", "isOpen"]), error: naming.field("error", id) },
      noun: entity.p,
      createPath: naming.route(entity.p, rng.pick(["exports", "export-jobs", "reports"])),
      jobPath: naming.route(entity.p, rng.pick(["exports", "export-jobs", "reports"]), ":id"),
      formats: rng.sample(["csv", "xlsx", "pdf", "json"], rng.int(1, 3)),
      durMs: [lo, lo + rng.int(1000, 9000)],
      dedupe: clean && dedupe === "none" ? "idem" : dedupe,
      createTimeoutMs: rng.weighted([[0, 2], [rng.int(2500, 7000), 2]] as const),
      retry: clean && retry === "no-key" ? "same-key" : retry,
      pollMs: fast && !clean ? rng.int(150, 350) : rng.int(700, 2500),
      backoff: clean || rng.bool(0.35),
      stopOnDone: clean || stopOnDone,
      cleanupOnClose: clean || cleanupOnClose,
      maxWaitMs: clean && !maxWait ? 60000 : maxWait,
      openLabel: `button "${rng.pick(["Export", "Download", "Export data", "Generate report"])}"`,
      closeLabel: `button "${rng.pick(["Close", "Done", "Back", "×"])}"`,
    };
  },
  pattern(s) {
    return [`dedupe:${s.dedupe}`, `retry:${s.retry}`, s.pollMs < 400 ? "poll:fast" : "poll:normal", s.backoff ? "backoff" : "nobackoff", s.stopOnDone ? "stop-done" : "poll-after-done", s.cleanupOnClose ? "cleanup" : "nocleanup", s.maxWaitMs ? "maxwait" : "nomaxwait"];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:exports`;
    const dur = (id: string) => s.durMs[0] + (hashAll(s.id, id) % Math.max(1, s.durMs[1] - s.durMs[0]));
    srv.route(
      "POST",
      s.createPath,
      (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const format = String(b.format ?? "csv");
        if (!s.formats.includes(format)) return { status: 422, body: api.error("invalid", "unsupported format") };
        // Creation time lives in the volatile updatedAt field (not part of the job's content).
        const job = db.insert(coll, { format, scope: String(b.scope ?? "all"), updatedAt: AppEnv.EPOCH + req.t }, `${format}:${String(b.scope ?? "all")}`, req.t);
        return { status: 202, body: api.one({ id: job.id!, status: "queued" }) };
      },
      { feature: s.id, kind: "write", idempotent: false, resource: `c:${coll}` },
    );
    srv.route(
      "GET",
      s.jobPath,
      (req) => {
        const job = db.get(coll, req.params.id!);
        if (!job) return { status: 404, body: api.error("not_found", "no such export") };
        const d = dur(String(job.id));
        const el = req.t - (Number(job.updatedAt) - AppEnv.EPOCH);
        const status = el < d * 0.25 ? "queued" : el < d ? "running" : "done";
        const body: Record<string, unknown> = { id: job.id, status, progress: Math.min(100, Math.round((el / d) * 100)) };
        if (status === "done") body.url = `/files/${String(job.id)}.${String(job.format)}`;
        return { status: 200, body: api.one(body) };
      },
      { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const key = `${s.id}.export`;
    const init: Record<string, unknown> = { [F.jobs]: [], [F.status]: "idle", [F.progress]: 0, [F.link]: null, [F.busy]: false, [F.open]: false, [F.error]: null };
    const S = env.store(s.store, s.id, init, { weights: weightsOf([[F.jobs, 0.8], [F.status, 1], [F.progress, 0.2], [F.link, 1], [F.busy, 0.2], [F.open, 0.4], [F.error, 0]]) });
    let creating = 0;
    let active = 0;
    let gen = 0;
    // Jobs still running per dialog instance (a reopened dialog starts with an enabled button).
    const activeIn = new Map<number, number>();
    const bump = (g: number, d: number) => activeIn.set(g, Math.max(0, (activeIn.get(g) ?? 0) + d));
    const polling = new Set<string>();
    async function poll(jobId: string, format: string, intent: number, myGen: number): Promise<void> {
      if (polling.has(jobId)) return;
      polling.add(jobId);
      const url = s.jobPath.replace(":id", encodeURIComponent(jobId));
      const started = env.now();
      let delay = s.pollMs;
      let done = false;
      let fails = 0;
      try {
        for (let n = 0; n < 60; n++) {
          await env.sleep(delay);
          if (s.cleanupOnClose && myGen !== gen) return;
          if (s.maxWaitMs && env.now() - started > s.maxWaitMs) {
            kit.write(S, (p) => ({ ...p, [F.status]: "failed", [F.busy]: false, [F.error]: "The export is taking too long. Try again later." }), { role: "error", intent, key });
            kit.shownError();
            return;
          }
          const afterDone = done;
          const afterClose = myGen !== gen || !S.get()[F.open];
          const op = kit.op({
            role: "poll",
            method: "GET",
            url,
            intent,
            key: `${s.id}.job.${jobId}`,
            background: true,
            handled: true,
            ...(delay < 400 ? { anomaly: "storm" } : {}),
            classify: () => (afterDone ? "duplicate" : afterClose ? "stale" : undefined),
          });
          const r = await kit.call(op, { timeoutMs: 10000 });
          if (!r.ok) {
            fails++;
            if (fails >= 3 && !s.backoff) kit.write(S, (p) => ({ ...p, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, intent, key });
            if (s.backoff) delay = Math.min(10000, delay * 2);
            continue;
          }
          fails = 0;
          const job = kit.api.unone(r.body);
          const st = String(job.status ?? "queued");
          const cur = S.get();
          const row = ((cur[F.jobs] as Record<string, unknown>[]) ?? []).find((j) => j.id === jobId);
          if (row?.status !== st || (st !== "done" && cur[F.progress] !== job.progress)) {
            const classify = () => ((RANK[String(((S.get()[F.jobs] as Record<string, unknown>[]) ?? []).find((j) => j.id === jobId)?.status)] ?? 0) > (RANK[st] ?? 0) ? "stale" : undefined);
            kit.write(
              S,
              (p) => ({
                ...p,
                [F.jobs]: ((p[F.jobs] as Record<string, unknown>[]) ?? []).map((j) => (j.id === jobId ? { ...j, status: st } : j)),
                [F.status]: st,
                [F.progress]: Number(job.progress ?? 0),
                ...(st === "done" ? { [F.link]: String(job.url ?? ""), [F.busy]: active > 1 || creating > 0 } : {}),
              }),
              { role: "poll-result", op, intent, key, classify },
            );
          }
          if (st === "done") {
            if (!done) {
              active--;
              bump(myGen, -1);
            }
            done = true;
            if (s.stopOnDone) return;
          }
          if (s.backoff) delay = Math.min(5000, delay * 1.5);
        }
      } finally {
        polling.delete(jobId);
        if (!done) {
          active = Math.max(0, active - 1);
          bump(myGen, -1);
          if (active === 0 && creating === 0 && S.get()[F.busy]) kit.write(S, (p) => ({ ...p, [F.busy]: false }), { role: "busy", intent, key });
        }
      }
    }
    function start(intent: number, format: string): void {
      if (s.dedupe === "disable" && (creating > 0 || (activeIn.get(gen) ?? 0) > 0)) return;
      const it = env.know.getIntent(intent);
      const ref = it?.accidental && it.repeatOf !== undefined ? it.repeatOf : intent;
      const idem = s.dedupe === "idem" || s.retry === "same-key" ? `exp_${env.rng.fork("export", s.id, ref).token(12)}` : undefined;
      const dup = it?.accidental ? [...env.know.ops].reverse().find((o) => o.intent === it.repeatOf && o.role === "create")?.id ?? -1 : undefined;
      creating++;
      kit.write(S, (p) => ({ ...p, [F.busy]: true, [F.status]: "queued", [F.progress]: 0, [F.link]: null, [F.error]: null }), { role: "busy", intent, key });
      const myGen = gen;
      const attempt = async (n: number, retryOf?: number): Promise<void> => {
        const headers: Record<string, string> = {};
        if (idem && (n === 1 || s.retry === "same-key")) headers["idempotency-key"] = idem;
        const op = kit.op({ role: "create", method: "POST", url: s.createPath, body: { format, scope: "all" }, intent, key, idempotent: false, attempt: n, handled: s.retry !== "none", ...(retryOf !== undefined ? { retryOf } : {}), ...(dup !== undefined ? { dupOf: dup } : {}) });
        const r = await kit.call(op, s.createTimeoutMs ? { headers, timeoutMs: s.createTimeoutMs } : { headers });
        if (!r.ok && (r.outcome === "timeout" || r.outcome === "neterr" || r.status >= 500) && s.retry !== "none" && n < 3) {
          await env.sleep(600 * n);
          return attempt(n + 1, op.id);
        }
        creating--;
        if (!r.ok) {
          kit.write(S, (p) => ({ ...p, [F.busy]: creating > 0 || active > 0, [F.status]: "failed", [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, intent, key });
          kit.shownError();
          return;
        }
        const job = kit.api.unone(r.body);
        const jobId = String(job.id);
        kit.write(S, (p) => {
          const jobs = ((p[F.jobs] as Record<string, unknown>[]) ?? []).filter((j) => j.id !== jobId);
          return { ...p, [F.jobs]: [...jobs, { id: jobId, format, status: String(job.status ?? "queued") }] };
        }, { role: "created", op, intent, key });
        if (!polling.has(jobId)) {
          active++;
          bump(myGen, 1);
          await poll(jobId, format, intent, myGen);
        }
      };
      kit.spawn(() => attempt(1), "uncaught", { cause: "export-failed", diagnosis: "failing" });
    }
    return {
      handle(step: UserStep, intent: number) {
        if (step.action === "open") return kit.write(S, (p) => ({ ...p, [F.open]: true }), { role: "input", intent, key: `${s.id}.dialog` });
        if (step.action === "close") {
          gen++;
          return kit.write(S, (p) => ({ ...p, [F.open]: false }), { role: "input", intent, key: `${s.id}.dialog` });
        }
        start(intent, String(step.args?.format ?? s.formats[0]));
      },
      cond() {
        return creating > 0 || active > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(1);
    const dialog = (action: "open" | "close", target: string) => steps.push({ t, feature: s.id, action, ui: { kind: "click", target }, intent: { kind: action, key: `${s.id}.dialog`, mode: "replace", accidental: false } });
    let lastFormat = "";
    while (t < win.t1 - 2500) {
      dialog("open", s.openLabel);
      t += user.think(0.8);
      // Same format again sometimes (a fresh export of updated data: a new intent, not a duplicate).
      const format = lastFormat && user.rng.bool(0.25) ? lastFormat : user.rng.pick(s.formats);
      lastFormat = format;
      const c = user.click(t, `button "Export ${format.toUpperCase()}"`, "start", { kind: "export", key: `${s.id}.export` }, { args: { format }, pendingCond: "exporting", kind: "submit" });
      steps.push(...c.steps);
      // Leave early (navigate away while the job runs) or wait for the download link.
      t += user.rng.bool(0.3) ? user.rng.float(800, 2500) : s.durMs[1] + user.think(1.2);
      dialog("close", s.closeLabel);
      t += user.think(3);
    }
    return steps;
  },
};
