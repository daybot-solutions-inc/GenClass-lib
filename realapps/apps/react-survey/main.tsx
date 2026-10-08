// Survey builder (React 19 + useGenClassState + fetch). Questions are a collection ordered by an `order` field;
// question text autosaves; the survey document (versioned) is published with its question count. Latent bugs by
// flag: the Add button live while posting (addGuard=none), a PATCH per keystroke (editSave=on-change: an older text
// can land last), optimistic deletes without rollback (deleteMode=optimistic), new questions ordered by list length
// (order=length+1: after a delete two questions share a position) and Publish live while publishing.
import { createRoot } from "react-dom/client";
import { useEffect, useRef } from "react";
import { useGenClassState } from "@genclass/runtime/react";
import { flag } from "../_shared/genclass";
import { api, itemsOf, errText } from "../_shared/w3-http";

type Q = { id: number; order: number; text: string; type: string };
type Survey = { title: string; status: string; questionCount: number; version: number };
const ADD_GUARD = flag("addGuard", "disable") === "disable";
const EDIT_SAVE = flag("editSave", "debounced");
const DELETE_MODE = flag("deleteMode", "wait");
const ORDER = flag("order", "max+1");
const PUBLISH_GUARD = flag("publishGuard", "pending") === "pending";
const sortQ = (qs: Q[]) => [...qs].sort((a, b) => a.order - b.order || a.id - b.id);

function Builder() {
  const [b, setB] = useGenClassState("builder", { title: "", status: "", version: 0, questions: [] as Q[], newq: "", type: "scale", adding: false, saving: 0, error: "", notice: "" });
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const publishing = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const [qs, sv] = await Promise.all([api(`/api/questions?limit=50`).then(itemsOf<Q>), api<Survey>(`/api/docs/survey`)]);
        setB((s) => ({ ...s, questions: sortQ(qs), title: sv.title, status: sv.status, version: sv.version }));
      } catch (e) {
        setB((s) => ({ ...s, error: errText(e, "loading the survey") }));
      }
    })();
  }, []);

  async function add() {
    if (ADD_GUARD && b.adding) return;
    const text = b.newq.trim();
    if (!text) return setB((s) => ({ ...s, error: "Type a question first." }));
    setB((s) => ({ ...s, adding: true, error: "", notice: "" }));
    try {
      const order = ORDER === "max+1" ? b.questions.reduce((m, q) => Math.max(m, q.order), 0) + 1 : b.questions.length + 1;
      const q = await api<Q>(`/api/questions`, "POST", { text, type: b.type, order });
      setB((s) => ({ ...s, questions: sortQ([...s.questions.filter((x) => x.id !== q.id), q]), newq: s.newq === b.newq ? "" : s.newq, notice: "Question added." }));
    } catch (e) {
      setB((s) => ({ ...s, error: errText(e, "adding the question") }));
    } finally {
      setB((s) => ({ ...s, adding: false }));
    }
  }

  function edit(q: Q, text: string) {
    setB((s) => ({ ...s, questions: s.questions.map((x) => (x.id === q.id ? { ...x, text } : x)) }));
    const save = async () => {
      setB((s) => ({ ...s, saving: s.saving + 1 }));
      try {
        await api<Q>(`/api/questions/${q.id}`, "PATCH", { text });
      } catch (e) {
        setB((s) => ({ ...s, error: errText(e, "saving the question") }));
      } finally {
        setB((s) => ({ ...s, saving: s.saving - 1 }));
      }
    };
    if (EDIT_SAVE === "on-change") return void save();
    clearTimeout(timers.current.get(q.id));
    timers.current.set(q.id, setTimeout(() => void save(), 700));
  }

  async function remove(q: Q) {
    if (DELETE_MODE === "optimistic") setB((s) => ({ ...s, questions: s.questions.filter((x) => x.id !== q.id) }));
    try {
      await api(`/api/questions/${q.id}`, "DELETE");
      setB((s) => ({ ...s, questions: s.questions.filter((x) => x.id !== q.id), notice: "Question removed.", error: "" }));
    } catch (e) {
      setB((s) => ({ ...s, error: errText(e, "removing the question") }));
    }
  }

  async function publish() {
    if (PUBLISH_GUARD && publishing.current) return;
    publishing.current = true;
    try {
      const sv = await api<Survey>(`/api/docs/survey`, "PATCH", { status: "published", questionCount: b.questions.length, version: b.version });
      setB((s) => ({ ...s, status: sv.status, version: sv.version, notice: `Published with ${sv.questionCount} questions.`, error: "" }));
    } catch (e) {
      setB((s) => ({ ...s, error: errText(e, "publishing") }));
    } finally {
      publishing.current = false;
    }
  }

  return (
    <div className="builder">
      <h1>{b.title || "Survey"} <small>{b.status}</small></h1>
      {b.error ? <p role="alert">{b.error}</p> : b.notice ? <p className="notice">{b.notice}</p> : null}
      <ol className="questions">
        {b.questions.map((q) => (
          <li key={q.id} className="question">
            <span className="type">{q.type}</span> <input className="text" value={q.text} onChange={(e) => edit(q, e.target.value)} /> <button className="delete" onClick={() => void remove(q)}>Delete</button>
          </li>
        ))}
      </ol>
      <form className="add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input name="newq" placeholder="New question" value={b.newq} onChange={(e) => setB((s) => ({ ...s, newq: e.target.value }))} />{" "}
        <select name="type" value={b.type} onChange={(e) => setB((s) => ({ ...s, type: e.target.value }))}>{["scale", "multi", "text", "yesno"].map((t) => <option key={t}>{t}</option>)}</select>{" "}
        <button type="submit" disabled={ADD_GUARD && b.adding}>{b.adding ? "Adding…" : "Add question"}</button>
      </form>
      <p className="muted">{b.saving > 0 ? "Saving…" : "All changes saved"}</p>
      {b.status !== "published" && <button className="publish" onClick={() => void publish()}>Publish ({b.questions.length} questions)</button>}
    </div>
  );
}

createRoot(document.getElementById("app")!).render(<Builder />);
