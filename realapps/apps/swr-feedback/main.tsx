// Product feedback board (React 19 + SWR: useSWRInfinite for the idea list, useSWR for the counters, bound and
// global mutate; fetch). Customers browse feature ideas sorted by votes, filtered by status tabs (status=open,
// status__in=planned,in-progress, status=done) and paged by cursor (?cursor=<last id> → nextCursor, "Load more"),
// upvote ideas (POST /ideas/:id/vote, relative; optimistic update of the cached pages) and suggest new ones (POST
// /ideas: the title must be unique → 409 "already suggested", title and details are required → 422). The board
// refreshes itself every 6 s. Votes in flight, the user's own votes and messages live in a runtime atom; SWR's cache
// is not wrapped. Latent bugs by flag: optimistic votes kept when the POST fails (vote=optimistic-no-rollback: the
// count stays one too high until a refresh), vote buttons live while the vote posts and after it (voteGuard=none: a
// double click votes twice), tab switches that keep the pages and the list of the previous tab (filterReset=
// keep-pages: the old tab's ideas stay on screen under the new tab until — or if a load fails, instead of — the new
// ones), a Post button live while the idea posts (submitGuard=none: the second POST answers 409 and the user is told
// their own idea "was already suggested") and request de-duplication switched off (dedupingInterval=0).
import { createRoot } from "react-dom/client";
import { useState, type FormEvent } from "react";
import useSWR, { SWRConfig, useSWRConfig } from "swr";
import useSWRInfinite from "swr/infinite";
import { useAtom } from "@genclass/runtime/react";
import { rt, flag } from "../_shared/genclass";

type Status = "open" | "planned" | "in-progress" | "done";
type Idea = { id: number; title: string; details: string; status: Status; votes: number; author: string };
type Page = { items: Idea[]; total: number; nextCursor?: string | null };

const VOTE = flag("vote", "optimistic-rollback");
const VOTE_GUARD = flag("voteGuard", "pending") === "pending";
const KEEP_PAGES = flag("filterReset", "reset-pages") === "keep-pages";
const SUBMIT_GUARD = flag("submitGuard", "pending") === "pending";
const DEDUPE = Number(flag("dedupingInterval", 2000));
const PAGE = 4;
const ME = "Robin (you)";
const TABS = [
  { id: "all", label: "All", query: "" },
  { id: "review", label: "Under review", query: "&status=open" },
  { id: "roadmap", label: "Planned", query: "&status__in=planned,in-progress" },
  { id: "shipped", label: "Shipped", query: "&status=done" },
];
const LABEL: Record<Status, string> = { open: "under review", planned: "planned", "in-progress": "in progress", done: "shipped" };
const ROADMAP = "/api/ideas?limit=1&status__in=planned,in-progress";

const ui = rt.atom("ui", { tab: "all", voted: [] as number[], voting: [] as number[], submitting: false, error: "", notice: "" });

class HttpErr extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}
const statusOf = (e: unknown) => (e instanceof HttpErr ? e.status : 0);
async function fetcher<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new HttpErr(r.status);
  return (await r.json()) as T;
}
async function post<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!r.ok) throw new HttpErr(r.status);
  return (await r.json()) as T;
}
const pageKey = (tab: string) => (i: number, prev: Page | null) => {
  if (prev && !prev.nextCursor) return null;
  return `/api/ideas?sort=-votes&limit=${PAGE}${TABS.find((t) => t.id === tab)!.query}&cursor=${i === 0 ? "" : prev!.nextCursor}`;
};

function Summary() {
  const all = useSWR<Page>("/api/ideas?limit=1");
  const road = useSWR<Page>(ROADMAP);
  return (
    <p className="summary">
      {all.data?.total ?? "–"} ideas · {road.data?.total ?? "–"} on the roadmap
    </p>
  );
}

function Tabs() {
  const [u, setU] = useAtom(ui);
  const road = useSWR<Page>(ROADMAP); // the same key as the summary (a second subscriber)
  return (
    <nav className="tabs">
      {TABS.map((t) => (
        <button key={t.id} type="button" className={u.tab === t.id ? "current" : ""} onClick={() => setU((x) => ({ ...x, tab: t.id, notice: "" }))}>
          {t.label}
          {t.id === "roadmap" && road.data ? ` (${road.data.total})` : ""}
        </button>
      ))}
    </nav>
  );
}

function Board() {
  const [u] = useAtom(ui);
  const { mutate: mutateKey } = useSWRConfig();
  const { data, error, size, setSize, isLoading, mutate } = useSWRInfinite<Page>(pageKey(u.tab), fetcher, { persistSize: KEEP_PAGES, keepPreviousData: KEEP_PAGES });
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const seen = new Set<number>();
  const ideas = (data ?? []).flatMap((p) => p.items).filter((i) => !seen.has(i.id) && Boolean(seen.add(i.id)));
  const loadingMore = isLoading || (size > 0 && !!data && data[size - 1] === undefined);
  const hasMore = !!data?.length && !!data[data.length - 1]?.nextCursor;

  const vote = async (idea: Idea) => {
    const cur = ui.get();
    if (VOTE_GUARD && (cur.voting.includes(idea.id) || cur.voted.includes(idea.id))) return;
    ui.update((x) => ({ ...x, voting: [...x.voting, idea.id], error: "", notice: "" }));
    const patch = (pages: Page[] | undefined, fn: (i: Idea) => Idea) => pages?.map((p) => ({ ...p, items: p.items.map((i) => (i.id === idea.id ? fn(i) : i)) }));
    try {
      await mutate(
        async (pages) => {
          const saved = await post<Idea>(`/api/ideas/${idea.id}/vote`);
          return patch(pages, () => saved);
        },
        { optimisticData: (pages) => patch(pages, (i) => ({ ...i, votes: i.votes + 1 })) ?? [], rollbackOnError: VOTE === "optimistic-rollback", populateCache: true, revalidate: false },
      );
      ui.update((x) => ({ ...x, voted: x.voted.includes(idea.id) ? x.voted : [...x.voted, idea.id], notice: `Thanks for backing “${idea.title}”.` }));
    } catch (e) {
      ui.update((x) => ({ ...x, error: `Your vote for “${idea.title}” didn't go through (${statusOf(e) || "network error"}).` }));
    } finally {
      ui.update((x) => ({ ...x, voting: x.voting.filter((v) => v !== idea.id) }));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (SUBMIT_GUARD && ui.get().submitting) return;
    const t = title.trim();
    ui.update((x) => ({ ...x, submitting: true, error: "", notice: "" }));
    try {
      const saved = await post<Idea>("/api/ideas", { title: t, details: details.trim(), status: "open", votes: 1, author: ME });
      setTitle("");
      setDetails("");
      ui.update((x) => ({ ...x, voted: [...x.voted, saved.id], notice: `Thanks! “${saved.title}” is up for votes.` }));
      void mutate();
      void mutateKey("/api/ideas?limit=1");
    } catch (err) {
      const s = statusOf(err);
      ui.update((x) => ({ ...x, error: s === 409 ? `“${t}” was already suggested — find it and upvote it instead.` : s === 422 ? "Add a title and a sentence about why you need it." : `Couldn't post your idea (${s || "network error"}).` }));
    } finally {
      ui.update((x) => ({ ...x, submitting: false }));
    }
  };

  return (
    <>
      {error && <p role="alert">Couldn't load ideas ({statusOf(error) || "network error"}).</p>}
      {u.error ? <p role="alert">{u.error}</p> : u.notice ? <p className="notice">{u.notice}</p> : null}
      {!data && !error ? <p className="muted">Loading ideas…</p> : null}
      <ul className="ideas">
        {ideas.map((i) => (
          <li key={i.id} className={`idea ${i.status}`}>
            <strong className="title">{i.title}</strong> · <span className="status">{LABEL[i.status]}</span> · <span className="votes">{i.votes} votes</span> · <span className="by">by {i.author}</span>{" "}
            {i.status !== "done" && (
              <button type="button" className="vote" disabled={VOTE_GUARD && (u.voting.includes(i.id) || u.voted.includes(i.id))} onClick={() => void vote(i)}>
                {u.voted.includes(i.id) ? "Voted" : "Upvote"}
              </button>
            )}
          </li>
        ))}
      </ul>
      {data && !ideas.length && <p className="muted">No ideas here yet.</p>}
      {hasMore && (
        <button type="button" className="load-more" disabled={loadingMore} onClick={() => !loadingMore && void setSize(size + 1)}>
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      )}
      <form className="new-idea" onSubmit={(e) => void submit(e)}>
        <h2>Suggest an idea</h2>
        <input name="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short title" />
        <textarea name="details" value={details} onChange={(e) => setDetails(e.target.value)} placeholder="What would it help you do?" />
        <button type="submit" disabled={SUBMIT_GUARD && u.submitting}>
          {u.submitting ? "Posting…" : "Post idea"}
        </button>
      </form>
    </>
  );
}

function App() {
  return (
    <main className="feedback">
      <h1>Feedback · Lumen Notes</h1>
      <Summary />
      <Tabs />
      <Board />
    </main>
  );
}

createRoot(document.getElementById("app")!).render(
  <SWRConfig value={{ fetcher, refreshInterval: 6000, dedupingInterval: DEDUPE, errorRetryCount: 3 }}>
    <App />
  </SWRConfig>,
);
