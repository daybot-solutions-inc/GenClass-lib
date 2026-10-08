// RealWorld "Conduit" API (https://realworld-docs.netlify.app/specifications/backend/endpoints/) as a mock-server
// extension, so unmodified open-source Conduit front-ends run against it. Auth scheme "Token <jwt>"; the demo
// user's token is "demo-token" (the harness may preload it into localStorage, like a returning user).

import type { Endpoint } from "../../shared/routes.js";
import type { MockServer, SReq, SRes, Item } from "../server.js";

interface Article {
  slug: string;
  title: string;
  description: string;
  body: string;
  tagList: string[];
  createdAt: string;
  updatedAt: string;
  author: string;
  favoritedBy: string[];
  t: number;
}
interface Comment {
  id: number;
  body: string;
  author: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}
interface User {
  username: string;
  email: string;
  password: string;
  bio: string;
  image: string;
  token: string;
}

const WORDS = ["signals", "render", "cache", "hooks", "compiler", "streams", "routing", "forms", "testing", "layout", "state", "effects", "workers", "styles", "bundles", "queries", "deploy", "types", "edge", "async"];
const TAGS = ["react", "vue", "svelte", "javascript", "css", "testing", "performance", "webdev", "node", "design"];
const PEOPLE = ["ada", "grace", "linus", "margaret", "dennis", "barbara", "ken", "frances"];

export class ConduitState {
  users = new Map<string, User>();
  articles = new Map<string, Article>();
  comments = new Map<number, Comment>();
  follows = new Set<string>(); // "follower>followee"
  commentN = 1;
  constructor(private srv: MockServer) {
    const iso = (t: number) => new Date(srv.epoch - 86400000 + t * 60000).toISOString();
    for (const p of [...PEOPLE, "demo"]) this.users.set(p, { username: p, email: `${p}@example.com`, password: "secret", bio: `${p} writes about the web`, image: "", token: p === "demo" ? "demo-token" : `token-${p}` });
    for (let i = 0; i < 28; i++) {
      const w1 = WORDS[i % WORDS.length]!;
      const w2 = WORDS[(i * 7 + 3) % WORDS.length]!;
      const title = `How ${w1} meets ${w2} ${i + 1}`;
      const slug = `how-${w1}-meets-${w2}-${i + 1}`;
      const author = PEOPLE[(i * 3) % PEOPLE.length]!;
      const tags = [TAGS[i % TAGS.length]!, TAGS[(i * 3 + 1) % TAGS.length]!].filter((x, j, a) => a.indexOf(x) === j);
      const fav = PEOPLE.filter((_, j) => (i + j) % 4 === 0);
      this.articles.set(slug, { slug, title, description: `Notes on ${w1} and ${w2}`, body: `A short essay on ${w1}, ${w2} and the ${WORDS[(i + 5) % WORDS.length]} that connects them.`, tagList: tags, createdAt: iso(i * 37), updatedAt: iso(i * 37), author, favoritedBy: fav, t: i });
    }
    let n = 0;
    for (const a of [...this.articles.values()].slice(0, 12)) {
      for (let j = 0; j < 2; j++) {
        const id = this.commentN++;
        this.comments.set(id, { id, body: `Great point about ${a.tagList[0]} (${++n})`, author: PEOPLE[(n * 5) % PEOPLE.length]!, slug: a.slug, createdAt: a.createdAt, updatedAt: a.createdAt });
      }
    }
    this.follows.add("demo>ada");
    this.follows.add("demo>linus");
  }
  viewer(h: Record<string, string>): User | null {
    const m = /^(?:Token|Bearer)\s+(.+)$/i.exec(h["authorization"] ?? "");
    if (!m) return null;
    for (const u of this.users.values()) if (u.token === m[1]) return u;
    return null;
  }
  profile(username: string, viewer: User | null): Item {
    const u = this.users.get(username);
    return { username, bio: u?.bio ?? null, image: u?.image || "https://api.realworld.io/images/smiley-cyrus.jpeg", following: viewer ? this.follows.has(`${viewer.username}>${username}`) : false };
  }
  articleView(a: Article, viewer: User | null): Item {
    return {
      slug: a.slug,
      title: a.title,
      description: a.description,
      body: a.body,
      tagList: a.tagList,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      favorited: viewer ? a.favoritedBy.includes(viewer.username) : false,
      favoritesCount: a.favoritedBy.length,
      author: this.profile(a.author, viewer),
    };
  }
  userView(u: User): Item {
    // `id` is not in the spec but several front-ends (Ember Data) need a stable one
    return { id: [...this.users.keys()].indexOf(u.username) + 1, email: u.email, token: u.token, username: u.username, bio: u.bio, image: u.image || null };
  }
  snapshot(): Record<string, Record<string, unknown>> {
    const articles: Record<string, unknown> = {};
    for (const a of this.articles.values()) articles[a.slug] = { title: a.title, description: a.description, body: a.body, tagList: a.tagList, author: a.author, favoritedBy: [...a.favoritedBy].sort() };
    const comments: Record<string, unknown> = {};
    const occ = new Map<string, number>();
    for (const c of this.comments.values()) {
      const k = `${c.slug}|${c.author}|${c.body}`;
      const n = (occ.get(k) ?? 0) + 1;
      occ.set(k, n);
      comments[`${k}|${n}`] = { body: c.body, author: c.author, slug: c.slug };
    }
    const follows: Record<string, unknown> = {};
    for (const f of this.follows) follows[f] = true;
    const users: Record<string, unknown> = {};
    for (const u of this.users.values()) users[u.username] = { email: u.email, bio: u.bio, image: u.image };
    return { articles, comments, follows, users };
  }
  external(kind: string, index: number | undefined, data: Item | undefined): void {
    const list = [...this.articles.values()];
    if (!list.length) return;
    const a = list[(index ?? 0) % list.length]!;
    const who = String(data?.who ?? PEOPLE[(index ?? 0) % PEOPLE.length]);
    const iso = new Date(this.srv.epoch + this.srv.now()).toISOString();
    if (kind === "action") {
      if (a.favoritedBy.includes(who)) a.favoritedBy = a.favoritedBy.filter((x) => x !== who);
      else a.favoritedBy = [...a.favoritedBy, who];
    } else if (kind === "create") {
      const id = this.commentN++;
      this.comments.set(id, { id, body: String(data?.body ?? "Nice"), author: who, slug: a.slug, createdAt: iso, updatedAt: iso });
    } else if (kind === "update") {
      a.body = `${a.body} (edited)`;
      a.updatedAt = iso;
    }
    this.srv.writes++;
  }
}

function page<T>(xs: T[], q: URLSearchParams): T[] {
  const limit = Number(q.get("limit") ?? 20) || 20;
  const offset = Number(q.get("offset") ?? 0) || 0;
  return xs.slice(offset, offset + limit);
}

export function conduitHandler(srv: MockServer, ep: Endpoint, params: Record<string, string>, req: SReq, t: number, _asOf: number): SRes {
  let st = srv.ext.conduit as ConduitState | undefined;
  if (!st) {
    st = new ConduitState(srv);
    srv.ext.conduit = st;
  }
  const B = srv.B;
  const p = ep.pattern.slice(B.length);
  const viewer = st.viewer(req.headers);
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, Item>;
  const iso = new Date(srv.epoch + t).toISOString();
  const unauthorized: SRes = { status: 401, body: { errors: { body: ["Unauthorized"] } }, wrote: false };
  const notFound: SRes = { status: 404, body: { errors: { body: ["Not found"] } }, wrote: false };
  const m = req.method;
  if (p === "/users/login") {
    const email = String(body.user?.email ?? "");
    const u = [...st.users.values()].find((x) => x.email === email);
    if (!u || String(body.user?.password ?? "") === "") return { status: 422, body: { errors: { "email or password": ["is invalid"] } }, wrote: false };
    return { status: 200, body: { user: st.userView(u) }, wrote: false };
  }
  if (p === "/users") {
    const username = String(body.user?.username ?? "");
    if (!username || st.users.has(username)) return { status: 422, body: { errors: { username: ["has already been taken"] } }, wrote: false };
    const u: User = { username, email: String(body.user?.email ?? ""), password: String(body.user?.password ?? ""), bio: "", image: "", token: `token-${username}` };
    st.users.set(username, u);
    return { status: 201, body: { user: st.userView(u) }, wrote: true };
  }
  if (p === "/user") {
    if (!viewer) return unauthorized;
    if (m === "GET") return { status: 200, body: { user: st.userView(viewer) }, wrote: false };
    Object.assign(viewer, { ...(body.user ?? {}) });
    return { status: 200, body: { user: st.userView(viewer) }, wrote: true };
  }
  if (p === "/tags") return { status: 200, body: { tags: [...new Set([...st.articles.values()].flatMap((a) => a.tagList))].slice(0, 20) }, wrote: false };
  if (p === "/profiles/:username") {
    if (!st.users.has(params.username!)) return notFound;
    return { status: 200, body: { profile: st.profile(params.username!, viewer) }, wrote: false };
  }
  if (p === "/profiles/:username/follow") {
    if (!viewer) return unauthorized;
    const key = `${viewer.username}>${params.username}`;
    if (m === "POST") st.follows.add(key);
    else st.follows.delete(key);
    return { status: 200, body: { profile: st.profile(params.username!, viewer) }, wrote: true };
  }
  const sorted = () => [...st!.articles.values()].sort((a, b) => b.t - a.t);
  if (p === "/articles" && m === "GET") {
    let xs = sorted();
    const tag = req.query.get("tag");
    const author = req.query.get("author");
    const fav = req.query.get("favorited");
    if (tag) xs = xs.filter((a) => a.tagList.includes(tag));
    if (author) xs = xs.filter((a) => a.author === author);
    if (fav) xs = xs.filter((a) => a.favoritedBy.includes(fav));
    return { status: 200, body: { articles: page(xs, req.query).map((a) => st!.articleView(a, viewer)), articlesCount: xs.length }, wrote: false, list: true };
  }
  if (p === "/articles/feed") {
    if (!viewer) return unauthorized;
    const xs = sorted().filter((a) => st!.follows.has(`${viewer.username}>${a.author}`));
    return { status: 200, body: { articles: page(xs, req.query).map((a) => st!.articleView(a, viewer)), articlesCount: xs.length }, wrote: false, list: true };
  }
  if (p === "/articles" && m === "POST") {
    if (!viewer) return unauthorized;
    const a0 = body.article ?? {};
    const title = String(a0.title ?? "untitled");
    let slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";
    let n = 1;
    while (st.articles.has(slug)) slug = `${slug.replace(/-\d+$/, "")}-${++n}`;
    const maxT = Math.max(0, ...[...st.articles.values()].map((x) => x.t));
    const a: Article = { slug, title, description: String(a0.description ?? ""), body: String(a0.body ?? ""), tagList: Array.isArray(a0.tagList) ? (a0.tagList as string[]) : [], createdAt: iso, updatedAt: iso, author: viewer.username, favoritedBy: [], t: maxT + 1 };
    st.articles.set(slug, a);
    return { status: 201, body: { article: st.articleView(a, viewer) }, wrote: true };
  }
  const a = params.slug ? st.articles.get(params.slug) : undefined;
  if (p === "/articles/:slug") {
    if (!a) return notFound;
    if (m === "GET") return { status: 200, body: { article: st.articleView(a, viewer) }, wrote: false };
    if (!viewer) return unauthorized;
    if (a.author !== viewer.username) return { status: 403, body: { errors: { article: ["forbidden"] } }, wrote: false };
    if (m === "DELETE") {
      st.articles.delete(a.slug);
      return { status: 204, body: null, wrote: true };
    }
    const a0 = body.article ?? {};
    for (const k of ["title", "description", "body"] as const) if (a0[k] !== undefined) a[k] = String(a0[k]);
    if (Array.isArray(a0.tagList)) a.tagList = a0.tagList as string[];
    a.updatedAt = iso;
    return { status: 200, body: { article: st.articleView(a, viewer) }, wrote: true };
  }
  if (p === "/articles/:slug/favorite") {
    if (!viewer) return unauthorized;
    if (!a) return notFound;
    if (m === "POST") {
      if (!a.favoritedBy.includes(viewer.username)) a.favoritedBy = [...a.favoritedBy, viewer.username];
    } else a.favoritedBy = a.favoritedBy.filter((x) => x !== viewer.username);
    return { status: 200, body: { article: st.articleView(a, viewer) }, wrote: true };
  }
  if (p === "/articles/:slug/comments") {
    if (!a) return notFound;
    if (m === "GET") {
      const cs = [...st.comments.values()].filter((c) => c.slug === a.slug).sort((x, y) => y.id - x.id);
      return { status: 200, body: { comments: cs.map((c) => ({ id: c.id, createdAt: c.createdAt, updatedAt: c.updatedAt, body: c.body, author: st!.profile(c.author, viewer) })) }, wrote: false, list: true };
    }
    if (!viewer) return unauthorized;
    const id = st.commentN++;
    const c: Comment = { id, body: String(body.comment?.body ?? ""), author: viewer.username, slug: a.slug, createdAt: iso, updatedAt: iso };
    st.comments.set(id, c);
    return { status: 200, body: { comment: { id, createdAt: iso, updatedAt: iso, body: c.body, author: st.profile(viewer.username, viewer) } }, wrote: true };
  }
  if (p === "/articles/:slug/comments/:id") {
    if (!viewer) return unauthorized;
    const c = st.comments.get(Number(params.id));
    if (!c) return notFound;
    st.comments.delete(c.id);
    return { status: 204, body: null, wrote: true };
  }
  return notFound;
}
