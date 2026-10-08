// Design-review comment threads (React 19 actions: <form action>, useActionState for posting, useOptimistic for
// the pending comment, useFormStatus for the submit button; review data in a GenClass atom via useGenClassState,
// fetch). Comments from other reviewers arrive by polling every 6 s. Latent bugs by flag: the comment appended to
// the real list before the request instead of an optimistic layer, and left there when the post fails
// (optimistic=manual-no-rollback), a Post button that stays enabled while the action is pending, so a double
// click queues the same comment twice (pendingGuard=none), polls that replace the list and drop a comment saved
// while they were in flight (poll=replace), the comment total incremented on success even when the poll already
// counted it (count=increment), likes sent once per click (likeGuard=none: a double click likes twice).
import { createRoot } from "react-dom/client";
import { useActionState, useCallback, useEffect, useOptimistic } from "react";
import { useFormStatus } from "react-dom";
import { useGenClassState } from "@genclass/runtime/react";
import { flag } from "../_shared/genclass";

type Thread = { id: number; title: string; anchor: string; resolved: boolean };
type Comment = { id: number | string; threadId: number; author: string; body: string; likes: number; pending?: boolean };
interface Review {
  threads: Thread[];
  comments: Comment[];
  total: number;
  active: number;
  liked: (number | string)[];
  syncing: boolean;
  error: string;
}
type PostResult = { error: string };

const OPTIMISTIC = flag("optimistic", "useOptimistic") as "useOptimistic" | "manual-no-rollback";
const PENDING_GUARD = flag("pendingGuard", "form-status") as "form-status" | "none";
const POLL = flag("poll", "merge") as "merge" | "replace";
const COUNT = flag("count", "recount") as "recount" | "increment";
const LIKE_GUARD = flag("likeGuard", "once") as "once" | "none";
const ME = "you";
const SYNC_ERR = "Could not refresh the comments";

const saved = (cs: Comment[]) => cs.filter((c) => !c.pending).length;
async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}
/** Server list plus what we have locally that the poll did not include yet (it may have started before a post). */
function merge(local: Comment[], server: Comment[]): Comment[] {
  const ids = new Set(server.map((c) => c.id));
  return [...server, ...local.filter((c) => !ids.has(c.id))];
}
let seq = 0;

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button className="post" type="submit" disabled={PENDING_GUARD === "form-status" && pending}>
      {pending ? "Posting…" : "Post"}
    </button>
  );
}

function App() {
  const [review, setReview] = useGenClassState<Review>("review", { threads: [], comments: [], total: 0, active: 61, liked: [], syncing: false, error: "" });
  const [shown, addOptimistic] = useOptimistic(review.comments, (cur: Comment[], c: Comment) => [...cur, c]);

  const sync = useCallback(async () => {
    setReview((r) => ({ ...r, syncing: true }));
      try {
        const [threads, page] = await Promise.all([http<Thread[]>("/api/threads"), http<{ items: Comment[] }>("/api/comments?limit=200")]);
        setReview((r) => {
          const comments = POLL === "merge" ? merge(r.comments, page.items) : page.items;
          return { ...r, threads, comments, total: saved(comments), syncing: false, error: r.error === SYNC_ERR ? "" : r.error };
        });
      } catch {
        setReview((r) => ({ ...r, syncing: false, error: SYNC_ERR }));
      }
  }, [setReview]);
  useEffect(() => {
    void sync();
    const h = setInterval(() => void sync(), 6000);
    return () => clearInterval(h);
  }, [sync]);

  async function postComment(_prev: PostResult, fd: FormData): Promise<PostResult> {
    const body = String(fd.get("body") ?? "").trim();
    const threadId = Number(fd.get("threadId"));
    if (!body) return { error: "Write something first" };
    const temp: Comment = { id: `tmp-${++seq}`, threadId, author: ME, body, likes: 0 };
    if (OPTIMISTIC === "useOptimistic") addOptimistic({ ...temp, pending: true });
    else setReview((r) => ({ ...r, comments: [...r.comments, temp], total: COUNT === "recount" ? saved([...r.comments, temp]) : r.total }));
    try {
      const c = await http<Comment>("/api/comments", { method: "POST", body: JSON.stringify({ threadId, author: ME, body, likes: 0 }) });
      setReview((r) => {
        const known = r.comments.some((x) => x.id === c.id);
        const hasTemp = r.comments.some((x) => x.id === temp.id);
        const comments = known ? r.comments.filter((x) => x.id !== temp.id) : hasTemp ? r.comments.map((x) => (x.id === temp.id ? c : x)) : [...r.comments, c];
        return { ...r, comments, total: COUNT === "recount" ? saved(comments) : r.total + 1 };
      });
      return { error: "" };
    } catch {
      // manual-no-rollback: the comment appended above stays in the list as if it had been posted
      return { error: "Your comment was not posted, please try again" };
    }
  }
  const [postState, postAction] = useActionState(postComment, { error: "" });

  async function resolveThread(fd: FormData) {
    const id = Number(fd.get("threadId"));
    setReview((r) => ({ ...r, threads: r.threads.map((t) => (t.id === id ? { ...t, resolved: true } : t)) }));
    try {
      await http<Thread>(`/api/threads/${id}`, { method: "PATCH", body: JSON.stringify({ resolved: true }) });
    } catch {
      setReview((r) => ({ ...r, threads: r.threads.map((t) => (t.id === id ? { ...t, resolved: false } : t)), error: "Could not resolve the thread" }));
    }
  }

  function like(c: Comment) {
    if (typeof c.id === "string" || (LIKE_GUARD === "once" && review.liked.includes(c.id))) return;
    setReview((r) => ({ ...r, liked: [...r.liked, c.id], comments: r.comments.map((x) => (x.id === c.id ? { ...x, likes: x.likes + 1 } : x)) }));
    http<Comment>(`/api/comments/${c.id}/like`, { method: "POST" }).then(
      (s) => setReview((r) => ({ ...r, comments: r.comments.map((x) => (x.id === s.id ? { ...x, likes: s.likes } : x)) })),
      () => setReview((r) => ({ ...r, liked: r.liked.filter((id) => id !== c.id), comments: r.comments.map((x) => (x.id === c.id ? { ...x, likes: x.likes - 1 } : x)), error: "Your like did not go through" })),
    );
  }

  const active = review.threads.find((t) => t.id === review.active);
  return (
    <main className="review">
      <header>
        <h1>Landing page review</h1>
        <p className="total">{review.total} comments</p>
        <button className="refresh" onClick={() => void sync()}>
          {review.syncing ? "Syncing…" : "Refresh"}
        </button>
      </header>
      {review.error && <p role="alert">{review.error}</p>}
      {review.threads.map((t) => (
        <section key={t.id} className={t.resolved ? "thread resolved" : "thread"}>
          <h3>
            {t.title} <small>{t.anchor}</small>
          </h3>
          {t.resolved ? (
            <p className="resolved">Resolved</p>
          ) : (
            <form action={resolveThread}>
              <input type="hidden" name="threadId" value={t.id} />
              <button className="resolve" type="submit">
                Resolve
              </button>
            </form>
          )}
          <button className="reply-to" onClick={() => setReview((r) => ({ ...r, active: t.id }))}>
            Reply
          </button>
          <ul>
            {shown
              .filter((c) => c.threadId === t.id)
              .map((c) => (
                <li key={c.id} className={c.pending ? "comment pending" : "comment"}>
                  {c.author}: {c.body} · {c.likes} likes{" "}
                  {c.pending ? (
                    <em>sending…</em>
                  ) : (
                    <button className="like" disabled={LIKE_GUARD === "once" && review.liked.includes(c.id)} onClick={() => like(c)}>
                      {review.liked.includes(c.id) ? "Liked" : "Like"}
                    </button>
                  )}
                </li>
              ))}
          </ul>
        </section>
      ))}
      <form action={postAction} className="composer">
        <p>Replying to: {active?.title ?? "…"}</p>
        <input type="hidden" name="threadId" value={review.active} />
        <textarea name="body" placeholder="Add a comment" />
        <SubmitButton />
        {postState.error && <p role="alert">{postState.error}</p>}
      </form>
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
