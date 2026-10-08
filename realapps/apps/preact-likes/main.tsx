// Reading list with claps (Preact + @preact/signals + fetch; state in runtime atoms mirrored into signals). A clap
// is a relative, non-idempotent POST /articles/:id/like answered with the article's new count; a trending sidebar
// polls the most-clapped articles and also refreshes the counts in the list. Latent bugs by flag: client retry on
// timeout / 5xx without an Idempotency-Key (retry=naive: a request that timed out after the server counted it is
// counted twice; retry=keyed retries safely, retry=none gives up), counts from echoes and polls applied as-is so an
// older count overwrites a newer one (echo=blind), polling on a fixed interval so slow polls overlap and land out
// of order (poll=interval), a short client timeout (timeoutMs) that makes retries more frequent.
import { render } from "preact";
import { useEffect } from "preact/hooks";
import { rt, flag } from "../_shared/genclass";
import { atomSignal } from "../_shared/preact-atom";

type Article = { id: number; title: string; author: string; minutes: number; likes: number };
type Row = Article & { mine: number };
type Top = { id: number; title: string; likes: number };

const RETRY = flag("retry", "keyed") as "keyed" | "none" | "naive";
const ECHO = flag("echo", "max") as "max" | "blind";
const POLL = flag("poll", "chain") as "chain" | "interval";
const TIMEOUT_MS = Number(flag("timeoutMs", 2500));
const POLL_MS = 3000;

const reading = rt.atom("reading", { articles: [] as Row[], loading: true, error: "" });
const trending = rt.atom("trending", { top: [] as Top[], stale: false });
const detail = rt.atom("detail", { id: 0, title: "", summary: "", loading: false });
const readingSig = atomSignal(reading);
const trendingSig = atomSignal(trending);
const detailSig = atomSignal(detail);

const merge = (local: number, server: unknown) => (typeof server !== "number" ? local : ECHO === "max" ? Math.max(local, server) : server);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

async function loadArticles() {
  try {
    const r = await fetch("/api/articles?limit=20");
    if (!r.ok) throw new HttpError(r.status);
    const data = (await r.json()) as { items: Article[] };
    reading.update((s) => ({ ...s, articles: (data.items ?? []).map((a) => ({ ...a, mine: 0 })), loading: false, error: "" }));
  } catch {
    reading.update((s) => ({ ...s, loading: false, error: "Couldn't load your reading list." }));
    setTimeout(() => void loadArticles(), 3000);
  }
}

/** POST one clap; retried on timeouts and 5xx unless retry=none. */
async function postClap(id: number): Promise<Article> {
  const key = RETRY === "keyed" ? crypto.randomUUID() : null;
  const attempts = RETRY === "none" ? 1 : 3;
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`/api/articles/${id}/like`, {
        method: "POST",
        headers: key ? { "Idempotency-Key": key } : {},
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!r.ok) throw new HttpError(r.status);
      return (await r.json()) as Article;
    } catch (e) {
      const err = e as Error;
      const retryable = err.name === "TimeoutError" || err.name === "TypeError" || (err instanceof HttpError && (err.status >= 500 || err.status === 429));
      if (!retryable || i >= attempts - 1) throw err;
      await sleep(400 * 2 ** i);
    }
  }
}

async function clap(id: number) {
  reading.update((s) => ({ ...s, error: "", articles: s.articles.map((a) => (a.id === id ? { ...a, likes: a.likes + 1, mine: a.mine + 1 } : a)) }));
  try {
    const saved = await postClap(id);
    reading.update((s) => ({ ...s, articles: s.articles.map((a) => (a.id === id ? { ...a, likes: merge(a.likes, saved.likes) } : a)) }));
  } catch (e) {
    const timeout = (e as Error).name === "TimeoutError";
    reading.update((s) => ({
      ...s,
      error: timeout ? "The server is slow; your clap may not have counted." : "Your clap didn't go through.",
      articles: s.articles.map((a) => (a.id === id ? { ...a, likes: a.likes - 1, mine: Math.max(0, a.mine - 1) } : a)),
    }));
  }
}

async function pollTrending() {
  try {
    const r = await fetch(`/api/articles?sort=-likes&limit=5`);
    if (!r.ok) throw new HttpError(r.status);
    const items = ((await r.json()) as { items: Article[] }).items ?? [];
    trending.set({ top: items.map(({ id, title, likes }) => ({ id, title, likes })), stale: false });
    reading.update((s) => ({
      ...s,
      articles: s.articles.map((a) => {
        const t = items.find((x) => x.id === a.id);
        return t ? { ...a, likes: merge(a.likes, t.likes) } : a;
      }),
    }));
  } catch {
    trending.update((t) => (t.stale ? t : { ...t, stale: true }));
  }
}

function startPolling() {
  if (POLL === "interval") {
    void pollTrending();
    setInterval(() => void pollTrending(), POLL_MS);
    return;
  }
  const tick = async () => {
    await pollTrending();
    setTimeout(() => void tick(), POLL_MS);
  };
  void tick();
}

let detailSeq = 0;
async function openArticle(a: Row) {
  const seq = ++detailSeq;
  detail.set({ id: a.id, title: a.title, summary: "", loading: true });
  try {
    const r = await fetch(`/api/articles/${a.id}`);
    if (!r.ok) throw new HttpError(r.status);
    const full = (await r.json()) as Article & { summary?: string };
    if (seq !== detailSeq) return;
    detail.update((d) => ({ ...d, summary: full.summary ?? "", loading: false }));
  } catch {
    if (seq !== detailSeq) return;
    detail.update((d) => ({ ...d, summary: "Preview unavailable.", loading: false }));
  }
}

// ------------------------------------------------------------------------------------------------------ UI
function ArticleCard({ a }: { a: Row }) {
  return (
    <li class="article">
      <h3>{a.title}</h3>
      <p class="meta">
        {a.author} · {a.minutes} min read
      </p>
      <p class="claps">
        <button class="clap" onClick={() => void clap(a.id)}>
          Clap
        </button>{" "}
        {a.likes} claps{a.mine > 0 ? ` (you: ${a.mine})` : ""} <button class="read" onClick={() => void openArticle(a)}>
          Preview
        </button>
      </p>
    </li>
  );
}

function Trending() {
  const t = trendingSig.value;
  return (
    <aside class="trending">
      <h2>Trending</h2>
      {t.stale && <p class="muted">Couldn't refresh trending.</p>}
      <ol>
        {t.top.map((x) => (
          <li key={x.id}>
            {x.title} ({x.likes})
          </li>
        ))}
      </ol>
    </aside>
  );
}

function App() {
  useEffect(() => {
    void loadArticles();
    startPolling();
  }, []);
  const s = readingSig.value;
  const d = detailSig.value;
  return (
    <div class="reader">
      <h1>Reading list</h1>
      {s.loading && <p>Loading articles…</p>}
      {s.error && <p role="alert">{s.error}</p>}
      <ul class="articles">
        {s.articles.map((a) => (
          <ArticleCard key={a.id} a={a} />
        ))}
      </ul>
      {d.id > 0 && (
        <section class="preview">
          <h2>{d.title}</h2>
          <p>{d.loading ? "Loading preview…" : d.summary}</p>
        </section>
      )}
      <Trending />
    </div>
  );
}

render(<App />, document.getElementById("app")!);
