// Master-detail: a list, the selected item's detail fetched on select, and an edit form saved with PUT. Knobs:
// detail response guard (check the selected id before applying / abort the previous load on switch / none: the
// detail of A arriving after B was selected is shown under B), save echo target (only into the item it was saved
// for and only if the form did not change since; or blindly into whatever form is open: A's saved values land in
// B's form, and the next save writes them to B), unsaved edits on switch (autosave, keep a per-item draft, or
// discard), save button disabled while saving. Relation: the detail shown belongs to the selected row.

import type { Item } from "../../net/server.js";
import type { SimOp } from "../../oracle/knowledge.js";
import type { Rng } from "../../rng.js";
import { rel, type ExternalEvent, type FeatureDef, type UserStep } from "../feature.js";
import { title } from "../naming.js";
import { apiOf, errMsg, seedItems, weightsOf } from "./common.js";

export interface MasterDetailSpec {
  id: string;
  api: string;
  listStore: string;
  detailStore: string;
  f: { items: string; selected: string; loading: string; detail: string; draft: string; dirty: string; saving: string; error: string };
  coll: string;
  nameField: string;
  notesField: string;
  items: Item[];
  paths: { list: string; item: string };
  guard: "check" | "abort" | "none";
  echo: "check" | "blind";
  onSwitch: "autosave" | "keep" | "discard";
  disable: boolean;
  labels: { row: string; save: string; name: string; notes: string };
  words: string[];
  externalEdits: number;
}

function knob<T>(rng: Rng, clean: boolean | undefined, good: T, opts: readonly (readonly [T, number])[]): T {
  const v = rng.weighted(opts);
  return clean ? good : v;
}

export const masterdetail: FeatureDef<MasterDetailSpec> = {
  kind: "masterdetail",
  make({ rng, clean, entity, naming, id, api }) {
    const notesField = naming.word(rng.pick(["notes", "description", "summary", "comment"]));
    return {
      id,
      api: api.name,
      listStore: naming.store(entity.p, rng.pick(["list", "index", "table"])),
      detailStore: naming.store(entity.s, rng.pick(["detail", "editor", "panel", "inspector"])),
      f: { items: naming.field("list", id), selected: naming.field("selected", id), loading: naming.field("loading", id), detail: rng.pick(["detail", "record", "item", "entity"]), draft: naming.field("draft", id), dirty: rng.pick(["dirty", "isDirty", "unsaved", "changed"]), saving: naming.field("saving", id), error: naming.field("error", id) },
      coll: entity.p,
      nameField: entity.name,
      notesField,
      items: seedItems(rng, entity, rng.int(5, 14), (it) => { it[notesField] = `${rng.pick(entity.words)} ${rng.pick(entity.words)}`; }),
      paths: { list: naming.route(entity.p), item: naming.route(entity.p, ":id") },
      guard: knob(rng, clean, "check", [["check", 2], ["abort", 2], ["none", 3]] as const),
      echo: knob(rng, clean, "check", [["check", 1], ["blind", 1]] as const),
      onSwitch: knob(rng, clean, "autosave", [["autosave", 2], ["keep", 2], ["discard", 2]] as const),
      disable: knob(rng, clean, true, [[true, 1], [false, 1]] as const),
      labels: { row: `row "${title(entity.s)}`, save: `button "${rng.pick(["Save", "Save changes", "Update"])}"`, name: `input "${title(entity.name)}"`, notes: `textarea "${title(notesField)}"` },
      words: entity.words,
      externalEdits: rng.int(0, 4),
    };
  },
  pattern(s) {
    return [`guard:${s.guard}`, `echo:${s.echo}`, `switch:${s.onSwitch}`, s.disable ? "disable" : "nodisable"];
  },
  relations(s) {
    const D = `${s.detailStore}.${s.f.detail}`;
    const Sel = `${s.listStore}.${s.f.selected}`;
    return [{ fields: [D, Sel], desc: "detail shown is the selected item", check: (st) => {
      const d = rel.field(st, D) as Item | null;
      return !d || String(d.id) === String(rel.field(st, Sel));
    } }];
  },
  server(s, srv, db) {
    const api = apiOf(s.api);
    const coll = `${s.id}:${s.coll}`;
    for (const it of s.items) db.insert(coll, it, `seed:${JSON.stringify(it)}`);
    const meta = { feature: s.id, resource: `c:${coll}` };
    srv.route("GET", s.paths.list, () => ({ status: 200, body: api.list(db.list(coll).map((it) => ({ id: it.id!, [s.nameField]: it[s.nameField]!, status: it.status ?? null }))) }), { ...meta, kind: "read", idempotent: true });
    srv.route("GET", s.paths.item, (req) => {
      const it = db.get(coll, req.params.id!);
      return it ? { status: 200, body: api.one(it) } : { status: 404, body: api.error("not_found", "gone") };
    }, { ...meta, kind: "read", idempotent: true });
    srv.route("PUT", s.paths.item, (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const patch: Item = {};
      for (const f of [s.nameField, s.notesField]) if (typeof b[f] === "string") patch[f] = b[f] as string;
      const it = db.update(coll, req.params.id!, patch, req.t);
      return it ? { status: 200, body: api.one(it) } : { status: 404, body: api.error("not_found", "gone") };
    }, { ...meta, kind: "write", idempotent: true });
  },
  client(s, env, kit) {
    const F = s.f;
    const editable = (it: Item) => ({ [s.nameField]: String(it[s.nameField] ?? ""), [s.notesField]: String(it[s.notesField] ?? "") });
    const L = env.store(s.listStore, s.id, { [F.items]: [] as Item[], [F.selected]: null, [F.loading]: false } as Record<string, unknown>, {
      weights: weightsOf([[F.items, 1], [F.selected, 0.5], [F.loading, 0.1]]),
      resync: () => loadList(),
    });
    const D = env.store(s.detailStore, s.id, { [F.detail]: null, [F.draft]: {}, [F.dirty]: false, [F.saving]: false, [F.error]: null } as Record<string, unknown>, {
      weights: weightsOf([[F.detail, 1], [F.draft, 0.4], [F.dirty, 0.2], [F.saving, 0.1], [F.error, 0]]),
      resync: () => {
        const sel = L.get()[F.selected];
        if (sel) loadDetail(String(sel), undefined);
      },
    });
    const drafts = new Map<string, Record<string, string>>();
    let ctl: AbortController | null = null;
    let saving = 0;
    const selected = () => (L.get()[F.selected] === null ? null : String(L.get()[F.selected]));
    const shownId = () => ((D.get()[F.detail] as Item | null)?.id ?? null);
    async function loadList(): Promise<void> {
      const op = kit.op({ role: "load", method: "GET", url: s.paths.list, key: `${s.id}.list`, background: true });
      const r = await kit.call(op);
      if (r.ok) kit.write(L, (p) => ({ ...p, [F.items]: kit.api.unlist(r.body).items }), { role: "load", op, key: `${s.id}.list` });
    }
    function loadDetail(id: string, intent: number | undefined): void {
      if (s.guard === "abort" && ctl) ctl.abort();
      const myCtl = s.guard === "abort" ? new AbortController() : null;
      ctl = myCtl;
      const op = kit.op({ role: "detail", method: "GET", url: s.paths.item.replace(":id", id), key: `${s.id}.selected`, background: intent === undefined, ...(intent !== undefined ? { intent } : {}) });
      kit.write(L, (p) => ({ ...p, [F.loading]: true }), { role: "loading", key: `${s.id}.selected`, ...(intent !== undefined ? { intent } : {}) });
      kit.spawn(async () => {
        const r = await kit.call(op, { timeoutMs: 9000, ...(myCtl ? { signal: myCtl.signal } : {}) });
        if (r.outcome === "aborted" || (s.guard === "check" && selected() !== id)) return;
        kit.write(L, (p) => ({ ...p, [F.loading]: false }), { role: "loading", op, key: `${s.id}.selected` });
        if (!r.ok) {
          kit.write(D, (p) => ({ ...p, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, key: `${s.id}.selected` });
          kit.shownError();
          return;
        }
        const it = kit.api.unone(r.body);
        const verdict = selected() !== id ? "stale" : intent !== undefined && env.know.superseded(intent) ? "expected" : undefined;
        const kept = drafts.get(id);
        kit.write(D, (p) => ({ ...p, [F.detail]: it, [F.draft]: kept ?? editable(it), [F.dirty]: !!kept, [F.error]: null }), { role: "load", op, key: `${s.id}.selected`, classify: () => verdict, ...(intent !== undefined ? { intent } : {}) });
      }, "uncaught", { cause: "detail-failed", diagnosis: "failing", op });
    }
    function save(intent: number, id: string | null, draft: Record<string, string>): void {
      if (!id || (s.disable && saving > 0)) return;
      const it = env.know.getIntent(intent);
      saving++;
      kit.write(D, (p) => ({ ...p, [F.saving]: true }), { role: "saving", intent, key: `${s.id}.save` });
      const op: SimOp = kit.op({ role: "save", method: "PUT", url: s.paths.item.replace(":id", id), body: draft, intent, key: `${s.id}.save.${id}`, idempotent: true, ...(it?.accidental ? { dupOf: it.repeatOf } : {}) });
      const sent = JSON.stringify(draft);
      kit.spawn(async () => {
        const r = await kit.call(op, { timeoutMs: 8000 });
        saving--;
        if (!r.ok) {
          kit.write(D, (p) => ({ ...p, [F.saving]: saving > 0, [F.error]: errMsg(r.status, r.outcome) }), { role: "error", op, key: `${s.id}.save` });
          kit.shownError();
          return;
        }
        const echo = kit.api.unone(r.body);
        drafts.delete(id);
        kit.write(L, (p) => ({ ...p, [F.items]: ((p[F.items] as Item[]) ?? []).map((x) => (String(x.id) === id ? { ...x, [s.nameField]: echo[s.nameField] ?? x[s.nameField]! } : x)) }), { role: "echo", op, key: `${s.id}.list` });
        const here = String(shownId()) === id;
        const unchanged = JSON.stringify(D.get()[F.draft]) === sent;
        if (s.echo === "check" && (!here || !unchanged)) {
          kit.write(D, (p) => ({ ...p, [F.saving]: saving > 0, ...(here ? { [F.detail]: echo } : {}) }), { role: "saving", op, key: `${s.id}.save` });
          return;
        }
        const verdict = !here || selected() !== id ? "stale" : !unchanged ? "stale" : undefined;
        kit.write(D, (p) => ({ ...p, [F.detail]: echo, [F.draft]: editable(echo), [F.dirty]: false, [F.saving]: saving > 0, [F.error]: null }), { role: "echo", op, intent, key: `${s.id}.save`, classify: () => verdict });
      }, "uncaught", { cause: "save-failed", diagnosis: "failing", op });
    }
    return {
      init() {
        kit.spawn(loadList, "swallow");
      },
      handle(step: UserStep, intent: number) {
        if (step.action === "select") {
          const items = (L.get()[F.items] as Item[]) ?? [];
          const row = items[Number(step.args?.idx ?? 0) % Math.max(1, items.length)];
          const prev = selected();
          if (!row || String(row.id) === prev) return;
          const d = D.get();
          if (prev && d[F.dirty]) {
            if (s.onSwitch === "autosave") save(intent, prev, { ...(d[F.draft] as Record<string, string>) });
            else if (s.onSwitch === "keep") drafts.set(prev, { ...(d[F.draft] as Record<string, string>) });
          }
          kit.write(L, (p) => ({ ...p, [F.selected]: String(row.id) }), { role: "input", intent, key: `${s.id}.selected` });
          kit.write(D, (p) => ({ ...p, [F.detail]: null, [F.draft]: {}, [F.dirty]: false }), { role: "clear", intent, key: `${s.id}.selected` });
          loadDetail(String(row.id), intent);
        } else if (step.action === "edit") {
          if (!D.get()[F.detail]) return;
          const field = String(step.args?.field);
          kit.write(D, (p) => ({ ...p, [F.draft]: { ...(p[F.draft] as object), [field]: String(step.ui.value ?? "") }, [F.dirty]: true }), { role: "input", intent, key: `${s.id}.draft.${field}` });
        } else if (step.action === "save" && D.get()[F.detail]) save(intent, selected(), { ...(D.get()[F.draft] as Record<string, string>) });
      },
      cond() {
        return saving > 0;
      },
    };
  },
  session(s, user, win) {
    const steps: UserStep[] = [];
    const cur = s.items.map((it) => ({ [s.nameField]: String(it[s.nameField] ?? ""), [s.notesField]: String(it[s.notesField] ?? "") }));
    const pick = (not: number) => {
      const i = user.rng.int(0, s.items.length - 1);
      return i === not ? (i + 1) % s.items.length : i;
    };
    const select = (t: number, idx: number) => steps.push(...user.click(t, `${s.labels.row} ${cur[idx]![s.nameField]}"`, "select", { kind: "select", key: `${s.id}.selected`, mode: "replace" }, { args: { idx }, doubleP: 0.05 }).steps);
    let t = win.t0 + user.think(1);
    let sel = -1;
    while (t < win.t1 - 1500) {
      sel = pick(sel);
      select(t, sel);
      if (user.rng.bool(0.25)) {
        // Scanning: flick through a couple of rows before settling.
        for (let i = 0, n = user.rng.int(1, 2); i < n; i++) {
          t += user.rng.float(200, 650);
          sel = pick(sel);
          select(t, sel);
        }
      }
      t += user.think(0.7);
      if (!user.rng.bool(0.7)) continue;
      const field = user.rng.bool(0.7) ? s.notesField : s.nameField;
      const typed = user.type(t, cur[sel]![field]!, ` ${user.rng.pick(s.words)}`, field === s.notesField ? s.labels.notes : s.labels.name, "edit", `${s.id}.draft.${field}`, { field });
      steps.push(...typed.steps);
      if (typed.steps.length) cur[sel]![field] = String(typed.steps[typed.steps.length - 1]!.ui.value);
      t = typed.t + user.rng.float(150, 800);
      const r = user.rng.next();
      if (r < 0.65) {
        steps.push(...user.click(t, s.labels.save, "save", { kind: "save", key: `${s.id}.save` }, { pendingCond: "saving" }).steps);
        // Often straight on to the next row while the save is still in flight.
        t += user.rng.bool(0.5) ? user.rng.float(100, 700) : user.think(0.8);
        continue;
      }
      // r >= 0.65: move on without saving (unsaved changes on switch).
      t += user.rng.float(200, 900);
    }
    return steps;
  },
  external(s, rng, win) {
    const out: ExternalEvent[] = [];
    for (let i = 0; i < s.externalEdits; i++) {
      const idx = rng.int(0, s.items.length - 1);
      const add = ` ${rng.pick(s.words)}`;
      out.push({ t: rng.float(win.t0 + 1500, win.t1), feature: s.id, desc: `another user edits ${s.coll} ${idx}`, apply(w) {
        const coll = `${s.id}:${s.coll}`;
        const id = w.db.collection(coll).order[idx];
        const it = id ? w.db.get(coll, id) : undefined;
        if (it) w.db.update(coll, id!, { [s.notesField]: String(it[s.notesField] ?? "") + add }, w.now());
      } });
    }
    return out;
  },
};
