// Lab sample reception (React 19 + MobX 6 observable store registered with rt.guard; mobx-react-lite observers;
// fetch). A technician scans barcodes (lookup + PATCH to "received"), racks samples into the next free slot (slot is
// unique server-side), and enters/verifies results (versioned PATCH); the analyser moves received samples along.
// Latent bugs by flag: scans processed in parallel (scanMode=parallel: the "last scanned" panel shows whichever
// lookup finished last), rack buttons live while racking (slotGuard=none: the second click takes another slot or
// 409s), status counts stored and adjusted only by our own writes (counts=stored) and result verification without
// the version (verify=force: overwrites a value the analyser just posted).
import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import { observable, runInAction, reaction, toJS, comparer } from "mobx";
import { observer } from "mobx-react-lite";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Sample = { id: number; barcode: string; patient: string; test: string; status: string; slot: string; value: number | null; version: number };
const SCAN_MODE = flag("scanMode", "queue");
const SLOT_GUARD = flag("slotGuard", "pending") === "pending";
const COUNTS = flag("counts", "computed");
const VERIFY = flag("verify", "if-match");

const store = observable({ samples: [] as Sample[], counts: {} as Record<string, number>, last: "", drafts: {} as Record<number, string>, busy: [] as number[], error: "", notice: "" });
const lab = rt.guard("lab", {
  get: () => toJS(store),
  set: (v: any) => runInAction(() => Object.assign(store, v)),
  subscribe: (fn) => reaction(() => toJS(store), () => fn(), { equals: comparer.structural }),
});
type L = ReturnType<typeof toJS<typeof store>>;
const countOf = (xs: Sample[]) => xs.reduce<Record<string, number>>((a, x) => ((a[x.status] = (a[x.status] ?? 0) + 1), a), {});
function put(s: L, x: Sample): L {
  const before = s.samples.find((y) => y.id === x.id);
  const samples = before ? s.samples.map((y) => (y.id === x.id ? x : y)) : [...s.samples, x];
  let counts = countOf(samples);
  if (COUNTS === "stored") {
    counts = { ...s.counts };
    if (before) counts[before.status] = (counts[before.status] ?? 1) - 1;
    counts[x.status] = (counts[x.status] ?? 0) + 1;
  }
  return { ...s, samples, counts };
}
const busy = (id: number, on: boolean) => lab.update((s: L) => ({ ...s, busy: on ? [...s.busy, id] : s.busy.filter((b) => b !== id) }));

async function load(background = false) {
  try {
    const samples = itemsOf<Sample>(await api(`/api/samples?limit=40`));
    lab.update((s: L) => {
      const mine = new Map(s.samples.map((x) => [x.id, x]));
      const merged = samples.map((x) => (s.busy.includes(x.id) ? (mine.get(x.id) ?? x) : x));
      return { ...s, samples: merged, counts: COUNTS === "computed" || !background ? countOf(merged) : s.counts };
    });
  } catch (e) {
    if (!background) lab.update((s: L) => ({ ...s, error: errText(e, "loading samples") }));
  }
}

async function receive(barcode: string) {
  const code = barcode.trim().toUpperCase();
  if (!code) return;
  try {
    const [hit] = itemsOf<Sample>(await api(`/api/samples?barcode=${encodeURIComponent(code)}`));
    if (!hit) return lab.update((s: L) => ({ ...s, last: code, error: `${code} is not on today's manifest.` }));
    const saved = hit.status === "pending" ? await api<Sample>(`/api/samples/${hit.id}`, "PATCH", { status: "received", version: hit.version }) : hit;
    lab.update((s: L) => ({ ...put(s, saved), last: saved.barcode, notice: `${saved.barcode} (${saved.test}) ${hit.status === "pending" ? "received" : `already ${saved.status}`}.`, error: "" }));
  } catch (e) {
    lab.update((s: L) => ({ ...s, last: code, error: errText(e, `receiving ${code}`) }));
  }
}
let scanQueue: Promise<void> = Promise.resolve();
const scan = (code: string) => (SCAN_MODE === "queue" ? (scanQueue = scanQueue.then(() => receive(code))) : void receive(code));

async function rack(x: Sample) {
  if (SLOT_GUARD && store.busy.includes(x.id)) return;
  busy(x.id, true);
  const used = new Set(store.samples.map((y) => y.slot).filter(Boolean));
  let n = 0;
  while (used.has(`R2-${n}`)) n++;
  try {
    const saved = await api<Sample>(`/api/samples/${x.id}`, "PATCH", { slot: `R2-${n}` });
    lab.update((s: L) => ({ ...put(s, saved), notice: `${saved.barcode} racked at ${saved.slot}.`, error: "" }));
  } catch (e) {
    lab.update((s: L) => ({ ...s, error: e instanceof HttpError && e.status === 409 ? `Slot R2-${n} is already taken; try again.` : errText(e, "racking the sample") }));
    if (e instanceof HttpError && e.status === 409) void load(true);
  } finally {
    busy(x.id, false);
  }
}

async function verify(x: Sample) {
  const raw = store.drafts[x.id];
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value)) return lab.update((s: L) => ({ ...s, error: `Enter a numeric result for ${x.barcode}.` }));
  if (store.busy.includes(x.id)) return;
  busy(x.id, true);
  try {
    const saved = await api<Sample>(`/api/samples/${x.id}`, "PATCH", VERIFY === "if-match" ? { value, status: "resulted", version: x.version } : { value, status: "resulted" });
    lab.update((s: L) => {
      const drafts = { ...s.drafts };
      delete drafts[x.id];
      return { ...put(s, saved), drafts, notice: `${saved.barcode}: ${saved.value} verified.`, error: "" };
    });
  } catch (e) {
    const cur = e instanceof HttpError && e.status === 409 ? (e.body?.current as Sample | undefined) : undefined;
    lab.update((s: L) => ({ ...(cur ? put(s, cur) : s), error: cur ? `${x.barcode} was updated by the analyser (${cur.status}${cur.value != null ? `, ${cur.value}` : ""}).` : errText(e, "verifying the result") }));
  } finally {
    busy(x.id, false);
  }
}

const Reception = observer(function Reception() {
  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(true), 5000);
    return () => clearInterval(iv);
  }, []);
  return (
    <div className="lab">
      <h1>Sample reception</h1>
      <form className="scan" onSubmit={(e) => { e.preventDefault(); const el = (e.currentTarget.elements.namedItem("barcode") as HTMLInputElement); scan(el.value); el.value = ""; }}>
        <label>Scan barcode <input name="barcode" autoComplete="off" /></label> <button type="submit">Receive</button>
      </form>
      <p className="counts">{["pending", "received", "processing", "resulted"].map((k) => `${k}: ${store.counts[k] ?? 0}`).join(" · ")}</p>
      {store.last && <p className="last">Last scanned: {store.last}</p>}
      {store.error ? <p role="alert">{store.error}</p> : store.notice ? <p className="notice">{store.notice}</p> : null}
      <ul className="samples">
        {store.samples.filter((x) => x.status !== "pending").map((x) => (
          <li key={x.id} className={`sample ${x.status}`}>
            {x.barcode} · {x.patient} · {x.test} · {x.status} {x.slot && `· ${x.slot}`} {x.value != null && `· ${x.value}`}{" "}
            {x.status === "received" && !x.slot.startsWith("R2") && <button className="rack" disabled={SLOT_GUARD && store.busy.includes(x.id)} onClick={() => void rack(x)}>Rack</button>}
            {(x.status === "received" || x.status === "processing") && (
              <>
                <input className="value" inputMode="decimal" value={store.drafts[x.id] ?? ""} onChange={(e) => runInAction(() => (store.drafts[x.id] = e.target.value))} />{" "}
                <button className="verify" disabled={store.busy.includes(x.id)} onClick={() => void verify(x)}>Verify</button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
});

createRoot(document.getElementById("app")!).render(<Reception />);
