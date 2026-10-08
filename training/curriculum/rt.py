"""Runtime-exact rendering: the situation text and standing questions exactly as @genclass/runtime builds them
(FROZEN at git tag `situation-v2`, commit 6e5e86e: packages/runtime/src/situation/{facts,conflicts,content,evidence,
describe,build,serialize,questions}.ts and state/fields.ts changeText/stringDiff), from a scenario's
Trace and `spec`. The curriculum renders a share of decision rows this way so stage 1 already matches what the
model will read in production; the remaining rows keep the varied styles (robustness).

Facts follow CORE's computations (provenance, versions, inputs moved, concurrency, repetition, outcomes, baselines,
cache, method semantics, invariants, transitions, errors) and its ordering (non-neutral first, then kind rank).
Scenario facts that CORE cannot compute are dropped; scenarios whose label would then be unjustifiable return None.

situation-v2 additions mirrored here: the `delivery` trigger (a response / WebSocket message about to be delivered;
mutation scenarios whose cause is a completed fetch or a WS message are rendered as deliveries with P_DELIVERY, since
v2 decides at the network boundary and store writes are not held by default), newer-data / pending-local-change
conflicts (conflicts.ts: only these make a version fact non-neutral), content facts F1-F3 (content.ts, scalar fields),
evidence facts F5-F7/F9 (evidence.ts: commit ambiguity, failure scope, cadence, repeat-action evidence, stale marks),
diff-centred string changes (fields.ts stringDiff), the 2,400-char full budget and the new "auto" device budgets.
Inputs the curriculum Trace does not model (learned cadence, stale marks, click counts, create responses for
read-your-writes, list item joins) come from optional `spec` keys or are absent, as in a runtime that never saw them.
"""

from __future__ import annotations

import json
import math
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
    "transient": "a one-off failure that is likely to succeed if tried again",  # CONTRACT §6 (2026-10-07)
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
TRIGGER_DESCRIPTIONS = {"delivery": {  # questions.ts TRIGGER_DESCRIPTIONS (situation-v2)
    "deliver": "pass it to the application now",
    "discard": "deliver it but drop the state changes it would make over newer data",
    "defer": "hold it until the related in-flight operations finish, then decide again",
}}
TRIGGER_ACTIONS = {"mutation": ["apply", "discard", "defer"], "request": ["send", "coalesce", "delay", "block", "serve_cached"],
                   "delivery": ["deliver", "discard", "defer"],
                   "failure": ["deliver", "retry", "serve_cached"], "stall": ["wait", "hedge", "serve_cached"],
                   "inconsistency": ["ignore", "rollback", "resync"], "transition": ["ignore", "rollback", "resync"],
                   "error": ["ignore", "rollback"]}
ACTION_INSTR = {
    "mutation": "What should the runtime do with this write?", "request": "What should the runtime do with this request?",
    "delivery": "What should the runtime do with this response or message?",
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
STATE_CHAR_BUDGET = 2400  # situation-v2 (was 3,200)
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


def _is_slug_id(seg: str) -> bool:
    if len(seg) < 4 or not re.fullmatch(r"[A-Za-z0-9_-]+", seg) or not re.search(r"\d", seg) or not re.search(r"[A-Za-z]", seg):
        return False
    if re.fullmatch(r"v\d+([a-z]+\d*)?", seg, re.I):
        return False
    for part in re.split(r"[-_]", seg):
        if not part or not re.search(r"\d", part) or not re.search(r"[A-Za-z]", part):
            continue
        if part[0].isdigit():
            return True
        if len(re.findall(r"[A-Za-z](?=\d)|\d(?=[A-Za-z])", part)) >= 2:
            return True
    return len(seg) >= 6 and bool(re.search(r"[a-z]", seg)) and bool(re.search(r"[A-Z]", seg)) and bool(re.search(r"\d", seg))


def is_id(seg: str) -> bool:
    return bool(seg) and (seg.isdigit() or bool(_UUID.match(seg)) or bool(_HEX.match(seg)) or bool(_TOK.match(seg))
                          or _is_slug_id(seg))


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
    """CORE (situation-v2): "started 0.09s after #6"."""
    d = w.start - ref.start
    if abs(d) < 0.5:
        return f"started at the same time as #{ref.id}"
    return f"started {secs(abs(d))} {'after' if d > 0 else 'before'} #{ref.id}"


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
    p = f"{what} comes from {label(op)}, started {secs(now - op.start)} ago"
    if op.kind != "user" and op.end is not None and op.end <= now and op.end != op.start:
        p += f", ended {secs(now - op.end)} ago with {status_text(op)}"
    root = tr.root_of(op)
    if root.id != op.id:
        p += f"; its chain began with {label(root)}"
    return F(p + ".", "provenance", True)


def value_at(tr: Trace, path: str, t: float) -> str:
    """The field's value (summary) at time t (writes at t included)."""
    prev = [w for w in tr.writes if w.path == path and w.t <= t]
    return prev[-1].summary if prev else tr.values0.get(path, "undefined")


def _json_str(summary: str) -> str | None:
    """A summary that is a JSON string literal -> the string (the runtime compares raw strings)."""
    if len(summary) >= 2 and summary[0] == '"' and summary[-1] == '"':
        try:
            v = json.loads(summary)
        except ValueError:
            return None
        return v if isinstance(v, str) else None
    return None


def _jstr(x: str) -> str:
    return json.dumps(x, ensure_ascii=False)


def string_diff(before: str, after: str, width: int = 30) -> str | None:
    """state/fields.ts stringDiff (situation-v2): a diff-centred preview of a long string change, None when short."""
    if before == after or (len(before) <= width and len(after) <= width):
        return None
    p, mx = 0, min(len(before), len(after))
    while p < mx and before[p] == after[p]:
        p += 1
    s = 0
    while s < mx - p and before[len(before) - 1 - s] == after[len(after) - 1 - s]:
        s += 1
    removed, added = before[p: len(before) - s], after[p: len(after) - s]
    start = max(0, p - 14)

    def win(x: str) -> str:
        return _jstr(f"{'…' if start > 0 else ''}{x[start: start + width]}{'…' if start + width < len(x) else ''}")

    def q(x: str) -> str:
        return _jstr(truncate(x, 28))

    what = f"removes {q(removed)}" if not added else f"inserts {q(added)}" if not removed else f"replaces {q(removed)} with {q(added)}"
    return f"{win(before)} → {win(after)} ({what})"


def change_text(before: str, after: str) -> str:
    """state/fields.ts changeText for scalar summaries: long strings are shown diff-centred (situation-v2)."""
    b, a = _json_str(before), _json_str(after)
    if b is not None and a is not None:
        d = string_diff(b, a)
        if d:
            return d
    return f"{before} → {after}"


def normalize_field_path(path: str) -> str:
    return ".".join(":id" if i > 0 and (is_id(s) or re.search(r"\d", s)) else s for i, s in enumerate(path.split(".")))


# ------------------------------------------------------------------------------------------------ conflicts.ts (v2)

PENDING_WINDOW_MS = 10_000


def newer_same_signature(tr: Trace, x: Op) -> bool:
    if x.kind != "fetch":
        return False
    return any(o.id != x.id and o.sig == x.sig and o.kind == x.kind and o.start > x.start for o in tr.in_flight())


def newer_conflict(tr: Trace, x: Op, path: str) -> dict | None:
    """A newer operation (started after x, outside x's chain, not a user action) wrote `path` since x started and its
    value now differs from its value when x started. None while a newer request of x's signature is in flight."""
    if newer_same_signature(tr, x):
        return None
    log = [w for w in tr.writes_between(path, x.start) if not same_chain(tr, x, w.op)]
    if not log:
        return None
    newest = None
    for w in log:
        o = tr.ops.get(w.op)
        if o is None or o.kind == "user" or o.start <= x.start:
            continue
        newest = o
    if newest is None or value_before(tr, path, log[0].t) == tr.value(path):
        return None
    return {"path": path, "kind": "newer", "writer": newest, "count": len(log), "t": log[-1].t}


def pending_conflict(tr: Trace, x: Op | None, path: str, now: float) -> dict | None:
    """An unconfirmed optimistic write of a user action's chain whose request (of another signature than x's) is
    still in flight."""
    my_root = (x.root if x.root is not None else x.id) if x is not None else None
    hist = [w for w in tr.writes if w.path == path and w.t <= now]
    for w in reversed(hist):
        if now - w.t > PENDING_WINDOW_MS:
            break
        wo = tr.ops.get(w.op)
        if wo is None:
            continue
        root = tr.root_of(wo)
        if root.kind != "user" or root.id == my_root:
            continue
        pending = next((o for o in tr.in_flight() if (o.root == root.id) and o.kind != "user"
                        and (x is None or o.sig != x.sig)), None)
        if pending is None:
            continue
        return {"path": path, "kind": "pending", "writer": root, "pending_op": pending, "count": 1, "t": w.t}
    return None


def conflicts_on(tr: Trace, x: Op, paths: list[str], now: float) -> list[dict]:
    out = [c for p in paths if (c := newer_conflict(tr, x, p) or pending_conflict(tr, x, p, now))]
    return sorted(out, key=lambda c: 0 if c["kind"] == "newer" else 1)


# ------------------------------------------------------------------------------------------------ facts.ts (v2) shared

def version_facts(tr: Trace, X: Op, paths: list[str], ref: str) -> list:
    """Non-neutral only for a newer-data conflict or a pending local change (situation-v2)."""
    now = tr.now
    out = []
    for path in paths:
        v0, vn = tr.version(path, X.start), tr.version(path)
        log = tr.writes_between(path, X.start)
        others = [w for w in log if not same_chain(tr, X, w.op)]
        pending = pending_conflict(tr, X, path, now)
        if pending:
            rel_ = "started after that user action" if X.start > pending["writer"].start else "started before that user action"
            out.append(F(f"{path} has a pending local change: {label(pending['writer'])} wrote it {secs(now - pending['t'])} ago "
                         f"and its {label(pending['pending_op'])} is still in flight; {ref} {rel_}.", "versions", False))
        if others:
            last = others[-1]
            w = tr.ops.get(last.op)
            wt = (f"{label(w)}, which {started_rel(w, X)}{user_relation(tr, X, w)}" if w is not None else "a user action")
            conflict = newer_conflict(tr, X, path) is not None
            out.append(F(f"{path} was written {times(len(others))} by other operations since {ref} started (version "
                         f"{v0} → {vn}), last {secs(now - last.t)} ago by {wt}.", "versions", not conflict))
        elif log:
            out.append(F(f"{path} was written {times(len(log))} by {ref}'s own chain since it started (version {v0} → {vn}).",
                         "versions", True))
        elif not pending:
            out.append(F(f"{path} has not changed since {ref} started (version {vn}).", "versions", True))
    return out


def moved_facts(tr: Trace, X: Op, exclude: list[str], stores: list[str], ref: str) -> list:
    """Other fields changed since X started, by other chains (always neutral in situation-v2)."""
    now = tr.now
    moved: dict[str, list] = {}
    for w in tr.writes:
        if X.start < w.t <= now and w.path not in exclude and not same_chain(tr, X, w.op):
            moved.setdefault(w.path, []).append(w)

    def key(item):
        p, hs = item
        same = p.split(".")[0] in stores
        user = any(tr.ops.get(h.op) is not None and tr.ops[h.op].kind == "user" for h in hs)
        return (-int(same), -int(user), -hs[-1].t)

    out = []
    for p, hs in sorted(moved.items(), key=key)[:2]:
        first, last = hs[0], hs[-1]
        w = tr.ops.get(last.op)
        by = f"{label(w)} {secs(max(0.0, last.t - X.start))} after #{X.id} started" if w else "an untracked writer"
        n = len(hs)
        before, cur = value_before(tr, p, first.t), tr.value(p)
        if before == cur:
            what = f"{p} changed {times(n)} since {ref} started and is back to {cur}"
        else:
            what = f"{p} changed since {ref} started: {before} → {cur}{f' ({n} writes)' if n > 1 else ''}"
        out.append(F(f"{what}, last by {by}.", "inputs", True))
    return out


def concurrency_facts(tr: Trace, X: Op, ref: str) -> list:
    """Other in-flight ops with X's signature (always neutral in situation-v2). The store-writers variant needs the
    runtime's per-signature store statistics, which the Trace does not keep."""
    chain = {X.id} | {a.id for a in ancestors(tr, X)}
    others = [o for o in tr.in_flight() if o.id not in chain and not is_anc_or_self(tr, X, o) and o.kind != "user"]
    same = [o for o in others if o.kind == X.kind and o.sig == X.sig]
    if not same:
        return []
    newer = [o for o in same if o.start > X.start]
    items = "; ".join(" ".join(f"#{o.id} {truncate(detail(o), 30)} {started_rel(o, X)}".split()) for o in same[:3])
    cname = signature(X.method, X.url) if X.kind == "fetch" else X.sig
    return [F(f"{plural(len(same), f'other {cname} operation')} {'is' if len(same) == 1 else 'are'} in flight "
              f"({len(newer)} newer than {ref}): {items}.", "concurrency", True)]


# ------------------------------------------------------------------------------------------------ content.ts (v2)

def compare_field(tr: Trace, x: Op, path: str, incoming: str, current: str | None = None) -> dict:
    """content.ts compareField over value summaries (scalar fields; list item joins are not modelled)."""
    cur = tr.value(path) if current is None else current
    log = tr.writes_between(path, x.start)
    others = [w for w in log if not same_chain(tr, x, w.op)]
    c = {"path": path, "incoming": incoming, "current": cur, "same": incoming == cur, "others": others,
         "start": cur if not log else value_before(tr, path, log[0].t), "revert_of": None, "user": None}
    if not c["same"]:
        for w in reversed(others):
            if value_before(tr, path, w.t) == incoming:
                c["revert_of"] = w
                break
        if _json_str(cur) is not None and _json_str(incoming) is not None:
            us = [w for w in others if (o := tr.ops.get(w.op)) is not None and (o.kind == "user" or tr.root_of(o).kind == "user")]
            if us:
                c["user"] = (len(us), us[-1])
    return c


def content_facts(tr: Trace, x: Op, cmps: list[dict], subject: str, all_fields: list[str] | None = None) -> list:
    now = tr.now
    out = []
    verb = "applying it" if subject == "This write" else "delivering it"
    ordered = sorted(cmps, key=lambda c: -int(bool(c["revert_of"] or c["user"])))  # stable, like Array.sort
    shown = 0
    for c in ordered:
        if c["same"] or shown >= 3:
            continue
        p = c["path"]
        if c["user"]:
            n, last = c["user"]
            d = string_diff(_json_str(c["current"]), _json_str(c["incoming"]))
            change = d or f"{c['current']} → {c['incoming']}"
            out.append(F(f"{subject} would replace text the user typed into {p} after #{x.id} started ({plural(n, 'user write')}, "
                         f"the last {secs(now - last.t)} ago): {change}.", "versions", False))
            shown += 1
            continue
        if c["revert_of"] is not None:
            h = c["revert_of"]
            w = tr.ops.get(h.op)
            wt = label(w) if w is not None else "an operation that is no longer tracked"
            st = f" (it started {'after' if w.start > x.start else 'before'} #{x.id})" if w is not None and w.start != x.start else ""
            out.append(F(f"{subject} has {p} = {c['incoming']}, the value that {wt} replaced with {h.summary} {secs(now - h.t)} ago"
                         f"{st}; {verb} would put the older value back.", "versions", False))
            shown += 1
            continue
        if c["others"]:
            st = f", nor the value when #{x.id} started" if c["start"] is not None else ""
            out.append(F(f"{subject} has {p} = {c['incoming']}: neither the current value {c['current']}{st}.", "versions", True))
            shown += 1
    same = [c["path"] for c in cmps if c["same"]]
    if same:
        lst = ", ".join(same) if len(same) <= 3 else f"{', '.join(same[:3])} and {len(same) - 3} more"
        everything = bool(all_fields) and len(same) == len(all_fields)
        out.append(F(f"{subject} matches the current values of everything it is predicted to write ({lst}): {verb} changes nothing."
                     if everything else f"{subject} has the current value of {lst}.", "delta", True))
    return out


def pending_revert_facts(tr: Trace, conflicts: list[dict], cmps: list[dict], subject: str) -> list:
    now = tr.now
    out = []
    for c in conflicts:
        if c["kind"] != "pending" or len(out) >= 2:
            continue
        cmp = next((x for x in cmps if x["path"] == c["path"]), None)
        if cmp is None or cmp["same"]:
            continue
        h = next((w for w in reversed([w for w in tr.writes if w.path == c["path"] and w.t <= now])
                  if (o := tr.ops.get(w.op)) is not None and tr.root_of(o).id == c["writer"].id), None)
        if h is None or value_before(tr, c["path"], h.t) != cmp["incoming"]:
            continue
        out.append(F(f"{subject} has {c['path']} = {cmp['incoming']}, the value before {label(c['writer'])} changed it to "
                     f"{h.summary} {secs(now - h.t)} ago (its {label(c['pending_op'])} is still in flight); delivering it "
                     f"would undo the user's change.", "versions", False))
    return out


# ------------------------------------------------------------------------------------------------ evidence.ts (v2)

def mark_facts(tr: Trace, spec: dict, paths, mx: int = 2) -> list:
    """F9 stale marks: spec["marks"] = {path: (age_ms, why)} (set by the runtime; absent in most scenarios)."""
    marks = spec.get("marks") or {}
    out, seen = [], set()
    for p in paths:
        if p in seen or len(out) >= mx:
            continue
        seen.add(p)
        if p in marks:
            age, why = marks[p]
            out.append(F(f"{p} holds a value written {secs(age)} ago {why}; nothing has rewritten it since.", "versions", True))
    return out


def cadence_fact(spec: dict, sig: str) -> tuple | None:
    """F6: spec["cadence"] = {"kind": "periodic", "period", "intervals", "next_in"} or {"kind": "debounce", "delay",
    "matching", "of"} (the runtime's learned cadence; absent unless a scenario sets it)."""
    c = spec.get("cadence")
    if not c:
        return None
    if c["kind"] == "periodic":
        d = c["next_in"]
        return F(f"{sig} runs on a schedule: every {secs(c['period'])} (last {plural(c['intervals'], 'interval')}); the next "
                 f"run is {f'due in {secs(d)}' if d >= 0 else f'{secs(-d)} overdue'}.", "baseline", True)
    return F(f"{sig} is usually sent {secs(c['delay'])} after the user's last input ({c['matching']} of the last {c['of']}): "
             f"a later edit is followed by a new request.", "baseline", True)


def host_of_sig(sig: str) -> str:
    where = sig[sig.index(" ") + 1:] if " " in sig else sig
    if where.startswith("/"):
        return "same-origin"
    i = where.find("/")
    return where if i < 0 else where[:i]


def scope_facts(tr: Trace, op: Op, spec: dict) -> list:
    """F5: outcomes of the other endpoints of the same origin in the last 10s; offline (spec["online"] is False)."""
    now = tr.now
    sig = signature(op.method, op.url)
    host = host_of_sig(sig)
    where = "this origin" if host == "same-origin" else host
    recent = []
    for o in tr.requests():
        if o.end is None or o.end > now or now - o.end > 10_000 or o.status == "aborted":
            continue
        s = signature(o.method, o.url)
        if s == sig or host_of_sig(s) != host:
            continue
        outc = str(o.code) if o.code is not None else ("timeout" if o.err == "timeout" else "network")
        recent.append((o.end, s, o.status == "ok", outc))
    recent.sort(key=lambda r: r[0])
    out = []
    failed = [r for r in recent if not r[2]]
    if failed:
        sigs = list(dict.fromkeys(r[1] for r in failed))
        items = ", ".join(f"{r[1]} {'network error' if r[3] == 'network' else r[3]}" for r in failed[-2:])
        ok = len(recent) - len(failed)
        ok_txt = f"; {plural(ok, 'other request')} succeeded" if ok else ""
        out.append(F(f"{plural(len(sigs), 'other endpoint')} of {where} failed in the last 10s ({plural(len(failed), 'failure')}, "
                     f"latest: {items}){ok_txt}.", "outcome", True))
    elif recent:
        n_sigs = len({r[1] for r in recent})
        out.append(F(f"The other endpoints of {where} answered normally in the last 10s ({plural(len(recent), 'request')} to "
                     f"{plural(n_sigs, 'endpoint')}).", "outcome", True))
    if spec.get("online") is False:
        out.append(F("The browser reports that it is offline (navigator.onLine is false).", "outcome", True))
    return out


NOT_PROCESSED = {502, 503, 429, 408}


def commit_ambiguity(op: Op, b) -> str | None:
    """F5 commit ambiguity of a failed state-changing request (None for GET/HEAD/OPTIONS)."""
    m = op.method.upper()
    if m in ("GET", "HEAD", "OPTIONS") or op.end is None:
        return None
    usual = b.med if b else None
    dur = op.end - op.start
    if op.code is not None:
        s = op.code
        if s in NOT_PROCESSED:
            return f"This {m} failed with HTTP {s}, a status servers and gateways usually return without processing the request."
        if s < 500:
            return None
        if usual is not None and dur < usual * 0.5:
            return f"This {m} failed with HTTP {s} after {secs(dur)}, well before its usual {secs(usual)}."
        return (f"This {m} failed with HTTP {s} after {secs(dur)}{f' (usual {secs(usual)})' if usual is not None else ''}: "
                f"the server may have applied it before failing.")
    what = "timed out" if op.err == "timeout" else "failed with a network error"
    if usual is not None and dur < usual * 0.5:
        return f"This {m} {what} after {secs(dur)}, well before its usual {secs(usual)}."
    return (f"This {m} {what} after {secs(dur)}{f', no earlier than its usual {secs(usual)}' if usual is not None else ''}: "
            f"the server may have received and applied it.")


def repeat_evidence(tr: Trace, u1: Op, u2: Op, first_req: Op | None = None, clicks: int | None = None) -> tuple:
    """F7: evidence about a repeated user action (same element, click count, first request in flight, writes between)."""
    if u1.start > u2.start:
        u1, u2 = u2, u1
    parts = []
    if u1.action == u2.action and u1.target == u2.target and u1.target:
        parts.append(f"both are {u1.action}s on {u1.target}")
    if clicks is not None and clicks >= 2:
        parts.append(f"the browser counted #{u2.id} as click {clicks} of a multi-click (MouseEvent.detail)")
    if first_req is not None and first_req.start <= u2.start and (first_req.end is None or first_req.end > u2.start):
        parts.append(f"the request of #{u1.id} (#{first_req.id}) was still in flight at #{u2.id}")
    between = list(dict.fromkeys(w.path for w in tr.writes if u1.start < w.t <= u2.start))
    parts.append(f"between them the app wrote {', '.join(between[:2])}{f' and {len(between) - 2} more' if len(between) > 2 else ''}"
                 if between else "the app changed no state between them")
    return F(f"User actions #{u1.id} and #{u2.id}, {secs(u2.start - u1.start)} apart: {'; '.join(parts)}.", "repetition", True)


def net_of(tr: Trace, op: Op) -> Op | None:
    x = op
    for _ in range(16):
        if x is None:
            return None
        if x.kind in ("fetch", "ws"):
            return x
        x = tr.ops.get(x.cause) if x.cause is not None else None
    return None


# ------------------------------------------------------------------------------------------------ mutation

def mutation_facts(tr: Trace, spec: dict) -> list:
    now = tr.now
    C: Op | None = spec.get("cause")
    paths: list[str] = spec["paths"]
    after = spec.get("after", "?")
    store = spec.get("store") or paths[0].split(".")[0]
    out = [provenance(tr, "This write", C)]
    if C is not None:
        ref = f"this write's cause (#{C.id})"
        Ref = ref[0].upper() + ref[1:]
        out += version_facts(tr, C, paths[:3], ref)
        if "after" in spec:  # what this write puts back / overwrites (F1, F2)
            out += content_facts(tr, C, [compare_field(tr, C, p, after) for p in paths[:6]], "This write")
        net = net_of(tr, C)
        if net is not None and net.kind != "user":
            cf = cadence_fact(spec, signature(net.method, net.url) if net.kind == "fetch" else net.sig)
            if cf:
                out.append(cf)
        out += moved_facts(tr, C, paths, [store], ref)
        out += concurrency_facts(tr, C, ref)
        if C.kind == "fetch" and C.end is not None:
            lat = C.end - C.start
            b = tr.baselines.get(C.sig)
            if b:
                slow = lat > 3 * b.med and lat - b.med >= 100
                out.append(F(f"{Ref} took {secs(lat)}, {ratio(lat, b.med)} its usual {secs(b.med)} (p95 {secs(b.p95)}).",
                             "baseline", not slow))
            if C.status == "error":
                out.append(F(f"{Ref} failed ({status_text(C)}) before this write.", "outcome", True))
    else:  # no cause: an unconfirmed optimistic change of a user action is the only version fact
        for path in paths[:3]:
            pend = pending_conflict(tr, None, path, now)
            if pend:
                out.append(F(f"{path} has a pending local change: {label(pend['writer'])} wrote it {secs(now - pend['t'])} ago "
                             f"and its {label(pend['pending_op'])} is still in flight; this write has no known cause.",
                             "versions", False))
    out += mark_facts(tr, spec, paths)
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
                out.append(repeat_evidence(tr, u2, u1, clicks=spec.get("clicks")))
        out.append(F(f"An identical change to {', '.join(paths)} ({rep['what']}) was applied {secs(now - rep['t'])} ago by "
                     f"{label(w)}{rel_}.", "repetition", not rep.get("additive", True)))
    for p in paths[:3]:
        out.append(F(f"This write would change {p}: {change_text(tr.value(p), after)}.", "delta", True))
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


def failure_counts(tr: Trace, sig_key: str, spec: dict, outs: list[str] | None = None) -> tuple[int, int]:
    """CORE (situation-v1, unchanged in v2): real counts over the last <= 20 outcomes of the signature. The trace only holds the most
    recent ones; older session outcomes (the baseline's samples) fill the window at the baseline's error rate."""
    o = (outs if outs is not None else outcomes_of(tr, sig_key))[-20:]
    b = tr.baselines.get(sig_key)
    rate = float(spec["err_rate"]) if spec.get("err_rate") is not None else (b.err_rate if b else 0.0)
    if spec.get("err_rate") is not None and o:  # scenario-level override (e.g. long-polls: mostly 504 by design)
        of = min(20, max(len(o), b.n if b else len(o)))
        return round(rate * of), of
    failed = sum(1 for x in o if not (x.isdigit() and int(x) < 400))
    older = max(0, min(20, (b.n if b else 0) + len(o)) - len(o)) if b else 0
    return failed + round(rate * older), len(o) + older


def error_rate_text(tr: Trace, sig_key: str, spec: dict, outs: list[str] | None = None) -> str:
    failed, of = failure_counts(tr, sig_key, spec, outs)
    if not of:
        return "no completed requests yet"
    return f"error rate {round(failed / of * 100)}% over {plural(of, 'request')} ({failed} failed)"


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
        r = f"#{last.id} started {secs(abs(op.start - last.start))} {'after' if last.start > op.start else 'before'} this one"
        if u1 and u2 and u1.id == u2.id:
            r += f", from the same user action (#{u1.id})"
        elif u1 and u2:
            r += f"; they come from separate user actions {secs(abs(u1.start - u2.start))} apart"
            out.append(repeat_evidence(tr, u2, u1, last, clicks=spec.get("clicks")))
        elif not u1 and not u2:
            r += ", neither from a user action"
        close = bool(inflight) or (op.start - last.start) < 2000
        listed = f" (latest 3: {'; '.join(items)})" if len(ident) > 3 else f": {'; '.join(items)}"
        out.append(F(f"{plural(len(ident), f'identical {sig} request')} in the last 10s{listed}; {r}.", "repetition",
                     (not close) if trigger == "request" else True))
    same_sig = [o for o in tr.in_flight() if o.id != op.id and signature(o.method, o.url) == sig and o.identity != op.identity]
    if same_sig:
        items = "; ".join(f"#{o.id}{(' ' + truncate(detail(o), 30)) if detail(o) else ''} ({started_rel(o, op)})"
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
        out.append(F(f"{sig} usually answers in {secs(b.med)} (p95 {secs(b.p95)}, {b.n} samples); "
                     f"{error_rate_text(tr, op.sig, spec, outs)}.", "baseline", True))
    if spec.get("cached") and op.method == "GET":
        out.append(F(f"A cached 200 response from {secs(spec.get('cached_ago', 30000))} ago exists for this request.", "cache", True))
    idem = op.method in ("GET", "HEAD", "PUT", "DELETE", "OPTIONS")
    body = "" if op.method in ("GET", "HEAD") else f"; its body ({len(op.body or '')} bytes) can be replayed"
    out.append(F(f"{op.method} {'is' if idem else 'is not'} idempotent{body}.", "request", True))
    return out


def failure_text(op: Op) -> str:
    from world import STATUS_TEXT
    if op.code is not None:
        # Response.statusText is empty for most HTTP/2 responses (and in SIM's server): CORE then prints "HTTP 503"
        with_text = op.code in STATUS_TEXT and (op.id * 2654435761) % 10 < 3
        return f"HTTP {op.code}{(' ' + STATUS_TEXT[op.code]) if with_text else ''}"
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
    out.append(F(f"This is the {ordinal(st)} {sig} failure in a row (recent outcomes: {', '.join(outs[-5:])}; {ls}); "
                 f"{error_rate_text(tr, op.sig, spec, outs)}.", "outcome", True))
    commit = commit_ambiguity(op, tr.baselines.get(op.sig))  # situation-v2 F5/F6
    if commit:
        out.append(F(commit, "outcome", True))
    out += scope_facts(tr, op, spec)
    cf = cadence_fact(spec, sig)
    if cf:
        out.append(cf)
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
    out += scope_facts(tr, op, spec)  # situation-v2 F5/F6
    cf = cadence_fact(spec, sig)
    if cf:
        out.append(cf)
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
                     f"{change_text(value_before(tr, w.path, w.t), w.summary)}.", "versions", True))
    out += mark_facts(tr, spec, spec["fields"])  # situation-v2 F9 (read-your-writes needs create responses: none here)
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
    out += mark_facts(tr, spec, spec.get("chain_fields", []))  # situation-v2 F9
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
            over = sum(1 for p in ps if (lw := tr.last_write(p)) is not None and not same_chain(tr, op, lw.op))
            out.append(F(f"Its chain wrote {', '.join(ps[:4])} before the error"
                         f"{f' ({over} of them overwritten since by other operations)' if over else ''}.", "versions", True))
            out += mark_facts(tr, spec, ps)  # situation-v2 F9
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


# ------------------------------------------------------------------------------------------------ delivery (v2)

P_DELIVERY = 0.5  # share of fetch-response / WS-message mutation scenarios rendered as the v2 `delivery` trigger
DELIVERY_ACTION = {"apply": "deliver", "discard": "discard", "defer": "defer"}


def field_list_text(fs: list[str]) -> str:
    if not fs:
        return "nothing"
    shown, rest = fs[:4], len(fs) - 4
    lst = shown[0] if len(shown) == 1 else f"{', '.join(shown[:-1])} and {shown[-1]}"
    return f"{lst} (+{rest} more)" if rest > 0 else lst


def predicted_text(d: dict) -> str:
    p = d["predicted"]
    resp = d["channel"] == "response"
    who, verb = ("its operation", "writes") if resp else ("messages like it", "write")
    if p["source"] == "profile":
        return f"{who} usually {verb} {field_list_text(p['patterns'])}"
    if p["source"] == "last":
        return f"{who} last wrote {field_list_text(p['patterns'])}"
    return f"no earlier {'completion' if resp else 'message'} shows which state it writes"


def delivery_spec(tr: Trace, spec: dict) -> dict | None:
    """A mutation scenario's spec as a v2 DeliverySpec: the write's cause is a completed fetch (its response is about to
    be delivered) or a WebSocket message. Predicted writes: the profile when the signature has a baseline (its
    completions), else what the last completion wrote. None when the cause is neither."""
    X: Op | None = spec.get("cause")
    if X is None or not ((X.kind == "fetch" and X.end is not None and X.end <= tr.now and X.status == "ok") or X.kind == "ws"):
        return None
    paths = list(spec["paths"])
    pats = sorted(dict.fromkeys(normalize_field_path(p) for p in paths))
    b = tr.baselines.get(X.sig) if X.kind == "fetch" else None
    predicted = ({"patterns": pats, "source": "profile", "seen": b.n, "of": b.n} if b and b.n > 0
                 else {"patterns": pats, "source": "last", "seen": 1, "of": 1})
    d = {"op": X, "channel": "response" if X.kind == "fetch" else "websocket", "predicted": predicted, "matched": paths,
         "conflicts": conflicts_on(tr, X, paths, tr.now), "defers": spec.get("defers", 0), "queued_ahead": 0,
         "incoming": spec.get("after")}
    if X.kind == "fetch":
        d["status"] = X.code
    else:
        d["message"] = {"path": X.target, "summary": spec.get("message_summary", spec.get("after", ""))}
    return d


def related_in_flight(tr: Trace, x: Op, fields: list[str]) -> list[Op]:
    """build.ts relatedInFlight: in-flight ops outside x's chain with x's signature or whose signature wrote these
    fields' stores (in the trace)."""
    stores = {f.split(".")[0] for f in fields}
    wrote = {tr.ops[w.op].sig for w in tr.writes if w.op in tr.ops and w.path.split(".")[0] in stores}
    return [o for o in tr.in_flight() if o.id != x.id and o.kind != "user" and not is_anc_or_self(tr, o, x)
            and not is_anc_or_self(tr, x, o) and (o.sig == x.sig or o.sig in wrote)]


def delivery_facts(tr: Trace, d: dict, spec: dict) -> list:
    now = tr.now
    X: Op = d["op"]
    out = []
    resp = d["channel"] == "response"
    ref = f"its operation (#{X.id})" if resp else f"this message (#{X.id})"
    held = f" and was held {times(d['defers'])} already" if d["defers"] else ""
    if resp:
        dur = (X.end if X.end is not None else now) - X.start
        st = f" ({d['status']})" if d.get("status") is not None else ""
        out.append(F(f"The response to {label(X)} arrived after {secs(dur)}{st}{held}; the app has not seen it yet.", "provenance", True))
        cause = tr.ops.get(X.cause) if X.cause is not None else None
        if cause is not None:
            out.append(provenance(tr, "This request", cause))
    else:
        m = d["message"]
        out.append(F(" ".join(f"A WebSocket message (#{X.id}) {m['summary']} arrived on {m['path'] or 'a stream'}{held}; "
                              f"the app has not seen it yet.".split()), "provenance", True))
        if d["queued_ahead"]:
            q = d["queued_ahead"]
            out.append(F(f"{plural(q, 'earlier message')} of this channel {'is' if q == 1 else 'are'} held ahead of it (order is kept).",
                         "concurrency", True))
    p = d["predicted"]
    if p["source"] == "profile":
        out.append(F(f"In {p['of']} earlier completions of {X.sig} its chain wrote {field_list_text(p['patterns'])} "
                     f"({p['seen']} of {p['of']} wrote state).", "transition", True))
    conflicted = [c["path"] for c in d["conflicts"]]
    rest = [f for f in d["matched"] if f not in conflicted and tr.writes_between(f, X.start)]
    out += version_facts(tr, X, (conflicted + rest)[:3], ref)
    if d.get("incoming") is not None:  # the response's content against the predicted fields (F1-F3)
        subject = "The response" if resp else "This message"
        cmps = [compare_field(tr, X, f, d["incoming"]) for f in d["matched"][:32]]
        out += pending_revert_facts(tr, d["conflicts"], cmps, subject)
        out += content_facts(tr, X, cmps, subject, d["matched"])
    out += mark_facts(tr, spec, conflicted + d["matched"])
    cf = cadence_fact(spec, signature(X.method, X.url) if resp else X.sig)
    if cf:
        out.append(cf)
    stores = list(dict.fromkeys(f.split(".")[0] for f in d["matched"]))
    out += moved_facts(tr, X, d["matched"], stores, ref)
    out += concurrency_facts(tr, X, ref)
    if resp:
        sig = signature(X.method, X.url)
        b = tr.baselines.get(X.sig)
        if b and X.end is not None:
            out.append(F(f"{sig} usually answers in {secs(b.med)} (p95 {secs(b.p95)}).", "baseline", True))
        streak = streak_of(outcomes_of(tr, X.sig, exclude=X.id))
        if streak > 0:
            out.append(F(f"The {plural(streak, f'{sig} request')} before this one failed in a row.", "outcome", True))
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
    if trigger == "delivery":
        d = spec["delivery"]
        if d["channel"] == "response":
            return f"The response to {label(op)} arrived and is about to be delivered; {predicted_text(d)}."
        what = " ".join(f"WebSocket message {d['message']['path']} (#{op.id})".split())
        return f"A {what} arrived and is about to be delivered; {predicted_text(d)}."
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
            out.append(f"{ts} write {truncate(f'{w.path}: {change_text(value_before(tr, w.path, w.t), w.summary)}', 110)} (by #{w.op}{', user' if user else ''})")
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
        failed, of = failure_counts(tr, s, spec if subj is not None and s == subj.sig else {})
        parts = [f"{b.n} done", f"median {secs(b.med)}", f"p95 {secs(b.p95)}", f"{failed} of last {of} failed",
                 f"{recent} in last 10s{f' (usual {fmt_num(round(usual, 2))})' if usual is not None else ''}"]
        rep = next((o for o in tr.requests() if o.sig == s), None)
        sig_txt = signature(rep.method, rep.url) if rep is not None else s
        out.append(f"{sig_txt}: {', '.join(parts)}")
    return out[: LIMITS["stats"]]


# the runtime's "auto" device budgets (situation-v2 runtime.situationBudget): webgpu / unknown 2,400; wasm 1,000 at
# 1 thread to 2,000 at 4 threads (1000 + round((threads-1)*1000/3))
BUDGETS = ((2400, 0.35), (2000, 0.2), (1667, 0.05), (1333, 0.05), (1000, 0.35))
COMPACT_QUESTIONS_MAX = 1400  # CORE: at budgets <= 1,400 chars options are bare labels / names (criteria null)


COMPACT_BUDGET, MIN_BUDGET = 1100, 500


def section_limits(budget: int) -> dict:
    """CORE (situation-v2) serialize.sectionLimits: compact at <= 1,100 chars, full at >= 2,400, linear between."""
    r = min(1.0, max(0.0, (budget - COMPACT_BUDGET) / (STATE_CHAR_BUDGET - COMPACT_BUDGET)))

    def lerp(a, b):  # JS Math.round (half up)
        return int(math.floor(a + (b - a) * r + 0.5))

    return {"facts": lerp(6, 12), "in_flight": lerp(2, 6), "timeline": lerp(3, 16), "state": lerp(3, 8), "stats": lerp(1, 4),
            "line": {"app": lerp(60, 120), "trigger": lerp(180, 240), "facts": lerp(220, 260), "in_flight": lerp(90, 120),
                     "timeline": lerp(100, 140), "state": lerp(100, 150), "stats": lerp(110, 140)}}


def to_state(parts: dict, budget: int = STATE_CHAR_BUDGET) -> dict:
    b = max(MIN_BUDGET, int(round(budget)))
    L = section_limits(b)
    ln = L["line"]
    p = {"app": truncate(parts["app"] or "unknown", ln["app"]), "trigger": truncate(parts["trigger"], ln["trigger"]),
         "facts": [truncate(x, ln["facts"]) for x in parts["facts"][: L["facts"]]],
         "in_flight": [truncate(x, ln["in_flight"]) for x in parts["in_flight"][: L["in_flight"]]],
         "timeline": [truncate(x, ln["timeline"]) for x in (parts["timeline"][-L["timeline"]:] if L["timeline"] else [])],
         "state": [truncate(x, ln["state"]) for x in parts["state"][: L["state"]]],
         "stats": [truncate(x, ln["stats"]) for x in parts["stats"][: L["stats"]]]}

    def build():
        return {k: (v if not isinstance(v, list) else (list(v) if v else "none")) for k, v in p.items()}

    st = build()
    for key, from_start, floor in (("timeline", True, 0), ("state", False, 0), ("facts", False, 1), ("in_flight", False, 0),
                                   ("stats", False, 0)):
        while size_chars(st) > b and len(p[key]) > floor:
            p[key].pop(0 if from_start else -1)
            st = build()
    if size_chars(st) > b and isinstance(st.get("facts"), list):  # pathological: one over-long fact
        over = size_chars(st) - b
        p["facts"] = [truncate(f, max(40, len(f) - over)) for f in p["facts"]]
        st = build()
    return st


def size_chars(st: dict) -> int:
    return sum(len(k) + 2 + len("\n".join(v) if isinstance(v, list) else str(v)) + 1 for k, v in st.items())


def render(sc, app, rng, info: dict | None = None) -> tuple[dict, dict] | None:
    """-> (state, questions) exactly as the runtime builds them, or None when the scenario has no runtime form.

    situation-v2: a mutation scenario whose cause is a completed fetch or a WS message is rendered as a `delivery`
    with probability P_DELIVERY (spec["delivery"] True/False forces it). When `info` is given it receives the rendered
    trigger and the scenario-action -> runtime-action map ({"apply": "deliver", ...} for deliveries)."""
    spec = getattr(sc, "spec", None) or {}
    if not spec or spec.get("no_runtime"):
        return None
    tr: Trace = sc.trace
    trig = sc.trigger
    amap = {a: a for a in sc.actions}
    dspec = None
    if trig == "mutation" and spec.get("delivery", rng.random() < P_DELIVERY) and (dspec := delivery_spec(tr, spec)):
        gold = sc.action if isinstance(sc.action, str) else max(sc.action, key=sc.action.get)
        acts = [a for a in sc.actions if a in DELIVERY_ACTION]
        if "defer" in acts and (dspec["defers"] >= 2 or not related_in_flight(tr, dspec["op"], dspec["matched"])):
            acts.remove("defer")  # build.ts builtinApplicable: defer only with related work in flight
        if gold in acts:
            trig = "delivery"
            amap = {a: DELIVERY_ACTION[a] for a in acts}
    if trig == "delivery":
        subj = dspec["op"]
        fs = delivery_facts(tr, dspec, spec)
        paths = list(spec["paths"]) + [p for p in spec.get("state_extra", []) if p not in spec["paths"]]
        spec = {**spec, "delivery": dspec}
    elif trig == "mutation":
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
    import os
    forced = os.environ.get("GC_RT_BUDGET")  # analysis: render every row at one budget
    budget = int(forced) if forced else (spec.get("budget") or rng.choices([b for b, _ in BUDGETS], [w for _, w in BUDGETS])[0])
    state = to_state(parts, budget)
    acts = [a for a in TRIGGER_ACTIONS[trig] if a in amap.values()]
    compact = budget <= COMPACT_QUESTIONS_MAX
    questions = {"diagnosis": {"type": "choice", "instructions": DIAG_INSTR,
                               "criteria": {k: (None if compact else v) for k, v in DIAGNOSES.items()}}}
    if len(acts) > 1:
        desc = TRIGGER_DESCRIPTIONS.get(trig, {})
        questions["action"] = {"type": "choice", "instructions": ACTION_INSTR[trig],
                               "criteria": {a: (None if compact else desc.get(a, ACTIONS[a])) for a in acts}}
    if info is not None:
        info["trigger"] = trig
        info["action_map"] = amap
    return state, questions
