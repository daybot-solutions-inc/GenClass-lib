"""Assemble CONTRACT-D rows from scenarios: situation state, standing questions (action, diagnosis), primitives."""

from __future__ import annotations

import random

from app import App
from fmt import (ACTION_DESC, ACTION_INSTR, DIAG_DESC, DIAG_INSTR, DIAGNOSES, DISTRACTOR_ACTIONS, PASSIVE, Style,
                 pick_from)
from scenarios import Scen
from world import render_in_flight, render_state_line, render_stats, render_timeline

RENAMES = {"discard": ("drop", "skip_write"), "defer": ("hold", "postpone"), "coalesce": ("dedupe", "share"),
           "delay": ("backoff", "throttle"), "serve_cached": ("use_cache", "cached"), "retry": ("resend", "try_again"),
           "hedge": ("race", "backup_request"), "rollback": ("restore", "revert"), "resync": ("reload", "refetch"),
           "apply": ("allow", "commit"), "send": ("proceed", "go"), "deliver": ("pass_through", "report"),
           "wait": ("keep_waiting", "continue"), "ignore": ("none", "leave"), "block": ("fail_fast", "deny")}


def situation_state(sc: Scen, app: App, st: Style, rng: random.Random, ask: bool = False) -> dict:
    tr = sc.trace
    facts = list(sc.facts)[:12]
    if rng.random() < 0.25:  # robustness to fact order (the runtime orders most-informative first)
        rng.shuffle(facts)
    state_lines = [render_state_line(tr, st, p) for p in sc.state_paths] + list(sc.extra_state)
    tl = render_timeline(tr, st, limit=16)
    inf = render_in_flight(tr, st, exclude=sc.exclude_inflight)
    stats = render_stats(tr, st, sc.stats_sigs)
    parts = {
        "app": app.app_line(),
        "trigger": sc.subject if not ask else pick_from(rng, ["Developer question about the current situation.",
                                                               "ask", "Question from the app developer."], st.test),
        "facts": facts if facts else "none",
        "in_flight": inf,
        "timeline": tl if tl else "none",
        "state": state_lines[:8] if state_lines else "none",
        "stats": stats,
    }
    order = list(parts)
    drop = set()
    if rng.random() < 0.15:
        drop.add(rng.choice(("in_flight", "stats", "state")))
    if ask and rng.random() < 0.3:
        drop.add("facts")  # ask rows: sometimes only the raw timeline/state, the model must derive the answer
    if rng.random() < 0.1:
        rng.shuffle(order)
    return {st.key(k): parts[k] for k in order if k not in drop}


def action_question(sc: Scen, st: Style, rng: random.Random) -> tuple[dict, dict, dict]:
    """-> (question, label, name map original->shown)."""
    acts = list(sc.actions)
    names = {a: a for a in acts}
    if rng.random() < 0.1:
        for a in acts:
            if a in RENAMES and rng.random() < 0.5:
                names[a] = rng.choice(RENAMES[a])
        if len(set(names.values())) < len(names):
            names = {a: a for a in acts}
    shown = [a for a in acts]
    extra = []
    if rng.random() < 0.15:
        extra = rng.sample(sorted(DISTRACTOR_ACTIONS), rng.randint(1, 2))
    if rng.random() < 0.5:
        rng.shuffle(shown)
    crit = {}
    for a in shown:
        descs = ACTION_DESC[a]
        d = descs[0] if rng.random() < 0.5 else pick_from(rng, descs, st.test)
        crit[names[a]] = d
    for x in extra:
        pos = rng.randrange(len(crit) + 1)
        items = list(crit.items())
        items.insert(pos, (x, DISTRACTOR_ACTIONS[x]))
        crit = dict(items)
    instr = pick_from(rng, ACTION_INSTR[sc.trigger], st.test).format(subj=sc.subj)
    q = {"type": "choice", "instructions": instr, "criteria": crit}
    if isinstance(sc.action, str):
        lab = {"type": "choice", "label": names[sc.action]}
    else:
        dist = {names[a]: p for a, p in sc.action.items() if a in names}
        s = sum(dist.values())
        lab = {"type": "choice", "dist": {k: v / s for k, v in dist.items()}}
    return q, lab, names


def diagnosis_question(sc: Scen, st: Style, rng: random.Random) -> tuple[dict, dict]:
    gold = [sc.diag] if isinstance(sc.diag, str) else [k for k, v in sc.diag.items() if v > 0]
    labels = list(DIAGNOSES)
    if rng.random() < 0.2:
        keep = set(gold) | {"expected"}
        others = [x for x in labels if x not in keep]
        keep |= set(rng.sample(others, rng.randint(2, min(5, len(others)))))
        labels = [x for x in labels if x in keep]
    if rng.random() < 0.5:
        rng.shuffle(labels)
    crit = {}
    for x in labels:
        descs = DIAG_DESC[x]
        crit[x] = descs[0] if rng.random() < 0.5 else pick_from(rng, descs, st.test)
    q = {"type": "choice", "instructions": pick_from(rng, DIAG_INSTR, st.test), "criteria": crit}
    if isinstance(sc.diag, str):
        lab = {"type": "choice", "label": sc.diag}
    else:
        lab = {"type": "choice", "dist": dict(sc.diag)}
    return q, lab


def add_prims(questions: dict, labels: dict, prims: list, rng: random.Random, k: int) -> list[str]:
    used = []
    pool = list(prims)
    rng.shuffle(pool)
    seen_q = set()
    for qid, q, lab in pool:
        if len(used) >= k:
            break
        key = (q["instructions"], q["type"])
        if key in seen_q:
            continue
        seen_q.add(key)
        name = qid
        n = 2
        while name in questions:
            name = f"{qid}{n}"
            n += 1
        questions[name] = q
        labels[name] = lab
        used.append(name)
    return used


def decision_row(sc: Scen, app: App, st: Style, rng: random.Random, p_runtime: float = 0.0) -> dict:
    rendered = None
    if p_runtime > 0 and rng.random() < p_runtime:
        import rt
        rendered = rt.render(sc, app, rng)
    if rendered is not None:  # exactly what @genclass/runtime hands the model
        state, questions = rendered
        names = {a: a for a in sc.actions}
        ld = {"type": "choice", "label": sc.diag} if isinstance(sc.diag, str) else {"type": "choice", "dist": dict(sc.diag)}
        labels = {"diagnosis": ld}
        if "action" in questions:  # the runtime asks only when more than one action applies
            if isinstance(sc.action, str):
                labels["action"] = {"type": "choice", "label": sc.action}
            else:
                dist = {a: p for a, p in sc.action.items() if a in questions["action"]["criteria"]}
                tot = sum(dist.values())
                labels["action"] = {"type": "choice", "dist": {k: v / tot for k, v in dist.items()}}
        prim_names = add_prims(questions, labels, sc.prims, rng, rng.choice((0, 0, 1, 2)))
        style = "runtime"
    else:
        state = situation_state(sc, app, st, rng)
        qa, la, names = action_question(sc, st, rng)
        qd, ld = diagnosis_question(sc, st, rng)
        questions = {"action": qa, "diagnosis": qd}
        labels = {"action": la, "diagnosis": ld}
        if rng.random() < 0.15:  # question order robustness (isolation makes it irrelevant to the model)
            questions = {"diagnosis": qd, "action": qa}
        if len(sc.actions) < 2:  # one applicable action: the runtime does not ask
            del questions["action"], labels["action"]
        prim_names = add_prims(questions, labels, sc.prims, rng, rng.choice((0, 1, 2, 2, 3)))
        style = "varied"
    a_gold = sc.action if isinstance(sc.action, str) else max(sc.action, key=sc.action.get)
    d_gold = sc.diag if isinstance(sc.diag, str) else max(sc.diag, key=sc.diag.get)
    meta = {"kind": "decision", "trigger": sc.trigger, "case": sc.case, "domain": app.dom.key,
            "passive_best": sc.passive_best, "action_gold": names.get(a_gold, a_gold), "action_canonical": a_gold,
            "passive": names.get(PASSIVE[sc.trigger], PASSIVE[sc.trigger]), "diag_gold": d_gold,
            "action_names": names, "prims": prim_names, "heldout_templates_possible": st.test,
            "soft_action": not isinstance(sc.action, str), "style": style}
    return {"state": state, "questions": questions, "labels": labels, "meta": meta,
            "family": f"cur/{sc.trigger}/{sc.case.split('/')[-1]}"}


def ask_row(sc: Scen, app: App, st: Style, rng: random.Random) -> dict | None:
    state = situation_state(sc, app, st, rng, ask=True)
    questions: dict = {}
    labels: dict = {}
    names = add_prims(questions, labels, sc.prims, rng, rng.randint(2, 5))
    if not names:
        return None
    meta = {"kind": "ask", "trigger": "ask", "source_trigger": sc.trigger, "case": sc.case, "domain": app.dom.key,
            "prims": names}
    return {"state": state, "questions": questions, "labels": labels, "meta": meta,
            "family": f"cur/ask/{sc.trigger}"}
