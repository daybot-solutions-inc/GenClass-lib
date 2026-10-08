// Pet adoption site (Preact 10 + @preact/signals mirroring runtime atoms; fetch). Visitors page through adoptable pets
// with species/age filters, apply to adopt one (POST /applications) and then book a home visit on the application
// (versioned: shelter staff move applications along at the same time). Latent bugs by flag: page answers applied in
// arrival order (pageSeq=blind: page 2 replaces page 3), filter changes that keep the current page number
// (filterReset=keep-page: page 4 of a filter with one page shows nobody), application POSTs retried without an
// Idempotency-Key (applyKey=retry-blind: an application stored before a 5xx is filed twice) or not at all
// (applyKey=no-retry), a Submit button live while posting (applyGuard=none) and the visit saved by PUTting the whole
// application as first loaded (visitSave=put-stale: the staff's "reviewing" status is overwritten back to "received").
import { render } from "preact";
import { rt, flag } from "../_shared/genclass";
import { atomSignal } from "../_shared/preact-atom";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Pet = { id: number; name: string; species: string; age: string; status: string; shelter: string };
type App = { id: number; petId: number; petName: string; applicant: string; status: string; visit: string; version: number };
const PAGE_SEQ = flag("pageSeq", "latest");
const FILTER_RESET = flag("filterReset", "page-1");
const APPLY_KEY = flag("applyKey", "idempotency-key") as "idempotency-key" | "retry-blind" | "no-retry";
const APPLY_GUARD = flag("applyGuard", "pending") === "pending";
const VISIT_SAVE = flag("visitSave", "patch-if-match");
const PAGE = 6;

const pets = rt.atom("pets", { species: "all", age: "any", page: 1, items: [] as Pet[], total: 0, loading: true, error: "" });
const adopt = rt.atom("adopt", { petId: 0, petName: "", step: "none", applicant: "", appId: 0, version: 0, status: "", visit: "Sat 10:00", submitting: false, error: "", notice: "" });
type A = ReturnType<typeof adopt.get>;
const petsSig = atomSignal(pets);
const adoptSig = atomSignal(adopt);
const FRESH: A = adopt.get();

let seq = 0;
async function loadPets() {
  const my = ++seq;
  const { species, age, page } = pets.get();
  pets.update((p) => ({ ...p, loading: true, error: "" }));
  try {
    const qs = new URLSearchParams({ page: String(page), limit: String(PAGE) });
    if (species !== "all") qs.set("species", species);
    if (age !== "any") qs.set("age", age);
    const body = await api<{ data: Pet[]; meta: { total: number } }>(`/api/pets?${qs}`);
    if (PAGE_SEQ === "latest" && my !== seq) return;
    pets.update((p) => ({ ...p, items: itemsOf<Pet>(body), total: Number(body?.meta?.total ?? 0), loading: false }));
  } catch (e) {
    if (my === seq) pets.update((p) => ({ ...p, loading: false, error: errText(e, "loading pets") }));
  }
}
function setFilter(key: "species" | "age", value: string) {
  pets.update((p) => ({ ...p, [key]: value, page: FILTER_RESET === "page-1" ? 1 : p.page }));
  void loadPets();
}
function setPage(page: number) {
  pets.update((p) => ({ ...p, page }));
  void loadPets();
}

let keyN = 0;
async function submitApplication(e: Event) {
  e.preventDefault();
  const a = adopt.get();
  if (!a.applicant.trim()) return void adopt.update((x) => ({ ...x, error: "Please tell us your name." }));
  if (APPLY_GUARD && a.submitting) return;
  adopt.update((x) => ({ ...x, submitting: true, error: "", notice: "" }));
  const key = APPLY_KEY === "idempotency-key" ? `adopt-${a.petId}-${++keyN}` : "";
  const post = () => api<App>(`/api/applications`, "POST", { petId: a.petId, petName: a.petName, applicant: a.applicant.trim(), status: "received", visit: "" }, key ? { "Idempotency-Key": key } : {});
  try {
    let app: App;
    try {
      app = await post();
    } catch (err) {
      if (APPLY_KEY === "no-retry" || (err instanceof HttpError && err.status > 0 && err.status < 500)) throw err;
      app = await post();
    }
    adopt.update((x) => ({ ...x, appId: app.id, version: app.version, status: app.status, step: "visit", notice: `Application #${app.id} received for ${a.petName}.` }));
  } catch (err) {
    adopt.update((x) => ({ ...x, error: errText(err, "sending your application") }));
  } finally {
    adopt.update((x) => ({ ...x, submitting: false }));
  }
}

async function confirmVisit(e: Event) {
  e.preventDefault();
  const a = adopt.get();
  if (!a.appId || a.submitting) return;
  adopt.update((x) => ({ ...x, submitting: true, error: "", notice: "" }));
  try {
    let saved: App;
    if (VISIT_SAVE === "patch-if-match") {
      try {
        saved = await api<App>(`/api/applications/${a.appId}`, "PATCH", { visit: a.visit, version: a.version });
      } catch (err) {
        const cur = err instanceof HttpError && err.status === 409 ? (err.body?.current as App | undefined) : undefined;
        if (!cur) throw err;
        saved = await api<App>(`/api/applications/${a.appId}`, "PATCH", { visit: a.visit, version: cur.version });
      }
    } else saved = await api<App>(`/api/applications/${a.appId}`, "PUT", { petId: a.petId, petName: a.petName, applicant: a.applicant.trim(), status: a.status, visit: a.visit });
    adopt.update((x) => ({ ...x, version: saved.version, status: saved.status, step: "done", notice: `Home visit for ${saved.petName} booked: ${saved.visit} (application ${saved.status}).` }));
  } catch (err) {
    adopt.update((x) => ({ ...x, error: errText(err, "booking the visit") }));
  } finally {
    adopt.update((x) => ({ ...x, submitting: false }));
  }
}

function Panel() {
  const a = adoptSig.value;
  if (a.step === "none") return <aside className="panel muted">Pick a pet to start an application.</aside>;
  return (
    <aside className="panel">
      <h2>Adopting {a.petName}</h2>
      {a.error ? <p role="alert">{a.error}</p> : a.notice ? <p className="notice">{a.notice}</p> : null}
      {a.step === "form" ? (
        <form className="apply" onSubmit={(e) => void submitApplication(e)}>
          <input name="applicant" placeholder="Your full name" value={a.applicant} onInput={(e) => adopt.update((x) => ({ ...x, applicant: (e.target as HTMLInputElement).value }))} />
          <button type="submit" className="submit" disabled={APPLY_GUARD && a.submitting}>
            {a.submitting ? "Sending…" : "Submit application"}
          </button>
        </form>
      ) : a.step === "visit" ? (
        <form className="visit" onSubmit={(e) => void confirmVisit(e)}>
          <label>
            Home visit{" "}
            <select name="visit" value={a.visit} onChange={(e) => adopt.update((x) => ({ ...x, visit: (e.target as HTMLSelectElement).value }))}>
              {["Sat 10:00", "Sat 14:00", "Sun 11:00", "Mon 17:30"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={a.submitting}>
            {a.submitting ? "Booking…" : "Book visit"}
          </button>
        </form>
      ) : (
        <p className="done">All set — the {a.status} team will see you {a.visit}.</p>
      )}
    </aside>
  );
}

function App() {
  const p = petsSig.value;
  const pages = Math.max(1, Math.ceil(p.total / PAGE));
  return (
    <main className="adoption">
      <h1>Adopt a pet</h1>
      <div className="filters">
        <select name="species" value={p.species} onChange={(e) => setFilter("species", (e.target as HTMLSelectElement).value)}>
          {["all", "dog", "cat", "rabbit"].map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All animals" : `${s}s`}
            </option>
          ))}
        </select>{" "}
        <select name="age" value={p.age} onChange={(e) => setFilter("age", (e.target as HTMLSelectElement).value)}>
          {["any", "young", "adult", "senior"].map((s) => (
            <option key={s} value={s}>
              {s === "any" ? "Any age" : s}
            </option>
          ))}
        </select>
      </div>
      {p.error ? <p role="alert">{p.error}</p> : null}
      <p className="summary">{p.loading ? "Loading…" : `${p.total} pets · page ${p.page} of ${pages}`}</p>
      <ul className="pets">
        {p.items.map((pet) => (
          <li key={pet.id} className="pet">
            {pet.name} · {pet.species} · {pet.age} · {pet.shelter}{" "}
            {pet.status === "available" ? (
              <button type="button" className="adopt" onClick={() => adopt.set({ ...FRESH, petId: pet.id, petName: pet.name, step: "form" })}>
                Adopt {pet.name}
              </button>
            ) : (
              <em>adopted</em>
            )}
          </li>
        ))}
        {!p.loading && !p.items.length ? <li className="empty">No pets match on this page.</li> : null}
      </ul>
      <nav className="pages">
        {Array.from({ length: pages }, (_, i) => (
          <button key={i} type="button" className={p.page === i + 1 ? "current" : ""} onClick={() => setPage(i + 1)}>
            {i + 1}
          </button>
        ))}
      </nav>
      <Panel />
    </main>
  );
}

render(<App />, document.getElementById("app")!);
void loadPets();
setInterval(() => void loadPets(), 9000);
