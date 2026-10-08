// CRM email sequences (React 19 + Zustand 5 registered through the runtime's zustand middleware; fetch). A rep opens
// a sequence (its steps and enrolled contacts load together), edits step subjects inline, pauses/resumes it and
// enrolls ticked contacts (one POST per contact; "<sequence>-<contact>" is unique server-side). Latent bugs by
// flag: the Enroll button live while enrolling (enrollGuard=none), Promise.all over the enrollments (enrollWait=all:
// one failure discards the ones that succeeded from the screen), sequence loads applied in arrival order
// (seqLoad=blind), a PATCH per keystroke (subjectSave=per-keystroke: an older subject can land last) and an enrolled
// counter adjusted by hand (enrolledCount=manual).
import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import { create } from "zustand";
import { genclass } from "@genclass/runtime/zustand";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText } from "../_shared/w3-http";

type Sequence = { id: number; name: string; status: string };
type Step = { id: number; sequenceId: number; order: number; subject: string; delayDays: number };
type Contact = { id: number; name: string; company: string };
type Enrollment = { id: number; key: string; sequenceId: number; contactId: number };
const ENROLL_GUARD = flag("enrollGuard", "disable") === "disable";
const ENROLL_WAIT = flag("enrollWait", "allSettled");
const SEQ_LOAD = flag("seqLoad", "latest");
const SUBJECT_SAVE = flag("subjectSave", "debounced");
const ENROLLED_COUNT = flag("enrolledCount", "derive");

type S = { list: Sequence[]; current: number; steps: Step[]; enrolled: Enrollment[]; enrolledCount: number; contacts: Contact[]; picked: number[]; busy: boolean; loading: boolean; error: string; notice: string };
const useSeq = create<S>()(genclass(rt, "sequences")(() => ({ list: [], current: 0, steps: [], enrolled: [], enrolledCount: 0, contacts: [], picked: [], busy: false, loading: true, error: "", notice: "" }) as S));
const set = useSeq.setState;
const get = useSeq.getState;

let seq = 0;
async function open(id: number) {
  const my = ++seq;
  set({ current: id, loading: true, error: "", notice: "", picked: [] });
  try {
    const [steps, enrolled] = await Promise.all([api(`/api/steps?sequenceId=${id}`).then(itemsOf<Step>), api(`/api/enrollments?sequenceId=${id}&limit=50`).then(itemsOf<Enrollment>)]);
    if (SEQ_LOAD === "latest" && (my !== seq || get().current !== id)) return;
    set({ steps: steps.sort((a, b) => a.order - b.order), enrolled, enrolledCount: enrolled.length, loading: false });
  } catch (e) {
    if (my === seq) set({ loading: false, error: errText(e, "loading the sequence") });
  }
}

async function enroll() {
  const { picked, current, enrolled, busy } = get();
  if (ENROLL_GUARD && busy) return;
  const ids = picked.filter((c) => !enrolled.some((e) => e.contactId === c));
  if (!ids.length) return;
  set({ busy: true, error: "", notice: "" });
  const post = (c: number) => api<Enrollment>(`/api/enrollments`, "POST", { key: `${current}-${c}`, sequenceId: current, contactId: c });
  const add = (es: Enrollment[]) =>
    set((s) => {
      if (s.current !== current) return s;
      const fresh = es.filter((e) => !s.enrolled.some((x) => x.id === e.id));
      const all = [...s.enrolled, ...fresh];
      return { enrolled: all, enrolledCount: ENROLLED_COUNT === "derive" ? all.length : s.enrolledCount + es.length };
    });
  try {
    if (ENROLL_WAIT === "all") {
      const es = await Promise.all(ids.map(post));
      add(es);
      set({ notice: `Enrolled ${es.length} contact(s).`, picked: [] });
    } else {
      const rs = await Promise.allSettled(ids.map(post));
      const ok = rs.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      add(ok);
      const failed = rs.length - ok.length;
      set({ notice: ok.length ? `Enrolled ${ok.length} contact(s).` : "", error: failed ? `${failed} contact(s) could not be enrolled.` : "", picked: [] });
    }
  } catch (e) {
    set({ error: errText(e, "enrolling contacts") });
  } finally {
    set({ busy: false });
  }
}

const timers = new Map<number, ReturnType<typeof setTimeout>>();
function editSubject(step: Step, subject: string) {
  set((s) => ({ steps: s.steps.map((x) => (x.id === step.id ? { ...x, subject } : x)) }));
  const save = () =>
    api<Step>(`/api/steps/${step.id}`, "PATCH", { subject })
      .then(() => set({ notice: `Saved step ${step.order}.` }))
      .catch((e) => set({ error: errText(e, `saving step ${step.order}`) }));
  if (SUBJECT_SAVE === "per-keystroke") return void save();
  clearTimeout(timers.get(step.id));
  timers.set(step.id, setTimeout(() => (timers.delete(step.id), void save()), 600));
}

async function toggleStatus() {
  const s0 = get();
  const cur = s0.list.find((x) => x.id === s0.current);
  if (!cur || s0.busy) return;
  set({ busy: true });
  try {
    const saved = await api<Sequence>(`/api/sequences/${cur.id}`, "PATCH", { status: cur.status === "active" ? "paused" : "active" });
    set((s) => ({ list: s.list.map((x) => (x.id === saved.id ? saved : x)), notice: `${saved.name} is ${saved.status}.`, error: "" }));
  } catch (e) {
    set({ error: errText(e, "changing the status") });
  } finally {
    set({ busy: false });
  }
}

function App() {
  const s = useSeq();
  useEffect(() => {
    (async () => {
      try {
        const [list, contacts] = await Promise.all([api(`/api/sequences`).then(itemsOf<Sequence>), api(`/api/contacts`).then(itemsOf<Contact>)]);
        set({ list, contacts });
        void open(list[0]?.id ?? 0);
      } catch (e) {
        set({ loading: false, error: errText(e, "loading sequences") });
      }
    })();
  }, []);
  const cur = s.list.find((x) => x.id === s.current);
  const isIn = (c: number) => s.enrolled.some((e) => e.contactId === c);
  return (
    <div className="sequences">
      <h1>Sequences</h1>
      <nav className="sequences">{s.list.map((x) => <button key={x.id} className={x.id === s.current ? "current" : ""} onClick={() => void open(x.id)}>{x.name}</button>)}</nav>
      {s.error ? <p role="alert">{s.error}</p> : s.notice ? <p className="notice">{s.notice}</p> : null}
      {cur && <p>{cur.name} · {cur.status} · {s.enrolledCount} enrolled <button className="status" onClick={() => void toggleStatus()}>{cur.status === "active" ? "Pause" : "Resume"}</button></p>}
      {s.loading && <p className="muted">Loading…</p>}
      <ol className="steps">{s.steps.map((st) => <li key={st.id} className="step">Day {st.delayDays}: <input className="subject" value={st.subject} onChange={(e) => editSubject(st, e.target.value)} /></li>)}</ol>
      <h2>Contacts</h2>
      <ul className="contacts">
        {s.contacts.map((c) => (
          <li key={c.id} className="contact">
            <label><input type="checkbox" className="pick" disabled={isIn(c.id)} checked={isIn(c.id) || s.picked.includes(c.id)} onChange={() => set((x) => ({ picked: x.picked.includes(c.id) ? x.picked.filter((p) => p !== c.id) : [...x.picked, c.id] }))} /> {c.name} ({c.company})</label>
          </li>
        ))}
      </ul>
      <button className="enroll" disabled={!s.picked.length || (ENROLL_GUARD && s.busy)} onClick={() => void enroll()}>Enroll {s.picked.length || ""}</button>
    </div>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
