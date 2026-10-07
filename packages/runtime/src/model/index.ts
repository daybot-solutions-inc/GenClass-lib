// Model engine and host of @genclass/runtime (owner: MODEL). CORE wires createModelHost() into the runtime as the
// default DecisionProvider; Tokenizer/Packer/stateSegments are exported for token budgeting of situations.

export { createModelHost, DEFAULT_MODEL_BASE_URL, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_QUEUE } from "./host.js";
export type { ModelHost, ModelHostOptions, ModelHostStats, ModelEvaluateRequest, WorkerLike, ModelHostStatus, EvaluateOk } from "./host.js";
export { ModelBackend, ORT_WASM_FILE, ortCdnBase, WARMUP_STATE, WARMUP_QUESTIONS } from "./backend.js";
export type { BackendLoadOptions, BackendEnv } from "./backend.js";
export { Engine, FEEDS, tensorFloats } from "./engine.js";
export type { EngineOptions, EngineResult, ModelMeta, OrtLike, OrtSessionLike, OrtTensorLike } from "./engine.js";
export { Packer, planInputs, unpackLogits, MARKERS, STATE } from "./packer.js";
export type { Packed, PackedQuestion, PackerOptions, FeedPlan } from "./packer.js";
export { Tokenizer, bytesToUnicode } from "./tokenizer.js";
export type { TokenizerJson, AddedTokenJson } from "./tokenizer.js";
export {
  stateSegments,
  stateText,
  segmentText,
  questionBlock,
  questionEntries,
  criteriaEntries,
  entryText,
  pyJson,
  toJsonValue,
  MAX_ARRAY_SEGMENTS,
  DEFAULT_CHOICE_INSTR,
  DEFAULT_NOUL_INSTR,
  DEFAULT_SCORE_INSTR,
} from "./serialize.js";
export type { Segment, QBlock, BlockKind, WireQuestion } from "./serialize.js";
export {
  parseCalibration,
  calibrateLogits,
  buildAnswer,
  headerKey,
  tauFor,
  noulAffine,
  kBucket,
  normalizeProbs,
  choiceConfidence,
  scoreConfidence,
  K_BUCKETS,
  BUCKET_CLAMP,
} from "./calibrate.js";
export type { Calibration, Precision } from "./calibrate.js";
export {
  parseCard,
  planOrder,
  probeWebGPU,
  fetchFile,
  fetchCard,
  cardId,
  fileUrl,
  normalizeBaseUrl,
  CARD_FORMAT,
  DEFAULT_CACHE_NAME,
} from "./loader.js";
export type { ModelCard, VariantSpec, FileSpec, FileRole, Plan, GpuInfo, DevicePreference, DeviceKind, FetchEnv, FetchOutcome } from "./loader.js";
export {
  GenClassModelError,
  ModelNotReadyError,
  MaxTokensExceededError,
  ModelInputError,
  ModelUnsupportedError,
  ModelTimeoutError,
  ModelAbortedError,
  ModelBusyError,
  ModelDisposedError,
  ModelLoadError,
  ModelIntegrityError,
  ModelInferenceError,
  serializeError,
  deserializeError,
} from "./errors.js";
export type { ModelErrorCode, SerializedError, LoadAttempt } from "./errors.js";
export { sha1Hex, sha256Hex } from "./hash.js";
export { pyNumber, pyRound, pyStrip, clip01 } from "./pyutil.js";
