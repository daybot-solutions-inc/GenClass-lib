/// <reference lib="webworker" />
// Mock API server for the demos, running in a Service Worker so every app uses real `fetch` and a real
// EventSource. Each page (and each trial iframe) binds its client id to a session ("world") through
// postMessage; control traffic never goes through fetch, so GenClass never sees it.
import { World, json, now, sleep, type WorldDef } from "./core.ts";
import { searchWorld } from "./worlds/search.ts";
import { editorWorld } from "./worlds/editor.ts";
import { checkoutWorld } from "./worlds/checkout.ts";
import { statusWorld } from "./worlds/status.ts";
import { boardWorld } from "./worlds/board.ts";
import { decisionsWorld } from "./worlds/decisions.ts";
import type { ControlMessage, ControlReply, DemoId } from "../shared/protocol.ts";

declare const self: ServiceWorkerGlobalScope;
declare const __BUILD_ID__: string;

const BUILD = typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev";
const EPOCH = Math.random().toString(36).slice(2, 10);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DEFS: Record<DemoId, WorldDef<any>> = {
  search: searchWorld,
  editor: editorWorld,
  checkout: checkoutWorld,
  status: statusWorld,
  board: boardWorld,
  decisions: decisionsWorld,
};

const worlds = new Map<string, World>();
const bindings = new Map<string, string>(); // clientId -> sid
const lastSeen = new Map<string, number>(); // sid -> epoch ms

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function bind(clientId: string | undefined, sid: string) {
  if (clientId) bindings.set(clientId, sid);
  lastSeen.set(sid, now());
}

function getWorld(sid: string): World | undefined {
  return worlds.get(sid);
}

function createWorld(msg: Extract<ControlMessage, { type: "hello" }>): World {
  const old = worlds.get(msg.sid);
  if (old) old.dispose();
  const def = DEFS[msg.demo];
  if (!def) throw new Error(`unknown demo ${msg.demo}`);
  const w = new World(def, msg.sid, msg.seed ?? 1, msg.params ?? {}, msg.chaos);
  worlds.set(msg.sid, w);
  w.start();
  return w;
}

async function control(msg: ControlMessage, clientId: string | undefined): Promise<ControlReply> {
  switch (msg.type) {
    case "ping": {
      if (msg.sid) bind(clientId, msg.sid);
      return { ok: true, buildId: BUILD, epoch: EPOCH, known: msg.sid ? worlds.has(msg.sid) : undefined };
    }
    case "hello": {
      let w = getWorld(msg.sid);
      let created = false;
      if (!w || msg.reset || w.demo !== msg.demo) {
        w = createWorld(msg);
        created = true;
      }
      bind(clientId, msg.sid);
      return { ok: true, buildId: BUILD, epoch: EPOCH, created, chaos: w.chaos, t: now() };
    }
    case "chaos": {
      const w = getWorld(msg.sid);
      if (!w) return { ok: false, error: "no such session" };
      w.setChaos(msg.patch, msg.replace);
      return { ok: true, chaos: w.chaos };
    }
    case "state": {
      const w = getWorld(msg.sid);
      if (!w) return { ok: false, error: "no such session" };
      return { ok: true, t: now(), created: w.created, state: w.def.snapshot(w), chaos: w.chaos, events: w.events.length };
    }
    case "log": {
      const w = getWorld(msg.sid);
      if (!w) return { ok: false, error: "no such session" };
      const since = msg.since ?? 0;
      return { ok: true, t: now(), log: w.log.filter((e) => e.id > since), events: w.events };
    }
    case "quiet": {
      const w = getWorld(msg.sid);
      if (!w) return { ok: false, error: "no such session" };
      const r = await w.quiet(msg.idleMs, msg.timeoutMs, msg.ignoreStreams);
      return { ok: true, ...r };
    }
    case "world": {
      const w = getWorld(msg.sid);
      if (!w) return { ok: false, error: "no such session" };
      if (msg.action === "freeze") {
        w.frozen = true;
        return { ok: true, result: true };
      }
      const result = w.def.action?.(w, msg.action, msg.args);
      return { ok: result !== undefined, result: result ?? null };
    }
    case "bye": {
      const w = getWorld(msg.sid);
      if (w && msg.sid.startsWith("trial-")) {
        w.dispose();
        worlds.delete(msg.sid);
      }
      for (const [c, s] of bindings) if (s === msg.sid && c === clientId) bindings.delete(c);
      return { ok: true };
    }
  }
}

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  const msg = event.data as ControlMessage | { type: "claim" } | undefined;
  const port = event.ports[0];
  if (!msg || typeof msg !== "object" || !("type" in msg)) return;
  if (msg.type === "claim") {
    // A page that was hard-reloaded is not controlled; it asks us to take it over.
    event.waitUntil(self.clients.claim().then(() => port?.postMessage({ ok: true })));
    return;
  }
  const source = event.source as Client | null;
  const p = control(msg, source?.id)
    .catch((e): ControlReply => ({ ok: false, error: String(e) }))
    .then((reply) => {
      port?.postMessage(reply);
    });
  event.waitUntil(p);
});

/** A request from a client we do not know (e.g. the worker restarted): ask the page who it is. */
async function resolveSid(clientId: string): Promise<string | undefined> {
  const known = bindings.get(clientId);
  if (known && worlds.has(known)) return known;
  const client = clientId ? await self.clients.get(clientId) : undefined;
  if (!client) return undefined;
  client.postMessage({ type: "identify" });
  const t0 = now();
  while (now() - t0 < 5000) {
    await sleep(25);
    const sid = bindings.get(clientId);
    if (sid && worlds.has(sid)) return sid;
  }
  return undefined;
}

self.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin) return;
  const apiRoot = scope.pathname + "api/";
  if (!url.pathname.startsWith(apiRoot)) return;
  const path = "/" + url.pathname.slice(apiRoot.length);
  event.respondWith(
    (async () => {
      const sid = await resolveSid(event.clientId);
      const w = sid ? worlds.get(sid) : undefined;
      if (!w) return json(503, { error: "The demo server lost this session. Reload the page." });
      lastSeen.set(w.sid, now());
      return w.handle(event.request, url, path, event.clientId);
    })(),
  );
});

// Drop worlds whose pages are gone (grace period covers reloads of the interactive page).
setInterval(async () => {
  const alive = new Set((await self.clients.matchAll({ includeUncontrolled: true })).map((c) => c.id));
  const live = new Set<string>();
  for (const [c, sid] of bindings) {
    if (alive.has(c)) live.add(sid);
    else bindings.delete(c);
  }
  const t = now();
  for (const [sid, w] of worlds) {
    if (live.has(sid)) continue;
    const seen = lastSeen.get(sid) ?? w.created;
    if (t - seen > (sid.startsWith("trial-") ? 15000 : 120000)) {
      w.dispose();
      worlds.delete(sid);
      lastSeen.delete(sid);
    }
  }
}, 10000);
