// Chat / comments: compose + send. Optimistic append with a temp id, POST, replace the temp message with the
// server's; the server also pushes every new message (including our own) on the live channel. Knobs: dedupe of
// pushed messages by id/clientId (guard) or not (duplicate defect), replace-by-clientId vs append on response,
// send button disabled while sending, unread counter maintained by the app.

import type { Item } from "../../net/server.js";
import type { ExternalEvent, FeatureDef, UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, errMsg, weightsOf } from "./common.js";

export interface ChatSpec {
  id: string;
  api: string;
  store: string;
  f: { messages: string; draft: string; sending: string; unread: string; error: string };
  textField: string;
  path: string;
  topic: string;
  optimistic: boolean;
  dedupe: "id" | "clientId" | "none";
  onResponse: "replace" | "append" | "ignore";
  disable: boolean;
  unreadField: boolean;
  words: string[];
  others: string[];
  inputLabel: string;
  sendLabel: string;
  incoming: number;
}

export const chat: FeatureDef<ChatSpec> = {
  kind: "chat",
  make({ rng, domain, entity, naming, id, api }) {
    const chatEnt = domain.entities.find((e) => /message|comment|post|reply|note/.test(e.s)) ?? entity;
    return {
      id,
      api: api.name,
      store: naming.store(rng.pick(["chat", "thread", "comments", "conversation", "feed"])),
      f: { messages: naming.field("messages", id), draft: naming.field("draft", id), sending: naming.field("submitting", id), unread: naming.field("unread", id), error: naming.field("error", id) },
      textField: naming.word(rng.pick(["text", "body", "content", "message"])),
      path: naming.route(rng.pick(["messages", "comments", "posts", "replies"])),
      topic: rng.pick(["chat", "messages", "thread", "comments", "room"]) + rng.pick(["", "-live", "-stream"]),
      optimistic: rng.bool(0.6),
      dedupe: rng.weighted([["id", 2], ["clientId", 2], ["none", 3]] as const),
      onResponse: rng.weighted([["replace", 3], ["append", 2], ["ignore", 1]] as const),
      disable: rng.bool(0.3),
      unreadField: rng.bool(0.5),
      words: chatEnt.words.concat(["ok", "thanks", "on it", "lgtm", "see you"]),
      others: domain.people.concat(["sam", "lee", "ana"]),
      inputLabel: `textarea "${rng.pick(["Message", "Write a comment", "Reply", "Say something"])}"`,
      sendLabel: `button "${rng.pick(["Send", "Post", "Reply", "Comment"])}"`,
      incoming: rng.int(0, 4),
    };
  },
  pattern(s) {
    return [s.optimistic ? "optimistic" : "pessimistic", `dedupe:${s.dedupe}`, `resp:${s.onResponse}`, s.disable ? "disable" : "nodisable", s.unreadField ? "unread" : "nounread"];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:messages`;
    srv.route("GET", s.path, () => ({ status: 200, body: api.list(db.list(coll)) }), { feature: s.id, kind: "read", idempotent: true, resource: `c:${coll}` });
    srv.route(
      "POST",
      s.path,
      (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const text = String(b[s.textField] ?? "");
        if (!text.trim()) return { status: 422, body: api.error("empty", "message is empty") };
        const it = db.insert(coll, { [s.textField]: text, author: "you", clientId: String(b.clientId ?? "") }, `${text}`, req.t);
        srv.publish(s.topic, it);
        return { status: 201, body: api.one(it) };
      },
      { feature: s.id, kind: "write", idempotent: false, resource: `c:${coll}` },
    );
  },
  client(s, env, kit) {
    const F = s.f;
    const init: Record<string, unknown> = { [F.messages]: [] as Item[], [F.draft]: "", [F.sending]: false, [F.error]: null };
    if (s.unreadField) init[F.unread] = 0;
    let sending = 0;
    let tmp = 0;
    const S = env.store(s.store, s.id, init, {
      weights: weightsOf([[F.messages, 1], [F.draft, 0.3], [F.sending, 0.1], [F.unread, 0.3], [F.error, 0]]),
      resync: () => load(true),
    });
    // Message content equality for the "messages" list ignores ids (see divergence): text + author.
    async function load(bg: boolean): Promise<void> {
      const op = kit.op({ role: "load", method: "GET", url: s.path, key: `${s.id}.messages`, background: bg });
      const r = await kit.call(op);
      if (r.ok) kit.write(S, (p) => ({ ...p, [F.messages]: kit.api.unlist(r.body).items }), { role: "load", op, key: `${s.id}.messages` });
    }
    const has = (list: Item[], m: Item) => {
      if (s.dedupe === "id") return list.some((x) => x.id === m.id);
      if (s.dedupe === "clientId") return list.some((x) => x.id === m.id || (m.clientId && x.clientId === m.clientId));
      return false;
    };
    function send(intent: number): void {
      if (s.disable && sending > 0) return;
      const text = String(S.get()[F.draft] ?? "").trim();
      if (!text) return;
      const it = env.know.getIntent(intent);
      const ref = it?.accidental && it.repeatOf !== undefined ? it.repeatOf : intent;
      const clientId = `c${env.rng.fork("cid", ref).token(8)}`;
      const tmpId = `tmp-${++tmp}`;
      sending++;
      const key = `${s.id}.send`;
      if (s.optimistic) {
        kit.write(S, (p) => ({ ...p, [F.messages]: [...((p[F.messages] as Item[]) ?? []), { id: tmpId, [s.textField]: text, author: "you", clientId, pending: true }], [F.draft]: "", [F.sending]: true }), { role: "optimistic", intent, key });
      } else kit.write(S, (p) => ({ ...p, [F.sending]: true }), { role: "sending", intent, key });
      const op = kit.op({ role: "send", method: "POST", url: s.path, body: { [s.textField]: text, clientId }, intent, key, idempotent: false, ...(it?.accidental ? { dupOf: it.repeatOf } : {}) });
      kit.spawn(
        async () => {
          const r = await kit.call(op, { timeoutMs: 10000 });
          sending--;
          if (r.ok) {
            const m = kit.api.unone(r.body);
            const classify = () => {
              const list = (S.get()[F.messages] as Item[]) ?? [];
              return list.some((x) => x.id === m.id) && s.onResponse === "append" ? "duplicate" : undefined;
            };
            if (s.onResponse === "replace") {
              kit.write(S, (p) => {
                const list = ((p[F.messages] as Item[]) ?? []).filter((x) => x.id !== tmpId && !(s.dedupe !== "none" && x.id === m.id));
                return { ...p, [F.messages]: [...list, m], [F.sending]: sending > 0, [F.draft]: s.optimistic ? p[F.draft] : "" };
              }, { role: "confirm", op, intent, key, classify });
            } else if (s.onResponse === "append") {
              kit.write(S, (p) => {
                const list = ((p[F.messages] as Item[]) ?? []).filter((x) => x.id !== tmpId);
                if (has(list, m)) return { ...p, [F.sending]: sending > 0 };
                return { ...p, [F.messages]: [...list, m], [F.sending]: sending > 0, [F.draft]: s.optimistic ? p[F.draft] : "" };
              }, { role: "confirm", op, intent, key, classify });
            } else {
              kit.write(S, (p) => ({ ...p, [F.sending]: sending > 0, [F.draft]: s.optimistic ? p[F.draft] : "" }), { role: "sent", op, intent, key });
            }
            return;
          }
          kit.write(S, (p) => ({ ...p, [F.sending]: sending > 0, [F.error]: errMsg(r.status, r.outcome), [F.messages]: s.optimistic ? ((p[F.messages] as Item[]) ?? []).filter((x) => x.id !== tmpId) : p[F.messages] }), { role: "error", op, intent, key });
          kit.shownError();
        },
        "uncaught",
        { cause: "send-failed", diagnosis: "failing", op },
      );
    }
    return {
      init() {
        kit.spawn(() => load(true), "swallow");
        env.socket(s.topic, (msg) => {
          const m = msg as Item;
          const list = (S.get()[F.messages] as Item[]) ?? [];
          const mine = m.author === "you";
          if (has(list, m)) return;
          const classify = () => {
            const cur = (S.get()[F.messages] as Item[]) ?? [];
            const already = cur.some((x) => x.id === m.id || (mine && x.clientId === m.clientId && !x.pending));
            const pendingTmp = cur.some((x) => mine && x.clientId === m.clientId && x.pending);
            return already ? "duplicate" : pendingTmp && s.onResponse !== "ignore" ? "duplicate" : undefined;
          };
          kit.write(S, (p) => {
            const o: Record<string, unknown> = { ...p, [F.messages]: [...((p[F.messages] as Item[]) ?? []).filter((x) => !(s.dedupe === "clientId" && mine && x.clientId === m.clientId && x.pending)), m] };
            if (s.unreadField && !mine) o[F.unread] = Number(p[F.unread] ?? 0) + 1;
            return o;
          }, { role: "push", key: `${s.id}.messages`, classify });
        });
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "type") {
          kit.write(S, (p) => ({ ...p, [F.draft]: String(step.ui.value ?? "") }), { role: "input", intent, key: `${s.id}.draft` });
          return;
        }
        if (step.action === "read" && s.unreadField) {
          kit.write(S, (p) => ({ ...p, [F.unread]: 0 }), { role: "read", intent, key: `${s.id}.unread` });
          return;
        }
        send(intent);
      },
      cond() {
        return sending > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(0.6);
    let last = "";
    while (t < win.t1 - 1000) {
      const text = last && user.rng.bool(0.15) ? last : `${user.rng.pick(s.words)}${user.rng.bool(0.5) ? " " + user.rng.pick(s.words) : ""}`;
      const typed = user.type(t, "", text, s.inputLabel, "type", `${s.id}.draft`);
      steps.push(...typed.steps);
      t = typed.t + user.rng.float(100, 600);
      const viaEnter = user.rng.bool(0.6);
      const c = user.click(t, viaEnter ? s.inputLabel : s.sendLabel, "send", { kind: "send", key: `${s.id}.send` }, { pendingCond: "sending", kind: viaEnter ? "key" : "click", ...(viaEnter ? { value: "Enter" } : {}) });
      steps.push(...c.steps);
      last = text;
      if (user.rng.bool(0.3)) steps.push({ t: t + user.think(0.5), feature: s.id, action: "read", ui: { kind: "click", target: `tab "${title(s.store)}"` }, intent: { kind: "read", key: `${s.id}.read`, mode: "replace", accidental: false } });
      t += user.think(1.4);
    }
    return steps;
  },
  external(s, rng, win) {
    const out: ExternalEvent[] = [];
    for (let i = 0; i < s.incoming; i++) {
      const t = rng.float(win.t0, win.t1);
      const who = rng.pick(s.others);
      const text = `${rng.pick(s.words)} ${rng.pick(s.words)}`;
      out.push({
        t,
        feature: s.id,
        desc: `${who} posts`,
        apply(w) {
          const it = w.db.insert(`${s.id}:messages`, { [s.textField]: text, author: who, clientId: "" }, `${who}:${text}`, w.now());
          w.publish(s.topic, it);
        },
      });
    }
    return out;
  },
};
