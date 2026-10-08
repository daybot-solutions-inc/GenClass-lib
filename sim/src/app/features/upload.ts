// Upload queue with progress and cancel. Users drop files; the app uploads them with a concurrency limit (POST, a
// non-idempotent create) and ticks a client-side progress estimate on a timer while each request is in flight.
// "✕" cancels a queued or in-flight upload (AbortController) or removes a finished one (DELETE). Knobs: an
// idempotency key reused across retries (else a retry after a timeout whose first attempt committed stores the file
// twice), automatic vs manual retry, reconcile after cancel (an aborted request may already have reached the server:
// GET by client id, DELETE the orphan) or trust the abort, "Retry" acting only on failed rows (else it restarts rows
// that are still uploading), derived uploaded count / bytes kept on every path or not.

import { rel, type FeatureDef, type Relation, type UserStep } from "../feature.js";
import type { CallOpts } from "../kit.js";
import { apiOf, errMsg, weightsOf } from "./common.js";

export interface UploadSpec {
  id: string;
  api: string;
  store: string;
  f: { files: string; progress: string; done: string; bytes: string; busy: string; error: string };
  path: string;
  itemPath: string;
  files: { name: string; size: number }[];
  concurrency: number;
  tickMs: number;
  kbPerSec: number;
  timeoutMs: number;
  idem: boolean;
  retry: "auto" | "manual";
  cancel: "abort-only" | "reconcile";
  reconcileMs: number;
  retryGuard: boolean;
  totals: boolean;
  totalsSkip: "none" | "retry" | "remove";
  maxKb: number;
  labels: { drop: string; cancel: string; retry: string };
}

type Obj = Record<string, unknown>;
interface Row {
  clientId: string;
  name: string;
  size: number;
  status: "queued" | "uploading" | "retrying" | "done" | "failed";
  id?: string;
}
interface Run {
  cid: string;
  ctl: AbortController;
  timer: unknown;
  op: number;
}

const EXT = ["pdf", "png", "jpg", "csv", "docx", "mp4", "zip", "heic", "xlsx"];

export const upload: FeatureDef<UploadSpec> = {
  kind: "upload",
  make({ rng, entity, naming, id, api, clean }) {
    const g = <T>(good: T, v: T): T => (clean ? good : v);
    const retry = rng.weighted([["auto", 3], ["manual", 3]] as const);
    const files: UploadSpec["files"] = [];
    const n = rng.int(4, 9);
    for (let i = 0; i < n; i++) {
      const w = rng.pick(entity.words).replace(/[^a-z0-9]+/gi, "-").toLowerCase() || entity.s;
      files.push({ name: `${w}${rng.pick(["-", "_", " "])}${rng.int(1, 40)}.${rng.pick(EXT)}`, size: Math.max(5, Math.min(30000, Math.round(rng.lognormal(900, 1.2)))) });
    }
    const verb = rng.pick(["Upload", "Attach", "Add files", "Import"]);
    return {
      id,
      api: api.name,
      store: naming.store(rng.pick(["uploads", "attachments", "upload queue", "files"])),
      f: {
        files: naming.word(rng.pick(["files", "uploads", "queue", "attachments"])),
        progress: naming.word(rng.pick(["progress", "percent", "uploadProgress"])),
        done: naming.word(rng.pick(["uploaded", "completed", "doneCount", "finished"])),
        bytes: naming.word(rng.pick(["uploadedKb", "bytesDone", "totalUploaded", "sizeDone"])),
        busy: naming.field("loading", id + "u"),
        error: naming.field("error", id + "u"),
      },
      path: naming.route(rng.pick(["uploads", "files", "attachments"])),
      itemPath: naming.route(rng.pick(["uploads", "files"]), ":id"),
      files,
      concurrency: rng.int(1, 3),
      tickMs: rng.pick([300, 400, 500, 750]),
      kbPerSec: rng.float(300, 3000),
      timeoutMs: rng.weighted([[0, 2], [rng.int(3000, 12000), 3]] as const),
      idem: g(true, rng.bool(retry === "auto" ? 0.5 : 0.35)),
      retry,
      cancel: g("reconcile", rng.weighted([["reconcile", 2], ["abort-only", 3]] as const)),
      reconcileMs: rng.int(300, 1200),
      retryGuard: g(true, rng.bool(0.6)),
      totals: rng.bool(0.65),
      totalsSkip: g("none", rng.weighted([["none", 3], ["retry", 2], ["remove", 1]] as const)),
      maxKb: 25000,
      labels: { drop: `input[type=file] "${verb}"`, cancel: rng.pick(["Cancel", "Remove", "✕"]), retry: `button "${rng.pick(["Retry", "Retry failed", "Try again"])}"` },
    };
  },
  pattern(s) {
    return [`retry:${s.retry}`, s.idem ? "idem" : "noidem", `cancel:${s.cancel}`, s.retryGuard ? "retry-guard" : "retry-noguard", `conc:${s.concurrency}`, s.totals ? `totals:${s.totalsSkip === "none" ? "all" : `skip-${s.totalsSkip}`}` : "nototals"];
  },
  relations(s): Relation[] {
    if (!s.totals) return [];
    const L = `${s.store}.${s.f.files}`;
    const D = `${s.store}.${s.f.done}`;
    const B = `${s.store}.${s.f.bytes}`;
    const done = (st: Obj) => ((rel.field(st, L) as Row[]) ?? []).filter((r) => r.status === "done");
    return [
      { fields: [D, L], desc: "uploaded count equals files marked done", check: (st) => Number(rel.field(st, D)) === done(st).length },
      { fields: [B, L], desc: "uploaded size equals sum of done file sizes", check: (st) => Number(rel.field(st, B)) === done(st).reduce((a, r) => a + Number(r.size), 0) },
    ];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:uploads`;
    srv.route(
      "GET",
      s.path,
      (req) => {
        const cid = req.query.get("clientId");
        return { status: 200, body: api.list(db.list(coll).filter((x) => !cid || x.clientId === cid)) };
      },
      { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` },
    );
    srv.route(
      "POST",
      s.path,
      (req) => {
        const b = (req.body ?? {}) as Obj;
        const name = String(b.name ?? "");
        const size = Number(b.size ?? 0);
        if (!name || !(size > 0)) return { status: 422, body: api.error("invalid", "empty file") };
        if (size > s.maxKb) return { status: 413, body: api.error("too_large", `files over ${Math.round(s.maxKb / 1000)} MB are not allowed`) };
        const cid = String(b.clientId ?? "");
        // Content key per client upload id: the same file dropped twice is two uploads, a re-sent request a duplicate.
        const it = db.insert(coll, { name, size, clientId: cid }, `${cid}|${name}|${size}`, req.t);
        return { status: 201, body: api.one(it) };
      },
      { feature: s.id, kind: "upload", idempotent: false, resource: `c:${coll}` },
    );
    srv.route(
      "DELETE",
      s.itemPath,
      (req) => (db.remove(coll, req.params.id!, req.t) ? { status: 204 } : { status: 404, body: api.error("not_found", "no such file") }),
      { feature: s.id, kind: "write", idempotent: true, resource: `c:${coll}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const key = `${s.id}.files`;
    const init: Obj = { [F.files]: [] as Row[], [F.progress]: {} as Record<string, number>, [F.busy]: false, [F.error]: null };
    if (s.totals) {
      init[F.done] = 0;
      init[F.bytes] = 0;
    }
    const S = env.store(s.store, s.id, init, {
      weights: weightsOf([[F.files, 1], [F.progress, 0.15], [F.done, 0.5], [F.bytes, 0.4], [F.busy, 0.1], [F.error, 0]]),
      resync: () => resync(),
    });
    const order: string[] = [];
    const queue: string[] = [];
    const runs = new Set<Run>();
    const cancelled = new Set<string>();
    const intents = new Map<string, number>();
    const rowsOf = (p: Obj) => (p[F.files] as Row[]) ?? [];
    const find = (cid: string) => rowsOf(S.get()).find((r) => r.clientId === cid);
    const totalsOf = (rows: Row[]): Obj => {
      const done = rows.filter((r) => r.status === "done");
      return { [F.done]: done.length, [F.bytes]: done.reduce((a, r) => a + r.size, 0) };
    };
    const withRows = (p: Obj, rows: Row[], totals: boolean, busy: boolean): Obj => ({ ...p, [F.files]: rows, [F.busy]: busy, ...(s.totals && totals ? totalsOf(rows) : {}) });
    const busyNow = () => runs.size + queue.length > 0;
    const idemOf = (cid: string) => `up-${env.rng.fork("idem", s.id, cid).token(12)}`;

    async function resync(): Promise<void> {
      const op = kit.op({ role: "resync", method: "GET", url: s.path, key, background: true });
      const r = await kit.call(op, { timeoutMs: 8000 });
      if (!r.ok) return;
      const server = kit.api.unlist(r.body).items;
      kit.write(S, (p) => {
        const rows = rowsOf(p).map((row) => {
          const hit = server.find((x) => x.clientId === row.clientId);
          return hit && row.status !== "done" ? { ...row, status: "done" as const, id: String(hit.id) } : row;
        });
        return withRows(p, rows, true, p[F.busy] === true);
      }, { role: "resync", op, key });
    }
    function tick(cid: string, size: number): void {
      const step = Math.max(1, Math.round((100 * s.tickMs) / Math.max(200, (size / s.kbPerSec) * 1000)));
      kit.write(S, (p) => {
        const pr = { ...((p[F.progress] as Record<string, number>) ?? {}) };
        if (!(cid in pr)) return p;
        pr[cid] = Math.min(95, (pr[cid] ?? 0) + step);
        return { ...p, [F.progress]: pr };
      }, { role: "progress", key: `${s.id}.progress` });
    }
    function pump(): void {
      while (runs.size < s.concurrency && queue.length) start(queue.shift()!, 1);
    }
    function start(cid: string, attempt: number, retryOf?: number): void {
      const row = find(cid);
      if (!row) return;
      const intent = intents.get(cid);
      const ctl = new AbortController();
      const other = [...runs].find((x) => x.cid === cid);
      const op = kit.op({
        role: "upload",
        method: "POST",
        url: s.path,
        body: { name: row.name, size: row.size, clientId: cid },
        intent,
        key: `${s.id}.file.${cid}`,
        idempotent: false,
        attempt,
        handled: s.retry === "auto",
        ...(retryOf !== undefined ? { retryOf } : {}),
        ...(other ? { dupOf: other.op } : {}),
      });
      const run: Run = { cid, ctl, timer: env.setInterval(() => tick(cid, row.size), s.tickMs), op: op.id };
      runs.add(run);
      const fresh = attempt === 1 && !other;
      kit.write(S, (p) => {
        const rows = rowsOf(p).map((r) => (r.clientId === cid ? { ...r, status: "uploading" as const } : r));
        return { ...withRows(p, rows, false, true), ...(fresh ? { [F.progress]: { ...((p[F.progress] as Record<string, number>) ?? {}), [cid]: 0 } } : {}) };
      }, { role: "uploading", op, intent, key });
      kit.spawn(
        async () => {
          const opts: CallOpts = { signal: ctl.signal };
          if (s.idem) opts.headers = { "idempotency-key": idemOf(cid) };
          if (s.timeoutMs) opts.timeoutMs = s.timeoutMs;
          const r = await kit.call(op, opts);
          env.clearInterval(run.timer);
          if (cancelled.has(cid)) {
            runs.delete(run);
            if (r.outcome === "aborted") afterCancel(cid, intent);
            pump();
            return;
          }
          if (r.ok) {
            runs.delete(run);
            const it = kit.api.unone(r.body);
            const skip = s.totals && s.totalsSkip === "retry" && attempt > 1;
            const busy = busyNow();
            kit.write(S, (p) => {
              const rows = rowsOf(p).map((x) => (x.clientId === cid ? { ...x, status: "done" as const, id: String(it.id ?? "") } : x));
              return { ...withRows(p, rows, !skip, busy), [F.progress]: { ...((p[F.progress] as Record<string, number>) ?? {}), [cid]: 100 } };
            }, { role: "created", op, intent, key, ...(skip ? { anomaly: "partial" } : {}) });
            pump();
            return;
          }
          const retriable = r.outcome === "timeout" || r.outcome === "neterr" || r.status >= 500 || r.status === 429;
          if (s.retry === "auto" && retriable && attempt < 3) {
            kit.write(S, (p) => withRows(p, rowsOf(p).map((x) => (x.clientId === cid ? { ...x, status: "retrying" as const } : x)), false, true), { role: "retrying", op, intent, key });
            await env.sleep(1000 * 2 ** (attempt - 1));
            runs.delete(run);
            if (cancelled.has(cid)) return pump();
            start(cid, attempt + 1, op.id);
            return;
          }
          runs.delete(run);
          const msg = `${row.name}: ${r.status === 413 ? "file too large" : errMsg(r.status, r.outcome)}`;
          const busy = busyNow();
          kit.write(S, (p) => ({ ...withRows(p, rowsOf(p).map((x) => (x.clientId === cid ? { ...x, status: "failed" as const } : x)), false, busy), [F.error]: msg }), { role: "error", op, intent, key });
          kit.shownError();
          pump();
        },
        "uncaught",
        { cause: "upload-failed", diagnosis: "failing", op },
      );
    }
    /** An aborted upload may already have reached the server: look it up by client id and delete the orphan. */
    function afterCancel(cid: string, intent: number | undefined): void {
      if (s.cancel === "abort-only") return;
      kit.spawn(async () => {
        await env.sleep(s.reconcileMs);
        const g = kit.op({ role: "reconcile", method: "GET", url: `${s.path}?clientId=${encodeURIComponent(cid)}`, intent, key, background: true, handled: true });
        const r = await kit.call(g, { timeoutMs: 8000 });
        if (!r.ok) return;
        for (const it of kit.api.unlist(r.body).items) {
          const d = kit.op({ role: "delete-orphan", method: "DELETE", url: s.itemPath.replace(":id", String(it.id)), intent, key, background: true, handled: true });
          await kit.call(d, { timeoutMs: 8000 });
        }
      }, "swallow");
    }
    function remove(row: Row, intent: number): void {
      const skip = s.totals && s.totalsSkip === "remove";
      const busy = busyNow();
      kit.write(S, (p) => withRows(p, rowsOf(p).filter((x) => x.clientId !== row.clientId), !skip, busy), { role: "remove", intent, key, ...(skip ? { anomaly: "partial" } : {}) });
      if (!row.id) return;
      const op = kit.op({ role: "delete", method: "DELETE", url: s.itemPath.replace(":id", row.id), intent, key: `${s.id}.file.${row.clientId}` });
      kit.spawn(
        async () => {
          const r = await kit.call(op, { timeoutMs: 8000 });
          if (r.ok || r.status === 404) return;
          kit.write(S, (p) => ({ ...withRows(p, [...rowsOf(p), row], true, p[F.busy] === true), [F.error]: `${row.name}: ${errMsg(r.status, r.outcome)}` }), { role: "rollback", op, intent, key });
          kit.shownError();
        },
        "uncaught",
        { cause: "remove-failed", diagnosis: "failing", op },
      );
    }
    function cancel(cid: string, intent: number): void {
      const row = find(cid);
      if (!row) return;
      if (row.status === "done") return remove(row, intent);
      const qi = queue.indexOf(cid);
      if (qi >= 0) queue.splice(qi, 1);
      if (row.status === "uploading" || row.status === "retrying") {
        cancelled.add(cid);
        for (const run of runs) {
          if (run.cid !== cid) continue;
          env.clearInterval(run.timer);
          run.ctl.abort();
        }
      }
      const busy = busyNow();
      kit.write(S, (p) => {
        const pr = { ...((p[F.progress] as Record<string, number>) ?? {}) };
        delete pr[cid];
        return { ...withRows(p, rowsOf(p).filter((x) => x.clientId !== cid), true, busy), [F.progress]: pr };
      }, { role: "cancel", intent, key });
    }
    return {
      init() {
        kit.spawn(async () => {
          const op = kit.op({ role: "load", method: "GET", url: s.path, key, background: true });
          await kit.call(op, { timeoutMs: 8000 });
        }, "swallow");
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "add") {
          const picked = ((step.args?.files as number[]) ?? []).map((i) => s.files[i % s.files.length]!);
          const rows: Row[] = picked.map((f) => {
            const cid = `u${env.rng.fork("upload", s.id, order.length).token(10)}`;
            order.push(cid);
            intents.set(cid, intent);
            queue.push(cid);
            return { clientId: cid, name: f.name, size: f.size, status: "queued" };
          });
          kit.write(S, (p) => ({ ...p, [F.files]: [...rowsOf(p), ...rows], [F.busy]: true, [F.error]: null }), { role: "queued", intent, key });
          pump();
        } else if (step.action === "cancel") {
          const cid = order[Number(step.args?.file ?? 0)];
          if (cid) cancel(cid, intent);
        } else if (step.action === "retry") {
          // Guard: only failed rows. Defect: everything not done, including rows still uploading.
          const again = rowsOf(S.get()).filter((r) => (s.retryGuard ? r.status === "failed" : r.status !== "done" && r.status !== "queued"));
          if (!again.length) return;
          for (const r of again) {
            cancelled.delete(r.clientId);
            intents.set(r.clientId, intent);
            queue.push(r.clientId);
          }
          const ids = new Set(again.map((r) => r.clientId));
          kit.write(S, (p) => ({ ...withRows(p, rowsOf(p).map((x) => (ids.has(x.clientId) && x.status === "failed" ? { ...x, status: "queued" as const } : x)), false, true), [F.error]: null }), { role: "retry", intent, key });
          pump();
        }
      },
      cond(name) {
        if (name === "failed") return rowsOf(S.get()).some((r) => r.status === "failed");
        return runs.size > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    const added: number[] = [];
    let t = win.t0 + user.think(0.7);
    while (t < win.t1 - 1500 && added.length < 14) {
      const r = user.rng.next();
      if (r < 0.55 || added.length === 0) {
        const n = user.rng.weighted([[1, 4], [2, 3], [3, 2], [4, 1]] as const);
        const idxs: number[] = [];
        for (let i = 0; i < n; i++) idxs.push(user.rng.int(0, s.files.length - 1));
        steps.push({ t, feature: s.id, action: "add", ui: { kind: "change", target: s.labels.drop, value: idxs.map((i) => s.files[i]!.name).join(", ") }, args: { files: idxs }, intent: { kind: "upload", key: `${s.id}.add`, mode: "accumulate", accidental: false } });
        // Changed their mind about one of the files (often while it is still uploading).
        if (user.rng.bool(0.3)) {
          const j = user.rng.int(0, n - 1);
          const k = added.length + j;
          steps.push({ t: t + user.rng.float(250, 2500), feature: s.id, action: "cancel", ui: { kind: "click", target: `button "${s.labels.cancel} ${s.files[idxs[j]!]!.name}"` }, args: { file: k }, intent: { kind: "cancel", key: `${s.id}.file.${k}`, mode: "replace", accidental: false } });
        }
        added.push(...idxs);
      } else if (r < 0.75) {
        const c = user.click(t, s.labels.retry, "retry", { kind: "retry", key: `${s.id}.retry` });
        for (const st of c.steps) st.when = "failed";
        steps.push(...c.steps);
      } else {
        const k = user.rng.int(0, added.length - 1);
        steps.push({ t, feature: s.id, action: "cancel", ui: { kind: "click", target: `button "${s.labels.cancel} ${s.files[added[k]!]!.name}"` }, args: { file: k }, intent: { kind: "remove", key: `${s.id}.file.${k}`, mode: "replace", accidental: false } });
      }
      t += user.think(1.4);
    }
    return steps;
  },
};
