// The eight compat scenarios: how the runner drives each one with real (trusted) input, and the oracle that says
// whether the user would see a bug. Oracles read only the DOM and the mock server's truth, never GenClass.
//
// DOM contract every app implements inside <div id="compat" data-ready="1">, text exactly as below:
//   a  input[data-testid=q], li[data-testid=result] (city name)
//   b  form > input[data-testid=title] + button[data-testid=create] (type=submit), li[data-testid=item] (title)
//   c  button[data-testid=load], li[data-testid=left-row], li[data-testid=right-row]
//   d  li[data-testid=todo] "Title: done|open", input[type=checkbox][data-testid=toggle-<id>]
//   e  input[data-testid=note-text], button[data-testid=note-add], li[data-testid=note] "text" or "text (pending)"
//   f  button[data-testid=plus], [data-testid=count], [data-testid=synced]
//   g  button[data-testid=start], [data-testid=tick], [data-testid=polls], li[data-testid=detail] "Item <id>: <price>"
//      (Start mounts the panel: six detail requests at once, then a status poll every 250 ms until tick >= 8;
//      polls = number of status answers received)
//   h  li[data-testid=item], input[data-testid=q], li[data-testid=result], input[data-testid=title], button[data-testid=create]
//   any: [data-testid=error] when the app shows an error (compared as present/absent)

import { A_PREFIX, detail, searchCities, typeaheadWord } from "./backend.mjs";

const eq = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
const LEFT_ROWS = ["Ada Lovelace", "Grace Hopper", "Linus Torvalds"];
const RIGHT_ROWS = ["Build passed", "Deploy queued", "Review requested", "Issue closed"];
const D_EXPECTED = ["Write tests: done", "Ship release: open", "Fix flaky CI: done"];

async function typeInto(page, testid, text, delay) {
  await page.click(`[data-testid="${testid}"]`);
  await page.keyboard.type(text, { delay });
}

export const SCENARIOS = {
  a: {
    name: "typeahead, out-of-order responses",
    kind: "bug",
    what: "type a 5-letter prefix at 70 ms/key; shorter prefixes answer later than the full one",
    async drive(page, { seed }) {
      await typeInto(page, "q", typeaheadWord(seed).slice(0, A_PREFIX), 70);
    },
    oracle(dom, _server, { seed }) {
      const want = searchCities(typeaheadWord(seed).slice(0, A_PREFIX));
      return eq(dom.result, want) ? null : `stale results: shows [${(dom.result ?? []).slice(0, 3).join(", ")}${(dom.result ?? []).length > 3 ? ", ..." : ""}] (${(dom.result ?? []).length}) for "${typeaheadWord(seed).slice(0, A_PREFIX)}", want ${want.length}`;
    },
  },
  b: {
    name: "double submit of a create",
    kind: "bug",
    what: "double-click the submit button of a create form (POST takes 350-650 ms)",
    async drive(page, { seed }) {
      await typeInto(page, "title", `Report ${seed}`, 15);
      await page.dblclick('[data-testid="create"]');
    },
    oracle(dom, server, { seed }) {
      const t = `Report ${seed}`;
      const onServer = server.items.filter((x) => x === t).length;
      const shown = (dom.item ?? []).filter((x) => x === t).length;
      if (onServer !== 1) return `server has ${onServer} "${t}"`;
      if (shown !== onServer) return `shows ${shown} "${t}", server ${onServer}`;
      return null;
    },
  },
  c: {
    name: "two concurrent requests, different parts of the UI",
    kind: "legit",
    what: "one click loads two panels concurrently (80-600 ms each, random order)",
    async drive(page) {
      await page.click('[data-testid="load"]');
    },
    oracle(dom) {
      if (!eq(dom["left-row"], LEFT_ROWS)) return `left panel shows [${(dom["left-row"] ?? []).join(", ")}]`;
      if (!eq(dom["right-row"], RIGHT_ROWS)) return `right panel shows [${(dom["right-row"] ?? []).join(", ")}]`;
      return null;
    },
  },
  d: {
    name: "optimistic update, confirmation, rollback on failure",
    kind: "legit",
    what: "toggle todo 1 (server confirms) and 120 ms later todo 2 (server answers 500: must roll back)",
    async drive(page) {
      await page.click('[data-testid="toggle-1"]');
      await page.waitForTimeout(120);
      await page.click('[data-testid="toggle-2"]');
    },
    oracle(dom, server) {
      if (!eq(server.todos, D_EXPECTED)) return `server todos [${server.todos.join("; ")}]`;
      if (!eq(dom.todo, server.todos)) return `shows [${(dom.todo ?? []).join("; ")}], server [${server.todos.join("; ")}]`;
      return null;
    },
  },
  e: {
    name: "offline, then reconnect and sync",
    kind: "legit",
    what: "go offline, add two notes (queued), go online: the app syncs its outbox",
    async drive(page, { context }) {
      await context.setOffline(true);
      await page.waitForTimeout(200);
      await typeInto(page, "note-text", "offline-1", 10);
      await page.click('[data-testid="note-add"]');
      await page.waitForTimeout(150);
      await typeInto(page, "note-text", "offline-2", 10);
      await page.click('[data-testid="note-add"]');
      await page.waitForTimeout(500);
      await context.setOffline(false);
    },
    oracle(dom, server) {
      const want = ["first note", "offline-1", "offline-2"];
      if (!eq(server.notes, want)) return `server notes [${server.notes.join(", ")}]`;
      if (!eq(dom.note, want)) return `shows [${(dom.note ?? []).join(", ")}]`;
      return null;
    },
  },
  f: {
    name: "repeated deliberate actions (+1 five times)",
    kind: "legit",
    what: "click +1 five times, 180 ms apart; each POST takes 150-500 ms (identical requests overlap)",
    async drive(page) {
      for (let i = 0; i < 5; i++) {
        await page.click('[data-testid="plus"]');
        if (i < 4) await page.waitForTimeout(180);
      }
    },
    oracle(dom, server) {
      if (server.counter !== 5) return `server counter ${server.counter}`;
      if (!eq(dom.count, ["5"])) return `count shows ${dom.count?.[0]}`;
      if (!eq(dom.synced, ["5"])) return `synced shows ${dom.synced?.[0]}`;
      return null;
    },
  },
  g: {
    name: "polling and fan-out",
    kind: "legit",
    what: "click Start: six detail GETs at once (50-400 ms) and a status poll every 250 ms until tick 8",
    async drive(page) {
      await page.click('[data-testid="start"]');
    },
    oracle(dom, server) {
      if (!eq(dom.tick, [String(server.statusTicks)]) || server.statusTicks !== 8) return `tick shows ${dom.tick?.[0]}, server ${server.statusTicks}`;
      const want = [1, 2, 3, 4, 5, 6].map((i) => `${detail(i).name}: ${detail(i).price}`);
      if (!eq(dom.detail, want)) return `details [${(dom.detail ?? []).join("; ")}]`;
      return null;
    },
  },
  h: {
    name: "clean traffic",
    kind: "legit",
    what: "list loads, type a 3-letter search at 250 ms/key, create one item with one click (20-80 ms)",
    async drive(page, { seed }) {
      await typeInto(page, "q", typeaheadWord(seed).slice(0, 3), 250);
      await page.waitForTimeout(500);
      await typeInto(page, "title", `Clean ${seed}`, 20);
      await page.click('[data-testid="create"]');
    },
    oracle(dom, server, { seed }) {
      const t = `Clean ${seed}`;
      if (server.items.filter((x) => x === t).length !== 1) return `server has ${server.items.filter((x) => x === t).length} "${t}"`;
      if (!eq(dom.item, server.items)) return `items [${(dom.item ?? []).join(", ")}], server [${server.items.join(", ")}]`;
      const want = searchCities(typeaheadWord(seed).slice(0, 3));
      if (!eq(dom.result, want)) return `results [${(dom.result ?? []).join(", ")}]`;
      return null;
    },
  },
};

/** Page-side: the scenario's visible state, { testid: [text, ...] } (inputs and buttons excluded). */
export function domSnapshotFn() {
  const root = document.getElementById("compat");
  const out = {};
  if (!root) return { __missing: ["#compat"] };
  for (const el of root.querySelectorAll("[data-testid]")) {
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON" || tag === "FORM" || tag === "SELECT") continue;
    const id = el.getAttribute("data-testid");
    let t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (id === "error") t = t ? "error" : "";
    if (id === "error" && !t) continue;
    (out[id] ??= []).push(t);
  }
  return out;
}
