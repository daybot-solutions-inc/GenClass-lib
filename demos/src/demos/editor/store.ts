// Notes store: plain Redux, registered with GenClass through its store enhancer.
import { legacy_createStore as createStore } from "redux";
import { genclassEnhancer } from "@genclass/runtime/redux";
import type { Runtime } from "@genclass/runtime";

export interface Note {
  id: string;
  title: string;
  body: string;
  version: number;
  updatedAt: number;
}

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

export interface NotesState {
  notes: Record<string, Note>;
  order: string[];
  activeId: string | null;
  status: SaveStatus;
  lastSavedAt: number | null;
}

export type NotesAction =
  | { type: "notes/listed"; notes: { id: string; title: string; excerpt: string; version: number; updatedAt: number }[] }
  | { type: "note/loaded"; note: Note }
  | { type: "note/selected"; id: string }
  | { type: "note/edited"; id: string; title?: string; body?: string }
  | { type: "save/started" }
  | { type: "save/succeeded"; note: Note; applyBody: boolean }
  | { type: "save/failed" };

const initial: NotesState = { notes: {}, order: [], activeId: null, status: "idle", lastSavedAt: null };

function reducer(state: NotesState = initial, action: NotesAction): NotesState {
  switch (action.type) {
    case "notes/listed": {
      const notes = { ...state.notes };
      for (const n of action.notes) {
        notes[n.id] = notes[n.id] ?? { id: n.id, title: n.title, body: n.excerpt, version: n.version, updatedAt: n.updatedAt };
      }
      return { ...state, notes, order: action.notes.map((n) => n.id), activeId: state.activeId ?? action.notes[0]?.id ?? null };
    }
    case "note/loaded":
      return { ...state, notes: { ...state.notes, [action.note.id]: action.note } };
    case "note/selected":
      return { ...state, activeId: action.id };
    case "note/edited": {
      const n = state.notes[action.id];
      if (!n) return state;
      return {
        ...state,
        status: "dirty",
        notes: { ...state.notes, [n.id]: { ...n, title: action.title ?? n.title, body: action.body ?? n.body } },
      };
    }
    case "save/started":
      return { ...state, status: "saving" };
    case "save/succeeded": {
      const n = state.notes[action.note.id];
      const next = action.applyBody ? { ...action.note } : { ...n, version: action.note.version, updatedAt: action.note.updatedAt };
      return { ...state, status: "saved", lastSavedAt: action.note.updatedAt, notes: { ...state.notes, [n.id]: next } };
    }
    case "save/failed":
      return { ...state, status: "error" };
    default:
      return state;
  }
}

export function createNotesStore(gc: Runtime) {
  return createStore(reducer, initial, genclassEnhancer(gc, { name: "notes" }));
}

export type NotesStore = ReturnType<typeof createNotesStore>;
