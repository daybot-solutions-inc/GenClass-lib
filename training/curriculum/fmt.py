"""Surface variation: per-row style (op refs, time/duration formats, key names) and paraphrase templates.

Templates: TEMPLATES[key] is a list; the trailing `held` ones (≈20%, at least one when a list has ≥ 4 entries) are
test-only, so the test split also measures robustness to unseen phrasings. `pick(rng, key, test)` returns one.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

CANONICAL_KEYS = ("app", "trigger", "facts", "in_flight", "timeline", "state", "stats")
KEY_VARIANTS = {
    "app": ("app", "page", "application", "context", "where"),
    "trigger": ("trigger", "subject", "event", "situation", "now"),
    "facts": ("facts", "observations", "evidence", "signals", "findings"),
    "in_flight": ("in_flight", "pending", "running", "in progress", "open requests"),
    "timeline": ("timeline", "recent events", "history", "log", "events"),
    "state": ("state", "stores", "data", "store values", "fields"),
    "stats": ("stats", "baselines", "metrics", "usual behaviour", "history stats"),
}


def held_count(n: int) -> int:
    return max(1, round(n * 0.2)) if n >= 4 else 0


def pick_from(rng: random.Random, items: list | tuple, test: bool):
    """Train rows never see the trailing held-out entries; test rows draw from all (held-out half the time)."""
    h = held_count(len(items))
    if not test or h == 0:
        return items[rng.randrange(len(items) - h)]
    if rng.random() < 0.5:
        return items[len(items) - h + rng.randrange(h)]
    return items[rng.randrange(len(items))]


@dataclass
class Style:
    rng: random.Random
    test: bool
    op_fmt: str
    time_fmt: str
    dur_fmt: str
    line_fmt: str
    keys: dict
    sep_thousands: bool
    clock0: float  # ms of day at session start (clock style)
    session_ms: float

    @classmethod
    def make(cls, rng: random.Random, test: bool, canonical: float = 0.55) -> "Style":
        canon = rng.random() < canonical
        op_fmt = "op {n}" if canon or rng.random() < 0.4 else pick_from(rng, ("#{n}", "op#{n}", "req {n}", "op {n}",
                                                                              "[{n}]", "op-{n}"), test)
        time_fmt = "rel_s" if canon or rng.random() < 0.3 else pick_from(rng, ("rel_ms", "ago", "clock", "offset",
                                                                               "rel_s", "t_minus"), test)
        dur_fmt = "s" if canon else rng.choice(("s", "ms", "auto"))
        line_fmt = "A" if canon or rng.random() < 0.35 else pick_from(rng, ("B", "C", "A", "D"), test)
        if canon or rng.random() < 0.5:
            keys = {k: k for k in CANONICAL_KEYS}
        else:
            keys = {k: pick_from(rng, KEY_VARIANTS[k], test) for k in CANONICAL_KEYS}
        return cls(rng, test, op_fmt, time_fmt, dur_fmt, line_fmt, keys, rng.random() < 0.5,
                   rng.uniform(8, 20) * 3600e3, rng.uniform(20e3, 600e3))

    # ------------------------------------------------------------------ formatting

    def op(self, n: int) -> str:
        return self.op_fmt.format(n=n)

    def num(self, x: float, dec: int = 0) -> str:
        s = f"{x:,.{dec}f}" if self.sep_thousands else f"{x:.{dec}f}"
        return s

    def dur(self, ms: float) -> str:
        f = self.dur_fmt
        if f == "auto":
            f = "ms" if ms < 1000 else "s"
        if f == "ms":
            return f"{self.num(ms)} ms"
        return f"{ms / 1000:.2f} s" if ms < 10_000 else f"{ms / 1000:.1f} s"

    def ago(self, ms: float) -> str:
        """'1.82 s ago' style (facts)."""
        return f"{self.dur(ms)} ago"

    def t(self, rel_ms: float) -> str:
        """Timeline time stamp for an event `rel_ms` before now (rel_ms >= 0)."""
        f = self.time_fmt
        if f == "rel_s":
            return f"-{rel_ms / 1000:.2f}s"
        if f == "rel_ms":
            return f"-{rel_ms:.0f}ms"
        if f == "t_minus":
            return f"t-{rel_ms:.0f}ms"
        if f == "ago":
            return f"{rel_ms / 1000:.2f}s ago"
        if f == "offset":
            return f"+{(self.session_ms - rel_ms) / 1000:.3f}s"
        ms = self.clock0 + self.session_ms - rel_ms
        h, rem = divmod(int(ms), 3600_000)
        m, rem = divmod(rem, 60_000)
        s, msec = divmod(rem, 1000)
        return f"{h:02d}:{m:02d}:{s:02d}.{msec:03d}"

    def key(self, k: str) -> str:
        return self.keys[k]


def pick(rng: random.Random, key: str, test: bool, **kw) -> str:
    return pick_from(rng, TEMPLATES[key], test).format(**kw)


# Fact and question templates. Placeholders are filled by the scenario code. Keep the held-out (trailing) entries
# meaningfully different in wording.
TEMPLATES: dict[str, list[str]] = {
    # ---------------------------------------------------------------- provenance
    "prov_write": [
        "This write comes from {req} ({op}), started {ago} by {root}.",
        "The pending write was produced by {req} ({op}); that request began {ago}, caused by {root}.",
        "Source of this write: {req} ({op}), sent {ago} after {root}.",
        "{op} ({req}) produced this write; it started {ago} because of {root}.",
        "Write origin: {op} {req}, launched {ago}, root cause {root}.",
    ],
    "prov_req": [
        "This request was caused by {root} {ago}.",
        "{req} is being sent because of {root} ({ago}).",
        "Cause: {root}, {ago}.",
        "The app issued this request in response to {root}, {ago}.",
        "Triggered by {root} ({ago}).",
    ],
    # ---------------------------------------------------------------- versions
    "ver_moved": [
        "{path} was at version {v0} when {op} started; it is now at version {v1}.",
        "When {op} began, {path} was v{v0}; it is v{v1} now.",
        "{path}: v{v0} at the start of {op}, currently v{v1}.",
        "Since {op} started, {path} advanced from version {v0} to version {v1}.",
        "Version of {path} then/now: {v0} → {v1}.",
    ],
    "ver_same": [
        "{path} is still at version {v0}, the same as when {op} started.",
        "{path} has not changed since {op} started (v{v0}).",
        "No write to {path} since {op} began; it is at v{v0}.",
        "{path} unchanged since the start of {op} (version {v0}).",
        "Version of {path} then/now: {v0} → {v0}.",
    ],
    "ver_writer_newer": [
        "Version {v} of {path} was written by {req} ({wop}), which started {gap} after {op}, from {wroot}.",
        "{wop} ({req}) wrote {path} v{v}; it was sent {gap} later than {op}, caused by {wroot}.",
        "{path} v{v} came from {wop} {req}, started {gap} after {op} (cause: {wroot}).",
        "A newer operation, {wop} ({req}, started {gap} after {op} by {wroot}), wrote version {v} of {path}.",
        "{path} v{v} ← {wop}; {wop} began {gap} after {op}; root: {wroot}.",
    ],
    "ver_writer_older": [
        "Version {v} of {path} was written by {req} ({wop}), which started {gap} before {op}, from {wroot}.",
        "{wop} ({req}) wrote {path} v{v}; it was sent {gap} earlier than {op}, caused by {wroot}.",
        "{path} v{v} came from {wop} {req}, started {gap} before {op} (cause: {wroot}).",
        "An older operation, {wop} ({req}, started {gap} before {op} by {wroot}), wrote version {v} of {path}.",
        "{path} v{v} ← {wop}; {wop} began {gap} before {op}; root: {wroot}.",
    ],
    "ver_writer_same_root": [
        "Version {v} of {path} was written by {wop}, part of the same {wroot} that caused {op}.",
        "{path} v{v} was set by {wop} from the same user action as {op} ({wroot}).",
        "{wop} (same root as {op}: {wroot}) wrote {path} v{v}.",
        "The newer version {v} of {path} came from {op}'s own chain ({wop}, {wroot}).",
        "{path} v{v} ← {wop}, same root as {op} ({wroot}).",
    ],
    "ver_writer_user": [
        "Version {v} of {path} was written by user input on {target} {ago}, after {op} started.",
        "The user edited {path} (v{v}, input on {target}) {ago}, while {op} was in flight.",
        "{path} v{v} came from typing in {target} {ago}, after {op} was sent.",
        "After {op} started, the user changed {path} via {target} (now v{v}, {ago}).",
        "{path} v{v} ← user input on {target} ({ago}).",
    ],
    "inputs_moved": [
        "{path} changed from {before} to {after} since {op} started ({who}, {ago}).",
        "The input {path} is now {after}; it was {before} when {op} started (changed by {who} {ago}).",
        "Since {op} began, {who} changed {path}: {before} → {after} ({ago}).",
        "{op} was built from {path} = {before}, but {path} is now {after} ({who}, {ago}).",
        "Input moved: {path} {before} → {after} by {who} {ago}.",
    ],
    # ---------------------------------------------------------------- concurrency
    "concurrent_same": [
        "{other} ({oreq}) touches {path} too; it started {gap} {rel} {op} and is still in flight.",
        "Another request on {path}, {other} {oreq}, is in flight; it was sent {gap} {rel} {op}.",
        "{other} ({oreq}, in flight) also writes {path}; started {gap} {rel} {op}.",
        "In flight on the same field: {other} {oreq}, started {gap} {rel} {op}.",
        "Concurrent: {other} {oreq} → {path}, {gap} {rel} {op}, not finished.",
    ],
    # ---------------------------------------------------------------- repetition
    "rep_identical_req": [
        "An identical {req} (same body) was sent {ago} from {same} and is {state}.",
        "The same request ({req}, identical body) went out {ago}; it came from {same} and is {state}.",
        "{prev} is identical to this request (same method, URL and body), sent {ago} from {same}; it is {state}.",
        "Identical request {prev} {ago} ({same}), {state}.",
        "Duplicate candidate: {prev} {req}, {ago}, {same}, {state}.",
    ],
    "rep_identical_change": [
        "An identical change to {path} (same value) was applied {ago} from {same}.",
        "{path} received the same change {ago}, from {same}.",
        "The same update to {path} already happened {ago} ({same}).",
        "Identical change to {path} {ago} ({same}).",
        "Repeat of an earlier change to {path} ({ago}, {same}).",
    ],
    "rep_count": [
        "{sig} was sent {n} times in the last {win}; usual rate is {usual}.",
        "In the last {win}, {sig} went out {n} times (usually {usual}).",
        "{n} × {sig} within {win}; the learned rate is {usual}.",
        "Request frequency for {sig}: {n} in {win} vs {usual} normally.",
        "{sig}: {n} sends / {win} (baseline {usual}).",
    ],
    # ---------------------------------------------------------------- outcomes
    "streak": [
        "{sig} has failed {n} times in a row ({codes}); last success {ago}.",
        "The last {n} attempts of {sig} failed ({codes}); it last succeeded {ago}.",
        "{sig}: {n} consecutive failures ({codes}), last OK {ago}.",
        "Failure streak for {sig}: {n} ({codes}); previous success {ago}.",
        "{sig} keeps failing: {codes} ({n} in a row, last success {ago}).",
    ],
    "streak_none": [
        "{sig} succeeded the last {n} times; error rate {rate}.",
        "No recent failures for {sig} ({n} successes in a row, error rate {rate}).",
        "{sig} is healthy: last {n} calls OK, error rate {rate}.",
        "{sig}: {n} successes in a row (error rate {rate}).",
        "Recent outcomes of {sig}: all {n} succeeded; error rate {rate}.",
    ],
    "failure_now": [
        "{req} failed with {what} after {dur}.",
        "This attempt of {req} ended in {what} ({dur}).",
        "{req} → {what} after {dur}.",
        "Result of {req}: {what}, {dur}.",
        "{what} for {req} ({dur} after it was sent).",
    ],
    # ---------------------------------------------------------------- baselines
    "lat_ratio": [
        "{req} has taken {el} so far; usual median {med}, p95 {p95} ({ratio}× the median).",
        "Elapsed {el} for {req}; it normally takes {med} (p95 {p95}), so {ratio}× the median.",
        "{req} is at {el}; learned median {med}, p95 {p95}: {ratio}× median.",
        "Latency so far {el} vs typical {med} (p95 {p95}) for {req} — {ratio}×.",
        "{req}: {el} elapsed, baseline median {med} / p95 {p95} → {ratio}×.",
    ],
    "lat_done": [
        "{req} took {el}; usual median {med}, p95 {p95}.",
        "Duration of {req}: {el} (median {med}, p95 {p95}).",
        "{req} finished in {el}; it normally takes {med} (p95 {p95}).",
        "{req} completed after {el} vs a usual {med} (p95 {p95}).",
        "{req}: {el} (baseline {med}, p95 {p95}).",
    ],
    "others_fast": [
        "Other requests to the same API finished normally in the last {win} ({k} of {n} under their p95).",
        "The rest of the API is responsive: {k}/{n} recent requests were within their usual latency.",
        "Other endpoints are fine right now ({k} of the last {n} requests were normal).",
        "Concurrent traffic to the API is healthy ({k}/{n} within p95).",
        "Rest of API normal: {k}/{n} in p95 over {win}.",
    ],
    "others_slow": [
        "Other requests to the same API are also slow ({k} of the last {n} exceeded their p95).",
        "The whole API seems degraded: {k}/{n} recent requests were slower than their p95.",
        "Most other endpoints are slow too ({k} of {n} recent requests over p95).",
        "Concurrent traffic is slow as well ({k}/{n} over p95).",
        "API-wide slowdown: {k}/{n} beyond p95.",
    ],
    # ---------------------------------------------------------------- invariants / transitions
    "inv_violated": [
        "Learned invariant {rel} is violated: {lhs} vs {rhs} (held at {n} settled points).",
        "The relation {rel} held at {n} settled points but now fails ({lhs} ≠ {rhs}).",
        "{rel} no longer holds: left side {lhs}, right side {rhs} (learned from {n} snapshots).",
        "Invariant broken: {rel} ({lhs} vs {rhs}); previously true {n} times.",
        "{rel}: {lhs} != {rhs} now (was true at {n} settled points).",
    ],
    "inv_mutation": [
        "It broke after {what} ({ago}).",
        "The violation appeared right after {what}, {ago}.",
        "Last change before the violation: {what} ({ago}).",
        "{what} happened {ago}, just before the relation broke.",
        "Broken by: {what} ({ago}).",
    ],
    "inv_consistent_age": [
        "The last consistent snapshot of {store} is {age} old.",
        "{store} was last fully consistent {age} ago.",
        "A consistent snapshot of {store} exists from {age} ago.",
        "Last snapshot where all relations held: {age} ago ({store}).",
        "{store}: consistent snapshot available ({age} old).",
    ],
    "trans_shape": [
        "In the previous {n} completions of {sig} it wrote {usual}; this time it wrote {now}.",
        "{sig} usually writes {usual} ({k} of {n} completions); this time: {now}.",
        "Normally {sig} updates {usual} ({k}/{n}); this completion updated {now}.",
        "This {sig} completion wrote {now}, a shape seen {seen} in {n} previous completions (usual: {usual}).",
        "{sig}: usual writes {usual} ({k}/{n}); now {now}.",
    ],
    "delta": [
        "{path}: {before} → {after}.",
        "{path} would change from {before} to {after}.",
        "Change to {path}: {before} → {after}.",
        "{path} {before} ⇒ {after}.",
        "Delta {path}: {before} -> {after}.",
    ],
    "cached": [
        "A cached good response for {sig} exists (from {ago}, {size}).",
        "The last successful response of {sig} is cached ({ago}, {size}).",
        "Cached copy available for {sig}: {ago}, {size}.",
        "{sig} has a cached 200 response from {ago} ({size}).",
        "Cache: {sig} ok response, {ago}, {size}.",
    ],
    "offline": [
        "The browser went offline {ago} and has not come back online.",
        "navigator.onLine became false {ago}.",
        "Network connectivity was lost {ago}.",
        "Offline since {ago}.",
        "Connection dropped {ago} (offline event).",
    ],
    "app_retry": [
        "The app itself already retried this request {n} times (attempt {a}).",
        "This is attempt {a}; the application retries it on its own.",
        "Application-level retry: attempt {a} of this request.",
        "{req} is the app's own retry #{n}.",
        "Attempt {a} (app retry loop).",
    ],
}

ACTION_DESC = {  # canonical (CONTRACT §7) first, then paraphrases; the last ones are held out for test
    "apply": ["let this write update the state now", "apply the write to the store now", "let the update go through",
              "allow this state change", "commit the pending change"],
    "discard": ["drop this write and keep the current state", "throw this write away; keep what is in the store",
                "do not apply this update; leave the current value", "skip this write",
                "ignore the incoming value and keep the present state"],
    "defer": ["hold this write until the related in-flight operations finish, then decide again",
              "wait for the other pending operations on this state, then reconsider",
              "postpone this write until concurrent requests settle", "hold the change for now and decide later",
              "keep the write pending until related requests complete"],
    "send": ["send the request now", "let the request go out", "proceed with the request", "dispatch it now",
             "issue the request as normal"],
    "coalesce": ["do not send; reuse the result of the identical request that is in flight or just finished",
                 "share the response of the identical request instead of sending another",
                 "merge with the identical pending request", "piggyback on the same request already made",
                 "reuse the duplicate's response rather than sending"],
    "delay": ["wait before sending, backing off so the service can recover", "hold the request briefly and back off",
              "send later with exponential backoff", "slow down: wait, then send",
              "back off before sending to give the server room"],
    "block": ["do not send; fail this request immediately", "refuse to send it and fail fast",
              "cancel the request with an error", "stop this request from going out (fail it)",
              "block the request and return a failure"],
    "serve_cached": ["answer with the last successful response for this request instead",
                     "respond from the cache with the last good response", "use the cached response instead",
                     "return the previously successful result", "serve the stored good response"],
    "deliver": ["pass the failure to the application as it is", "let the app see the error",
                "hand the failure over unchanged", "report the failure to the app normally",
                "do nothing special; the app gets the error"],
    "retry": ["retry the request after a short backoff", "try the request again shortly",
              "re-send after a brief pause", "attempt it once more after backing off", "retry with a small delay"],
    "wait": ["keep waiting for the request", "continue waiting for the response", "let it run",
             "do nothing and wait", "give it more time"],
    "hedge": ["send a second identical request and use whichever answers first",
              "race a duplicate request and take the first answer", "fire a backup request in parallel",
              "issue a hedged copy and use the fastest", "send a parallel duplicate, first response wins"],
    "ignore": ["leave the state as it is", "do nothing", "take no action", "keep everything unchanged",
               "no intervention"],
    "rollback": ["restore the affected state to its last consistent snapshot", "roll the store back to the last good snapshot",
                 "revert to the last consistent state", "undo back to the last snapshot where relations held",
                 "restore the previous consistent values"],
    "resync": ["reload the affected state from its source", "refetch the store from the server",
               "resynchronise the state with its source", "re-load the data from the backend",
               "pull fresh data from the source"],
}

DIAG_DESC = {
    "expected": ["normal behaviour, nothing is wrong", "everything is fine; this is how it normally works",
                 "no problem here", "working as intended", "benign: nothing to fix"],
    "stale": ["outdated data or an older operation is about to replace newer state",
              "old data is about to overwrite newer data", "an out-of-date result is arriving after a newer one",
              "the result belongs to an older request than the current state", "superseded data"],
    "conflict": ["concurrent operations are competing over the same state or resource",
                 "two in-flight operations fight over the same data", "competing concurrent updates",
                 "simultaneous writers on the same field", "a race between concurrent changes"],
    "duplicate": ["the same change or request is happening again without a new intent",
                  "an accidental repeat of the same request or change", "a double submission or double write",
                  "the identical operation is being repeated unintentionally", "repeated without a new user intent"],
    "inconsistent": ["the state contradicts itself or relationships it normally keeps",
                     "related fields disagree with each other", "the data broke one of its usual relations",
                     "state invariants are violated", "self-contradictory state"],
    "failing": ["an operation keeps failing or its failures follow a pattern", "the operation is failing",
                "repeated errors from the same operation", "a failure pattern (errors, timeouts)",
                "the request is not succeeding"],
    "slow": ["an operation is far slower than usual", "much higher latency than normal", "the request is unusually slow",
             "it is taking far longer than it usually does", "abnormal latency"],
    "overload": ["work is being triggered far more often than usual", "a request storm or runaway loop",
                 "far too many requests compared with normal", "abnormally high request rate",
                 "excessive repeated work"],
    "unusual": ["this differs from how the same operation normally behaves", "an atypical outcome for this operation",
                "the operation behaved unlike its usual pattern", "a novel, never-seen shape of result",
                "out of the ordinary for this operation"],
    "transient": ["a one-off failure that is likely to succeed if tried again", "an isolated blip that should pass",
                  "a single failure, probably fine on a retry", "a momentary glitch, not a pattern",
                  "a one-time error likely to clear up"],
}

DIAGNOSES = tuple(DIAG_DESC)

TRIGGER_ACTIONS = {  # passive first (CONTRACT §6)
    "mutation": ("apply", "discard", "defer"),
    "request": ("send", "coalesce", "delay", "block", "serve_cached"),
    "failure": ("deliver", "retry", "serve_cached"),
    "stall": ("wait", "hedge", "serve_cached"),
    "inconsistency": ("ignore", "rollback", "resync"),
    "transition": ("ignore", "rollback", "resync"),
    "error": ("ignore", "rollback"),
}
PASSIVE = {k: v[0] for k, v in TRIGGER_ACTIONS.items()}
TIER = {"apply": "passive", "send": "passive", "deliver": "passive", "wait": "passive", "ignore": "passive",
        "discard": "guard", "defer": "guard", "coalesce": "guard", "delay": "guard",
        "block": "heal", "serve_cached": "heal", "retry": "heal", "hedge": "heal", "rollback": "heal", "resync": "heal"}

# Extra plugin-like actions that are never the best answer in these scenarios (teach reading descriptions).
DISTRACTOR_ACTIONS = {
    "reload_page": "reload the whole page",
    "notify_user": "show a toast describing the problem to the user",
    "clear_storage": "wipe localStorage and sessionStorage",
    "logout": "sign the user out",
    "open_support_chat": "open the support chat widget",
    "disable_feature": "turn the related feature off for this session",
}

ACTION_INSTR = {
    "mutation": ["What should the runtime do with this write?", "Decide what to do with the pending write to {subj}.",
                 "How should GenClass handle this state update?", "Choose the runtime's action for the held write.",
                 "Pick what happens to this write.", "What should happen with the update to {subj}?"],
    "request": ["What should the runtime do with this request?", "Decide how to handle {subj} before it is sent.",
                "How should GenClass treat this outgoing request?", "Choose the runtime's action for this request.",
                "Pick what to do with {subj}.", "Before sending {subj}, what should happen?"],
    "failure": ["What should the runtime do with this failure?", "Decide how to handle the failed {subj}.",
                "How should GenClass react to this failed request?", "Choose the runtime's action for this failure.",
                "Pick what to do now that {subj} failed.", "{subj} failed. What next?"],
    "stall": ["What should the runtime do with this slow request?", "Decide how to handle {subj}, which is taking long.",
              "How should GenClass treat this stalled request?", "Choose the runtime's action for the stall.",
              "Pick what to do while {subj} is still pending.", "{subj} is still running. What now?"],
    "inconsistency": ["What should the runtime do about this inconsistency?",
                      "Decide how to handle the broken relation in {subj}.",
                      "How should GenClass react to this invariant violation?",
                      "Choose the runtime's action for the inconsistent state.", "Pick what to do about {subj}.",
                      "The state of {subj} broke a relation. What now?"],
    "transition": ["What should the runtime do about this unusual transition?",
                   "Decide how to handle what {subj} just did to the state.",
                   "How should GenClass react to this state transition?",
                   "Choose the runtime's action for this transition.", "Pick what to do after {subj} completed.",
                   "{subj} changed the state unlike usual. What now?"],
    "error": ["What should the runtime do about this error?", "Decide how to handle the uncaught error.",
              "How should GenClass react to this exception?", "Choose the runtime's action for this error.",
              "Pick what to do about the error.", "An uncaught error occurred. What now?"],
}
DIAG_INSTR = ["What is going on here?", "Which diagnosis fits this situation best?", "Diagnose the situation.",
              "What kind of problem, if any, is this?", "Classify what is happening.", "What best describes this?",
              "Which label describes the situation?"]
