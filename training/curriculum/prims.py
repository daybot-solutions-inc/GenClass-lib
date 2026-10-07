"""Primitive questions over a Trace (exact labels): temporal order, causality, versions, identity, outcomes,
baselines. Each builder returns a list of candidates (qid, question, label); the row builder samples a few.
"""

from __future__ import annotations

import random

from fmt import Style, pick_from
from world import Op, Trace

Q = tuple[str, dict, dict]


def noul(instr: str, p: bool, crit: tuple[str, str] | None = None) -> tuple[dict, dict]:
    q = {"type": "noul", "instructions": instr}
    if crit:
        q["criteria"] = {"true": crit[0], "false": crit[1]}
    return q, {"type": "noul", "p": 1.0 if p else 0.0}


def choice(instr: str, options: dict[str, str | None], label: str) -> tuple[dict, dict]:
    assert label in options, (label, options)
    return {"type": "choice", "instructions": instr, "criteria": options}, {"type": "choice", "label": label}


def score(instr: str, levels: list[str], level: int) -> tuple[dict, dict]:
    assert 0 <= level < len(levels)
    return {"type": "score", "instructions": instr, "criteria": levels}, {"type": "score", "level": level}


def _shuffled(rng: random.Random, xs: list) -> list:
    xs = list(xs)
    rng.shuffle(xs)
    return xs


def opname(st: Style, o: Op, rng: random.Random) -> str:
    """How an op is named inside a question: by ref, by request, or both."""
    r = rng.random()
    if o.kind == "user":
        return f"{st.op(o.id)} ({o.action} {o.target})" if r < 0.5 else f"the {o.action} on {o.target}"
    if r < 0.4:
        return st.op(o.id)
    if r < 0.7:
        return f"{st.op(o.id)} ({o.req})"
    return o.req if r < 0.85 else f"{o.req} [{st.op(o.id)}]"


# ------------------------------------------------------------------------------------------------- temporal


def temporal(rng: random.Random, tr: Trace, st: Style) -> list[Q]:
    out: list[Q] = []
    reqs = tr.requests()
    test = st.test
    if len(reqs) >= 2:
        a, b = rng.sample(reqs, 2)
        if a.start != b.start:
            na, nb = opname(st, a, rng), opname(st, b, rng)
            instr = pick_from(rng, [f"Did {na} start before {nb}?", f"Was {na} sent earlier than {nb}?",
                                    f"Is {na} older than {nb} (started first)?", f"{na} started before {nb}: true?",
                                    f"Did {nb} start after {na}?"], test)
            truth = a.start < b.start
            out.append(("t_before",) + noul(instr, truth))
    if len(reqs) >= 3:
        cands = rng.sample(reqs, min(len(reqs), rng.randint(3, 4)))
        first = min(cands, key=lambda o: o.start)
        last = max(cands, key=lambda o: o.start)
        if len({o.start for o in cands}) == len(cands):
            want_first = rng.random() < 0.5
            tgt = first if want_first else last
            opts = {st.op(o.id): (o.req if rng.random() < 0.7 else None) for o in _shuffled(rng, cands)}
            instr = pick_from(rng, ["Which of these requests started {w}?", "Which request was sent {w}?",
                                    "Pick the request that began {w}.", "Of these, which started {w}?"], test)
            out.append(("t_first",) + choice(instr.format(w="first" if want_first else "last"), opts, st.op(tgt.id)))
    done = [o for o in reqs if o.end is not None and o.end <= tr.now]
    if len(done) >= 2:
        a, b = rng.sample(done, 2)
        if a.start < b.start and a.end != b.end:
            na, nb = opname(st, a, rng), opname(st, b, rng)
            ooo = b.end < a.end
            instr = pick_from(rng, [f"{na} was sent before {nb}. Did {nb}'s response arrive first?",
                                    f"Did the responses of {na} and {nb} arrive out of order (later request answered first)?",
                                    f"Was {nb} answered before {na} even though it was sent later?",
                                    f"Out-of-order responses between {na} and {nb}?"], test)
            out.append(("t_ooo",) + noul(instr, ooo))
        fin = sorted(done, key=lambda o: o.end)[-1]
        cands = rng.sample(done, min(len(done), 4))
        if fin not in cands:
            cands[0] = fin
        if len({o.end for o in cands}) == len(cands):
            lastc = max(cands, key=lambda o: o.end)
            opts = {st.op(o.id): (o.req if rng.random() < 0.6 else None) for o in _shuffled(rng, cands)}
            instr = pick_from(rng, ["Which of these requests finished last?", "Whose response arrived last?",
                                    "Pick the request that completed most recently.", "Which one ended last?"], test)
            out.append(("t_lastend",) + choice(instr, opts, st.op(lastc.id)))
    n_if = len(tr.in_flight())
    levels = ["none", "one", "two", "three or more"]
    instr = pick_from(rng, ["How many requests are still in flight?", "How many requests have not finished yet?",
                            "Count the pending requests.", "Number of open requests right now?"], test)
    out.append(("t_inflight",) + score(instr, levels, min(n_if, 3)))
    return out


# ------------------------------------------------------------------------------------------------- causality


def causal(rng: random.Random, tr: Trace, st: Style) -> list[Q]:
    out: list[Q] = []
    users = tr.users()
    reqs = [o for o in tr.requests() if o.root is not None and tr.ops[o.root].kind == "user"]
    test = st.test
    if users and reqs and len(users) >= 2:
        o = rng.choice(reqs)
        root = tr.ops[o.root]
        cands = rng.sample(users, min(len(users), 4))
        if root not in cands:
            cands[0] = root
        if len({(u.action, u.target, u.value) for u in cands}) == len(cands):
            opts = {st.op(u.id): f"{u.action} {u.target}" + (f' "{u.value}"' if u.value else "") for u in _shuffled(rng, cands)}
            instr = pick_from(rng, [f"Which user action caused {opname(st, o, rng)}?",
                                    f"What triggered {opname(st, o, rng)}?",
                                    f"{opname(st, o, rng)} was issued because of which user action?",
                                    f"Root user action of {opname(st, o, rng)}?"], test)
            out.append(("c_root",) + choice(instr, opts, st.op(root.id)))
    if len(reqs) >= 2:
        a, b = rng.sample(reqs, 2)
        same = a.root == b.root
        instr = pick_from(rng, [f"Were {opname(st, a, rng)} and {opname(st, b, rng)} triggered by the same user action?",
                                f"Do {opname(st, a, rng)} and {opname(st, b, rng)} share a root cause?",
                                f"Same originating user action for {opname(st, a, rng)} and {opname(st, b, rng)}?",
                                f"Did one user action cause both {opname(st, a, rng)} and {opname(st, b, rng)}?"], test)
        out.append(("c_same",) + noul(instr, same))
    if users:
        u = rng.choice(users)
        n = sum(1 for o in tr.requests() if o.root == u.id)
        instr = pick_from(rng, [f"How many requests did {opname(st, u, rng)} cause?",
                                f"Count the requests triggered by {opname(st, u, rng)}.",
                                f"Number of requests that came from {opname(st, u, rng)}?"], test)
        out.append(("c_count",) + score(instr, ["none", "one", "two", "three or more"], min(n, 3)))
    return out


# ------------------------------------------------------------------------------------------------- versions


def versions(rng: random.Random, tr: Trace, st: Style, path: str, op: Op) -> list[Q]:
    out: list[Q] = []
    test = st.test
    since = tr.writes_between(path, op.start)
    on = opname(st, op, rng)
    instr = pick_from(rng, [f"Has {path} changed since {on} started?", f"Was {path} written after {on} began?",
                            f"Did anything write {path} while {on} was in flight?",
                            f"Is {path} different now from when {on} started?"], test)
    out.append(("v_changed",) + noul(instr, bool(since)))
    def in_chain(wo: Op) -> bool:
        return wo.id == op.id or (op.root is not None and (wo.id == op.root or wo.root == op.root))

    newer = [w for w in since if (wo := tr.ops.get(w.op)) is not None and not in_chain(wo)
             and (wo.kind in ("user", "ws") or wo.start > op.start)]
    instr = pick_from(rng, [f"Was {path} written since {on} started by an operation or input that is newer than {on}?",
                            f"Would applying {on}'s result overwrite newer data in {path}?",
                            f"Does {path} now hold data that is newer than {on}?",
                            f"Is {on}'s result older than what {path} currently holds?"], test)
    out.append(("v_newer",) + noul(instr, bool(newer)))
    behind = len(since)
    instr = pick_from(rng, [f"How many versions of {path} were written since {on} started?",
                            f"By how many versions has {path} moved since {on} began?",
                            f"Count the writes to {path} after {on} started."], test)
    out.append(("v_behind",) + score(instr, ["0", "1", "2", "3 or more"], min(behind, 3)))
    writers = [tr.ops[w.op] for w in since if w.op in tr.ops]
    pool = [o for o in tr.ops.values() if o.kind in ("fetch", "user") and o.id != op.id and o.start <= tr.now]
    if pool:
        last_writer = writers[-1] if writers else None
        cands = rng.sample(pool, min(len(pool), 3))
        if last_writer is not None and last_writer not in cands:
            cands[0] = last_writer
        opts = {st.op(o.id): (o.req if o.kind == "fetch" else f"user {o.action} {o.target}") for o in _shuffled(rng, cands)}
        opts["none"] = "nothing wrote it"
        lab = st.op(last_writer.id) if last_writer is not None else "none"
        instr = pick_from(rng, [f"Which operation last wrote {path} after {on} started?",
                                f"Who most recently wrote {path} since {on} began?",
                                f"Since {on} started, which op wrote {path} last?"], test)
        out.append(("v_writer",) + choice(instr, opts, lab))
    return out


# ------------------------------------------------------------------------------------------------- identity


def identity(rng: random.Random, tr: Trace, st: Style, op: Op) -> list[Q]:
    out: list[Q] = []
    test = st.test
    prev = [o for o in tr.requests() if o.start < op.start or (o.start == op.start and o.id < op.id)]
    prev = [o for o in prev if o.id != op.id]
    same = [o for o in prev if o.identity == op.identity]
    on = opname(st, op, rng)
    instr = pick_from(rng, [f"Is {on} identical to an earlier request (same method, URL and body)?",
                            f"Was the exact same request as {on} sent before?",
                            f"Does an identical earlier request to {on} exist?",
                            f"Has {on} (same method, URL and body) been sent already?"], test)
    out.append(("i_ident",) + noul(instr, bool(same)))
    others = [o for o in prev if o.identity != op.identity]
    if others or same:
        cands = rng.sample(others, min(len(others), 3 if not same else 2)) + ([same[-1]] if same else [])
        opts = {st.op(o.id): f"{o.req} {o.body}".strip() for o in _shuffled(rng, cands)}
        opts["none"] = "no earlier request is identical"
        lab = st.op(same[-1].id) if same else "none"
        instr = pick_from(rng, [f"Which earlier request is identical to {on}?",
                                f"Pick the request that {on} duplicates, if any.",
                                f"Which of these is the same request as {on}?"], test)
        out.append(("i_which",) + choice(instr, opts, lab))
    if same:
        o = same[-1]
        same_root = o.root == op.root and op.root is not None
        instr = pick_from(rng, [f"Did {on} and the identical {st.op(o.id)} come from the same user action?",
                                f"Were both identical requests ({st.op(o.id)} and {on}) caused by one user action?",
                                f"Same user intent behind {st.op(o.id)} and {on}?"], test)
        out.append(("i_sameact",) + noul(instr, same_root))
        gap = op.start - o.start
        lv = 0 if gap < 100 else 1 if gap < 1000 else 2 if gap < 5000 else 3
        instr = pick_from(rng, [f"How far apart were {st.op(o.id)} and {on} sent?",
                                f"Time between the identical requests {st.op(o.id)} and {on}?",
                                f"Gap between {st.op(o.id)} and {on}?"], test)
        out.append(("i_gap",) + score(instr, ["under 100 ms", "100 ms to 1 s", "1 to 5 s", "more than 5 s"], lv))
    return out


# ------------------------------------------------------------------------------------------------- outcomes


def streak_q(rng: random.Random, st: Style, sig: str, outcomes: list[bool]) -> list[Q]:
    """outcomes: oldest..newest, True = success."""
    n = 0
    for ok in reversed(outcomes):
        if ok:
            break
        n += 1
    test = st.test
    instr = pick_from(rng, [f"How many times in a row has {sig} failed most recently?",
                            f"Current failure streak of {sig}?", f"Consecutive recent failures of {sig}?",
                            f"How many of the latest {sig} attempts failed back to back?"], test)
    out = [("o_streak",) + score(instr, ["0", "1", "2", "3", "4", "5 or more"], min(n, 5))]
    instr = pick_from(rng, [f"Did the most recent {sig} succeed?", f"Was the last attempt of {sig} successful?",
                            f"Is {sig}'s latest outcome a success?"], test)
    out.append(("o_last",) + noul(instr, outcomes[-1] if outcomes else True))
    return out


def ratio_level(r: float) -> int:
    return 0 if r < 1.5 else 1 if r < 3 else 2 if r < 10 else 3


RATIO_LEVELS = ["under 1.5× the median", "1.5–3×", "3–10×", "10× or more"]


def latency_q(rng: random.Random, st: Style, what: str, elapsed: float, med: float, p95: float) -> list[Q]:
    test = st.test
    r = elapsed / med
    instr = pick_from(rng, [f"How does {what}'s time compare with its usual median?",
                            f"Latency of {what} relative to its median?", f"{what}: how many times its usual latency?",
                            f"Ratio of {what}'s duration to the learned median?"], test)
    out = [("b_ratio",) + score(instr, RATIO_LEVELS, ratio_level(r))]
    instr = pick_from(rng, [f"Is {what} slower than its usual p95?", f"Has {what} exceeded its p95 latency?",
                            f"Beyond the 95th percentile for {what}?"], test)
    out.append(("b_p95",) + noul(instr, elapsed > p95))
    instr = pick_from(rng, [f"Is {what} abnormally slow (more than 3× its median and beyond p95)?",
                            f"Would you call {what} far slower than usual (>3× median, >p95)?",
                            f"Is {what} a latency anomaly?"], test)
    out.append(("b_anom",) + noul(instr, r > 3 and elapsed > p95))
    return out


RETRYABLE = {408: True, 425: True, 429: False, 500: True, 502: True, 503: True, 504: True,
             400: False, 401: False, 403: False, 404: False, 409: False, 410: False, 412: False, 413: False, 422: False}


def failure_kind(code: int | None, err: str) -> str:
    if err == "timeout" or code in (408, 504):
        return "timeout"
    if err:
        return "network"
    if code == 429:
        return "rate_limited"
    if code == 401:
        return "auth"
    if code == 403:
        return "forbidden"
    if code in (404, 410):
        return "not_found"
    if code in (409, 412):
        return "conflict"
    if code in (400, 413, 422):
        return "validation"
    return "server"


FAILURE_KIND_DESC = {
    "timeout": "the request or a gateway timed out", "network": "network-level failure (no HTTP response)",
    "rate_limited": "too many requests; the server asked to slow down", "auth": "authentication missing or expired",
    "forbidden": "authenticated but not allowed", "not_found": "the resource does not exist (anymore)",
    "conflict": "version conflict with the server's copy", "validation": "the request content was rejected as invalid",
    "server": "a fault on the server side",
}


def failure_q(rng: random.Random, st: Style, op: Op, has_key: bool = False) -> list[Q]:
    test = st.test
    k = failure_kind(op.code, op.err)
    kinds = list(FAILURE_KIND_DESC)
    opts_keys = [k] + rng.sample([x for x in kinds if x != k], 3)
    rng.shuffle(opts_keys)
    opts = {x: FAILURE_KIND_DESC[x] for x in opts_keys}
    on = op.req
    instr = pick_from(rng, [f"What kind of failure is this for {on}?", f"Classify the failure of {on}.",
                            f"Why did {on} fail?", f"Which failure category fits {on}?"], test)
    out = [("f_kind",) + choice(instr, opts, k)]
    safe = (op.idempotent or has_key) and (RETRYABLE.get(op.code, True) if op.code else True)
    instr = pick_from(rng, [f"Is it safe to retry {on} automatically?",
                            f"Can {on} be retried without risking a double effect or a pointless repeat?",
                            f"Would an automatic retry of {on} be safe and sensible?"], test)
    out.append(("f_retry",) + noul(instr, safe))
    return out
