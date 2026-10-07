"""Runtime-like decision scenarios per trigger (CONTRACT §6) with exact ground truth.

Each builder constructs a Trace, writes facts with paraphrase templates, and returns a Scen with the action and
diagnosis labels (hard, or a soft dist for genuinely ambiguous cases, always leaning passive), plus primitive
questions about the same trace. Benign look-alikes (salient but fine) are first-class cases.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field

import prims as P
from app import App, rand_token
from fmt import Style, pick, pick_from
from world import Op, Trace

PASSIVE_OF = {"mutation": "apply", "request": "send", "failure": "deliver", "stall": "wait",
              "inconsistency": "ignore", "transition": "ignore", "error": "ignore"}


@dataclass
class Scen:
    trigger: str
    case: str
    subject: str
    subj: str
    facts: list[str]
    actions: list[str]
    action: str | dict
    diag: str | dict
    state_paths: list[str] = field(default_factory=list)
    extra_state: list[str] = field(default_factory=list)
    stats_sigs: list[str] = field(default_factory=list)
    prims: list = field(default_factory=list)
    exclude_inflight: tuple = ()
    trace: object = None
    spec: dict = field(default_factory=dict)

    @property
    def passive_best(self) -> bool:
        p = PASSIVE_OF[self.trigger]
        if isinstance(self.action, str):
            return self.action == p
        return max(self.action, key=self.action.get) == p


def _u(rng: random.Random, a: float, b: float) -> float:
    return rng.uniform(a, b)


def add_noise_ops(rng: random.Random, app: App, tr: Trace, t_lo: float, t_hi: float, k: int | None = None) -> None:
    """Unrelated background activity (polling, analytics, other stores) so salience is not a shortcut."""
    k = rng.randint(0, 2) if k is None else k
    for _ in range(k):
        t = _u(rng, t_lo, t_hi)
        kind = rng.random()
        if kind < 0.5:
            tm = tr.timer(t, rng.choice(("poll every 5 s", "heartbeat", "refresh interval", "presence ping")))
            path = rng.choice(("/notifications", "/presence", "/health", "/badge-count", "/me"))
            o = tr.fetch(t + 1, "GET", app.api + path, "GET " + app.api + path, cause=tm)
            if rng.random() < 0.8:
                tr.finish(o, min(t + _u(rng, 30, 300), tr.now - 1 if tr.now > t + 2 else t + 2), 200)
        elif kind < 0.8:
            target, path, vals = rng.choice((("#sidebar-toggle", "ui.sidebarOpen", ("true", "false")),
                                             ("#tab-overview", "ui.tab", ('"overview"', '"activity"', '"settings"')),
                                             ("#sort", "ui.sort", ('"name"', '"date"', '"price"')),
                                             ("#theme", "prefs.theme", ('"dark"', '"light"')),
                                             ("#page-size", "ui.pageSize", ("25", "50", "100"))))
            u = tr.user(t, rng.choice(("click", "change")), target)
            if path not in tr.values0:
                tr.init_field(path, rng.randint(1, 30), rng.choice(vals))
            tr.write(t + 1, path, u, rng.choice(vals))
        else:
            o = tr.fetch(t, "POST", app.api + "/events", "POST " + app.api + "/events", body='{"type":"view"}')
            tr.finish(o, min(t + _u(rng, 20, 120), max(t + 2, tr.now - 1)), 204)


def cap_now(tr: Trace) -> None:
    """Ops that would end after now are in flight."""
    for o in tr.ops.values():
        if o.end is not None and o.end > tr.now and o.kind == "fetch":
            o.end, o.status, o.code, o.err = None, None, None, ""


# ================================================================================================ mutation


def mutation(rng: random.Random, app: App, st: Style) -> Scen:
    r = rng.random()
    if r < 0.42:
        return mut_typeahead(rng, app, st)
    if r < 0.62:
        return mut_detail(rng, app, st)
    if r < 0.78:
        return mut_autosave(rng, app, st)
    if r < 0.89:
        return mut_live(rng, app, st)
    return mut_dupchange(rng, app, st)


def _mut_actions(rng: random.Random) -> list[str]:
    return ["apply", "discard", "defer"]


def mut_typeahead(rng: random.Random, app: App, st: Style) -> Scen:
    case = rng.choices(("stale", "fresh", "older_between", "moved_inflight", "same_root"), (0.36, 0.22, 0.2, 0.12, 0.1))[0]
    tr = Trace(rng)
    test = st.test
    store = rng.choice(("search", app.coll, app.ident("results"), "finder"))
    F = f"{store}.{rng.choice(('results', 'items', 'hits', 'list'))}"
    QF = f"{store}.{rng.choice(('query', 'q', 'term', 'text'))}"
    target = app.input_target()
    base = app.coll_url() if rng.random() < 0.5 else app.api + "/search"
    sig = f"GET {base}"
    pre = app.query_prefixes()
    vF, vQ = rng.randint(1, 40), rng.randint(1, 60)
    tr.init_field(F, vF, app.list_summary(rng.randint(0, 40)))
    tr.init_field(QF, vQ, f'"{pre[0][:-1]}"')
    med = _u(rng, 60, 400)
    tr.baseline(sig, med, med * _u(rng, 2.2, 4), rng.choice((0.0, 0.002, 0.01, 0.03)), rng.randint(30, 900))
    t = 0.0
    reqs: list[Op] = []
    users: list[Op] = []
    deb = _u(rng, 1, 260)  # the app's debounce: requests start in keystroke order
    for p in pre:
        u = tr.user(t, "input", target, p)
        tr.write(t + 0.5, QF, u, f'"{p}"')
        o = tr.fetch(t + deb + _u(rng, 0, 5), "GET", f"{base}?q={p}", sig, cause=u)
        users.append(u)
        reqs.append(o)
        t += _u(rng, 90, 420)
    n = len(reqs)
    # durations; choose X (subject) and the arrangement per case
    if case == "stale":
        xi = rng.randrange(0, n - 1)
        X = reqs[xi]
        Y = rng.choice(reqs[xi + 1:])
        y_end = Y.start + _u(rng, 0.4, 1.2) * med
        x_end = max(y_end + _u(rng, 20, 900), X.start + _u(rng, 2.5, 12) * med, reqs[-1].start + 5)
        for o in reqs:
            lat = _u(rng, 0.5, 3) * med
            if o is X:
                tr.finish(o, x_end)
            elif o is Y:
                tr.finish(o, y_end)
                tr.write(y_end + 1, F, o, app.list_summary(rng.randint(0, 30)))
            elif o.start < X.start:
                if o.start + lat < X.start:
                    tr.finish(o, o.start + lat)
                    tr.write(o.start + lat + 1, F, o, app.list_summary(rng.randint(0, 30)))
                else:
                    tr.abort(o, X.start + 1)  # superseded by the app
            else:
                e = o.start + lat
                if o.start > Y.start and e < x_end and rng.random() < 0.5:
                    tr.finish(o, e)
                    tr.write(e + 1, F, o, app.list_summary(rng.randint(0, 30)))
                elif e < x_end:
                    tr.abort(o, e)
        tr.now = x_end + 1
    elif case in ("fresh", "same_root"):
        X = reqs[-1]
        x_end = X.start + _u(rng, 0.5, 2.5) * med
        for o in reqs[:-1]:
            e = o.start + _u(rng, 0.4, 1.0) * med
            if e < X.start:
                tr.finish(o, e)
                tr.write(e + 1, F, o, app.list_summary(rng.randint(0, 30)))
            else:
                tr.abort(o, min(X.start + 2, o.start + 60))
        if case == "same_root":  # optimistic placeholder from the same keystroke
            tr.write(X.start + 2, F, tr.ops[X.cause], "[] (loading placeholder)")
        tr.finish(X, x_end)
        tr.now = x_end + 1
    elif case == "older_between":
        X = reqs[-1]
        W = reqs[-2]
        w_end = X.start + _u(rng, 10, 0.9 * med)
        x_end = w_end + _u(rng, 10, 1.5 * med)
        for o in reqs[:-2]:
            e = o.start + _u(rng, 0.4, 1.0) * med
            if e < X.start:
                tr.finish(o, e)
                tr.write(e + 1, F, o, app.list_summary(rng.randint(0, 30)))
            else:
                tr.abort(o, X.start + 1)
        tr.finish(W, w_end)
        tr.write(w_end + 1, F, W, app.list_summary(rng.randint(0, 30)))
        tr.finish(X, x_end)
        tr.now = x_end + 1
    else:  # moved_inflight: a newer request is still running, nothing newer written yet
        xi = rng.randrange(0, n - 1)
        X = reqs[xi]
        x_end = X.start + _u(rng, 1.0, 4) * med
        x_end = max(x_end, reqs[-1].start + 5)
        for o in reqs:
            if o is X:
                tr.finish(o, x_end)
            elif o.start < X.start:
                e = o.start + _u(rng, 0.4, 1.0) * med
                if e < X.start:
                    tr.finish(o, e)
                    tr.write(e + 1, F, o, app.list_summary(rng.randint(0, 30)))
                else:
                    tr.abort(o, X.start + 1)
            # newer ones stay in flight
        tr.now = x_end + 1
    add_noise_ops(rng, app, tr, 0, tr.now - 5)
    cap_now(tr)
    Xu = tr.ops[X.cause]
    new_val = app.list_summary(rng.randint(0, 30))
    facts = [pick(rng, "prov_write", test, req=X.req, op=st.op(X.id), ago=st.ago(tr.now - X.start),
                  root=tr.root_desc(X))]
    v0, v1 = tr.version(F, X.start), tr.version(F)
    since = tr.writes_between(F, X.start)
    if v0 == v1:
        facts.append(pick(rng, "ver_same", test, path=F, op=st.op(X.id), v0=v0))
    else:
        facts.append(pick(rng, "ver_moved", test, path=F, op=st.op(X.id), v0=v0, v1=v1))
        for w in since[-2:]:
            wo = tr.ops[w.op]
            if wo.kind == "user" or wo.root == X.root:
                facts.append(pick(rng, "ver_writer_same_root", test, v=w.version, path=F, wop=st.op(wo.id),
                                  op=st.op(X.id), wroot=tr.root_desc(wo)))
            elif wo.start > X.start:
                facts.append(pick(rng, "ver_writer_newer", test, v=w.version, path=F, req=wo.req, wop=st.op(wo.id),
                                  gap=st.dur(wo.start - X.start), op=st.op(X.id), wroot=tr.root_desc(wo)))
            else:
                facts.append(pick(rng, "ver_writer_older", test, v=w.version, path=F, req=wo.req, wop=st.op(wo.id),
                                  gap=st.dur(X.start - wo.start), op=st.op(X.id), wroot=tr.root_desc(wo)))
    q_then = tr.ops[X.cause].value
    q_now = tr.value(QF).strip('"')
    if q_now != q_then:
        last_u = [w for w in tr.writes if w.path == QF][-1]
        facts.append(pick(rng, "inputs_moved", test, path=QF, before=f'"{q_then}"', after=f'"{q_now}"',
                          op=st.op(X.id), who=f"user input on {target}", ago=st.ago(tr.now - last_u.t)))
    inflight_same = [o for o in tr.in_flight() if o.sig == sig and o.id != X.id]
    for o in inflight_same[:1]:
        rel = "after" if o.start > X.start else "before"
        facts.append(pick(rng, "concurrent_same", test, other=st.op(o.id), oreq=o.req, path=F,
                          gap=st.dur(abs(o.start - X.start)), rel=rel, op=st.op(X.id)))
    facts.append(pick(rng, "delta", test, path=F, before=tr.value(F), after=new_val))
    # labels
    if case == "stale":
        action, diag = "discard", "stale"
    elif case == "moved_inflight":
        action, diag = {"defer": 0.7, "discard": 0.2, "apply": 0.1}, {"stale": 0.8, "conflict": 0.2}
    else:
        action, diag = "apply", "expected"
    prims = P.versions(rng, tr, st, F, X) + P.temporal(rng, tr, st) + P.causal(rng, tr, st)
    subject = pick_from(rng, [f"A write to {F} from {X.req} ({st.op(X.id)}) is about to apply.",
                              f"{st.op(X.id)} ({X.req}) wants to write {F}.",
                              f"Pending write: {F} ← {X.req} ({st.op(X.id)}).",
                              f"The response of {X.req} is about to update {F}."], test)
    return Scen("mutation", f"typeahead/{case}", subject, F, facts, _mut_actions(rng), action, diag,
                state_paths=[F, QF], stats_sigs=[sig], prims=prims, trace=tr,
                spec={"cause": X, "paths": [F], "after": new_val, "store": store, "state_extra": [QF]})


def mut_detail(rng: random.Random, app: App, st: Style) -> Scen:
    case = rng.choices(("stale", "fresh", "moved_inflight", "older_between"), (0.4, 0.3, 0.15, 0.15))[0]
    tr = Trace(rng)
    test = st.test
    store = rng.choice((app.item, "detail", "current", app.ident("selected " + app.noun)))
    F = f"{store}.{rng.choice(('data', 'item', 'record', 'value'))}"
    SEL = f"{rng.choice(('ui', 'router', 'nav'))}.{rng.choice(('selectedId', 'activeId', 'openId'))}"
    ids = [app.new_id() for _ in range(3)]
    while len(set(ids)) < 3:
        ids = [app.new_id() for _ in range(3)]
    tr.init_field(F, rng.randint(1, 30), f"{{id: {ids[2]}}}")
    tr.init_field(SEL, rng.randint(1, 50), ids[2])
    med = _u(rng, 80, 500)
    url0, sig_path = app.item_url(ids[0])
    sig = f"GET {sig_path}"
    tr.baseline(sig, med, med * _u(rng, 2, 4), rng.choice((0.0, 0.004, 0.02)), rng.randint(20, 600))
    t = 0.0
    u1 = tr.user(t, "click", f'row "{app.word().capitalize()}" ({ids[0]})')
    tr.write(t + 0.5, SEL, u1, ids[0])
    X = tr.fetch(t + _u(rng, 1, 30), "GET", app.item_url(ids[0])[0], sig, cause=u1)
    if case == "fresh":
        x_end = X.start + _u(rng, 0.5, 2.0) * med
        tr.finish(X, x_end)
        tr.now = x_end + 1
    elif case == "older_between":
        tw = X.start - _u(rng, 50, 500)
        u0 = tr.user(tw - 1, "click", f'row "{app.word().capitalize()}" ({ids[2]})')
        W = tr.fetch(tw, "GET", app.item_url(ids[2])[0], sig, cause=u0)
        w_end = X.start + _u(rng, 10, 300)
        tr.finish(W, w_end)
        tr.write(w_end + 1, F, W, f"{{id: {ids[2]}}}")
        x_end = w_end + _u(rng, 20, 600)
        tr.finish(X, x_end)
        tr.now = x_end + 1
    else:
        t2 = X.start + _u(rng, 150, 1500)
        u2 = tr.user(t2, "click", f'row "{app.word().capitalize()}" ({ids[1]})')
        tr.write(t2 + 0.5, SEL, u2, ids[1])
        Y = tr.fetch(t2 + _u(rng, 1, 30), "GET", app.item_url(ids[1])[0], sig, cause=u2)
        if case == "stale":
            y_end = Y.start + _u(rng, 0.4, 1.2) * med
            tr.finish(Y, y_end)
            tr.write(y_end + 1, F, Y, f"{{id: {ids[1]}}}")
            x_end = y_end + _u(rng, 20, 1500)
        else:  # moved_inflight: Y still pending
            x_end = Y.start + _u(rng, 5, 0.5 * med)
        tr.finish(X, x_end)
        tr.now = x_end + 1
    add_noise_ops(rng, app, tr, 0, tr.now - 5)
    cap_now(tr)
    facts = [pick(rng, "prov_write", test, req=X.req, op=st.op(X.id), ago=st.ago(tr.now - X.start), root=tr.root_desc(X))]
    v0, v1 = tr.version(F, X.start), tr.version(F)
    if v0 == v1:
        facts.append(pick(rng, "ver_same", test, path=F, op=st.op(X.id), v0=v0))
    else:
        facts.append(pick(rng, "ver_moved", test, path=F, op=st.op(X.id), v0=v0, v1=v1))
        w = tr.writes_between(F, X.start)[-1]
        wo = tr.ops[w.op]
        key = "ver_writer_newer" if wo.start > X.start else "ver_writer_older"
        facts.append(pick(rng, key, test, v=w.version, path=F, req=wo.req, wop=st.op(wo.id),
                          gap=st.dur(abs(wo.start - X.start)), op=st.op(X.id), wroot=tr.root_desc(wo)))
    if tr.value(SEL) != ids[0]:
        last = [w for w in tr.writes if w.path == SEL][-1]
        facts.append(pick(rng, "inputs_moved", test, path=SEL, before=ids[0], after=tr.value(SEL), op=st.op(X.id),
                          who="a click", ago=st.ago(tr.now - last.t)))
    facts.append(pick(rng, "delta", test, path=F, before=tr.value(F), after=f"{{id: {ids[0]}}}"))
    if case == "stale":
        action, diag = "discard", "stale"
    elif case == "moved_inflight":
        action, diag = {"defer": 0.7, "discard": 0.2, "apply": 0.1}, {"stale": 0.8, "conflict": 0.2}
    else:
        action, diag = "apply", "expected"
    prims = P.versions(rng, tr, st, F, X) + P.temporal(rng, tr, st) + P.causal(rng, tr, st)
    subject = pick_from(rng, [f"A write to {F} from {X.req} ({st.op(X.id)}) is about to apply.",
                              f"{st.op(X.id)} wants to set {F} to the record {ids[0]}.",
                              f"Pending write: {F} ← {X.req}.", f"{X.req} returned and is about to update {F}."], test)
    return Scen("mutation", f"detail/{case}", subject, F, facts, _mut_actions(rng), action, diag,
                state_paths=[F, SEL], stats_sigs=[sig], prims=prims, trace=tr,
                spec={"cause": X, "paths": [F], "after": f"{{id: {ids[0]}}}", "state_extra": [SEL]})


def mut_autosave(rng: random.Random, app: App, st: Style) -> Scen:
    case = rng.choices(("stale", "fresh", "two_saves_last"), (0.5, 0.3, 0.2))[0]
    tr = Trace(rng)
    test = st.test
    store = rng.choice(("editor", "doc", "draft", app.item))
    F = f"{store}.{rng.choice(('content', 'body', 'text', 'value'))}"
    target = rng.choice(("#editor", "#body", "textarea#content", "#note-text"))
    id_ = app.new_id()
    url, sig_path = app.item_url(id_, rng.choice(app.dom.nouns))
    method = rng.choice(("PUT", "PATCH"))
    sig = f"{method} {sig_path}"
    v = rng.randint(3, 60)
    tr.init_field(F, v, f'"…{app.word()}" ({rng.randint(40, 4000)} chars)')
    med = _u(rng, 120, 700)
    tr.baseline(sig, med, med * _u(rng, 2, 4), rng.choice((0.0, 0.01)), rng.randint(20, 400))
    t = 0.0
    n_typed = rng.randint(1, 3)
    for k in range(n_typed):
        u = tr.user(t, "input", target)
        tr.write(t + 0.5, F, u, f'"…{app.word()}" ({rng.randint(40, 4000)} chars)')
        t += _u(rng, 80, 400)
    vsave = tr.version(F, t)
    tm = tr.timer(t + _u(rng, 300, 1500), "autosave debounce")
    S1 = tr.fetch(tm.start + 1, method, url, sig, body=f'{{"content":"…","rev":{vsave}}}', cause=tm)
    if case == "fresh":
        e = S1.start + _u(rng, 0.5, 2) * med
        tr.finish(S1, e)
        tr.now = e + 1
        X = S1
    elif case == "stale":
        t2 = S1.start + _u(rng, 30, 0.8 * med)
        for k in range(rng.randint(1, 4)):
            u = tr.user(t2, "input", target)
            tr.write(t2 + 0.5, F, u, f'"…{app.word()}" ({rng.randint(40, 4000)} chars)')
            t2 += _u(rng, 60, 300)
        e = max(t2 + 5, S1.start + _u(rng, 0.8, 3) * med)
        tr.finish(S1, e)
        tr.now = e + 1
        X = S1
    else:  # two saves; the later save's echo arrives last and matches current content
        t2 = S1.start + _u(rng, 30, 0.6 * med)
        u = tr.user(t2, "input", target)
        tr.write(t2 + 0.5, F, u, f'"…{app.word()}" ({rng.randint(40, 4000)} chars)')
        tm2 = tr.timer(t2 + _u(rng, 300, 900), "autosave debounce")
        S2 = tr.fetch(tm2.start + 1, method, url, sig, body=f'{{"content":"…","rev":{tr.version(F, tm2.start)}}}', cause=tm2)
        e1 = S1.start + _u(rng, 0.5, 1.5) * med
        e1 = min(e1, S2.start + 50)
        tr.finish(S1, e1)
        e2 = S2.start + _u(rng, 0.5, 2) * med
        tr.finish(S2, e2)
        tr.now = e2 + 1
        X = S2
    add_noise_ops(rng, app, tr, 0, tr.now - 5)
    cap_now(tr)
    facts = [pick(rng, "prov_write", test, req=X.req, op=st.op(X.id), ago=st.ago(tr.now - X.start), root=tr.root_desc(X))]
    v0, v1 = tr.version(F, X.start), tr.version(F)
    since = tr.writes_between(F, X.start)
    if v0 == v1:
        facts.append(pick(rng, "ver_same", test, path=F, op=st.op(X.id), v0=v0))
    else:
        facts.append(pick(rng, "ver_moved", test, path=F, op=st.op(X.id), v0=v0, v1=v1))
        w = since[-1]
        facts.append(pick(rng, "ver_writer_user", test, v=w.version, path=F, target=target, ago=st.ago(tr.now - w.t),
                          op=st.op(X.id)))
    echo = pick_from(rng, [f"The response echoes the content saved at version {v0}.",
                           f"The server returned the document as of rev {v0} (what {st.op(X.id)} sent).",
                           f"This write is the server echo of the save sent at v{v0}.",
                           f"Echo payload = content of v{v0}."], test)
    facts.append(echo)
    if case == "stale":
        action, diag = "discard", "stale"
    else:
        action, diag = "apply", "expected"
    prims = P.versions(rng, tr, st, F, X) + P.temporal(rng, tr, st)
    subject = pick_from(rng, [f"The save response of {X.req} ({st.op(X.id)}) is about to write {F}.",
                              f"A write to {F} from the autosave {st.op(X.id)} is pending.",
                              f"Pending write: {F} ← server echo of {X.req}.",
                              f"{st.op(X.id)} finished and wants to update {F}."], test)
    echo_val = ([w.summary for w in tr.writes if w.path == F and w.t <= X.start] or [tr.values0.get(F, "?")])[-1]
    return Scen("mutation", f"autosave/{case}", subject, F, facts, _mut_actions(rng), action, diag,
                state_paths=[F], stats_sigs=[sig], prims=prims, trace=tr,
                spec={"cause": X, "paths": [F], "after": echo_val})


def mut_live(rng: random.Random, app: App, st: Style) -> Scen:
    case = rng.choices(("stale", "newer"), (0.5, 0.5))[0]
    tr = Trace(rng)
    test = st.test
    cid = app.new_id()
    store = rng.choice(("board", app.coll, "feed", "doc"))
    F = f"{store}.{rng.choice(('cards', 'items', 'entries', 'rows'))}[{cid}]"
    chan = f"{store}:{app.new_id()}"
    cur = rng.randint(5, 900)
    tr.init_field(F, rng.randint(2, 40), f"{{status: \"{app.word()}\", rev: {cur - 1}}}")
    t = 0.0
    u = tr.user(t, rng.choice(("drop", "click")), f"#{app.url_word(app.noun)}-{cid}")
    mv = tr.fetch(t + 2, rng.choice(("PATCH", "POST")), app.item_url(cid)[0] + "/move",
                  "PATCH " + app.item_url(cid)[1] + "/move", body=f'{{"to":"{app.word()}"}}', cause=u)
    tr.write(t + 1, F, u, f'{{status: "{app.word()}", rev: {cur - 1} (optimistic)}}')
    e = mv.start + _u(rng, 80, 600)
    tr.finish(mv, e)
    tr.write(e + 1, F, mv, f'{{status: "{app.word()}", rev: {cur}}}')
    ws = tr._new(kind="ws", start=e + _u(rng, 5, 2500), end=None, status="ok", target=f"channel {chan}")
    ws.end = ws.start
    tr.now = ws.start + 1
    incoming = cur - rng.randint(1, 3) if case == "stale" else cur + rng.randint(1, 3)
    who = rng.choice(("another user", f"{rng.choice(('Ana', 'Omar', 'Lena', 'Kofi', 'Yuki'))}"))
    add_noise_ops(rng, app, tr, 0, tr.now - 5)
    cap_now(tr)
    facts = [pick_from(rng, [f"This write comes from a live update on {chan} ({st.op(ws.id)}), received {st.ago(tr.now - ws.start)}.",
                             f"Source: live message {st.op(ws.id)} on {chan}.",
                             f"{st.op(ws.id)} is a server push on {chan} that wants to update {F}.",
                             f"Live update {st.op(ws.id)} ({chan}) produced this write."], test),
             pick_from(rng, [f"{F} currently holds server revision {cur} (written by {st.op(mv.id)}, our own confirmed change {st.ago(tr.now - e)}).",
                             f"Current revision of {F}: {cur}, from {st.op(mv.id)} ({st.ago(tr.now - e)}).",
                             f"{F} is at rev {cur} after {st.op(mv.id)} confirmed the user's move."], test),
             pick_from(rng, [f"The live update carries revision {incoming} (author: {who}).",
                             f"Incoming payload revision: {incoming}, made by {who}.",
                             f"This update is revision {incoming} from {who}."], test)]
    if case == "stale":
        action, diag = "discard", "stale"
    else:
        action, diag = "apply", "expected"
    prims = [("l_newer",) + P.noul(pick_from(rng, [f"Is the incoming revision newer than the current one in {F}?",
                                                   f"Does the live update carry a newer revision than {F} has?",
                                                   f"Incoming rev > current rev?"], test), incoming > cur)]
    prims += P.temporal(rng, tr, st) + P.causal(rng, tr, st)
    subject = pick_from(rng, [f"A live update ({st.op(ws.id)}) is about to write {F}.",
                              f"Pending write to {F} from the {chan} channel.",
                              f"{st.op(ws.id)} wants to update {F}."], test)
    return Scen("mutation", f"live/{case}", subject, F, facts, _mut_actions(rng), action, diag,
                state_paths=[F], prims=prims, trace=tr,
                spec={"cause": ws, "paths": [F], "after": f'{{status: "{app.word()}", rev: {incoming}}}'})


def mut_dupchange(rng: random.Random, app: App, st: Style) -> Scen:
    case = rng.choices(("dup_append", "separate_clicks", "idempotent_set"), (0.45, 0.35, 0.2))[0]
    tr = Trace(rng)
    test = st.test
    store = rng.choice(("cart", "basket", app.coll, "selection", "list"))
    F = f"{store}.{rng.choice(('items', 'lines', 'entries'))}" if case != "idempotent_set" else \
        f"{rng.choice(('ui', 'filters', 'prefs'))}.{rng.choice(('status', 'view', 'sort', 'range'))}"
    btn = app.button()
    n0 = rng.randint(0, 6)
    tr.init_field(F, rng.randint(1, 30), app.list_summary(n0) if case != "idempotent_set" else '"all"')
    t = 0.0
    u1 = tr.user(t, "click", btn)
    if case == "dup_append":
        w1 = tr.write(t + _u(rng, 1, 20), F, u1, app.list_summary(n0 + 1))
        tr.now = w1.t + _u(rng, 3, 60)
        X_root = u1
        gap = tr.now - w1.t
        same = "the same click"
        new_val = app.list_summary(n0 + 2)
    elif case == "separate_clicks":
        w1 = tr.write(t + _u(rng, 1, 20), F, u1, app.list_summary(n0 + 1))
        t2 = w1.t + _u(rng, 1200, 9000)
        u2 = tr.user(t2, "click", btn)
        tr.now = t2 + _u(rng, 1, 20)
        X_root = u2
        gap = tr.now - w1.t
        same = "a separate click"
        new_val = app.list_summary(n0 + 2)
    else:
        val = rng.choice(('"open"', '"grid"', '"price"', '"last 7 days"'))
        w1 = tr.write(t + _u(rng, 1, 20), F, u1, val)
        tr.now = w1.t + _u(rng, 3, 60)
        X_root = u1
        gap = tr.now - w1.t
        same = "the same click"
        new_val = val
    add_noise_ops(rng, app, tr, -5000, max(-1, tr.now - 5000))
    cap_now(tr)
    facts = [pick_from(rng, [f"This write comes from the handler of {tr.root_desc(X_root)} ({st.op(X_root.id)}).",
                             f"Source: {st.op(X_root.id)}, {tr.root_desc(X_root)}.",
                             f"The change was made synchronously by {tr.root_desc(X_root)}."], test),
             pick(rng, "rep_identical_change", test, path=F, ago=st.ago(gap), same=same),
             pick(rng, "delta", test, path=F, before=tr.value(F), after=new_val)]
    if case == "dup_append":
        action, diag = "discard", "duplicate"
    else:
        action, diag = "apply", "expected"
    prims = [("d_same",) + P.noul(pick_from(rng, ["Did the earlier identical change come from the same user action?",
                                                  "Are both identical changes caused by one click?",
                                                  "Same user action behind both changes?"], test), case != "separate_clicks"),
             ("d_gap",) + P.score(pick_from(rng, ["How long ago was the identical change?",
                                                  "Time since the identical change?"], test),
                                  ["under 100 ms", "100 ms to 1 s", "1 to 5 s", "more than 5 s"],
                                  0 if gap < 100 else 1 if gap < 1000 else 2 if gap < 5000 else 3)]
    subject = pick_from(rng, [f"A write to {F} from {st.op(X_root.id)} is about to apply.",
                              f"Pending change to {F} ({tr.root_desc(X_root)}).", f"{F} is about to change."], test)
    what = f"set to {new_val}" if case == "idempotent_set" else "added 1 item {id: " + app.new_id() + "}"
    return Scen("mutation", f"dupchange/{case}", subject, F, facts, _mut_actions(rng), action, diag,
                state_paths=[F], prims=prims, trace=tr,
                spec={"cause": X_root, "paths": [F], "after": new_val,
                      "repetition": {"writer": u1, "t": w1.t, "what": what, "additive": case != "idempotent_set"}})
