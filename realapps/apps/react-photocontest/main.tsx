// Photo contest gallery (React 19 + useGenClassState; fetch + WebSocket). Entries page in six at a time ("Load
// more") by category, sorted by votes or newest; vote counts change live as others vote. Each visitor has 10 ballots:
// a vote is optimistic (POST /photos/:id/vote, then the ballot counter is decremented server-side) and can be taken
// back (unvote). Latent bugs by flag: votes not rolled back when they fail (vote=optimistic), a ballot counter
// adjusted by hand that a rollback forgets (ballots=manual), pages appended without checking ids while live votes
// reorder the "top" list (more=blind: the same photo twice), pushes treated as +1 instead of the server's count
// (live=increment: your own vote counts twice) and category loads applied in arrival order (tabSeq=blind).
import { createRoot } from "react-dom/client";
import { useEffect, useRef } from "react";
import { useGenClassState } from "@genclass/runtime/react";
import { flag } from "../_shared/genclass";
import { api, itemsOf, errText, liveTopic } from "../_shared/w3-http";

type Photo = { id: number; title: string; category: string; author: string; votes: number; createdAt?: string };
const VOTE = flag("vote", "optimistic-rollback");
const BALLOTS = flag("ballots", "recount");
const MORE = flag("more", "dedupe");
const LIVE = flag("live", "server-value");
const TAB_SEQ = flag("tabSeq", "latest");
const PER = 6;
const MAX = 10;
const CATS = ["All", "Landscape", "Street", "Wildlife"];

function Gallery() {
  const [g, setG] = useGenClassState("gallery", { tab: "All", sort: "top", items: [] as Photo[], total: 0, loading: true, loadingMore: false, voted: [] as number[], ballots: MAX, pending: [] as number[], live: false, error: "", notice: "" });
  const view = useRef({ tab: "All", sort: "top" });
  const seq = useRef(0);
  const count = useRef(0);

  const url = (tab: string, sort: string, offset: number) => `/api/photos?sort=${sort === "top" ? "-votes" : "-createdAt"}&offset=${offset}&limit=${PER}${tab === "All" ? "" : `&category=${tab}`}`;
  const ballotsFor = (voted: number[], prev: number, delta: number) => (BALLOTS === "recount" ? MAX - voted.length : prev + delta);

  async function load(tab: string, sort: string) {
    const my = ++seq.current;
    view.current = { tab, sort };
    setG((s) => ({ ...s, tab, sort, loading: true, error: "", notice: "" }));
    try {
      const body = await api<{ items: Photo[]; total: number }>(url(tab, sort, 0));
      if (TAB_SEQ === "latest" && my !== seq.current) return;
      count.current = itemsOf<Photo>(body).length;
      setG((s) => ({ ...s, items: itemsOf<Photo>(body), total: Number(body.total ?? 0), loading: false }));
    } catch (e) {
      if (my === seq.current) setG((s) => ({ ...s, loading: false, error: errText(e, "loading photos") }));
    }
  }

  async function more() {
    if (g.loadingMore || g.loading) return;
    const my = seq.current;
    const { tab, sort } = view.current;
    setG((s) => ({ ...s, loadingMore: true, error: "" }));
    try {
      const body = await api<{ items: Photo[]; total: number }>(url(tab, sort, count.current));
      if (my !== seq.current) return;
      const page = itemsOf<Photo>(body);
      count.current += page.length;
      setG((s) => ({ ...s, items: MORE === "dedupe" ? [...s.items, ...page.filter((p) => !s.items.some((x) => x.id === p.id))] : [...s.items, ...page], total: Number(body.total ?? s.total) }));
    } catch (e) {
      setG((s) => ({ ...s, error: errText(e, "loading more photos") }));
    } finally {
      setG((s) => ({ ...s, loadingMore: false }));
    }
  }

  async function toggleVote(p: Photo) {
    if (g.pending.includes(p.id)) return;
    const had = g.voted.includes(p.id);
    if (!had && g.ballots <= 0) return setG((s) => ({ ...s, error: "You have used all your ballots — take one back to vote again." }));
    const d = had ? -1 : 1;
    setG((s) => {
      const voted = had ? s.voted.filter((x) => x !== p.id) : [...s.voted, p.id];
      return { ...s, voted, ballots: ballotsFor(voted, s.ballots, -d), pending: [...s.pending, p.id], items: s.items.map((x) => (x.id === p.id ? { ...x, votes: x.votes + d } : x)), error: "", notice: "" };
    });
    try {
      const saved = await api<Photo>(`/api/photos/${p.id}/${had ? "unvote" : "vote"}`, "POST");
      setG((s) => ({ ...s, items: s.items.map((x) => (x.id === saved.id ? saved : x)), notice: had ? `Vote for “${p.title}” taken back.` : `You voted for “${p.title}”.` }));
      void api(`/api/counters/ballots-you/incr`, "POST", { by: -d }).catch(() => undefined);
    } catch (e) {
      setG((s) => {
        if (VOTE !== "optimistic-rollback") return { ...s, error: errText(e, "your vote") };
        const voted = had ? [...s.voted, p.id] : s.voted.filter((x) => x !== p.id);
        return { ...s, voted, ballots: BALLOTS === "recount" ? MAX - voted.length : s.ballots, items: s.items.map((x) => (x.id === p.id ? { ...x, votes: x.votes - d } : x)), error: errText(e, "your vote") };
      });
    } finally {
      setG((s) => ({ ...s, pending: s.pending.filter((x) => x !== p.id) }));
    }
  }

  useEffect(() => {
    void load("All", "top");
    const off = liveTopic(
      "photos",
      (m) => {
        if (m.type !== "updated" || !m.item) return;
        const p = m.item as Photo;
        setG((s) => ({ ...s, items: s.items.map((x) => (x.id !== p.id || s.pending.includes(p.id) ? x : LIVE === "server-value" ? { ...x, votes: p.votes } : { ...x, votes: x.votes + 1 })) }));
      },
      (up) => setG((s) => ({ ...s, live: up })),
    );
    return off;
  }, []);

  return (
    <main className="contest">
      <h1>Spring photo contest</h1>
      <p className="ballots">
        {g.ballots} of {MAX} ballots left · {g.live ? "live" : "reconnecting…"}
      </p>
      <nav className="categories">
        {CATS.map((c) => (
          <button key={c} type="button" className={g.tab === c ? "current" : ""} onClick={() => void load(c, view.current.sort)}>
            {c}
          </button>
        ))}
      </nav>
      <label>
        Sort{" "}
        <select name="sort" value={g.sort} onChange={(e) => void load(view.current.tab, e.target.value)}>
          <option value="top">Most votes</option>
          <option value="new">Newest</option>
        </select>
      </label>
      {g.error ? <p role="alert">{g.error}</p> : g.notice ? <p className="notice">{g.notice}</p> : null}
      {g.loading ? <p className="muted">Loading…</p> : null}
      <ul className="photos">
        {g.items.map((p, i) => {
          const mine = g.voted.includes(p.id);
          return (
            <li key={`${p.id}-${i}`} className="photo">
              “{p.title}” by {p.author} · {p.category} · {p.votes} votes{" "}
              <button type="button" className="vote" disabled={g.pending.includes(p.id) || (!mine && g.ballots <= 0)} onClick={() => void toggleVote(p)}>
                {mine ? "Unvote" : "Vote"}
              </button>
            </li>
          );
        })}
      </ul>
      {!g.loading && g.items.length < g.total ? (
        <button type="button" className="more" disabled={g.loadingMore} onClick={() => void more()}>
          {g.loadingMore ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<Gallery />);
