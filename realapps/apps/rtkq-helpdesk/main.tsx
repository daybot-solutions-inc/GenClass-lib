// Support helpdesk (React 19 + Redux Toolkit + RTK Query; the whole store goes through GenClass via
// genclassEnhancer). The ticket queue is a polled RTK Query list per view; assigning and closing tickets are
// optimistic cache patches (onQueryStarted + updateQueryData) on a versioned resource; comments are a tag-invalidated
// list. Latent bugs by flag: optimistic patches kept after a failure (undo=false), no tag invalidation after writes so
// a poll that started before the write lands with the old ticket and reverts the patch until the next poll
// (invalidate=none), claims that overwrite a teammate's assignment without If-Match (claim=force), double comment
// posts (postGuard=none).
import { createRoot } from "react-dom/client";
import { configureStore, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { createApi, fetchBaseQuery, type FetchBaseQueryError } from "@reduxjs/toolkit/query/react";
import { Provider, useDispatch, useSelector } from "react-redux";
import { genclassEnhancer } from "@genclass/runtime/redux";
import { rt, flag } from "../_shared/genclass";

type Status = "open" | "pending" | "closed";
type View = "open" | "pending" | "mine" | "closed";
type Ticket = { id: number; subject: string; requester: string; status: Status; priority: string; assignee: string; version: number };
type Comment = { id: number; ticketId: number; author: string; body: string };
type TicketPatch = { id: number; view: View; version: number; patch: Partial<Pick<Ticket, "status" | "assignee">> };

const UNDO = Boolean(flag("undo", true));
const INVALIDATE = flag("invalidate", "tags") as "tags" | "none";
const CLAIM = flag("claim", "if-match") as "if-match" | "force";
const POST_GUARD = flag("postGuard", "disable") as "disable" | "none";
const POLL_MS = Number(flag("pollMs", 5000));
const ME = "jo";
const VIEWS: { id: View; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "pending", label: "Pending" },
  { id: "mine", label: "Mine" },
  { id: "closed", label: "Closed" },
];

const inView = (t: Ticket, v: View) => (v === "mine" ? t.assignee === ME : t.status === v);
const viewQuery = (v: View) => (v === "mine" ? `assignee=${ME}` : `status=${v}`);

// --------------------------------------------------------------------------------------------- RTK Query
export const api = createApi({
  reducerPath: "api",
  baseQuery: fetchBaseQuery({ baseUrl: "/api", timeout: 10000, prepareHeaders: (h) => (h.set("X-Agent", ME), h) }),
  tagTypes: ["Ticket", "Comments"],
  endpoints: (b) => ({
    getTickets: b.query<Ticket[], View>({
      query: (v) => `tickets?${viewQuery(v)}&limit=50`,
      transformResponse: (r: { items: Ticket[] }) => r.items,
      providesTags: (r) => [...(r ?? []).map((t) => ({ type: "Ticket" as const, id: t.id })), { type: "Ticket" as const, id: "LIST" }],
    }),
    getTicket: b.query<Ticket, number>({
      query: (id) => `tickets/${id}`,
      providesTags: (_r, _e, id) => [{ type: "Ticket", id }],
    }),
    getComments: b.query<Comment[], number>({
      query: (id) => `comments?ticketId=${id}&limit=100`,
      transformResponse: (r: { items: Comment[] }) => r.items,
      providesTags: (_r, _e, id) => [{ type: "Comments", id }],
    }),
    patchTicket: b.mutation<Ticket, TicketPatch>({
      query: ({ id, patch, version }) => ({ url: `tickets/${id}`, method: "PATCH", body: patch, headers: CLAIM === "if-match" ? { "If-Match": String(version) } : {} }),
      async onQueryStarted({ id, view, patch }, { dispatch, queryFulfilled }) {
        const optimistic = dispatch(
          api.util.updateQueryData("getTickets", view, (draft) => {
            const t = draft.find((x) => x.id === id);
            if (t) Object.assign(t, patch);
          }),
        );
        try {
          const { data: saved } = await queryFulfilled;
          // the server's copy carries the new version: later writes must send it
          dispatch(
            api.util.updateQueryData("getTickets", view, (draft) => {
              const i = draft.findIndex((x) => x.id === id);
              if (i >= 0) draft[i] = saved;
            }),
          );
        } catch (e) {
          const err = (e as { error?: FetchBaseQueryError }).error;
          if (err?.status === 409) {
            const current = (err.data as { current?: Ticket })?.current;
            optimistic.undo();
            if (current)
              dispatch(
                api.util.updateQueryData("getTickets", view, (draft) => {
                  const i = draft.findIndex((x) => x.id === id);
                  if (i >= 0) draft[i] = current;
                }),
              );
            dispatch(noticeShown(current?.assignee && current.assignee !== ME ? `#${id} is already handled by ${current.assignee}` : `#${id} changed on the server, please check it again`));
            return;
          }
          if (UNDO) optimistic.undo();
          dispatch(failed(`Could not update ticket #${id}`));
        }
      },
      invalidatesTags: (_r, _e, { id }) => (INVALIDATE === "tags" ? [{ type: "Ticket", id }] : []),
    }),
    addComment: b.mutation<Comment, { ticketId: number; body: string }>({
      query: ({ ticketId, body }) => ({ url: "comments", method: "POST", body: { ticketId, author: ME, body } }),
      async onQueryStarted({ ticketId }, { dispatch, queryFulfilled }) {
        try {
          await queryFulfilled;
          dispatch(draftChanged(""));
        } catch {
          dispatch(failed(`Comment on #${ticketId} was not posted`));
        }
      },
      invalidatesTags: (_r, _e, { ticketId }) => [{ type: "Comments", id: ticketId }],
    }),
  }),
});
const { useGetTicketsQuery, useGetTicketQuery, useGetCommentsQuery, usePatchTicketMutation, useAddCommentMutation } = api;

// ---------------------------------------------------------------------------------------------- UI slice
interface DeskState {
  view: View;
  selectedId: number;
  draft: string;
  notice: string;
  error: string;
}
const desk = createSlice({
  name: "desk",
  initialState: { view: "open", selectedId: 0, draft: "", notice: "", error: "" } as DeskState,
  reducers: {
    viewChanged(s, a: PayloadAction<View>) {
      s.view = a.payload;
    },
    ticketOpened(s, a: PayloadAction<number>) {
      if (s.selectedId !== a.payload) s.draft = "";
      s.selectedId = a.payload;
    },
    draftChanged(s, a: PayloadAction<string>) {
      s.draft = a.payload;
    },
    noticeShown(s, a: PayloadAction<string>) {
      s.notice = a.payload;
    },
    failed(s, a: PayloadAction<string>) {
      s.error = a.payload;
    },
    dismissed(s) {
      s.error = "";
      s.notice = "";
    },
  },
});
const { viewChanged, ticketOpened, draftChanged, noticeShown, failed, dismissed } = desk.actions;

const store = configureStore({
  reducer: { [api.reducerPath]: api.reducer, desk: desk.reducer },
  middleware: (gDM) => gDM().concat(api.middleware),
  enhancers: (gDE) => gDE().concat(genclassEnhancer(rt, { name: "helpdesk" })),
});
type Root = ReturnType<typeof store.getState>;
type AppDispatch = typeof store.dispatch;
const useDesk = () => useSelector((s: Root) => s.desk);

function TicketRow({ t, view }: { t: Ticket; view: View }) {
  const dispatch = useDispatch<AppDispatch>();
  const [patch] = usePatchTicketMutation();
  return (
    <li className={`ticket ${t.status} prio-${t.priority}`}>
      <span className="subject">
        #{t.id} {t.subject}
      </span>{" "}
      <span className="meta">
        {t.requester} · {t.priority} · {t.status} · {t.assignee ? `@${t.assignee}` : "unassigned"}
      </span>{" "}
      <button className="open" onClick={() => dispatch(ticketOpened(t.id))}>
        Open
      </button>
      {t.assignee !== ME && t.status !== "closed" && (
        <button className="assign" onClick={() => void patch({ id: t.id, view, version: t.version, patch: { assignee: ME } })}>
          Assign to me
        </button>
      )}
      {t.status !== "closed" && (
        <button className="close-ticket" onClick={() => void patch({ id: t.id, view, version: t.version, patch: { status: "closed" } })}>
          Close
        </button>
      )}
    </li>
  );
}

function Detail({ id }: { id: number }) {
  const dispatch = useDispatch<AppDispatch>();
  const { draft, view } = useDesk();
  const ticket = useGetTicketQuery(id);
  const comments = useGetCommentsQuery(id);
  const [addComment, posting] = useAddCommentMutation();
  const [patch] = usePatchTicketMutation();
  const t = ticket.data;
  return (
    <aside className="detail">
      {ticket.isLoading && <p>Loading ticket…</p>}
      {ticket.isError && <p role="alert">Ticket #{id} could not be loaded</p>}
      {t && (
        <>
          <h2>
            #{t.id} {t.subject}
          </h2>
          <p>
            {t.requester} · {t.status} · {t.assignee ? `@${t.assignee}` : "unassigned"}
          </p>
          {t.status === "closed" && (
            <button className="reopen" onClick={() => void patch({ id: t.id, view, version: t.version, patch: { status: "open" } })}>
              Reopen
            </button>
          )}
        </>
      )}
      <ul className="comments">
        {(comments.data ?? []).map((c) => (
          <li key={c.id} className="comment">
            <b>{c.author}</b>: {c.body}
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const body = draft.trim();
          if (body) void addComment({ ticketId: id, body });
        }}
      >
        <textarea name="comment" value={draft} onChange={(e) => dispatch(draftChanged(e.target.value))} placeholder="Reply to the customer" />
        <button className="post-comment" type="submit" disabled={POST_GUARD === "disable" && posting.isLoading}>
          {posting.isLoading ? "Posting…" : "Post reply"}
        </button>
      </form>
    </aside>
  );
}

function Desk() {
  const dispatch = useDispatch<AppDispatch>();
  const { view, selectedId, notice, error } = useDesk();
  const list = useGetTicketsQuery(view, { pollingInterval: POLL_MS });
  const tickets = (list.data ?? []).filter((t) => inView(t, view));
  return (
    <main className="desk">
      <header>
        <h1>Helpdesk</h1>
        <nav className="views">
          {VIEWS.map((v) => (
            <button key={v.id} aria-pressed={v.id === view} onClick={() => dispatch(viewChanged(v.id))}>
              {v.label}
            </button>
          ))}
        </nav>
        <button className="refetch" onClick={() => void list.refetch()}>
          Refresh
        </button>
      </header>
      {notice && <p className="notice">{notice}</p>}
      {error && (
        <p role="alert">
          {error} <button onClick={() => dispatch(dismissed())}>Dismiss</button>
        </p>
      )}
      {list.isError && !list.data && <p role="alert">The queue could not be loaded</p>}
      <p className="count">
        {tickets.length} {view} tickets
      </p>
      <ul className="tickets">
        {tickets.map((t) => (
          <TicketRow key={t.id} t={t} view={view} />
        ))}
      </ul>
      {selectedId > 0 && <Detail id={selectedId} />}
    </main>
  );
}

createRoot(document.getElementById("app")!).render(
  <Provider store={store}>
    <Desk />
  </Provider>,
);
