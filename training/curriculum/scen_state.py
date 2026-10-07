"""Inconsistency / transition / error scenarios (state side of CONTRACT §6)."""

from __future__ import annotations

import random

import prims as P
from app import App
from fmt import Style, pick, pick_from
from scenarios import Scen, _u, add_noise_ops, cap_now
from world import Trace
from vocab import COMPONENTS, FILE_EXT, THIRD_PARTY


def _money(rng: random.Random) -> float:
    return round(rng.uniform(1, 200), 2)


def _fmt(x: float) -> str:
    return f"{x:.2f}"


def _v(x) -> str:
    return _fmt(x) if isinstance(x, float) else str(x)


def inconsistency(rng: random.Random, app: App, st: Style) -> Scen:
    case = rng.choices(("partial_sum", "count_drift", "negative", "dup_ids", "explained_discount", "weak_invariant",
                        "coincidental"),
                       (0.15, 0.12, 0.09, 0.08, 0.16, 0.15, 0.25))[0]
    tr = Trace(rng)
    test = st.test
    store = rng.choice(("cart", "basket", "order", app.coll, "summary", "invoice"))
    items = app.ident(rng.choice(("items", "lines", "entries", "rows")))
    has_resync = rng.random() < 0.5
    n_settled = rng.randint(3, 6) if case == "weak_invariant" else rng.randint(8, 400)
    facts: list[str] = []
    extra: list[str] = []
    k = rng.randint(2, 5)
    prices = [_money(rng) for _ in range(k)]
    qtys = [rng.randint(1, 4) for _ in range(k)]
    total = round(sum(p * q for p, q in zip(prices, qtys)), 2)
    url = app.coll_url(rng.choice(app.dom.nouns)) + rng.choice(("/items", "", "/lines"))
    tr.init_field(f"{store}.{items}", rng.randint(3, 60), f"{k} items")
    tr.init_field(f"{store}.total", rng.randint(3, 60), _fmt(total))
    tr.init_field(f"{store}.count", rng.randint(3, 60), str(k))
    tr.init_field(f"{store}.discount", rng.randint(1, 20), "0.00")
    t = 0.0
    u = tr.user(t, "click", app.button())
    op = tr.fetch(t + 2, rng.choice(("POST", "PATCH", "DELETE")), url, f"POST {url}", body=app.body(), cause=u)
    if case == "partial_sum":
        rel = f"{store}.total == sum({store}.{items}[*].price * {store}.{items}[*].qty)"
        new_p, new_q = _money(rng), rng.randint(1, 3)
        lhs, rhs = total, round(total + new_p * new_q, 2)
        tr.finish(op, t + _u(rng, 100, 900), rng.choice((500, 502, 503, None)), err="" if rng.random() < 0.7 else "timeout")
        tr.write(t + 1, f"{store}.{items}", u, f"{k + 1} items (optimistic add, {_fmt(new_p)} × {new_q})")
        what = pick_from(rng, [f"the optimistic add of a line by {tr.root_desc(op)}, whose {op.req} then failed",
                               f"{st.op(op.id)} {op.req} failing after {store}.{items} was updated optimistically",
                               f"a failed {op.req} ({st.op(op.id)}) that left {store}.{items} updated but not {store}.total"],
                         test)
        label_a = "resync" if has_resync else "rollback"
        diag = "inconsistent"
    elif case == "count_drift":
        rel = f"{store}.count == len({store}.{items})"
        lhs, rhs = k + rng.choice((1, 2, -1)), k
        tr.finish(op, t + _u(rng, 80, 600), 200)
        tr.write(t + _u(rng, 600, 700), f"{store}.count", op, str(lhs))
        what = pick_from(rng, [f"{op.req} ({st.op(op.id)}) updated {store}.count but the list kept {k} items",
                               f"the response of {st.op(op.id)} set {store}.count to {lhs}"], test)
        label_a = "resync" if has_resync else "rollback"
        diag = "inconsistent"
    elif case == "negative":
        f = rng.choice(("stock", "balance", "seats", "remaining", "credits"))
        rel = f"{store}.{f} >= 0"
        lhs, rhs = -rng.randint(1, 5), 0
        o2 = tr.fetch(t + _u(rng, 5, 80), "POST", url, f"POST {url}", body=app.body(), cause=u)
        tr.finish(op, t + _u(rng, 100, 400), 200)
        tr.finish(o2, t + _u(rng, 120, 500), 200)
        tr.write(op.end + 1, f"{store}.{f}", op, "0")
        tr.write(o2.end + 1, f"{store}.{f}", o2, str(lhs))
        what = pick_from(rng, [f"two concurrent decrements ({st.op(op.id)} and {st.op(o2.id)}) both applied",
                               f"{st.op(o2.id)} decremented {store}.{f} after {st.op(op.id)} had already brought it to 0"],
                         test)
        label_a = "resync" if has_resync else "rollback"
        diag = "inconsistent"
    elif case == "dup_ids":
        rel = f"{store}.{items}[*].id unique"
        dup = app.new_id()
        lhs, rhs = f"id {dup} appears twice", "unique ids"
        o2 = tr.fetch(t + _u(rng, 1, 40), op.method, url, f"{op.method} {url}", body=op.body, cause=u)
        tr.finish(op, t + _u(rng, 80, 400), 201)
        tr.finish(o2, t + _u(rng, 90, 450), 201)
        tr.write(op.end + 1, f"{store}.{items}", op, f"{k + 1} items")
        tr.write(o2.end + 1, f"{store}.{items}", o2, f"{k + 2} items (id {dup} twice)")
        what = pick_from(rng, [f"two identical inserts ({st.op(op.id)}, {st.op(o2.id)}) from the same click",
                               f"{st.op(o2.id)} appended an item with id {dup} that {st.op(op.id)} had already added"], test)
        label_a = "resync" if has_resync else "rollback"
        diag = {"inconsistent": 0.6, "duplicate": 0.4}
    elif case == "explained_discount":
        rel = f"{store}.total == sum({store}.{items}[*].price * {store}.{items}[*].qty)"
        disc = round(rng.choice((5, 10, 15, 20)) / 100 * total, 2) if rng.random() < 0.5 else float(rng.choice((5, 10, 20)))
        disc = min(disc, round(total - 0.01, 2))
        lhs, rhs = round(total - disc, 2), total
        tr.finish(op, t + _u(rng, 80, 600), 200)
        tr.write(op.end + 1, f"{store}.discount", op, _fmt(disc))
        tr.write(op.end + 1.5, f"{store}.total", op, _fmt(lhs))
        what = pick_from(rng, [f"{op.req} ({st.op(op.id)}, from {tr.root_desc(op)}) which also set {store}.discount from 0.00 to {_fmt(disc)}",
                               f"the coupon response of {st.op(op.id)}: {store}.discount 0.00 → {_fmt(disc)} in the same update"],
                         test)
        label_a = {"ignore": 0.8, "resync": 0.2} if has_resync else {"ignore": 0.85, "rollback": 0.15}
        diag = "expected"
    elif case == "coincidental":
        # a relation the miner learned by coincidence between unrelated fields (few settled points), broken by a
        # legitimate user action: SIM labels these `expected` (the invariant miner learns many such relations)
        n_settled = rng.randint(3, 8)
        other = rng.choice(("lanes", "summary", "stats", "panel", "filters", "meta"))
        f1 = app.ident(rng.choice(("total count", "page", "unread", "selected index", "version", "level")))
        kind = rng.choice(("member", "equal", "unique"))
        ue = tr.user(t + _u(rng, 200, 900), rng.choice(("click", "change", "input")),
                     rng.choice((f'item "{app.word().capitalize()}"', "#status", f'button "{app.dom.buttons[0]}"')),
                     rng.choice(("", "low", "high", app.word())))
        v1 = rng.randint(1, 9)
        if kind == "member":
            rel = f"{store}.{f1} ∈ {other}.results[*].version"
            lhs, rhs = v1, "the versions in the list"
            tr.write(ue.start + 1, f"{other}.results", ue, f"{rng.randint(3, 15)} items, 1 changed")
        elif kind == "equal":
            f2 = app.ident(rng.choice(("low", "pending", "open count", "rank")))
            rel = f"{store}.{f1} == {other}.{f2}"
            lhs, rhs = v1, v1 + rng.choice((1, -1, 2))
            tr.write(ue.start + 1, f"{other}.{f2}", ue, str(rhs))
        else:
            rel = f"{store}.{items}[*].{app.ident(app.text_field)} unique"
            lhs, rhs = "duplicates", "unique values"
            tr.write(ue.start + 1, f"{store}.{items}", ue, f"{k} → {k + 1} items: added {{text: \"{app.word()}\"}}")
        what = pick_from(rng, [f"{tr.root_desc(ue)}, a normal user action", f"the user action {tr.root_desc(ue)}"], test)
        label_a = {"ignore": 0.85, "resync": 0.15} if has_resync else {"ignore": 0.85, "rollback": 0.15}
        diag = "expected"
    else:  # weak_invariant: learned from very few snapshots, changed by a direct user edit
        f1, f2 = rng.choice((("shippingAddress", "billingAddress"), ("displayName", "legalName"), ("startDate", "endDate"),
                             ("currency", "displayCurrency")))
        f1, f2 = app.ident(f1), app.ident(f2)
        rel = f"{store}.{f1} == {store}.{f2}"
        lhs, rhs = f'"{app.word()}"', f'"{app.word()}"'
        ue = tr.user(t + _u(rng, 200, 900), "input", f"#{app.url_word(f1)}", lhs.strip('"'))
        tr.write(ue.start + 1, f"{store}.{f1}", ue, lhs)
        what = pick_from(rng, [f"the user editing {store}.{f1} in #{app.url_word(f1)}",
                               f"user input on #{app.url_word(f1)}, which changed only {store}.{f1}"], test)
        label_a = {"ignore": 0.85, "resync": 0.15} if has_resync else {"ignore": 0.85, "rollback": 0.15}
        diag = "expected"
    tr.now = max([w.t for w in tr.writes] + [o.end or o.start for o in tr.ops.values()]) + rng.choice((60, 80, 150, 400))
    add_noise_ops(rng, app, tr, -6000, -5)
    cap_now(tr)
    facts.append(pick(rng, "inv_violated", test, rel=rel, lhs=_v(lhs), rhs=_v(rhs), n=n_settled))
    facts.append(pick(rng, "inv_mutation", test, what=what, ago=st.ago(tr.now - max(w.t for w in tr.writes))))
    age = _u(rng, 300, 20000)
    facts.append(pick(rng, "inv_consistent_age", test, store=store, age=st.dur(age)))
    if has_resync:
        facts.append(pick_from(rng, [f"{store} has a resync handler (reload from the server).",
                                     f"The app registered resync for {store}.", f"Resync is available for {store}."], test))
    if case in ("partial_sum", "explained_discount"):
        lines = list(zip(prices, qtys)) + ([(new_p, new_q)] if case == "partial_sum" else [])
        extra.append(f"{store}.{items}: " + "; ".join(f"{_fmt(p)} × {q}" for p, q in lines))
        extra.append(f"{store}.total: {_v(lhs)}")
        if case == "explained_discount":
            extra.append(f"{store}.discount: {_fmt(total - lhs)}")
    actions = ["ignore", "rollback"] + (["resync"] if has_resync else [])
    holds = case in ("explained_discount",)
    prims = [("n_settled",) + P.score(pick_from(rng, ["How much evidence supports the learned relation?",
                                                      "How many settled points confirmed the relation?",
                                                      "Strength of the learned invariant?"], test),
                                      ["fewer than 5 points", "5 to 20", "more than 20"],
                                      0 if n_settled < 5 else 1 if n_settled <= 20 else 2)]
    if case in ("partial_sum", "explained_discount"):
        explained = case == "explained_discount"
        prims.append(("n_explained",) + P.noul(pick_from(rng, [
            f"Does another field changed in the same update exactly explain the difference in {rel.split(' ==')[0]}?",
            "Is the mismatch fully accounted for by a field that changed at the same time?",
            "Can the violation be explained by a simultaneous change elsewhere?"], test), explained))
    prims += P.temporal(rng, tr, st) + P.causal(rng, tr, st)
    subject = pick_from(rng, [f"A learned relation broke at a settled point: {rel}.", f"Invariant violation in {store}: {rel}.",
                              f"{store} no longer satisfies {rel}.", f"The relation {rel} is violated."], test)
    left, _, right = rel.partition(" == ")
    if case in ("negative",):
        values = f"{store}.{f} = {_v(lhs)}"
    elif case == "dup_ids":
        values = f"{lhs}"
    elif case == "coincidental" and kind == "member":
        values = f"{store}.{f1} = {lhs}, not among {other}.results[*].version"
    elif case == "coincidental" and kind == "unique":
        values = f"{rel.replace(' unique', '')} has duplicates"
    else:
        values = f"{left} = {_v(lhs)}, {right} = {_v(rhs)}"
    fields = sorted({w.path for w in tr.writes if w.path.startswith(store + ".")
                     or (case == "coincidental" and w.op in tr.ops and tr.ops[w.op].kind == "user")})
    spec = {"rel": rel, "values": values, "held": n_settled, "fields": fields, "lc_age": age,
            "state_paths": fields, "state_lines": [x for x in extra if x.split(":")[0] not in fields]}
    return Scen("inconsistency", f"inconsistency/{case}", subject, store, facts, actions, label_a, diag,
                extra_state=extra, prims=prims, trace=tr, spec=spec)


def transition(rng: random.Random, app: App, st: Style) -> Scen:
    case = rng.choices(("missing_write", "null_write", "common_variant", "few_obs", "empty_after_filter"),
                       (0.25, 0.18, 0.22, 0.17, 0.18))[0]
    tr = Trace(rng)
    test = st.test
    store = rng.choice((app.coll, "cart", app.item, "list", "dashboard"))
    a, b = (f"{store}.{app.ident(x)}" for x in rng.sample(("items", "total", "count", "updated at", "status", "summary",
                                                            "page info", "badge"), 2))
    method = rng.choice(("POST", "PUT", "PATCH", "GET"))
    url = app.coll_url()
    sig = f"{method} {url}"
    has_resync = rng.random() < 0.5
    n = rng.randint(4, 15) if case == "few_obs" else rng.randint(20, 900)
    u = tr.user(0, "click", app.button())
    X = tr.fetch(2, method, url, sig, body=app.body() if method != "GET" else "", cause=u)
    tr.finish(X, 2 + _u(rng, 60, 800), 200)
    if case == "missing_write":
        k = n if rng.random() < 0.7 else n - 1
        usual, now_w = f"{a} and {b}", f"only {a}"
        tr.write(X.end + 1, a, X, "updated")
        seen = "never" if k == n else "once"
        label_a = ({"resync": 0.55, "ignore": 0.35, "rollback": 0.1} if has_resync else {"ignore": 0.75, "rollback": 0.25})
        diag = "unusual"
    elif case == "null_write":
        k = n
        usual, now_w = f"{a} as a non-empty array", f"{a} = null"
        tr.write(X.end + 1, a, X, "null")
        seen = "never"
        label_a = ({"resync": 0.5, "rollback": 0.3, "ignore": 0.2} if has_resync else {"rollback": 0.55, "ignore": 0.45})
        diag = "unusual"
    elif case == "common_variant":
        k = int(n * _u(rng, 0.4, 0.75))
        usual, now_w = f"{a} and {b}", f"only {a}"
        tr.write(X.end + 1, a, X, "updated")
        seen = f"{n - k} times"
        label_a, diag = "ignore", "expected"
    elif case == "few_obs":
        k = n
        usual, now_w = f"{a} and {b}", f"only {a}"
        tr.write(X.end + 1, a, X, "updated")
        seen = "never"
        label_a, diag = "ignore", "expected"
    else:  # empty_after_filter
        k = n - rng.randint(0, 2)
        usual, now_w = f"{a} as a non-empty list", f"{a} = [] (empty)"
        target = app.input_target()
        uf = tr.user(-_u(rng, 300, 3000), "input", target, app.word() + " " + app.word() + " xyz")
        X.cause, X.root = uf.id, uf.id
        tr.write(X.end + 1, a, X, "[] (empty)")
        seen = f"{n - k} times"
        label_a, diag = "ignore", "expected"
    tr.now = X.end + rng.choice((60, 70, 120, 300))
    add_noise_ops(rng, app, tr, -5000, X.start - 1)
    cap_now(tr)
    facts = [pick(rng, "trans_shape", test, n=n, sig=sig, usual=usual, now=now_w, k=k, seen=seen)]
    if case == "empty_after_filter":
        facts.append(pick(rng, "inputs_moved", test, path=f"{store}.filter", before='""',
                          after=f'"{tr.ops[X.root].value}"', op=st.op(X.id), who=f"user input on {tr.ops[X.root].target}",
                          ago=st.ago(tr.now - tr.ops[X.root].start)))
    if has_resync:
        facts.append(pick_from(rng, [f"{store} has a resync handler.", f"Resync is available for {store}."], test))
    actions = ["ignore", "rollback"] + (["resync"] if has_resync else [])
    novel = (n >= 20) and ((n - k) / n < 0.01) and case != "empty_after_filter"
    prims = [("tr_novel",) + P.noul(pick_from(rng, [
        "Is this transition shape novel (seen in under 1% of at least 20 previous completions)?",
        f"Has {sig} essentially never produced this shape before, with enough history to tell?",
        "Is there strong evidence that this completion is out of the ordinary?"], test), novel),
             ("tr_hist",) + P.score(pick_from(rng, [f"How much history is there for {sig}?",
                                                    f"Number of previous completions of {sig}?"], test),
                                    ["fewer than 20", "20 to 100", "more than 100"], 0 if n < 20 else 1 if n <= 100 else 2)]
    prims += P.temporal(rng, tr, st)
    subject = pick_from(rng, [f"{X.req} ({st.op(X.id)}) completed with a transition unlike its usual ones.",
                              f"Unusual state transition after {X.req}.", f"{st.op(X.id)} {X.req} changed the state in a new way.",
                              f"Transition check for {X.req}."], test)
    from rt import signature as _sig
    rsig = _sig(method, url)
    if case == "null_write":
        utext = (f"In the previous {n} completions of {rsig} that wrote {a}, it wrote an array ({k} of {n} times); "
                 f"this time it wrote null.")
    elif case == "empty_after_filter":
        utext = (f"In the previous {n} completions of {rsig} that wrote {a}, it wrote an array ({k} of {n} times); "
                 f"this time it wrote an empty array.")
    else:
        seen_txt = "" if seen == "never" else f" (seen {seen.replace(' times', ' times') if seen != 'once' else 'once'} before)"
        utext = (f"In the previous {n} completions of {rsig} its chain wrote {a} and {b} ({k} of {n} times); "
                 f"this time it wrote only {a}{seen_txt}.")
    spec = {"op": X, "unusual_text": utext, "chain_fields": [a], "lc_age": _u(rng, 500, 30000)}
    return Scen("transition", f"transition/{case}", subject, X.req, facts, actions, label_a, diag,
                stats_sigs=[sig], prims=prims, trace=tr, spec=spec)


ERR_MSGS = [
    ("TypeError", "Cannot read properties of null (reading 'map')"),
    ("TypeError", "Cannot read properties of undefined (reading 'length')"),
    ("TypeError", "{f} is not iterable"),
    ("TypeError", "Cannot read properties of null (reading 'forEach')"),
    ("TypeError", "undefined is not an object (evaluating '{f}.map')"),
]


def error(rng: random.Random, app: App, st: Style) -> Scen:
    case = rng.choices(("bad_write", "third_party", "resize_observer", "unhandled_fetch", "chunk_load"),
                       (0.34, 0.2, 0.14, 0.18, 0.14))[0]
    tr = Trace(rng)
    test = st.test
    comp = app.ident(app.noun).capitalize() + rng.choice(COMPONENTS)
    file = app.url_word(app.noun) + rng.choice(FILE_EXT)
    line = f"{file}:{rng.randint(5, 400)}:{rng.randint(2, 60)}"
    store = rng.choice((app.coll, "list", "feed", app.item))
    F = f"{store}.{rng.choice(('items', 'rows', 'entries', 'data'))}"
    facts: list[str] = []
    actions = ["ignore"]
    url = app.coll_url()
    sig = f"GET {url}"
    u = tr.user(0, rng.choice(("click", "nav")), app.button())
    X = tr.fetch(2, "GET", url, sig, cause=u)
    tr.finish(X, 2 + _u(rng, 60, 600), 200)
    if case == "bad_write":
        name, msg = rng.choice(ERR_MSGS)
        msg = msg.format(f=F.split(".")[-1])
        tr.write(X.end + 1, F, X, "null")
        t_err = X.end + _u(rng, 2, 40)
        tr.extra(t_err, "error", f"{name}: {msg} at {comp} ({line})")
        tr.now = t_err + 1
        n = rng.randint(20, 900)
        facts.append(pick_from(rng, [f"It was thrown {st.dur(t_err - X.end - 1)} after {F} was set to null by {X.req} ({st.op(X.id)}).",
                                     f"Right before the error, {st.op(X.id)} wrote {F} = null.",
                                     f"{F} became null {st.dur(t_err - X.end - 1)} earlier (written by {st.op(X.id)})."], test))
        facts.append(pick_from(rng, [f"{F} was a non-empty array in {n} of {n} previous writes.",
                                     f"Every previous write of {F} ({n}) was an array.",
                                     f"Learned type of {F}: array (held {n} times)."], test))
        facts.append(pick(rng, "inv_consistent_age", test, store=store, age=st.dur(_u(rng, 300, 9000))))
        actions.append("rollback")
        label_a, diag = {"rollback": 0.7, "ignore": 0.3}, {"unusual": 0.6, "inconsistent": 0.4}
        err_line = f"Uncaught {name}: {msg} at {comp} ({line})"
    elif case == "third_party":
        src = rng.choice(THIRD_PARTY)
        name, msg = rng.choice((("TypeError", "Cannot read properties of undefined (reading 'push')"),
                                ("ReferenceError", "dataLayer is not defined"), ("Error", "Script error.")))
        tr.now = X.end + _u(rng, 100, 5000)
        tr.extra(tr.now - 1, "error", f"{name}: {msg} ({src})")
        facts.append(pick_from(rng, [f"The error comes from {src}, not from the app's own code.",
                                     f"Source of the error: {src} (third-party script).",
                                     f"Stack points only into {src}."], test))
        facts.append(pick_from(rng, ["No app state was written in the last 2 s.",
                                     "The app's stores did not change around the error.",
                                     "No store write precedes the error."], test))
        label_a, diag = "ignore", "expected"
        err_line = f"Uncaught {name}: {msg} ({src})"
    elif case == "resize_observer":
        tr.now = X.end + _u(rng, 100, 5000)
        msg = "ResizeObserver loop completed with undelivered notifications."
        tr.extra(tr.now - 1, "error", msg)
        facts.append(pick_from(rng, ["This browser warning is raised by layout observers and is harmless.",
                                     "No stack frames point into app code.", "The error has no stack and no state change."],
                               test))
        label_a, diag = "ignore", "expected"
        err_line = f"Uncaught Error: {msg}"
    elif case == "unhandled_fetch":
        ypath = app.api + rng.choice(("/recommendations", "/suggestions", "/related", "/ads"))
        Y = tr.fetch(X.end + 5, "GET", ypath, f"GET {ypath}", cause=u)
        tr.finish(Y, Y.start + _u(rng, 10, 3000), None, err="network error")
        tr.now = Y.end + 2
        tr.extra(Y.end + 1, "error", f"Unhandled rejection: TypeError: Failed to fetch ({Y.req})")
        facts.append(pick_from(rng, [f"The rejection comes from {Y.req} ({st.op(Y.id)}), which failed with a network error.",
                                     f"{st.op(Y.id)} {Y.req} failed and nothing caught the promise.",
                                     f"Unhandled: the failed {Y.req} had no catch handler."], test))
        facts.append(pick_from(rng, [f"{Y.req} wrote no state.", "No store was modified by the failing request.",
                                     "The failed request did not touch any store."], test))
        label_a, diag = "ignore", {"transient": 0.6, "failing": 0.4}
        err_line = f"Unhandled rejection: TypeError: Failed to fetch"
    else:  # chunk_load
        tr.now = X.end + _u(rng, 100, 4000)
        chunk = f"/assets/{app.url_word(app.noun)}-{rng.randint(1000, 9999)}.js"
        tr.extra(tr.now - 1, "error", f"ChunkLoadError: Loading chunk failed ({chunk})")
        facts.append(pick_from(rng, [f"The lazy-loaded chunk {chunk} failed to load (network).",
                                     f"Dynamic import of {chunk} failed.", f"Code chunk {chunk} could not be fetched."], test))
        facts.append(pick_from(rng, ["No app state was written around the error.", "No store changed."], test))
        label_a, diag = "ignore", {"transient": 0.6, "failing": 0.4}
        err_line = f"Uncaught ChunkLoadError: Loading chunk failed ({chunk})"
    add_noise_ops(rng, app, tr, -6000, -5)
    cap_now(tr)
    facts.insert(0, pick_from(rng, [f"Uncaught error: {err_line}.", f"Error: {err_line}.", f"{err_line}"], test))
    prims = [("e_appcode",) + P.noul(pick_from(rng, ["Did the error originate in the app's own code?",
                                                     "Is the app's own code the source of this error?",
                                                     "Is this error thrown by first-party code?"], test),
                                     case in ("bad_write",)),
             ("e_state",) + P.noul(pick_from(rng, ["Did a state write happen just before the error?",
                                                   "Was a store written right before the error?",
                                                   "Is the error preceded by a state change?"], test), case == "bad_write")]
    if case == "bad_write":
        prims.append(("e_comp",) + P.choice(pick_from(rng, ["Which component threw?", "Where was the error thrown?",
                                                            "Name the failing component."], test),
                                            {comp: None, app.ident(app.noun2).capitalize() + rng.choice(COMPONENTS): None,
                                             "App": None}, comp))
    prims += P.temporal(rng, tr, st)
    subject = pick_from(rng, [f"Uncaught error: {err_line}", f"An exception reached the window: {err_line}",
                              f"Error event: {err_line}"], test)
    if case == "bad_write":
        espec = {"name": name, "message": msg, "source": f"{comp} ({line})", "op": X, "lc_age": _u(rng, 300, 9000),
                 "state_paths": [F]}
    elif case == "third_party":
        espec = {"name": name, "message": msg, "source": src, "op": None}
    elif case == "resize_observer":
        espec = {"name": "Error", "message": "ResizeObserver loop completed with undelivered notifications.", "op": None}
    elif case == "unhandled_fetch":
        espec = {"name": "TypeError", "message": "Failed to fetch", "source": "unhandledrejection", "op": Y}
    else:
        espec = {"name": "ChunkLoadError", "message": f"Loading chunk failed ({chunk})", "op": None}
    return Scen("error", f"error/{case}", subject, "the error", facts, actions, label_a, diag,
                state_paths=[F] if case == "bad_write" else [], prims=prims, trace=tr, spec=espec)
