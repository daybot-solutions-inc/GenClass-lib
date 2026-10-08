// Lab reference manager (Vue 3 templates + @tanstack/vue-query useInfiniteQuery over a cursor API + axios). The
// library is paged by cursor (`?cursor=<last id>` → nextCursor, "Load more") and filtered by collection
// (`collection__in=thesis,hci`). Papers are added by DOI (POST; the DOI is unique → 409, DOI and title required →
// 422), tagged (versioned PATCH of the tag list) and starred (POST /papers/:id/star, a relative toggle). The infinite
// ["library"] cache is registered with rt.guard (the app's inserts, optimistic stars/tags and rollbacks go through
// GenClass; query fetches are traced). Latent bugs by flag: star buttons live while the toggle is on its way
// (star=none: an impatient double click flips it back), a filter change that refetches without cancelling a
// "Load more" in flight (pages=keep: the old filter's next page is appended and the new filter never applies),
// tag edits sent without the version (tags=force: someone else's tags are overwritten), "Add paper" live while
// adding (addGuard=none: the second POST answers 409) and a refetch of every page after adding instead of
// inserting the answer (afterAdd=refetch-all: a lagging replica drops the new paper, the refetch lands over stars).
import { createApp, defineComponent, computed, ref } from "vue";
import { QueryClient, VueQueryPlugin, useInfiniteQuery, useMutation, type InfiniteData } from "@tanstack/vue-query";
import axios from "axios";
import { rt, flag } from "../_shared/genclass";
import { useAtom } from "../_shared/vue-atom";

type Paper = { id: number; title: string; authors: string; year: number; venue: string; doi: string; collection: string; tags: string[]; starred: boolean; version: number; createdAt?: string };
type Page = { items: Paper[]; nextCursor: string | null };
type Library = InfiniteData<Page, string>;

const STAR_LOCK = flag("star", "pending-lock") === "pending-lock";
const PAGES = flag("pages", "reset-on-filter") as "reset-on-filter" | "keep";
const IF_MATCH = flag("tags", "if-match") === "if-match";
const ADD_GUARD = flag("addGuard", "pending") === "pending";
const AFTER_ADD = flag("afterAdd", "set-query-data") as "set-query-data" | "refetch-all";

const COLLECTIONS: [string, string][] = [["reading", "Reading list"], ["thesis", "Thesis"], ["mlsys", "ML systems"], ["hci", "HCI"]];
const labelOf = (c: string) => COLLECTIONS.find(([k]) => k === c)?.[1] ?? c;
const http = axios.create({ baseURL: "/api", timeout: 10000 });
const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30000 } } });
const KEY = ["library"];

const library = rt.guard<Library>("library", {
  get: () => qc.getQueryData<Library>(KEY) ?? { pages: [], pageParams: [] },
  set: (v) => void qc.setQueryData<Library>(KEY, v),
  subscribe: (fn) =>
    qc.getQueryCache().subscribe((e) => {
      if (e.type === "updated" && e.query.queryKey[0] === "library" && e.action.type === "success") fn();
    }),
});
const ui = rt.atom("ui", { collections: [] as string[], editing: 0, tag: "", doi: "", title: "", collection: "reading", error: "", notice: "" });
type Ui = ReturnType<typeof ui.get>;

const statusOf = (e: unknown) => (axios.isAxiosError(e) ? (e.response?.status ?? 0) : 0);
function fail(e: unknown, what: string) {
  const s = statusOf(e);
  const msg = s === 0 ? `Network problem — ${what} didn't go through.` : s === 409 ? `Someone else changed this — ${what} wasn't saved.` : `${what[0]!.toUpperCase()}${what.slice(1)} failed (${s}).`;
  ui.update((u) => ({ ...u, notice: "", error: msg }));
}
const allPapers = () => library.get().pages.flatMap((p) => p.items);
const patchPaper = (id: number, fn: (p: Paper) => Paper) => library.update((d) => ({ ...d, pages: d.pages.map((pg) => ({ ...pg, items: pg.items.map((p) => (p.id === id ? fn(p) : p)) })) }));
const sameTags = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

async function fetchPage(cols: string[], cursor: string): Promise<Page> {
  const params: Record<string, string | number> = { limit: 6, sort: "-createdAt", cursor };
  if (cols.length) params.collection__in = cols.join(",");
  const { data } = await http.get<{ items: Paper[]; nextCursor?: string | null }>("/papers", { params });
  return { items: data.items ?? [], nextCursor: data.nextCursor ?? null };
}

// --------------------------------------------------------------------------------------------- stars
const starring = ref<number[]>([]);
async function toggleStar(p: Paper) {
  if (STAR_LOCK && starring.value.includes(p.id)) return;
  const want = !(allPapers().find((x) => x.id === p.id)?.starred ?? p.starred);
  starring.value = [...starring.value, p.id];
  patchPaper(p.id, (x) => ({ ...x, starred: want }));
  ui.update((u) => ({ ...u, error: "" }));
  try {
    const { data } = await http.post<Paper>(`/papers/${p.id}/star`);
    patchPaper(p.id, (x) => ({ ...x, starred: Boolean(data.starred), version: data.version }));
  } catch (e) {
    patchPaper(p.id, (x) => (x.starred === want ? { ...x, starred: !want } : x));
    fail(e, `starring “${p.title}”`);
  } finally {
    const i = starring.value.indexOf(p.id);
    if (i >= 0) starring.value = [...starring.value.slice(0, i), ...starring.value.slice(i + 1)];
  }
}

// ---------------------------------------------------------------------------------------------- tags
async function saveTags(id: number, change: (tags: string[]) => string[], what: string) {
  const cur = allPapers().find((x) => x.id === id);
  if (!cur) return;
  const base = cur.tags ?? [];
  const next = change(base);
  if (sameTags(base, next)) return;
  patchPaper(id, (x) => ({ ...x, tags: next }));
  ui.update((u) => ({ ...u, error: "" }));
  try {
    let saved: Paper;
    try {
      saved = (await http.patch<Paper>(`/papers/${id}`, IF_MATCH ? { tags: next, version: cur.version } : { tags: next }, { headers: IF_MATCH ? { "If-Match": String(cur.version) } : {} })).data;
    } catch (e) {
      const current = statusOf(e) === 409 ? ((e as { response: { data: { current?: Paper } } }).response.data.current ?? null) : null;
      if (!IF_MATCH || !current) throw e;
      // the paper changed meanwhile (a star, someone else's tags): make our change on top of their version
      saved = (await http.patch<Paper>(`/papers/${id}`, { tags: change(current.tags ?? []), version: current.version }, { headers: { "If-Match": String(current.version) } })).data;
    }
    patchPaper(id, (x) => ({ ...x, tags: saved.tags ?? [], version: saved.version }));
  } catch (e) {
    patchPaper(id, (x) => (sameTags(x.tags, next) ? { ...x, tags: base } : x));
    fail(e, what);
  }
}

const set = (k: keyof Ui, v: unknown) => ui.update((u) => ({ ...u, [k]: v }));

const App = defineComponent({
  setup() {
    const u = useAtom(ui);
    const q = useInfiniteQuery({
      queryKey: KEY,
      queryFn: ({ pageParam }: { pageParam: string }) => fetchPage(ui.get().collections, pageParam),
      initialPageParam: "",
      getNextPageParam: (last: Page) => last.nextCursor ?? undefined,
      refetchInterval: 12000, // lab mates add and tag papers too
    });
    const add = useMutation({
      mutationFn: (v: { doi: string; title: string; collection: string }) => http.post<Paper>("/papers", { ...v, authors: "Unknown authors", year: 2026, venue: "Preprint", tags: [], starred: false }).then((r) => r.data),
      onSuccess: (paper: Paper) => {
        ui.update((x) => ({ ...x, doi: "", title: "", error: "", notice: `Added “${paper.title}” to ${labelOf(paper.collection)}.` }));
        if (AFTER_ADD === "refetch-all") return void qc.invalidateQueries({ queryKey: KEY });
        const cols = ui.get().collections;
        if (cols.length && !cols.includes(paper.collection)) return;
        library.update((d) => {
          if (!d.pages.length || d.pages.some((pg) => pg.items.some((x) => x.id === paper.id))) return d;
          const [first, ...rest] = d.pages;
          return { ...d, pages: [{ ...first!, items: [paper, ...first!.items] }, ...rest] };
        });
      },
      onError: (e: unknown, v: { doi: string }) => {
        const s = statusOf(e);
        if (s === 409) ui.update((x) => ({ ...x, notice: "", error: `${v.doi} is already in the library.` }));
        else if (s === 422) ui.update((x) => ({ ...x, notice: "", error: "A DOI and a title are both needed." }));
        else fail(e, "adding the paper");
      },
    });

    const papers = computed(() => (q.data.value?.pages ?? []).flatMap((p) => p.items));
    const editing = computed(() => papers.value.find((p) => p.id === u.value.editing) ?? null);
    function toggleCollection(c: string, on: boolean) {
      ui.update((x) => ({ ...x, collections: on ? [...x.collections.filter((k) => k !== c), c] : x.collections.filter((k) => k !== c), error: "", notice: "" }));
      if (PAGES === "reset-on-filter") void qc.resetQueries({ queryKey: KEY }); // drop loaded pages and any "Load more" in flight
      else void q.refetch({ cancelRefetch: false }); // reuse whatever is already loading
    }
    function submitAdd() {
      const s = ui.get();
      if (ADD_GUARD && add.isPending.value) return;
      const doi = s.doi.trim();
      if (!doi) return set("error", "Enter a DOI first.");
      add.mutate({ doi, title: s.title.trim(), collection: s.collection });
    }
    function addTag() {
      const s = ui.get();
      const tag = s.tag.trim().toLowerCase();
      if (!tag || !s.editing) return;
      set("tag", "");
      void saveTags(s.editing, (tags) => (tags.includes(tag) ? tags : [...tags, tag]), `tagging the paper “${tag}”`);
    }
    const removeTag = (id: number, tag: string) => void saveTags(id, (tags) => tags.filter((t) => t !== tag), `removing the tag “${tag}”`);
    return {
      u,
      papers,
      editing,
      COLLECTIONS,
      labelOf,
      STAR_LOCK,
      ADD_GUARD,
      starring,
      adding: add.isPending,
      isPending: q.isPending,
      isError: q.isError,
      hasNextPage: q.hasNextPage,
      fetchingMore: q.isFetchingNextPage,
      starredCount: computed(() => papers.value.filter((p) => p.starred).length),
      loadMore: () => void q.fetchNextPage(),
      toggleStar,
      toggleCollection,
      submitAdd,
      addTag,
      removeTag,
      set,
      openTags: (p: Paper) => ui.update((x) => ({ ...x, editing: p.id, tag: "", error: "" })),
      closeTags: () => ui.update((x) => ({ ...x, editing: 0, tag: "" })),
    };
  },
  template: `
    <div class="library">
      <header>
        <h1>Lab library</h1>
        <p class="count">{{ papers.length }} papers shown · {{ starredCount }} starred</p>
      </header>
      <form class="add" @submit.prevent="submitAdd">
        <input name="doi" placeholder="DOI, e.g. 10.1145/…" aria-label="DOI" :value="u.doi" @input="set('doi', $event.target.value)" />
        <input name="title" placeholder="Title" aria-label="Title" :value="u.title" @input="set('title', $event.target.value)" />
        <select name="collection" aria-label="Collection" :value="u.collection" @change="set('collection', $event.target.value)">
          <option v-for="[k, l] in COLLECTIONS" :key="k" :value="k">{{ l }}</option>
        </select>
        <button class="add-paper" type="submit" :disabled="ADD_GUARD && adding">{{ adding ? "Adding…" : "Add paper" }}</button>
      </form>
      <fieldset class="collections">
        <legend>Collections</legend>
        <label v-for="[k, l] in COLLECTIONS" :key="k"><input type="checkbox" :value="k" :checked="u.collections.includes(k)" @change="toggleCollection(k, $event.target.checked)" /> {{ l }}</label>
      </fieldset>
      <p v-if="u.error" role="alert">{{ u.error }}</p>
      <p v-if="isError && !papers.length" role="alert">The library couldn't be loaded.</p>
      <p v-if="u.notice" class="notice">{{ u.notice }}</p>
      <section v-if="editing" class="tag-editor">
        <h2>Tags for “{{ editing.title }}”</h2>
        <form class="tags" @submit.prevent="addTag">
          <input name="tag" placeholder="Add a tag" aria-label="New tag" :value="u.tag" @input="set('tag', $event.target.value)" />
          <button class="add-tag" type="submit">Add tag</button>
          <button v-for="t in editing.tags" :key="t" type="button" class="remove-tag" @click="removeTag(editing.id, t)">Remove {{ t }}</button>
          <button type="button" class="done" @click="closeTags">Done</button>
        </form>
      </section>
      <p v-if="isPending">Loading papers…</p>
      <article v-for="p in papers" :key="p.id" class="paper">
        <h2>{{ p.title }}</h2>
        <p class="meta">{{ p.authors }} · {{ p.venue }} {{ p.year }} · {{ labelOf(p.collection) }}</p>
        <p class="tags">Tags: {{ p.tags.length ? p.tags.join(", ") : "none" }}</p>
        <button class="star" :class="{ on: p.starred }" :disabled="STAR_LOCK && starring.includes(p.id)" @click="toggleStar(p)">{{ p.starred ? "★ Starred" : "☆ Star" }}</button>
        <button class="edit-tags" @click="openTags(p)">Edit tags</button>
      </article>
      <button v-if="hasNextPage" class="more" :disabled="fetchingMore" @click="loadMore">{{ fetchingMore ? "Loading…" : "Load more" }}</button>
      <p v-else-if="papers.length" class="end">End of the library.</p>
    </div>`,
});

createApp(App).use(VueQueryPlugin, { queryClient: qc }).mount("#app");
