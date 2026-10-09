// Anonymous diagnostics (InitOptions.telemetry; packages/runtime/TELEMETRY.md). startTelemetry is called by
// createRuntime (src/index.ts) after the runtime is built.

import type { RuntimeImpl } from "../runtime.js";
import type { TelemetryOptions, TelemetryStatus } from "../types.js";
import { TelemetryClient, telemetryOff, type TelemetrySessionInfo } from "./client.js";
import { TELEMETRY_NOTICE, resolveTelemetry } from "./config.js";

export { DEFAULT_TELEMETRY_ENDPOINT, TELEMETRY_NOTICE, TELEMETRY_SCHEMA, resolveTelemetry } from "./config.js";
export { TelemetryClient, MAX_QUEUE, MAX_REQUEST_BYTES } from "./client.js";
export type { TelemetrySessionInfo } from "./client.js";

let noticeShown = false;

/** Tests only: show the console notice again. */
export function resetTelemetryNotice(): void {
  noticeShown = false;
}

export function startTelemetry(
  rt: RuntimeImpl,
  opt: boolean | TelemetryOptions | undefined,
  defaultOn: boolean,
  info: TelemetrySessionInfo,
): TelemetryStatus {
  try {
    const res = resolveTelemetry(opt, rt.global, defaultOn);
    if (!res.on) return telemetryOff(res.reason);
    const client = new TelemetryClient(rt, res.config, rt.global, info);
    if (!noticeShown) {
      noticeShown = true;
      try {
        ((rt.global.console as Console | undefined) ?? (globalThis as { console?: Console }).console)?.info?.(TELEMETRY_NOTICE);
      } catch {
        /* ignore */
      }
    }
    return client;
  } catch {
    return telemetryOff("error");
  }
}
