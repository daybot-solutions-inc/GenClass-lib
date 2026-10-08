// CRM contact import console (Vue 3 template compiled at runtime; state in a runtime atom bridged with useAtom; fetch).
// Pick a CSV and upload it (POST /imports, then the rows go up in batches of 25: POST /imports/:id/batch); once in,
// it is validated (POST …/validate: a worker marks it valid or invalid, so active imports poll), then committed (POST
// …/commit: relative, counts commits; the worker finishes it). Several imports can be in flight; finished ones are
// dismissed into the history. Latent bugs by flag: batches retried without an Idempotency-Key (batchRetry=blind: a
// batch stored before a 5xx is counted twice) or not retried (batchRetry=none), validation started once the last
// batch is sent instead of acknowledged (validateWhen=early: the worker validates a partial file), Commit buttons live
// while committing (commitGuard=none: an import is committed twice), polling on setInterval (poll=interval) and a
// history never refreshed after imports finish (history=stale).
import { createApp, defineComponent } from "vue";
import { rt, flag } from "../_shared/genclass";
import { useAtom } from "../_shared/vue-atom";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Job = { id: number; file: string; rows: number; received: number; status: string; errors: number; commits: number; createdAt?: string };
const BATCH_RETRY = flag("batchRetry", "idempotency-key") as "idempotency-key" | "blind" | "none";
const VALIDATE_WHEN = flag("validateWhen", "after-upload");
const COMMIT_GUARD = flag("commitGuard", "state");
const POLL = flag("poll", "chain");
const HISTORY = flag("history", "refetch");
const FILES: Record<string, number> = { "contacts-march.csv": 100, "webinar-signups.csv": 50, "trade-show-leads.csv": 75 };
const BATCH = 25;

const importer = rt.atom("importer", { file: "contacts-march.csv", jobs: [] as Job[], history: [] as Job[], detail: null as Job | null, starting: false, busy: [] as number[], error: "", notice: "" });
const putJob = (j: Job) => importer.update((s) => ({ ...s, jobs: s.jobs.some((x) => x.id === j.id) ? s.jobs.map((x) => (x.id === j.id ? j : x)) : [...s.jobs, j] }));
const mark = (id: number, on: boolean) => importer.update((s) => ({ ...s, busy: on ? [...s.busy, id] : s.busy.filter((x) => x !== id) }));

/** Imports left waiting for review (valid or invalid) are picked up again on load. */
async function loadActive() {
  try {
    const [valid, invalid] = await Promise.all([api(`/api/imports?status=valid&limit=10`), api(`/api/imports?status=invalid&limit=10`)]);
    const jobs = [...itemsOf<Job>(valid), ...itemsOf<Job>(invalid)];
    importer.update((s) => ({ ...s, jobs: [...jobs.filter((j) => !s.jobs.some((x) => x.id === j.id)), ...s.jobs], history: s.history.filter((h) => !jobs.some((j) => j.id === h.id)) }));
  } catch (e) {
    importer.update((s) => ({ ...s, error: errText(e, "loading pending imports") }));
  }
}

async function loadHistory() {
  try {
    const history = itemsOf<Job>(await api(`/api/imports?sort=-createdAt&limit=20`));
    importer.update((s) => ({ ...s, history: history.filter((h) => !s.jobs.some((j) => j.id === h.id)) }));
  } catch {
    /* keep the last list */
  }
}

let batchN = 0;
async function upload() {
  const s0 = importer.get();
  if (s0.starting) return;
  const file = s0.file;
  const rows = FILES[file]!;
  importer.update((s) => ({ ...s, starting: true, error: "", notice: "" }));
  let job: Job;
  try {
    job = await api<Job>(`/api/imports`, "POST", { file, rows, received: 0, status: "uploading", errors: 0, commits: 0 });
    putJob(job);
  } catch (e) {
    importer.update((s) => ({ ...s, error: errText(e, `starting the import of ${file}`) }));
    return;
  } finally {
    importer.update((s) => ({ ...s, starting: false }));
  }
  mark(job.id, true);
  try {
    const sendBatch = async (i: number) => {
      const key = BATCH_RETRY === "idempotency-key" ? `batch-${job.id}-${i}-${++batchN}` : "";
      const post = () => api<Job>(`/api/imports/${job.id}/batch`, "POST", { index: i, size: BATCH }, key ? { "Idempotency-Key": key } : {});
      const done = await post().catch((e) => (BATCH_RETRY === "none" || (e instanceof HttpError && e.status > 0 && e.status < 500) ? Promise.reject(e) : post()));
      importer.update((s) => ({ ...s, jobs: s.jobs.map((x) => (x.id === done.id && x.status === "uploading" ? done : x)) }));
    };
    const n = Math.ceil(rows / BATCH);
    const last: Promise<void>[] = [];
    for (let i = 0; i < n; i++) {
      if (VALIDATE_WHEN === "early" && i === n - 1) {
        const p = sendBatch(i);
        p.catch(() => undefined); // awaited after validation starts
        last.push(p);
      }
      else await sendBatch(i);
    }
    putJob(await api<Job>(`/api/imports/${job.id}/validate`, "POST"));
    await Promise.all(last);
    importer.update((s) => ({ ...s, notice: `${file} uploaded (${rows} rows) — validating…` }));
  } catch (e) {
    importer.update((s) => ({ ...s, error: errText(e, `uploading ${file}`) }));
  } finally {
    mark(job.id, false);
  }
}

async function step(j: Job, verb: "commit" | "validate") {
  const s0 = importer.get();
  if (s0.busy.includes(j.id) && (verb === "validate" || COMMIT_GUARD === "state")) return;
  mark(j.id, true);
  importer.update((s) => ({ ...s, error: "", notice: "" }));
  try {
    putJob(await api<Job>(`/api/imports/${j.id}/${verb}`, "POST"));
  } catch (e) {
    importer.update((s) => ({ ...s, error: errText(e, verb === "commit" ? `committing ${j.file}` : `revalidating ${j.file}`) }));
  } finally {
    mark(j.id, false);
  }
}

function dismiss(j: Job) {
  importer.update((s) => ({ ...s, jobs: s.jobs.filter((x) => x.id !== j.id), history: HISTORY === "refetch" ? s.history : s.history }));
  if (HISTORY === "refetch") void loadHistory();
}

let viewSeq = 0;
async function view(id: number) {
  const my = ++viewSeq;
  try {
    const j = await api<Job>(`/api/imports/${id}`);
    if (my === viewSeq) importer.update((s) => ({ ...s, detail: j }));
  } catch (e) {
    if (my === viewSeq) importer.update((s) => ({ ...s, error: errText(e, "opening the import") }));
  }
}

async function poll() {
  const active = importer.get().jobs.filter((j) => j.status === "validating" || j.status === "committing");
  for (const j of active) {
    try {
      const fresh = await api<Job>(`/api/imports/${j.id}`);
      importer.update((s) => ({ ...s, jobs: s.jobs.map((x) => (x.id === fresh.id && !s.busy.includes(x.id) ? fresh : x)), notice: fresh.status === "done" && j.status !== "done" ? `Imported ${fresh.rows} contacts from ${fresh.file}.` : s.notice }));
    } catch {
      /* next tick */
    }
  }
}

const App = defineComponent({
  setup() {
    const s = useAtom(importer);
    const pick = (e: Event) => importer.update((x) => ({ ...x, file: (e.target as HTMLSelectElement).value }));
    return { s, files: FILES, pick, guard: COMMIT_GUARD, upload: () => void upload(), commit: (j: Job) => void step(j, "commit"), revalidate: (j: Job) => void step(j, "validate"), dismiss, view: (id: number) => void view(id) };
  },
  template: `<div class="importer">
    <h1>Import contacts</h1>
    <section class="choose">
      <select name="file" :value="s.file" @change="pick"><option v-for="(rows, f) in files" :key="f" :value="f">{{ f }} ({{ rows }} rows)</option></select>
      <button type="button" class="upload" :disabled="s.starting" @click="upload">{{ s.starting ? 'Starting…' : 'Upload' }}</button>
    </section>
    <p v-if="s.error" role="alert">{{ s.error }}</p><p v-else-if="s.notice" class="notice">{{ s.notice }}</p>
    <ul class="jobs"><li v-for="j in s.jobs" :key="j.id" class="job">{{ j.file }} · {{ Math.min(j.received, j.rows) }}/{{ j.rows }} rows · {{ j.status }}<span v-if="j.errors"> · {{ j.errors }} errors</span>
      <button v-if="j.status === 'valid' || j.status === 'committing'" type="button" class="commit" :disabled="guard === 'state' && (s.busy.includes(j.id) || j.status !== 'valid')" @click="commit(j)">{{ j.status === 'committing' ? 'Committing…' : 'Commit' }}</button>
      <button v-if="j.status === 'invalid'" type="button" class="revalidate" :disabled="s.busy.includes(j.id)" @click="revalidate(j)">Fix &amp; revalidate</button>
      <button v-if="j.status === 'done' || j.status === 'invalid'" type="button" class="dismiss" @click="dismiss(j)">Dismiss</button></li></ul>
    <h2>Recent imports</h2>
    <ul class="history"><li v-for="h in s.history" :key="h.id" class="import">{{ h.file }} · {{ h.rows }} rows · {{ h.status }} <button type="button" class="view" @click="view(h.id)">Details</button></li></ul>
    <aside v-if="s.detail" class="detail">{{ s.detail.file }}: {{ s.detail.received }}/{{ s.detail.rows }} rows, {{ s.detail.errors }} errors, committed {{ s.detail.commits }}×, {{ s.detail.status }}</aside>
  </div>`,
});

createApp(App).mount("#app");
void loadActive().then(loadHistory);
if (POLL === "interval") setInterval(() => void poll(), 2000);
else {
  const loop = async () => {
    await poll();
    setTimeout(loop, 2000);
  };
  setTimeout(loop, 2000);
}
