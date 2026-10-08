// Newsroom story desk (Solid 1.9 with solid-js/html tagged templates; runtime atoms mirrored into signals). Editors
// open a story, retitle it (debounced autosave as a versioned PUT) and publish it; the night desk edits the same
// stories. Latent bugs by flag: autosaves fired in parallel with the same version (autosave=parallel: our own
// second save conflicts), conflicts resolved by re-sending over the other editor's copy (conflict=overwrite), story
// loads applied whatever story is open by then (openSeq=blind) and a publish button live while saving
// (publishGuard=none).
import html from "solid-js/html";
import { render } from "solid-js/web";
import { For, Show } from "solid-js";
import { rt, flag } from "../_shared/genclass";
import { atomSignal } from "../_shared/solid-atom";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Story = { id: number; headline: string; desk: string; status: string; words: number; standfirst: string; version: number };
const AUTOSAVE = flag("autosave", "serialized");
const CONFLICT = flag("conflict", "reload");
const OPEN_SEQ = flag("openSeq", "latest");
const PUBLISH_GUARD = flag("publishGuard", "disable") === "disable";
const LIST_POLL = Number(flag("listPoll", 6000));

const desk = rt.atom("desk", { filter: "all", items: [] as Story[], loading: true, error: "", notice: "" });
const editor = rt.atom("editor", { id: 0, story: 0, headline: "", standfirst: "", status: "", version: 0, dirty: false, saving: false, loading: false, error: "" });

async function loadList(background = false) {
  const f = desk.get().filter;
  if (!background) desk.update((s) => ({ ...s, loading: true, error: "" }));
  try {
    const items = itemsOf<Story>(await api(`/api/stories?limit=30${f === "all" ? "" : `&status=${f}`}`));
    if (desk.get().filter === f) desk.update((s) => ({ ...s, items, loading: false }));
  } catch (e) {
    if (desk.get().filter === f) desk.update((s) => ({ ...s, loading: false, error: background ? s.error : errText(e, "loading stories") }));
  }
}

async function open(id: number) {
  editor.update((e) => ({ ...e, id, loading: true, error: "" }));
  try {
    const st = await api<Story>(`/api/stories/${id}`);
    if (OPEN_SEQ === "latest" && editor.get().id !== id) return;
    editor.update((e) => ({ ...e, story: st.id, headline: st.headline, standfirst: st.standfirst, status: st.status, version: st.version, dirty: false, loading: false }));
  } catch (e) {
    if (editor.get().id === id) editor.update((x) => ({ ...x, loading: false, error: errText(e, "opening the story") }));
  }
}

let chain: Promise<void> = Promise.resolve();
let inflight = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
function edit(field: "headline" | "standfirst", v: string) {
  editor.update((e) => ({ ...e, [field]: v, dirty: true }));
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (AUTOSAVE === "serialized") chain = chain.then(save, save);
    else void save();
  }, 700);
}

async function save(patch: Partial<Story> = {}) {
  const e0 = editor.get();
  if (!e0.story || (!e0.dirty && !patch.status)) return;
  inflight++;
  editor.update((e) => ({ ...e, saving: true, error: "" }));
  const body = { headline: e0.headline, standfirst: e0.standfirst, ...patch };
  try {
    let saved: Story;
    try {
      saved = await api<Story>(`/api/stories/${e0.story}`, "PATCH", { ...body, version: e0.version });
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 409 && CONFLICT === "overwrite")) throw err;
      saved = await api<Story>(`/api/stories/${e0.story}`, "PATCH", { ...body, version: err.body?.current?.version });
    }
    editor.update((e) => (e.story !== saved.id ? e : { ...e, version: saved.version, status: saved.status, dirty: e.headline !== saved.headline || e.standfirst !== saved.standfirst }));
    desk.update((s) => ({ ...s, items: s.items.map((x) => (x.id === saved.id ? saved : x)), notice: patch.status ? `“${saved.headline}” is live.` : "" }));
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) {
      const cur = err.body?.current as Story | undefined;
      if (cur) editor.update((e) => (e.story !== cur.id ? e : { ...e, headline: cur.headline, standfirst: cur.standfirst, status: cur.status, version: cur.version, dirty: false, error: "Another editor changed this story; their version is loaded." }));
    } else editor.update((e) => ({ ...e, error: errText(err, "saving the story") }));
  } finally {
    inflight--;
    editor.update((e) => ({ ...e, saving: inflight > 0 }));
  }
}
function publish() {
  if (PUBLISH_GUARD && editor.get().saving) return;
  clearTimeout(timer);
  chain = chain.then(() => save({ status: "published" }), () => save({ status: "published" }));
}
function setFilter(f: string) {
  desk.update((s) => ({ ...s, filter: f }));
  void loadList();
}

function App() {
  const d = atomSignal(desk);
  const e = atomSignal(editor);
  const FILTERS: [string, string][] = [["all", "All"], ["draft", "Draft"], ["review", "Review"], ["published", "Published"]];
  return html`<div class="newsroom">
    <header><h1>Story desk</h1><nav class="status"><${For} each=${FILTERS}>${([k, l]: [string, string]) => html`<button type="button" class=${() => (d().filter === k ? "current" : "")} onClick=${() => setFilter(k)}>${l}</button>`}<//></nav>
      <${Show} when=${() => d().loading}><span class="muted">Loading…</span><//></header>
    <${Show} when=${() => d().error}><p role="alert">${() => d().error}</p><//>
    <${Show} when=${() => d().notice}><p class="notice">${() => d().notice}</p><//>
    <ul class="stories"><${For} each=${() => d().items}>${(s: Story) => html`<li class="story"><span class="desk">${s.desk}</span> ${s.headline} <em>${s.status}</em> <button type="button" class="open" onClick=${() => void open(s.id)}>Edit</button></li>`}<//></ul>
    <${Show} when=${() => e().id}>
      <form class="editor" onSubmit=${(ev: Event) => ev.preventDefault()}>
        <${Show} when=${() => e().loading}><p class="muted">Opening story…</p><//>
        <label>Headline <input name="headline" value=${() => e().headline} onInput=${(ev: Event) => edit("headline", (ev.currentTarget as HTMLInputElement).value)} /></label>
        <label>Standfirst <textarea name="standfirst" value=${() => e().standfirst} onInput=${(ev: Event) => edit("standfirst", (ev.currentTarget as HTMLTextAreaElement).value)}></textarea></label>
        <p class="save-state">${() => (e().saving ? "Saving…" : e().dirty ? "Unsaved changes" : `Saved · ${e().status}`)}</p>
        <${Show} when=${() => e().status !== "published"}><button type="button" class="publish" disabled=${() => PUBLISH_GUARD && e().saving} onClick=${publish}>Publish</button><//>
        <${Show} when=${() => e().error}><p role="alert">${() => e().error}</p><//>
      </form>
    <//>
  </div>`;
}

render(() => html`<${App} />`, document.getElementById("app")!);
void loadList();
setInterval(() => void loadList(true), LIST_POLL);
