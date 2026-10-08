// Kitchen display system (React 19 + effector + effector-react useUnit; fetch + WebSocket). Tickets stream in over
// the live topic; a cook starts a ticket (new → cooking), bumps it when the plates are up (cooking → ready, versioned
// PATCH) or recalls a ready ticket that came back (POST /tickets/:id/recall: relative, counts recalls). The expo
// clears served tickets elsewhere. Server results reach the stores through GenClass-guarded writes; the station tab
// is a plain UI event. Latent bugs by flag: pushes and HTTP echoes applied in arrival order (live=blind: an older
// copy overwrites the bump), bump/start buttons live while the PATCH posts (bumpGuard=none: the second PATCH carries
// the old version and fails), reconnects that don't reload what was missed (reconnect=naive), recalls retried
// without an Idempotency-Key (recall=retry-blind: a recall that committed before a 5xx counts twice) and all-day
// counts adjusted by hand in two places (allDay=incremental: the WS echo and the HTTP answer both subtract).
import { createRoot } from "react-dom/client";
import { createEffect, createEvent, createStore, sample } from "effector";
import { useUnit } from "effector-react";
import { flag } from "../_shared/genclass";
import { guardStore } from "../_shared/w4-effector";
import { api, itemsOf, errText, HttpError, liveTopic } from "../_shared/w3-http";

type Status = "new" | "cooking" | "ready";
type Ticket = { id: number; table: string; items: string; station: string; covers: number; status: Status; recalls: number; version: number; createdAt?: string };
type Kitchen = { tickets: Ticket[]; allDay: Record<string, number> };
type Board = { station: string; pending: number[]; live: boolean; error: string; notice: string };

const LIVE = flag("live", "version-check");
const BUMP_GUARD = flag("bumpGuard", "pending") === "pending";
const RECONNECT = flag("reconnect", "resync");
const RECALL = flag("recall", "idempotency-key") as "idempotency-key" | "retry-blind" | "no-retry";
const ALL_DAY = flag("allDay", "derive");
const STATIONS = ["grill", "fry", "salad"];
const NEXT: Record<string, { to: Status; label: string; cls: string }> = { new: { to: "cooking", label: "Start", cls: "start" }, cooking: { to: "ready", label: "Bump", cls: "bump" } };

const isOpen = (t: Ticket) => t.status !== "ready";
const allDayOf = (ts: Ticket[]) => Object.fromEntries(STATIONS.map((s) => [s, ts.filter((t) => t.station === s && isOpen(t)).reduce((a, t) => a + t.covers, 0)]));
// seeded tickets first, then by arrival on the pass (server createdAt), ties by id
const byNo = (ts: Ticket[]) => [...ts].sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) || a.id - b.id);

// ------------------------------------------------------------------------------------------ stores
const $kitchen = createStore<Kitchen>({ tickets: [], allDay: allDayOf([]) });
const $board = createStore<Board>({ station: "all", pending: [], live: false, error: "", notice: "" });
const writeKitchen = guardStore("kitchen", $kitchen);
const writeBoard = guardStore("board", $board);

const stationPicked = createEvent<string>();
$board.on(stationPicked, (b, station) => ({ ...b, station, notice: "" }));

/** A ticket from the server (HTTP answer or push) merged into the kitchen. */
function upsert(k: Kitchen, t: Ticket, fromPush: boolean): Kitchen {
  const cur = k.tickets.find((x) => x.id === t.id);
  if (cur && LIVE === "version-check" && Number(t.version) < Number(cur.version)) return k;
  const tickets = byNo(cur ? k.tickets.map((x) => (x.id === t.id ? t : x)) : [...k.tickets, t]);
  if (ALL_DAY === "derive") return { tickets, allDay: allDayOf(tickets) };
  // incremental: the push handler adjusts by the transition it sees (the bump handler subtracts on its own)
  const allDay = { ...k.allDay };
  if (fromPush) {
    if (!cur && isOpen(t)) allDay[t.station] += t.covers;
    else if (cur && isOpen(cur) && !isOpen(t)) allDay[t.station] -= t.covers;
    else if (cur && !isOpen(cur) && isOpen(t)) allDay[t.station] += t.covers;
  }
  return { tickets, allDay };
}
function remove(k: Kitchen, id: number): Kitchen {
  const tickets = k.tickets.filter((x) => x.id !== id);
  return { tickets, allDay: ALL_DAY === "derive" ? allDayOf(tickets) : k.allDay };
}
const pend = (id: number, on: boolean) => writeBoard((b) => ({ ...b, pending: on ? [...b.pending, id] : b.pending.filter((x) => x !== id) }));

// ------------------------------------------------------------------------------------------ effects
const loadFx = createEffect(async () => byNo(itemsOf<Ticket>(await api("/api/tickets?limit=50"))));
loadFx.doneData.watch((tickets) => writeKitchen(() => ({ tickets, allDay: allDayOf(tickets) })));
loadFx.failData.watch((e) => writeBoard((b) => ({ ...b, error: errText(e, "loading tickets") })));

const advanceFx = createEffect(async (t: Ticket) => {
  const next = NEXT[t.status]!;
  return api<Ticket>(`/api/tickets/${t.id}`, "PATCH", { status: next.to, version: t.version });
});
const advanceClicked = createEvent<Ticket>();
sample({
  clock: advanceClicked,
  source: $board,
  filter: (b, t) => !(BUMP_GUARD && b.pending.includes(t.id)) && Boolean(NEXT[t.status]),
  fn: (_, t) => t,
  target: advanceFx,
});
advanceFx.watch((t) => {
  pend(t.id, true);
  writeBoard((b) => ({ ...b, error: "", notice: "" }));
});
advanceFx.done.watch(({ params, result }) => {
  writeKitchen((k) => {
    const next = upsert(k, result, false);
    if (ALL_DAY === "incremental" && params.status === "cooking" && result.status === "ready") return { ...next, allDay: { ...next.allDay, [result.station]: next.allDay[result.station]! - result.covers } };
    return next;
  });
  writeBoard((b) => ({ ...b, notice: result.status === "ready" ? `#${result.id} for ${result.table} is up.` : `#${result.id} started.` }));
});
advanceFx.fail.watch(({ params, error }) => {
  const cur = error instanceof HttpError && error.status === 409 ? (error.body?.current as Ticket | undefined) : undefined;
  if (cur) writeKitchen((k) => upsert(k, cur, false));
  writeBoard((b) => ({ ...b, error: cur ? `#${params.id} was already moved on another screen.` : errText(error, `updating #${params.id}`) }));
});
advanceFx.finally.watch(({ params }) => pend(params.id, false));

const recallFx = createEffect(async (t: Ticket) => {
  const key = RECALL === "idempotency-key" ? `recall-${t.id}-${t.version}` : "";
  const send = () => api<Ticket>(`/api/tickets/${t.id}/recall`, "POST", {}, key ? { "Idempotency-Key": key } : {});
  try {
    return await send();
  } catch (e) {
    const retriable = !(e instanceof HttpError) || e.status >= 500;
    if (RECALL === "no-retry" || !retriable) throw e;
    return send();
  }
});
const recallClicked = createEvent<Ticket>();
sample({ clock: recallClicked, source: $board, filter: (b, t) => !b.pending.includes(t.id), fn: (_, t) => t, target: recallFx });
recallFx.watch((t) => pend(t.id, true));
recallFx.doneData.watch((t) => {
  writeKitchen((k) => upsert(k, t, false));
  writeBoard((b) => ({ ...b, error: "", notice: `#${t.id} recalled to the pass (${t.recalls}×).` }));
});
recallFx.fail.watch(({ params, error }) => writeBoard((b) => ({ ...b, error: errText(error, `recalling #${params.id}`) })));
recallFx.finally.watch(({ params }) => pend(params.id, false));

// ------------------------------------------------------------------------------------------ view
function TicketRow({ t, pending }: { t: Ticket; pending: boolean }) {
  const next = NEXT[t.status];
  return (
    <li className={`ticket ${t.status}`}>
      <strong>#{t.id}</strong> {t.table} · {t.items} · {t.covers} cover{t.covers === 1 ? "" : "s"} · {t.station}
      {t.recalls ? <em> · recalled {t.recalls}×</em> : null}{" "}
      {next ? (
        <button type="button" className={next.cls} disabled={BUMP_GUARD && pending} onClick={() => advanceClicked(t)}>
          {next.label}
        </button>
      ) : (
        <button type="button" className="recall" disabled={pending} onClick={() => recallClicked(t)}>
          Recall
        </button>
      )}
    </li>
  );
}

function App() {
  const [kitchen, board] = useUnit([$kitchen, $board]);
  const shown = kitchen.tickets.filter((t) => board.station === "all" || t.station === board.station);
  return (
    <main className="kds">
      <header>
        <h1>Kitchen display</h1>
        <p className="allday">All day: {STATIONS.map((s) => `${s} ${kitchen.allDay[s]}`).join(" · ")}</p>
        <p className="conn">{board.live ? "live" : "reconnecting…"}</p>
      </header>
      <nav className="stations">
        {["all", ...STATIONS].map((s) => (
          <button key={s} type="button" className={board.station === s ? "current" : ""} onClick={() => stationPicked(s)}>
            {s === "all" ? "All" : s}
          </button>
        ))}
      </nav>
      {board.error ? <p role="alert">{board.error}</p> : board.notice ? <p className="notice">{board.notice}</p> : null}
      <ul className="tickets">
        {shown.map((t) => (
          <TicketRow key={t.id} t={t} pending={board.pending.includes(t.id)} />
        ))}
      </ul>
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<App />);

let everUp = false;
liveTopic(
  "tickets",
  (m) => {
    if (m.type === "deleted") writeKitchen((k) => remove(k, Number(m.id)));
    else if (m.item) writeKitchen((k) => upsert(k, m.item as Ticket, true));
  },
  (up) => {
    writeBoard((b) => ({ ...b, live: up }));
    if (up && everUp && RECONNECT === "resync") void loadFx();
    if (up) everUp = true;
  },
);
void loadFx();
