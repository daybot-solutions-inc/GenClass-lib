import type { Chaos } from "./chaos.ts";

export type DemoId = "search" | "editor" | "checkout" | "status" | "board" | "decisions";

/** Page -> Service Worker control messages (sent with a MessagePort for the reply; never through fetch). */
export type ControlMessage =
  | {
      type: "hello";
      sid: string;
      demo: DemoId;
      /** Start a fresh server world (trials always do). */
      reset?: boolean;
      seed?: number;
      chaos?: Partial<Chaos>;
      params?: Record<string, unknown>;
    }
  | { type: "ping"; sid?: string }
  | { type: "chaos"; sid: string; patch: Partial<Chaos>; replace?: boolean }
  | { type: "state"; sid: string }
  | { type: "log"; sid: string; since?: number }
  | { type: "quiet"; sid: string; idleMs: number; timeoutMs: number; ignoreStreams?: boolean }
  | { type: "world"; sid: string; action: string; args?: unknown }
  | { type: "bye"; sid: string };

export interface ControlReply {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

/** One request seen by the mock server. Times are epoch ms (performance.timeOrigin + performance.now()). */
export interface LogEntry {
  id: number;
  method: string;
  path: string;
  query: string;
  route: string;
  /** Request arrived at the server worker. */
  t0: number;
  /** The server handled it (side effects applied), if it got that far. */
  tHandled?: number;
  /** The response left the server (or the request was failed). */
  tEnd?: number;
  status?: number;
  outcome: "pending" | "ok" | "client-error" | "rejected" | "lost" | "network";
  /** Short description of the side effect, if any ("order o3 created"). */
  effect?: string;
  /** The page aborted the request (the server still finished it). */
  aborted?: boolean;
  spike?: boolean;
  body?: string;
}

/** One live event published by the server and its delivery time to each stream. */
export interface EventEntry {
  seq: number;
  type: string;
  t: number;
  data: unknown;
  deliveredAt: number[];
}

export interface ServerInfo {
  buildId: string;
  epoch: string;
}
