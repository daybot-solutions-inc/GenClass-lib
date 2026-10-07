"""A tiny explicit world: ops (user actions, requests), field writes with versions, extra events, baselines.

Scenario code builds a Trace with exact times; `render_*` turns it into situation text in one of several surface
styles (fmt.Style). Ground truth for every question comes from the Trace, never from the rendered text.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field

from fmt import Style

USER_VERB = {"click": "clicked", "input": "typed in", "submit": "submitted", "dblclick": "double-clicked",
             "keydown": "pressed Enter in", "scroll": "scrolled", "change": "changed", "blur": "left",
             "nav": "navigated to", "drop": "dropped a card on"}


@dataclass
class Op:
    id: int
    kind: str  # user | fetch | timer | ws | task | load
    start: float
    method: str = ""
    url: str = ""
    sig: str = ""
    body: str = ""
    end: float | None = None
    status: str | None = None  # ok | error | aborted
    code: int | None = None
    err: str = ""  # "timeout" | "network error" | "" (http errors use code)
    cause: int | None = None
    root: int | None = None
    action: str = ""  # user ops
    target: str = ""
    value: str = ""
    attempt: int = 1

    @property
    def req(self) -> str:
        return f"{self.method} {self.url}" if self.method else self.sig

    @property
    def identity(self) -> str:
        return f"{self.method} {self.url} {self.body}"

    @property
    def idempotent(self) -> bool:
        return self.method in ("GET", "HEAD", "PUT", "DELETE", "OPTIONS")


@dataclass
class Write:
    t: float
    path: str
    version: int
    op: int
    summary: str


@dataclass
class Extra:
    t: float
    kind: str  # error | nav | custom | offline
    text: str


@dataclass
class Baseline:
    sig: str
    med: float
    p95: float
    err_rate: float
    n: int


class Trace:
    def __init__(self, rng: random.Random, now: float = 0.0):
        self.rng = rng
        self.ops: dict[int, Op] = {}
        self.writes: list[Write] = []
        self.extras: list[Extra] = []
        self.version0: dict[str, int] = {}  # version before the first write in the trace
        self.values0: dict[str, str] = {}
        self.baselines: dict[str, Baseline] = {}
        self.next_id = rng.randint(3, 400)
        self.now = now

    # ------------------------------------------------------------------ building

    def _new(self, **kw) -> Op:
        op = Op(id=self.next_id, **kw)
        self.next_id += self.rng.choice((1, 1, 1, 2, 3))
        if op.cause is not None and op.cause in self.ops:
            c = self.ops[op.cause]
            op.root = c.root if c.root is not None else c.id
        self.ops[op.id] = op
        return op

    def user(self, t: float, action: str, target: str, value: str = "") -> Op:
        return self._new(kind="user", start=t, end=t, status="ok", action=action, target=target, value=value)

    def timer(self, t: float, name: str = "interval") -> Op:
        return self._new(kind="timer", start=t, end=t, status="ok", target=name)

    def fetch(self, t: float, method: str, url: str, sig: str, body: str = "", cause: Op | None = None,
              attempt: int = 1) -> Op:
        return self._new(kind="fetch", start=t, method=method, url=url, sig=sig, body=body,
                         cause=cause.id if cause else None, attempt=attempt)

    def finish(self, op: Op, t: float, code: int | None = 200, err: str = "") -> Op:
        op.end = t
        op.code = code
        op.err = err
        op.status = "ok" if (code is not None and code < 400 and not err) else "error"
        return op

    def abort(self, op: Op, t: float) -> Op:
        op.end, op.status = t, "aborted"
        return op

    def init_field(self, path: str, version: int, value: str) -> None:
        self.version0[path] = version
        self.values0[path] = value

    def write(self, t: float, path: str, op: Op, summary: str) -> Write:
        v = self.version(path, t) + 1
        w = Write(t, path, v, op.id, summary)
        self.writes.append(w)
        self.writes.sort(key=lambda x: x.t)
        return w

    def extra(self, t: float, kind: str, text: str) -> None:
        self.extras.append(Extra(t, kind, text))

    def baseline(self, sig: str, med: float, p95: float, err_rate: float, n: int) -> Baseline:
        b = Baseline(sig, med, p95, err_rate, n)
        self.baselines[sig] = b
        return b

    # ------------------------------------------------------------------ queries (ground truth)

    def version(self, path: str, t: float | None = None) -> int:
        t = self.now if t is None else t
        v = self.version0.get(path, 0)
        for w in self.writes:
            if w.path == path and w.t <= t:
                v = w.version
        return v

    def writes_between(self, path: str, t0: float, t1: float | None = None) -> list[Write]:
        t1 = self.now if t1 is None else t1
        return [w for w in self.writes if w.path == path and t0 < w.t <= t1]

    def last_write(self, path: str) -> Write | None:
        ws = [w for w in self.writes if w.path == path and w.t <= self.now]
        return ws[-1] if ws else None

    def value(self, path: str) -> str:
        w = self.last_write(path)
        return w.summary if w else self.values0.get(path, "?")

    def in_flight(self, t: float | None = None) -> list[Op]:
        t = self.now if t is None else t
        # strictly before t: a request created exactly now (a `request` trigger subject) has not been sent yet
        return [o for o in self.ops.values() if o.kind == "fetch" and o.start < t and (o.end is None or o.end > t)]

    def requests(self) -> list[Op]:
        return sorted((o for o in self.ops.values() if o.kind == "fetch" and o.start <= self.now), key=lambda o: o.start)

    def users(self) -> list[Op]:
        return sorted((o for o in self.ops.values() if o.kind == "user" and o.start <= self.now), key=lambda o: o.start)

    def root_of(self, op: Op) -> Op:
        return self.ops[op.root] if op.root is not None else op

    # ------------------------------------------------------------------ descriptions

    def root_desc(self, op: Op) -> str:
        r = self.root_of(op)
        if r.kind == "user":
            if r.action == "input" and r.value:
                return f'input on {r.target} ("{r.value}")'
            return {"click": f"a click on {r.target}", "dblclick": f"a double-click on {r.target}",
                    "submit": f"submit of {r.target}", "keydown": f"Enter in {r.target}",
                    "scroll": f"scrolling {r.target}", "nav": f"navigation to {r.target}",
                    "change": f"a change of {r.target}", "blur": f"leaving {r.target}",
                    "drop": f"a drop on {r.target}"}.get(r.action, f"{r.action} {r.target}")
        if r.kind == "timer":
            return f"a timer ({r.target})"
        if r.kind == "load":
            return "page load"
        if r.kind == "fetch":
            return f"the app's retry loop of {r.req}" if r is not op else f"{r.req} (no user action)"
        if r.kind == "ws":
            return f"a live update ({r.target})"
        return f"{r.kind} {r.target}".strip()


# ---------------------------------------------------------------------------------------------- rendering


def _what_failed(op: Op) -> str:
    if op.err:
        return op.err
    return f"{op.code}"


STATUS_TEXT = {200: "OK", 201: "Created", 204: "No Content", 304: "Not Modified", 400: "Bad Request",
               401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 408: "Request Timeout", 409: "Conflict",
               410: "Gone", 412: "Precondition Failed", 413: "Payload Too Large", 422: "Unprocessable Entity",
               425: "Too Early", 429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway",
               503: "Service Unavailable", 504: "Gateway Timeout"}


def status_phrase(op: Op, st: Style, long: bool = False) -> str:
    if op.err:
        return op.err
    if long and op.code in STATUS_TEXT:
        return f"{op.code} {STATUS_TEXT[op.code]}"
    return str(op.code)


def _events(tr: Trace) -> list[tuple[float, int, str, object]]:
    ev: list[tuple[float, int, str, object]] = []
    for o in tr.ops.values():
        if o.start <= tr.now:
            ev.append((o.start, 0, "user" if o.kind == "user" else ("start" if o.kind == "fetch" else o.kind), o))
        if o.kind == "fetch" and o.end is not None and o.end <= tr.now:
            ev.append((o.end, 1, "end", o))
    for w in tr.writes:
        if w.t <= tr.now:
            ev.append((w.t, 2, "write", w))
    for x in tr.extras:
        if x.t <= tr.now:
            ev.append((x.t, 3, "extra", x))
    ev.sort(key=lambda e: (e[0], e[1]))
    return ev


def render_timeline(tr: Trace, st: Style, limit: int = 16) -> list[str]:
    out = []
    for t, _, kind, obj in _events(tr)[-limit:]:
        ts = st.t(tr.now - t)
        f = st.line_fmt
        if kind == "user":
            o = obj
            val = f' "{o.value}"' if o.value else ""
            out.append({"A": f"{ts} user {o.action} {o.target}{val}",
                        "B": f"[{ts}] {o.action} {o.target}{val}",
                        "C": f"{ts}: the user {USER_VERB.get(o.action, o.action)} {o.target}{val}",
                        "D": f"{ts} USER {o.action.upper()} {o.target}{val}"}[f])
        elif kind == "start":
            o = obj
            body = f" {o.body}" if o.body else ""
            cz = ""
            if o.cause is not None and o.cause in tr.ops:
                c = tr.ops[o.cause]
                cdesc = f"{st.op(c.id)} {c.action} {c.target}".strip() if c.kind == "user" else st.op(c.id)
                cz = {"A": f" (cause: {cdesc})", "B": f", from {cdesc}", "C": f" because of {cdesc}",
                      "D": f" <- {cdesc}"}[f]
            att = f" attempt {o.attempt}" if o.attempt > 1 else ""
            out.append({"A": f"{ts} {st.op(o.id)} start {o.req}{body}{cz}{att}",
                        "B": f"[{ts}] → {o.req}{body} ({st.op(o.id)}{cz}){att}",
                        "C": f"{ts}: {st.op(o.id)} sent {o.req}{body}{cz}{att}",
                        "D": f"{ts} >> {st.op(o.id)} {o.req}{body}{cz}{att}"}[f])
        elif kind == "end":
            o = obj
            d = st.dur(o.end - o.start)
            if o.status == "aborted":
                out.append({"A": f"{ts} {st.op(o.id)} aborted ({d})", "B": f"[{ts}] ✕ {o.req} aborted ({st.op(o.id)}, {d})",
                            "C": f"{ts}: {st.op(o.id)} was aborted after {d}",
                            "D": f"{ts} << {st.op(o.id)} ABORTED {d}"}[f])
            elif o.status == "ok":
                out.append({"A": f"{ts} {st.op(o.id)} end {o.code} ({d})", "B": f"[{ts}] ← {o.code} {o.req} ({st.op(o.id)}, {d})",
                            "C": f"{ts}: {st.op(o.id)} returned {o.code} after {d}",
                            "D": f"{ts} << {st.op(o.id)} {o.code} {d}"}[f])
            else:
                w = status_phrase(o, st)
                out.append({"A": f"{ts} {st.op(o.id)} failed {w} ({d})", "B": f"[{ts}] ← {w} {o.req} ({st.op(o.id)}, {d})",
                            "C": f"{ts}: {st.op(o.id)} failed ({w}) after {d}",
                            "D": f"{ts} << {st.op(o.id)} FAIL {w} {d}"}[f])
        elif kind == "write":
            w = obj
            wo = tr.ops.get(w.op)
            by = (f"user input {wo.target}" if wo is not None and wo.kind == "user" else st.op(w.op))
            out.append({"A": f"{ts} state {w.path} v{w.version} ← {by}", "B": f"[{ts}] set {w.path} (v{w.version}) by {by}",
                        "C": f"{ts}: {w.path} updated to v{w.version} by {by}",
                        "D": f"{ts} == {w.path}@v{w.version} {by}"}[f])
        elif kind == "extra":
            x = obj
            out.append({"A": f"{ts} {x.kind} {x.text}", "B": f"[{ts}] {x.kind}: {x.text}", "C": f"{ts}: {x.kind} — {x.text}",
                        "D": f"{ts} {x.kind.upper()} {x.text}"}[f])
        else:  # timer / load / ws ops
            o = obj
            out.append({"A": f"{ts} {o.kind} {o.target}", "B": f"[{ts}] {o.kind} {o.target}", "C": f"{ts}: {o.kind} {o.target}",
                        "D": f"{ts} {o.kind.upper()} {o.target}"}[f])
    return out


def render_in_flight(tr: Trace, st: Style, limit: int = 6, exclude: tuple[int, ...] = ()) -> list[str] | str:
    ops = [o for o in tr.in_flight() if o.id not in exclude][:limit]
    if not ops:
        return "none"
    out = []
    for o in ops:
        cz = f", cause: {tr.root_desc(o)}" if o.cause is not None else ""
        body = f" {o.body}" if o.body else ""
        out.append(f"{st.op(o.id)} {o.req}{body} (started {st.ago(tr.now - o.start)}{cz})")
    return out


def render_state_line(tr: Trace, st: Style, path: str) -> str:
    w = tr.last_write(path)
    v = tr.version(path)
    if w is None:
        return f"{path}: {tr.values0.get(path, '?')} (v{v})"
    wo = tr.ops.get(w.op)
    by = f"user input {wo.target}" if wo is not None and wo.kind == "user" else st.op(w.op)
    return f"{path}: {w.summary} (v{v}, {by}, {st.ago(tr.now - w.t)})"


def render_stats(tr: Trace, st: Style, sigs: list[str]) -> list[str] | str:
    out = []
    for s in sigs:
        b = tr.baselines.get(s)
        if b is None:
            continue
        out.append(f"{s}: median {st.dur(b.med)}, p95 {st.dur(b.p95)}, error rate {b.err_rate * 100:.1f}% ({b.n} calls)")
    return out or "none"
