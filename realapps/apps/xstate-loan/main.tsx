// Personal loan application wizard (React 19 + XState v5 machine read with @xstate/react useSelector; fetch). The
// machine owns the flow: applicant (draft saved with POST/PATCH) → documents (three uploads: POST /documents, then
// POST /documents/:id/scan; an external scanner verifies or rejects them, so the step polls) → review → submitting
// (POST /applications/:id/submit: relative, counts submissions) → status (polls for the underwriter's decision).
// Uploads run outside the machine and report back with events. The machine context is mirrored into a GenClass atom on
// every transition. Latent bugs by flag: a Submit button that stays live while submitting and a machine that accepts
// SUBMIT again there (submitGuard=none), submissions sent without an Idempotency-Key (submitKey=none: a re-entry or a
// retry submits twice), document POSTs retried without a key (docRetry=blind: a POST that committed before a 5xx is
// stored twice) or not at all (docRetry=none), a scan poller started with setInterval on entry and never cleared
// (scanPoll=leak: every visit adds one, and they keep running) and a decision checked once (decision=poll-once).
import { createRoot } from "react-dom/client";
import { assign, createActor, fromCallback, fromPromise, setup, type SnapshotFrom } from "xstate";
import { useSelector } from "@xstate/react";
import { rt, flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Kind = "id" | "paystub" | "bank";
type Doc = { id: number; applicationId: number; kind: Kind; file: string; status: string };
type App = { id: number; status: string; submissions: number };
interface Ctx {
  appId: number;
  name: string;
  income: string;
  amount: string;
  docs: Record<Kind, Doc | null>;
  uploading: Kind[];
  status: string;
  submitKey: string;
  error: string;
}
type Ev =
  | { type: "FIELD"; field: "name" | "income" | "amount"; value: string }
  | { type: "NEXT" }
  | { type: "BACK" }
  | { type: "DOC_START"; kind: Kind }
  | { type: "DOC_SAVED"; kind: Kind; doc: Doc }
  | { type: "DOC_FAILED"; kind: Kind; error: string }
  | { type: "DOCS"; docs: Doc[] }
  | { type: "SUBMIT" }
  | { type: "DECISION"; status: string }
  | { type: "NEW" };

const SUBMIT_GUARD = flag("submitGuard", "state");
const SUBMIT_KEY = flag("submitKey", "per-application");
const DOC_RETRY = flag("docRetry", "idempotency-key") as "idempotency-key" | "blind" | "none";
const SCAN_POLL = flag("scanPoll", "invoke");
const DECISION = flag("decision", "poll-until-final");
const KINDS: Kind[] = ["id", "paystub", "bank"];
const LABEL: Record<Kind, string> = { id: "photo ID", paystub: "latest pay stub", bank: "bank statement" };
const FILES: Record<Kind, string> = { id: "passport.jpg", paystub: "paystub-march.pdf", bank: "statement-q1.pdf" };

const fresh = (): Ctx => ({ appId: 0, name: "Jordan Lee", income: "64000", amount: "15000", docs: { id: null, paystub: null, bank: null }, uploading: [], status: "", submitKey: "", error: "" });
const allDocs = (c: Ctx) => KINDS.every((k) => c.docs[k] && c.docs[k]!.id > 0 && c.docs[k]!.status !== "rejected");
const latestPerKind = (docs: Doc[], prev: Ctx["docs"]): Ctx["docs"] => {
  const out = { ...prev };
  for (const k of KINDS) {
    const mine = docs.filter((d) => d.kind === k);
    if (mine.length) out[k] = mine[mine.length - 1]!;
  }
  return out;
};
let keyN = 0;

const machine = setup({
  types: { context: {} as Ctx, events: {} as Ev },
  actors: {
    saveDraft: fromPromise(async ({ input }: { input: Ctx }) => {
      const body = { name: input.name.trim(), income: Number(input.income), amount: Number(input.amount) };
      return input.appId ? api<App>(`/api/applications/${input.appId}`, "PATCH", body) : api<App>(`/api/applications`, "POST", { ...body, status: "draft", submissions: 0 });
    }),
    scanPoller: fromCallback<Ev, number>(({ sendBack, input }) => {
      const iv = setInterval(() => void api(`/api/documents?applicationId=${input}&limit=30`).then((b) => sendBack({ type: "DOCS", docs: itemsOf<Doc>(b) }), () => undefined), 2000);
      return () => clearInterval(iv);
    }),
    submit: fromPromise(async ({ input }: { input: { appId: number; key: string } }) => api<App>(`/api/applications/${input.appId}/submit`, "POST", {}, input.key ? { "Idempotency-Key": input.key } : {})),
    decisionPoller: fromCallback<Ev, number>(({ sendBack, input }) => {
      let stop = false;
      let timer: ReturnType<typeof setTimeout>;
      const tick = () =>
        void api<App>(`/api/applications/${input}`)
          .then((a) => {
            sendBack({ type: "DECISION", status: a.status });
            return a.status === "submitted";
          }, () => true)
          .then((again) => {
            if (again && !stop && DECISION === "poll-until-final") timer = setTimeout(tick, 2500);
          });
      timer = setTimeout(tick, 1500);
      return () => {
        stop = true;
        clearTimeout(timer);
      };
    }),
  },
  actions: {
    leakyPoller: ({ context }) => {
      const id = context.appId;
      setInterval(() => void api(`/api/documents?applicationId=${id}&limit=30`).then((b) => actor.send({ type: "DOCS", docs: itemsOf<Doc>(b) }), () => undefined), 2000);
    },
  },
}).createMachine({
  id: "loan",
  initial: "applicant",
  context: fresh(),
  on: {
    DOC_START: { actions: assign(({ context, event }) => ({ uploading: [...context.uploading, event.kind], error: "" })) },
    DOC_SAVED: { actions: assign(({ context, event }) => (event.doc.applicationId !== context.appId ? {} : { docs: { ...context.docs, [event.kind]: event.doc }, uploading: context.uploading.filter((k) => k !== event.kind) })) },
    DOC_FAILED: { actions: assign(({ context, event }) => ({ uploading: context.uploading.filter((k) => k !== event.kind), error: event.error })) },
    DOCS: { actions: assign(({ context, event }) => ({ docs: latestPerKind(event.docs.filter((d) => d.applicationId === context.appId), context.docs) })) },
  },
  states: {
    applicant: {
      on: {
        FIELD: { actions: assign(({ event }) => ({ [event.field]: event.value }) as Partial<Ctx>) },
        NEXT: { target: "saving", guard: ({ context }) => context.name.trim().length > 1 && Number(context.income) > 0 },
      },
    },
    saving: {
      invoke: {
        src: "saveDraft",
        input: ({ context }) => context,
        onDone: { target: "documents", actions: assign(({ event }) => ({ appId: event.output.id, error: "" })) },
        onError: { target: "applicant", actions: assign(({ event }) => ({ error: errText(event.error, "saving your details") })) },
      },
    },
    documents: {
      ...(SCAN_POLL === "invoke" ? { invoke: { src: "scanPoller", input: ({ context }: { context: Ctx }) => context.appId } } : { entry: "leakyPoller" }),
      on: {
        NEXT: { target: "review", guard: ({ context }) => allDocs(context) },
        BACK: { target: "applicant" },
      },
    },
    review: {
      entry: assign(({ context }) => (SUBMIT_KEY === "per-application" && !context.submitKey ? { submitKey: `submit-${context.appId}-${++keyN}` } : {})),
      on: { SUBMIT: { target: "submitting", actions: assign({ error: "" }) }, BACK: { target: "documents" } },
    },
    submitting: {
      invoke: {
        src: "submit",
        input: ({ context }) => ({ appId: context.appId, key: context.submitKey }),
        onDone: { target: "status", actions: assign(({ event }) => ({ status: event.output.status })) },
        onError: { target: "review", actions: assign(({ event }) => ({ error: errText(event.error, "submitting the application") })) },
      },
      on: SUBMIT_GUARD === "none" ? { SUBMIT: { target: "submitting", reenter: true } } : {},
    },
    status: {
      invoke: { src: "decisionPoller", input: ({ context }) => context.appId },
      on: {
        DECISION: { actions: assign(({ event }) => ({ status: event.status })) },
        NEW: { target: "applicant", actions: assign(() => fresh()) },
      },
    },
  },
});

const stepOf = (s: SnapshotFrom<typeof machine>) => String(s.value);
const actor = createActor(machine);
const loan = rt.atom("loan", { step: "applicant", ...actor.getSnapshot().context, busy: false });
actor.subscribe((s) => loan.set({ step: stepOf(s), ...s.context, busy: s.context.uploading.length > 0 || ["saving", "submitting"].includes(stepOf(s)) }));
actor.start();

let uploadN = 0;
async function startUpload(kind: Kind) {
  const c = actor.getSnapshot().context;
  if (!c.appId || c.uploading.includes(kind)) return;
  actor.send({ type: "DOC_START", kind });
  const body = { applicationId: c.appId, kind, file: FILES[kind], status: "uploaded" };
  const key = DOC_RETRY === "idempotency-key" ? `doc-${c.appId}-${kind}-${++uploadN}` : "";
  const post = () => api<Doc>(`/api/documents`, "POST", body, key ? { "Idempotency-Key": key } : {});
  try {
    let doc: Doc;
    try {
      doc = await post();
    } catch (e) {
      if (DOC_RETRY === "none" || (e instanceof HttpError && e.status > 0 && e.status < 500)) throw e;
      doc = await post();
    }
    const scanning = await api<Doc>(`/api/documents/${doc.id}/scan`, "POST");
    actor.send({ type: "DOC_SAVED", kind, doc: scanning });
  } catch (e) {
    actor.send({ type: "DOC_FAILED", kind, error: errText(e, `uploading your ${LABEL[kind]}`) });
  }
}

// ------------------------------------------------------------------------------------------- view
const STATUS: Record<string, string> = { submitted: "Submitted — an underwriter is reviewing it.", approved: "Approved! We'll email the agreement.", "needs-info": "We need a little more information.", "": "…" };
function Wizard() {
  const snap = useSelector(actor, (s) => s);
  const c = snap.context;
  const step = stepOf(snap);
  const send = (e: Ev) => actor.send(e);
  // the guided primary action on the documents step uploads the next missing document
  const nextDoc = KINDS.find((k) => !c.uploading.includes(k) && (!c.docs[k] || c.docs[k]!.status === "rejected"));
  const primary: Record<string, { label: string; ev: Ev; ok: boolean }> = {
    applicant: { label: "Continue", ev: { type: "NEXT" }, ok: true },
    saving: { label: "Saving…", ev: { type: "NEXT" }, ok: false },
    documents: nextDoc ? { label: `Upload your ${LABEL[nextDoc]}`, ev: { type: "NEXT" }, ok: true } : { label: allDocs(c) ? "Review application" : "Uploading…", ev: { type: "NEXT" }, ok: allDocs(c) },
    review: { label: "Submit application", ev: { type: "SUBMIT" }, ok: true },
    submitting: { label: "Submitting…", ev: { type: "SUBMIT" }, ok: SUBMIT_GUARD === "none" },
    status: { label: "Start another application", ev: { type: "NEW" }, ok: true },
  };
  const p = primary[step]!;
  const go = () => (step === "documents" && nextDoc ? void startUpload(nextDoc) : send(p.ev));
  return (
    <main className="loan">
      <h1>Personal loan</h1>
      <ol className="steps">
        {["applicant", "documents", "review", "status"].map((s) => (
          <li key={s} className={step === s || (s === "review" && step === "submitting") || (s === "applicant" && step === "saving") ? "current" : ""}>
            {s}
          </li>
        ))}
      </ol>
      {c.error ? <p role="alert">{c.error}</p> : null}
      {step === "applicant" || step === "saving" ? (
        <form className="applicant" onSubmit={(e) => e.preventDefault()}>
          <label>
            Full name <input name="fullname" value={c.name} onChange={(e) => send({ type: "FIELD", field: "name", value: e.target.value })} />
          </label>
          <label>
            Yearly income <input name="income" inputMode="numeric" value={c.income} onChange={(e) => send({ type: "FIELD", field: "income", value: e.target.value })} />
          </label>
          <label>
            Amount{" "}
            <select name="amount" value={c.amount} onChange={(e) => send({ type: "FIELD", field: "amount", value: e.target.value })}>
              {["5000", "15000", "30000"].map((a) => (
                <option key={a} value={a}>
                  ${a}
                </option>
              ))}
            </select>
          </label>
        </form>
      ) : null}
      {step === "documents" ? (
        <ul className="docs">
          {KINDS.map((k) => {
            const d = c.docs[k];
            const busy = c.uploading.includes(k);
            return (
              <li key={k} className={`doc ${d?.status ?? "missing"}`}>
                {LABEL[k]}: {busy ? "uploading…" : d ? `${d.file} · ${d.status}` : "not uploaded"}{" "}
                {!busy && (!d || d.status === "rejected") ? (
                  <button type="button" className="upload" onClick={() => void startUpload(k)}>
                    {d ? "Upload again" : "Upload"}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {step === "review" || step === "submitting" ? (
        <section className="review">
          <p>
            {c.name} · income ${c.income} · borrowing ${c.amount}
          </p>
          <p>Documents: {KINDS.map((k) => `${LABEL[k]} (${c.docs[k]?.status ?? "missing"})`).join(", ")}</p>
        </section>
      ) : null}
      {step === "status" ? (
        <section className="status">
          <p>Application #{c.appId}</p>
          <p className="decision">{STATUS[c.status] ?? c.status}</p>
        </section>
      ) : null}
      <footer>
        {step === "documents" || step === "review" ? (
          <button type="button" className="back" onClick={() => send({ type: "BACK" })}>
            Back
          </button>
        ) : null}{" "}
        <button type="button" className="primary" disabled={!p.ok} onClick={go}>
          {p.label}
        </button>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<Wizard />);
