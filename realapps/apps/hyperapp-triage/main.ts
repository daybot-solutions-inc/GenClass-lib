// Issue triage board (Hyperapp 2 actions/effects/subscriptions; state registered via hyperappGuard; fetch). The
// triager filters by component, ticks issues and applies a label to all of them (POST /issues/bulk, per-item
// results), or takes an issue ("Assign to me"). New reports arrive and teammates label issues while the list polls.
// Latent bugs by flag: bulk results ignored (bulkResult=assume-all: issues whose update failed show the label
// anyway), assign buttons live while posting (assignGuard=none), component lists applied in arrival order
// (listSeq=blind), selections kept across reloads (selection=keep: hidden issues get labelled) and an untriaged
// counter adjusted by hand (untriaged=manual).
import { app, h, text } from "hyperapp";
import { flag } from "../_shared/genclass";
import { hyperappGuard } from "../_shared/hyperapp-guard";
import { api, itemsOf, errText } from "../_shared/w3-http";

type Issue = { id: number; number: number; title: string; label: string; assignee: string; component: string };
type S = { component: string; issues: Issue[]; selected: number[]; untriaged: number; busy: number[]; loading: boolean; error: string; notice: string };
const BULK_RESULT = flag("bulkResult", "per-item");
const ASSIGN_GUARD = flag("assignGuard", "pending") === "pending";
const LIST_SEQ = flag("listSeq", "latest");
const SELECTION = flag("selection", "prune");
const UNTRIAGED = flag("untriaged", "derive");
const ME = "you";

const count = (is: Issue[]) => is.filter((i) => !i.label).length;
const init: S = { component: "all", issues: [], selected: [], untriaged: 0, busy: [], loading: true, error: "", notice: "" };
const { middleware, store } = hyperappGuard<S>("triage", init);
const withIssues = (s: S, issues: Issue[], delta = 0): S => ({ ...s, issues, untriaged: UNTRIAGED === "derive" ? count(issues) : s.untriaged + delta });

let seq = 0;
const loadFx = (component: string, background: boolean) => [
  () => {
    const my = background ? seq : ++seq;
    api(`/api/issues?limit=40${component === "all" ? "" : `&component=${component}`}`)
      .then((body) => {
        const issues = itemsOf<Issue>(body);
        store.update((s) => {
          if ((LIST_SEQ === "latest" && my !== seq) || (background && s.component !== component)) return s;
          const busy = new Set(s.busy);
          const merged = issues.map((i) => (busy.has(i.id) ? (s.issues.find((x) => x.id === i.id) ?? i) : i));
          const selected = SELECTION === "prune" ? s.selected.filter((id) => merged.some((i) => i.id === id)) : s.selected;
          return { ...withIssues(s, merged), untriaged: UNTRIAGED === "derive" || !background ? count(merged) : s.untriaged, selected, loading: false };
        });
      })
      .catch((e) => store.update((s) => (my !== seq ? s : { ...s, loading: false, error: background ? s.error : errText(e, "loading issues") })));
  },
  null,
];

const bulkFx = (ids: number[], label: string) => [
  () => {
    api<{ results: { id: number; ok: boolean }[] }>(`/api/issues/bulk`, "POST", { ids, op: "patch", patch: { label } })
      .then((r) => {
        const ok = new Set(BULK_RESULT === "per-item" ? r.results.filter((x) => x.ok).map((x) => Number(x.id)) : ids);
        const failed = ids.length - r.results.filter((x) => x.ok).length;
        store.update((s) => {
          const issues = s.issues.map((i) => (ok.has(i.id) ? { ...i, label } : i));
          const newly = s.issues.filter((i) => ok.has(i.id) && !i.label).length;
          return { ...withIssues(s, issues, -newly), selected: [], busy: [], notice: `Labelled ${ok.size} issue(s) “${label}”.`, error: failed && BULK_RESULT === "per-item" ? `${failed} issue(s) could not be labelled.` : "" };
        });
      })
      .catch((e) => store.update((s) => ({ ...s, busy: [], error: errText(e, "labelling") })));
  },
  null,
];

const assignFx = (id: number) => [
  () => {
    api<Issue>(`/api/issues/${id}`, "PATCH", { assignee: ME })
      .then((saved) => store.update((s) => ({ ...withIssues(s, s.issues.map((i) => (i.id === id ? saved : i))), busy: s.busy.filter((x) => x !== id), notice: `#${saved.number} is yours.`, error: "" })))
      .catch((e) => store.update((s) => ({ ...s, busy: s.busy.filter((x) => x !== id), error: errText(e, "assigning the issue") })));
  },
  null,
];

const Filter = (s: S, component: string) => [{ ...s, component, loading: true, error: "", notice: "" }, loadFx(component, false)];
const Poll = (s: S) => [s, loadFx(s.component, true)];
const Pick = (s: S, id: number) => ({ ...s, selected: s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id] });
const Apply = (s: S, label: string) => (s.selected.length === 0 || s.busy.length ? s : [{ ...s, busy: [...s.selected], error: "", notice: "" }, bulkFx(s.selected, label)]);
const Assign = (s: S, id: number) => (ASSIGN_GUARD && s.busy.includes(id) ? s : [{ ...s, busy: [...s.busy, id], error: "" }, assignFx(id)]);

// one subscriber function for every interval (module level): Hyperapp compares subscribers by identity, so a
// function created per render would restart the interval on every state change
const intervalSub = (dispatch: (a: unknown) => void, p: { ms: number; action: unknown }) => {
  const iv = setInterval(() => dispatch(p.action), p.ms);
  return () => clearInterval(iv);
};
const every = (ms: number, action: unknown) => [intervalSub, { ms, action }];

const view = (s: S) =>
  h("main", { class: "triage" }, [
    h("header", {}, [h("h1", {}, text("Triage")), h("p", { class: "untriaged" }, text(`${s.untriaged} untriaged`))]),
    h("nav", { class: "components" }, ["all", "api", "web", "mobile"].map((c) => h("button", { class: s.component === c ? "current" : "", onclick: [Filter, c] }, text(c === "all" ? "All" : c)))),
    h("div", { class: "bulk" }, [text(`${s.selected.length} selected `), ...["bug", "feature", "perf", "docs"].map((l) => h("button", { class: "apply", disabled: s.selected.length === 0 || s.busy.length > 0, onclick: [Apply, l] }, text(l)))]),
    s.error ? h("p", { role: "alert" }, text(s.error)) : s.notice ? h("p", { class: "notice" }, text(s.notice)) : text(""),
    s.loading ? h("p", { class: "muted" }, text("Loading…")) : text(""),
    h(
      "ul",
      { class: "issues" },
      s.issues.map((i) =>
        h("li", { class: "issue", key: i.id }, [
          h("input", { type: "checkbox", class: "pick", checked: s.selected.includes(i.id), onchange: [Pick, i.id] }),
          text(` #${i.number} ${i.title} [${i.component}] ${i.label ? `· ${i.label}` : "· untriaged"} ${i.assignee ? `· @${i.assignee}` : ""} `),
          i.assignee ? text("") : h("button", { class: "mine", disabled: ASSIGN_GUARD && s.busy.includes(i.id), onclick: [Assign, i.id] }, text("Assign to me")),
        ]),
      ),
    ),
  ]);

app<S>({
  init: [init, loadFx("all", false)],
  view,
  node: document.getElementById("app")!,
  subscriptions: () => [every(5000, Poll)],
  dispatch: middleware,
} as never);
