// Team onboarding wizard (Vue 3 templates + fetch; form state in runtime atoms bridged to Vue). An admin adds
// teammates in three steps: account (username checked for availability while typing, email checked on blur),
// profile, review + create (POST /users). Before creating, the username is re-validated with the server and
// server errors are shown in [role=alert]. Latent bugs by flag: availability answers applied in arrival order, so
// "available"/"taken" can belong to an older prefix (check=none; check=debounce narrows the window but keeps it;
// check=reqid and check=debounce-abort are guarded), Create button not locked while submitting (submitLock=false),
// no Idempotency-Key on the create request (idemKey=false: a double submit or a retried request makes two accounts).
import { createApp, defineComponent, computed, ref } from "vue";
import { rt, flag } from "../_shared/genclass";
import { useAtom } from "../_shared/vue-atom";

type User = { id: number; username: string; email: string; displayName: string; role: string };
type Status = "" | "short" | "invalid" | "checking" | "available" | "taken" | "unknown";

const CHECK = flag("check", "debounce-abort") as "debounce-abort" | "none" | "reqid" | "debounce";
const SUBMIT_LOCK = Boolean(flag("submitLock", true));
const IDEM = Boolean(flag("idemKey", true));
const DEBOUNCE_MS = 300;
const USERNAME_RE = /^[a-z0-9._-]+$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;

const blank = () => ({ step: 1, username: "", email: "", displayName: "", role: "member", usernameStatus: "" as Status, emailStatus: "" as "" | "checking" | "ok" | "in-use" | "invalid", hint: "", error: "", notice: "" });
const form = rt.atom("signup", blank());
const team = rt.atom("team", { members: [] as User[], loading: true });
const submitting = ref(false);
const password = ref("");
let idemKey = "";

const norm = (v: string) => v.trim().toLowerCase();
class HttpError extends Error {}
const json = { "content-type": "application/json" };

async function lookup(field: "username" | "email", value: string, signal?: AbortSignal): Promise<boolean> {
  const r = await fetch(`/api/users?${field}=${encodeURIComponent(value)}&limit=1`, signal ? { signal } : {});
  if (!r.ok) throw new HttpError(`Couldn't verify the username (HTTP ${r.status})`);
  const data = (await r.json()) as { items?: User[]; total?: number };
  return Number(data.total ?? data.items?.length ?? 0) > 0;
}

// --------------------------------------------------------------------------------- username availability
let checkSeq = 0;
let checkCtl: AbortController | null = null;
let checkTimer: ReturnType<typeof setTimeout> | null = null;

function onUsername(v: string) {
  const name = norm(v);
  const status: Status = !name ? "" : name.length < 3 ? "short" : USERNAME_RE.test(name) ? "checking" : "invalid";
  form.update((f) => ({ ...f, username: v, usernameStatus: status, hint: "", step: 1 }));
  if (checkTimer) clearTimeout(checkTimer);
  if (status !== "checking") {
    if (CHECK === "debounce-abort") checkCtl?.abort();
    return;
  }
  if (CHECK === "debounce" || CHECK === "debounce-abort") checkTimer = setTimeout(() => void checkUsername(name), DEBOUNCE_MS);
  else void checkUsername(name);
}

async function checkUsername(name: string) {
  const id = ++checkSeq;
  if (CHECK === "debounce-abort") {
    checkCtl?.abort();
    checkCtl = new AbortController();
  }
  try {
    const taken = await lookup("username", name, CHECK === "debounce-abort" ? checkCtl!.signal : undefined);
    if (CHECK === "reqid" && id !== checkSeq) return;
    if (CHECK === "debounce-abort" && norm(form.get().username) !== name) return;
    form.update((f) => ({ ...f, usernameStatus: taken ? "taken" : "available" }));
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    if (CHECK === "reqid" && id !== checkSeq) return;
    form.update((f) => ({ ...f, usernameStatus: "unknown" }));
  }
}

// ------------------------------------------------------------------------------------------------- email
async function onEmailBlur() {
  const email = norm(form.get().email);
  if (!email) return;
  if (!EMAIL_RE.test(email)) return void form.update((f) => ({ ...f, emailStatus: "invalid" }));
  form.update((f) => ({ ...f, emailStatus: "checking" }));
  try {
    const used = await lookup("email", email);
    if (norm(form.get().email) !== email) return;
    form.update((f) => ({ ...f, emailStatus: used ? "in-use" : "ok" }));
  } catch {
    if (norm(form.get().email) === email) form.update((f) => ({ ...f, emailStatus: "" }));
  }
}

// ------------------------------------------------------------------------------------------- navigation
function next1() {
  const f = form.get();
  let hint = "";
  if (f.usernameStatus === "checking") hint = "Still checking that username…";
  else if (f.usernameStatus !== "available") hint = "Choose an available username.";
  else if (!EMAIL_RE.test(f.email.trim()) || f.emailStatus === "in-use") hint = "Enter an email address that isn't already on the team.";
  else if (password.value.length < 8) hint = "Passwords need at least 8 characters.";
  if (hint) return void form.update((x) => ({ ...x, hint }));
  form.update((x) => ({ ...x, step: 2, hint: "", notice: "", displayName: x.displayName || x.username.trim() }));
}

function next2() {
  const f = form.get();
  if (!f.displayName.trim()) return void form.update((x) => ({ ...x, hint: "Add a display name." }));
  idemKey = IDEM ? crypto.randomUUID() : "";
  form.update((x) => ({ ...x, step: 3, hint: "", error: "" }));
}

function back() {
  form.update((x) => ({ ...x, step: Math.max(1, x.step - 1), hint: "", error: "" }));
}

function another() {
  password.value = "";
  form.set({ ...blank(), notice: "" });
}

async function submit() {
  if (SUBMIT_LOCK && submitting.value) return;
  const f = form.get();
  if (f.step !== 3 || !f.username.trim()) return;
  const body = { username: norm(f.username), email: norm(f.email), displayName: f.displayName.trim(), role: f.role, password: password.value };
  submitting.value = true;
  form.update((x) => ({ ...x, error: "" }));
  try {
    // server-side re-validation: someone may have taken the name since it was checked
    if (await lookup("username", body.username)) {
      form.update((x) => ({ ...x, step: 1, usernameStatus: "taken", error: `@${body.username} was just taken by someone else. Pick another username.` }));
      return;
    }
    const r = await fetch("/api/users", { method: "POST", headers: { ...json, ...(IDEM && idemKey ? { "Idempotency-Key": idemKey } : {}) }, body: JSON.stringify(body) });
    const data = (await r.json().catch(() => ({}))) as User & { error?: string };
    if (!r.ok) throw new HttpError(`${data.error ?? "The account could not be created"} (HTTP ${r.status})`);
    team.update((t) => ({ ...t, members: t.members.some((m) => m.id === data.id) ? t.members : [...t.members, data] }));
    password.value = "";
    form.set({ ...blank(), notice: `Added @${data.username} to the team.` });
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : "Network error: the account may not have been created.";
    form.update((x) => ({ ...x, error: msg }));
  } finally {
    submitting.value = false;
  }
}

async function loadTeam(attempt = 0) {
  try {
    const r = await fetch("/api/users?limit=50");
    if (!r.ok) throw new Error(String(r.status));
    const data = (await r.json()) as { items: User[] };
    team.update((t) => ({ members: [...(data.items ?? []), ...t.members.filter((m) => !(data.items ?? []).some((x) => x.id === m.id))], loading: false }));
  } catch {
    if (attempt < 3) setTimeout(() => void loadTeam(attempt + 1), 3000);
    else team.update((t) => ({ ...t, loading: false }));
  }
}

// ------------------------------------------------------------------------------------------------------ UI
const STATUS_TEXT: Record<string, string> = { short: "At least 3 characters", invalid: "Use lowercase letters, numbers, dots, dashes", checking: "Checking…", available: "Available", taken: "Already taken", unknown: "Couldn't check right now" };
const EMAIL_TEXT: Record<string, string> = { checking: "Checking…", ok: "", "in-use": "Already on the team", invalid: "Not a valid email address" };

const App = defineComponent({
  setup() {
    const f = useAtom(form);
    const t = useAtom(team);
    const statusText = computed(() => STATUS_TEXT[f.value.usernameStatus] ?? "");
    const emailText = computed(() => EMAIL_TEXT[f.value.emailStatus] ?? "");
    const set = (k: "email" | "displayName" | "role", v: string) => form.update((x) => ({ ...x, [k]: v, ...(k === "email" ? { emailStatus: "" as const, step: 1 } : {}), hint: "" }));
    const setPassword = (v: string) => {
      password.value = v;
      if (form.get().step > 1) form.update((x) => ({ ...x, step: 1 }));
    };
    return { f, t, statusText, emailText, password, submitting, onUsername, onEmailBlur, set, setPassword, next1, next2, back, another, submit, LOCK: SUBMIT_LOCK };
  },
  template: `
    <div class="onboarding">
      <aside class="team">
        <h2>Team ({{ t.members.length }})</h2>
        <p v-if="t.loading">Loading team…</p>
        <ul><li v-for="m in t.members" :key="m.id">@{{ m.username }} · {{ m.role }}</li></ul>
      </aside>
      <main>
        <h1>Add a teammate</h1>
        <p class="steps">Step {{ f.step }} of 3</p>
        <p v-if="f.notice" class="notice" role="status">{{ f.notice }}</p>
        <form class="account" @submit.prevent="next1">
          <h2>1. Account</h2>
          <p><label>Username <input name="username" autocomplete="off" :value="f.username" @input="onUsername($event.target.value)" /></label> <span class="status">{{ statusText }}</span></p>
          <p><label>Email <input name="email" type="email" :value="f.email" @input="set('email', $event.target.value)" @change="onEmailBlur" /></label> <span class="status">{{ emailText }}</span></p>
          <p><label>Temporary password <input name="password" type="password" autocomplete="new-password" :value="password" @input="setPassword($event.target.value)" /></label></p>
          <button v-if="f.step === 1" class="next1" type="submit">Continue</button>
        </form>
        <form v-if="f.step >= 2" class="profile" @submit.prevent="next2">
          <h2>2. Profile</h2>
          <p><label>Display name <input name="displayName" :value="f.displayName" @input="set('displayName', $event.target.value)" /></label></p>
          <p><label>Role
            <select name="role" :value="f.role" @change="set('role', $event.target.value)">
              <option value="member">Member</option><option value="admin">Admin</option><option value="viewer">Viewer</option>
            </select>
          </label></p>
          <p v-if="f.step === 2"><button class="back" type="button" @click="back">Back</button> <button class="next2" type="submit">Review</button></p>
        </form>
        <section v-if="f.step === 3" class="review">
          <h2>3. Review</h2>
          <p>@{{ f.username.trim().toLowerCase() }} · {{ f.email.trim().toLowerCase() }} · {{ f.displayName }} · {{ f.role }}</p>
          <button class="back" type="button" @click="back">Back</button> <button class="submit" :disabled="LOCK && submitting" @click="submit">{{ submitting ? "Creating…" : "Create account" }}</button>
        </section>
        <p v-if="f.hint" class="hint">{{ f.hint }}</p>
        <p v-if="f.error" role="alert">{{ f.error }}</p>
        <button v-if="f.notice" class="another" type="button" @click="another">Add another teammate</button>
      </main>
    </div>`,
});

createApp(App).mount("#app");
void loadTeam();
