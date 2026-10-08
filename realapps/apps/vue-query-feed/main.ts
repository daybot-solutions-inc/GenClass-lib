// Community feed (Vue 3 templates + @tanstack/vue-query + axios). The feed lives in the vue-query cache under
// ["feed"] and is registered with rt.guard, so the app's own cache writes (pages appended by "Load more", optimistic
// likes, echoes, rollbacks) go through GenClass; the query's own fetches are traced. Latent bugs by flag:
// "Load more" without an in-flight / reset guard (loadMoreGuard=none: the same page appended twice, or a page from
// before a reset appended to the new feed), no de-duplication when offset pages shift (dedupe=none), optimistic
// like rolled back to a whole-feed snapshot (rollback=snapshot) or not at all (rollback=none), absolute like counts
// (likeMode=absolute: last writer wins over other people's likes), like echoes applied out of order
// (likeEcho=blind), reply button not locked while sending (replyGuard=false).
import { createApp, defineComponent, computed, ref } from "vue";
import { QueryClient, VueQueryPlugin, useMutation, useQuery } from "@tanstack/vue-query";
import axios from "axios";
import { rt, flag } from "../_shared/genclass";
import { useAtom } from "../_shared/vue-atom";

type Post = { id: number; author: string; text: string; likes: number; liked: boolean; comments: number; createdAt: string };
type Feed = { posts: Post[]; page: number; hasMore: boolean; total: number };
type Comment = { id: number; postId: number; author: string; text: string };
type Page = { items: Post[]; total: number; page: number };

const LOAD_GUARD = flag("loadMoreGuard", "inflight") as "inflight" | "none";
const DEDUPE = flag("dedupe", "by-id") as "by-id" | "none";
const ROLLBACK = flag("rollback", "invert") as "invert" | "snapshot" | "none";
const LIKE_MODE = flag("likeMode", "relative") as "relative" | "absolute";
const LIKE_ECHO = flag("likeEcho", "if-latest") as "if-latest" | "blind";
const REPLY_GUARD = Boolean(flag("replyGuard", true));
const PAGE_SIZE = 5;

const api = axios.create({ baseURL: "/api", timeout: 10000 });
const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15000 } } });

const EMPTY: Feed = { posts: [], page: 0, hasMore: false, total: 0 };
const feed = rt.guard<Feed>("feed", {
  get: () => qc.getQueryData<Feed>(["feed"]) ?? EMPTY,
  set: (v) => void qc.setQueryData<Feed>(["feed"], v),
  subscribe: (fn) =>
    qc.getQueryCache().subscribe((e) => {
      if (e.type === "updated" && e.query.queryKey[0] === "feed" && e.action.type === "success") fn();
    }),
});
const ui = rt.atom("ui", { openId: 0, draft: "", error: "" });

const fetchPage = (page: number) => api.get<Page>("/posts", { params: { page, limit: PAGE_SIZE, sort: "-createdAt" } }).then((r) => r.data);
const patchPost = (f: Feed, id: number, fn: (p: Post) => Post): Feed => ({ ...f, posts: f.posts.map((p) => (p.id === id ? fn(p) : p)) });

// ------------------------------------------------------------------------------------------ pagination
let generation = 0;
const loadingMore = ref(false);

async function loadFirst(): Promise<Feed> {
  generation++;
  const d = await fetchPage(1);
  return { posts: d.items, page: 1, hasMore: d.items.length < d.total, total: d.total };
}

async function loadMore() {
  if (LOAD_GUARD === "inflight" && loadingMore.value) return;
  const page = feed.get().page + 1;
  const gen = generation;
  loadingMore.value = true;
  ui.update((u) => ({ ...u, error: "" }));
  try {
    const d = await fetchPage(page);
    if (LOAD_GUARD === "inflight" && gen !== generation) return; // the feed was reset while this page loaded
    feed.update((cur) => {
      const have = new Set(cur.posts.map((p) => p.id));
      const fresh = DEDUPE === "by-id" ? d.items.filter((p) => !have.has(p.id)) : d.items;
      return { ...cur, posts: [...cur.posts, ...fresh], page, hasMore: page * PAGE_SIZE < d.total, total: d.total };
    });
  } catch {
    ui.update((u) => ({ ...u, error: "Couldn't load more posts." }));
  } finally {
    loadingMore.value = false;
  }
}

function showNew() {
  ui.update((u) => ({ ...u, openId: 0, error: "" }));
  void qc.refetchQueries({ queryKey: ["feed"] });
}

// --------------------------------------------------------------------------------------------- likes
const likeTokens = new Map<number, number>();

function useLike() {
  return useMutation({
    mutationFn: (v: { id: number; like: boolean; likes: number }) =>
      (LIKE_MODE === "relative" ? api.post<Post>(`/posts/${v.id}/${v.like ? "like" : "unlike"}`) : api.patch<Post>(`/posts/${v.id}`, { liked: v.like, likes: v.likes })).then((r) => r.data),
    onMutate: (v) => {
      const token = (likeTokens.get(v.id) ?? 0) + 1;
      likeTokens.set(v.id, token);
      const prev = feed.get();
      feed.update((f) => patchPost(f, v.id, (p) => ({ ...p, liked: v.like, likes: v.likes })));
      return { prev, token };
    },
    onError: (_e, v, ctx) => {
      if (ROLLBACK === "snapshot" && ctx) feed.set(ctx.prev);
      else if (ROLLBACK === "invert") feed.update((f) => patchPost(f, v.id, (p) => (p.liked === v.like ? { ...p, liked: !v.like, likes: p.likes + (v.like ? -1 : 1) } : p)));
      ui.update((u) => ({ ...u, error: "Couldn't save your like." }));
    },
    onSuccess: (post, v, ctx) => {
      if (LIKE_ECHO === "if-latest" && ctx && likeTokens.get(v.id) !== ctx.token) return; // a newer toggle is on its way
      feed.update((f) => patchPost(f, v.id, (p) => ({ ...p, likes: Number(post.likes ?? p.likes), liked: Boolean(post.liked) })));
    },
  });
}

// ------------------------------------------------------------------------------------------- comments
function useReply() {
  return useMutation({
    mutationFn: (v: { postId: number; text: string }) => api.post<Comment>("/comments", { postId: v.postId, author: "you", text: v.text }).then((r) => r.data),
    onSuccess: (_c, v) => {
      if (!REPLY_GUARD) ui.update((u) => ({ ...u, draft: "" }));
      feed.update((f) => patchPost(f, v.postId, (p) => ({ ...p, comments: p.comments + 1 })));
      void qc.invalidateQueries({ queryKey: ["comments", v.postId] });
    },
    onError: () => ui.update((u) => ({ ...u, error: "Your reply wasn't sent." })),
  });
}

// ------------------------------------------------------------------------------------------------- UI
const App = defineComponent({
  setup() {
    const u = useAtom(ui);
    const feedQ = useQuery({ queryKey: ["feed"], queryFn: loadFirst, staleTime: Infinity });
    const head = useQuery({
      queryKey: ["feed-head"],
      queryFn: () => api.get<Page>("/posts", { params: { limit: 1, sort: "-createdAt" } }).then((r) => r.data.total),
      refetchInterval: 6000,
    });
    const openId = computed(() => u.value.openId);
    const commentsQ = useQuery({
      queryKey: computed(() => ["comments", openId.value]),
      queryFn: () => api.get<{ items: Comment[] }>("/comments", { params: { postId: openId.value, limit: 50 } }).then((r) => r.data.items),
      enabled: computed(() => openId.value > 0),
    });
    const like = useLike();
    const reply = useReply();
    const data = computed(() => feedQ.data.value ?? EMPTY);
    const newCount = computed(() => (feedQ.data.value ? Math.max(0, Number(head.data.value ?? 0) - data.value.total) : 0));

    const toggleLike = (p: Post) => like.mutate({ id: p.id, like: !p.liked, likes: p.likes + (p.liked ? -1 : 1) });
    const toggleOpen = (id: number) => ui.update((x) => ({ ...x, openId: x.openId === id ? 0 : id, draft: x.openId === id ? x.draft : "", error: "" }));
    const setDraft = (v: string) => ui.update((x) => ({ ...x, draft: v }));
    const sendReply = () => {
      const s = ui.get();
      const text = s.draft.trim();
      if (!text || !s.openId) return;
      if (REPLY_GUARD && reply.isPending.value) return;
      ui.update((x) => ({ ...x, draft: REPLY_GUARD ? "" : x.draft, error: "" }));
      reply.mutate({ postId: s.openId, text });
    };
    return {
      u,
      data,
      loading: feedQ.isLoading,
      feedError: feedQ.isError,
      newCount,
      comments: computed(() => commentsQ.data.value ?? []),
      commentsLoading: commentsQ.isLoading,
      replying: reply.isPending,
      loadingMore,
      toggleLike,
      toggleOpen,
      setDraft,
      sendReply,
      loadMore,
      showNew,
      LOCK_MORE: LOAD_GUARD === "inflight",
      REPLY_GUARD,
    };
  },
  template: `
    <div class="feed">
      <header>
        <h1>Commons</h1>
        <button v-if="newCount > 0" class="new-posts" @click="showNew">Show {{ newCount }} new {{ newCount === 1 ? "post" : "posts" }}</button>
      </header>
      <p v-if="loading">Loading feed…</p>
      <p v-if="feedError" role="alert">The feed could not be loaded.</p>
      <article v-for="(p, i) in data.posts" :key="p.id + ':' + i" class="post">
        <p class="author">@{{ p.author }}</p>
        <p class="text">{{ p.text }}</p>
        <p class="actions"><button class="like" :class="{ on: p.liked }" @click="toggleLike(p)">{{ p.liked ? "Liked" : "Like" }}</button> {{ p.likes }} {{ p.likes === 1 ? "like" : "likes" }} · <button class="comments" @click="toggleOpen(p.id)">{{ p.comments }} {{ p.comments === 1 ? "comment" : "comments" }}</button></p>
        <div v-if="u.openId === p.id" class="thread">
          <p v-if="commentsLoading">Loading comments…</p>
          <ul><li v-for="c in comments" :key="c.id">@{{ c.author }}: {{ c.text }}</li></ul>
          <form @submit.prevent="sendReply">
            <textarea name="reply" :value="u.draft" @input="setDraft($event.target.value)" aria-label="Reply" placeholder="Write a reply"></textarea>
            <button class="reply" type="submit" :disabled="REPLY_GUARD && replying">Reply</button>
          </form>
        </div>
      </article>
      <button v-if="data.hasMore" class="more" :disabled="LOCK_MORE && loadingMore" @click="loadMore">{{ loadingMore ? "Loading…" : "Load more" }}</button>
      <p v-else-if="data.posts.length" class="end">You're all caught up.</p>
      <p v-if="u.error" role="alert">{{ u.error }}</p>
    </div>`,
});

createApp(App).use(VueQueryPlugin, { queryClient: qc }).mount("#app");
