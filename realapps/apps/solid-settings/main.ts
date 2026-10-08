// Account settings (SolidJS with solid-js/html tagged templates, fetch; state in runtime atoms mirrored into Solid
// signals). Every preference change auto-saves the WHOLE settings object with PUT /api/docs/settings and applies
// the server's echo. The public profile is a versioned PATCH (If-Match) with 409 handling. Latent bugs by flag:
// every echo applied, so an older save's echo reverts a newer toggle (saveMode=blind; saveMode=serialize is a
// correct alternative that keeps one save in flight), profile conflicts overwritten blindly (conflict=overwrite)
// or left unrecoverable until a reload (conflict=stuck), Save profile not locked while saving (profileLock=false:
// a double click sends the same version twice and the second one conflicts).
import html from "solid-js/html";
import { render } from "solid-js/web";
import { For, Show, createSignal } from "solid-js";
import { rt, flag } from "../_shared/genclass";
import { atomSignal } from "../_shared/solid-atom";

type Prefs = {
  theme: string;
  density: string;
  language: string;
  digest: string;
  notifyComments: boolean;
  notifyMentions: boolean;
  notifyFollows: boolean;
  productNews: boolean;
  publicProfile: boolean;
  showActivity: boolean;
};
type ProfileFields = { displayName: string; bio: string; location: string };
type Profile = ProfileFields & { id: string; version: number };

const SAVE = flag("saveMode", "sequence") as "sequence" | "blind" | "serialize";
const CONFLICT = flag("conflict", "merge") as "merge" | "overwrite" | "stuck";
const PROFILE_LOCK = Boolean(flag("profileLock", true));

const DEFAULTS: Prefs = { theme: "system", density: "comfortable", language: "en", digest: "weekly", notifyComments: true, notifyMentions: true, notifyFollows: false, productNews: false, publicProfile: true, showActivity: true };
const KEYS = Object.keys(DEFAULTS) as (keyof Prefs)[];
const FIELDS: (keyof ProfileFields)[] = ["displayName", "bio", "location"];
const SELECTS: { key: keyof Prefs; label: string; options: [string, string][] }[] = [
  { key: "theme", label: "Theme", options: [["system", "Match system"], ["light", "Light"], ["dark", "Dark"]] },
  { key: "density", label: "Density", options: [["comfortable", "Comfortable"], ["compact", "Compact"]] },
  { key: "language", label: "Language", options: [["en", "English"], ["fr", "Français"], ["de", "Deutsch"], ["es", "Español"]] },
  { key: "digest", label: "Email digest", options: [["off", "Off"], ["daily", "Daily"], ["weekly", "Weekly"]] },
];
const TOGGLES: [keyof Prefs, string][] = [
  ["notifyComments", "Comments on my posts"],
  ["notifyMentions", "Mentions"],
  ["notifyFollows", "New followers"],
  ["productNews", "Product news"],
  ["publicProfile", "Public profile"],
  ["showActivity", "Show my activity status"],
];

const prefs = rt.atom<Prefs>("prefs", DEFAULTS);
const prefsStatus = rt.atom("prefsStatus", { loaded: false, error: "" });
const profile = rt.atom("profile", { displayName: "", bio: "", location: "", version: 0, dirty: false, notice: "", error: "" });
const [saving, setSaving] = createSignal(0);
const [profileSaving, setProfileSaving] = createSignal(false);

const pick = (doc: Partial<Prefs>, fallback: Prefs): Prefs => {
  const out = { ...fallback };
  for (const k of KEYS) if (doc[k] !== undefined && doc[k] !== null) (out as Record<string, unknown>)[k] = doc[k];
  return out;
};
const json = { "content-type": "application/json" };

// ---------------------------------------------------------------------------------------------- settings
async function loadPrefs(attempt = 0) {
  try {
    const r = await fetch("/api/docs/settings");
    if (!r.ok) throw new Error(String(r.status));
    const doc = (await r.json()) as Partial<Prefs>;
    prefs.set(pick(doc, DEFAULTS));
    prefsStatus.set({ loaded: true, error: "" });
  } catch {
    prefsStatus.update((s) => ({ ...s, error: "Couldn't load your settings. Retrying…" }));
    if (attempt < 3) setTimeout(() => void loadPrefs(attempt + 1), 2000);
  }
}

let saveSeq = 0;
let inflight = false;
let again = false;

async function savePrefs() {
  if (SAVE === "serialize" && inflight) {
    again = true;
    return;
  }
  const mine = ++saveSeq;
  inflight = true;
  setSaving((n) => n + 1);
  try {
    const r = await fetch("/api/docs/settings", { method: "PUT", headers: json, body: JSON.stringify(pick({}, prefs.get())) });
    if (!r.ok) throw new Error(String(r.status));
    const doc = (await r.json()) as Partial<Prefs>;
    const apply = SAVE === "blind" || (SAVE === "sequence" && mine === saveSeq) || (SAVE === "serialize" && !again);
    if (apply) prefs.update((cur) => pick(doc, cur));
  } catch {
    if (SAVE === "blind" || mine === saveSeq) prefsStatus.update((s) => ({ ...s, error: "Couldn't save your settings. Your changes are kept on this device." }));
  } finally {
    setSaving((n) => n - 1);
    inflight = false;
    if (SAVE === "serialize" && again) {
      again = false;
      void savePrefs();
    }
  }
}

function change<K extends keyof Prefs>(k: K, v: Prefs[K]) {
  prefs.update((p) => ({ ...p, [k]: v }));
  if (prefsStatus.get().error) prefsStatus.update((s) => ({ ...s, error: "" }));
  void savePrefs();
}

// ----------------------------------------------------------------------------------------------- profile
let base: ProfileFields = { displayName: "", bio: "", location: "" };
const fieldsOf = (p: Partial<ProfileFields>): ProfileFields => ({ displayName: String(p.displayName ?? ""), bio: String(p.bio ?? ""), location: String(p.location ?? "") });

async function loadProfile() {
  try {
    const r = await fetch("/api/profiles/me");
    if (!r.ok) throw new Error(String(r.status));
    const p = (await r.json()) as Profile;
    base = fieldsOf(p);
    profile.set({ ...base, version: p.version, dirty: false, notice: "", error: "" });
  } catch {
    profile.update((p) => ({ ...p, error: "Couldn't load your profile." }));
  }
}

function editProfile(k: keyof ProfileFields, v: string) {
  profile.update((p) => ({ ...p, [k]: v, dirty: true, notice: "", error: "" }));
}

async function saveProfile() {
  if (PROFILE_LOCK && profileSaving()) return;
  const p0 = profile.get();
  const sent = fieldsOf(p0);
  let version = p0.version;
  setProfileSaving(true);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch("/api/profiles/me", { method: "PATCH", headers: { ...json, "If-Match": String(version) }, body: JSON.stringify({ ...sent, version }) });
      if (r.status === 409) {
        const cur = ((await r.json()) as { current?: Profile }).current;
        if (!cur) throw new Error("409");
        if (CONFLICT === "overwrite" && attempt === 0) {
          version = cur.version; // last writer wins
          continue;
        }
        if (CONFLICT === "merge") {
          const theirs = fieldsOf(cur);
          profile.update((p) => {
            const merged = { ...p };
            for (const k of FIELDS) if (sent[k] === base[k]) merged[k] = theirs[k]; // keep only what this user changed
            return { ...merged, version: cur.version, dirty: true, notice: "", error: "Your profile was updated on another device. We merged the latest version; review and save again." };
          });
          base = theirs;
        } else profile.update((p) => ({ ...p, error: "Your profile was changed somewhere else. Reload the page to continue." }));
        return;
      }
      if (!r.ok) throw new Error(String(r.status));
      const saved = (await r.json()) as Profile;
      base = fieldsOf(saved);
      profile.update((p) => {
        const unchanged = FIELDS.every((k) => p[k] === sent[k]);
        return unchanged ? { ...p, ...fieldsOf(saved), version: saved.version, dirty: false, notice: "Profile saved.", error: "" } : { ...p, version: saved.version, notice: "", error: "" };
      });
      return;
    }
  } catch {
    profile.update((p) => ({ ...p, error: "Couldn't save your profile. Try again." }));
  } finally {
    setProfileSaving(false);
  }
}

// ------------------------------------------------------------------------------------------------------ UI
function Preferences() {
  const p = atomSignal(prefs);
  const st = atomSignal(prefsStatus);
  return html`<section class="prefs">
    <h2>Preferences</h2>
    <p class="save-state">${() => (saving() > 0 ? "Saving…" : st().loaded ? "All changes saved" : "Loading…")}</p>
    <${For} each=${SELECTS}>${(s: (typeof SELECTS)[number]) => html`<label class="field">${s.label} <select name=${s.key} aria-label=${s.label} disabled=${() => !st().loaded} onChange=${(e: Event) => change(s.key, (e.currentTarget as HTMLSelectElement).value)}>${s.options.map(([v, l]) => html`<option value=${v} selected=${() => p()[s.key] === v}>${l}</option>`)}</select></label>`}<//>
    <fieldset>
      <legend>Notifications and privacy</legend>
      <${For} each=${TOGGLES}>${([k, label]: [keyof Prefs, string]) => html`<label class="toggle"><input type="checkbox" class="pref-toggle" name=${k} disabled=${() => !st().loaded} checked=${() => Boolean(p()[k])} onChange=${(e: Event) => change(k, (e.currentTarget as HTMLInputElement).checked)} /> ${label}</label>`}<//>
    </fieldset>
    <${Show} when=${() => st().error}><p role="alert">${() => st().error}</p><//>
  </section>`;
}

function ProfileForm() {
  const pr = atomSignal(profile);
  const onSubmit = (e: Event) => {
    e.preventDefault();
    void saveProfile();
  };
  return html`<section class="profile">
    <h2>Public profile</h2>
    <form onSubmit=${onSubmit}>
      <label>Display name <input name="displayName" value=${() => pr().displayName} onInput=${(e: Event) => editProfile("displayName", (e.currentTarget as HTMLInputElement).value)} /></label>
      <label>Bio <textarea name="bio" value=${() => pr().bio} onInput=${(e: Event) => editProfile("bio", (e.currentTarget as HTMLTextAreaElement).value)}></textarea></label>
      <label>Location <input name="location" value=${() => pr().location} onInput=${(e: Event) => editProfile("location", (e.currentTarget as HTMLInputElement).value)} /></label>
      <p class="profile-state">${() => (profileSaving() ? "Saving profile…" : pr().dirty ? "Unsaved changes" : "")}</p>
      <button type="submit" class="save-profile" disabled=${() => PROFILE_LOCK && profileSaving()}>Save profile</button>
      <button type="button" class="discard-profile" onClick=${() => void loadProfile()}>Discard changes</button>
    </form>
    <${Show} when=${() => pr().notice}><p role="status">${() => pr().notice}</p><//>
    <${Show} when=${() => pr().error}><p role="alert">${() => pr().error}</p><//>
  </section>`;
}

function App() {
  return html`<div class="settings"><h1>Account settings</h1><${Preferences} /><${ProfileForm} /></div>`;
}

render(() => html`<${App} />`, document.getElementById("app")!);
void loadPrefs();
void loadProfile();
