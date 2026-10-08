// Multi-tab sync: app state (preferences, a draft, a last-read id) is persisted to localStorage (one key per field,
// {field, value, ts, tab}) and/or posted on a BroadcastChannel, and optionally saved to / reloaded from the server.
// Another tab of the same app (external events via w.otherTab) writes the same keys; this tab gets `storage` events
// or channel messages. The other tab's timers are throttled in the background, so some of its writes carry an old
// timestamp. Knobs: apply incoming state blindly (defect: clobbers unsaved local changes = conflict, older over
// newer = stale) vs versioned by modification time vs merge (guards); persist immediately or debounced; server
// save of the full state or of changed fields only, with or without an echo guard; reload from the server on
// every storage event (defect: storms; late responses overwrite newer typing) vs debounced.

import { AppEnv } from "../env.js";
import type { ExternalEvent, FeatureDef, UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, errMsg, weightsOf } from "./common.js";

type Val = string | number;

export interface MultitabSpec {
  id: string;
  api: string;
  store: string;
  kind: "prefs" | "draft" | "read";
  f: { values: string; syncing: string; error: string };
  fields: { name: string; options: string[]; label: string }[];
  init: Record<string, Val>;
  storageKey: string;
  channel: string;
  transport: "storage" | "channel";
  apply: "blind" | "versioned" | "merge";
  persistMs: number;
  server: "none" | "save" | "refetch";
  saveMs: number;
  patchOnly: boolean;
  echoGuard: boolean;
  refetchMs: number;
  statePath: string;
  otherEvents: number;
}

const OPTION_SETS = [["light", "dark", "system"], ["compact", "comfortable", "spacious"], ["daily", "weekly", "never"], ["en", "fr", "de", "es"], ["on", "off"]];

export const multitab: FeatureDef<MultitabSpec> = {
  kind: "multitab",
  make({ rng, domain, naming, id, api, clean }) {
    const kind = rng.weighted([["prefs", 3], ["draft", 3], ["read", 2]] as const);
    let fields: MultitabSpec["fields"];
    if (kind === "prefs") {
      fields = rng.sample(["theme", ...domain.settings], rng.int(2, 3)).map((n) => ({ name: naming.word(n), options: rng.pick(OPTION_SETS), label: `select "${title(n)}"` }));
    } else if (kind === "draft") {
      const n = naming.field("draft", id);
      fields = [{ name: n, options: domain.entities.flatMap((e) => e.words).slice(0, 16), label: `textarea "${rng.pick(["Draft", "Message", "Note", "Reply"])}"` }];
    } else fields = [{ name: rng.pick(["lastRead", "lastSeenId", "readUpTo", "cursor"]), options: [], label: `button "${rng.pick(["Mark as read", "Next", "Mark read ↓"])}"` }];
    const init: Record<string, Val> = {};
    for (const f of fields) init[f.name] = kind === "prefs" ? f.options[0]! : kind === "draft" ? "" : rng.int(100, 900);
    const apply = rng.weighted([["blind", 4], ["versioned", 3], ["merge", 2]] as const);
    const server = rng.weighted([["none", 2], ["save", 3], ["refetch", 3]] as const);
    const refetchMs = rng.weighted([[0, 3], [rng.int(200, 600), 2]] as const);
    return {
      id,
      api: api.name,
      store: naming.store(rng.pick(kind === "prefs" ? ["prefs", "ui", "appearance"] : kind === "draft" ? ["composer", "draft", "notes"] : ["inbox", "reader", "feed"]), rng.pick(["", "state", "sync"])),
      kind,
      f: { values: naming.field("value", id), syncing: naming.field("saving", id), error: naming.field("error", id) },
      fields,
      init,
      storageKey: `${rng.pick(["app", domain.name, "ui"])}:${kind}`,
      channel: `${domain.name}-${rng.pick(["sync", "tabs", "state"])}`,
      transport: rng.bool(0.6) ? "storage" : "channel",
      apply: clean && apply === "blind" ? "versioned" : apply,
      persistMs: rng.weighted([[0, 3], [rng.int(300, 1000), 2]] as const),
      server,
      saveMs: rng.int(300, 1200),
      patchOnly: clean || rng.bool(0.5),
      echoGuard: clean || rng.bool(0.5),
      refetchMs: clean && refetchMs === 0 ? 300 : refetchMs,
      statePath: naming.route(rng.pick(["me", "user", "session"]), rng.pick([kind, "state", "sync"])),
      otherEvents: rng.int(2, 7),
    };
  },
  pattern(s) {
    return [`kind:${s.kind}`, `via:${s.transport}`, `apply:${s.apply}`, s.persistMs ? "persist:debounce" : "persist:now", `server:${s.server}`, s.server === "save" ? (s.patchOnly ? "patch" : "full") : "nosave", s.server === "save" ? (s.echoGuard ? "echo-guard" : "echo-blind") : "noecho", s.server === "refetch" ? (s.refetchMs ? "refetch-debounce" : "refetch-each") : "norefetch"];
  },
  server(s, srv, db) {
    // Registered even when this variant keeps state client-side only (a program always has endpoints).
    const api = apiOf(s.api);
    const name = `${s.id}:state`;
    db.doc(name, s.init);
    const out = () => api.one({ values: { ...db.doc(name).fields }, rev: db.doc(name).version });
    srv.route("GET", s.statePath, () => ({ status: 200, body: out() }), { feature: s.id, kind: "read", idempotent: true, resource: `d:${name}` });
    srv.route("PUT", s.statePath, (req) => {
      const b = ((req.body ?? {}) as Record<string, unknown>).values as Record<string, Val> | undefined;
      const patch: Record<string, Val> = {};
      for (const f of s.fields) if (b && (typeof b[f.name] === "string" || typeof b[f.name] === "number")) patch[f.name] = b[f.name]!;
      db.writeDoc(name, patch, req.t);
      return { status: 200, body: out() };
    }, { feature: s.id, kind: "write", idempotent: true, resource: `d:${name}` });
  },
  client(s, env, kit) {
    const F = s.f;
    const tab = `tab-${env.rng.fork("tab", s.id).token(6)}`;
    const S = env.store(s.store, s.id, { [F.values]: { ...s.init }, [F.syncing]: false, [F.error]: null } as Record<string, unknown>, {
      weights: weightsOf([[F.values, 1], [F.syncing, 0.1], [F.error, 0]]),
      ...(s.server !== "none" ? { resync: () => reload("resync") } : {}),
    });
    const vals = () => (S.get()[F.values] as Record<string, Val>) ?? {};
    const meta = new Map<string, { ts: number; dirty: boolean }>();
    const timers = new Map<string, unknown>();
    let saveTimer: unknown = null;
    let refetchTimer: unknown = null;
    let saving = 0;
    let localSeq = 0;
    let remoteAt = -1;
    let lastReload = -1e9;
    const ch = s.transport === "channel" ? env.channel(s.channel, (m) => incoming(m)) : null;
    const dirtyFields = () => [...meta].filter(([, m]) => m.dirty).map(([f]) => f);
    function persist(field: string): void {
      const payload = { field, value: vals()[field], ts: meta.get(field)?.ts ?? env.clientNow(), tab };
      try {
        env.G.localStorage.setItem(`${s.storageKey}.${field}`, JSON.stringify(payload));
      } catch {
        /* quota / private mode */
      }
      ch?.post(payload);
      const m = meta.get(field);
      if (m && s.server !== "save") m.dirty = false;
    }
    async function save(intent: number): Promise<void> {
      const seqAt = localSeq;
      const sentFields = s.patchOnly ? dirtyFields() : s.fields.map((f) => f.name);
      const sent: Record<string, Val> = {};
      for (const f of sentFields) sent[f] = vals()[f]!;
      saving++;
      kit.write(S, (p) => ({ ...p, [F.syncing]: true }), { role: "saving", intent, key: `${s.id}.state` });
      const op = kit.op({ role: "save", method: "PUT", url: s.statePath, body: { values: sent }, intent, key: `${s.id}.state`, idempotent: true, handled: true });
      const r = await kit.call(op, { timeoutMs: 8000 });
      saving--;
      if (!r.ok) {
        kit.write(S, (p) => ({ ...p, [F.syncing]: saving > 0, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, intent });
        return kit.shownError();
      }
      for (const f of sentFields) {
        const m = meta.get(f);
        if (m && vals()[f] === sent[f]) m.dirty = false;
      }
      const srvVals = (kit.api.unone(r.body).values ?? {}) as Record<string, Val>;
      if (s.echoGuard && (localSeq !== seqAt || remoteAt > op.t0)) {
        kit.write(S, (p) => ({ ...p, [F.syncing]: saving > 0 }), { role: "saving", op, intent, key: `${s.id}.state` });
        return;
      }
      const classify = () => (remoteAt > op.t0 && s.fields.some((f) => srvVals[f.name] !== vals()[f.name]) ? "stale" : undefined);
      kit.write(S, (p) => ({ ...p, [F.values]: { ...(p[F.values] as Record<string, Val>), ...srvVals }, [F.syncing]: saving > 0 }), { role: "echo", op, intent, key: `${s.id}.state`, classify });
    }
    async function reload(role: string): Promise<void> {
      const tight = env.now() - lastReload < 300;
      lastReload = env.now();
      const op = kit.op({ role, method: "GET", url: s.statePath, key: `${s.id}.state`, background: true, handled: true, ...(tight && s.refetchMs === 0 ? { anomaly: "storm" } : {}) });
      const r = await kit.call(op, { timeoutMs: 8000 });
      if (!r.ok) return;
      const srvVals = (kit.api.unone(r.body).values ?? {}) as Record<string, Val>;
      const keep = s.apply === "blind" ? [] : dirtyFields();
      const classify = () => (dirtyFields().some((f) => srvVals[f] !== vals()[f]) && s.apply === "blind" ? "conflict" : undefined);
      kit.write(S, (p) => {
        const cur = (p[F.values] as Record<string, Val>) ?? {};
        const next: Record<string, Val> = { ...cur, ...srvVals };
        for (const f of keep) next[f] = cur[f]!;
        return { ...p, [F.values]: next };
      }, { role: role === "initial" ? "load" : "refetch", op, key: `${s.id}.state`, classify });
    }
    function incoming(raw: unknown): void {
      const m = raw as { field?: unknown; value?: unknown; ts?: unknown; tab?: unknown } | null;
      if (!m || typeof m.field !== "string" || m.tab === tab || !s.fields.some((f) => f.name === m.field)) return;
      const field = m.field;
      remoteAt = env.now();
      if (s.server === "refetch") {
        // The event only says "something changed": reload the state from the server.
        if (!s.refetchMs) return void kit.spawn(() => reload("storage-refetch"), "swallow");
        if (refetchTimer) env.clearTimeout(refetchTimer);
        refetchTimer = env.setTimeout(() => {
          refetchTimer = null;
          kit.spawn(() => reload("storage-refetch"), "swallow");
        }, s.refetchMs);
        return;
      }
      const cur = vals()[field];
      const loc = meta.get(field);
      const ts = Number(m.ts) || 0;
      const older = !!loc && ts < loc.ts;
      const conflict = !!loc?.dirty && cur !== m.value;
      let value = m.value as Val;
      if (s.apply === "versioned" && older) return;
      if (s.apply === "merge") {
        if (s.kind === "read") value = Math.max(Number(cur ?? 0), Number(value));
        else if (loc?.dirty || older) return;
      }
      if (value === cur) return;
      meta.set(field, { ts: Math.max(ts, loc?.ts ?? 0), dirty: false });
      kit.write(S, (p) => ({ ...p, [F.values]: { ...(p[F.values] as Record<string, Val>), [field]: value } }), {
        role: "push",
        key: `${s.id}.${field}`,
        classify: () => (older ? "stale" : conflict ? "conflict" : "expected"),
      });
    }
    return {
      init() {
        for (const f of s.fields) {
          try {
            const raw = env.G.localStorage.getItem(`${s.storageKey}.${f.name}`);
            if (raw) incoming(JSON.parse(raw));
          } catch {
            /* corrupt entry */
          }
        }
        if (s.server !== "none") kit.spawn(() => reload("initial"), "swallow");
        if (s.transport === "storage") {
          env.on("storage", (e) => {
            const ev = e as unknown as { key: string | null; newValue: string | null };
            if (!ev.key?.startsWith(`${s.storageKey}.`) || !ev.newValue) return;
            try {
              incoming(JSON.parse(ev.newValue));
            } catch {
              /* foreign value */
            }
          });
        }
      },
      handle(step: UserStep, intent: number) {
        const field = String(step.args?.field ?? s.fields[0]!.name);
        const value: Val = s.kind === "read" ? Number(vals()[field] ?? 0) + 1 : String(step.ui.value ?? "");
        localSeq++;
        meta.set(field, { ts: env.clientNow(), dirty: true });
        kit.write(S, (p) => ({ ...p, [F.values]: { ...(p[F.values] as Record<string, Val>), [field]: value } }), { role: "input", intent, key: `${s.id}.${field}` });
        if (!s.persistMs) persist(field);
        else {
          if (timers.get(field)) env.clearTimeout(timers.get(field));
          timers.set(field, env.setTimeout(() => persist(field), s.persistMs));
        }
        if (s.server === "save") {
          if (saveTimer) env.clearTimeout(saveTimer);
          saveTimer = env.setTimeout(() => {
            saveTimer = null;
            kit.spawn(() => save(intent), "swallow");
          }, s.saveMs);
        }
      },
      cond() {
        return saving > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    let t = win.t0 + user.think(1);
    let text = "";
    while (t < win.t1 - 1000) {
      const f = user.rng.pick(s.fields);
      const intent = { kind: s.kind === "read" ? "read" : "set", key: `${s.id}.${f.name}`, mode: s.kind === "read" ? ("accumulate" as const) : ("replace" as const), accidental: false };
      if (s.kind === "prefs") {
        steps.push({ t, feature: s.id, action: "set", ui: { kind: "change", target: f.label, value: user.rng.pick(f.options) }, args: { field: f.name }, intent });
      } else if (s.kind === "draft") {
        const add = `${text ? " " : ""}${user.rng.pick(f.options.length ? f.options : ["note"])}`;
        const typed = user.type(t, text, add, f.label, "type", `${s.id}.${f.name}`, { field: f.name });
        steps.push(...typed.steps);
        t = typed.t;
        text = typed.steps.length ? String(typed.steps[typed.steps.length - 1]!.ui.value) : text;
      } else {
        for (let k = user.rng.int(1, 4); k > 0; k--) {
          steps.push({ t, feature: s.id, action: "read", ui: { kind: "click", target: f.label }, args: { field: f.name }, intent });
          t += user.rng.float(250, 1200);
        }
      }
      t += user.think(1.5);
    }
    return steps;
  },
  external(s, rng, win, steps) {
    const out: ExternalEvent[] = [];
    const plan: { t: number; field: string; value: Val; lagMs: number }[] = [];
    let otherText = "";
    let otherRead = Number(s.init[s.fields[0]!.name] ?? 0);
    const pickValue = (f: MultitabSpec["fields"][number]): Val => {
      if (s.kind === "prefs") return rng.pick(f.options);
      if (s.kind === "read") return (otherRead += rng.int(-2, 4));
      return (otherText += `${otherText ? " " : ""}${rng.pick(f.options.length ? f.options : ["note"])}`);
    };
    for (let i = 0; i < s.otherEvents; i++) {
      const f = rng.pick(s.fields);
      const t = rng.float(win.t0 + 500, win.t1);
      // A throttled background tab flushes a change it made a while ago (old timestamp).
      const lagMs = rng.bool(0.3) ? rng.float(2000, 20000) : 0;
      if (s.kind === "draft") {
        // The draft open in the other tab: a typing burst, one storage write per keystroke.
        let tt = t;
        for (let k = rng.int(3, 9); k > 0; k--) {
          plan.push({ t: tt, field: f.name, value: pickValue(f), lagMs });
          tt += rng.float(110, 300);
        }
      } else plan.push({ t, field: f.name, value: pickValue(f), lagMs });
    }
    // The user changes the same thing in the other tab right after this one (competing changes).
    for (const st of steps) {
      if (st.intent.accidental || !rng.bool(0.12)) continue;
      const f = s.fields.find((x) => x.name === st.args?.field) ?? s.fields[0]!;
      plan.push({ t: st.t + rng.float(40, 900), field: f.name, value: pickValue(f), lagMs: 0 });
    }
    for (const p of plan) {
      out.push({
        t: p.t,
        feature: s.id,
        desc: `another tab writes ${p.field}${p.lagMs ? " (late flush)" : ""}`,
        apply(w) {
          const payload = { field: p.field, value: p.value, ts: AppEnv.EPOCH + Math.max(0, w.now() - p.lagMs), tab: "tab-other" };
          if (s.server !== "none") w.db.writeDoc(`${s.id}:state`, { [p.field]: p.value }, w.now());
          if (s.transport === "storage") w.otherTab.setItem(`${s.storageKey}.${p.field}`, JSON.stringify(payload));
          else w.otherTab.broadcast(s.channel, payload);
        },
      });
    }
    return out;
  },
};
