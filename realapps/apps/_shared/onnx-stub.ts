// The harness never loads the model (a recording DecisionProvider answers), so onnxruntime-web is stubbed out of
// app bundles.
export const InferenceSession = { create: () => Promise.reject(new Error("onnxruntime-web is not bundled in realapps")) };
export const Tensor = class {};
export const env = { wasm: {} };
export default { InferenceSession, Tensor, env };
