// The harness's view inside the page: a recording DecisionProvider (forces actions by decision index, explores in
// the base run), runtime hooks that correlate runtime ops/mutations with harness steps, WebSocket messages and mock
// network requests, a plugin that snapshots the registered stores, DOM text snapshots, error episodes, and the
// diagnosis label computed from harness knowledge at decision time (src/world/diagnose.ts).

import type { DecisionRec, NetRec, RunConfig, SnapshotRec, Step } from "../shared/types.js";
import { diagnose } from "./diagnose.js";
import type { VirtualLoop } from "./loop.js";
import type { Network } from "./net.js";
import type { NetApi } from "./netapi.js";
import { hashAll, type MockServer } from "./server.js";

import { PASSIVE as RT_PASSIVE } from "@rt/questions";

/** Passive action per trigger, from the runtime build in use (new triggers: the first offered action). */
export const PASSIVE: Record<string, string> = { ...(RT_PASSIVE as Record<string, string>) };
export function passiveOf(trigger: string, actions: string[]): string {
  return PASSIVE[trigger] || actions[0] || "";
}

export interface OpLite {
  id: number;
  kind: string;
  name: string;
  cause?: number;
  root?: number;
  start: number;
  end?: number;
  status?: string;
  code?: number | string;
  attempt: number;
  identity?: string;
  method?: string;
  url?: string;
  detail?: string;
}

export interface UserOpInfo {
  step: number;
  sub: number;
  t: number;
}

export interface WsInfo {
  topic: string;
  msg: Record<string, unknown>;
  t: number;
}

export interface WriteInfo {
  id: number;
  store: string;
  paths: string[];
  cause?: number;
  t: number;
  /** Per path: ids of the list elements this write changes (added/removed/changed), or "*" (the whole field). */
  keys?: Record<string, string[] | "*">;
}

/** Which elements of a list field a change touches, by element identity; "*" when not a keyed list. */
export function changedKeys(before: unknown, after: unknown): string[] | "*" {
  const isObj = (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x);
  if (isObj(before) && isObj(after)) {
    // a keyed collection (normalised byId map): the keys whose values differ
    const a = before as Record<string, unknown>;
    const b = after as Record<string, unknown>;
    const out: string[] = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
    return out;
  }
  if (!Array.isArray(before) || !Array.isArray(after)) return "*";
  const idOf = (x: unknown): string | undefined => {
    if (!x || typeof x !== "object") return undefined;
    const o = x as Record<string, unknown>;
    const k = o.id ?? o.key ?? o.slug ?? o.clientId ?? o._id ?? o.uuid;
    return k === undefined || k === null ? undefined : String(k);
  };
  const m = new Map<string, string>();
  for (const x of before) {
    const k = idOf(x);
    if (k === undefined) return "*";
    m.set(k, JSON.stringify(x));
  }
  const out = new Set<string>();
  const seen = new Set<string>();
  for (const x of after) {
    const k = idOf(x);
    if (k === undefined) return "*";
    seen.add(k);
    if (m.get(k) !== JSON.stringify(x)) out.add(k);
  }
  for (const k of m.keys()) if (!seen.has(k)) out.add(k);
  return [...out];
}

export function keysOverlap(a: string[] | "*" | undefined, b: string[] | "*" | undefined): boolean {
  if (a === undefined || b === undefined || a === "*" || b === "*") return true;
  const s = new Set(a);
  return b.some((k) => s.has(k));
}

function safeJson(v: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const s = JSON.stringify(v, (_k, x) => {
      if (typeof x === "function" || typeof x === "symbol") return undefined;
      if (typeof x === "bigint") return String(x);
      if (x && typeof x === "object") {
        if (seen.has(x)) return undefined;
        seen.add(x);
        if (x instanceof Map) return Object.fromEntries(x);
        if (x instanceof Set) return [...x];
        if (typeof Node !== "undefined" && x instanceof Node) return undefined;
      }
      return x;
    });
    return s === undefined ? "null" : s.length > 400_000 ? JSON.stringify({ __truncated: s.length }) : s;
  } catch {
    return "null";
  }
}

/** Elements whose text starts and ends a line in DOM snapshots. */
const BLOCK = /^(DIV|P|LI|TR|TD|TH|H[1-6]|SECTION|ARTICLE|HEADER|FOOTER|NAV|MAIN|ASIDE|UL|OL|TABLE|FORM|LABEL|BUTTON|A|OPTION|DT|DD|FIGCAPTION|SUMMARY|DETAILS|DIALOG)$/;

/** Store fields that hold an error message for the user (by name). */
const ERROR_FIELD = /(^|[._])(errors?|err|errorMessage|errorMsg|alert|failure|failed|problem)$/i;
function isEmptyish(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

export class Probe {
  /** Times of proposed writes that put an error message into a store (shown-error episodes of store apps). */
  errorWrites: number[] = [];
  /** Times of user steps skipped because their element never appeared. */
  skippedAt: number[] = [];
  // knowledge -------------------------------------------------------------------------------------------
  ops = new Map<number, OpLite>();
  userOps = new Map<number, UserOpInfo>();
  wsOps = new Map<number, WsInfo>();
  netOfOp = new Map<number, NetRec>();
  private initOps = new WeakMap<object, number[]>();
  private opInit = new Map<number, object>();
  private xhrUnbound: number[] = [];
  writes = new Map<number, WriteInfo>();
  userFieldTime = new Map<string, number>();
  /** User writes per path: time and the elements they changed (most recent last, bounded). */
  userWrites = new Map<string, { t: number; keys: string[] | "*" }[]>();
  private userMutations = new Set<number>();
  addUserWrite(path: string, t: number, keys: string[] | "*"): void {
    this.userFieldTime.set(path, t);
    const l = this.userWrites.get(path) ?? [];
    l.push({ t, keys });
    if (l.length > 40) l.splice(0, l.length - 40);
    this.userWrites.set(path, l);
  }
  /** Actual dispatch time per (step, sub). */
  subTimes = new Map<string, number>();
  stepsRan: { i: number; t: number }[] = [];
  stepsSkipped = 0;
  current: { step: Step; sub: number } | null = null;
  currentWs: WsInfo | null = null;
  /** sig -> consecutive failures seen by the app (delivered). */
  streak = new Map<string, number>();
  // decisions ---------------------------------------------------------------------------------------------
  decisions: DecisionRec[] = [];
  /** delivery decisions waiting for their first write (op id -> record). */
  pendingDelivery = new Map<number, DecisionRec>();
  private k = 0;
  private forced: Map<number, string>;
  // snapshots ---------------------------------------------------------------------------------------------
  api: { stores: { names(): string[]; get(n: string): unknown } } | null = null;
  /** The runtime (from the plugin API), for ask probes. */
  rt: { situation(t?: string): { state: Record<string, unknown> } } | null = null;
  private dirtyStores = new Set<string>();
  private allDirty = true;
  private lastStores = new Map<string, string>();
  private lastDom: string[] = [];
  private lastErr = 0;
  snapshots: SnapshotRec[] = [];
  initial: SnapshotRec = { t: 0, s: {}, d: [], e: 0 };
  private initialFrozen = false;
  errorEpisodes: number[] = [];
  uncaught: number[] = [];
  serverTimeline: { t: number; server: ReturnType<MockServer["snapshot"]> }[] = [];
  private lastServerWrites = -1;
  mo: MutationObserver | null = null;
  domDirty = true;
  wsMessages = 0;

  constructor(
    readonly w: Window & typeof globalThis,
    readonly cfg: RunConfig,
    readonly loop: VirtualLoop,
    readonly net: Network,
    readonly netApi: NetApi,
    readonly server: MockServer,
  ) {
    this.forced = new Map(cfg.forced);
  }

  // ------------------------------------------------------------------------------------------ correlation
  rootUser(opId: number | undefined): UserOpInfo | undefined {
    let cur = opId;
    for (let i = 0; i < 24 && cur !== undefined; i++) {
      const u = this.userOps.get(cur);
      if (u) return u;
      cur = this.ops.get(cur)?.cause;
    }
    return undefined;
  }

  rootWs(opId: number | undefined): WsInfo | undefined {
    let cur = opId;
    for (let i = 0; i < 24 && cur !== undefined; i++) {
      const u = this.wsOps.get(cur);
      if (u) return u;
      cur = this.ops.get(cur)?.cause;
    }
    return undefined;
  }

  /** Ops in the causal chain from `opId` to its root (inclusive). */
  chain(opId: number | undefined): OpLite[] {
    const out: OpLite[] = [];
    let cur = opId;
    for (let i = 0; i < 24 && cur !== undefined; i++) {
      const o = this.ops.get(cur);
      if (!o) break;
      out.push(o);
      cur = o.cause;
    }
    return out;
  }

  /** Network records of the requests in a chain (and runtime retries/hedges of them). */
  netsOfChain(opId: number | undefined): NetRec[] {
    const out: NetRec[] = [];
    for (const o of this.chain(opId)) {
      const r = this.netOfOp.get(o.id);
      if (r) out.push(r);
    }
    return out;
  }

  /** Steps as actually performed (an alternative or a recovery step replaces the scheduled one). */
  actualSteps = new Map<number, Step>();
  stepOf(i: number): Step | undefined {
    return this.actualSteps.get(i) ?? this.cfg.steps[i];
  }

  hooks() {
    return {
      opCreated: (op: OpLite) => {
        this.ops.set(op.id, op);
        if (op.kind === "user" && this.current) this.userOps.set(op.id, { step: this.current.step.i, sub: this.current.sub, t: this.loop.now });
        if (op.kind === "ws" && this.currentWs && /^WS message/.test(op.name)) this.wsOps.set(op.id, this.currentWs);
        if (op.kind === "fetch") {
          const init = this.netApi.currentInit();
          if (init) {
            const l = this.initOps.get(init) ?? [];
            l.push(op.id);
            this.initOps.set(init, l);
            this.opInit.set(op.id, init);
          } else if (op.cause !== undefined && this.opInit.has(op.cause)) {
            const init2 = this.opInit.get(op.cause)!;
            this.initOps.get(init2)!.push(op.id);
            this.opInit.set(op.id, init2);
          }
        }
        if (op.kind === "xhr") this.xhrUnbound.push(op.id);
        if (this.ops.size > 6000) {
          // keep memory bounded on long sessions: drop the oldest ended ops nobody refers to
          let n = 0;
          for (const [id, o] of this.ops) {
            if (n++ > 2000) break;
            if (o.end !== undefined && !this.userOps.has(id) && !this.wsOps.has(id)) this.ops.delete(id);
          }
        }
      },
      mutationProposed: (m: { id: number; store: string; paths: string[]; cause?: number; changes?: { path: string; before: unknown; after: unknown }[] }) => {
        for (const c of m.changes ?? []) {
          if (ERROR_FIELD.test(c.path) && isEmptyish(c.before) && !isEmptyish(c.after)) {
            this.errorWrites.push(this.loop.now);
            break;
          }
        }
        const keys: Record<string, string[] | "*"> = {};
        for (const c of m.changes ?? []) {
          try {
            keys[c.path] = changedKeys(c.before, c.after);
          } catch {
            keys[c.path] = "*";
          }
        }
        const wi: WriteInfo = { id: m.id, store: m.store, paths: m.paths.slice(0, 16), t: this.loop.now, keys, ...(m.cause !== undefined ? { cause: m.cause } : {}) };
        // a delivery decision is diagnosed by the first write its response or message makes (mutation rules)
        if (m.cause !== undefined && this.pendingDelivery.size) {
          for (const o of this.chain(m.cause)) {
            const rec = this.pendingDelivery.get(o.id);
            if (!rec) continue;
            this.pendingDelivery.delete(o.id);
            try {
              const d = diagnose(this, "mutation", { mutation: m.id, cause: m.cause }, this.loop.now);
              if (d.label && (rec.diagWhy === "rel-check" || rec.diagnosis === undefined)) {
                if (d.label !== "expected" || d.why !== "rel-check") {
                  rec.diagnosis = d.label;
                  rec.diagWhy = `write:${d.why}`;
                } else rec.diagWhy = "rel-check";
                if (d.trace) rec.diagTrace = d.trace;
              }
            } catch {
              /* keep the delivery verdict */
            }
            break;
          }
        }
        if (m.cause !== undefined && this.ops.get(m.cause)?.kind === "user") {
          this.userMutations.add(m.id);
          for (const p of m.paths) this.addUserWrite(p, this.loop.now, keys[p] ?? "*");
        }
        this.writes.set(m.id, wi);
        if (this.writes.size > 4000) {
          const first = this.writes.keys().next().value;
          if (first !== undefined) this.writes.delete(first);
        }
      },
    };
  }

  onSend(rec: NetRec, ctx: { init?: object; xhr?: object }): void {
    let opId: number | undefined;
    if (ctx.init) {
      const l = this.initOps.get(ctx.init);
      if (l) opId = l.find((id) => !this.netOfOp.has(id));
    } else if (ctx.xhr) {
      const abs = (u: string | undefined) => {
        try {
          return new URL(u ?? "", this.w.location.origin + "/").pathname + new URL(u ?? "", this.w.location.origin + "/").search;
        } catch {
          return u ?? "";
        }
      };
      const idx = this.xhrUnbound.findIndex((id) => {
        const o = this.ops.get(id);
        return !!o && o.end === undefined && (o.method ?? "GET").toUpperCase() === rec.method && abs(o.url) === rec.url;
      });
      if (idx >= 0) {
        opId = this.xhrUnbound[idx];
        this.xhrUnbound.splice(idx, 1);
      }
    }
    if (opId === undefined) return;
    this.netOfOp.set(opId, rec);
    rec.rtOp = opId;
    const u = this.rootUser(opId);
    if (u) rec.step = u.step;
  }

  onSettle(rec: NetRec): void {
    const fail = rec.outcome === "neterr" || rec.outcome === "timeout" || rec.outcome === "hang" || (rec.status !== undefined && (rec.status >= 500 || rec.status === 429 || rec.status === 408));
    if (rec.outcome === "aborted") return;
    this.streak.set(rec.sig, fail ? (this.streak.get(rec.sig) ?? 0) + 1 : 0);
  }

  // ---------------------------------------------------------------------------------------------- decider
  decider() {
    const self = this;
    return {
      status: { state: "ready", model: "realapps-recorder" },
      ready: () => Promise.resolve(),
      evaluate(req: { trigger: string; state: Record<string, unknown>; questions: Record<string, { type: string; criteria?: unknown }>; subject?: Record<string, unknown> }) {
        return self.evaluate(req);
      },
    };
  }

  private evaluate(req: { trigger: string; state: Record<string, unknown>; questions: Record<string, { type: string; criteria?: unknown }>; subject?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const idx = this.k++;
    const t = this.loop.now;
    const aq = req.questions.action;
    const actions = aq && aq.type === "choice" ? Object.keys(aq.criteria as object) : [];
    const passive = passiveOf(req.trigger, actions);
    let diag: { label?: string; why: string } = { why: "error" };
    try {
      diag = diagnose(this, req.trigger, req.subject ?? {}, t);
    } catch (e) {
      diag = { why: `diagnose-error ${String((e as Error)?.message ?? e).slice(0, 80)}` };
    }
    let chosen = this.forced.get(idx);
    let explored = false;
    if (chosen === undefined && this.cfg.explore > 0) {
      const others = actions.filter((a) => a !== passive);
      const p = diag.label && diag.label !== "expected" ? this.cfg.explore : this.cfg.explore / 4;
      if (others.length && hashAll(this.cfg.seed, "explore", idx) / 4294967296 < p) {
        chosen = others[hashAll(this.cfg.seed, "explore-pick", idx) % others.length]!;
        explored = true;
      }
    }
    if (chosen === undefined || !actions.includes(chosen)) chosen = actions.includes(passive) ? passive : actions[0] ?? passive;
    const fpText = JSON.stringify([req.trigger, req.state, req.questions]);
    const fp = `${hashAll(fpText).toString(36)}.${hashAll(fpText, 7).toString(36)}.${fpText.length}`;
    if (this.cfg.record || idx <= this.cfg.fpUpTo) {
      const subj = req.subject ?? {};
      const s: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(subj)) if (k !== "error") s[k] = v;
      if (subj.error) s.error = String((subj.error as Error)?.message ?? subj.error).slice(0, 200);
      const rec: DecisionRec = { k: idx, t, trigger: req.trigger, actions, chosen, explored, fp, subject: s, ...(diag.label ? { diagnosis: diag.label } : {}), diagWhy: diag.why, ...(diag.trace ? { diagTrace: diag.trace } : {}) };
      if (this.cfg.record) {
        rec.state = req.state;
        rec.questions = req.questions as Record<string, unknown>;
      }
      // S1 inputs (labels are finished in Node): does the subject repeat an accidental user step; is there an
      // identical request in flight or just answered
      const subjOp = (subj.op as number | undefined) ?? (subj.cause as number | undefined) ?? (subj.mutation !== undefined ? this.writes.get(subj.mutation as number)?.cause : undefined);
      const u = subjOp !== undefined ? this.rootUser(subjOp) : undefined;
      const ust = u ? this.stepOf(u.step) : undefined;
      if (ust && (ust.accidental || ust.repeatOf !== undefined)) rec.repeat = true;
      if (req.trigger === "request" && subjOp !== undefined) {
        const op = this.ops.get(subjOp);
        if (op) {
          let url = op.url ?? "";
          try {
            const x = new URL(url, this.w.location.origin + "/");
            url = x.pathname + x.search;
          } catch {
            /* keep */
          }
          const method = (op.method ?? "GET").toUpperCase();
          rec.twin = this.net.log.some((r) => r.method === method && r.url === url && r.rtOp !== op.id && (r.td === undefined || t - r.td < 10000));
        }
      }
      if (req.trigger === "delivery" && subjOp !== undefined && (rec.diagWhy === "rel-check" || rec.diagnosis === undefined)) this.pendingDelivery.set(subjOp, rec);
      this.decisions.push(rec);
    }
    // the counterfactual future starts once decision k is answered: later draws use the future's salt
    if (this.cfg.future && idx === this.cfg.future.k) this.net.salt = this.cfg.future.salt;
    const answers: Record<string, unknown> = {};
    for (const [qid, q] of Object.entries(req.questions)) {
      if (q.type !== "choice") continue;
      const keys = Object.keys(q.criteria as object);
      const pick = qid === "action" ? chosen : qid === "diagnosis" ? (diag.label && keys.includes(diag.label) ? diag.label : keys[0]!) : keys[0]!;
      const probabilities: Record<string, number> = {};
      for (const kk of keys) probabilities[kk] = kk === pick ? 1 : 0;
      answers[qid] = { type: "choice", choice: pick, confidence: 1, probabilities };
    }
    const salt = this.cfg.future && idx > this.cfg.future.k ? this.cfg.future.salt : 0;
    const u = Math.max(1e-9, hashAll(this.cfg.seed, "model-latency", idx, salt) / 4294967296);
    const v = hashAll(this.cfg.seed, "model-latency2", idx, salt) / 4294967296;
    const ms = this.cfg.modelMs * Math.exp(0.35 * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
    return new Promise((resolve) => this.loop.schedule(ms, () => resolve(answers), "decide"));
  }

  // ----------------------------------------------------------------------------------------------- plugin
  plugin() {
    const self = this;
    return {
      name: "realapps-probe",
      setup(api: { runtime?: unknown; stores: { names(): string[]; get(n: string): unknown }; on(t: string, fn: (e: { kind: string; name: string; data?: Record<string, unknown> }) => void): () => void }) {
        self.api = api;
        self.rt = (api.runtime as Probe["rt"]) ?? null;
        api.on("event", (e) => {
          if (e.kind !== "state") return;
          self.dirtyStores.add(String(e.data?.store ?? e.name));
          // a write made by a user action (directly on a guarded/adapter store too): the user changed these fields
          // writes made outside the pipeline (guarded/adapter stores mutated directly) only show up here
          const op = (e as { op?: number }).op;
          const mid = e.data?.mutation as number | undefined;
          if ((e.data?.user || (op !== undefined && self.ops.get(op)?.kind === "user")) && !(mid !== undefined && self.userMutations.has(mid)))
            for (const p of (e.data?.paths as string[] | undefined) ?? []) self.addUserWrite(p, self.loop.now, "*");
        });
      },
    };
  }

  /** Elements matching `sel` in the document and inside every open shadow root. */
  deepAll(sel: string): Element[] {
    const out: Element[] = [];
    const visit = (root: ParentNode) => {
      try {
        out.push(...Array.from(root.querySelectorAll(sel)));
      } catch {
        return;
      }
      for (const el of Array.from(root.querySelectorAll("*"))) {
        const sr = (el as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
        if (sr) visit(sr);
      }
    };
    visit(this.w.document);
    return out;
  }

  /** Visible text of an element including open shadow roots (innerText skips shadow content). */
  private deepText(root: Element): string {
    const sr = (root as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
    const parts: string[] = [];
    const walk = (n: Node) => {
      if (n.nodeType === 3) {
        const t = (n.textContent ?? "").trim();
        if (t) parts.push(t);
        return;
      }
      if (n.nodeType !== 1 && n.nodeType !== 11) return;
      const el = n as HTMLElement;
      if (n.nodeType === 1) {
        const tag = el.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE") return;
        if (el.hidden) return;
        if (el.getClientRects().length === 0 && tag !== "SLOT" && this.w.getComputedStyle(el).display === "none") return;
        const shadow = (el as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
        if (shadow) {
          walk(shadow);
          return;
        }
        if (tag === "SELECT") {
          // a closed select shows its selected option only
          const o = (el as HTMLSelectElement).selectedOptions?.[0];
          if (o) parts.push("\n", (o.textContent ?? "").trim(), "\n");
          return;
        }
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        if (BLOCK.test(tag)) parts.push("\n");
      }
      for (const c of Array.from(n.childNodes)) walk(c);
      if (n.nodeType === 1 && BLOCK.test(el.tagName)) parts.push("\n");
    };
    walk(sr ?? root);
    return parts.join(" ").replace(/ *\n */g, "\n");
  }

  /** Set once any shadow root was attached (then text walks into shadow roots). */
  hasShadow = false;

  private domLines(): string[] {
    const root = this.w.document.querySelector(this.cfg.domRoot) ?? this.w.document.body;
    if (!root) return [];
    const txt = this.deepText(root);
    const errText = new Set<string>();
    try {
      for (const e of this.hasShadow ? this.deepAll(this.cfg.errorSelector) : Array.from(this.w.document.querySelectorAll(this.cfg.errorSelector)))
        for (const l of this.deepText(e).split("\n")) {
          const x = l.replace(/\s+/g, " ").trim();
          if (x) errText.add(x);
        }
    } catch {
      /* bad selector */
    }
    const out: string[] = [];
    for (const l of txt.split("\n")) {
      const s = l.replace(/\s+/g, " ").trim();
      if (s && !errText.has(s)) out.push(s.length > 160 ? s.slice(0, 160) : s);
      if (out.length >= 400) break;
    }
    return out;
  }

  /** After every virtual task: record a snapshot of whatever changed. */
  taskEnd(): void {
    const t = this.loop.now;
    // server timeline: the cost compares the server at decision time + horizon (ideal run, and the base run when it
    // stands in for the passive counterfactual)
    if ((this.cfg.ideal || this.cfg.record) && this.server.writes !== this.lastServerWrites) {
      this.lastServerWrites = this.server.writes;
      this.serverTimeline.push({ t, server: this.server.snapshot() });
    }
    const domDirty = this.domDirty || (this.mo ? this.mo.takeRecords().length > 0 : false);
    this.domDirty = false;
    if (!domDirty && !this.dirtyStores.size && !this.allDirty) return;
    const snap: SnapshotRec = { t };
    let changed = false;
    if (this.api && (this.dirtyStores.size || this.allDirty)) {
      const names = this.allDirty ? this.api.stores.names() : [...this.dirtyStores];
      for (const n of names) {
        if (n.startsWith("__")) continue;
        const j = safeJson(this.api.stores.get(n));
        if (this.lastStores.get(n) !== j) {
          this.lastStores.set(n, j);
          (snap.s ??= {})[n] = j;
          changed = true;
        }
      }
    }
    this.dirtyStores.clear();
    this.allDirty = false;
    if (domDirty) {
      const d = this.domLines();
      if (d.length !== this.lastDom.length || d.some((x, i) => x !== this.lastDom[i])) {
        this.lastDom = d;
        snap.d = d;
        changed = true;
      }
      let e = 0;
      try {
        const els = this.hasShadow ? this.deepAll(this.cfg.errorSelector) : Array.from(this.w.document.querySelectorAll(this.cfg.errorSelector));
        // shown errors only: hidden placeholders and empty alert regions do not count
        e = els.filter((x) => !(x as HTMLElement).hidden && x.getClientRects().length > 0 && (x.textContent ?? "").trim() !== "").length;
      } catch {
        e = 0;
      }
      if (e !== this.lastErr) {
        if (this.lastErr === 0 && e > 0) this.errorEpisodes.push(t);
        this.lastErr = e;
        snap.e = e;
        changed = true;
      }
    }
    if (!changed) return;
    if (t < this.cfg.snapFrom) {
      // fold into the initial (full) state
      Object.assign((this.initial.s ??= {}), snap.s ?? {});
      if (snap.d) this.initial.d = snap.d;
      if (snap.e !== undefined) this.initial.e = snap.e;
      this.initial.t = t;
      return;
    }
    if (!this.initialFrozen) this.initialFrozen = true;
    this.snapshots.push(snap);
  }

  markAllDirty(): void {
    this.allDirty = true;
  }
}
