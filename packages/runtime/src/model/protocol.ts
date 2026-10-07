// Messages between the model host (main thread) and the model worker. Every request carries an id; the worker
// answers each with exactly one "result". Status updates are pushed whenever the backend's status changes.

import type { Answer } from "../types.js";
import type { BackendLoadOptions, ModelHostStatus } from "./backend.js";
import type { SerializedError } from "./errors.js";

export type ToWorker =
  | { type: "load"; options: BackendLoadOptions }
  | { type: "evaluate"; id: number; state: unknown; questions: unknown }
  | { type: "measure"; id: number; state: unknown; questions?: unknown }
  | { type: "dispose" };

export interface EvaluateOk {
  answers: Record<string, Answer>;
  model: string;
  usage: { input_tokens: number; positions: number };
  timings: { pack: number; forward: number; total: number };
}

export type FromWorker =
  /** Posted once when the worker module (and onnxruntime-web) finished loading. */
  | { type: "hello" }
  | { type: "status"; status: ModelHostStatus }
  | { type: "result"; id: number; ok: true; value: unknown }
  | { type: "result"; id: number; ok: false; error: SerializedError };
