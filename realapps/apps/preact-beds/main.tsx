// Hospital bed board for the patient-flow coordinator (Preact 10 with hooks — component state only, nothing
// registered with GenClass: observe-only; fetch + WebSocket). Beds and the admissions queue update live as wards
// discharge, clean and take transfers. Placing a patient is two writes: a versioned PATCH puts them in an available
// bed, then their admission request is closed (DELETE). Latent bugs by flag: placements sent without the version
// (assign=force: a bed another ward just filled is double-booked), bed buttons live while a placement posts
// (assignGuard=none), the admission closed before the bed is secured (steps=admission-first: when the bed PATCH
// fails the patient silently drops out of the queue), pushes applied in arrival order (live=blind) and reconnects
// without a reload (reconnect=naive).
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError, liveTopic } from "../_shared/w3-http";

type Bed = { id: number; ward: string; bed: string; status: string; patient: string; version: number; updatedAt?: string };
type Admission = { id: number; name: string; ward: string; acuity: number };
const ASSIGN = flag("assign", "if-match");
const ASSIGN_GUARD = flag("assignGuard", "pending") === "pending";
const STEPS = flag("steps", "bed-then-admission");
const LIVE = flag("live", "newer-wins");
const RECONNECT = flag("reconnect", "resync");

function Board() {
  const [beds, setBeds] = useState<Bed[]>([]);
  const [queue, setQueue] = useState<Admission[]>([]);
  const [ward, setWard] = useState("All");
  const [picked, setPicked] = useState<Admission | null>(null);
  const [busy, setBusy] = useState<number[]>([]);
  const [live, setLive] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const mark = (id: number, on: boolean) => setBusy((b) => (on ? [...b, id] : b.filter((x) => x !== id)));
  const putBed = (b: Bed, push = false) =>
    setBeds((all) => all.map((x) => (x.id !== b.id ? x : push && LIVE === "newer-wins" && x.updatedAt && b.updatedAt && b.updatedAt < x.updatedAt ? x : b)));

  async function load() {
    try {
      const [bs, qs] = await Promise.all([api(`/api/beds?limit=40`), api(`/api/admissions?limit=20`)]);
      setBeds(itemsOf<Bed>(bs));
      setQueue(itemsOf<Admission>(qs));
    } catch (e) {
      setError(errText(e, "loading the bed board"));
    }
  }

  useEffect(() => {
    let everUp = false;
    const offBeds = liveTopic(
      "beds",
      (m) => {
        if (m.item && m.type === "updated") putBed(m.item as Bed, true);
      },
      (up) => {
        setLive(up);
        if (up && everUp && RECONNECT === "resync") void load();
        if (up) everUp = true;
      },
    );
    const offQueue = liveTopic("admissions", (m) => {
      if (m.type === "created" && m.item) setQueue((q) => (q.some((a) => a.id === m.item.id) ? q : [...q, m.item as Admission]));
      if (m.type === "deleted") setQueue((q) => q.filter((a) => a.id !== Number(m.id)));
    });
    void load();
    return () => {
      offBeds();
      offQueue();
    };
  }, []);

  async function assign(bed: Bed) {
    const who = picked;
    if (!who || (ASSIGN_GUARD && busy.includes(bed.id))) return;
    mark(bed.id, true);
    setError("");
    setNotice("");
    const placeBed = () => api<Bed>(`/api/beds/${bed.id}`, "PATCH", ASSIGN === "if-match" ? { status: "occupied", patient: who.name, version: bed.version } : { status: "occupied", patient: who.name });
    const closeAdmission = () => api(`/api/admissions/${who.id}`, "DELETE");
    try {
      if (STEPS === "admission-first") {
        await closeAdmission();
        setQueue((q) => q.filter((a) => a.id !== who.id));
        putBed(await placeBed());
      } else {
        putBed(await placeBed());
        await closeAdmission().catch(() => closeAdmission());
        setQueue((q) => q.filter((a) => a.id !== who.id));
      }
      setPicked(null);
      setNotice(`${who.name} placed in ${bed.bed} (${bed.ward}).`);
    } catch (e) {
      const cur = e instanceof HttpError && e.status === 409 ? (e.body?.current as Bed | undefined) : undefined;
      if (cur) putBed(cur);
      setError(cur ? `${bed.bed} was just taken (${cur.patient || cur.status}). Pick another bed.` : errText(e, `placing ${who.name}`));
    } finally {
      mark(bed.id, false);
    }
  }

  async function advance(bed: Bed, status: string, patient: string, done: string) {
    if (busy.includes(bed.id)) return;
    mark(bed.id, true);
    setError("");
    try {
      putBed(await api<Bed>(`/api/beds/${bed.id}`, "PATCH", { status, patient, version: bed.version }));
      setNotice(done);
    } catch (e) {
      const cur = e instanceof HttpError && e.status === 409 ? (e.body?.current as Bed | undefined) : undefined;
      if (cur) putBed(cur);
      setError(cur ? `${bed.bed} changed meanwhile.` : errText(e, `updating ${bed.bed}`));
    } finally {
      mark(bed.id, false);
    }
  }

  const shown = beds.filter((b) => ward === "All" || b.ward === ward);
  const free = beds.filter((b) => b.status === "available").length;
  return (
    <main class="beds">
      <h1>Bed board</h1>
      <p class="summary">
        {free} beds available · {queue.length} waiting · {live ? "live" : "reconnecting…"}
      </p>
      <nav class="wards">
        {["All", "Medical", "Surgical", "ICU"].map((w) => (
          <button key={w} type="button" class={ward === w ? "current" : ""} onClick={() => setWard(w)}>
            {w}
          </button>
        ))}
      </nav>
      {error ? <p role="alert">{error}</p> : notice ? <p class="notice">{notice}</p> : null}
      <h2>Waiting for a bed</h2>
      <ul class="admissions">
        {queue.map((a) => (
          <li key={a.id} class={`admission${picked?.id === a.id ? " picked" : ""}`}>
            {a.name} · {a.ward} · acuity {a.acuity}{" "}
            <button type="button" class="pick" onClick={() => setPicked(a)}>
              {picked?.id === a.id ? "Selected" : "Find bed"}
            </button>
          </li>
        ))}
      </ul>
      <ul class="board">
        {shown.map((b) => (
          <li key={b.id} class={`bed ${b.status}`}>
            {b.bed} · {b.ward} · {b.status}
            {b.patient ? ` · ${b.patient}` : ""}{" "}
            {b.status === "available" && picked ? (
              <button type="button" class="assign" disabled={ASSIGN_GUARD && busy.includes(b.id)} onClick={() => void assign(b)}>
                Place {picked.name}
              </button>
            ) : null}
            {b.status === "occupied" ? (
              <button type="button" class="discharge" disabled={busy.includes(b.id)} onClick={() => void advance(b, "cleaning", "", `${b.patient} discharged from ${b.bed}.`)}>
                Discharge
              </button>
            ) : null}
            {b.status === "cleaning" ? (
              <button type="button" class="cleaned" disabled={busy.includes(b.id)} onClick={() => void advance(b, "available", "", `${b.bed} is ready.`)}>
                Mark clean
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </main>
  );
}

render(<Board />, document.getElementById("app")!);
