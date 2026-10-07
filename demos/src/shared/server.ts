// Page side of the mock server: registers the Service Worker, makes sure it controls the page, binds this page to
// a server session and offers the control calls (chaos, server truth for oracles). Control traffic goes through
// postMessage, never through fetch, so GenClass does not observe it.
import type { Chaos } from "./chaos.ts";
import type { ControlMessage, ControlReply, DemoId, EventEntry, LogEntry } from "./protocol.ts";

declare const __BUILD_ID__: string;
const BUILD = typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev";

export class ServerError extends Error {}

function wait(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function waitForControllerChange(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => {
        clearTimeout(t);
        resolve(true);
      },
      { once: true },
    );
  });
}

function rawSend(target: ServiceWorker, msg: unknown, timeoutMs = 10000): Promise<ControlReply> {
  return new Promise((resolve, reject) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => reject(new ServerError(`mock server did not answer ${(msg as { type: string }).type}`)), timeoutMs);
    ch.port1.onmessage = (e) => {
      clearTimeout(t);
      ch.port1.close();
      resolve(e.data as ControlReply);
    };
    target.postMessage(msg, [ch.port2]);
  });
}

/** Register the worker and wait until it controls this page (first visit, hard reload and stale worker safe). */
export async function ensureServiceWorker(root: URL): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) {
    throw new ServerError("This demo needs Service Workers (they are off in some private windows and on plain http).");
  }
  const swUrl = new URL("sw.js", root);
  const reg = await navigator.serviceWorker.register(swUrl.href, {
    scope: root.pathname,
    type: import.meta.env.DEV ? "module" : "classic",
    updateViaCache: "none",
  });

  for (let attempt = 0; attempt < 3 && !navigator.serviceWorker.controller; attempt++) {
    const active = reg.active ?? (await navigator.serviceWorker.ready).active;
    if (navigator.serviceWorker.controller) break;
    if (active) {
      const changed = waitForControllerChange(3000);
      try {
        await rawSend(active, { type: "claim" }, 3000);
      } catch {
        /* fall through to the controllerchange wait */
      }
      if (await changed) break;
    } else {
      if (await waitForControllerChange(5000)) break;
    }
  }
  if (!navigator.serviceWorker.controller) {
    const key = "gc-demo-sw-reload";
    if (!sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, "1");
      location.reload();
      await new Promise(() => {});
    }
    throw new ServerError("The mock server could not take control of this page. Try a normal reload.");
  }
  sessionStorage.removeItem("gc-demo-sw-reload");

  // The first visit was not served by the worker, so it lacks the isolation headers: reload once.
  const wantIsolation = new URLSearchParams(location.search).get("coi") !== "0";
  if (wantIsolation && !self.crossOriginIsolated && window.top === window) {
    const key = "gc-demo-coi-reload";
    if (!sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, "1");
      location.reload();
      await new Promise(() => {});
    }
  } else if (self.crossOriginIsolated) sessionStorage.removeItem("gc-demo-coi-reload");

  // An older worker from a previous build may still be in charge: update it once.
  const pong = await rawSend(navigator.serviceWorker.controller, { type: "ping" }, 5000).catch(() => null);
  if (pong && pong.buildId !== BUILD && BUILD !== "dev") {
    const changed = waitForControllerChange(6000);
    await reg.update().catch(() => {});
    await changed;
  }
  return reg;
}

export interface ServerTruth<S = unknown> {
  t: number;
  created: number;
  state: S;
  chaos: Chaos;
  events: number;
}

export class ServerLink {
  private hb: ReturnType<typeof setInterval> | null = null;
  private lastHello: Omit<Extract<ControlMessage, { type: "hello" }>, "type" | "sid" | "demo"> = {};
  onRestart: (() => void) | null = null;

  constructor(
    readonly sid: string,
    readonly demo: DemoId,
  ) {}

  async send(msg: ControlMessage, timeoutMs = 10000): Promise<ControlReply> {
    let ctl = navigator.serviceWorker.controller;
    if (!ctl) {
      await waitForControllerChange(5000);
      ctl = navigator.serviceWorker.controller;
    }
    if (!ctl) throw new ServerError("mock server is not in control");
    const reply = await rawSend(ctl, msg, timeoutMs);
    if (!reply.ok && reply.error) throw new ServerError(reply.error);
    return reply;
  }

  async hello(opts: { reset?: boolean; seed?: number; chaos?: Partial<Chaos>; params?: Record<string, unknown> } = {}) {
    this.lastHello = { ...opts, reset: false };
    return this.send({ type: "hello", sid: this.sid, demo: this.demo, ...opts });
  }

  /** Keep the worker alive and re-bind after it restarts. */
  startHeartbeat(): void {
    if (this.hb) return;
    navigator.serviceWorker.addEventListener("message", (e) => {
      if ((e.data as { type?: string })?.type === "identify") void this.hello({ ...this.lastHello, reset: false });
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      void this.hello({ ...this.lastHello, reset: false }).then((r) => {
        if (r.created) this.onRestart?.();
      });
    });
    this.hb = setInterval(async () => {
      try {
        const r = await this.send({ type: "ping", sid: this.sid }, 4000);
        if (r.known === false) {
          await this.hello({ ...this.lastHello, reset: false });
          this.onRestart?.();
        }
      } catch {
        /* transient */
      }
    }, 5000);
  }

  stop(): void {
    if (this.hb) clearInterval(this.hb);
    this.hb = null;
  }

  async setChaos(patch: Partial<Chaos>, replace = false): Promise<Chaos> {
    const r = await this.send({ type: "chaos", sid: this.sid, patch, replace });
    return r.chaos as Chaos;
  }

  async truth<S>(): Promise<ServerTruth<S>> {
    return (await this.send({ type: "state", sid: this.sid })) as unknown as ServerTruth<S>;
  }

  async log(since = 0): Promise<{ t: number; log: LogEntry[]; events: EventEntry[] }> {
    return (await this.send({ type: "log", sid: this.sid, since })) as unknown as {
      t: number;
      log: LogEntry[];
      events: EventEntry[];
    };
  }

  async quiet(idleMs: number, timeoutMs: number, ignoreStreams = false): Promise<boolean> {
    const r = await this.send({ type: "quiet", sid: this.sid, idleMs, timeoutMs, ignoreStreams }, timeoutMs + 5000);
    return Boolean(r.quiet);
  }

  async world(action: string, args?: unknown): Promise<unknown> {
    const r = await this.send({ type: "world", sid: this.sid, action, args });
    return r.result;
  }

  async bye(): Promise<void> {
    this.stop();
    await this.send({ type: "bye", sid: this.sid }, 2000).catch(() => {});
  }
}

export const epochNow = (): number => performance.timeOrigin + performance.now();
export { wait };
