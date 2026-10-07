"""Request / failure / stall scenarios (network side of CONTRACT §6)."""

from __future__ import annotations

import random

import prims as P
from app import App, rand_token
from fmt import Style, pick, pick_from
from scenarios import Scen, _u, add_noise_ops, cap_now
from world import Op, Trace, status_phrase


def _outcome_codes(rng: random.Random, outcomes: list[bool], fail_pool: tuple) -> list[str]:
    return ["200" if ok else rng.choice(fail_pool) for ok in outcomes]


def _rate(st: Style, per_min: float) -> str:
    if per_min >= 1:
        return f"{per_min:.0f} per minute" if per_min < 60 else f"{per_min / 60:.1f} per second"
    return f"1 per {60 / per_min:.0f} s"


# ================================================================================================ request


def request(rng: random.Random, app: App, st: Style) -> Scen:
    case = rng.choices(("normal", "double_submit", "same_root_get", "separate_intent", "deliberate_repeat",
                        "retry_storm", "failing_backoff", "outage_cached", "polling_ok", "typing_burst", "runaway"),
                       (0.17, 0.13, 0.07, 0.1, 0.08, 0.08, 0.1, 0.06, 0.09, 0.07, 0.05))[0]
    tr = Trace(rng)
    test = st.test
    id_ = app.new_id()
    actions = ["send", "delay", "block"]
    cached = False
    facts: list[str] = []
    now_ms = 0.0
    if case in ("double_submit", "separate_intent", "deliberate_repeat"):
        method = "POST"
        url = app.coll_url(rng.choice(app.dom.nouns))
        sig = f"POST {url}"
        body = app.body()
        btn = app.button()
        med = _u(rng, 150, 900)
        tr.baseline(sig, med, med * _u(rng, 2, 4), rng.choice((0.0, 0.01, 0.02)), rng.randint(10, 300))
        u1 = tr.user(0, "click", btn)
        A = tr.fetch(_u(rng, 1, 20), method, url, sig, body=body, cause=u1)
        if case == "double_submit":
            if rng.random() < 0.5:  # one click handler fired twice
                X = tr.fetch(A.start + _u(rng, 1, 40), method, url, sig, body=body, cause=u1)
                same = "the same click"
            else:
                u2 = tr.user(A.start + _u(rng, 60, 330), rng.choice(("click", "dblclick")), btn)
                X = tr.fetch(u2.start + _u(rng, 1, 15), method, url, sig, body=body, cause=u2)
                same = f"a second click {st.dur(u2.start - u1.start)} after the first"
            tr.now = X.start
            label_a, diag = "coalesce", "duplicate"
        elif case == "separate_intent":  # earlier identical request completed long ago
            e = A.start + _u(rng, 0.6, 1.5) * med
            tr.finish(A, e, rng.choice((200, 201)))
            u2 = tr.user(e + _u(rng, 2500, 30000), "click", btn)
            X = tr.fetch(u2.start + _u(rng, 1, 15), method, url, sig, body=body, cause=u2)
            tr.now = X.start
            same = f"a separate click {st.dur(u2.start - u1.start)} later"
            label_a, diag = "send", "expected"
        else:  # deliberate_repeat: second click > 1 s later while the first is still in flight
            u2 = tr.user(A.start + _u(rng, 1100, 2400), "click", btn)
            X = tr.fetch(u2.start + _u(rng, 1, 15), method, url, sig, body=body, cause=u2)
            A.end = None
            if A.start + med * 4 < X.start:  # make sure A is plausibly still running
                tr.baseline(sig, (X.start - A.start) / 1.5, (X.start - A.start) * 2, 0.01, 50)
            tr.now = X.start
            same = f"a separate click {st.dur(u2.start - u1.start)} earlier"
            label_a, diag = "send", "expected"
        cap_now(tr)
        prev_state = "still in flight" if A.end is None else f"finished ({A.code}, {st.ago(tr.now - A.end)})"
        if A.end is None or tr.now - A.end < 2000:
            actions.insert(1, "coalesce")
        facts.append(pick(rng, "prov_req", test, req=X.req, root=tr.root_desc(X), ago=st.ago(tr.now - tr.root_of(X).start)))
        facts.append(pick(rng, "rep_identical_req", test, req=X.req, ago=st.ago(tr.now - A.start), same=same,
                          state=prev_state, prev=st.op(A.id)))
        mk = lambda: P.identity(rng, tr, st, X) + P.causal(rng, tr, st)
    elif case == "same_root_get":
        url = app.coll_url()
        sig = f"GET {url}"
        med = _u(rng, 60, 400)
        tr.baseline(sig, med, med * _u(rng, 2, 4), 0.005, rng.randint(50, 900))
        nav = tr.user(0, "nav", app.route())
        A = tr.fetch(_u(rng, 5, 40), "GET", url, sig, cause=nav)
        X = tr.fetch(A.start + _u(rng, 1, 60), "GET", url, sig, cause=nav)
        tr.now = X.start
        actions.insert(1, "coalesce")
        facts.append(pick(rng, "prov_req", test, req=X.req, root=tr.root_desc(X), ago=st.ago(tr.now - nav.start)))
        facts.append(pick(rng, "rep_identical_req", test, req=X.req, ago=st.ago(tr.now - A.start),
                          same="the same navigation (another component)", state="still in flight", prev=st.op(A.id)))
        label_a, diag = "coalesce", "duplicate"
        mk = lambda: P.identity(rng, tr, st, X) + P.temporal(rng, tr, st)
    elif case in ("retry_storm", "failing_backoff", "outage_cached", "runaway"):
        if case == "runaway":
            url = app.api + rng.choice(("/telemetry", "/events", "/log", "/metrics", "/track"))
            method = "POST"
        else:
            url = app.coll_url() if rng.random() < 0.6 else app.item_url(id_)[0]
            method = "GET" if case == "outage_cached" else rng.choice(("GET", "POST", "PUT"))
        sig = f"{method} {url}"
        med = _u(rng, 60, 500)
        usual_per_min = rng.choice((0.5, 1, 2, 4, 6))
        tr.baseline(sig, med, med * 3, 0.01, rng.randint(40, 900))
        t = 0.0
        if case == "retry_storm":
            n = rng.randint(18, 60)
            win = 10_000
            gaps = win / n
            outcomes = []
            prev = None
            for k in range(n):
                o = tr.fetch(t, method, url, sig, cause=prev, attempt=k + 1)
                ok = rng.random() < 0.15
                tr.finish(o, t + _u(rng, 10, 80), 200 if ok else rng.choice((503, 502, 500)))
                outcomes.append(ok)
                prev = o
                t += gaps * _u(rng, 0.6, 1.4)
            X = tr.fetch(t, method, url, sig, cause=prev, attempt=n + 1)
            tr.now = t
            facts.append(pick(rng, "rep_count", test, sig=sig, n=n, win="10 s", usual=_rate(st, usual_per_min)))
            facts.append(pick(rng, "streak", test, sig=sig, n=_streak(outcomes), codes=", ".join(_codes(tr, sig)[-5:]),
                              ago=_last_ok(st, tr, sig)))
            label_a, diag = "delay", "overload"
        elif case == "runaway":
            n = rng.randint(80, 600)
            X = tr.fetch(0, method, url, sig, body='{"type":"render"}')
            tr.now = 0
            facts.append(pick(rng, "rep_count", test, sig=sig, n=n, win="10 s", usual=_rate(st, usual_per_min)))
            facts.append(pick(rng, "streak_none", test, sig=sig, n=min(n, 50), rate="0.0%"))
            label_a, diag = {"delay": 0.6, "block": 0.3, "send": 0.1}, "overload"
            outcomes = [True] * 5
        else:
            k = rng.randint(4, 9) if case == "failing_backoff" else rng.randint(5, 12)
            outcomes = [True] * rng.randint(0, 3) + [False] * k
            prev = None
            for ok in outcomes:
                o = tr.fetch(t, method, url, sig, cause=prev)
                if ok:
                    tr.finish(o, t + med * _u(rng, 0.5, 1.5), 200)
                else:
                    c = rng.choice((503, 502, 504, None))
                    tr.finish(o, t + (_u(rng, 5000, 10000) if c is None else _u(rng, 20, 400)), c,
                              err="timeout" if c is None else "")
                prev = o
                t = o.end + _u(rng, 800, 4000)
            X = tr.fetch(t, method, url, sig, cause=prev)
            tr.now = t
            facts.append(pick(rng, "streak", test, sig=sig, n=_streak(outcomes), codes=", ".join(_codes(tr, sig)[-5:]),
                              ago=_last_ok(st, tr, sig)))
            if case == "outage_cached":
                cached = True
                facts.append(pick(rng, "cached", test, sig=sig, ago=st.ago(_u(rng, 20e3, 300e3)),
                                  size=f"{_u(rng, 0.4, 90):.1f} KB"))
                label_a, diag = {"serve_cached": 0.55, "delay": 0.35, "send": 0.1}, "failing"
            else:
                label_a, diag = "delay", "failing"
        mk = lambda: P.streak_q(rng, st, sig, outcomes) + P.temporal(rng, tr, st)
    elif case == "polling_ok":
        url = app.coll_url() if rng.random() < 0.5 else app.api + rng.choice(("/status", "/feed", "/inbox", "/jobs"))
        sig = f"GET {url}"
        med = _u(rng, 40, 300)
        period = rng.choice((2000, 3000, 5000, 10000, 15000))
        tr.baseline(sig, med, med * 2.5, rng.choice((0.0, 0.004)), rng.randint(100, 3000))
        t = 0.0
        outcomes = []
        for k in range(rng.randint(2, 5)):
            tm = tr.timer(t, f"poll every {period // 1000} s")
            o = tr.fetch(t + 1, "GET", url, sig, cause=tm)
            ok = rng.random() < 0.9
            tr.finish(o, t + med * _u(rng, 0.5, 1.5), 200 if ok else 503)
            outcomes.append(ok)
            t += period
        outcomes[-1] = True
        tm = tr.timer(t, f"poll every {period // 1000} s")
        X = tr.fetch(t + 1, "GET", url, sig, cause=tm)
        tr.now = X.start
        facts.append(pick(rng, "prov_req", test, req=X.req, root=tr.root_desc(X), ago=st.ago(1)))
        facts.append(pick(rng, "rep_count", test, sig=sig, n=len(outcomes) + 1, win=f"{(t + period) / 1000:.0f} s",
                          usual=_rate(st, 60000 / period)))
        label_a, diag = "send", "expected"
        mk = lambda: P.streak_q(rng, st, sig, outcomes) + P.temporal(rng, tr, st)
    elif case == "typing_burst":
        url = app.api + "/search" if rng.random() < 0.5 else app.coll_url()
        sig = f"GET {url}"
        med = _u(rng, 60, 300)
        tr.baseline(sig, med, med * 3, 0.005, rng.randint(100, 2000))
        target = app.input_target()
        t = 0.0
        prevs = app.query_prefixes()
        for p in prevs[:-1]:
            u = tr.user(t, "input", target, p)
            o = tr.fetch(t + _u(rng, 1, 200), "GET", f"{url}?q={p}", sig, cause=u)
            tr.finish(o, o.start + med * _u(rng, 0.5, 1.5))
            t += _u(rng, 150, 450)
        u = tr.user(t, "input", target, prevs[-1])
        X = tr.fetch(t + _u(rng, 1, 200), "GET", f"{url}?q={prevs[-1]}", sig, cause=u)
        tr.now = X.start
        cap_now(tr)
        n = len(prevs)
        facts.append(pick(rng, "prov_req", test, req=X.req, root=tr.root_desc(X), ago=st.ago(tr.now - u.start)))
        facts.append(pick(rng, "rep_count", test, sig=sig, n=n, win=f"{max(1, tr.now / 1000):.0f} s",
                          usual=rng.choice(("12 per minute while typing", "frequent during searches",
                                            f"{rng.randint(20, 60)} per minute"))))
        label_a, diag = "send", "expected"
        mk = lambda: P.identity(rng, tr, st, X) + P.temporal(rng, tr, st) + P.causal(rng, tr, st)
    else:  # normal
        method = rng.choice(("GET", "GET", "POST", "PUT", "DELETE", "PATCH"))
        url = app.coll_url() if method in ("GET", "POST") else app.item_url(id_)[0]
        sig = f"{method} {url if method in ('GET', 'POST') else app.item_url(id_)[1]}"
        med = _u(rng, 60, 600)
        tr.baseline(sig, med, med * _u(rng, 2, 4), rng.choice((0.0, 0.003, 0.01)), rng.randint(5, 900))
        u = tr.user(0, rng.choice(("click", "submit", "keydown")), app.button())
        X = tr.fetch(_u(rng, 1, 30), method, url, sig, body=app.body() if method in ("POST", "PUT", "PATCH") else "", cause=u)
        tr.now = X.start
        facts.append(pick(rng, "prov_req", test, req=X.req, root=tr.root_desc(X), ago=st.ago(tr.now - u.start)))
        if rng.random() < 0.5:
            facts.append(pick(rng, "streak_none", test, sig=sig, n=rng.randint(3, 40),
                              rate=f"{tr.baselines[sig].err_rate * 100:.1f}%"))
        label_a, diag = "send", "expected"
        mk = lambda: P.identity(rng, tr, st, X) + P.causal(rng, tr, st)
    if cached:
        actions.append("serve_cached")
    spec = {"op": X, "cached": cached, "cached_ago": _u(rng, 15e3, 300e3)}
    if case in ("retry_storm", "failing_backoff", "outage_cached"):
        spec["usual_per_10s"] = usual_per_min / 6
    if case == "runaway":
        spec["usual_per_10s"] = usual_per_min / 6
        spec["recent_count"] = n
    if case == "polling_ok":
        spec["usual_per_10s"] = 10000 / period
    if case == "typing_burst":
        spec["usual_per_10s"] = max(3.0, len(prevs) * _u(rng, 0.5, 1.0))
    add_noise_ops(rng, app, tr, tr.now - 8000, tr.now - 5)
    cap_now(tr)
    prims = mk()
    subject = pick_from(rng, [f"{X.req} ({st.op(X.id)}) is about to be sent.", f"Outgoing request: {X.req}.",
                              f"The app is sending {X.req} ({st.op(X.id)}).", f"{st.op(X.id)} {X.req} is ready to go out."],
                        test)
    return Scen("request", f"request/{case}", subject, X.req, facts, actions, label_a, diag,
                stats_sigs=[X.sig], prims=prims, exclude_inflight=(X.id,), trace=tr, spec=spec)


def _streak(outcomes: list[bool]) -> int:
    n = 0
    for ok in reversed(outcomes):
        if ok:
            break
        n += 1
    return n


def _codes(tr: Trace, sig: str) -> list[str]:
    return [("ok" if o.status == "ok" else (o.err or str(o.code))) for o in tr.requests() if o.sig == sig and o.end is not None]


def _last_ok(st: Style, tr: Trace, sig: str) -> str:
    oks = [o for o in tr.requests() if o.sig == sig and o.status == "ok" and o.end is not None]
    if not oks:
        return pick_from(st.rng, ["more than 5 minutes ago", "not in this session", "over 10 min ago"], False)
    return st.ago(tr.now - oks[-1].end)


# ================================================================================================ failure


def failure(rng: random.Random, app: App, st: Style) -> Scen:
    case = rng.choices(("transient_get", "post_no_key", "post_with_key", "outage_cached", "outage_no_cache",
                        "rate_limited", "offline", "timeout_get", "longpoll_expected", "app_retry_loop"),
                       (0.17, 0.13, 0.07, 0.08, 0.1, 0.1, 0.08, 0.1, 0.09, 0.08))[0]
    tr = Trace(rng)
    test = st.test
    id_ = app.new_id()
    actions = ["deliver", "retry"]
    facts: list[str] = []
    has_key = False
    if case in ("post_no_key", "post_with_key"):
        method = "POST"
        url = app.coll_url(rng.choice(app.dom.nouns))
        sig = f"POST {url}"
        body = app.body()
        if case == "post_with_key":
            has_key = True
            body = '{"idempotencyKey":"' + rand_token(rng, 10) + '",' + body[1:]
    elif case == "longpoll_expected":
        method, url = "GET", app.api + rng.choice(("/events/poll", "/updates?wait=30", "/stream/longpoll"))
        sig, body = f"GET {url}", ""
    else:
        method = "GET"
        url, sp = app.item_url(id_) if rng.random() < 0.5 else (app.coll_url(), app.coll_url())
        sig, body = f"GET {sp}", ""
    med = _u(rng, 60, 600)
    err_rate = rng.choice((0.0, 0.003, 0.01, 0.02))
    if case == "longpoll_expected":
        med, err_rate = 30000.0, rng.choice((0.93, 0.96, 0.98))
    tr.baseline(sig, med, med * _u(rng, 1.01, 1.05) if case == "longpoll_expected" else med * _u(rng, 2, 4), err_rate,
                rng.randint(20, 2000))
    t = 0.0
    outcomes: list[bool] = []
    prev = None
    n_prev = {"outage_cached": rng.randint(3, 8), "outage_no_cache": rng.randint(4, 9),
              "app_retry_loop": rng.randint(2, 4)}.get(case, 0)
    n_ok = rng.randint(1, 6)
    for k in range(n_ok):
        o = tr.fetch(t, method, url, sig, body=body)
        if case == "longpoll_expected":  # a long-poll normally ends with 504 at ~30 s and is re-issued
            tr.finish(o, t + 30000, 504)
            outcomes.append(False)
            t = o.end + _u(rng, 5, 50)
            continue
        tr.finish(o, t + med * _u(rng, 0.5, 1.5), 200)
        outcomes.append(True)
        t = o.end + _u(rng, 500, 20000)
    for k in range(n_prev):
        o = tr.fetch(t, method, url, sig, body=body, cause=prev if case == "app_retry_loop" else None,
                     attempt=k + 1 if case == "app_retry_loop" else 1)
        c = rng.choice((503, 502, 500, 504))
        tr.finish(o, t + _u(rng, 20, 400), c)
        outcomes.append(False)
        prev = o
        t = o.end + _u(rng, 400, 6000)
    u = tr.user(t - 1, rng.choice(("click", "submit", "nav")), app.button()) if case not in ("longpoll_expected",) else None
    X = tr.fetch(t, method, url, sig, body=body, cause=prev if case == "app_retry_loop" else u,
                 attempt=n_prev + 1 if case == "app_retry_loop" else 1)
    if case in ("transient_get", "outage_cached", "outage_no_cache", "app_retry_loop"):
        c = rng.choice((503, 502, 504, 500, None))
        tr.finish(X, t + (_u(rng, 50, 500) if c else _u(rng, 30, 3000)), c, err="" if c else "network error")
    elif case in ("post_no_key", "post_with_key"):
        c = rng.choice((500, 502, 503, None))
        tr.finish(X, t + (_u(rng, 50, 900) if c else _u(rng, 5000, 30000)), c, err="" if c else "timeout")
    elif case == "rate_limited":
        tr.finish(X, t + _u(rng, 10, 200), 429)
    elif case == "offline":
        tr.extra(t - _u(rng, 500, 8000), "offline", "navigator.onLine = false")
        tr.finish(X, t + _u(rng, 1, 30), None, err="network error")
    elif case == "timeout_get":
        tr.finish(X, t + _u(rng, 8000, 30000), None, err="timeout")
    else:  # longpoll
        tr.finish(X, t + 30000, 504)
    outcomes.append(False)
    tr.now = X.end + 1
    add_noise_ops(rng, app, tr, tr.now - 9000, tr.now - 5)
    cap_now(tr)
    what = status_phrase(X, st, long=True)
    facts.append(pick(rng, "failure_now", test, req=X.req, what=what, dur=st.dur(X.end - X.start)))
    streak = _streak(outcomes)
    if streak >= 2:
        facts.append(pick(rng, "streak", test, sig=sig, n=streak, codes=", ".join(_codes(tr, sig)[-5:]),
                          ago=_last_ok(st, tr, sig)))
    else:
        facts.append(pick_from(rng, [f"Before this, {sig} succeeded {n_ok} times in a row (error rate {err_rate * 100:.1f}%).",
                                     f"This is the first failure of {sig} recently; error rate {err_rate * 100:.1f}%.",
                                     f"{sig} was healthy until now ({n_ok} successes, error rate {err_rate * 100:.1f}%)."],
                               test))
    cached = case == "outage_cached" or (case == "offline" and rng.random() < 0.5 and method == "GET")
    if cached:
        actions.append("serve_cached")
        facts.append(pick(rng, "cached", test, sig=sig, ago=st.ago(_u(rng, 15e3, 400e3)), size=f"{_u(rng, 0.3, 120):.1f} KB"))
    high_rate = False
    if case == "rate_limited":
        if rng.random() < 0.5:
            high_rate = True
            facts.append(pick(rng, "rep_count", test, sig=sig, n=rng.randint(25, 200), win="10 s",
                              usual=_rate(st, rng.choice((1, 2, 6)))))
        ra = rng.choice((1, 2, 5, 10, 30, 60, 120))
        facts.append(pick_from(rng, [f"The response says Retry-After: {ra} (seconds).", f"Retry-After header: {ra} s.",
                                     f"Server asked to wait {ra} s before retrying (Retry-After)."], test))
    if case == "post_no_key":
        facts.append(pick_from(rng, [f"{method} {url} is not idempotent and carries no idempotency key.",
                                     "The request body has no idempotency key; the method is POST.",
                                     "Repeating this POST may apply it twice (no idempotency key)."], test))
    if case == "post_with_key":
        facts.append(pick_from(rng, ["The request carries an idempotency key, so the server deduplicates retries.",
                                     "Idempotency-Key is set on this POST.",
                                     "Retries of this POST are deduplicated server-side (idempotency key present)."], test))
    if case == "offline":
        off = [x for x in tr.extras if x.kind == "offline"][0]
        facts.append(pick(rng, "offline", test, ago=st.ago(tr.now - off.t)))
    if case == "longpoll_expected":
        facts.append(pick_from(rng, [f"{sig} is a long-poll: 96% of its calls end with 504 after about 30 s, by design.",
                                     f"Usual outcome of {sig}: a 504 after ~30 s (long-poll timeout), then the app re-polls.",
                                     f"{sig} normally times out at 30 s and is immediately re-issued by the app."], test))
    if case == "app_retry_loop":
        facts.append(pick(rng, "app_retry", test, n=n_prev, a=n_prev + 1, req=X.req))
    # labels
    if case in ("transient_get", "timeout_get", "post_with_key"):
        label_a, diag = "retry", "transient"  # an isolated failure that would succeed if tried again (CONTRACT §11)
    elif case == "outage_cached":
        label_a, diag = {"serve_cached": 0.7, "deliver": 0.2, "retry": 0.1}, "failing"
    elif case == "offline" and cached:
        label_a, diag = {"serve_cached": 0.6, "deliver": 0.4}, "failing"
    elif case == "rate_limited":
        label_a, diag = "deliver", ("overload" if high_rate else "failing")
    elif case == "longpoll_expected":
        label_a, diag = "deliver", "expected"
    elif case == "post_no_key":  # isolated failure (transient), but retrying a non-idempotent POST is unsafe
        label_a, diag = "deliver", "transient"
    else:
        label_a, diag = "deliver", "failing"
    prims = P.failure_q(rng, st, X, has_key) + P.streak_q(rng, st, sig, outcomes) + P.temporal(rng, tr, st)
    subject = pick_from(rng, [f"{X.req} ({st.op(X.id)}) failed with {what} before the app saw it.",
                              f"Failure of {X.req}: {what}.", f"{st.op(X.id)} {X.req} ended in {what}.",
                              f"The request {X.req} just failed ({what})."], test)
    spec = {"op": X, "cached": cached, "cached_ago": _u(rng, 15e3, 300e3), "no_runtime": case == "offline"}
    if case == "rate_limited" and high_rate:
        spec["usual_per_10s"] = rng.choice((1, 2, 6)) / 6
        spec["recent_count"] = rng.randint(25, 200)
    if case == "longpoll_expected":
        spec["err_rate"] = err_rate
    return Scen("failure", f"failure/{case}", subject, X.req, facts, actions, label_a, diag,
                stats_sigs=[sig], prims=prims, exclude_inflight=(X.id,), trace=tr, spec=spec)


# ================================================================================================ stall


def stall(rng: random.Random, app: App, st: Style) -> Scen:
    case = rng.choices(("tail_get", "within_p95", "slow_endpoint_ok", "api_degraded", "slow_upload", "tail_get_cached"),
                       (0.25, 0.22, 0.15, 0.14, 0.12, 0.12))[0]
    tr = Trace(rng)
    test = st.test
    id_ = app.new_id()
    if case == "slow_upload":
        method, url = "POST", app.coll_url(rng.choice(app.dom.nouns)) + rng.choice(("/upload", "/import", "/attachments"))
        sig, body = f"POST {url}", f'(multipart, {_u(rng, 5, 80):.1f} MB)'
    elif case == "slow_endpoint_ok":
        method, url = rng.choice(("GET", "POST")), app.api + rng.choice(("/reports/generate", "/export", "/analytics/run",
                                                                         "/search/deep"))
        sig, body = f"{method} {url}", ""
    else:
        method = "GET"
        url, sp = app.item_url(id_) if rng.random() < 0.5 else (app.coll_url(), app.coll_url())
        sig, body = f"GET {sp}", ""
    if case == "slow_endpoint_ok":
        med = _u(rng, 3000, 9000)
    else:
        med = _u(rng, 60, 600)
    p95 = med * _u(rng, 2, 4)
    tr.baseline(sig, med, p95, rng.choice((0.0, 0.004, 0.01)), rng.randint(30, 3000))
    if case in ("tail_get", "tail_get_cached"):
        el = max(p95 * _u(rng, 3, 10), med * _u(rng, 8, 40))
    elif case == "within_p95":
        el = _u(rng, med * 1.05, p95 * 0.95)
    elif case == "slow_endpoint_ok":
        el = _u(rng, med * 0.9, p95 * 0.95)
    elif case == "api_degraded":
        el = max(p95 * _u(rng, 1.5, 6), med * _u(rng, 4, 20))
    else:
        el = med * _u(rng, 3, 12)
    ua = rng.choice(("click", "nav", "submit"))
    u = tr.user(-el - _u(rng, 1, 30), ua, app.route() if ua == "nav" else app.button())
    X = tr.fetch(-el, method, url, sig, body=body, cause=u)
    tr.now = 0.0
    peers = 0
    if case == "api_degraded":
        peers = rng.randint(1, 3)
        for _ in range(peers):
            pid = app.new_id()
            pu = tr.user(-_u(rng, 4 * med, el), "click", app.button())
            tr.fetch(pu.start + 2, method, f"{url}?page={_ + 2}", sig, cause=pu)
    facts = [pick(rng, "lat_ratio", test, req=X.req, el=st.dur(el), med=st.dur(med), p95=st.dur(p95),
                  ratio=f"{el / med:.1f}")]
    k_tot = rng.randint(4, 20)
    if case == "api_degraded":
        facts.append(pick(rng, "others_slow", test, k=rng.randint(int(0.6 * k_tot) + 1, k_tot), n=k_tot, win="30 s"))
    elif rng.random() < 0.8:
        facts.append(pick(rng, "others_fast", test, k=rng.randint(int(0.9 * k_tot), k_tot), n=k_tot, win="30 s"))
    actions = ["wait"]
    if method == "GET":
        actions.append("hedge")
    cached = case == "tail_get_cached"
    if cached:
        actions.append("serve_cached")
        facts.append(pick(rng, "cached", test, sig=sig, ago=st.ago(_u(rng, 10e3, 300e3)), size=f"{_u(rng, 0.3, 50):.1f} KB"))
    if case == "slow_upload":
        facts.append(pick_from(rng, [f"The request body is large ({body}); uploads scale with size.",
                                     f"This is an upload: {body}.", f"Payload {body}, not replayable cheaply."], test))
    add_noise_ops(rng, app, tr, -el, -5)
    cap_now(tr)
    if case == "tail_get":
        label_a, diag = "hedge", "slow"
    elif case == "tail_get_cached":
        label_a, diag = {"hedge": 0.6, "serve_cached": 0.3, "wait": 0.1}, "slow"
    elif case == "api_degraded":
        label_a, diag = ({"wait": 0.7, "hedge": 0.3} if "hedge" in actions else "wait"), "slow"
    elif case == "slow_upload":
        label_a, diag = "wait", ("slow" if el > p95 else "expected")
    else:
        label_a, diag = "wait", "expected"
    prims = P.latency_q(rng, st, X.req, el, med, p95) + P.temporal(rng, tr, st)
    subject = pick_from(rng, [f"{X.req} ({st.op(X.id)}) has been in flight for {st.dur(el)}.",
                              f"{X.req} is still pending after {st.dur(el)}.",
                              f"Slow request: {st.op(X.id)} {X.req}, {st.dur(el)} so far.",
                              f"{st.op(X.id)} has not answered yet ({st.dur(el)})."], test)
    return Scen("stall", f"stall/{case}", subject, X.req, facts, actions, label_a, diag,
                stats_sigs=[sig], prims=prims, exclude_inflight=(), trace=tr,
                spec={"op": X, "cached": cached, "cached_ago": _u(rng, 10e3, 300e3), "slow_peers": peers})
