// Severe-weather alert subscriptions for a regional emergency service, written as native Custom Elements with
// shadow DOM (no framework) + fetch; state in runtime atoms that the elements subscribe to. Each subscription row
// element polls the alerts of its own region while it is connected. Latent bugs by flag: subscribe clicks that are
// not guarded while the POST is in flight (subGuard=exists-only) or not checked at all (subGuard=none) so the same
// region is subscribed twice, row elements that never stop their timers when they are disconnected
// (pollCleanup=false), a list that re-creates every row element on each change (rowRender=replace: every mute or
// add re-polls every region and, without cleanup, leaks a timer per row), fixed-interval polling whose responses
// land out of order (poll=interval: an alert acknowledged or cancelled meanwhile reappears) and acknowledgements
// sent as a relative toggle (ack=toggle: a double click un-acknowledges).
import { rt, flag } from "../_shared/genclass";

type Severity = "advisory" | "watch" | "warning";
type Sub = { id: number; region: string; minSeverity: Severity; muted: boolean; channel: string };
type Alert = { id: number; region: string; severity: Severity; headline: string; until: string; acked: boolean };

const SUB_GUARD = flag("subGuard", "inflight") as "inflight" | "exists-only" | "none";
const POLL_CLEANUP = Boolean(flag("pollCleanup", true));
const ROW_RENDER = flag("rowRender", "keyed") as "keyed" | "replace";
const POLL = flag("poll", "chain") as "chain" | "interval";
const POLL_MS = Number(flag("pollMs", 5000));
const ACK = flag("ack", "set") as "set" | "toggle";

const REGIONS: Record<string, string> = { "coastal-north": "Coastal North", "coastal-south": "Coastal South", "valley-east": "Valley East", "valley-west": "Valley West", highlands: "Highlands", metro: "Metro" };
const RANK: Record<Severity, number> = { advisory: 1, watch: 2, warning: 3 };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const subs = rt.atom("subs", { items: [] as Sub[], loading: true, adding: false, error: "", notice: "" });
const feed = rt.atom("feed", { byRegion: {} as Record<string, Alert[]>, error: "" });

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}
async function api<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new HttpError(r.status);
  return (r.status === 204 ? null : await r.json()) as T;
}

// ------------------------------------------------------------------------------------------- data flows
async function loadSubs() {
  try {
    const items = await api<Sub[]>("/api/subscriptions");
    subs.update((s) => ({ ...s, items, loading: false }));
  } catch {
    subs.update((s) => ({ ...s, loading: false, error: "Your subscriptions could not be loaded." }));
  }
}

async function subscribe(region: string, minSeverity: Severity) {
  const s = subs.get();
  if (SUB_GUARD !== "none" && s.items.some((x) => x.region === region)) {
    subs.update((x) => ({ ...x, error: "", notice: `You already get alerts for ${REGIONS[region]}.` }));
    return;
  }
  if (SUB_GUARD === "inflight" && s.adding) return;
  subs.update((x) => ({ ...x, adding: true, error: "", notice: "" }));
  try {
    const created = await api<Sub>("/api/subscriptions", "POST", { region, minSeverity, muted: false, channel: "push" });
    subs.update((x) => ({ ...x, adding: false, items: [...x.items, created], notice: `Subscribed to ${REGIONS[region]} (${minSeverity} and above).` }));
  } catch (e) {
    subs.update((x) => ({ ...x, adding: false, error: e instanceof HttpError && e.status === 429 ? "Too many requests — wait a moment and try again." : "The subscription could not be saved." }));
  }
}

async function toggleMute(id: number) {
  const sub = subs.get().items.find((x) => x.id === id);
  if (!sub) return;
  const muted = !sub.muted;
  const patch = (m: boolean) => subs.update((x) => ({ ...x, items: x.items.map((i) => (i.id === id ? { ...i, muted: m } : i)) }));
  patch(muted);
  try {
    const saved = await api<Sub>(`/api/subscriptions/${id}`, "PATCH", { muted });
    subs.update((x) => ({ ...x, items: x.items.map((i) => (i.id === id ? { ...i, ...saved } : i)) }));
  } catch {
    patch(!muted);
    subs.update((x) => ({ ...x, error: "Muting failed. Please try again." }));
  }
}

async function unsubscribe(id: number) {
  const before = subs.get().items;
  subs.update((x) => ({ ...x, items: x.items.filter((i) => i.id !== id), error: "", notice: "" }));
  try {
    await api(`/api/subscriptions/${id}`, "DELETE");
  } catch {
    subs.update((x) => ({ ...x, items: before.filter((b) => b.id === id || x.items.some((i) => i.id === b.id)), error: "The subscription could not be removed." }));
  }
}

let pollSeq = 0;
const applied: Record<string, number> = {};
async function pollRegion(region: string) {
  const issued = ++pollSeq;
  try {
    const d = await api<Alert[]>(`/api/alerts?region=${encodeURIComponent(region)}`);
    if (POLL === "chain" && issued < (applied[region] ?? 0)) return; // an answer to a newer request is already shown
    applied[region] = issued;
    feed.update((f) => ({ ...f, error: "", byRegion: { ...f.byRegion, [region]: d } }));
  } catch {
    feed.update((f) => (f.error ? f : { ...f, error: "Live alerts are delayed — retrying." }));
  }
}

async function acknowledge(alert: Alert) {
  if (ACK === "set" && alert.acked) return;
  const setLocal = (acked: boolean) => feed.update((f) => ({ ...f, byRegion: { ...f.byRegion, [alert.region]: (f.byRegion[alert.region] ?? []).map((a) => (a.id === alert.id ? { ...a, acked } : a)) } }));
  setLocal(ACK === "set" ? true : !alert.acked);
  try {
    const saved = await api<Alert>(`/api/alerts/${alert.id}/${ACK === "set" ? "ack" : "toggle-ack"}`, "POST", {});
    setLocal(saved.acked);
  } catch {
    setLocal(alert.acked);
    feed.update((f) => ({ ...f, error: "The acknowledgement did not reach the operations centre." }));
  }
}

// ---------------------------------------------------------------------------------------------- elements
abstract class AtomElement extends HTMLElement {
  protected root = this.attachShadow({ mode: "open" });
  private offs: (() => void)[] = [];
  protected abstract render(): void;
  protected watch(): { subscribe(fn: () => void): () => void }[] {
    return [subs, feed];
  }
  connectedCallback() {
    this.offs = this.watch().map((a) => a.subscribe(() => this.render()));
    this.render();
  }
  disconnectedCallback() {
    this.offs.forEach((off) => off());
    this.offs = [];
  }
}

class WxPicker extends AtomElement {
  protected watch() {
    return [subs];
  }
  connectedCallback() {
    this.root.innerHTML = `<form class="picker"><label>Region <select name="region">${Object.entries(REGIONS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
      <label>Notify me for <select name="severity"><option value="advisory">Advisories and up</option><option value="watch">Watches and up</option><option value="warning">Warnings only</option></select></label>
      <button type="submit" class="subscribe">Subscribe</button><p class="msg"></p></form>`;
    this.root.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      const f = e.target as HTMLFormElement;
      void subscribe((f.elements.namedItem("region") as HTMLSelectElement).value, (f.elements.namedItem("severity") as HTMLSelectElement).value as Severity);
    });
    super.connectedCallback();
  }
  protected render() {
    const s = subs.get();
    const btn = this.root.querySelector<HTMLButtonElement>("button.subscribe")!;
    btn.disabled = SUB_GUARD === "inflight" && s.adding;
    btn.textContent = s.adding ? "Subscribing…" : "Subscribe";
    this.root.querySelector(".msg")!.innerHTML = s.error ? `<span role="alert">${esc(s.error)}</span>` : esc(s.notice);
  }
}

class WxSubRow extends HTMLElement {
  sub!: Sub;
  private root = this.attachShadow({ mode: "open" });
  private timer: ReturnType<typeof setTimeout> | null = null;
  private live = false;
  connectedCallback() {
    this.render();
    this.live = true;
    const tick = () => {
      const cur = subs.get().items.find((x) => x.id === this.sub.id) ?? this.sub;
      return cur.muted ? Promise.resolve() : pollRegion(cur.region);
    };
    if (POLL === "interval") {
      void tick();
      this.timer = setInterval(() => void tick(), POLL_MS);
    } else {
      const loop = async () => {
        await tick();
        if (this.live) this.timer = setTimeout(() => void loop(), POLL_MS);
      };
      void loop();
    }
  }
  disconnectedCallback() {
    if (!POLL_CLEANUP) return;
    this.live = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      clearInterval(this.timer);
    }
    this.timer = null;
  }
  update(sub: Sub) {
    this.sub = sub;
    this.render();
  }
  render() {
    const s = this.sub;
    this.root.innerHTML = `<div class="row${s.muted ? " muted" : ""}"><strong>${esc(REGIONS[s.region] ?? s.region)}</strong> · ${esc(s.minSeverity)} and above${s.muted ? " · muted" : ""}
      <button type="button" class="mute">${s.muted ? "Unmute" : "Mute"}</button> <button type="button" class="remove">Unsubscribe</button></div>`;
    this.root.querySelector("button.mute")!.addEventListener("click", () => void toggleMute(s.id));
    this.root.querySelector("button.remove")!.addEventListener("click", () => void unsubscribe(s.id));
  }
}

class WxSubscriptions extends AtomElement {
  private shown: Sub[] | null = null;
  protected watch() {
    return [subs];
  }
  protected render() {
    const s = subs.get();
    if (!this.root.querySelector("ul")) this.root.innerHTML = `<h2>My subscriptions</h2><p class="empty"></p><ul class="subs"></ul>`;
    this.root.querySelector(".empty")!.textContent = s.loading ? "Loading subscriptions…" : s.items.length ? "" : "No subscriptions yet.";
    if (s.items === this.shown) return; // only the list itself changes the rows
    this.shown = s.items;
    const ul = this.root.querySelector("ul")!;
    if (ROW_RENDER === "replace") {
      ul.innerHTML = "";
      for (const sub of s.items) {
        const li = document.createElement("li");
        const row = document.createElement("wx-sub-row") as WxSubRow;
        row.sub = sub;
        li.appendChild(row);
        ul.appendChild(li);
      }
      return;
    }
    const existing = new Map(Array.from(ul.querySelectorAll<WxSubRow>("wx-sub-row")).map((r) => [r.sub.id, r]));
    for (const [id, row] of existing) if (!s.items.some((x) => x.id === id)) row.parentElement!.remove();
    for (const sub of s.items) {
      const row = existing.get(sub.id);
      if (row) {
        if (row.sub !== sub) row.update(sub);
        continue;
      }
      const li = document.createElement("li");
      const el = document.createElement("wx-sub-row") as WxSubRow;
      el.sub = sub;
      li.appendChild(el);
      ul.appendChild(li);
    }
  }
}

class WxFeed extends AtomElement {
  constructor() {
    super();
    this.root.addEventListener("click", (e) => {
      const btn = (e.target as Element).closest("button.ack") as HTMLElement | null;
      if (!btn) return;
      const a = this.visible().find((x) => x.id === Number(btn.dataset.id));
      if (a) void acknowledge(a);
    });
  }
  private visible(): Alert[] {
    const f = feed.get();
    const out: Alert[] = [];
    for (const sub of subs.get().items) {
      if (sub.muted) continue;
      for (const a of f.byRegion[sub.region] ?? []) if (RANK[a.severity] >= RANK[sub.minSeverity] && !out.some((o) => o.id === a.id)) out.push(a);
    }
    return out.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.id - b.id);
  }
  protected render() {
    const list = this.visible();
    const open = list.filter((a) => !a.acked).length;
    const err = feed.get().error;
    this.root.innerHTML = `<h2>Active alerts</h2><p class="summary">${list.length} active alert(s), ${open} unacknowledged</p>${err ? `<p role="alert">${esc(err)}</p>` : ""}
      <ol class="alerts">${list.map((a) => `<li class="alert sev-${a.severity}${a.acked ? " acked" : ""}"><strong>${a.severity.toUpperCase()}</strong> ${esc(REGIONS[a.region] ?? a.region)} — ${esc(a.headline)} until ${esc(a.until)} ${a.acked ? `<span class="done">Acknowledged</span>${ACK === "toggle" ? ` <button type="button" class="ack" data-id="${a.id}">Undo</button>` : ""}` : `<button type="button" class="ack" data-id="${a.id}">Acknowledge</button>`}</li>`).join("")}</ol>`;
  }
}

class WxApp extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML = `<header><h1>Regional Weather Alerts</h1><p>Emergency Management Office · duty console</p></header><wx-picker></wx-picker><wx-subscriptions></wx-subscriptions><wx-feed></wx-feed>`;
  }
}

customElements.define("wx-picker", WxPicker);
customElements.define("wx-sub-row", WxSubRow);
customElements.define("wx-subscriptions", WxSubscriptions);
customElements.define("wx-feed", WxFeed);
customElements.define("wx-app", WxApp);

document.getElementById("app")!.appendChild(document.createElement("wx-app"));
void loadSubs();
