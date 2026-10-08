// Video upload & transcode console (petite-vue templates over a local reactive object, no stores registered with
// GenClass: observe-only; fetch + AbortController). Uploading is a multi-step flow: POST /jobs creates the job, the
// file goes up in chunks (POST /jobs/:id/chunk, two in flight at a time) and a PATCH marks it queued; an encoding
// farm then picks queued jobs up and reports progress, so the list polls. Jobs can be cancelled mid-upload and
// finished ones removed. Latent bugs by flag: chunk POSTs retried without an Idempotency-Key (chunkRetry=blind: a
// chunk that landed before a 5xx is counted twice) or not retried (chunkRetry=none), the job finalized once the last
// chunk is sent instead of acknowledged (finalize=early: queued with chunks missing), cancel that only hides the job
// while its chunks keep going (cancel=ui-only: 404s, and the job reappears), polling on setInterval (poll=interval)
// and an Upload button that stays live while the job is created (uploadGuard=none: two jobs for one file).
import { createApp, reactive } from "petite-vue";
import { flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError, isAbort } from "../_shared/w3-http";

type Job = { id: number; file: string; sizeMb: number; chunks: number; received: number; status: string; progress: number };
const CHUNK_RETRY = flag("chunkRetry", "idempotency-key") as "idempotency-key" | "blind" | "none";
const FINALIZE = flag("finalize", "after-all");
const CANCEL = flag("cancel", "abort");
const POLL = flag("poll", "chain");
const UPLOAD_GUARD = flag("uploadGuard", "pending") === "pending";
const FILES: Record<string, { sizeMb: number; chunks: number }> = {
  "keynote-2026.mov": { sizeMb: 2400, chunks: 6 },
  "podcast-ep42.wav": { sizeMb: 640, chunks: 3 },
  "product-demo.mp4": { sizeMb: 1100, chunks: 4 },
  "wedding-reel.mov": { sizeMb: 1800, chunks: 5 },
};
const ACTIVE = new Set(["uploading", "queued", "encoding"]);

const s = reactive({ file: "keynote-2026.mov", jobs: [] as Job[], uploading: [] as number[], creating: false, filter: "all", error: "", notice: "" });
const ctrls = new Map<number, AbortController>();
const cancelled = new Set<number>();

function upsert(j: Job) {
  if (CANCEL === "abort" && cancelled.has(j.id)) return;
  s.jobs = s.jobs.some((x) => x.id === j.id) ? s.jobs.map((x) => (x.id === j.id ? j : x)) : [j, ...s.jobs];
}

async function upload() {
  if (UPLOAD_GUARD && s.creating) return;
  const file = s.file;
  const meta = FILES[file]!;
  s.creating = true;
  s.error = "";
  s.notice = "";
  let job: Job;
  try {
    job = await api<Job>(`/api/jobs`, "POST", { file, sizeMb: meta.sizeMb, chunks: meta.chunks, received: 0, status: "uploading", progress: 0 });
  } catch (e) {
    s.error = errText(e, `starting the upload of ${file}`);
    return;
  } finally {
    s.creating = false;
  }
  upsert(job);
  s.uploading = [...s.uploading, job.id];
  const ctl = new AbortController();
  ctrls.set(job.id, ctl);
  const signal = CANCEL === "abort" ? ctl.signal : undefined;
  const sendChunk = async (i: number) => {
    const key = CHUNK_RETRY === "idempotency-key" ? `chunk-${job.id}-${i}` : "";
    const post = () => api<Job>(`/api/jobs/${job.id}/chunk`, "POST", { index: i }, key ? { "Idempotency-Key": key } : {}, signal);
    try {
      return await post();
    } catch (e) {
      if (isAbort(e) || CHUNK_RETRY === "none" || (e instanceof HttpError && e.status > 0 && e.status < 500)) throw e;
      return post();
    }
  };
  try {
    const inflight: Promise<void>[] = [];
    for (let i = 0; i < job.chunks; i++) {
      if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
      const p = sendChunk(i).then(upsert);
      p.catch(() => undefined); // failures surface through the awaits below
      inflight.push(p);
      if (inflight.length >= 2) await inflight[inflight.length - 2];
    }
    if (FINALIZE === "after-all") await Promise.all(inflight);
    else void Promise.all(inflight).catch((e) => (s.error = errText(e, `a chunk of ${file}`)));
    const queued = await api<Job>(`/api/jobs/${job.id}`, "PATCH", { status: "queued" }, {}, signal);
    upsert(queued);
    s.notice = `${file} uploaded — waiting for an encoder.`;
  } catch (e) {
    if (!isAbort(e)) s.error = errText(e, `uploading ${file}`);
  } finally {
    s.uploading = s.uploading.filter((x) => x !== job.id);
    ctrls.delete(job.id);
  }
}

async function cancel(j: Job) {
  cancelled.add(j.id);
  if (CANCEL === "abort") ctrls.get(j.id)?.abort();
  s.jobs = s.jobs.filter((x) => x.id !== j.id);
  s.error = "";
  try {
    await api(`/api/jobs/${j.id}`, "DELETE");
    s.notice = `Cancelled ${j.file}.`;
  } catch (e) {
    s.error = errText(e, `cancelling ${j.file}`);
  }
}

async function remove(j: Job) {
  s.jobs = s.jobs.filter((x) => x.id !== j.id);
  try {
    await api(`/api/jobs/${j.id}`, "DELETE");
  } catch (e) {
    s.error = errText(e, `removing ${j.file}`);
    void loadJobs();
  }
}

async function loadJobs() {
  try {
    const items = itemsOf<Job>(await api(`/api/jobs?limit=30`)).reverse();
    s.jobs = items.filter((j) => !cancelled.has(j.id));
  } catch (e) {
    if (!s.jobs.length) s.error = errText(e, "loading your uploads");
  }
}

const label = (j: Job) =>
  j.status === "uploading" ? `uploading ${j.received}/${j.chunks} chunks` : j.status === "encoding" ? `encoding ${Math.min(100, j.progress)}%` : j.status === "queued" ? `queued (${j.received}/${j.chunks} chunks)` : j.status;
const shown = () => s.jobs.filter((j) => s.filter === "all" || (s.filter === "active" ? ACTIVE.has(j.status) : !ACTIVE.has(j.status)));

document.getElementById("app")!.innerHTML = `<div v-scope>
  <h1>Video uploads</h1>
  <section class="new"><label>File <select name="file" v-model="s.file"><option v-for="(m, f) in files" :key="f" :value="f">{{ f }} ({{ m.sizeMb }} MB)</option></select></label>
    <button type="button" class="upload" :disabled="guard && s.creating" @click="upload()">{{ s.creating ? 'Starting…' : 'Upload' }}</button></section>
  <p role="alert" v-if="s.error">{{ s.error }}</p><p class="notice" v-else-if="s.notice">{{ s.notice }}</p>
  <nav class="filters"><button v-for="f in ['all', 'active', 'done']" :key="f" type="button" :class="{ current: s.filter === f }" @click="s.filter = f">{{ f === 'all' ? 'All' : f === 'active' ? 'Active' : 'Done' }}</button></nav>
  <ul class="jobs"><li class="job" v-for="j in shown()" :key="j.id" :class="j.status">{{ j.file }} · {{ j.sizeMb }} MB · {{ label(j) }}
    <button v-if="j.status === 'uploading' || j.status === 'queued'" type="button" class="cancel" @click="cancel(j)">Cancel</button>
    <button v-if="j.status === 'done' || j.status === 'failed'" type="button" class="remove" @click="remove(j)">Remove</button></li></ul>
</div>`;
createApp({ s, files: FILES, guard: UPLOAD_GUARD, shown, label, upload: () => void upload(), cancel: (j: Job) => void cancel(j), remove: (j: Job) => void remove(j) }).mount();

void loadJobs();
if (POLL === "interval") setInterval(() => void loadJobs(), 3000);
else {
  const loop = async () => {
    await loadJobs();
    setTimeout(loop, 3000);
  };
  setTimeout(loop, 3000);
}
