"""Data-derived runtime gates, shipped with the model (`meta.json` → `gate`), fitted on dev and verified on test.

    python training/fit_gates.py --cal out/export-M/calibration.json \
        --fit  sim=data/sim2g/dev.jsonl:out/records/M__sim2g__dev.jsonl \
        --fit  real=data/realev/test.jsonl:out/records/M__realev__test.jsonl:notest \
        --fit  realc=data/real2e/dev.jsonl:out/records/M__real2e__dev.jsonl \
        --test sim=data/sim2e/test.jsonl:out/records/M__sim2e__test.jsonl \
        --test sim=data/sim2f/test.jsonl:out/records/M__sim2f__test.jsonl \
        --test real=data/realev/test.jsonl:out/records/M__realev__test.jsonl:test \
        --test realc=data/real2e/test.jsonl:out/records/M__real2e__test.jsonl \
        --out out/gates/M.json [--write-meta out/export-M]

The runtime gate (CONTRACT §8, policy.ts `gate()`): A = permitted non-passive actions (guard mode: guard tier; heal mode:
guard + heal), candidate = argmax calibrated p over A, run iff Σ_A p ≥ threshold[tier(candidate)][trigger] and the top
diagnosis ≠ expected. Probabilities use the shipped calibration (per-kind temperature, as `calibrateLogits`).

Sources: `sim` = SIM gold rows; `real` = REAL's unambiguous-case eval set (meta.eval_case/eval_expect; `:notest` keeps
rows whose original split is not test, `:test` only test-split rows = held-out apps/framework); `realc` = random REAL
gold rows (harm only).
Constraints (per tier, on the fit data; each must hold for the one-sided 95% Wilson UPPER bound, because the test
sets and real apps are held out / shifted relative to dev): FIR = fired share of SIM passive-best rows and of REAL clean-benign +
benign-salient rows ≤ 0.1% (guard) / 0.5% (heal); harm = share of rows whose fired action costs ≥ 1 more than passive
(meta.costs, else mean cost_futures) ≤ 0.2% / 1% (SIM and REAL separately). The guard tier is fitted in guard mode; the
heal tier in heal mode with guard candidates at their fitted guard thresholds. Threshold = the lowest grid value t such
that the constraints hold at t and at every grid value above t. Per trigger when the fit data has ≥ --min-passive SIM
passive-best rows for it (REAL constraints per trigger only with ≥ --min-real REAL benign rows, else pooled), otherwise
the tier default (fitted on all triggers pooled); if the per-trigger thresholds break a pooled constraint, every
trigger is raised to at least the default. Test: per trigger and pooled metrics with 95% bootstrap intervals.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path

import numpy as np

PREM = {"passive": 0.0, "guard": 0.25, "heal": 0.5}
PERMIT = {"guard": ("guard",), "heal": ("guard", "heal")}
LIMITS = {"guard": {"fir": 0.001, "harm": 0.002}, "heal": {"fir": 0.005, "harm": 0.01}}
GRID_MASS = [round(0.30 + 0.05 * i, 2) for i in range(14)] + [0.97, 0.99, 1.0]
GRID_GAIN = [-1.0, -0.5, 0.0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 99.0]  # 99 = never
GRID = GRID_MASS
KIND = "mass"  # "gain": fire argmax over A iff ĝ = TAU_GAIN·ln(p(cand)/p(passive)) ≥ margin[tier][trigger]
TAU_GAIN = 1.0
BENIGN = {"clean-benign", "benign-salient"}


def softmax(z, tau):
    z = np.asarray(z, np.float64) / tau
    z = z - z.max()
    e = np.exp(z)
    return e / e.sum()


def mean_costs(m: dict) -> dict | None:
    if m.get("costs"):
        return {k: float(v) for k, v in m["costs"].items()}
    cf = m.get("cost_futures")
    if cf:
        return {k: float(np.mean(v)) for k, v in cf.items() if v}
    return None


def clear_best(m: dict, permitted: list[str], passive: str):
    cf = m.get("cost_futures") or {k: [v] for k, v in (m.get("costs") or {}).items()}
    tiers = m.get("tiers") or {}
    if passive not in cf:
        return None
    K = min(len(v) for v in cf.values())
    gaps, bests = [], []
    for f in range(K):
        cand = [(cf[a][f] + PREM.get(tiers.get(a, "heal"), 0.5), a) for a in permitted if a != passive and a in cf]
        if not cand:
            return None
        c, a = min(cand)
        gaps.append(cf[passive][f] - c)
        bests.append(a)
    if sum(gaps) / K >= 2 and min(gaps) > 0 and len(set(bests)) == 1:
        return bests[0]
    return None


KEYED_PATTERNS = {"idem", "co-idem", "create-idem", "confirm-idem", "key-guard"}
NOT_IDEM = re.compile(r"\b(POST|PATCH) is not idempotent")


def retry_unoffered_v22(state, m: dict) -> bool:
    """situation-v2.2 (runtime batch 7): `retry` is offered for non-idempotent methods only when the request carries an
    idempotency key header. v2 rows do not record headers, so a POST/PATCH ("… is not idempotent" fact) counts as keyed
    only when its subject feature's SIM pattern says the app sends keys (…/idem, co-idem, create-idem, confirm-idem,
    key-guard, retry:same-key); otherwise retry is removed and the remaining probabilities renormalised."""
    facts = " ".join(state.get("facts") or []) if isinstance(state, dict) else ""
    if not NOT_IDEM.search(facts):
        return False
    feat = m.get("subject_feature") or ""
    for p in m.get("patterns") or []:
        f, _, v = p.partition("/")
        if f == feat and (v in KEYED_PATTERNS or v.endswith("retry:same-key")):
            return False
    return True


def tau_of(cal: dict, rec: dict) -> float:
    """The runtime's choice temperature for one question: calibration.by_header[header], else the per-kind value."""
    bh = cal.get("by_header") or {}
    h = rec.get("header")
    return float(bh[h]) if h in bh else float(cal.get("choice", 1.0))


def load(spec: str, cal: dict, v22: bool = True) -> list[dict]:
    """→ one item per decision row: per-mode gate inputs and outcome indicators."""
    kind, rest = spec.split("=", 1)
    parts = rest.split(":")
    rows_p, rec_p = parts[0], parts[1]
    filt = parts[2] if len(parts) > 2 else ""
    trig_in = trig_out = None  # optional 4th field: "only=t1,t2" or "not=t1,t2" (per-trigger source choice)
    if len(parts) > 3 and parts[3]:
        k, _, v = parts[3].partition("=")
        if k == "only":
            trig_in = set(v.split(","))
        elif k == "not":
            trig_out = set(v.split(","))
    rows = {}
    with open(rows_p) as f:
        for line in f:
            r = json.loads(line)
            m = r.get("meta") or {}
            drop = v22 and "retry" in ((r.get("questions") or {}).get("action") or {}).get("criteria", {}) \
                and retry_unoffered_v22(r.get("state"), m)
            rows[r["id"]] = (r.get("split"), m, drop)
    recs: dict = defaultdict(dict)
    with open(rec_p) as f:
        for line in f:
            r = json.loads(line)
            if r["qid"] in ("action", "diagnosis"):
                recs[r["id"]][r["qid"]] = r
    out = []
    for rid, q in recs.items():
        if rid not in rows or "action" not in q:
            continue
        split, m, drop_retry = rows[rid]
        if filt == "test" and split != "test":
            continue
        if filt == "notest" and split == "test":
            continue
        trg = m.get("trigger")
        if (trig_in is not None and trg not in trig_in) or (trig_out is not None and trg in trig_out):
            continue
        tiers = m.get("tiers") or {}
        passive = m.get("passive") or next((a for a, t in tiers.items() if t == "passive"), None)
        ra = q["action"]
        names = list(ra["labels"])
        if passive not in names:
            continue
        logits = list(ra["logits"])
        target = list(ra["target"])
        if drop_retry and "retry" in names:
            j = names.index("retry")
            names, logits, target = names[:j] + names[j + 1:], logits[:j] + logits[j + 1:], target[:j] + target[j + 1:]
        p = softmax(logits, tau_of(cal, ra))
        idx = {a: i for i, a in enumerate(names)}
        top_d = None
        if "diagnosis" in q:
            rd = q["diagnosis"]
            top_d = list(rd["labels"])[int(softmax(rd["logits"], tau_of(cal, rd)).argmax())]
        costs = mean_costs(m)
        gold = names[int(np.asarray(target).argmax())]
        pb = m.get("passive_best")
        pb = bool(pb) if pb is not None else gold == passive
        if drop_retry and m.get("best") == "retry" and costs and passive in costs:  # best among what is still offered
            pb = all(costs[passive] <= costs[a] + PREM.get(tiers.get(a, "heal"), 0.5) for a in names if a in costs)
        case = m.get("eval_case")
        expect = set(m.get("eval_expect") or [])
        item = {"kind": kind, "trigger": m.get("trigger") or "?", "diag_ok": top_d != "expected", "modes": {}}
        for mode in ("guard", "heal"):
            A = [a for a in names if a != passive and tiers.get(a, "heal") in PERMIT[mode]]
            if not A:
                continue
            mass = float(sum(p[idx[a]] for a in A))
            cand = max(A, key=lambda a: p[idx[a]])
            ghat = TAU_GAIN * float(np.log(max(p[idx[cand]], 1e-6) / max(p[idx[passive]], 1e-6)))  # runtime: p clamped ≥ 1e-6
            ctier = tiers.get(cand, "heal")
            harm = gain = None
            oracle = 0.0
            if costs and passive in costs and cand in costs:
                harm = costs[cand] - costs[passive] >= 1.0
                gain = costs[passive] - costs[cand] - PREM.get(ctier, 0.5)
                gs = [costs[passive] - costs[a] - PREM.get(tiers.get(a, "heal"), 0.5) for a in A if a in costs]
                oracle = max([0.0] + gs)
            cb = clear_best(m, [passive] + A, passive) if kind == "sim" else None
            item["modes"][mode] = {
                "mass": mass, "ghat": ghat, "ctier": ctier, "harm": harm, "gain": gain, "oracle": oracle,
                "fir_row": (pb if kind == "sim" else (case in BENIGN) if kind == "real" else None),
                "fir_bad": True,  # a fire on a FIR row is always a false intervention
                "clear": cb is not None, "clear_hit": cb == cand if cb else False,
                "act_case": kind == "real" and case is not None and case not in BENIGN,
                "act_hit": kind == "real" and cand in expect,
            }
        out.append(item)
    return out


class Table:
    """Per mode, numpy arrays over the rows that have a permitted action in that mode."""

    def __init__(self, items: list[dict], mode: str):
        its = [(it, it["modes"][mode]) for it in items if mode in it["modes"]]
        self.n = len(its)
        g = lambda f, dt=float: np.array([f(it, x) for it, x in its], dtype=dt)
        self.kind = np.array([it["kind"] for it, _ in its])
        self.trig = np.array([it["trigger"] for it, _ in its])
        self.mass = g(lambda it, x: x["mass"] if KIND == "mass" else x["ghat"])
        self.ctier = np.array([x["ctier"] for _, x in its])
        self.diag = g(lambda it, x: it["diag_ok"], bool)
        self.fir_row = g(lambda it, x: bool(x["fir_row"]), bool)
        self.has_cost = g(lambda it, x: x["harm"] is not None, bool)
        self.harm = g(lambda it, x: bool(x["harm"]), bool)
        self.gain = g(lambda it, x: x["gain"] or 0.0)
        self.oracle = g(lambda it, x: x["oracle"])
        self.clear = g(lambda it, x: x["clear"], bool)
        self.clear_hit = g(lambda it, x: x["clear_hit"], bool)
        self.act_case = g(lambda it, x: x["act_case"], bool)
        self.act_hit = g(lambda it, x: x["act_hit"], bool)

    def fired(self, th: dict, mode: str) -> np.ndarray:
        """th: {tier: {"default": t, "byTrigger": {...}}}"""
        t = np.array([th[ct]["byTrigger"].get(tr, th[ct]["default"]) for ct, tr in zip(self.ctier, self.trig)])
        if KIND == "gain":  # runtime (CORE batch 10): fire iff tauGain·ln(p(a)/p(passive)) > margin
            return self.diag & (self.mass > t)
        return self.diag & (self.mass >= t - 1e-12)


def metrics(T: Table, fired: np.ndarray, sel: np.ndarray, boot: int = 0, seed: int = 0) -> dict:
    """Constraint metrics and report metrics over the rows in sel."""
    def stats(ix):
        sim = (T.kind[ix] == "sim")
        real = (T.kind[ix] == "real")
        realc = (T.kind[ix] == "realc")
        f = fired[ix]
        def rate(num, den):
            d = den.sum()
            return float((num & den).sum() / d) if d else None
        def cnt(num, den):
            return [int((num & den).sum()), int(den.sum())]
        orc = T.oracle[ix][sim].sum()
        return {
            "_counts": {"fir_sim": cnt(f, sim & T.fir_row[ix]), "fir_real": cnt(f, real & T.fir_row[ix]),
                        "harm_sim": cnt(f & T.harm[ix], sim & T.has_cost[ix]),
                        "harm_real": cnt(f & T.harm[ix], (real | realc) & T.has_cost[ix])},
            "fir_sim": rate(f, sim & T.fir_row[ix]),
            "fir_real": rate(f, real & T.fir_row[ix]),
            "harm_sim": rate(f & T.harm[ix], sim & T.has_cost[ix]),
            "harm_real": rate(f & T.harm[ix], (real | realc) & T.has_cost[ix]),
            "fired_sim": rate(f, sim),
            "recall_clear": rate(f & T.clear_hit[ix], sim & T.clear[ix]),
            "recall_real_actions": rate(f & T.act_hit[ix], real & T.act_case[ix]),
            "gain_captured": float((T.gain[ix] * (f & sim)).sum() / orc) if orc > 0 else None,
        }
    ix = np.nonzero(sel)[0]
    base = stats(ix)
    base["n"] = {"sim": int((T.kind[ix] == "sim").sum()), "sim_passive_best": int(((T.kind[ix] == "sim") & T.fir_row[ix]).sum()),
                 "real_benign": int(((T.kind[ix] == "real") & T.fir_row[ix]).sum()),
                 "real_action_cases": int(((T.kind[ix] == "real") & T.act_case[ix]).sum()),
                 "sim_clear": int(((T.kind[ix] == "sim") & T.clear[ix]).sum())}
    if boot and len(ix):
        rng = np.random.default_rng(seed)
        bs = defaultdict(list)
        for _ in range(boot):
            s = stats(ix[rng.integers(0, len(ix), len(ix))])
            for k, v in s.items():
                if v is not None and not k.startswith("_"):
                    bs[k].append(v)
        base["ci95"] = {k: [round(float(np.percentile(v, 2.5)), 5), round(float(np.percentile(v, 97.5)), 5)]
                        for k, v in bs.items()}
    return base


DEV_MARGIN = 0.8  # dev fits must meet 0.8 × each limit, so they hold on the shifted test sets (coordinator, 08:00)
Z_UB = 1.645  # one-sided 95% Wilson upper bound: dev rows are in-distribution, test/real apps are not


def wilson_upper(k: int, n: int, z: float = Z_UB) -> float:
    if n == 0:
        return 0.0
    ph = k / n
    den = 1 + z * z / n
    c = ph + z * z / (2 * n)
    return (c + z * np.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n))) / den


def ok(mt: dict, tier: str, use_real: bool) -> bool:
    """The constraint must hold for the upper confidence bound (point estimate where n cannot certify the limit)."""
    L = LIMITS[tier]
    c = mt["_counts"]
    checks = [(c["fir_sim"], L["fir"]), (c["harm_sim"], L["harm"])]
    if use_real:
        checks += [(c["fir_real"], L["fir"]), (c["harm_real"], L["harm"])]
    lim_scale = DEV_MARGIN

    def holds(k: int, n: int, lim: float) -> bool:
        lim = lim * lim_scale
        if n == 0:
            return True
        if wilson_upper(0, n) > lim:  # too few rows to certify the limit even with zero events: point estimate
            return k / n <= lim + 1e-12
        return wilson_upper(k, n) <= lim + 1e-12
    return all(holds(k, n, lim) for (k, n), lim in checks)


def lowest_safe(T: Table, mode: str, tier: str, th: dict, sel: np.ndarray, trig: str | None, use_real: bool) -> float:
    best = GRID[-1]
    for t in reversed(GRID):  # walk down while every value so far is safe
        th2 = json.loads(json.dumps(th))
        if trig is None:
            th2[tier]["default"] = t
            th2[tier]["byTrigger"] = {}
        else:
            th2[tier]["byTrigger"][trig] = t
        if not ok(metrics(T, T.fired(th2, mode), sel), tier, use_real):
            break
        best = t
    return best


def fit(items: list[dict], min_passive: int, min_real: int) -> tuple[dict, dict]:
    th = {"guard": {"default": GRID[-1], "byTrigger": {}}, "heal": {"default": GRID[-1], "byTrigger": {}}}
    notes: dict = {}
    for tier in ("guard", "heal"):
        mode = tier
        T = Table(items, mode)
        allrows = np.ones(T.n, bool)
        th[tier]["default"] = lowest_safe(T, mode, tier, th, allrows, None, True)
        per = {}
        for trig in sorted(set(T.trig)):
            sel = T.trig == trig
            n_pb = int(((T.kind == "sim") & T.fir_row & sel).sum())
            n_rb = int(((T.kind == "real") & T.fir_row & sel).sum())
            if not ((T.ctier == tier) & sel).any():
                continue  # no candidate of this tier for this trigger: the threshold would be vacuous
            if n_pb < min_passive:
                notes[f"{tier}:{trig}"] = f"default (only {n_pb} SIM passive-best fit rows)"
                continue
            per[trig] = lowest_safe(T, mode, tier, th, sel, trig, n_rb >= min_real)
            notes[f"{tier}:{trig}"] = f"fitted on {n_pb} SIM passive-best / {n_rb} REAL benign rows"
        th[tier]["byTrigger"] = per
        if not ok(metrics(T, T.fired(th, mode), allrows), tier, True):
            th[tier]["byTrigger"] = {k: max(v, th[tier]["default"]) for k, v in per.items()}
            notes[f"{tier}:pooled"] = "per-trigger thresholds broke a pooled constraint → raised to the default"
    return th, notes


def report(items: list[dict], th: dict, boot: int) -> dict:
    out = {}
    for mode in ("guard", "heal"):
        T = Table(items, mode)
        f = T.fired(th, mode)
        r = {"ALL": metrics(T, f, np.ones(T.n, bool), boot)}
        for trig in sorted(set(T.trig)):
            r[trig] = metrics(T, f, T.trig == trig, boot)
        if KIND == "mass":
            fixed = {"guard": {"default": 0.9, "byTrigger": {}}, "heal": {"default": 0.8, "byTrigger": {}}}
            r["ALL@fixed-0.9/0.8"] = metrics(T, T.fired(fixed, mode), np.ones(T.n, bool), boot)
        else:
            for mg in (0.5, 1.0, 2.0):
                fixed = {"guard": {"default": mg, "byTrigger": {}}, "heal": {"default": mg, "byTrigger": {}}}
                r[f"ALL@fixed-gain>{mg}"] = metrics(T, T.fired(fixed, mode), np.ones(T.n, bool), boot)
        out[mode] = r
    return out


def write_meta(export: Path, th: dict, fit_info: dict) -> None:
    meta_p = export / "meta.json"
    meta = json.loads(meta_p.read_text())
    report = (meta.get("gate") or {}).get("report")
    meta["gate"] = ({"kind": "gain", "tauGain": TAU_GAIN} if KIND == "gain" else {}) | th
    if report is not None:
        meta["gate"]["report"] = report
    meta["gate_fit"] = fit_info
    meta_p.write_text(json.dumps(meta, indent=2) + "\n")
    card_p = export / "model.json"
    if card_p.exists():
        card = json.loads(card_p.read_text())
        b = meta_p.read_bytes()
        for v in list(card.get("files", {}).values()):
            if v.get("file") == "meta.json":
                v["bytes"] = len(b)
                v["sha256"] = hashlib.sha256(b).hexdigest()
        card_p.write_text(json.dumps(card, indent=1) + "\n")


def fmt(x):
    return "–" if x is None else f"{100 * x:.2f}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cal", type=Path, required=True)
    ap.add_argument("--fit", action="append", required=True)
    ap.add_argument("--test", action="append", required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--min-passive", type=int, default=1500)
    ap.add_argument("--min-real", type=int, default=300)
    ap.add_argument("--boot", type=int, default=300)
    ap.add_argument("--write-meta", type=Path, default=None)
    ap.add_argument("--kind", choices=["mass", "gain"], default="mass")
    ap.add_argument("--tau-gain", type=float, default=1.0)
    a = ap.parse_args()
    global KIND, TAU_GAIN, GRID
    KIND, TAU_GAIN, GRID = a.kind, a.tau_gain, (GRID_GAIN if a.kind == "gain" else GRID_MASS)
    cal = json.loads(a.cal.read_text())
    fit_items = [x for s in a.fit for x in load(s, cal)]
    test_items = [x for s in a.test for x in load(s, cal)]
    th, notes = fit(fit_items, a.min_passive, a.min_real)
    res = {"kind": KIND, "tau_gain": TAU_GAIN, "gate": th, "notes": notes, "limits": LIMITS, "grid": GRID, "fit_sets": a.fit, "test_sets": a.test,
           "fit": report(fit_items, th, 0), "test": report(test_items, th, a.boot)}
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(res, indent=1))
    if a.write_meta:
        write_meta(a.write_meta, th, {"fitted_on": [s.split(":")[0] for s in a.fit], "limits": LIMITS,
                                      "rule": "lowest summed-mass threshold meeting FIR/harm limits on dev (diagnosis≠expected kept)"})
    print(json.dumps(th, indent=1))
    for k, v in notes.items():
        print(f"  {k}: {v}")
    for mode in ("guard", "heal"):
        print(f"\nTEST [{mode}]  trigger: n_sim fired% | FIR sim% (CI) | FIR real% (CI) | harm sim% | harm real% | recall clear% | "
              "recall REAL actions% | gain captured%")
        for trig, m in res["test"][mode].items():
            ci = m.get("ci95", {})
            c = lambda k: f"[{fmt(ci[k][0])}, {fmt(ci[k][1])}]" if k in ci else ""
            print(f"  {trig:18s} {m['n']['sim']:6d} {fmt(m['fired_sim'])} | {fmt(m['fir_sim'])} {c('fir_sim')} | "
                  f"{fmt(m['fir_real'])} {c('fir_real')} | {fmt(m['harm_sim'])} | {fmt(m['harm_real'])} | "
                  f"{fmt(m['recall_clear'])} {c('recall_clear')} | {fmt(m['recall_real_actions'])} | {fmt(m['gain_captured'])} {c('gain_captured')}")


if __name__ == "__main__":
    main()
