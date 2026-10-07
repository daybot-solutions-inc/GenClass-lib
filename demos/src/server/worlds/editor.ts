import type { WorldDef } from "../core.ts";
import { now } from "../core.ts";

export interface ServerNote {
  id: string;
  title: string;
  body: string;
  version: number;
  updatedAt: number;
  /** Every stored version (for the oracle: what the server held, and when). */
  history: { version: number; t: number; body: string; title: string }[];
}

interface EditorState {
  notes: Record<string, ServerNote>;
  order: string[];
}

const SEED_NOTES: [string, string, string][] = [
  [
    "n1",
    "Launch checklist",
    "Ship the onboarding flow behind a flag.\nConfirm the billing webhooks in staging.\nDraft the changelog.\n",
  ],
  ["n2", "Reading notes", "Designing Data-Intensive Applications, chapter 5: replication lag and read-your-writes.\n"],
  ["n3", "Ideas", "A tiny CLI that diffs two JSON files and explains the change in one sentence.\n"],
];

export const editorWorld: WorldDef<EditorState> = {
  demo: "editor",
  create: () => {
    const t = now();
    const notes: Record<string, ServerNote> = {};
    for (const [id, title, body] of SEED_NOTES) {
      notes[id] = { id, title, body, version: 1, updatedAt: t, history: [{ version: 1, t, body, title }] };
    }
    return { notes, order: SEED_NOTES.map(([id]) => id) };
  },
  routes: [
    {
      method: "GET",
      pattern: /^\/notes$/,
      key: () => "notes",
      handle: (w) => ({
        status: 200,
        json: w.state.order.map((id) => {
          const n = w.state.notes[id];
          return { id, title: n.title, excerpt: n.body.slice(0, 80), version: n.version, updatedAt: n.updatedAt };
        }),
      }),
    },
    {
      method: "GET",
      pattern: /^\/notes\/([\w-]+)$/,
      key: () => "notes/item",
      handle: (w, req) => {
        const n = w.state.notes[req.params[0]];
        if (!n) return { status: 404, json: { error: "Note not found" } };
        return { status: 200, json: publicNote(n) };
      },
    },
    {
      method: "PUT",
      pattern: /^\/notes\/([\w-]+)$/,
      key: () => "notes/item",
      handle: (w, req) => {
        const n = w.state.notes[req.params[0]];
        if (!n) return { status: 404, json: { error: "Note not found" } };
        const body = req.body as { title?: unknown; body?: unknown } | undefined;
        if (!body || typeof body.body !== "string") return { status: 400, json: { error: "body must be a string" } };
        n.body = body.body;
        if (typeof body.title === "string") n.title = body.title;
        n.version += 1;
        n.updatedAt = now();
        n.history.push({ version: n.version, t: n.updatedAt, body: n.body, title: n.title });
        if (n.history.length > 400) n.history.splice(1, n.history.length - 400);
        return {
          status: 200,
          json: publicNote(n),
          work: 15 + n.body.length * 0.02,
          effect: `${n.id} v${n.version} stored (${n.body.length} chars)`,
        };
      },
    },
  ],
  snapshot: (w) => ({ notes: w.state.notes }),
};

function publicNote(n: ServerNote) {
  return { id: n.id, title: n.title, body: n.body, version: n.version, updatedAt: n.updatedAt };
}
