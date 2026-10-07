// Typed errors of the model host. They cross the worker boundary as plain objects (serializeError /
// deserializeError) and come back as the same classes, so callers can branch on `instanceof` or `code`.

export type ModelErrorCode =
  | "not_ready"
  | "max_tokens_exceeded"
  | "bad_request"
  | "unsupported"
  | "timeout"
  | "aborted"
  | "busy"
  | "disposed"
  | "load_failed"
  | "integrity"
  | "inference_failed";

export class GenClassModelError extends Error {
  readonly code: ModelErrorCode;
  readonly detail?: Record<string, unknown>;
  constructor(code: ModelErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "GenClassModelError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** evaluate() was called before the model finished loading (or after it failed). Fail open: run the passive action. */
export class ModelNotReadyError extends GenClassModelError {
  constructor(message = "the GenClass model is not loaded yet", detail?: Record<string, unknown>) {
    super("not_ready", message, detail);
    this.name = "ModelNotReadyError";
  }
}

/** The packed request needs more positions than the model supports (Jev `max_tokens_exceeded`). */
export class MaxTokensExceededError extends GenClassModelError {
  /** State tokens + the longest question branch (what the positions budget bounds). */
  readonly tokens: number;
  /** Every token of the packed sequence. */
  readonly total: number;
  readonly maxTokens: number;
  constructor(tokens: number, total: number, maxTokens: number, maxTotal?: number) {
    super("max_tokens_exceeded", `max_tokens_exceeded: the request needs ${tokens} positions (${total} tokens), the model allows ${maxTokens}`, {
      detail: "max_tokens_exceeded",
      tokens,
      total,
      max_tokens: maxTokens,
      ...(maxTotal !== undefined ? { max_total: maxTotal } : {}),
    });
    this.name = "MaxTokensExceededError";
    this.tokens = tokens;
    this.total = total;
    this.maxTokens = maxTokens;
  }
}

/** Malformed state or question (e.g. a choice with no options). */
export class ModelInputError extends GenClassModelError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super("bad_request", message, detail);
    this.name = "ModelInputError";
  }
}

/** The loaded model cannot answer this kind of question, or the model files use a format this runtime does not know. */
export class ModelUnsupportedError extends GenClassModelError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super("unsupported", message, detail);
    this.name = "ModelUnsupportedError";
  }
}

export class ModelTimeoutError extends GenClassModelError {
  constructor(ms: number) {
    super("timeout", `the GenClass model did not answer within ${ms} ms`, { timeoutMs: ms });
    this.name = "ModelTimeoutError";
  }
}

export class ModelAbortedError extends GenClassModelError {
  constructor(message = "the request was aborted") {
    super("aborted", message);
    this.name = "ModelAbortedError";
  }
}

/** The request queue is full and this request had the lowest priority. */
export class ModelBusyError extends GenClassModelError {
  constructor(queued: number) {
    super("busy", `the GenClass model queue is full (${queued} requests waiting)`, { queued });
    this.name = "ModelBusyError";
  }
}

export class ModelDisposedError extends GenClassModelError {
  constructor() {
    super("disposed", "the GenClass model host was disposed");
    this.name = "ModelDisposedError";
  }
}

export interface LoadAttempt {
  variant: string;
  device: string;
  error: string;
}

/** Every plan failed (or the model card / files could not be fetched). */
export class ModelLoadError extends GenClassModelError {
  readonly attempts: LoadAttempt[];
  constructor(message: string, attempts: LoadAttempt[] = []) {
    super("load_failed", message, { attempts });
    this.name = "ModelLoadError";
    this.attempts = attempts;
  }
}

/** A downloaded file did not match the sha256 (or size) in the model card. */
export class ModelIntegrityError extends GenClassModelError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super("integrity", message, detail);
    this.name = "ModelIntegrityError";
  }
}

export class ModelInferenceError extends GenClassModelError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super("inference_failed", message, detail);
    this.name = "ModelInferenceError";
  }
}

// ------------------------------------------------------------------------------------------- wire format

export interface SerializedError {
  name: string;
  message: string;
  code?: ModelErrorCode;
  detail?: Record<string, unknown>;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

export function serializeError(e: unknown): SerializedError {
  if (e instanceof GenClassModelError) {
    const out: SerializedError = { name: e.name, message: e.message, code: e.code };
    if (e.detail !== undefined) out.detail = jsonSafe(e.detail);
    return out;
  }
  if (e instanceof Error) return { name: e.name || "Error", message: e.message };
  return { name: "Error", message: errorMessage(e) };
}

export function deserializeError(s: SerializedError): Error {
  const d = s.detail ?? {};
  let e: Error;
  switch (s.code) {
    case "not_ready":
      e = new ModelNotReadyError(s.message, s.detail);
      break;
    case "max_tokens_exceeded":
      e = new MaxTokensExceededError(Number(d.tokens ?? 0), Number(d.total ?? 0), Number(d.max_tokens ?? 0), d.max_total === undefined ? undefined : Number(d.max_total));
      break;
    case "bad_request":
      e = new ModelInputError(s.message, s.detail);
      break;
    case "unsupported":
      e = new ModelUnsupportedError(s.message, s.detail);
      break;
    case "timeout":
      e = new ModelTimeoutError(Number(d.timeoutMs ?? 0));
      break;
    case "aborted":
      e = new ModelAbortedError(s.message);
      break;
    case "busy":
      e = new ModelBusyError(Number(d.queued ?? 0));
      break;
    case "disposed":
      e = new ModelDisposedError();
      break;
    case "load_failed":
      e = new ModelLoadError(s.message, Array.isArray(d.attempts) ? (d.attempts as LoadAttempt[]) : []);
      break;
    case "integrity":
      e = new ModelIntegrityError(s.message, s.detail);
      break;
    case "inference_failed":
      e = new ModelInferenceError(s.message, s.detail);
      break;
    default: {
      e = new Error(s.message);
      e.name = s.name || "Error";
    }
  }
  if (e.message !== s.message) e.message = s.message;
  return e;
}

function jsonSafe(v: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(v)) as Record<string, unknown>;
  } catch {
    return {};
  }
}
