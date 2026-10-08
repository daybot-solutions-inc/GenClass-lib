// Drone flight authorization (Solid 1.9 + solid-js/html; XState v5: a planner machine run with createActor that spawns
// one child machine per authorization; their snapshots are mirrored into a GenClass atom that Solid reads through a
// signal; fetch). The pilot plans a flight: a maximum altitude (zones whose ceiling allows it load with GET
// /zones?ceiling__gte=<altitude>), a time window and a zone; picking a zone runs an airspace check (GET
// /notams?zone=..&active=true; an active restriction below the altitude blocks the flight, advisories are shown).
// Requesting files POST /authorizations (retried once after a 5xx) and spawns an authorization actor: pending (polls
// the request until controllers approve or deny it; can be withdrawn) → approved → start (versioned PATCH
// status=active: an authorization revoked meanwhile answers 409) → flying → land (PATCH status=completed). One drone
// flies at a time. Latent bugs by flag: the airspace check fired outside the machine and accepted whenever it lands
// (check=race: the answer for the previous zone or altitude is shown — and trusted — for the current one), a Request
// button the planner still accepts while requesting (requestGuard=none: the same flight is filed twice), approval
// pollers started with setInterval and never cleared (approvalPoll=leak: they keep polling every request ever made,
// and a late poll answer overwrites a fresher authorization, so landing then conflicts), a start sent without the
// version (start=force: a revoked authorization is flown anyway) and the request retried without an Idempotency-Key
// (requestRetry=blind: a request that committed before its 5xx is filed twice).
import html from "solid-js/html";
import { render } from "solid-js/web";
import { For, Show } from "solid-js";
import { assign, createActor, enqueueActions, fromCallback, fromPromise, setup, type AnyActorRef } from "xstate";
import { rt, flag } from "../_shared/genclass";
import { atomSignal } from "../_shared/solid-atom";
import { api, itemsOf, errText, HttpError } from "../_shared/w3-http";

type Zone = { id: number; name: string; airspace: string; ceiling: number };
type Notam = { id: number; zone: number; text: string; floor: number; kind: "restriction" | "advisory"; active: boolean };
type Check = { for: number; altitude: number; clear: boolean; notams: Notam[] };
type Auth = { id: number; zoneId: number; zone: string; altitude: number; window: string; status: string; reason?: string; version: number };
type Row = Auth & { phase: string; error: string };

const CHECK = flag("check", "cancel-on-change");
const REQUEST_GUARD = flag("requestGuard", "state");
const APPROVAL_POLL = flag("approvalPoll", "invoke");
const START = flag("start", "if-match");
const REQUEST_RETRY = flag("requestRetry", "idempotency-key");
const WINDOWS = ["Morning 09–10", "Midday 12–13", "Evening 16–17"];
const POLL_MS = 1500;
const OPEN = ["pending", "withdrawing", "approved", "starting", "flying", "landing"];

async function checkAirspace(zoneId: number, altitude: number, signal?: AbortSignal): Promise<Check> {
  const notams = itemsOf<Notam>(await api(`/api/notams?zone=${zoneId}&active=true&limit=20`, "GET", undefined, {}, signal)).filter((n) => n.floor <= altitude);
  return { for: zoneId, altitude, clear: !notams.some((n) => n.kind === "restriction"), notams };
}
const pollAuth = (id: number, send: (e: { type: "STATUS"; auth: Auth }) => void) => void api<Auth>(`/api/authorizations/${id}`).then((auth) => send({ type: "STATUS", auth }), () => undefined);
const conflict = (e: unknown): Auth | undefined => (e instanceof HttpError && e.status === 409 ? (e.body?.current as Auth | undefined) : undefined);

// ------------------------------------------------------------------------------------- one authorization
type AuthEv = { type: "STATUS"; auth: Auth } | { type: "START" } | { type: "END" } | { type: "WITHDRAW" };
const authMachine = setup({
  types: { context: {} as { auth: Auth; error: string }, events: {} as AuthEv, input: {} as Auth },
  actors: {
    approvalPoll: fromCallback<AuthEv, number>(({ sendBack, input }) => {
      const iv = setInterval(() => pollAuth(input, sendBack), POLL_MS);
      return () => clearInterval(iv);
    }),
    patch: fromPromise(({ input }: { input: { auth: Auth; status: string; versioned: boolean } }) =>
      api<Auth>(`/api/authorizations/${input.auth.id}`, "PATCH", { status: input.status, ...(input.versioned ? { version: input.auth.version } : {}) }),
    ),
  },
  actions: {
    leakyPoll: ({ context, self }) => {
      const id = context.auth.id;
      setInterval(() => pollAuth(id, (e) => self.send(e)), POLL_MS);
    },
  },
}).createMachine({
  id: "auth",
  context: ({ input }) => ({ auth: input, error: "" }),
  initial: "route",
  // a poller that outlives the pending state still reports: its answer replaces the authorization
  on: APPROVAL_POLL === "leak" ? { STATUS: { actions: assign(({ event }) => ({ auth: event.auth })) } } : {},
  states: {
    route: {
      always: [
        { guard: ({ context }) => context.auth.status === "pending", target: "pending" },
        { guard: ({ context }) => context.auth.status === "approved", target: "approved" },
        { guard: ({ context }) => context.auth.status === "active", target: "flying" },
        { target: "closed" },
      ],
    },
    pending: {
      ...(APPROVAL_POLL === "invoke" ? { invoke: { src: "approvalPoll", input: ({ context }: { context: { auth: Auth } }) => context.auth.id } } : { entry: "leakyPoll" }),
      on: {
        STATUS: [
          { guard: ({ event }) => event.auth.status === "approved", target: "approved", actions: assign(({ event }) => ({ auth: event.auth })) },
          { guard: ({ event }) => event.auth.status !== "pending", target: "closed", actions: assign(({ event }) => ({ auth: event.auth })) },
        ],
        WITHDRAW: { target: "withdrawing", actions: assign({ error: "" }) },
      },
    },
    withdrawing: {
      invoke: {
        src: "patch",
        input: ({ context }) => ({ auth: context.auth, status: "withdrawn", versioned: true }),
        onDone: { target: "closed", actions: assign(({ event }) => ({ auth: event.output })) },
        onError: [
          { guard: ({ event }) => !!conflict(event.error), target: "route", actions: assign(({ event }) => ({ auth: conflict(event.error)!, error: `Already ${conflict(event.error)!.status} — nothing to withdraw.` })) },
          { target: "pending", actions: assign(({ event }) => ({ error: errText(event.error, "withdrawing the request") })) },
        ],
      },
    },
    approved: { on: { START: { target: "starting", guard: ({ context }) => !flyingOther(context.auth.id), actions: assign({ error: "" }) } } },
    starting: {
      invoke: {
        src: "patch",
        input: ({ context }) => ({ auth: context.auth, status: "active", versioned: START === "if-match" }),
        onDone: { target: "flying", actions: assign(({ event }) => ({ auth: event.output })) },
        onError: [
          { guard: ({ event }) => !!conflict(event.error), target: "closed", actions: assign(({ event }) => { const cur = conflict(event.error)!; return { auth: cur, error: `Not cleared to fly: ${cur.status}${cur.reason ? ` (${cur.reason})` : ""}.` }; }) },
          { target: "approved", actions: assign(({ event }) => ({ error: errText(event.error, "starting the flight") })) },
        ],
      },
    },
    flying: { on: { END: { target: "landing", actions: assign({ error: "" }) } } },
    landing: {
      invoke: {
        src: "patch",
        input: ({ context }) => ({ auth: context.auth, status: "completed", versioned: true }),
        onDone: { target: "closed", actions: assign(({ event }) => ({ auth: event.output })) },
        onError: { target: "flying", actions: assign(({ event }) => ({ error: errText(event.error, "logging the landing") })) },
      },
    },
    closed: {},
  },
});

// ------------------------------------------------------------------------------------------- planner
interface Ctx {
  altitude: number;
  window: string;
  zones: Zone[];
  zoneId: number;
  check: Check | null;
  ids: number[];
  reqKey: string;
  error: string;
  notice: string;
}
type Ev =
  | { type: "ALTITUDE"; altitude: number }
  | { type: "WINDOW"; window: string }
  | { type: "ZONE"; zoneId: number }
  | { type: "CHECKED"; check: Check }
  | { type: "CHECK_FAILED"; error: string }
  | { type: "REQUEST" }
  | { type: "LOADED"; auths: Auth[] };
let keyN = 0;
const newKey = () => (REQUEST_RETRY === "idempotency-key" ? `auth-${++keyN}` : "");
const rows = (): Row[] => (permit ? permit.get().auths : []);
const flyingOther = (id: number) => rows().some((a) => a.id !== id && ["starting", "flying", "landing"].includes(a.phase));
const requested = (c: Ctx) => rows().some((a) => OPEN.includes(a.phase) && a.zoneId === c.zoneId && a.altitude === c.altitude && a.window === c.window);
const spawnAuths = (auths: Auth[]) =>
  enqueueActions(({ enqueue }) => {
    for (const a of auths) enqueue.spawnChild(authMachine, { id: `auth-${a.id}`, input: a });
  });

const machine = setup({
  types: { context: {} as Ctx, events: {} as Ev },
  actors: {
    loadZones: fromPromise(async ({ input }: { input: number }) => itemsOf<Zone>(await api(`/api/zones?ceiling__gte=${input}&sort=name&limit=20`))),
    check: fromPromise(({ input, signal }: { input: { zoneId: number; altitude: number }; signal: AbortSignal }) => checkAirspace(input.zoneId, input.altitude, signal)),
    request: fromPromise(async ({ input }: { input: Ctx }) => {
      const z = input.zones.find((x) => x.id === input.zoneId)!;
      const body = { zoneId: z.id, zone: z.name, altitude: input.altitude, window: input.window, pilot: "you", status: "pending" };
      const post = () => api<Auth>(`/api/authorizations`, "POST", body, input.reqKey ? { "Idempotency-Key": input.reqKey } : {});
      return post().catch((e) => (e instanceof HttpError && e.status > 0 && e.status < 500 ? Promise.reject(e) : post()));
    }),
  },
  actions: {
    checkOutside: ({ context }) =>
      void checkAirspace(context.zoneId, context.altitude).then(
        (check) => actor.send({ type: "CHECKED", check }),
        (e) => actor.send({ type: "CHECK_FAILED", error: errText(e, "checking the airspace") }),
      ),
  },
}).createMachine({
  id: "drone",
  initial: "planning",
  context: { altitude: 200, window: WINDOWS[1]!, zones: [], zoneId: 0, check: null, ids: [], reqKey: newKey(), error: "", notice: "" },
  on: {
    LOADED: { actions: [({ event }) => event, assign(({ context, event }) => ({ ids: [...context.ids, ...event.auths.map((a) => a.id).filter((id) => !context.ids.includes(id))] }))] },
  },
  states: {
    planning: {
      initial: "loadingZones",
      states: {
        loadingZones: {
          invoke: {
            src: "loadZones",
            input: ({ context }) => context.altitude,
            onDone: [
              { guard: ({ context, event }) => event.output.some((z: Zone) => z.id === context.zoneId), target: "checking", actions: assign(({ event }) => ({ zones: event.output })) },
              { target: "idle", actions: assign(({ event }) => ({ zones: event.output, zoneId: 0, check: null })) },
            ],
            onError: { target: "idle", actions: assign(({ event }) => ({ error: errText(event.error, "loading flight zones") })) },
          },
        },
        idle: {},
        checking:
          CHECK === "cancel-on-change"
            ? {
                invoke: {
                  src: "check",
                  input: ({ context }: { context: Ctx }) => ({ zoneId: context.zoneId, altitude: context.altitude }),
                  onDone: [
                    { guard: ({ event }) => event.output.clear, target: "clear", actions: assign(({ event }) => ({ check: event.output })) },
                    { target: "blocked", actions: assign(({ event }) => ({ check: event.output })) },
                  ],
                  onError: { target: "idle", actions: assign(({ event }) => ({ error: errText(event.error, "checking the airspace") })) },
                },
              }
            : {
                entry: "checkOutside",
                on: {
                  CHECKED: [
                    { guard: ({ event }) => event.check.clear, target: "clear", actions: assign(({ event }) => ({ check: event.check })) },
                    { target: "blocked", actions: assign(({ event }) => ({ check: event.check })) },
                  ],
                  CHECK_FAILED: { target: "idle", actions: assign(({ event }) => ({ error: event.error })) },
                },
              },
        clear: { on: { REQUEST: { target: "#drone.requesting", guard: ({ context }) => !requested(context), actions: assign({ error: "", notice: "" }) } } },
        blocked: {},
      },
      on: {
        ALTITUDE: { target: ".loadingZones", actions: assign(({ event }) => ({ altitude: event.altitude, check: null, reqKey: newKey(), error: "", notice: "" })) },
        WINDOW: { actions: assign(({ event }) => ({ window: event.window, reqKey: newKey(), notice: "" })) },
        ZONE: { target: ".checking", actions: assign(({ event }) => ({ zoneId: event.zoneId, check: null, reqKey: newKey(), error: "", notice: "" })) },
      },
    },
    requesting: {
      invoke: {
        src: "request",
        input: ({ context }) => context,
        onDone: {
          target: "#drone.planning.clear",
          actions: [
            enqueueActions(({ enqueue, event }) => enqueue.spawnChild(authMachine, { id: `auth-${event.output.id}`, input: event.output })),
            assign(({ context, event }) => ({ ids: [event.output.id, ...context.ids.filter((id) => id !== event.output.id)], reqKey: newKey(), notice: `Request #${event.output.id} filed — waiting for approval.` })),
          ],
        },
        onError: { target: "#drone.planning.clear", actions: assign(({ event }) => ({ error: errText(event.error, "requesting authorization") })) },
      },
      on: REQUEST_GUARD === "none" ? { REQUEST: { target: "requesting", reenter: true } } : {},
    },
  },
});

const actor = createActor(machine);
const permit = rt.atom("permit", { step: "planning", sub: "loadingZones", ...actor.getSnapshot().context, auths: [] as Row[], busy: false });
const watched = new Set<string>();
function mirror() {
  const s = actor.getSnapshot();
  const v = s.value as string | Record<string, string>;
  const step = typeof v === "string" ? v : Object.keys(v)[0]!;
  const kids = s.children as Record<string, AnyActorRef | undefined>;
  const auths: Row[] = [];
  for (const id of s.context.ids) {
    const ref = kids[`auth-${id}`];
    if (!ref) continue;
    if (!watched.has(ref.id)) {
      watched.add(ref.id);
      ref.subscribe(mirror);
    }
    const c = ref.getSnapshot();
    auths.push({ ...c.context.auth, phase: String(c.value), error: c.context.error });
  }
  permit.set({ step, sub: typeof v === "string" ? "" : String(v[step]), ...s.context, auths, busy: step === "requesting" || auths.some((a) => ["withdrawing", "starting", "landing"].includes(a.phase)) });
}
actor.subscribe(mirror);
actor.start();
mirror();
void api(`/api/authorizations?pilot=you&sort=-createdAt&limit=6`).then(
  (b) => {
    const auths = itemsOf<Auth>(b).filter((a) => !permit.get().ids.includes(a.id));
    actor.send({ type: "LOADED", auths });
  },
  () => undefined,
);

// ------------------------------------------------------------------------------------------- view
const child = (id: number) => (actor.getSnapshot().children as Record<string, AnyActorRef | undefined>)[`auth-${id}`];
const STATUS: Record<string, string> = { pending: "waiting for approval", withdrawing: "withdrawing…", approved: "approved", starting: "taking off…", flying: "in the air", landing: "logging…" };
function App() {
  const p = atomSignal(permit);
  const planning = () => p().step === "planning";
  const zone = () => p().zones.find((z) => z.id === p().zoneId);
  const flying = () => p().auths.some((a) => ["starting", "flying", "landing"].includes(a.phase));
  const checkText = () => {
    const s = p();
    if (!s.zoneId) return "Pick a zone to check the airspace.";
    if (s.sub === "checking") return `Checking airspace over ${zone()?.name ?? "the zone"}…`;
    if (!s.check) return "";
    const notes = s.check.notams.map((n) => n.text).join("; ");
    return s.check.clear ? `Airspace clear up to ${s.check.altitude} ft${notes ? ` — advisory: ${notes}` : ""}.` : `Blocked: ${notes}.`;
  };
  const isRequested = () => requested(p());
  return html`<main class="permit">
    <h1>Flight authorization</h1>
    <${Show} when=${() => p().error}><p role="alert">${() => p().error}</p><//>
    <${Show} when=${() => !p().error && p().notice}><p class="notice">${() => p().notice}</p><//>
    <section class="plan">
      <label>Max altitude <select name="altitude" disabled=${() => !planning()} onChange=${(e: Event) => actor.send({ type: "ALTITUDE", altitude: Number((e.target as HTMLSelectElement).value) })}>
        ${[100, 200, 300, 400].map((a) => html`<option value=${String(a)} selected=${() => p().altitude === a}>${a} ft</option>`)}
      </select></label>
      <label>Window <select name="window" disabled=${() => !planning()} onChange=${(e: Event) => actor.send({ type: "WINDOW", window: (e.target as HTMLSelectElement).value })}>
        ${WINDOWS.map((w) => html`<option value=${w} selected=${() => p().window === w}>${w}</option>`)}
      </select></label>
      <${Show} when=${() => p().sub === "loadingZones"}><p class="muted">Finding zones…</p><//>
      <ul class="zones" hidden=${() => p().sub === "loadingZones"}><${For} each=${() => p().zones}>${(z: Zone) => html`<li class=${() => (p().zoneId === z.id ? "zone selected" : "zone")}>
        ${z.name} · ${z.airspace} · ceiling ${z.ceiling} ft
        <button type="button" class="pick" disabled=${() => !planning() || p().zoneId === z.id} onClick=${() => actor.send({ type: "ZONE", zoneId: z.id })}>${() => (p().zoneId === z.id ? "Selected" : "Fly here")}</button></li>`}<//></ul>
      <p class="check">${checkText}</p>
      <${Show} when=${() => p().sub === "clear" || p().step === "requesting"}>
        <button type="button" class="request" disabled=${() => (p().step === "requesting" ? REQUEST_GUARD === "state" : isRequested())} onClick=${() => actor.send({ type: "REQUEST" })}>${() => (p().step === "requesting" ? "Requesting…" : isRequested() ? "Requested" : `Request authorization for ${zone()?.name ?? ""}`)}</button>
      <//>
    </section>
    <h2>Your authorizations</h2>
    <ul class="auths"><${For} each=${() => p().auths}>${(a: Row) => html`<li class=${`auth ${a.phase}`}>
      <span class="what">#${a.id} ${a.zone} · ${a.altitude} ft · ${a.window}</span> · <span class="status">${STATUS[a.phase] ?? a.status}${a.reason ? ` (${a.reason})` : ""}</span>
      ${a.phase === "pending" ? html`<button type="button" class="withdraw" onClick=${() => child(a.id)?.send({ type: "WITHDRAW" })}>Withdraw</button>` : ""}
      ${a.phase === "approved" ? html`<button type="button" class="start" disabled=${() => flying()} onClick=${() => child(a.id)?.send({ type: "START" })}>Start flight</button>` : ""}
      ${a.phase === "flying" ? html`<button type="button" class="land" onClick=${() => child(a.id)?.send({ type: "END" })}>Land and log</button>` : ""}
      ${a.error ? html`<p role="alert" class="row-error">${a.error}</p>` : ""}</li>`}<//></ul>
  </main>`;
}

render(() => html`<${App} />`, document.getElementById("app")!);
