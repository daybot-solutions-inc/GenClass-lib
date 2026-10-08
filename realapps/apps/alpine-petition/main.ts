// Petition page (Alpine.js 3; the Alpine store mirrors a runtime atom; fetch + WebSocket). The signature count is a
// live counter; the form stays open so family members can sign too; signing is two calls (POST /signers — one per email — then POST /counters/signatures/incr) and the
// newest signers stream into a "recently signed" list. Visitors can share the petition (a share counter). Latent bugs
// by flag: the count bumped by one per push instead of taking the server's value (count=local-add: your own signature
// counts twice), a Sign button that stays live while posting (signGuard=none: the second POST says you already
// signed), sign POSTs retried without an Idempotency-Key (signRetry=blind: a signature stored before a 5xx answers 409
// on the retry and the counter is never bumped) or not retried (signRetry=none), the live echo of your own signature
// appended next to the POST answer (recent=append) and reconnects that don't reload the count (reconnect=naive).
import Alpine from "alpinejs";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError, liveTopic } from "../_shared/w3-http";

type Signer = { id: number; name: string; city: string; email: string; comment: string; createdAt?: string };
const COUNT = flag("count", "server-value");
const SIGN_GUARD = flag("signGuard", "pending") === "pending";
const SIGN_RETRY = flag("signRetry", "idempotency-key") as "idempotency-key" | "blind" | "none";
const RECENT = flag("recent", "dedupe");
const RECONNECT = flag("reconnect", "resync");
const GOAL = 1500;

const petition = rt.atom("petition", { count: 0, recent: [] as Signer[], form: { name: "", email: "", city: "Riverside" }, signing: false, signed: false, shares: 0, live: false, error: "", notice: "" });
type P = ReturnType<typeof petition.get>;
Alpine.store("petition", { ...petition.get() });
petition.subscribe((v) => Object.assign(Alpine.store("petition") as object, v));
const byNewest = (rs: Signer[]) => [...rs].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")) || b.id - a.id).slice(0, 6);
const addRecent = (p: P, s: Signer, fromPush: boolean): P => ({ ...p, recent: byNewest(p.recent.some((r) => r.id === s.id) && !(fromPush && RECENT === "append") ? p.recent : [s, ...p.recent]) });

function setField(field: "name" | "email" | "city", value: string) {
  petition.update((p) => ({ ...p, form: { ...p.form, [field]: value } }));
}

let signN = 0;
async function sign() {
  const p0 = petition.get();
  const { name, email, city } = p0.form;
  if (!name.trim() || !email.includes("@")) return void petition.update((p) => ({ ...p, error: "Please enter your name and email." }));
  if (SIGN_GUARD && p0.signing) return;
  petition.update((p) => ({ ...p, signing: true, error: "", notice: "" }));
  const key = SIGN_RETRY === "idempotency-key" ? `sign-${email}-${++signN}` : "";
  const post = () => api<Signer>(`/api/signers`, "POST", { name: name.trim(), email: email.trim(), city, comment: "" }, key ? { "Idempotency-Key": key } : {});
  try {
    let s: Signer;
    try {
      s = await post();
    } catch (e) {
      if (SIGN_RETRY === "none" || (e instanceof HttpError && e.status > 0 && e.status < 500)) throw e;
      s = await post();
    }
    petition.update((p) => ({ ...addRecent(p, s, false), signed: true, notice: `Thank you, ${s.name}! Your signature counts.` }));
    const c = await api<{ value: number }>(`/api/counters/signatures/incr`, "POST", { by: 1 });
    petition.update((p) => ({ ...p, count: COUNT === "server-value" ? Math.max(p.count, c.value) : p.count + 1 }));
  } catch (e) {
    petition.update((p) => ({ ...p, error: e instanceof HttpError && e.status === 409 ? `${email} has already signed this petition.` : errText(e, "your signature") }));
  } finally {
    petition.update((p) => ({ ...p, signing: false }));
  }
}

function another() {
  petition.update((p) => ({ ...p, signed: false, form: { name: "", email: "", city: "Riverside" }, notice: "", error: "" }));
}

async function share() {
  try {
    const c = await api<{ value: number }>(`/api/counters/shares/incr`, "POST", { by: 1 });
    petition.update((p) => ({ ...p, shares: c.value, notice: "Link copied — thanks for sharing!" }));
  } catch (e) {
    petition.update((p) => ({ ...p, error: errText(e, "sharing") }));
  }
}

async function loadCount() {
  try {
    const [c, sh] = await Promise.all([api<{ value: number }>(`/api/counters/signatures`), api<{ value: number }>(`/api/counters/shares`)]);
    petition.update((p) => ({ ...p, count: c.value, shares: sh.value }));
  } catch (e) {
    petition.update((p) => ({ ...p, error: p.count ? p.error : errText(e, "loading the signature count") }));
  }
}
async function loadRecent() {
  try {
    const rs = itemsOf<Signer>(await api(`/api/signers?sort=-createdAt&limit=6`));
    petition.update((p) => ({ ...p, recent: byNewest([...rs, ...p.recent.filter((r) => !rs.some((x) => x.id === r.id))]) }));
  } catch {
    /* the list fills from live updates */
  }
}

document.getElementById("app")!.innerHTML = `<div x-data>
  <h1>Save the Riverside Library</h1>
  <p class="count"><strong x-text="$store.petition.count.toLocaleString('en-US')"></strong> of ${GOAL.toLocaleString("en-US")} signatures · <span x-text="$store.petition.live ? 'live' : 'reconnecting…'"></span></p>
  <progress max="${GOAL}" :value="$store.petition.count"></progress>
  <p role="alert" x-show="$store.petition.error" x-text="$store.petition.error"></p>
  <p class="notice" x-show="!$store.petition.error && $store.petition.notice" x-text="$store.petition.notice"></p>
  <p class="thanks" x-show="$store.petition.signed">You've signed — thank you! Know someone who cares? They can sign below too.</p>
  <form class="sign" @submit.prevent="sign()">
    <input name="name" placeholder="Your name" :value="$store.petition.form.name" @input="setField('name', $event.target.value)">
    <input name="email" placeholder="Email" :value="$store.petition.form.email" @input="setField('email', $event.target.value)">
    <select name="city" @change="setField('city', $event.target.value)"><option>Riverside</option><option>Northend</option><option>Old Mill</option><option>Eastgate</option></select>
    <button type="submit" class="sign" :disabled="guard && $store.petition.signing" x-text="$store.petition.signing ? 'Signing…' : 'Sign the petition'"></button>
    <button type="button" class="clear" @click="another()">Clear</button></form>
  <p class="share"><button type="button" class="share" @click="share()">Share</button> <span x-text="$store.petition.shares + ' shares'"></span></p>
  <h2>Recently signed</h2>
  <ul class="recent"><template x-for="(r, i) in $store.petition.recent" :key="r.id + '-' + i"><li class="signer" x-text="r.name + ' · ' + r.city + (r.comment ? ' — “' + r.comment + '”' : '')"></li></template></ul>
</div>`;
Object.assign(window as any, { sign, another, share, setField, guard: SIGN_GUARD });
Alpine.start();

let everUp = false;
liveTopic(
  "counters/signatures",
  (m) => {
    if (typeof m.value !== "number") return;
    petition.update((p) => ({ ...p, count: COUNT === "server-value" ? m.value : p.count + 1 }));
  },
  (up) => {
    petition.update((p) => ({ ...p, live: up }));
    if (up && everUp && RECONNECT === "resync") void loadCount();
    if (up) everUp = true;
  },
);
liveTopic("signers", (m) => {
  if (m.type === "created" && m.item) petition.update((p) => addRecent(p, m.item as Signer, true));
});
void loadCount();
void loadRecent();
