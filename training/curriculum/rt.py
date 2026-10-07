"""Runtime-exact rendering: the situation text and standing questions exactly as @genclass/runtime builds them
(packages/runtime/src/situation/{facts,describe,build,serialize,questions}.ts, read 2026-10-07), from a scenario's
Trace and `spec`. The curriculum renders a share of decision rows this way so stage 1 already matches what the
model will read in production; the remaining rows keep the varied styles (robustness).

Facts follow CORE's computations (provenance, versions, inputs moved, concurrency, repetition, outcomes, baselines,
cache, method semantics, invariants, transitions, errors) and its ordering (non-neutral first, then kind rank).
Scenario facts that CORE cannot compute are dropped; scenarios whose label would then be unjustifiable return None.
"""

from __future__ import annotations

import json
import re

from world import Op, Trace

DIAG_INSTR = "What is happening here?"
DIAGNOSES = {
    "expected": "normal behaviour, nothing is wrong",
    "stale": "outdated data or an older operation is about to replace newer state",
    "conflict": "concurrent operations are competing over the same state or resource",
    "duplicate": "the same change or request is happening again without a new intent",
    "inconsistent": "the state contradicts itself or relationships it normally keeps",
    "failing": "an operation keeps failing or its failures follow a pattern",
    "slow": "an operation is far slower than usual",
    "overload": "work is being triggered far more often than usual",
    "unusual": "this differs from how the same operation normally behaves",
}
ACTIONS = {
    "apply": "let this write update the state now", "discard": "drop this write and keep the current state",
    "defer": "hold this write until the related in-flight operations finish, then decide again",
    "send": "send the request now",
    "coalesce": "do not send; reuse the result of the identical request that is in flight or just finished",
    "delay": "wait before sending, backing off so the service can recover",
    "block": "do not send; fail this request immediately",
    "serve_cached": "answer with the last successful response for this request instead",
    "deliver": "pass the failure to the application as it is", "retry": "retry the request after a short backoff",
    "wait": "keep waiting for the request", "hedge": "send a second identical request and use whichever answers first",
    "ignore": "leave the state as it is", "rollback": "restore the affected state to its last consistent snapshot",
    "resync": "reload the affected state from its source",
}
TRIGGER_ACTIONS = {"mutation": ["apply", "discard", "defer"], "request": ["send", "coalesce", "delay", "block", "serve_cached"],
                   "failure": ["deliver", "retry", "serve_cached"], "stall": ["wait", "hedge", "serve_cached"],
                   "inconsistency": ["ignore", "rollback", "resync"], "transition": ["ignore", "rollback", "resync"],
                   "error": ["ignore", "rollback"]}
ACTION_INSTR = {
    "mutation": "What should the runtime do with this write?", "request": "What should the runtime do with this request?",
    "failure": "What should the runtime do with this failed request?",
    "stall": "What should the runtime do with this slow request?",
    "inconsistency": "What should the runtime do about this inconsistent state?",
    "transition": "What should the runtime do about this unusual state change?",
    "error": "What should the runtime do about this error?",
}
RANK = {"invariant": 0, "transition": 0, "error": 0, "versions": 1, "repetition": 2, "inputs": 3, "outcome": 4,
        "baseline": 5, "concurrency": 6, "provenance": 7, "request": 8, "cache": 9, "delta": 10, "plugin": 11}
LIMITS = {"facts": 12, "in_flight": 6, "timeline": 16, "state": 8, "stats": 4}
LINE = {"app": 120, "trigger": 240, "facts": 260, "in_flight": 120, "timeline": 140, "state": 150, "stats": 140}
STATE_CHAR_BUDGET = 3200
WINDOW = 10_000


# ------------------------------------------------------------------------------------------------ util.ts ports

def truncate(s: str, n: int) -> str:
    return s if len(s) <= n else s[: max(0, n - 1)] + "…"


def secs(ms: float) -> str:
    s = max(0.0, ms) / 1000
    return f"{s:.2f}s" if s < 10 else f"{s:.1f}s" if s < 1000 else f"{round(s)}s"


def rel(ms: float) -> str:
    s = abs(ms) / 1000
    txt = f"{s:.2f}" if s < 10 else f"{s:.1f}"
    return f"{'-' if ms <= 0 else '+'}{txt}s"


def fmt_num(n: float) -> str:
    if float(n).is_integer():
        return str(int(n))
    a = abs(n)
    d = 1 if a >= 100 else 2 if a >= 1 else 4
    x = float(f"{n:.{d}f}")
    return str(int(x)) if x.is_integer() else repr(x)


def ratio(a: float, b: float) -> str:
    if b <= 0:
        return "∞"
    r = a / b
    return f"{round(r)}×" if r >= 10 else f"{r:.1f}×"


def plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def ordinal(n: int) -> str:
    v = n % 100
    suf = "th" if 11 <= v <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suf}"


def times(n: int) -> str:
    return "once" if n == 1 else "twice" if n == 2 else f"{n} times"


_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_HEX = re.compile(r"^(?=[0-9a-f]*\d)[0-9a-f]{8,}$", re.I)
_TOK = re.compile(r"^(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,}$")


def is_id(seg: str) -> bool:
    return bool(seg) and (seg.isdigit() or bool(_UUID.match(seg)) or bool(_HEX.match(seg)) or bool(_TOK.match(seg)))


def signature(method: str, url: str) -> str:
    path = url.split("?", 1)[0]
    return f"{method.upper()} " + "/".join(":id" if is_id(s) else s for s in path.split("/"))


# ------------------------------------------------------------------------------------------------ describe.ts

def user_phrase(op: Op) -> str:
    t = op.target
    v = json.dumps(op.value) if op.value else ""
    a = op.action
    if a in ("click", "dblclick", "drop"):
        return f"user clicked {t or 'the page'}"
    if a == "input":
        return f"user typed {v or 'text'}{f' into {t}' if t else ''}"
    if a == "change":
        return f"user changed {t or 'a field'}{f' to {v}' if v else ''}"
    if a == "submit":
        return f"user submitted {t or 'a form'}"
    if a == "keydown":
        return f"user pressed Enter{f' in {t}' if t else ''}"
    if a == "nav":
        return f"user navigated to {t or 'a page'}"
    return f"user {a}{f' {t}' if t else ''}{f' {v}' if v else ''}"


def detail(op: Op) -> str:
    q = "?" + op.url.split("?", 1)[1] if "?" in op.url else ""
    body = f" {truncate(op.body, 40)}" if op.body and op.method not in ("GET", "HEAD") else ""
    return q + body


def phrase(op: Op) -> str:
    if op.kind == "user":
        return user_phrase(op)
    if op.kind == "fetch":
        return f"{signature(op.method, op.url)}{detail(op)}"
    if op.kind == "timer":
        return f"timer {op.target}"
    if op.kind == "ws":
        return f"WS message {op.target}"
    return f"{op.kind} {op.target}".strip()


def label(op: Op | None) -> str:
    return "an earlier operation" if op is None else f"{truncate(phrase(op), 90)} (#{op.id})"


def status_text(op: Op) -> str:
    if op.status == "aborted":
        return "aborted"
    if op.code is not None:
        return str(op.code)
    if op.err == "timeout":
        return "timed out"
    if op.err:
        return "network error"
    return op.status or "pending"


def ancestors(tr: Trace, op: Op) -> list[Op]:
    out, seen = [], set()
    c = op.cause
    while c is not None and c in tr.ops and c not in seen:
        seen.add(c)
        out.append(tr.ops[c])
        c = tr.ops[c].cause
    return out


def is_anc_or_self(tr: Trace, a: Op, b: Op) -> bool:
    """a is an ancestor of b, or a is b."""
    return a.id == b.id or any(x.id == a.id for x in ancestors(tr, b))


def same_chain(tr: Trace, a: Op, writer: int | None) -> bool:
    if writer is None or writer not in tr.ops:
        return False
    w = tr.ops[writer]
    return is_anc_or_self(tr, a, w) or is_anc_or_self(tr, w, a)


def user_of(tr: Trace, op: Op) -> Op | None:
    chain = [op] + ancestors(tr, op)
    for o in chain:
        if o.kind == "user":
            return o
    return None


def started_rel(w: Op, ref: Op) -> str:
    d = w.start - ref.start
    if abs(d) < 0.5:
        return "which started at the same time as it"
    return f"which started {secs(abs(d))} {'after' if d > 0 else 'before'} it"


def user_relation(tr: Trace, ref: Op, w: Op) -> str:
    uw, ur = user_of(tr, w), user_of(tr, ref)
    if not uw:
        return ""
    if ur and uw.id == ur.id:
        return f", from the same user action (#{uw.id})"
    if uw.start > ref.start or (ur and uw.start > ur.start):
        return f", from a later user action (#{uw.id})"
    return f", from an earlier user action (#{uw.id})"


def value_before(tr: Trace, path: str, t: float) -> str:
    prev = [w for w in tr.writes if w.path == path and w.t < t]
    return prev[-1].summary if prev else tr.values0.get(path, "undefined")


# ------------------------------------------------------------------------------------------------ facts

def F(text: str, kind: str, neutral: bool) -> tuple[str, str, bool]:
    return (text, kind, neutral)


def order(fs: list) -> list[str]:
    idx = sorted(range(len(fs)), key=lambda i: (int(fs[i][2]), RANK[fs[i][1]], i))
    return [fs[i][0] for i in idx]


def provenance(tr: Trace, what: str, op: Op | None) -> tuple:
    now = tr.now
    if op is None:
        return F(f"{what} has no known cause: no operation was active when it started.", "provenance", True)
    p = f"{what} comes from {label(op)}, which started {secs(now - op.start)} ago"
    if op.kind != "user" and op.end is not None and op.end <= now and op.end != op.start:
        p += f" and ended {secs(now - op.end)} ago ({status_text(op)})"
    root = tr.root_of(op)
    if root.id != op.id:
        p += f"; its chain began with {label(root)} {secs(now - root.start)} ago"
    return F(p + ".", "provenance", True)


def mutation_facts(tr: Trace, spec: dict) -> list:
    now = tr.now
    C: Op | None = spec.get("cause")
    paths: list[str] = spec["paths"]
    out = [provenance(tr, "This write", C)]
    if C is not None:
        ref = f"this write's cause (#{C.id})"
        for path in paths[:3]:
            v0, vn = tr.version(path, C.start), tr.version(path)
            since = tr.writes_between(path, C.start)
            others = [w for w in since if not same_chain(tr, C, w.op)]
            if others:
                last = others[-1]
                w = tr.ops.get(last.op)
                wt = (f"{label(w)}, {started_rel(w, C)}{user_relation(tr, C, w)}" if w is not None else "a user action")
                out.append(F(f"{path} was written {times(len(others))} by other operations since {ref} started (version "
                             f"{v0} → {vn}), last {secs(now - last.t)} ago by {wt}.", "versions", False))
            elif since:
                out.append(F(f"{path} was written {times(len(since))} by this write's own chain since {ref} started "
                             f"(version {v0} → {vn}).", "versions", True))
            else:
                out.append(F(f"{path} has not changed since {ref} started (version {vn}).", "versions", True))
        store = spec.get("store") or paths[0].split(".")[0]
        moved: dict[str, list] = {}
        for w in tr.writes:
            if w.t > C.start and w.t <= now and w.path not in paths and not same_chain(tr, C, w.op):
                moved.setdefault(w.path, []).append(w)

        def key(item):
            p, hs = item
            same = p.split(".")[0] == store
            user = any(tr.ops.get(h.op) is not None and tr.ops[h.op].kind == "user" for h in hs)
            return (-int(same), -int(user), -hs[-1].t)

        for p, hs in sorted(moved.items(), key=key)[:2]:
            first, last = hs[0], hs[-1]
            w = tr.ops.get(last.op)
            by = f"{label(w)} {secs(max(0.0, last.t - C.start))} after it started" if w else "an untracked writer"
            out.append(F(f"{p} changed since {ref} started: {value_before(tr, p, first.t)} → {tr.value(p)}, last by {by}"
                         f"{f' ({len(hs)} writes)' if len(hs) > 1 else ''}.", "inputs", p.split(".")[0] != store))
        chain = {C.id} | {a.id for a in ancestors(tr, C)}
        others = [o for o in tr.in_flight() if o.id not in chain and not is_anc_or_self(tr, C, o)]
        same = [o for o in others if o.kind == C.kind and o.sig == C.sig]
        if same:
            newer = [o for o in same if o.start > C.start]
            items = "; ".join(f"#{o.id} {truncate(detail(o), 30)} {started_rel(o, C).replace('which ', '')}".replace("  ", " ")
                              for o in same[:3])
            cname = signature(C.method, C.url) if C.kind == "fetch" else C.sig
            out.append(F(f"{plural(len(same), f'other {cname} operation')} "
                         f"{'is' if len(same) == 1 else 'are'} in flight ({len(newer)} newer than {ref}): {items}.",
                         "concurrency", len(newer) == 0))
        if C.kind == "fetch" and C.end is not None:
            lat = C.end - C.start
            b = tr.baselines.get(C.sig)
            if b:
                slow = lat > 3 * b.med and lat - b.med >= 100
                out.append(F(f"{ref[0].upper() + ref[1:]} took {secs(lat)}, {ratio(lat, b.med)} its usual {secs(b.med)} "
                             f"(p95 {secs(b.p95)}).", "baseline", not slow))
            if C.status == "error":
                out.append(F(f"{ref[0].upper() + ref[1:]} failed ({status_text(C)}) before this write.", "outcome", True))
    rep = spec.get("repetition")
    if rep:
        w = rep["writer"]
        rel_ = ""
        if C is not None and w is not None:
            u1, u2 = user_of(tr, C), user_of(tr, w)
            if u1 and u2 and u1.id == u2.id:
                rel_ = f"; both come from the same user action (#{u1.id})"
            elif u1 and u2:
                rel_ = f"; they come from separate user actions {secs(abs(u1.start - u2.start))} apart"
        out.append(F(f"An identical change to {', '.join(paths)} ({rep['what']}) was applied {secs(now - rep['t'])} ago by "
                     f"{label(w)}{rel_}.", "repetition", not rep.get("additive", True)))
    for p in paths[:3]:
        out.append(F(f"This write would change {p}: {tr.value(p)} → {spec.get('after', '?')}.", "delta", True))
    return out


def outcomes_of(tr: Trace, sig: str, exclude: int | None = None) -> list[str]:
    res = []
    for o in tr.requests():
        if o.sig != sig or o.end is None or o.end > tr.now or o.id == exclude or o.status == "aborted":
            continue
        res.append(str(o.code) if o.code is not None else ("timeout" if o.err == "timeout" else "network error"))
    return res


def err_rate(tr: Trace, sig_key: str, spec: dict, outs: list[str] | None = None) -> float:
    """CORE keeps an EWMA of failures per signature; emulate it from the trace's outcomes (alpha 0.25)."""
    if spec.get("err_rate") is not None:
        return float(spec["err_rate"])
    b = tr.baselines.get(sig_key)
    e = b.err_rate if b else 0.0
    for x in (outs if outs is not None else outcomes_of(tr, sig_key)):
        bad = not (x.isdigit() and int(x) < 400)
        e = 0.75 * e + 0.25 * float(bad)
    return e


def streak_of(outs: list[str]) -> int:
    n = 0
    for x in reversed(outs):
        if x.isdigit() and int(x) < 400:
            break
        n += 1
    return n


def request_common(tr: Trace, trigger: str, op: Op, spec: dict) -> list:
    now = tr.now
    out = []
    sig = signature(op.method, op.url)
    selfr = f"This request (#{op.id})" if trigger == "request" else f"The request (#{op.id})"
    cause = tr.ops.get(op.cause) if op.cause is not None else None
    out.append(provenance(tr, "This request", cause))
    if op.attempt > 1:
        out.append(F(f"{selfr} is attempt {op.attempt}: it was already retried {times(op.attempt - 1)}.", "outcome", True))
    ident = [o for o in tr.requests() if o.id != op.id and o.identity == op.identity and now - o.start <= WINDOW
             and o.attempt == 1 and o.start <= op.start]
    if ident:
        inflight = [o for o in ident if o.end is None or o.end > now]
        items = []
        for o in ident[-3:]:
            if o.end is None or o.end > now:
                items.append(f"#{o.id} in flight (started {secs(now - o.start)} ago)")
            else:
                items.append(f"#{o.id} {'answered' if o.status == 'ok' else 'ended'} {status_text(o)} {secs(now - o.end)} ago")
        last = ident[-1]
        u1, u2 = user_of(tr, op), user_of(tr, last)
        r = f"#{last.id} started {secs(abs(op.start - last.start))} before this one"
        if u1 and u2 and u1.id == u2.id:
            r += f", from the same user action (#{u1.id})"
        elif u1 and u2:
            r += f"; they come from separate user actions {secs(abs(u1.start - u2.start))} apart"
        elif not u1 and not u2:
            r += ", neither from a user action"
        close = bool(inflight) or (op.start - last.start) < 2000
        listed = f" (latest 3: {'; '.join(items)})" if len(ident) > 3 else f": {'; '.join(items)}"
        out.append(F(f"{plural(len(ident), f'identical {sig} request')} in the last 10s{listed}; {r}.", "repetition",
                     (not close) if trigger == "request" else True))
    same_sig = [o for o in tr.in_flight() if o.id != op.id and signature(o.method, o.url) == sig and o.identity != op.identity]
    if same_sig:
        items = "; ".join(f"#{o.id}{(' ' + truncate(detail(o), 30)) if detail(o) else ''} ({started_rel(o, op).replace('which ', '')})"
                          for o in same_sig[:3])
        out.append(F(f"{plural(len(same_sig), f'other {sig} request')} with different input {'is' if len(same_sig) == 1 else 'are'} "
                     f"in flight: {items}.", "concurrency", True))
    outs = spec.get("outcomes") or outcomes_of(tr, op.sig, exclude=op.id if trigger == "failure" else None)
    st = streak_of(outs)
    b = tr.baselines.get(op.sig)
    if outs and st > 0 and trigger != "failure":
        oks = [o for o in tr.requests() if o.sig == op.sig and o.status == "ok" and o.end is not None and o.end <= now]
        ls = f"last success {secs(now - oks[-1].end)} ago" if oks else "no success yet"
        out.append(F(f"The last {plural(st, f'{sig} request')} failed in a row ({', '.join(outs[-5:])}); {ls}.", "outcome",
                     st < 2 if trigger == "request" else True))
    elif outs and trigger != "request":
        out.append(F(f"Recent {sig} outcomes: {', '.join(outs[-5:])}.", "outcome", True))
    recent = spec.get("recent_count")
    if recent is None:
        recent = sum(1 for o in tr.requests() if o.sig == op.sig and now - o.start <= WINDOW)
    usual = spec.get("usual_per_10s")
    if usual is not None and recent >= 3:
        hot = recent >= 5 and recent >= 3 * usual
        out.append(F(f"{sig} was requested {times(recent)} in the last 10s; usually {fmt_num(round(usual, 2))} per 10s "
                     f"({ratio(recent, usual)}).", "baseline", not hot))
    elif recent >= 3:
        out.append(F(f"{sig} was requested {times(recent)} in the last 10s (no usual rate learned yet).", "baseline", True))
    if b and trigger != "stall":
        out.append(F(f"{sig} usually answers in {secs(b.med)} (p95 {secs(b.p95)}, {b.n} samples); error rate "
                     f"{round(err_rate(tr, op.sig, spec, outs) * 100)}%.", "baseline", True))
    if spec.get("cached") and op.method == "GET":
        out.append(F(f"A cached 200 response from {secs(spec.get('cached_ago', 30000))} ago exists for this request.", "cache", True))
    idem = op.method in ("GET", "HEAD", "PUT", "DELETE", "OPTIONS")
    body = "" if op.method in ("GET", "HEAD") else f"; its body ({len(op.body or '')} bytes) can be replayed"
    out.append(F(f"{op.method} {'is' if idem else 'is not'} idempotent{body}.", "request", True))
    return out


def failure_text(op: Op) -> str:
    from world import STATUS_TEXT
    if op.code is not None:
        return f"HTTP {op.code}{(' ' + STATUS_TEXT[op.code]) if op.code in STATUS_TEXT else ''}"
    if op.err == "timeout":
        return "timed out"
    return "network error (Failed to fetch)"


def failure_facts(tr: Trace, op: Op, spec: dict) -> list:
    now = tr.now
    sig = signature(op.method, op.url)
    out = [F(f"The request #{op.id} failed: {failure_text(op)} after {secs(op.end - op.start)}; the app has not seen the "
             f"failure yet.", "outcome", False)]
    outs = spec.get("outcomes") or outcomes_of(tr, op.sig)
    st = max(1, streak_of(outs))
    oks = [o for o in tr.requests() if o.sig == op.sig and o.status == "ok" and o.end is not None and o.end <= now]
    ls = f"last success {secs(now - oks[-1].end)} ago" if oks else "no success yet"
    err = err_rate(tr, op.sig, spec, outs)
    b = tr.baselines.get(op.sig)
    count = b.n if b else len(outs)
    out.append(F(f"This is the {ordinal(st)} {sig} failure in a row (recent outcomes: {', '.join(outs[-5:])}; {ls}); "
                 f"error rate {round(err * 100)}% over {plural(count, 'request')}.", "outcome", True))
    return out + request_common(tr, "failure", op, {**spec, "outcomes": outs})


def stall_facts(tr: Trace, op: Op, spec: dict) -> list:
    now = tr.now
    sig = signature(op.method, op.url)
    b = tr.baselines.get(op.sig)
    waited = now - op.start
    out = []
    if b:
        out.append(F(f"The request #{op.id} has been in flight for {secs(waited)}; {sig} usually takes {secs(b.med)} "
                     f"(p95 {secs(b.p95)}, {b.n} samples), {ratio(waited, b.med)} the median.", "baseline", False))
    else:
        out.append(F(f"The request #{op.id} has been in flight for {secs(waited)}.", "baseline", False))
    peers = spec.get("slow_peers", 0)
    if peers:
        out.append(F(f"{plural(peers, f'other {sig} request')} {'is' if peers == 1 else 'are'} also running past 3× the usual "
                     f"latency.", "concurrency", True))
    return out + request_common(tr, "stall", op, spec)


def inconsistency_facts(tr: Trace, spec: dict) -> list:
    now = tr.now
    out = [F(f"The learned relation {spec['rel']} no longer holds: {spec['values']}. It held at {spec['held']} settled points "
             f"before.", "invariant", False)]
    lc_t = now - spec["lc_age"]
    hs = [w for w in tr.writes if w.path in spec["fields"] and w.t > lc_t]
    hs.sort(key=lambda w: -w.t)
    for w in hs[:2]:
        o = tr.ops.get(w.op)
        out.append(F(f"{w.path} was written {secs(now - w.t)} ago by {label(o)}{' (user)' if o is not None and o.kind == 'user' else ''}: "
                     f"{value_before(tr, w.path, w.t)} → {w.summary}.", "versions", True))
    n_writes = sum(1 for w in tr.writes if w.t > lc_t)
    out.append(F(f"The last consistent state is {secs(spec['lc_age'])} old; {plural(n_writes, 'field write')} happened since.",
                 "invariant", True))
    n_if = len(tr.in_flight())
    out.append(F(f"{plural(n_if, 'operation')} {'is' if n_if == 1 else 'are'} in flight." if n_if else
                 "No operations are in flight (the app is settled).", "concurrency", True))
    return out


def transition_facts(tr: Trace, op: Op, spec: dict) -> list:
    now = tr.now
    sig = op.sig
    out = [F(spec["unusual_text"], "transition", False)]
    cause = tr.ops.get(op.cause) if op.cause is not None else op
    out.append(provenance(tr, f"The completed operation #{op.id}", cause))
    b = tr.baselines.get(op.sig)
    out.append(F(f"It ended {secs(now - op.end)} ago with {status_text(op)} after {secs(op.end - op.start)}"
                 f"{f' (usual {secs(b.med)})' if b else ''}.", "baseline", True))
    for f in spec.get("chain_fields", [])[:3]:
        out.append(F(f"{f} is now {tr.value(f)}.", "delta", True))
    lc = spec.get("lc_age")
    root = tr.root_of(op)
    if lc is None:
        out.append(F(f"No consistent snapshot from before #{root.id} started exists.", "invariant", True))
    else:
        n_writes = sum(1 for w in tr.writes if w.t > root.start)
        out.append(F(f"The last consistent state from before #{root.id} started is {secs(lc)} old; "
                     f"{plural(n_writes, 'field write')} happened since.", "invariant", True))
    return out


def error_facts(tr: Trace, spec: dict) -> list:
    now = tr.now
    src = f" (at {truncate(spec['source'], 60)})" if spec.get("source") else ""
    out = [F(f"Uncaught {spec['name']}: {truncate(spec['message'], 120)}{src}.", "error", False)]
    op = spec.get("op")
    if op is not None:
        root = tr.root_of(op)
        out.append(F(f"It was thrown while {label(op)} was active, {secs(now - op.start)} after it started"
                     f"{f'; that chain began with {label(root)}' if root.id != op.id else ''}.", "provenance", True))
        ws = [w for w in tr.writes if w.t >= op.start and same_chain(tr, op, w.op)]
        if ws:
            ps = list(dict.fromkeys(w.path for w in ws))
            out.append(F(f"Its chain wrote {', '.join(ps[:4])} before the error (last {secs(now - max(w.t for w in ws))} ago).",
                         "versions", True))
        else:
            out.append(F("Its chain wrote no state before the error.", "versions", True))
    else:
        out.append(F("No operation was active when it was thrown.", "provenance", True))
    lc = spec.get("lc_age")
    if op is not None:
        root = tr.root_of(op)
        if lc is None:
            out.append(F(f"No consistent snapshot from before #{root.id} started exists.", "invariant", True))
        else:
            n_writes = sum(1 for w in tr.writes if w.t > root.start)
            out.append(F(f"The last consistent state from before #{root.id} started is {secs(lc)} old; "
                         f"{plural(n_writes, 'field write')} happened since.", "invariant", True))
    else:
        out.append(F("The last consistent state is " + secs(lc or 2000) + " old; 0 field writes happened since.", "invariant", True))
    return out


# ------------------------------------------------------------------------------------------------ sections

def subject_sentence(tr: Trace, trigger: str, spec: dict) -> str:
    if trigger == "mutation":
        ps = spec["paths"]
        p = f"{', '.join(ps[:3])} and {len(ps) - 3} more" if len(ps) > 3 else ", ".join(ps)
        c = spec.get("cause")
        return f"A write to {p}{f' from {label(c)}' if c is not None else ''} is about to be applied."
    op = spec.get("op")
    if trigger == "request":
        return f"{label(op)} is about to be sent."
    if trigger == "failure":
        short = f"HTTP {op.code}" if op.code is not None else ("timed out" if op.err == "timeout" else "network error")
        return f"{label(op)} failed ({short}) and the app has not seen the failure yet."
    if trigger == "stall":
        return f"{label(op)} has been waiting {secs(tr.now - op.start)} for a response."
    if trigger == "inconsistency":
        return f"The relation {spec['rel']} no longer holds now that the app is settled."
    if trigger == "transition":
        return f"{label(op)} completed with a state change unlike its usual ones."
    return f"An uncaught {spec['name']} was thrown: {truncate(spec['message'], 120)}"


def event_lines(tr: Trace) -> list[str]:
    from world import _events
    now = tr.now
    out = []
    for t, _, kind, obj in _events(tr):
        ts = rel(t - now)
        if kind == "user":
            out.append(f"{ts} {user_phrase(obj)} (#{obj.id})")
        elif kind == "start":
            o = obj
            by = f", by #{o.cause}" if o.cause is not None else ""
            att = f", attempt {o.attempt}" if o.attempt > 1 else ""
            out.append(f"{ts} start {truncate(phrase(o), 80)} (#{o.id}{by}{att})")
        elif kind == "end":
            o = obj
            out.append(f"{ts} end {truncate(phrase(o), 80)} (#{o.id}): {status_text(o)} in {secs(o.end - o.start)}")
        elif kind == "write":
            w = obj
            o = tr.ops.get(w.op)
            user = o is not None and o.kind == "user"
            out.append(f"{ts} write {truncate(f'{w.path}: {value_before(tr, w.path, w.t)} → {w.summary}', 110)} (by #{w.op}{', user' if user else ''})")
        elif kind == "extra":
            x = obj
            if x.kind == "error":
                out.append(f"{ts} error {truncate(x.text, 100)}")
            elif x.kind == "offline":
                out.append(f"{ts} event offline")
            else:
                out.append(f"{ts} event {truncate(x.text, 60)}")
        elif kind in ("ws",):
            out.append(f"{ts} event {truncate(phrase(obj), 60)} (#{obj.id})")
        else:  # timers: CORE records them only as causes; show nothing
            continue
    return out


def in_flight_lines(tr: Trace, subj: Op | None) -> list[str]:
    now = tr.now
    ops = [o for o in tr.in_flight() if subj is None or o.id != subj.id]

    def score(o):
        if subj is None:
            return 2
        return 0 if o.sig == subj.sig else 1 if o.root == subj.root else 2

    ops.sort(key=lambda o: (score(o), o.start))
    return [f"{truncate(phrase(o), 80)} (#{o.id}) {secs(now - o.start)} so far{f', by #{o.cause}' if o.cause is not None else ''}"
            for o in ops[: LIMITS["in_flight"]]]


def state_lines(tr: Trace, paths: list[str]) -> list[str]:
    now = tr.now
    out = []
    for p in paths:
        w = tr.last_write(p)
        v = tr.version(p)
        if w is not None:
            out.append(f"{p} = {w.summary} (v{v}, by #{w.op} {secs(now - w.t)} ago)")
        else:
            out.append(f"{p} = {tr.values0.get(p, 'undefined')} (v{v})" if v else f"{p} = {tr.values0.get(p, 'undefined')} (v0)")
    return out[: LIMITS["state"]]


def stats_lines(tr: Trace, subj: Op | None, spec: dict) -> list[str]:
    now = tr.now
    sigs = []
    if subj is not None and subj.kind == "fetch":
        sigs.append(subj.sig)
    for o in tr.in_flight():
        if o.sig not in sigs:
            sigs.append(o.sig)
    out = []
    for s in sigs:
        b = tr.baselines.get(s)
        if b is None:
            continue
        recent = spec.get("recent_count") if subj is not None and s == subj.sig and spec.get("recent_count") else \
            sum(1 for o in tr.requests() if o.sig == s and now - o.start <= WINDOW)
        usual = spec.get("usual_per_10s") if subj is not None and s == subj.sig else None
        er = err_rate(tr, s, spec if subj is not None and s == subj.sig else {})
        parts = [f"{b.n} done", f"median {secs(b.med)}", f"p95 {secs(b.p95)}", f"errors {round(er * 100)}%",
                 f"{recent} in last 10s{f' (usual {fmt_num(round(usual, 2))})' if usual is not None else ''}"]
        rep = next((o for o in tr.requests() if o.sig == s), None)
        sig_txt = signature(rep.method, rep.url) if rep is not None else s
        out.append(f"{sig_txt}: {', '.join(parts)}")
    return out[: LIMITS["stats"]]


def to_state(parts: dict) -> dict:
    p = {"app": truncate(parts["app"] or "unknown", LINE["app"]), "trigger": truncate(parts["trigger"], LINE["trigger"]),
         "facts": [truncate(s, LINE["facts"]) for s in parts["facts"][: LIMITS["facts"]]],
         "in_flight": [truncate(s, LINE["in_flight"]) for s in parts["in_flight"][: LIMITS["in_flight"]]],
         "timeline": [truncate(s, LINE["timeline"]) for s in parts["timeline"][-LIMITS["timeline"]:]],
         "state": [truncate(s, LINE["state"]) for s in parts["state"][: LIMITS["state"]]],
         "stats": [truncate(s, LINE["stats"]) for s in parts["stats"][: LIMITS["stats"]]]}

    def build():
        return {k: (v if not isinstance(v, list) else (list(v) if v else "none")) for k, v in p.items()}

    def size(st):
        return sum(len(k) + 2 + len("\n".join(v) if isinstance(v, list) else str(v)) + 1 for k, v in st.items())

    st = build()
    for key, from_start, floor in (("timeline", True, 0), ("state", False, 0), ("facts", False, 1), ("in_flight", False, 0),
                                   ("stats", False, 0)):
        while size(st) > STATE_CHAR_BUDGET and len(p[key]) > floor:
            p[key].pop(0 if from_start else -1)
            st = build()
    return st


def render(sc, app, rng) -> tuple[dict, dict] | None:
    """-> (state, questions) exactly as the runtime builds them, or None when the scenario has no runtime form."""
    spec = getattr(sc, "spec", None) or {}
    if not spec or spec.get("no_runtime"):
        return None
    tr: Trace = sc.trace
    trig = sc.trigger
    if trig == "mutation":
        fs = mutation_facts(tr, spec)
        subj = spec.get("cause")
        paths = list(spec["paths"]) + [p for p in spec.get("state_extra", []) if p not in spec["paths"]]
    elif trig == "request":
        subj = spec["op"]
        fs = request_common(tr, "request", subj, spec)
        paths = spec.get("state_paths", [])
    elif trig == "failure":
        subj = spec["op"]
        fs = failure_facts(tr, subj, spec)
        paths = spec.get("state_paths", [])
    elif trig == "stall":
        subj = spec["op"]
        fs = stall_facts(tr, subj, spec)
        paths = spec.get("state_paths", [])
    elif trig == "inconsistency":
        subj = None
        fs = inconsistency_facts(tr, spec)
        paths = spec.get("state_paths", spec["fields"])
    elif trig == "transition":
        subj = spec["op"]
        fs = transition_facts(tr, subj, spec)
        paths = spec.get("chain_fields", [])
    else:
        subj = spec.get("op")
        fs = error_facts(tr, spec)
        paths = spec.get("state_paths", [])
    facts = order(fs + [F(x, "plugin", True) for x in spec.get("extra_facts", [])])
    parts = {"app": f"{app.title} — {app.route()}", "trigger": subject_sentence(tr, trig, {**spec, "op": subj} if subj else spec),
             "facts": facts, "in_flight": in_flight_lines(tr, subj if trig != "mutation" else None),
             "timeline": event_lines(tr), "state": state_lines(tr, paths) + spec.get("state_lines", []),
             "stats": stats_lines(tr, subj if trig != "mutation" else spec.get("cause"), spec)}
    state = to_state(parts)
    acts = [a for a in TRIGGER_ACTIONS[trig] if a in sc.actions]
    questions = {"diagnosis": {"type": "choice", "instructions": DIAG_INSTR, "criteria": dict(DIAGNOSES)}}
    if len(acts) > 1:
        questions["action"] = {"type": "choice", "instructions": ACTION_INSTR[trig], "criteria": {a: ACTIONS[a] for a in acts}}
    return state, questions
