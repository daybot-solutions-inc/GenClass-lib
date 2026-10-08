// Small fetch wrapper used by the wave-3 apps: JSON in/out, non-2xx -> HttpError carrying the status and body.
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: any = null,
  ) {
    super(`HTTP ${status}`);
  }
}

export async function api<T = any>(url: string, method = "GET", body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
  const init: RequestInit = { method, headers: { "content-type": "application/json", ...headers }, signal };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(url, init);
  const text = r.status === 204 ? "" : await r.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!r.ok) throw new HttpError(r.status, data);
  return data as T;
}

/** Items of a list response whatever the envelope ({items}|{data}|{results}|bare). */
export function itemsOf<T = any>(body: any): T[] {
  if (Array.isArray(body)) return body;
  const v = body?.items ?? body?.data ?? body?.results;
  return Array.isArray(v) ? v : [];
}

export const isAbort = (e: unknown) => (e as { name?: string })?.name === "AbortError";

export function errText(e: unknown, what: string): string {
  const s = e instanceof HttpError ? e.status : 0;
  if (s === 0) return `Network problem — ${what} did not go through.`;
  if (s === 409) return `Someone else changed this — ${what} was not saved.`;
  if (s === 429) return `Too many requests — ${what} was throttled, try again shortly.`;
  return `${what[0]!.toUpperCase()}${what.slice(1)} failed (${s}).`;
}

/** WebSocket on topic `name` with reconnect; returns a closer. */
export function liveTopic(name: string, onMsg: (m: any) => void, onState?: (up: boolean) => void, retryMs = 2000): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  const open = () => {
    ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/${name}`);
    ws.onopen = () => onState?.(true);
    ws.onmessage = (ev) => {
      try {
        onMsg(JSON.parse(String(ev.data)));
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      onState?.(false);
      if (!closed) setTimeout(open, retryMs);
    };
  };
  open();
  return () => {
    closed = true;
    ws?.close();
  };
}
