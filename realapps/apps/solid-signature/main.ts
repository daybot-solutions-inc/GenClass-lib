// E-signature envelopes (Solid 1.9 + solid-js/html; a runtime atom mirrored into a signal; fetch). A sender drafts an
// envelope, adds signers one by one (POST /signers), sends it (versioned PATCH with the signer count, then the signers
// are activated with a bulk PATCH) and watches signatures come in (the open envelope polls); pending signers can be
// reminded (POST /signers/:id/remind: relative). Latent bugs by flag: Send enabled while signers are still being
// added (send=race: the envelope goes out without them and they are never activated), an Add button live while the
// signer posts (addGuard=none: the same signer twice), remind buttons without a cooldown (remind=none: reminder spam),
// polling on setInterval (poll=interval: slow polls overlap) and a signed counter advanced from the state each poll
// started with (signedCount=incremental: overlapping polls count a signature twice).
import html from "solid-js/html";
import { render } from "solid-js/web";
import { For, Show } from "solid-js";
import { rt, flag } from "../_shared/genclass";
import { atomSignal } from "../_shared/solid-atom";
import { api, itemsOf, errText } from "../_shared/w3-http";

type Env = { id: number; title: string; status: string; signers: number; version: number };
type Signer = { id: number; envelopeId: number; name: string; email: string; status: string; reminders: number; live: boolean };
const SEND = flag("send", "after-signers");
const ADD_GUARD = flag("addGuard", "pending") === "pending";
const REMIND = flag("remind", "cooldown");
const POLL = flag("poll", "chain");
const SIGNED = flag("signedCount", "derive");

const esign = rt.atom("esign", { envelopes: [] as Env[], current: 0, signers: [] as Signer[], loading: true, signedCount: 0, draft: { name: "", email: "" }, adding: 0, sending: false, cooldown: [] as number[], error: "", notice: "" });
type E = ReturnType<typeof esign.get>;
const signedOf = (ss: Signer[]) => ss.filter((x) => x.status === "signed").length;
const env = (e: E) => e.envelopes.find((x) => x.id === e.current);
const putEnv = (e: E, v: Env): E => ({ ...e, envelopes: e.envelopes.map((x) => (x.id === v.id ? v : x)) });

async function loadEnvelopes() {
  try {
    const envelopes = itemsOf<Env>(await api(`/api/envelopes?limit=20`));
    esign.update((e) => ({ ...e, envelopes }));
    // start on the draft being prepared, if any
    const first = envelopes.find((v) => v.status === "draft") ?? envelopes[0];
    if (!esign.get().current && first) void open(first.id);
  } catch (err) {
    esign.update((e) => ({ ...e, loading: false, error: errText(err, "loading envelopes") }));
  }
}

let openSeq = 0;
async function open(id: number) {
  const my = ++openSeq;
  esign.update((e) => ({ ...e, current: id, loading: true, signers: [], error: "", notice: "" }));
  try {
    const signers = itemsOf<Signer>(await api(`/api/signers?envelopeId=${id}&limit=30`));
    if (my !== openSeq) return;
    esign.update((e) => ({ ...e, signers, signedCount: signedOf(signers), loading: false }));
  } catch (err) {
    if (my === openSeq) esign.update((e) => ({ ...e, loading: false, error: errText(err, "opening the envelope") }));
  }
}

let n = 0;
async function newEnvelope() {
  try {
    const created = await api<Env>(`/api/envelopes`, "POST", { title: `Untitled envelope ${++n}`, status: "draft", signers: 0 });
    esign.update((e) => ({ ...e, envelopes: [created, ...e.envelopes] }));
    void open(created.id);
  } catch (err) {
    esign.update((e) => ({ ...e, error: errText(err, "creating the envelope") }));
  }
}

async function addSigner(ev: Event) {
  ev.preventDefault();
  const e0 = esign.get();
  const { name, email } = e0.draft;
  if (!name.trim() || !email.includes("@") || (ADD_GUARD && e0.adding > 0)) return;
  const envelopeId = e0.current;
  esign.update((e) => ({ ...e, adding: e.adding + 1, error: "", notice: "" }));
  try {
    const s = await api<Signer>(`/api/signers`, "POST", { envelopeId, name: name.trim(), email: email.trim(), status: "pending", reminders: 0, live: false });
    esign.update((e) => (e.current !== envelopeId ? e : { ...e, signers: [...e.signers, s], draft: { name: "", email: "" }, notice: `${s.name} will sign.` }));
  } catch (err) {
    esign.update((e) => ({ ...e, error: errText(err, `adding ${name}`) }));
  } finally {
    esign.update((e) => ({ ...e, adding: e.adding - 1 }));
  }
}

async function send() {
  const e0 = esign.get();
  const v = env(e0);
  if (!v || v.status !== "draft" || !e0.signers.length || e0.sending || (SEND === "after-signers" && e0.adding > 0)) return;
  esign.update((e) => ({ ...e, sending: true, error: "", notice: "" }));
  try {
    const ids = e0.signers.map((s) => s.id);
    const sent = await api<Env>(`/api/envelopes/${v.id}`, "PATCH", { status: "sent", signers: ids.length, version: v.version });
    const r = await api<{ results: { id: number; ok: boolean }[] }>(`/api/signers/bulk`, "POST", { ids, op: "patch", patch: { live: true } });
    const ok = new Set(r.results.filter((x) => x.ok).map((x) => Number(x.id)));
    esign.update((e) => ({ ...putEnv(e, sent), signers: e.signers.map((s) => (ok.has(s.id) ? { ...s, live: true } : s)), notice: `“${sent.title}” sent to ${ids.length} signer(s).`, error: ok.size < ids.length ? `${ids.length - ok.size} signer(s) were not notified.` : "" }));
  } catch (err) {
    esign.update((e) => ({ ...e, error: errText(err, "sending the envelope") }));
  } finally {
    esign.update((e) => ({ ...e, sending: false }));
  }
}

async function remind(s: Signer) {
  if (esign.get().cooldown.includes(s.id)) return;
  if (REMIND === "cooldown") esign.update((e) => ({ ...e, cooldown: [...e.cooldown, s.id] }));
  try {
    const saved = await api<Signer>(`/api/signers/${s.id}/remind`, "POST");
    esign.update((e) => ({ ...e, signers: e.signers.map((x) => (x.id === saved.id ? saved : x)), notice: `Reminder sent to ${s.name}.` }));
  } catch (err) {
    esign.update((e) => ({ ...e, error: errText(err, `reminding ${s.name}`) }));
  } finally {
    if (REMIND === "cooldown") setTimeout(() => esign.update((e) => ({ ...e, cooldown: e.cooldown.filter((x) => x !== s.id) })), 10000);
  }
}

async function poll() {
  const e0 = esign.get();
  const v = env(e0);
  if (!v || v.status !== "sent" || e0.loading) return;
  const before = e0.signedCount;
  try {
    const signers = itemsOf<Signer>(await api(`/api/signers?envelopeId=${v.id}&limit=30`));
    esign.update((e) => {
      if (e.current !== v.id || e.loading) return e;
      const fresh = signedOf(signers);
      return { ...e, signers, signedCount: SIGNED === "derive" ? fresh : e.signedCount + Math.max(0, fresh - before) };
    });
    if (signers.length && signers.every((s) => s.status === "signed") && esign.get().current === v.id) {
      const done = await api<Env>(`/api/envelopes/${v.id}`, "PATCH", { status: "completed", version: v.version });
      esign.update((e) => ({ ...putEnv(e, done), notice: `“${done.title}” is fully signed.` }));
    }
  } catch {
    /* try again on the next tick */
  }
}

function App() {
  const e = atomSignal(esign);
  const cur = () => env(e());
  return html`<main class="esign">
    <aside><h2>Envelopes</h2><button type="button" class="new-envelope" onClick=${() => void newEnvelope()}>New envelope</button>
      <ul class="envelopes"><${For} each=${() => e().envelopes}>${(v: Env) => html`<li class="envelope">${v.title} · ${v.status} <button type="button" class="open" onClick=${() => void open(v.id)}>Open</button></li>`}<//></ul></aside>
    <section class="detail">
      <${Show} when=${cur}>${() => html`<h1>${cur()!.title}</h1><p class="progress">${cur()!.status} · ${e().signedCount} of ${e().signers.length} signed</p>`}<//>
      <${Show} when=${() => e().error}><p role="alert">${() => e().error}</p><//>
      <${Show} when=${() => !e().error && e().notice}><p class="notice">${() => e().notice}</p><//>
      <${Show} when=${() => e().loading}><p class="muted">Loading…</p><//>
      <ul class="signers"><${For} each=${() => e().signers}>${(s: Signer) => html`<li class="signer">${s.name} · ${s.email} · ${s.status}${s.reminders ? ` · reminded ${s.reminders}×` : ""}
        <${Show} when=${() => cur()?.status === "sent" && s.status === "pending"}><button type="button" class="remind" disabled=${() => e().cooldown.includes(s.id)} onClick=${() => void remind(s)}>Remind</button><//></li>`}<//></ul>
      <${Show} when=${() => cur()?.status === "draft"}>
        <form class="signer" onSubmit=${(ev: Event) => void addSigner(ev)}>
          <input name="name" placeholder="Signer name" value=${() => e().draft.name} onInput=${(ev: Event) => esign.update((x) => ({ ...x, draft: { ...x.draft, name: (ev.currentTarget as HTMLInputElement).value } }))} />
          <input name="email" placeholder="Email" value=${() => e().draft.email} onInput=${(ev: Event) => esign.update((x) => ({ ...x, draft: { ...x.draft, email: (ev.currentTarget as HTMLInputElement).value } }))} />
          <button type="submit" disabled=${() => ADD_GUARD && e().adding > 0}>${() => (e().adding ? "Adding…" : "Add signer")}</button>
        </form>
        <button type="button" class="send" disabled=${() => !e().signers.length || e().sending || (SEND === "after-signers" && e().adding > 0)} onClick=${() => void send()}>${() => (e().sending ? "Sending…" : "Send for signature")}</button>
      <//>
    </section></main>`;
}

render(() => html`<${App} />`, document.getElementById("app")!);
void loadEnvelopes();
if (POLL === "interval") setInterval(() => void poll(), 3000);
else {
  const loop = async () => {
    await poll();
    setTimeout(loop, 3000);
  };
  setTimeout(loop, 3000);
}
