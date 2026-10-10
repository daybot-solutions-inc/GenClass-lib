// The plain-HTML compat app: no framework, no build step, no GenClass API (GenClass comes from the script tag in
// <head>). ?layer=fetch (fetch + DOM, all scenarios) or ?layer=push (WebSocket + EventSource: a, c, d, g, h).
// Written the common way: the typeahead renders whatever answer arrives (a: no ordering guard), the create form has
// no in-flight guard (b). The other scenarios are correct.
(function () {
  "use strict";
  var params = new URLSearchParams(location.search);
  var layer = params.get("layer") || "fetch";
  var s = params.get("s") || "h";
  var root = document.getElementById("compat");
  var DETAIL_IDS = [1, 2, 3, 4, 5, 6];

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }
  function list(ul, rows, testid) {
    ul.replaceChildren.apply(
      ul,
      rows.map(function (r) {
        return el("li", testid ? { "data-testid": testid } : {}, r);
      }),
    );
  }
  function http(url, init) {
    init = init || {};
    var headers = { accept: "application/json" };
    if (init.body) headers["content-type"] = "application/json";
    return fetch(url, Object.assign({}, init, { headers: headers })).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }
  var api = {
    search: function (q) { return http("/api/search?q=" + encodeURIComponent(q)); },
    items: function () { return http("/api/items"); },
    createItem: function (title) { return http("/api/items", { method: "POST", body: JSON.stringify({ title: title }) }); },
    left: function () { return http("/api/left"); },
    right: function () { return http("/api/right"); },
    todos: function () { return http("/api/todos"); },
    toggleTodo: function (id, done) { return http("/api/todos/" + id, { method: "PATCH", body: JSON.stringify({ done: done }) }); },
    notes: function () { return http("/api/notes"); },
    addNote: function (text) { return http("/api/notes", { method: "POST", body: JSON.stringify({ text: text }) }); },
    increment: function () { return http("/api/counter/increment", { method: "POST", body: "{}" }); },
    status: function () { return http("/api/status"); },
    detail: function (id) { return http("/api/detail/" + id); },
  };

  // ------------------------------------------------------------------------------------------ building blocks
  function typeahead(container, onQ) {
    container.append(el("h2", {}, "City search"));
    var input = el("input", { "data-testid": "q", placeholder: "Search cities", autocomplete: "off" });
    var ul = el("ul");
    container.append(input, ul);
    input.addEventListener("input", function () { onQ(input.value, ul); });
    return ul;
  }
  function createForm(container, onSubmit) {
    var form = el("form");
    var input = el("input", { "data-testid": "title", placeholder: "New item" });
    var button = el("button", { "data-testid": "create", type: "submit" }, "Create");
    form.append(input, button);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      onSubmit(input.value, function () { input.value = ""; });
    });
    container.append(form);
  }
  function errorLine(container, msg) {
    if (!container.querySelector('[data-testid="error"]')) container.append(el("p", { "data-testid": "error" }, msg));
  }
  function todosView(container, state, onToggle) {
    container.append(el("h2", {}, "Todos"));
    var ul = el("ul");
    container.append(ul);
    return function render() {
      ul.replaceChildren.apply(
        ul,
        state.todos.map(function (t) {
          var li = el("li", { "data-testid": "todo" });
          var label = el("label");
          var box = el("input", { type: "checkbox", "data-testid": "toggle-" + t.id });
          box.checked = t.done;
          box.addEventListener("change", function () { onToggle(t); });
          label.append(box, document.createTextNode(t.title + ": " + (t.done ? "done" : "open")));
          li.append(label);
          return li;
        }),
      );
    };
  }
  function optimisticToggle(state, render, container, t) {
    var done = !t.done;
    var patch = function (fn) {
      state.todos = state.todos.map(function (x) { return x.id === t.id ? fn(x) : x; });
      render();
    };
    patch(function (x) { return Object.assign({}, x, { done: done }); }); // optimistic
    api.toggleTodo(t.id, done).then(
      function (saved) { patch(function () { return saved; }); },
      function () {
        patch(function (x) { return Object.assign({}, x, { done: t.done }); }); // roll back
        errorLine(container, 'Could not save "' + t.title + '"');
      },
    );
  }
  function livePanel(container, start) {
    var button = el("button", { "data-testid": "start" }, "Start");
    container.append(button);
    button.addEventListener("click", function () {
      if (container.querySelector('[data-testid="tick"]')) return;
      var div = el("div");
      var p = el("p");
      var tick = el("span", { "data-testid": "tick" }, "0");
      var polls = el("span", { "data-testid": "polls" }, "0");
      p.append("Tick ", tick, " after ", polls, " polls");
      var ul = el("ul");
      var details = {};
      var renderDetails = function () {
        ul.replaceChildren.apply(
          ul,
          DETAIL_IDS.map(function (id) {
            var d = details[id];
            return d ? el("li", { "data-testid": "detail" }, d.name + ": " + d.price) : el("li", {}, "loading");
          }),
        );
      };
      renderDetails();
      div.append(p, ul);
      container.append(div);
      start({
        tick: function (n) { tick.textContent = String(n); polls.textContent = String(Number(polls.textContent) + 1); },
        detail: function (d) { details[d.id] = d; renderDetails(); },
      });
    });
  }

  // ------------------------------------------------------------------------------------------- layer: fetch
  var FETCH = {
    a: function (c) {
      typeahead(c, function (q, ul) {
        if (!q) return list(ul, []);
        api.search(q).then(function (r) { list(ul, r.results, "result"); }, function () {});
      });
    },
    b: function (c) {
      c.append(el("h2", {}, "Items"));
      var items = [];
      var ul = el("ul");
      createForm(c, function (title, clear) {
        api.createItem(title).then(
          function (item) { items.push(item); list(ul, items.map(function (i) { return i.title; }), "item"); clear(); },
          function () { errorLine(c, "Could not create"); },
        );
      });
      c.append(ul);
      api.items().then(function (r) { items = r.items; list(ul, items.map(function (i) { return i.title; }), "item"); });
    },
    c: function (c) {
      var button = el("button", { "data-testid": "load" }, "Load both");
      var left = el("ul");
      var right = el("ul");
      var s1 = el("section");
      s1.append(el("h3", {}, "People"), left);
      var s2 = el("section");
      s2.append(el("h3", {}, "Activity"), right);
      c.append(button, s1, s2);
      button.addEventListener("click", function () {
        api.left().then(function (p) { list(left, p.rows, "left-row"); });
        api.right().then(function (p) { list(right, p.rows, "right-row"); });
      });
    },
    d: function (c) {
      var state = { todos: [] };
      var render = todosView(c, state, function (t) { optimisticToggle(state, render, c, t); });
      api.todos().then(function (r) { state.todos = r.todos; render(); });
    },
    e: function (c) {
      c.append(el("h2", {}, "Notes"));
      var input = el("input", { "data-testid": "note-text", placeholder: "Note" });
      var add = el("button", { "data-testid": "note-add" }, "Add");
      var ul = el("ul");
      c.append(input, add, ul);
      var notes = [];
      var seq = 0;
      var render = function () { list(ul, notes.map(function (n) { return n.text + (n.pending ? " (pending)" : ""); }), "note"); };
      api.notes().then(function (r) { notes = r.notes.map(function (n) { return { key: "s" + n.id, text: n.text }; }).concat(notes); render(); });
      var queue = [];
      var flushing = false;
      var send = function (row) {
        return api.addNote(row.text).then(
          function (saved) {
            notes = notes.map(function (n) { return n.key === row.key ? { key: "s" + saved.id, text: saved.text } : n; });
            render();
            return true;
          },
          function () { return false; },
        );
      };
      var flush = function () {
        if (flushing || !queue.length) return;
        flushing = true;
        send(queue[0]).then(function (ok) {
          flushing = false;
          if (ok) { queue.shift(); flush(); }
        });
      };
      window.addEventListener("online", flush);
      add.addEventListener("click", function () {
        var row = { key: "l" + ++seq, text: input.value, pending: true };
        input.value = "";
        notes.push(row);
        render();
        if (queue.length || flushing) return void queue.push(row);
        send(row).then(function (ok) { if (!ok) queue.push(row); });
      });
    },
    f: function (c) {
      var plus = el("button", { "data-testid": "plus" }, "+1");
      var p = el("p");
      var count = el("span", { "data-testid": "count" }, "0");
      var synced = el("span", { "data-testid": "synced" }, "0");
      p.append("Count ", count, ", saved ", synced);
      c.append(plus, p);
      plus.addEventListener("click", function () {
        count.textContent = String(Number(count.textContent) + 1);
        api.increment().then(function (r) { synced.textContent = String(Math.max(Number(synced.textContent), r.count)); });
      });
    },
    g: function (c) {
      livePanel(c, function (on) {
        DETAIL_IDS.forEach(function (id) { api.detail(id).then(on.detail); });
        var poll = function () {
          api.status().then(function (r) {
            on.tick(r.tick);
            if (r.tick < 8) setTimeout(poll, 250);
          });
        };
        poll();
      });
    },
    h: function (c) {
      c.append(el("h2", {}, "Items"));
      var items = [];
      var ul = el("ul");
      c.append(ul);
      createForm(c, function (title, clear) {
        api.createItem(title).then(function (item) { items.push(item); list(ul, items.map(function (i) { return i.title; }), "item"); clear(); });
      });
      c.append(el("h2", {}, "Search"));
      typeahead(c, function (q, rl) {
        if (!q) return list(rl, []);
        api.search(q).then(function (r) { list(rl, r.results, "result"); }, function () {});
      });
      api.items().then(function (r) { items = r.items; list(ul, items.map(function (i) { return i.title; }), "item"); });
    },
  };

  // ------------------------------------------------------------------------------------- layer: push (WS + SSE)
  function socket() {
    var ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
    var handlers = [];
    var queued = [];
    ws.addEventListener("open", function () { queued.splice(0).forEach(function (m) { ws.send(m); }); });
    ws.addEventListener("message", function (e) {
      var m = JSON.parse(e.data);
      handlers.forEach(function (h) { h(m); });
    });
    return {
      send: function (o) {
        var m = JSON.stringify(o);
        if (ws.readyState === 1) ws.send(m);
        else queued.push(m);
      },
      on: function (h) { handlers.push(h); },
    };
  }
  var PUSH = {
    a: function (c) {
      var ws = socket();
      var seq = 0;
      var ul = typeahead(c, function (q, rl) {
        if (!q) return list(rl, []);
        ws.send({ type: "search", id: ++seq, q: q });
      });
      ws.on(function (m) { if (m.type === "results") list(ul, m.results, "result"); });
    },
    c: function (c) {
      var ws = socket();
      var button = el("button", { "data-testid": "load" }, "Load both");
      var left = el("ul");
      var right = el("ul");
      var s1 = el("section");
      s1.append(el("h3", {}, "People"), left);
      var s2 = el("section");
      s2.append(el("h3", {}, "Activity"), right);
      c.append(button, s1, s2);
      ws.on(function (m) { if (m.type === "left") list(left, m.rows, "left-row"); });
      button.addEventListener("click", function () {
        ws.send({ type: "left" });
        var es = new EventSource("/sse/right");
        es.addEventListener("message", function (e) {
          var m = JSON.parse(e.data);
          if (m.type === "right") { list(right, m.rows, "right-row"); es.close(); }
        });
      });
    },
    d: function (c) {
      var ws = socket();
      var state = { todos: [] };
      var render = todosView(c, state, function (t) { optimisticToggle(state, render, c, t); });
      ws.on(function (m) {
        if (m.type === "todos") { state.todos = m.todos; render(); }
        if (m.type === "todo") { state.todos = state.todos.map(function (x) { return x.id === m.todo.id ? m.todo : x; }); render(); }
      });
      ws.send({ type: "todos" });
    },
    g: function (c) {
      livePanel(c, function (on) {
        var ws = socket();
        ws.on(function (m) { if (m.type === "detail") on.detail(m); });
        DETAIL_IDS.forEach(function (id) { ws.send({ type: "detail", id: id }); });
        var es = new EventSource("/sse/status");
        es.addEventListener("message", function (e) {
          var m = JSON.parse(e.data);
          on.tick(m.tick);
          if (m.tick >= 8) es.close();
        });
      });
    },
    h: function (c) {
      var ws = socket();
      c.append(el("h2", {}, "Items"));
      var items = [];
      var ul = el("ul");
      c.append(ul);
      var render = function () { list(ul, items.map(function (i) { return i.title; }), "item"); };
      var upsert = function (item) {
        if (!items.some(function (i) { return i.id === item.id; })) items.push(item);
        render();
      };
      createForm(c, function (title, clear) {
        api.createItem(title).then(function (item) { upsert(item); clear(); });
      });
      c.append(el("h2", {}, "Search"));
      var seq = 0;
      var rl = typeahead(c, function (q, r) {
        if (!q) return list(r, []);
        ws.send({ type: "search", id: ++seq, q: q });
      });
      ws.on(function (m) {
        if (m.type === "items") { items = m.items.slice(); render(); }
        if (m.type === "item-added") upsert(m.item);
        if (m.type === "results") list(rl, m.results, "result");
      });
      ws.send({ type: "items" });
    },
  };

  var L = layer === "push" ? PUSH : FETCH;
  (L[s] || L.h)(root);
  root.setAttribute("data-ready", "1");
})();
