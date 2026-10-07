/** Thrown by ask()/decide() when no model can answer (model: false, failed to load, timed out, destroyed). */
export class GenClassUnavailableError extends Error {
  readonly reason: "off" | "error" | "timeout" | "destroyed";
  constructor(reason: "off" | "error" | "timeout" | "destroyed", message: string) {
    super(message);
    this.name = "GenClassUnavailableError";
    this.reason = reason;
  }
}
