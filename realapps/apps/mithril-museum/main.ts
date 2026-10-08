// Museum collection catalogue for curators (Mithril 2 hyperscript, m.request over XHR; state in runtime atoms with
// m.redraw on change). Objects page by 8 with a department filter (`dept__in=` for grouped departments) and a search
// box; hovering a row prefetches the object's record so "Open" shows it at once (then revalidates). In the detail pane
// the curator edits the gallery label (debounced autosave, versioned PATCH: the registrar edits labels too) and asks
// for an exhibition loan (POST /loans, one per object and venue). Latent bugs by flag: hover prefetches that land after
// a save and replace the open record with the older one (prefetch=blind: the next autosave conflicts), detail loads
// applied in arrival order (detailSeq=blind: the pane shows the object you opened before), labels saved without the
// version (labelSave=force: the registrar's edit is overwritten), autosave answers written over what was typed since
// (echo=blind) and loan buttons live while posting (loanGuard=none: the second POST answers 409).
import m from "mithril";
import { rt, flag } from "../_shared/genclass";

type Obj = { id: number; accession: string; title: string; maker: string; dept: string; year: number; label: string; location: string; version: number };
type Loan = { id: number; objectId: number; title: string; venue: string };
const PREFETCH = flag("prefetch", "newer-only");
const DETAIL_SEQ = flag("detailSeq", "latest");
const LABEL_SAVE = flag("labelSave", "if-match");
const ECHO = flag("echo", "keep-newer-typing");
const LOAN_GUARD = flag("loanGuard", "pending") === "pending";
const PER = 8;
const GROUPS: Record<string, string[]> = { all: [], paintings: ["paintings"], paper: ["prints", "drawings", "photographs"], objects: ["ceramics", "furniture", "textiles"] };
const VENUES = ["Tate Liverpool", "Rijksmuseum", "Art Institute of Chicago", "National Gallery of Canada"];

const catalogue = rt.atom("catalogue", { group: "all", q: "", page: 1, rows: [] as Obj[], total: 0, loading: true, error: "", notice: "" });
const detail = rt.atom("detail", { id: 0, obj: null as Obj | null, draft: "", loading: false, saving: false, dirty: false });
const loans = rt.atom("loans", { mine: [] as Loan[], busy: [] as number[], venue: VENUES[0]! });
for (const a of [catalogue, detail, loans]) a.subscribe(() => m.redraw());
const code = (e: any) => Number(e?.code ?? 0) || "offline";
const note = (patch: { error?: string; notice?: string }) => catalogue.update((c) => ({ ...c, error: "", notice: "", ...patch }));

/** Records fetched by hover prefetch or by opening, by id (what "Open" shows first). */
const cache = new Map<number, Obj>();
const remember = (o: Obj) => {
  const cur = cache.get(o.id);
  if (PREFETCH === "blind" || !cur || o.version >= cur.version) cache.set(o.id, o);
};

let listSeq = 0;
async function loadList(background = false) {
  const my = ++listSeq;
  const { group, q, page } = catalogue.get();
  if (!background) catalogue.update((c) => ({ ...c, loading: true, error: "" }));
  try {
    const params: Record<string, unknown> = { page, limit: PER, sort: "accession", ...(q ? { q } : {}), ...(GROUPS[group]!.length ? { dept__in: GROUPS[group]!.join(",") } : {}) };
    const body = await m.request<{ items: Obj[]; total: number }>({ url: "/api/objects", params, background: true });
    if (my !== listSeq) return;
    const rows = Array.isArray(body?.items) ? body.items : [];
    catalogue.update((c) => ({ ...c, rows, total: Number(body?.total ?? rows.length), loading: false }));
  } catch (e) {
    if (my === listSeq && !background) catalogue.update((c) => ({ ...c, loading: false, error: `The catalogue could not be loaded (${code(e)}).` }));
  }
}

const prefetching = new Set<number>();
const fetchedAt = new Map<number, number>();
async function prefetch(id: number) {
  // a record fetched in the last few seconds is fresh enough; older ones are refetched on hover
  if (Date.now() - (fetchedAt.get(id) ?? -1e9) < 4000 || prefetching.has(id)) return;
  prefetching.add(id);
  fetchedAt.set(id, Date.now());
  try {
    const o = await m.request<Obj>({ url: `/api/objects/${id}`, background: true });
    remember(o);
    // an open record is refreshed by a prefetch only when it is newer and nothing is being saved
    detail.update((d) => (d.id !== id || !d.obj ? d : PREFETCH === "blind" || (o.version > d.obj.version && !d.saving && !d.dirty) ? { ...d, obj: o } : d));
  } catch {
    /* a failed prefetch just means Open loads it */
  } finally {
    prefetching.delete(id);
  }
}

let detailSeq = 0;
async function open(id: number) {
  const my = ++detailSeq;
  const hit = cache.get(id) ?? null;
  detail.set({ id, obj: hit, draft: hit?.label ?? "", loading: !hit, saving: false, dirty: false });
  note({});
  fetchedAt.set(id, Date.now());
  try {
    const o = await m.request<Obj>({ url: `/api/objects/${id}`, background: true });
    remember(o);
    if (DETAIL_SEQ === "latest" && my !== detailSeq) return;
    detail.update((d) => {
      const typed = d.id === id && d.obj && d.draft !== d.obj.label;
      return { ...d, id, obj: o, draft: typed ? d.draft : o.label, loading: false };
    });
  } catch (e) {
    if (my === detailSeq) {
      detail.update((d) => ({ ...d, loading: false }));
      note({ error: `Object record could not be loaded (${code(e)}).` });
    }
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
function typed(value: string) {
  detail.update((d) => ({ ...d, draft: value, dirty: true }));
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void save();
  }, 700);
}

async function save() {
  const d0 = detail.get();
  if (!d0.obj || d0.saving) return;
  if (d0.draft === d0.obj.label) return void detail.update((d) => ({ ...d, dirty: false }));
  const sent = d0.draft;
  const target = d0.obj;
  detail.update((d) => ({ ...d, saving: true, dirty: false }));
  try {
    const body = LABEL_SAVE === "if-match" ? { label: sent, version: target.version } : { label: sent };
    const saved = await m.request<Obj>({ method: "PATCH", url: `/api/objects/${target.id}`, body, background: true });
    remember(saved);
    detail.update((d) => (d.id !== saved.id ? d : { ...d, obj: saved, draft: ECHO === "keep-newer-typing" && d.draft !== sent ? d.draft : saved.label }));
    catalogue.update((c) => ({ ...c, rows: c.rows.map((r) => (r.id === saved.id ? saved : r)), error: "", notice: `Label for ${saved.accession} saved.` }));
  } catch (e) {
    const cur = code(e) === 409 ? ((e as any)?.response?.current as Obj | undefined) : undefined;
    if (cur) {
      remember(cur);
      detail.update((d) => (d.id !== cur.id ? d : { ...d, obj: cur, draft: cur.label, dirty: false }));
      note({ error: `The registrar changed the label of ${cur.accession} meanwhile — their version is shown.` });
    } else note({ error: `The label could not be saved (${code(e)}).` });
  } finally {
    detail.update((d) => ({ ...d, saving: false }));
    const d1 = detail.get();
    if (d1.obj && d1.id === target.id && d1.draft !== d1.obj.label && !timer) void save();
  }
}

async function requestLoan() {
  const { obj } = detail.get();
  const venue = loans.get().venue;
  if (!obj || (LOAN_GUARD && loans.get().busy.includes(obj.id))) return;
  loans.update((l) => ({ ...l, busy: [...l.busy, obj.id] }));
  note({});
  try {
    const loan = await m.request<Loan>({ method: "POST", url: "/api/loans", body: { objectId: obj.id, title: obj.title, venue, curator: "you", key: `${obj.id}|${venue}` }, background: true });
    loans.update((l) => ({ ...l, mine: l.mine.some((x) => x.id === loan.id) ? l.mine : [...l.mine, loan] }));
    note({ notice: `Loan of “${obj.title}” to ${venue} requested.` });
  } catch (e) {
    note({ error: code(e) === 409 ? `“${obj.title}” is already requested for ${venue}.` : `The loan request failed (${code(e)}).` });
  } finally {
    loans.update((l) => ({ ...l, busy: l.busy.filter((x) => x !== obj.id) }));
  }
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;
function go(patch: { group?: string; q?: string; page?: number }) {
  catalogue.update((c) => ({ ...c, ...patch, notice: "" }));
  if (patch.q !== undefined && patch.group === undefined) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void loadList(), 300);
  } else void loadList();
}

const DEPT_LABEL: Record<string, string> = { all: "All departments", paintings: "Paintings", paper: "Works on paper", objects: "Decorative arts" };
const App = {
  view() {
    const c = catalogue.get();
    const d = detail.get();
    const l = loans.get();
    const pages = Math.max(1, Math.ceil(c.total / PER));
    const mineHere = d.obj ? l.mine.filter((x) => x.objectId === d.obj!.id) : [];
    return m("main.museum", [
      m("h1", "Collection catalogue"),
      m("div.filters", [
        m("select[name=dept]", { value: c.group, onchange: (e: Event) => go({ group: (e.target as HTMLSelectElement).value, q: "", page: 1 }) }, Object.keys(GROUPS).map((g) => m("option", { value: g }, DEPT_LABEL[g]))),
        m("input[name=q][placeholder=Search title or maker]", { value: c.q, oninput: (e: Event) => go({ q: (e.target as HTMLInputElement).value, page: 1 }) }),
      ]),
      c.error ? m("p[role=alert]", c.error) : c.notice ? m("p.notice", c.notice) : null,
      c.loading ? m("p.muted", "Loading…") : m("p.summary", `${c.total} objects`),
      m("table", m("tbody", c.rows.map((o) => m("tr.object", { key: o.id, class: d.id === o.id ? "open" : "", onmouseenter: () => void prefetch(o.id) }, [
        m("td", o.accession), m("td", o.title), m("td", `${o.maker}, ${o.year}`), m("td", o.dept), m("td", o.location),
        m("td", m("button.open[type=button]", { onclick: () => void open(o.id) }, d.id === o.id ? "Opened" : "Open")),
      ])))),
      m("nav.pages", Array.from({ length: pages }, (_, i) => m("button[type=button]", { class: c.page === i + 1 ? "current" : "", onclick: () => go({ page: i + 1 }) }, String(i + 1)))),
      d.id
        ? m("section.detail", d.loading || !d.obj
            ? m("p.muted", "Loading record…")
            : [
                m("h2", `${d.obj.accession} · ${d.obj.title}`),
                m("p", `${d.obj.maker} (${d.obj.year}) · ${d.obj.dept} · ${d.obj.location}`),
                m("label", ["Gallery label", m("textarea[name=label][rows=4]", { value: d.draft, oninput: (e: Event) => typed((e.target as HTMLTextAreaElement).value) })]),
                m("p.save-state", d.saving ? "Saving…" : d.draft === d.obj.label ? "All changes saved" : "Unsaved changes"),
                m("div.loan", [
                  m("select[name=venue]", { value: l.venue, onchange: (e: Event) => loans.update((x) => ({ ...x, venue: (e.target as HTMLSelectElement).value })) }, VENUES.map((v) => m("option", { value: v }, v))),
                  m("button.loan[type=button]", { disabled: LOAN_GUARD && l.busy.includes(d.obj.id), onclick: () => void requestLoan() }, l.busy.includes(d.obj.id) ? "Requesting…" : "Request loan"),
                ]),
                mineHere.length ? m("ul.loans", mineHere.map((x) => m("li", `Requested for ${x.venue}`))) : null,
              ])
        : m("p.muted", "Hover a row to preview, Open to edit its label."),
    ]);
  },
};
m.mount(document.getElementById("app")!, App);
void loadList();
void m.request<{ items: Loan[] }>({ url: "/api/loans", params: { curator: "you", limit: 50 }, background: true }).then((b) => loans.update((l) => ({ ...l, mine: b?.items ?? [] })), () => undefined);
setInterval(() => !catalogue.get().loading && void loadList(true), 8000);
