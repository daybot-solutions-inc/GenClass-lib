// Team link library (Knockout 3 observables + data-bind templates; fetch). Shared bookmarks live in folders; teammates
// add, pin and move links too, so the folder polls every 6 s. Pin is a relative toggle (POST /links/:id/pin), moving a
// link to another folder is a versioned PATCH, adding one is a POST (one per URL: a duplicate answers 409), and Delete
// hides the row with an Undo bar and only sends the DELETE when the bar times out. The view model is registered with
// rt.guard: async results are written through the guarded handle, UI events set the observables directly. Latent bugs
// by flag: polls that left before a write committed put the old rows back (poll=blind: a deleted or moved link
// reappears), a DELETE sent at once with Undo re-adding the link (undo=immediate: an Undo while the DELETE is still on
// its way answers 409), moves sent without the version (move=force: a teammate's move is overwritten), folder loads
// applied in arrival order (folderSeq=blind) and a pinned counter adjusted by hand (pinned=incremental).
import ko from "knockout";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Link = { id: number; title: string; url: string; folder: string; pinned: boolean; addedBy: string; version: number };
type Lib = { folder: string; links: Link[]; pinnedCount: number; loading: boolean; hidden: number[]; busy: number[]; undo: { id: number; title: string } | null; adding: boolean; error: string; notice: string };
const POLL = flag("poll", "write-aware");
const UNDO = flag("undo", "deferred");
const MOVE = flag("move", "if-match");
const FOLDER_SEQ = flag("folderSeq", "latest");
const PINNED = flag("pinned", "derive");
const FOLDERS = ["Design", "Engineering", "Onboarding", "Research"];
const UNDO_MS = 5000;

const vm = {
  folder: ko.observable("Design"),
  links: ko.observableArray<Link>([]),
  pinnedCount: ko.observable(0),
  loading: ko.observable(true),
  hidden: ko.observableArray<number>([]),
  busy: ko.observableArray<number>([]),
  undo: ko.observable<{ id: number; title: string } | null>(null),
  adding: ko.observable(false),
  draftTitle: ko.observable(""),
  draftUrl: ko.observable(""),
  error: ko.observable(""),
  notice: ko.observable(""),
};
const snapshot = ko.pureComputed<Lib>(() => ({
  folder: vm.folder(),
  links: vm.links(),
  pinnedCount: vm.pinnedCount(),
  loading: vm.loading(),
  hidden: vm.hidden(),
  busy: vm.busy(),
  undo: vm.undo(),
  adding: vm.adding(),
  error: vm.error(),
  notice: vm.notice(),
}));
const lib = rt.guard<Lib>("library", {
  get: () => snapshot.peek(),
  set: (v) => {
    vm.folder(v.folder);
    vm.links(v.links);
    vm.pinnedCount(v.pinnedCount);
    vm.loading(v.loading);
    vm.hidden(v.hidden);
    vm.busy(v.busy);
    vm.undo(v.undo);
    vm.adding(v.adding);
    vm.error(v.error);
    vm.notice(v.notice);
  },
  subscribe: (fn) => {
    const sub = snapshot.subscribe(() => fn());
    return () => sub.dispose();
  },
});
const countPinned = (ls: Link[]) => ls.filter((l) => l.pinned).length;
const withLinks = (s: Lib, links: Link[], delta = 0): Lib => ({ ...s, links, pinnedCount: PINNED === "derive" ? countPinned(links) : s.pinnedCount + delta });
const replace = (ls: Link[], l: Link) => ls.map((x) => (x.id === l.id ? l : x));
const host = (u: string) => u.replace(/^https?:\/\//, "").split("/")[0];

/** Writes sent and finished: a poll that started before the latest write finished is outdated. */
let writesDone = 0;
let writesOut = 0;
let seq = 0;
async function load(background = false) {
  const my = background ? seq : ++seq;
  const folder = vm.folder();
  const mark = writesDone;
  if (!background) vm.loading(true);
  try {
    const links = itemsOf<Link>(await api(`/api/links?folder=${encodeURIComponent(folder)}&sort=title&limit=40`));
    lib.update((s) => {
      if ((background || FOLDER_SEQ === "latest") && (my !== seq || s.folder !== folder)) return s;
      if (background && POLL === "write-aware" && (mark !== writesDone || writesOut > 0)) return s;
      return { ...withLinks(s, links, 0), pinnedCount: PINNED === "derive" || !background ? countPinned(links) : s.pinnedCount, loading: false };
    });
  } catch (e) {
    if (!background && my === seq) lib.update((s) => ({ ...s, loading: false, error: errText(e, `loading ${folder}`) }));
  }
}
async function write<T>(fn: () => Promise<T>): Promise<T> {
  writesOut++;
  try {
    return await fn();
  } finally {
    writesOut--;
    writesDone++;
  }
}
const busy = (id: number, on: boolean) => lib.update((s) => ({ ...s, busy: on ? [...s.busy, id] : s.busy.filter((x) => x !== id) }));

async function togglePin(l: Link) {
  if (vm.busy().includes(l.id)) return;
  busy(l.id, true);
  vm.error("");
  if (PINNED === "incremental") vm.pinnedCount(vm.pinnedCount() + (l.pinned ? -1 : 1));
  try {
    const saved = await write(() => api<Link>(`/api/links/${l.id}/pin`, "POST"));
    lib.update((s) => ({ ...withLinks(s, replace(s.links, saved), 0), notice: `${saved.pinned ? "Pinned" : "Unpinned"} “${saved.title}”.` }));
  } catch (e) {
    lib.update((s) => ({ ...s, error: errText(e, `pinning “${l.title}”`) }));
  } finally {
    busy(l.id, false);
  }
}

async function move(l: Link, to: string) {
  if (to === l.folder || vm.busy().includes(l.id)) return;
  busy(l.id, true);
  vm.error("");
  try {
    const saved = await write(() => api<Link>(`/api/links/${l.id}`, "PATCH", MOVE === "if-match" ? { folder: to, version: l.version } : { folder: to }));
    lib.update((s) => ({ ...withLinks(s, s.folder === saved.folder ? replace(s.links, saved) : s.links.filter((x) => x.id !== saved.id), l.pinned ? -1 : 0), notice: `Moved “${saved.title}” to ${saved.folder}.` }));
  } catch (e) {
    const cur = e instanceof HttpError && e.status === 409 ? (e.body?.current as Link | undefined) : undefined;
    lib.update((s) => ({ ...(cur ? withLinks(s, s.folder === cur.folder ? replace(s.links, cur) : s.links.filter((x) => x.id !== cur.id), 0) : withLinks(s, s.links.map((x) => (x.id === l.id ? { ...x } : x)), 0)), error: cur ? `“${cur.title}” was just changed by a teammate (now in ${cur.folder}).` : errText(e, `moving “${l.title}”`) }));
  } finally {
    busy(l.id, false);
  }
}

const timers = new Map<number, ReturnType<typeof setTimeout>>();
const deleted = new Map<number, Link>();
async function commitDelete(l: Link) {
  timers.delete(l.id);
  try {
    await write(() => api(`/api/links/${l.id}`, "DELETE"));
    lib.update((s) => ({ ...withLinks(s, s.links.filter((x) => x.id !== l.id), l.pinned ? -1 : 0), hidden: s.hidden.filter((x) => x !== l.id), undo: s.undo?.id === l.id && UNDO === "deferred" ? null : s.undo }));
  } catch (e) {
    lib.update((s) => ({ ...s, hidden: s.hidden.filter((x) => x !== l.id), undo: s.undo?.id === l.id ? null : s.undo, error: errText(e, `deleting “${l.title}”`) }));
  }
}
function remove(l: Link) {
  if (vm.hidden().includes(l.id) || vm.busy().includes(l.id)) return;
  vm.hidden.push(l.id);
  vm.undo({ id: l.id, title: l.title });
  vm.error("");
  vm.notice("");
  deleted.set(l.id, l);
  if (UNDO === "deferred") timers.set(l.id, setTimeout(() => void commitDelete(l), UNDO_MS));
  else void commitDelete(l);
  setTimeout(() => vm.undo()?.id === l.id && vm.undo(null), UNDO_MS);
}
async function undo() {
  const u = vm.undo();
  if (!u) return;
  vm.undo(null);
  const l = deleted.get(u.id);
  if (!l) return;
  if (UNDO === "deferred") {
    clearTimeout(timers.get(u.id));
    timers.delete(u.id);
    vm.hidden.remove(u.id);
    vm.notice(`Restored “${l.title}”.`);
    return;
  }
  // immediate: the link is already deleted (or being deleted) on the server; add it back
  try {
    const back = await write(() => api<Link>(`/api/links`, "POST", { title: l.title, url: l.url, folder: l.folder, pinned: l.pinned, addedBy: l.addedBy }));
    lib.update((s) => ({ ...withLinks(s, s.folder === back.folder ? [...s.links.filter((x) => x.id !== l.id), back] : s.links, back.pinned ? 1 : 0), hidden: s.hidden.filter((x) => x !== l.id), notice: `Restored “${l.title}”.` }));
  } catch (e) {
    lib.update((s) => ({ ...s, error: e instanceof HttpError && e.status === 409 ? `“${l.title}” could not be restored: its URL is still in the library.` : errText(e, `restoring “${l.title}”`) }));
  }
}

async function add() {
  const title = vm.draftTitle().trim();
  const url = vm.draftUrl().trim();
  if (!title || !url || vm.adding()) return;
  lib.update((s) => ({ ...s, adding: true, error: "", notice: "" }));
  try {
    const saved = await write(() => api<Link>(`/api/links`, "POST", { title, url, folder: vm.folder(), pinned: false, addedBy: "you" }));
    lib.update((s) => ({ ...(s.folder === saved.folder && !s.links.some((x) => x.id === saved.id) ? withLinks(s, [...s.links, saved].sort((a, b) => a.title.localeCompare(b.title)), 0) : s), notice: `Added “${saved.title}”.` }));
    vm.draftTitle("");
    vm.draftUrl("");
  } catch (e) {
    lib.update((s) => ({ ...s, error: e instanceof HttpError && e.status === 409 ? `${host(url)} is already in the library.` : errText(e, "adding the link") }));
  } finally {
    lib.update((s) => ({ ...s, adding: false }));
  }
}

document.getElementById("app")!.innerHTML = `<h1>Team links</h1>
  <label>Folder <select name="folder" data-bind="options: folders, value: folder"></select></label>
  <span class="summary" data-bind="text: (loading() ? 'Loading… · ' : '') + shown().length + ' links · ' + pinnedCount() + ' pinned'"></span>
  <p role="alert" data-bind="visible: error, text: error"></p><p class="notice" data-bind="visible: !error() && notice(), text: notice"></p>
  <div class="undo" data-bind="visible: undo"><span data-bind="text: undo() ? 'Deleted “' + undo().title + '”' : ''"></span> <button type="button" class="undo" data-bind="click: doUndo">Undo</button></div>
  <table><tbody data-bind="foreach: shown"><tr class="link">
    <td><span data-bind="text: pinned ? '★ ' : ''"></span><a data-bind="text: title, attr: { href: url }"></a></td><td data-bind="text: $root.host(url)"></td><td data-bind="text: 'added by ' + addedBy"></td>
    <td><button type="button" class="pin" data-bind="text: pinned ? 'Unpin' : 'Pin', click: () => $root.pin($data), disable: $root.busy().includes(id)"></button>
      <select class="move" data-bind="options: $root.folders, value: $root.folderOf($data), event: { change: (d, e) => $root.moveTo($data, e.target.value) }, disable: $root.busy().includes(id)"></select>
      <button type="button" class="delete" data-bind="click: () => $root.del($data), disable: $root.busy().includes(id)">Delete</button></td>
  </tr></tbody></table>
  <form class="add" data-bind="submit: addLink"><input name="title" placeholder="Title" data-bind="textInput: draftTitle"> <input name="url" placeholder="https://…" data-bind="textInput: draftUrl">
    <button type="submit" data-bind="disable: adding, text: adding() ? 'Adding…' : 'Add link'"></button></form>`;

ko.applyBindings(
  {
    ...vm,
    folders: FOLDERS,
    shown: ko.pureComputed(() => vm.links().filter((l) => !vm.hidden().includes(l.id))),
    host,
    folderOf: (l: Link) => l.folder,
    pin: (l: Link) => void togglePin(l),
    moveTo: (l: Link, to: string) => void move(l, to),
    del: (l: Link) => remove(l),
    doUndo: () => void undo(),
    addLink: () => void add(),
  },
  document.getElementById("app"),
);
vm.folder.subscribe(() => {
  vm.error("");
  vm.notice("");
  void load();
});
void load();
setInterval(() => !vm.loading() && void load(true), 6000);
