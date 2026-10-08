// Fantasy football draft room (Lit 3 element with shadow DOM holding its own state — nothing registered with
// GenClass: observe-only; fetch + WebSocket). Available players page by 8 with a position filter; other teams draft
// live. Drafting a player is two writes: claim him (versioned PATCH status=drafted, so two teams can't both get him)
// and record the pick (POST /picks, one per player). Latent bugs by flag: draft buttons live while a pick posts
// (pickGuard=none), the available list not refreshed when other teams pick (available=stale: drafted players are
// still offered and the claim fails), page answers applied in arrival order (pageSeq=blind), the pick recorded before
// the player is claimed (steps=record-first: a lost claim leaves a dangling pick) and reconnects without a reload
// (reconnect=naive).
import { LitElement, html, nothing } from "lit";
import { flag } from "../_shared/genclass";
import { api, itemsOf, errText, HttpError, liveTopic } from "../_shared/w3-http";

type Player = { id: number; name: string; pos: string; team: string; rank: number; status: string; by: string; version: number };
type Pick = { id: number; playerId: number; name: string; team: string };
const PICK_GUARD = flag("pickGuard", "pending") === "pending";
const AVAILABLE = flag("available", "refetch-on-push");
const PAGE_SEQ = flag("pageSeq", "latest");
const STEPS = flag("steps", "claim-first");
const RECONNECT = flag("reconnect", "resync");
const PER = 8;

class DraftRoom extends LitElement {
  private s = { pos: "All", page: 1, rows: [] as Player[], total: 0, loading: true, mine: [] as Pick[], queue: [] as number[], busy: [] as number[], ticker: [] as string[], live: false, error: "", notice: "" };
  private seq = 0;
  private refetch: ReturnType<typeof setTimeout> | undefined;

  private set(patch: Partial<DraftRoom["s"]>) {
    Object.assign(this.s, patch);
    this.requestUpdate();
  }

  connectedCallback() {
    super.connectedCallback();
    let everUp = false;
    liveTopic(
      "players",
      (m) => {
        const p = m.item as Player | undefined;
        if (m.type !== "updated" || !p || p.status !== "drafted") return;
        if (p.by !== "You") this.set({ ticker: [`${p.by} took ${p.name} (${p.pos})`, ...this.s.ticker].slice(0, 4) });
        if (AVAILABLE === "refetch-on-push" && this.s.rows.some((r) => r.id === p.id)) {
          clearTimeout(this.refetch);
          this.refetch = setTimeout(() => void this.load(true), 300);
        }
      },
      (up) => {
        this.set({ live: up });
        if (up && everUp && RECONNECT === "resync") void this.load(true);
        if (up) everUp = true;
      },
    );
    void this.load();
    void api(`/api/picks?team=you&limit=30`).then((b) => this.set({ mine: itemsOf<Pick>(b) }), () => undefined);
  }

  async load(background = false) {
    const my = ++this.seq;
    const { pos, page } = this.s;
    if (!background) this.set({ loading: true, error: "" });
    try {
      const body = await api<{ items: Player[]; total: number }>(`/api/players?status=available&sort=rank&page=${page}&limit=${PER}${pos === "All" ? "" : `&pos=${pos}`}`);
      if ((PAGE_SEQ === "latest" || background) && my !== this.seq) return;
      this.set({ rows: itemsOf<Player>(body), total: Number(body.total ?? 0), loading: false });
    } catch (e) {
      if (my === this.seq) this.set({ loading: false, error: background ? this.s.error : errText(e, "loading players") });
    }
  }

  async draft(p: Player) {
    if (PICK_GUARD && this.s.busy.length) return;
    if (this.s.mine.some((x) => x.playerId === p.id)) return;
    this.set({ busy: [...this.s.busy, p.id], error: "", notice: "" });
    const claim = () => api<Player>(`/api/players/${p.id}`, "PATCH", { status: "drafted", by: "You", version: p.version });
    const record = () => api<Pick>(`/api/picks`, "POST", { playerId: p.id, name: p.name, team: "you" });
    try {
      let pick: Pick;
      if (STEPS === "claim-first") {
        await claim();
        pick = await record().catch(() => record());
      } else {
        pick = await record();
        await claim();
      }
      this.set({ mine: [...this.s.mine, pick], rows: this.s.rows.filter((r) => r.id !== p.id), total: Math.max(0, this.s.total - 1), queue: this.s.queue.filter((id) => id !== p.id), notice: `You drafted ${p.name} (${p.pos}, ${p.team}).` });
      void this.load(true);
    } catch (e) {
      const cur = e instanceof HttpError && e.status === 409 ? (e.body?.current as Player | undefined) : undefined;
      this.set({ error: cur ? `${p.name} was just taken by ${cur.by}.` : e instanceof HttpError && e.status === 409 ? `${p.name} is already picked.` : errText(e, `drafting ${p.name}`) });
      if (cur || (e instanceof HttpError && e.status === 409)) void this.load(true);
    } finally {
      this.set({ busy: this.s.busy.filter((x) => x !== p.id) });
    }
  }

  private go(patch: { pos?: string; page?: number }) {
    this.set({ ...patch, notice: "" });
    void this.load();
  }

  render() {
    const s = this.s;
    const pages = Math.max(1, Math.ceil(s.total / PER));
    return html`<h1>Draft room</h1>
      <p class="status">${s.mine.length} on your roster · ${s.live ? "live" : "reconnecting…"}</p>
      <ul class="ticker">${s.ticker.map((t) => html`<li>${t}</li>`)}</ul>
      ${s.error ? html`<p role="alert">${s.error}</p>` : s.notice ? html`<p class="notice">${s.notice}</p>` : nothing}
      <nav class="pos">${["All", "QB", "RB", "WR", "TE"].map((p) => html`<button type="button" class=${s.pos === p ? "current" : ""} @click=${() => this.go({ pos: p, page: 1 })}>${p}</button>`)}</nav>
      ${s.loading ? html`<p class="muted">Loading…</p>` : nothing}
      <ol class="players">${s.rows.map(
        (p) => html`<li class="player">#${p.rank} ${p.name} · ${p.pos} · ${p.team}
          <button type="button" class="draft" ?disabled=${PICK_GUARD && s.busy.length > 0} @click=${() => void this.draft(p)}>${s.busy.includes(p.id) ? "Drafting…" : "Draft"}</button>
          <button type="button" class="queue" @click=${() => this.set({ queue: s.queue.includes(p.id) ? s.queue.filter((x) => x !== p.id) : [...s.queue, p.id] })}>${s.queue.includes(p.id) ? "Queued" : "Queue"}</button></li>`,
      )}</ol>
      <nav class="pages">${Array.from({ length: pages }, (_, i) => html`<button type="button" class=${s.page === i + 1 ? "current" : ""} @click=${() => this.go({ page: i + 1 })}>${i + 1}</button>`)}</nav>
      <h2>Your roster</h2><ul class="roster">${s.mine.map((p) => html`<li>${p.name}</li>`)}</ul>`;
  }
}
customElements.define("draft-room", DraftRoom);
document.getElementById("app")!.appendChild(document.createElement("draft-room"));
