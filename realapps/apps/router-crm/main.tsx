// Contacts CRM (React 19 + React Router 7 data router: createBrowserRouter, loaders and actions with fetch,
// <Form>, useFetcher, useNavigation, automatic revalidation). Loaders also keep a small app-wide cache in a GenClass
// atom (header counts, recently viewed), the way apps that grew a global store before moving to loaders do.
// Latent bugs by flag: loaders that ignore request.signal, so an interrupted navigation (typing in the search box,
// clicking through contacts) still finishes and writes its stale result into the cache (abort=ignore), a Save
// button that stays enabled while the edit is submitting (submitGuard=none: the second PUT carries the old
// version and fails with a conflict), favorites sent as a relative toggle with the starred count moved by ±1
// (star=toggle: a double click stars and un-stars, the count drifts), double note posts (noteGuard=none).
import { createRoot } from "react-dom/client";
import { useEffect, useRef } from "react";
import {
  createBrowserRouter,
  Form,
  Link,
  NavLink,
  Outlet,
  redirect,
  RouterProvider,
  useActionData,
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigation,
  useRevalidator,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunction,
} from "react-router-dom";
import { useAtom } from "@genclass/runtime/react";
import { rt, flag } from "../_shared/genclass";

type Contact = { id: number; name: string; company: string; email: string; phone: string; stage: string; favorite: boolean; version: number };
type Note = { id: number; contactId: number; author: string; text: string };
interface Crm {
  q: string;
  contacts: Contact[];
  total: number;
  starred: number;
  current: number;
  recent: string[];
  error: string;
}

const ABORT = flag("abort", "signal") as "signal" | "ignore";
const SUBMIT_GUARD = flag("submitGuard", "navigation-state") as "navigation-state" | "none";
const STAR = flag("star", "patch") as "patch" | "toggle";
const NOTE_GUARD = flag("noteGuard", "fetcher-state") as "fetcher-state" | "none";

const crm = rt.atom<Crm>("crm", { q: "", contacts: [], total: 0, starred: 0, current: 0, recent: [], error: "" });
const starredOf = (cs: Contact[]) => cs.filter((c) => c.favorite).length;

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}
async function http<T>(url: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(url, { ...init, headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) } });
  if (!r.ok) throw new HttpError(r.status);
  return (await r.json()) as T;
}
const signalOf = (request: Request) => (ABORT === "signal" ? request.signal : undefined);
const aborted = (request: Request, e: unknown) => (ABORT === "signal" && request.signal.aborted) || (e as Error)?.name === "AbortError";

// --------------------------------------------------------------------------------------- loaders/actions
type RootData = { q: string; contacts: Contact[]; error: string };
async function rootLoader({ request }: LoaderFunctionArgs): Promise<RootData> {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  try {
    const r = await http<{ items: Contact[]; total: number }>(`/api/contacts?${new URLSearchParams({ q, limit: "50" })}`, { signal: signalOf(request) });
    crm.update((s) => ({ ...s, q, contacts: r.items, total: r.total, starred: starredOf(r.items), error: s.error.startsWith("Contacts") ? "" : s.error }));
    return { q, contacts: r.items, error: "" };
  } catch (e) {
    if (aborted(request, e)) throw e;
    crm.update((s) => ({ ...s, error: "Contacts could not be loaded" }));
    return { q, contacts: crm.get().contacts, error: "Contacts could not be loaded" };
  }
}

type ContactData = { contact: Contact | null; notes: Note[] | null; error: string };
async function contactLoader({ params, request }: LoaderFunctionArgs): Promise<ContactData> {
  const id = Number(params.id);
  try {
    // the notes are secondary: the contact still shows when they fail
    const notesP = http<{ items: Note[] }>(`/api/notes?contactId=${id}&limit=100`, { signal: signalOf(request) }).then((r) => r.items, (e: unknown) => (aborted(request, e) ? Promise.reject(e) : null));
    notesP.catch(() => undefined);
    const contact = await http<Contact>(`/api/contacts/${id}`, { signal: signalOf(request) });
    const notes = await notesP;
    crm.update((s) => ({ ...s, current: contact.id, recent: [contact.name, ...s.recent.filter((n) => n !== contact.name)].slice(0, 4) }));
    return { contact, notes, error: "" };
  } catch (e) {
    if (aborted(request, e)) throw e;
    if (e instanceof HttpError && e.status === 404) throw redirect("/");
    return { contact: null, notes: [], error: "This contact could not be loaded" };
  }
}

function patchCache(saved: Contact, starredDelta?: number) {
  crm.update((s) => {
    const contacts = s.contacts.map((c) => (c.id === saved.id ? saved : c));
    return { ...s, contacts, starred: starredDelta === undefined ? starredOf(contacts) : s.starred + starredDelta };
  });
}

async function editAction({ params, request }: ActionFunctionArgs) {
  const fd = await request.formData();
  const id = Number(params.id);
  const body = { name: String(fd.get("name") ?? ""), company: String(fd.get("company") ?? ""), email: String(fd.get("email") ?? ""), phone: String(fd.get("phone") ?? ""), version: Number(fd.get("version")) };
  try {
    const saved = await http<Contact>(`/api/contacts/${id}`, { method: "PUT", body: JSON.stringify({ ...body, stage: String(fd.get("stage") ?? "lead"), favorite: fd.get("favorite") === "true" }), signal: signalOf(request) });
    patchCache(saved);
    return redirect(`/contacts/${id}`);
  } catch (e) {
    if (aborted(request, e)) throw e;
    if (e instanceof HttpError && e.status === 409) return { error: "This contact was changed in the meantime. Reload it to see the latest version." };
    return { error: "The contact could not be saved" };
  }
}

async function contactAction({ params, request }: ActionFunctionArgs) {
  const fd = await request.formData();
  const id = Number(params.id);
  if (fd.get("intent") === "favorite") {
    const want = fd.get("favorite") === "true";
    try {
      const saved = STAR === "patch" ? await http<Contact>(`/api/contacts/${id}`, { method: "PATCH", body: JSON.stringify({ favorite: want }) }) : await http<Contact>(`/api/contacts/${id}/star`, { method: "POST" });
      patchCache(saved, STAR === "toggle" ? (want ? 1 : -1) : undefined);
      return { ok: true };
    } catch {
      return { error: "Could not update the favorite" };
    }
  }
  const text = String(fd.get("note") ?? "").trim();
  if (!text) return { error: "Write a note first" };
  try {
    await http<Note>("/api/notes", { method: "POST", body: JSON.stringify({ contactId: id, author: "you", text }) });
    return { ok: true };
  } catch {
    return { error: "The note was not saved" };
  }
}

// ----------------------------------------------------------------------------------------------- routes
function Root() {
  const { q, contacts, error } = useLoaderData() as RootData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const location = useLocation();
  const [cache] = useAtom(crm);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current && document.activeElement !== input.current) input.current.value = q;
  }, [q]);
  return (
    <div className="crm">
      <header>
        <h1>Contacts</h1>
        <p className="stats">
          {cache.total} contacts · {cache.starred} starred
        </p>
        {cache.recent.length > 0 && <p className="recent">Recently viewed: {cache.recent.join(", ")}</p>}
      </header>
      <aside>
        <Form id="search" role="search">
          <input ref={input} name="q" defaultValue={q} placeholder="Search contacts" aria-label="Search contacts" onChange={(e) => void submit(e.currentTarget.form, { replace: q !== "", action: (navigation.location ?? location).pathname })} />
        </Form>
        {navigation.state === "loading" && <span className="spinner">Loading…</span>}
        {error && <p role="alert">{error}</p>}
        <nav className="contacts">
          <ul>
            {contacts.map((c) => (
              <li key={c.id}>
                <NavLink to={`/contacts/${c.id}${location.search}`}>
                  {c.name} {c.favorite ? "★" : ""}
                </NavLink>
              </li>
            ))}
          </ul>
          {!contacts.length && <p className="empty">No contacts match.</p>}
        </nav>
      </aside>
      <section className="detail">
        <Outlet />
      </section>
    </div>
  );
}

function ContactView() {
  const { contact, notes, error } = useLoaderData() as ContactData;
  const fav = useFetcher<{ ok?: boolean; error?: string }>();
  const noteF = useFetcher<{ ok?: boolean; error?: string }>();
  const noteForm = useRef<HTMLFormElement>(null);
  const revalidator = useRevalidator();
  useEffect(() => {
    if (noteF.state === "idle" && noteF.data?.ok) noteForm.current?.reset();
  }, [noteF.state, noteF.data]);
  if (!contact)
    return (
      <div className="contact">
        <p role="alert">{error}</p>
        <button className="retry" disabled={revalidator.state !== "idle"} onClick={() => void revalidator.revalidate()}>
          Try again
        </button>
      </div>
    );
  const favorite = fav.formData ? fav.formData.get("favorite") === "true" : contact.favorite;
  return (
    <div className="contact">
      <h2>
        {contact.name}{" "}
        <fav.Form method="post" className="fav">
          <input type="hidden" name="intent" value="favorite" />
          <button className="favorite" name="favorite" value={favorite ? "false" : "true"} aria-label={favorite ? "Remove from favorites" : "Add to favorites"}>
            {favorite ? "★" : "☆"}
          </button>
        </fav.Form>
      </h2>
      <p>
        {contact.company} · {contact.stage}
      </p>
      <p>
        {contact.email} · {contact.phone}
      </p>
      <Link className="edit" to={`/contacts/${contact.id}/edit`}>
        Edit
      </Link>
      {fav.data?.error && <p role="alert">{fav.data.error}</p>}
      <h3>Notes</h3>
      {!notes && <p className="notes-error">Notes are unavailable right now</p>}
      <ul className="notes">
        {(notes ?? []).map((n) => (
          <li key={n.id}>
            {n.author}: {n.text}
          </li>
        ))}
      </ul>
      <noteF.Form method="post" ref={noteForm} className="add-note">
        <input type="hidden" name="intent" value="note" />
        <textarea name="note" placeholder="Add a note" />
        <button className="add-note" disabled={NOTE_GUARD === "fetcher-state" && noteF.state !== "idle"}>
          {noteF.state === "submitting" ? "Saving…" : "Add note"}
        </button>
      </noteF.Form>
      {noteF.data?.error && <p role="alert">{noteF.data.error}</p>}
    </div>
  );
}

function EditContact() {
  const { contact } = useLoaderData() as ContactData;
  const result = useActionData() as { error?: string } | undefined;
  const navigation = useNavigation();
  if (!contact) return <p role="alert">This contact could not be loaded</p>;
  const saving = navigation.state === "submitting";
  return (
    <Form method="post" className="edit" key={`${contact.id}:${contact.version}`}>
      <input type="hidden" name="version" value={contact.version} />
      <input type="hidden" name="stage" value={contact.stage} />
      <input type="hidden" name="favorite" value={String(contact.favorite)} />
      <label>
        Name <input name="name" defaultValue={contact.name} />
      </label>
      <label>
        Company <input name="company" defaultValue={contact.company} />
      </label>
      <label>
        Email <input name="email" defaultValue={contact.email} />
      </label>
      <label>
        Phone <input name="phone" defaultValue={contact.phone} />
      </label>
      {result?.error && <p role="alert">{result.error}</p>}
      <button className="save" type="submit" disabled={SUBMIT_GUARD === "navigation-state" && saving}>
        {saving ? "Saving…" : "Save"}
      </button>
      <Link className="cancel" to={`/contacts/${contact.id}`}>
        Cancel
      </Link>
    </Form>
  );
}

// typing in the search box changes the query string: only the list needs to reload for that
const sameContact: ShouldRevalidateFunction = ({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }) => {
  if (formMethod && formMethod.toUpperCase() !== "GET") return defaultShouldRevalidate;
  if (currentUrl.pathname === nextUrl.pathname && currentUrl.search !== nextUrl.search) return false;
  return defaultShouldRevalidate;
};

const router = createBrowserRouter([
  {
    path: "/",
    element: <Root />,
    loader: rootLoader,
    children: [
      { index: true, element: <p className="welcome">Pick a contact from the list.</p> },
      { path: "contacts/:id", element: <ContactView />, loader: contactLoader, action: contactAction, shouldRevalidate: sameContact },
      { path: "contacts/:id/edit", element: <EditContact />, loader: contactLoader, action: editAction, shouldRevalidate: sameContact },
    ],
  },
]);

createRoot(document.getElementById("app")!).render(<RouterProvider router={router} />);
