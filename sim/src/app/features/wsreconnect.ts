// Live activity feed over a WebSocket the app manages itself (wss://host/ws/<topic>), with reconnects. The server
// publishes {seq, ...event} messages; a message published while the socket is down is lost for this client. The
// server drops sockets (socket-drop windows) and refuses new ones until the window ends. Knobs: reconnect with
// exponential backoff + jitter (guard), fixed delay, or an immediate tight loop (storm; with a connect ticket each
// attempt is also an HTTP request); after reconnecting, fetch the gap since the last seq, reload everything, or
// nothing (missed events never show: stale feed); seq-gap detection on messages; dedupe by seq (the gap fetch and
// the socket can deliver the same event); unread badge bumped on the gap-fill path or not.

import type { Item } from "../../net/server.js";
import type { ExternalEvent, FeatureDef, UserStep } from "../feature.js";
import { apiOf, weightsOf } from "./common.js";

export interface WsSpec {
  id: string;
  api: string;
  store: string;
  f: { feed: string; unread: string; conn: string; loading: string; error: string };
  path: string;
  ticketPath: string | null;
  topic: string;
  textField: string;
  kinds: string[];
  words: string[];
  people: string[];
  backoff: "exp" | "fixed" | "tight";
  baseMs: number;
  maxMs: number;
  gapFill: "since" | "reload" | "none";
  seqCheck: boolean;
  dedupe: boolean;
  unreadOnFill: boolean;
  maxItems: number;
  events: number;
  labels: { refresh: string; read: string };
}

type Obj = Record<string, unknown>;
interface Sock extends EventTarget {
  close(): void;
  readyState: number;
}

const seqOf = (x: unknown): number => Number((x as Item | undefined)?.seq ?? 0);

export const wsreconnect: FeatureDef<WsSpec> = {
  kind: "wsreconnect",
  make({ rng, domain, entity, naming, id, api, clean }) {
    const g = <T>(good: T, v: T): T => (clean ? good : v);
    const backoff = rng.weighted([["exp", 4], ["fixed", 2], ["tight", 2]] as const);
    const gapFill = rng.weighted([["since", 3], ["reload", 2], ["none", 3]] as const);
    const topicWord = rng.pick(domain.topics.length ? domain.topics : ["activity"]);
    return {
      id,
      api: api.name,
      store: naming.store(rng.pick(["activity", "live", "feed", "notifications", "events"]), rng.pick(["feed", "stream", ""]) || "feed"),
      f: {
        feed: naming.field("messages", id),
        unread: naming.field("unread", id),
        conn: naming.word(rng.pick(["connection", "socketState", "liveStatus", "connected"])),
        loading: naming.field("loading", id),
        error: naming.field("error", id),
      },
      path: naming.route(rng.pick(["activity", "events", "feed", "notifications"])),
      ticketPath: rng.bool(0.45) ? naming.route(rng.pick(["realtime", "ws", "live"]), rng.pick(["ticket", "token", "connect"])) : null,
      topic: `${topicWord.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}/${rng.pick(["live", "stream", "feed", "events"])}`,
      textField: naming.word(rng.pick(["text", "summary", "message", "title"])),
      kinds: [entity.create, ...entity.status.slice(0, 2), "comment"].map((k) => naming.word(k)),
      words: entity.words,
      people: domain.people.concat(["sam", "lee", "ana", "kai"]),
      backoff: g("exp", backoff),
      baseMs: rng.pick([250, 500, 1000]),
      maxMs: rng.pick([5000, 10000, 30000]),
      gapFill: g(gapFill === "none" ? "since" : gapFill, gapFill),
      seqCheck: rng.bool(0.4),
      dedupe: g(true, rng.bool(0.55)),
      unreadOnFill: g(true, rng.bool(0.6)),
      maxItems: rng.pick([20, 30, 50]),
      events: rng.int(10, 36),
      labels: { refresh: `button "${rng.pick(["Refresh", "Reload", "↻"])}"`, read: `button "${rng.pick(["Mark all read", "Mark as read", "Clear"])}"` },
    };
  },
  pattern(s) {
    return [`backoff:${s.backoff}`, `gap:${s.gapFill}`, s.seqCheck ? "seqcheck" : "noseqcheck", s.dedupe ? "dedupe" : "nodedupe", s.ticketPath ? "ticket" : "noticket", s.unreadOnFill ? "unread-fill" : "unread-push-only"];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:events`;
    srv.route(
      "GET",
      s.path,
      (req) => {
        const after = Number(req.query.get("after") ?? "0") || 0;
        const all = db.list(coll).filter((x) => seqOf(x) > after);
        const out = after ? all : all.slice(-s.maxItems);
        return { status: 200, body: api.list(out, { lastSeq: all.length ? seqOf(all[all.length - 1]) : after }) };
      },
      { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` },
    );
    if (s.ticketPath) {
      srv.route("POST", s.ticketPath, (req) => ({ status: 200, body: api.one({ ticket: `tk_${Math.floor(req.t).toString(36)}`, expiresIn: 30 }) }), { feature: s.id, kind: "auth", idempotent: true });
    }
  },
  client(s, env, kit) {
    const F = s.f;
    const key = `${s.id}.feed`;
    const S = env.store(s.store, s.id, { [F.feed]: [] as Item[], [F.unread]: 0, [F.conn]: "connecting", [F.loading]: true, [F.error]: null } as Obj, {
      weights: weightsOf([[F.feed, 1], [F.unread, 0.3], [F.conn, 0.15], [F.loading, 0.1], [F.error, 0]]),
      resync: () => fetchFeed("resync", 0),
    });
    let ws: Sock | null = null;
    let attempt = 0;
    let lastSeq = 0;
    let reconnects = 0;
    let filling = false;
    /** Guard variants subscribe first and load once the socket is open; events arriving meanwhile are buffered. */
    let loadOnOpen = false;
    let buffer: Item[] | null = null;
    function initialLoad(): void {
      loadOnOpen = false;
      buffer = [];
      kit.spawn(async () => {
        await fetchFeed("load", 0);
        const b = buffer ?? [];
        buffer = null;
        for (const m of b) onMessage(m);
      }, "swallow");
    }
    const feedOf = (p: Obj) => (p[F.feed] as Item[]) ?? [];
    const merge = (cur: Item[], add: Item[], dedupe: boolean): Item[] => {
      const fresh = dedupe ? add.filter((x) => !cur.some((y) => seqOf(y) === seqOf(x))) : add;
      return [...fresh.slice().reverse(), ...cur].slice(0, s.maxItems);
    };
    /** GET the feed: everything (`after` = 0) or the events after a seq (gap fill). */
    async function fetchFeed(why: "load" | "resync" | "refresh" | "gap" | "reload", after: number, intent?: number): Promise<void> {
      const url = after > 0 ? `${s.path}?after=${after}` : s.path;
      const op = kit.op({ role: why, method: "GET", url, key, intent, background: intent === undefined, handled: true });
      const r = await kit.call(op, { timeoutMs: 9000 });
      if (!r.ok) {
        kit.write(S, (p) => ({ ...p, [F.loading]: false }), { role: "error", op, key, intent });
        return;
      }
      const items = kit.api.unlist(r.body).items;
      const top = items.reduce((m, x) => Math.max(m, seqOf(x)), 0);
      if (after > 0) {
        // Gap fill: append what was missed.
        const dedupe = s.dedupe;
        const bump = s.unreadOnFill;
        const n = items.filter((x) => !feedOf(S.get()).some((y) => seqOf(y) === seqOf(x))).length;
        const classify = () => (items.length && items.every((x) => feedOf(S.get()).some((y) => seqOf(y) === seqOf(x))) ? "duplicate" : undefined);
        kit.write(S, (p) => ({ ...p, [F.feed]: merge(feedOf(p), items, dedupe), [F.loading]: false, ...(bump ? { [F.unread]: Number(p[F.unread] ?? 0) + n } : {}) }), { role: "refetch", op, key, intent, classify });
      } else {
        kit.write(S, (p) => ({ ...p, [F.feed]: items.slice().reverse().slice(0, s.maxItems), [F.loading]: false }), { role: why === "load" ? "load" : "refetch", op, key, intent });
      }
      lastSeq = Math.max(lastSeq, top);
    }
    function onMessage(m: Item): void {
      if (buffer) {
        buffer.push(m);
        return;
      }
      const seq = seqOf(m);
      if (s.dedupe && seq <= lastSeq) return;
      if (s.seqCheck && lastSeq > 0 && seq > lastSeq + 1 && !filling) {
        // Gap detected: fetch what was missed (the fetch includes this event).
        filling = true;
        const from = lastSeq;
        kit.spawn(async () => {
          await fetchFeed("gap", from);
          filling = false;
        }, "swallow");
        return;
      }
      lastSeq = Math.max(lastSeq, seq);
      const classify = () => (feedOf(S.get()).some((x) => seqOf(x) === seq) ? "duplicate" : undefined);
      kit.write(S, (p) => ({ ...p, [F.feed]: [m, ...feedOf(p)].slice(0, s.maxItems), [F.unread]: Number(p[F.unread] ?? 0) + 1 }), { role: "push", key, classify });
    }
    function scheduleReconnect(): void {
      // Could not subscribe: show the feed anyway; the reconnect fills the gap.
      if (loadOnOpen) initialLoad();
      attempt++;
      reconnects++;
      let delay: number;
      if (s.backoff === "exp") delay = Math.min(s.maxMs, s.baseMs * 2 ** (attempt - 1)) * (0.5 + 0.5 * env.rng.fork("ws-jitter", s.id, reconnects).next());
      else if (s.backoff === "fixed") delay = s.baseMs * 2;
      else delay = 5; // defect: reconnect immediately, forever
      if (attempt === 1 || attempt % 5 === 0) kit.write(S, (p) => ({ ...p, [F.conn]: "reconnecting" }), { role: "status", key: `${s.id}.conn` });
      if (reconnects > 400) return;
      env.setTimeout(() => connect(true), delay);
    }
    function open(reconnect: boolean, ticket?: string): void {
      const WS = env.G.WebSocket as (new (url: string) => Sock) | undefined;
      if (!WS) {
        env.subscribe(s.topic, (msg) => onMessage(msg as Item));
        return;
      }
      const url = `wss://${env.G.location.host}/ws/${s.topic.split("/").map(encodeURIComponent).join("/")}${ticket ? `?ticket=${encodeURIComponent(ticket)}` : ""}`;
      const sock = new WS(url);
      ws = sock;
      sock.addEventListener("open", () => {
        if (ws !== sock) return;
        attempt = 0;
        kit.write(S, (p) => ({ ...p, [F.conn]: "live" }), { role: "status", key: `${s.id}.conn` });
        if (loadOnOpen) return initialLoad();
        if (!reconnect) return;
        if (s.gapFill === "since") kit.spawn(() => fetchFeed("gap", lastSeq), "swallow");
        else if (s.gapFill === "reload") kit.spawn(() => fetchFeed("reload", 0), "swallow");
      });
      sock.addEventListener("message", (e) => {
        if (ws !== sock) return;
        onMessage(JSON.parse(String((e as MessageEvent).data)) as Item);
      });
      sock.addEventListener("close", () => {
        if (ws !== sock) return;
        ws = null;
        scheduleReconnect();
      });
    }
    function connect(reconnect: boolean): void {
      if (!s.ticketPath) return open(reconnect);
      const tight = reconnect && s.backoff === "tight";
      const op = kit.op({ role: "ticket", method: "POST", url: s.ticketPath, body: {}, key: `${s.id}.conn`, background: true, handled: true, idempotent: true, ...(tight ? { anomaly: "storm" } : {}) });
      kit.spawn(async () => {
        const r = await kit.call(op, { timeoutMs: 6000 });
        if (!r.ok) return scheduleReconnect();
        open(reconnect, String(kit.api.unone(r.body).ticket ?? ""));
      }, "swallow");
    }
    return {
      init() {
        if (s.gapFill === "none") {
          // Naive: load and subscribe in parallel (events published in between are missed).
          kit.spawn(() => fetchFeed("load", 0), "swallow");
        } else loadOnOpen = true;
        connect(false);
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "read") {
          kit.write(S, (p) => ({ ...p, [F.unread]: 0 }), { role: "read", intent, key: `${s.id}.unread` });
          return;
        }
        kit.write(S, (p) => ({ ...p, [F.loading]: true }), { role: "loading", intent, key });
        kit.spawn(() => fetchFeed("refresh", 0, intent), "uncaught", { cause: "feed-failed", diagnosis: "failing" });
      },
      cond() {
        return S.get()[F.loading] === true;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(2);
    while (t < win.t1 - 1000) {
      // Users mostly read a live feed; a manual refresh is occasional.
      if (user.rng.bool(0.15)) {
        const c = user.click(t, s.labels.refresh, "refresh", { kind: "refresh", key: `${s.id}.refresh`, mode: "replace" }, { pendingCond: "loading" });
        steps.push(...c.steps);
      } else {
        steps.push(...user.click(t, s.labels.read, "read", { kind: "read", key: `${s.id}.unread`, mode: "replace" }).steps);
      }
      t += user.think(3);
    }
    return steps;
  },
  external(s, rng, win) {
    const out: ExternalEvent[] = [];
    for (let i = 0; i < s.events; i++) {
      const t = rng.float(win.t0 + 300, win.t1);
      const who = rng.pick(s.people);
      const kind = rng.pick(s.kinds);
      const text = `${who} ${kind} ${rng.pick(s.words)}`;
      out.push({
        t,
        feature: s.id,
        desc: `${who}: ${kind}`,
        apply(w) {
          const coll = `${s.id}:events`;
          const seq = w.db.collection(coll).order.length + 1;
          const it = w.db.insert(coll, { seq, kind, [s.textField]: text, by: who }, `${seq}:${text}`, w.now());
          w.publish(s.topic, it);
        },
      });
    }
    return out;
  },
  env(_s, rng, win) {
    const drops: { start: number; end: number }[] = [];
    const n = rng.weighted([[1, 3], [2, 2]] as const);
    let lo = win.t0;
    for (let i = 0; i < n; i++) {
      const len = rng.float(1000, 6000);
      const room = win.t1 - lo - len;
      if (room <= 0) break;
      const start = lo + rng.float(0, n > 1 && i === 0 ? room * 0.5 : room);
      drops.push({ start, end: start + len });
      lo = start + len + 2000;
    }
    return { socketDrops: drops };
  },
};
