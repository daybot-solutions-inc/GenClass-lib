// Chat moderation queue (Solid 1.9 + solid-js/html; a runtime atom mirrored into a signal; fetch + WebSocket).
// Reports stream in over the live topic; a moderator approves or removes a message (versioned PATCH, so two
// moderators can't both act on one report) or bans the author (ban + remove their open reports). Latent bugs by flag:
// live "created" events appended without checking the list (live=append: a report that arrives during the initial
// load shows twice), action buttons live while posting (actionGuard=none), reconnect without reloading
// (reconnect=naive), actions sent without the version (claim=none: overrides another moderator) and an open-count
// adjusted by hand (queueCount=manual).
import html from "solid-js/html";
import { render } from "solid-js/web";
import { For, Show } from "solid-js";
import { rt, flag } from "../_shared/genclass";
import { atomSignal } from "../_shared/solid-atom";
import { api, itemsOf, errText, HttpError, liveTopic } from "../_shared/w3-http";

type Report = { id: number; author: string; text: string; reason: string; status: string; channel: string; version: number };
type User = { id: number; name: string; banned: boolean };
const LIVE = flag("live", "dedupe");
const ACTION_GUARD = flag("actionGuard", "pending") === "pending";
const RECONNECT = flag("reconnect", "resync");
const CLAIM = flag("claim", "if-match");
const QUEUE_COUNT = flag("queueCount", "derive");

const mod = rt.atom("mod", { reports: [] as Report[], openCount: 0, reason: "all", pending: [] as number[], banned: [] as string[], live: false, error: "", notice: "" });
type M = ReturnType<typeof mod.get>;
const openOf = (rs: Report[]) => rs.filter((r) => r.status === "open").length;
function upsert(m: M, r: Report, created = false): M {
  const cur = m.reports.find((x) => x.id === r.id);
  if (cur && Number(r.version) < Number(cur.version)) return m;
  const reports = cur && !(created && LIVE === "append") ? m.reports.map((x) => (x.id === r.id ? r : x)) : [...m.reports, r];
  const delta = (r.status === "open" ? 1 : 0) - (cur?.status === "open" ? 1 : 0);
  return { ...m, reports, openCount: QUEUE_COUNT === "derive" ? openOf(reports) : m.openCount + delta };
}
const pend = (id: number, on: boolean) => mod.update((m) => ({ ...m, pending: on ? [...m.pending, id] : m.pending.filter((x) => x !== id) }));

async function load() {
  try {
    const reports = itemsOf<Report>(await api(`/api/reports?status=open&limit=40`));
    mod.update((m) => {
      const extra = m.reports.filter((r) => r.status === "open" && !reports.some((x) => x.id === r.id));
      const merged = [...reports, ...extra];
      return { ...m, reports: merged, openCount: openOf(merged) };
    });
  } catch (e) {
    mod.update((m) => ({ ...m, error: errText(e, "loading the queue") }));
  }
}

async function decide(r: Report, status: "approved" | "removed") {
  if (ACTION_GUARD && mod.get().pending.includes(r.id)) return;
  pend(r.id, true);
  mod.update((m) => ({ ...m, error: "", notice: "" }));
  try {
    const saved = await api<Report>(`/api/reports/${r.id}`, "PATCH", CLAIM === "if-match" ? { status, version: r.version } : { status });
    mod.update((m) => ({ ...upsert(m, saved), notice: `${status === "removed" ? "Removed" : "Approved"} ${saved.author}'s message.` }));
  } catch (e) {
    const cur = e instanceof HttpError && e.status === 409 ? (e.body?.current as Report | undefined) : undefined;
    mod.update((m) => ({ ...(cur ? upsert(m, cur) : m), error: cur ? `Another moderator already ${cur.status} this report.` : errText(e, "the moderation action") }));
  } finally {
    pend(r.id, false);
  }
}

async function ban(r: Report) {
  if (ACTION_GUARD && mod.get().pending.includes(r.id)) return;
  pend(r.id, true);
  try {
    const [u] = itemsOf<User>(await api(`/api/users?name=${encodeURIComponent(r.author)}`));
    if (!u) throw new HttpError(404);
    await api<User>(`/api/users/${u.id}/ban`, "POST");
    const theirs = mod.get().reports.filter((x) => x.author === r.author && x.status === "open").map((x) => x.id);
    const res = await api<{ results: { id: number; ok: boolean }[] }>(`/api/reports/bulk`, "POST", { ids: theirs, op: "patch", patch: { status: "removed" } });
    const ok = new Set(res.results.filter((x) => x.ok).map((x) => Number(x.id)));
    mod.update((m) => {
      let next = { ...m, banned: [...m.banned, r.author] };
      for (const x of m.reports) if (ok.has(x.id)) next = upsert(next, { ...x, status: "removed", version: x.version + 1 });
      return { ...next, notice: `${r.author} is banned; ${ok.size} message(s) removed.`, error: ok.size < theirs.length ? `${theirs.length - ok.size} message(s) could not be removed.` : "" };
    });
  } catch (e) {
    mod.update((m) => ({ ...m, error: errText(e, `banning ${r.author}`) }));
  } finally {
    pend(r.id, false);
  }
}

function App() {
  const m = atomSignal(mod);
  const shown = () => m().reports.filter((r) => r.status === "open" && (m().reason === "all" || r.reason === m().reason));
  return html`<div class="moderation">
    <h1>Moderation queue</h1>
    <p class="count">${() => `${m().openCount} open report(s) · ${m().live ? "live" : "reconnecting…"}`}</p>
    <label>Reason <select name="reason" onChange=${(e: Event) => mod.update((x) => ({ ...x, reason: (e.currentTarget as HTMLSelectElement).value }))}>${["all", "spam", "harassment", "hate", "spoiler"].map((r) => html`<option value=${r}>${r}</option>`)}</select></label>
    <${Show} when=${() => m().error}><p role="alert">${() => m().error}</p><//>
    <${Show} when=${() => !m().error && m().notice}><p class="notice">${() => m().notice}</p><//>
    <ul class="queue"><${For} each=${shown}>${(r: Report) => html`<li class="report"><strong>${r.author}</strong> in ${r.channel}: “${r.text}” <em>${r.reason}</em>
      <button type="button" class="approve" disabled=${() => ACTION_GUARD && m().pending.includes(r.id)} onClick=${() => void decide(r, "approved")}>Approve</button>
      <button type="button" class="remove" disabled=${() => ACTION_GUARD && m().pending.includes(r.id)} onClick=${() => void decide(r, "removed")}>Remove</button>
      <${Show} when=${() => !m().banned.includes(r.author)}><button type="button" class="ban" disabled=${() => m().pending.includes(r.id)} onClick=${() => void ban(r)}>Ban ${r.author}</button><//></li>`}<//></ul>
  </div>`;
}

render(() => html`<${App} />`, document.getElementById("app")!);
let everUp = false;
liveTopic(
  "reports",
  (msg) => {
    if (msg.item && msg.type !== "deleted") mod.update((m) => upsert(m, msg.item as Report, msg.type === "created"));
  },
  (up) => {
    mod.update((m) => ({ ...m, live: up }));
    if (up && everUp && RECONNECT === "resync") void load();
    if (up) everUp = true;
  },
);
void load();
