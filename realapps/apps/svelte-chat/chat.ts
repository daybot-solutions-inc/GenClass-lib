// Chat state and effects (Svelte store backed by a runtime atom). Latent bugs by flag: messages appended twice
// (response + live push without dedupe), temp messages not replaced, double sends (no disable), message count not
// updated for pushes, reconnect without resync (missed messages), stale channel loads.
import { rt, flag } from "../_shared/genclass";
import { atomStore } from "../_shared/svelte-atom";

export type Msg = { id?: number; channel: string; author: string; text: string; clientId?: string; pending?: boolean };
const DEDUPE = flag("dedupe", "clientId") as "clientId" | "id" | "none";
const OPTIMISTIC = Boolean(flag("optimistic", true));
const REPLACE = flag("replace", "clientId") as "clientId" | "append";
export const DISABLE = Boolean(flag("disableWhileSending", true));
const COUNT_ON_PUSH = Boolean(flag("countOnPush", true));
const RECONNECT = flag("reconnect", "resync") as "resync" | "naive" | "none";
const CHANNEL_GUARD = Boolean(flag("channelGuard", true));

const chatAtom = rt.atom("chat", { channel: "general", channels: [] as string[], messages: [] as Msg[], count: 0, draft: "", sending: false, error: "", connected: false });
export const chat = atomStore(chatAtom);
let n = 0;

export async function loadChannel(name: string) {
  chatAtom.update((c) => ({ ...c, channel: name, error: "" }));
  try {
    const r = await fetch(`/api/messages?channel=${encodeURIComponent(name)}`);
    if (!r.ok) throw new Error(String(r.status));
    const data = (await r.json()) as { items: Msg[] };
    if (CHANNEL_GUARD && chatAtom.get().channel !== name) return;
    chatAtom.update((c) => ({ ...c, messages: data.items, count: data.items.length }));
  } catch {
    chatAtom.update((c) => ({ ...c, error: "Could not load messages" }));
  }
}

export async function init() {
  try {
    const r = await fetch("/api/channels");
    const chs = (await r.json()) as { name: string }[];
    chatAtom.update((c) => ({ ...c, channels: chs.map((x) => x.name) }));
  } catch {
    chatAtom.update((c) => ({ ...c, channels: ["general"] }));
  }
  await loadChannel("general");
  connect();
}

function has(list: Msg[], m: Msg): boolean {
  if (DEDUPE === "id") return m.id !== undefined && list.some((x) => x.id === m.id);
  if (DEDUPE === "clientId") return list.some((x) => (m.id !== undefined && x.id === m.id) || (!!m.clientId && x.clientId === m.clientId));
  return false;
}

function connect() {
  const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/messages`);
  ws.onopen = () => chatAtom.update((c) => ({ ...c, connected: true }));
  ws.onmessage = (e) => {
    const ev = JSON.parse(e.data) as { type: string; item: Msg };
    if (ev.type !== "created" || !ev.item) return;
    chatAtom.update((c) => {
      if (ev.item.channel !== c.channel || has(c.messages, ev.item)) return c;
      const messages = [...c.messages, ev.item];
      return { ...c, messages, count: COUNT_ON_PUSH ? messages.length : c.count };
    });
  };
  ws.onclose = () => {
    chatAtom.update((c) => ({ ...c, connected: false }));
    if (RECONNECT === "none") return;
    setTimeout(() => {
      connect();
      if (RECONNECT === "resync") void loadChannel(chatAtom.get().channel);
    }, 1000);
  };
}

export function setDraft(v: string) {
  chatAtom.update((c) => ({ ...c, draft: v }));
}

export async function send() {
  const c0 = chatAtom.get();
  const text = c0.draft.trim();
  if (!text || (DISABLE && c0.sending)) return;
  const clientId = `c${++n}-${Math.floor(Math.random() * 1e6)}`;
  const msg: Msg = { channel: c0.channel, author: "me", text, clientId };
  chatAtom.update((c) => {
    const messages = OPTIMISTIC ? [...c.messages, { ...msg, pending: true }] : c.messages;
    return { ...c, draft: "", sending: true, messages, count: messages.length };
  });
  try {
    const r = await fetch("/api/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg) });
    if (!r.ok) throw new Error(String(r.status));
    const saved = (await r.json()) as Msg;
    chatAtom.update((c) => {
      let messages: Msg[];
      if (OPTIMISTIC && REPLACE === "clientId") messages = c.messages.some((x) => x.clientId === clientId) ? c.messages.map((x) => (x.clientId === clientId ? saved : x)) : has(c.messages, saved) ? c.messages : [...c.messages, saved];
      else messages = has(c.messages, saved) ? c.messages : [...c.messages, saved];
      return { ...c, sending: false, messages, count: messages.length };
    });
  } catch {
    chatAtom.update((c) => {
      const messages = c.messages.filter((x) => x.clientId !== clientId);
      return { ...c, sending: false, error: "Message not sent", messages, count: messages.length };
    });
  }
}
