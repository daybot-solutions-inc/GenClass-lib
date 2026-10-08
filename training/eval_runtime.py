"""Runtime-model evaluation: accuracy, calibration, and the product metrics (precision / false interventions).

Gate (CONTRACT §8 as of 2026-10-07): A = applicable non-passive actions permitted by the mode (guard: guard tier;
heal: guard + heal); candidate = argmax p over A; it runs iff sum_{a∈A} p(a) ≥ the candidate's tier threshold
(guard 0.9 / heal 0.8) and the top diagnosis is not `expected`.

    python training/eval_runtime.py --ckpt CKPT --data DIR --split test [--fit-split dev] [--limit N] \
        [--out report.json] [--write-calibration calibration.json]

Reads CONTRACT-D rows (curriculum or SIM). For rows that carry the standing questions `action` and `diagnosis` it
applies the gate above in guard mode and in heal mode and reports: false-intervention rate (FIR) on rows whose best
action is passive, precision of fired actions (candidate == best action), recall on rows whose best action is a
permitted non-passive action, per trigger / case / style, a threshold sweep, diagnosis confusion, and — for SIM rows
with `meta.costs` — the mean counterfactual cost of the gated policy vs always-passive vs the oracle, and the harm
(cost increase) of interventions on passive-best rows. Plus per-question accuracy, NLL, Brier and ECE (15 bins), and
temperatures fitted on --fit-split (per kind, per standing question, per exact header) with a split-half check.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import zlib
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path.home() / "jev"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "curriculum"))

TIER = {"apply": "passive", "send": "passive", "deliver": "passive", "wait": "passive", "ignore": "passive",
        "discard": "guard", "defer": "guard", "coalesce": "guard", "delay": "guard",
        "block": "heal", "serve_cached": "heal", "retry": "heal", "hedge": "heal", "rollback": "heal", "resync": "heal"}
PASSIVE = {"mutation": "apply", "request": "send", "failure": "deliver", "stall": "wait", "inconsistency": "ignore",
           "transition": "ignore", "error": "ignore"}
THRESH = {"guard": 0.9, "heal": 0.8}
N_BINS = 15


def softmax(z: np.ndarray, tau: float = 1.0) -> np.ndarray:
    z = np.asarray(z, np.float64) / tau
    z = z - z.max()
    e = np.exp(z)
    return e / e.sum()


def ece(conf: np.ndarray, correct: np.ndarray, n_bins: int = N_BINS) -> float:
    if len(conf) == 0:
        return float("nan")
    bins = np.minimum((conf * n_bins).astype(int), n_bins - 1)
    return float(sum((bins == b).mean() * abs(correct[bins == b].mean() - conf[bins == b].mean())
                     for b in range(n_bins) if (bins == b).any()))


def fit_tau(items: list[tuple[np.ndarray, np.ndarray]], lo: float = 0.2, hi: float = 5.0) -> float:
    """Temperature minimising NLL (golden section on log tau)."""
    if not items:
        return 1.0

    def nll(lt: float) -> float:
        tau = math.exp(lt)
        s = 0.0
        for z, t in items:
            p = softmax(z, tau)
            s -= float((t * np.log(np.clip(p, 1e-12, 1))).sum())
        return s / len(items)

    a, b = math.log(lo), math.log(hi)
    g = (math.sqrt(5) - 1) / 2
    c, d = b - g * (b - a), a + g * (b - a)
    fc, fd = nll(c), nll(d)
    for _ in range(40):
        if fc < fd:
            b, d, fd = d, c, fc
            c = b - g * (b - a)
            fc = nll(c)
        else:
            a, c, fc = c, d, fd
            d = a + g * (b - a)
            fd = nll(d)
    return float(math.exp((a + b) / 2))


def fit_tau_noul(items: list[tuple[float, float]]) -> float:
    if not items:
        return 1.0

    def nll(lt: float) -> float:
        tau = math.exp(lt)
        s = 0.0
        for z, p in items:
            q = 1 / (1 + math.exp(-z / tau))
            q = min(max(q, 1e-12), 1 - 1e-12)
            s -= p * math.log(q) + (1 - p) * math.log(1 - q)
        return s / len(items)

    best = min((nll(math.log(t)), t) for t in np.exp(np.linspace(math.log(0.2), math.log(5), 61)))
    return float(best[1])


# ------------------------------------------------------------------------------------------------ collection


def load_rows(path: Path, limit: int | None) -> dict[str, dict]:
    rows = {}
    with path.open() as f:
        for i, line in enumerate(f):
            if limit is not None and i >= limit:
                break
            r = json.loads(line)
            st = r.get("state")
            chars = (sum(len(k) + 2 + len("\n".join(v) if isinstance(v, list) else str(v)) + 1 for k, v in st.items())
                     if isinstance(st, dict) else len(str(st)))
            m = dict(r.get("meta") or {})
            bud = m.get("budget") or (m.get("situation") or {}).get("budget") if isinstance(m.get("situation"), dict) else m.get("budget")
            m["_budget"] = str(bud) if bud else ("≤1100" if chars <= 1100 else "≤2100" if chars <= 2100 else ">2100")
            rows[r["id"]] = {"meta": m, "labels": r.get("labels") or {}, "family": r.get("family", ""),
                             "questions": {q: list(v.get("criteria", {})) if isinstance(v.get("criteria"), dict) else None
                                           for q, v in r["questions"].items()}}
    return rows


def collect(ckpt: Path, path: Path, limit: int | None, batch: int) -> list[dict]:
    """-> one record per supervised question: {id, qid, kind, labels, logits, target}."""
    from jev_local.train.eval import collect as jl_collect

    res = jl_collect(ckpt, [path], limit=limit, batch=batch, device="cpu")
    out = []
    for rec, m in zip(res.records, res.metas):
        out.append({"id": m.example_id, "qid": rec.qid, "kind": rec.kind, "labels": list(m.labels),
                    "logits": np.asarray(rec.logits, np.float64), "target": np.asarray(rec.target, np.float64),
                    "header": rec.header})
    return out


def dump_records(recs: list[dict], path: Path) -> None:
    with path.open("w") as f:
        for r in recs:
            f.write(json.dumps({**r, "logits": [float(x) for x in r["logits"]],
                                "target": [float(x) for x in r["target"]]}) + "\n")


def load_records(path: Path) -> list[dict]:
    out = []
    with path.open() as f:
        for line in f:
            r = json.loads(line)
            r["logits"] = np.asarray(r["logits"], np.float64)
            r["target"] = np.asarray(r["target"], np.float64)
            out.append(r)
    return out


def get_records(ckpt: Path, path: Path, limit: int | None, batch: int, cache: Path | None) -> list[dict]:
    """Collect raw logits once; with --records-dir they are cached as jsonl next to the report and reused."""
    if cache is not None and cache.is_file():
        return load_records(cache)
    recs = collect(ckpt, path, limit, batch)
    if cache is not None:
        cache.parent.mkdir(parents=True, exist_ok=True)
        dump_records(recs, cache)
    return recs


def group_of(rec: dict) -> str:
    if rec["qid"] in ("action", "diagnosis"):
        return rec["qid"]
    return rec["kind"]


def fit_calibration(recs: list[dict]) -> dict:
    by = defaultdict(list)
    for r in recs:
        g = group_of(r)
        if r["kind"] == "noul":
            by["noul"].append((float(r["logits"][0]), float(r["target"][0])))
        else:
            by[g].append((r["logits"], r["target"]))
            if g in ("action", "diagnosis"):
                by["choice"].append((r["logits"], r["target"]))
    taus = {"noul": fit_tau_noul(by["noul"])}
    for g in ("choice", "score", "action", "diagnosis"):
        taus[g] = fit_tau(by[g])
    # per exact header (the runtime's fixed instructions) for the standing questions, when well populated
    hdr = defaultdict(list)
    for r in recs:
        if r["qid"] in ("action", "diagnosis"):
            hdr[r["header"]].append((r["logits"], r["target"]))
    taus["by_header"] = {h: fit_tau(v) for h, v in hdr.items() if len(v) >= 300}
    return taus


def probs(rec: dict, taus: dict | None, mode: str) -> np.ndarray:
    """mode: 'raw' (tau 1), 'kind' (per-kind tau), 'group' (action/diagnosis own tau)."""
    tau = 1.0
    if taus and mode != "raw":
        g = group_of(rec)
        if mode == "header" and rec["header"] in taus.get("by_header", {}):
            tau = taus["by_header"][rec["header"]]
        else:
            tau = taus.get(g if mode == "group" else rec["kind"], 1.0)
    if rec["kind"] == "noul":
        z = float(rec["logits"][0]) / tau
        return np.array([1 / (1 + math.exp(-z))])
    return softmax(rec["logits"], tau)


# ------------------------------------------------------------------------------------------------ metrics


def question_metrics(recs: list[dict], taus: dict | None, mode: str) -> dict:
    by = defaultdict(lambda: {"conf": [], "ok": [], "nll": [], "brier": []})
    for r in recs:
        p = probs(r, taus, mode)
        t = r["target"]
        g = group_of(r)
        if r["kind"] == "noul":
            q = float(p[0])
            y = float(t[0])
            ok = (q >= 0.5) == (y >= 0.5)
            conf = max(q, 1 - q)
            nll = -(y * math.log(max(q, 1e-12)) + (1 - y) * math.log(max(1 - q, 1e-12)))
            brier = (q - y) ** 2
        else:
            ok = int(p.argmax()) == int(t.argmax())
            conf = float(p.max())
            nll = -float((t * np.log(np.clip(p, 1e-12, 1))).sum())
            brier = float(((p - t) ** 2).sum())
        for key in (g, "all"):
            d = by[key]
            d["conf"].append(conf)
            d["ok"].append(float(ok))
            d["nll"].append(nll)
            d["brier"].append(brier)
    out = {}
    for k, d in by.items():
        conf, ok = np.array(d["conf"]), np.array(d["ok"])
        out[k] = {"n": len(ok), "acc": round(float(ok.mean()), 4), "nll": round(float(np.mean(d["nll"])), 4),
                  "brier": round(float(np.mean(d["brier"])), 4), "ece": round(ece(conf, ok), 4)}
    return out


def canonical(name: str, meta: dict) -> str:
    """Shown option name -> canonical action name (curriculum rows may rename options)."""
    inv = {v: k for k, v in (meta.get("action_names") or {}).items()}
    return inv.get(name, name)


def decision_metrics(recs: list[dict], rows: dict[str, dict], taus: dict | None, mode: str) -> dict:
    per_id = defaultdict(dict)
    for r in recs:
        if r["qid"] in ("action", "diagnosis"):
            per_id[r["id"]][r["qid"]] = r
    stats = {"all": Counter()}
    by_trig: dict[str, Counter] = defaultdict(Counter)
    by_case: dict[str, Counter] = defaultdict(Counter)
    by_style: dict[str, Counter] = defaultdict(Counter)
    by_budget: dict[str, Counter] = defaultdict(Counter)
    diag_conf = defaultdict(Counter)
    act_acc = Counter()
    fires_detail = Counter()
    for rid, qs in per_id.items():
        if "action" not in qs or "diagnosis" not in qs or rid not in rows:
            continue
        meta = rows[rid]["meta"]
        trig = meta.get("trigger") or meta.get("trigger_kind") or "?"
        ra, rd = qs["action"], qs["diagnosis"]
        pa, pd = probs(ra, taus, mode), probs(rd, taus, mode)
        a_names = [canonical(x, meta) for x in ra["labels"]]
        d_names = list(rd["labels"])
        gold_a = a_names[int(ra["target"].argmax())]
        gold_d = d_names[int(rd["target"].argmax())]
        top_a = a_names[int(pa.argmax())]
        p_top = float(pa.max())
        top_d = d_names[int(pd.argmax())]
        passive = PASSIVE.get(trig, meta.get("passive"))
        passive_best = gold_a == passive or TIER.get(gold_a) == "passive"
        act_acc["n"] += 1
        act_acc["ok"] += int(top_a == gold_a)
        by_trig[trig]["n"] += 1
        by_trig[trig]["act_ok"] += int(top_a == gold_a)
        by_trig[trig]["diag_ok"] += int(top_d == gold_d)
        by_trig[trig]["passive_rows"] += int(passive_best)
        diag_conf[gold_d][top_d] += 1
        case = meta.get("case") or meta.get("family") or "?"
        bud = meta.get("_budget", "?")
        for c, key in ((by_case[case], None), (by_style[meta.get("style", "sim")], None), (by_budget[bud], None)):
            c["n"] += 1
            c["act_ok"] += int(top_a == gold_a)
            c["diag_ok"] += int(top_d == gold_d)
            c["passive_rows"] += int(passive_best)
        costs = meta.get("costs") if isinstance(meta.get("costs"), dict) else None
        for m in ("guard", "heal"):
            # CONTRACT §8 (2026-10-07): A = applicable non-passive actions the mode permits; candidate = argmax of p
            # over A; it runs iff sum_{a in A} p(a) >= the candidate's tier threshold and the top diagnosis is not
            # `expected`. Unknown (plugin/distractor) actions default to the heal tier.
            permitted = ("guard",) if m == "guard" else ("guard", "heal")
            A = [i for i, a in enumerate(a_names) if TIER.get(a, "heal") in permitted]
            fire, cand = False, None
            if A:
                ci = max(A, key=lambda i: pa[i])
                cand = a_names[ci]
                thr = THRESH[TIER.get(cand, "heal")]
                fire = float(sum(pa[i] for i in A)) >= thr and top_d != "expected"
            gold_permitted = TIER.get(gold_a, "heal") in permitted
            for c in (stats["all"], by_trig[trig], by_case[case], by_style[meta.get("style", "sim")], by_budget[bud]):
                c[f"{m}_rows_passive"] += int(passive_best)
                c[f"{m}_rows_active"] += int(not passive_best and gold_permitted)
                c[f"{m}_fires"] += int(fire)
                c[f"{m}_fires_correct"] += int(fire and cand == gold_a)
                c[f"{m}_false_fires"] += int(fire and passive_best)
                c[f"{m}_recall_hits"] += int(fire and not passive_best and cand == gold_a and gold_permitted)
                clear = (not passive_best) and gold_permitted and float(ra["target"].max()) >= 0.9
                c[f"{m}_clear_active"] += int(clear)
                c[f"{m}_clear_hits"] += int(clear and fire and cand == gold_a)
                if gold_d in ("stale", "duplicate"):
                    c[f"{m}_sd_active"] += int(clear)
                    c[f"{m}_sd_hits"] += int(clear and fire and cand == gold_a)
                if costs and passive in costs:
                    done = cand if fire else passive
                    c[f"{m}_cost_rows"] += 1
                    c[f"{m}_cost_policy_x1e3"] += int(1000 * float(costs.get(done, costs[passive])))
                    c[f"{m}_cost_passive_x1e3"] += int(1000 * float(costs[passive]))
                    c[f"{m}_cost_oracle_x1e3"] += int(1000 * min(float(v) for v in costs.values()))
                    if fire and passive_best:
                        c[f"{m}_harm_x1e3"] += int(1000 * (float(costs.get(cand, costs[passive])) - float(costs[passive])))
            if fire and passive_best:
                fires_detail[f"{m}:{trig}:{cand}<-{gold_a}"] += 1
        # threshold sweep (heal-mode permitted set, summed probability, diagnosis gate on)
        A = [i for i, a in enumerate(a_names) if TIER.get(a, "heal") in ("guard", "heal")]
        s_a = float(sum(pa[i] for i in A)) if A else 0.0
        cand = a_names[max(A, key=lambda i: pa[i])] if A else None
        for thr in (0.5, 0.6, 0.7, 0.8, 0.9, 0.95):
            fire = bool(A) and s_a >= thr and top_d != "expected"
            stats["all"][f"sweep{thr}_fires"] += int(fire)
            stats["all"][f"sweep{thr}_false"] += int(fire and passive_best)
            stats["all"][f"sweep{thr}_correct"] += int(fire and cand == gold_a)

    def summ(c: Counter) -> dict:
        o = {}
        for m in ("guard", "heal"):
            rp, ra_ = c[f"{m}_rows_passive"], c[f"{m}_rows_active"]
            f, fc = c[f"{m}_fires"], c[f"{m}_fires_correct"]
            o[m] = {"false_intervention_rate": round(c[f"{m}_false_fires"] / rp, 5) if rp else None,
                    "false_fires": c[f"{m}_false_fires"], "passive_rows": rp,
                    "precision": round(fc / f, 4) if f else None, "fires": f,
                    "recall": round(c[f"{m}_recall_hits"] / ra_, 4) if ra_ else None, "active_rows": ra_,
                    "recall_clear": round(c[f"{m}_clear_hits"] / c[f"{m}_clear_active"], 4) if c[f"{m}_clear_active"] else None,
                    "clear_rows": c[f"{m}_clear_active"],
                    "recall_clear_stale_dup": round(c[f"{m}_sd_hits"] / c[f"{m}_sd_active"], 4) if c[f"{m}_sd_active"] else None,
                    "clear_stale_dup_rows": c[f"{m}_sd_active"]}
            n_c = c[f"{m}_cost_rows"]
            if n_c:  # SIM rows: mean counterfactual cost of running the gate vs always-passive vs the oracle
                o[m]["mean_cost"] = {"policy": round(c[f"{m}_cost_policy_x1e3"] / 1000 / n_c, 4),
                                     "always_passive": round(c[f"{m}_cost_passive_x1e3"] / 1000 / n_c, 4),
                                     "oracle": round(c[f"{m}_cost_oracle_x1e3"] / 1000 / n_c, 4), "rows": n_c,
                                     "harm_on_passive_rows": round(c[f"{m}_harm_x1e3"] / 1000, 3)}
        return o

    out = {"n": act_acc["n"], "action_acc": round(act_acc["ok"] / max(act_acc["n"], 1), 4), "modes": summ(stats["all"]),
           "by_trigger": {}, "sweep": {}, "diag_confusion": {g: dict(c) for g, c in diag_conf.items()},
           "false_fires_detail": dict(fires_detail.most_common(30))}
    for t, c in sorted(by_trig.items()):
        out["by_trigger"][t] = {"n": c["n"], "action_acc": round(c["act_ok"] / c["n"], 4),
                                "diag_acc": round(c["diag_ok"] / c["n"], 4), "passive_frac": round(c["passive_rows"] / c["n"], 3),
                                **summ(c)}
    for name, groups in (("by_case", by_case), ("by_style", by_style), ("by_budget", by_budget)):
        out[name] = {}
        for t, c in sorted(groups.items()):
            out[name][t] = {"n": c["n"], "action_acc": round(c["act_ok"] / c["n"], 4), "diag_acc": round(c["diag_ok"] / c["n"], 4),
                            "passive_frac": round(c["passive_rows"] / c["n"], 3), **summ(c)}
    s = stats["all"]
    for thr in (0.5, 0.6, 0.7, 0.8, 0.9, 0.95):
        f = s[f"sweep{thr}_fires"]
        out["sweep"][str(thr)] = {"fires": f, "false": s[f"sweep{thr}_false"],
                                  "precision": round(s[f"sweep{thr}_correct"] / f, 4) if f else None}
    tot = sum(sum(c.values()) for c in diag_conf.values())
    ok = sum(diag_conf[g][g] for g in diag_conf)
    out["diag_acc"] = round(ok / tot, 4) if tot else None
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", type=Path, required=True)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--split", default="test")
    ap.add_argument("--fit-split", default=None)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--threads", type=int, default=32)
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--write-calibration", type=Path, default=None)
    ap.add_argument("--calibration", type=Path, default=None, help="evaluate with this calibration.json's temperatures")
    ap.add_argument("--records-dir", type=Path, default=None,
                    help="cache raw logits here (<ckpt>__<data>__<split>.jsonl); later runs reuse them (metrics only)")
    ap.add_argument("--header-calibration", action="store_true",
                    help="also write per-header temperatures for the standing questions (check split_half first)")
    args = ap.parse_args()
    import torch

    torch.set_num_threads(args.threads)
    test_path = args.data / f"{args.split}.jsonl"
    rows = load_rows(test_path, args.limit)
    rd = args.records_dir
    tag = f"{args.ckpt.name}__{args.data.name}"
    recs = get_records(args.ckpt, test_path, args.limit, args.batch, rd / f"{tag}__{args.split}.jsonl" if rd else None)
    report = {"ckpt": str(args.ckpt), "data": str(args.data), "split": args.split, "n_rows": len(rows),
              "n_questions": len(recs)}
    taus = None
    if args.calibration:
        cal = json.loads(args.calibration.read_text())
        taus = {"noul": float(cal.get("noul", 1.0)), "choice": float(cal.get("choice", 1.0)),
                "score": float(cal.get("score", 1.0)), "by_header": dict(cal.get("by_header") or {})}
        taus["action"] = taus["diagnosis"] = taus["choice"]
        report["calibration_from"] = str(args.calibration)
        report["taus"] = taus
    if args.fit_split:
        fit_path = args.data / f"{args.fit_split}.jsonl"
        fit_recs = get_records(args.ckpt, fit_path, args.limit, args.batch,
                               rd / f"{tag}__{args.fit_split}.jsonl" if rd else None)
        taus = fit_calibration(fit_recs)
        report["calibration_fit_on"] = args.fit_split
        report["taus"] = {k: (round(v, 4) if not isinstance(v, dict) else {h: round(x, 4) for h, x in v.items()})
                          for k, v in taus.items()}
        # split-half check on the fit split itself: fit on even ids, evaluate on odd ids
        ev = [r for r in fit_recs if zlib.crc32(r["id"].encode()) % 2 == 0]
        od = [r for r in fit_recs if zlib.crc32(r["id"].encode()) % 2 == 1]
        t_even = fit_calibration(ev)
        report["split_half"] = {"taus_even": {k: v for k, v in t_even.items() if not isinstance(v, dict)},
                                "odd_raw": question_metrics(od, None, "raw").get("all"),
                                "odd_with_even_taus_kind": question_metrics(od, t_even, "kind").get("all"),
                                "odd_with_even_taus_group": question_metrics(od, t_even, "group").get("all"),
                                "odd_with_even_taus_header": question_metrics(od, t_even, "header").get("all")}
    for mode in ("raw", "kind", "group", "header") if taus else ("raw",):
        report[f"questions_{mode}"] = question_metrics(recs, taus, mode)
        report[f"decisions_{mode}"] = decision_metrics(recs, rows, taus, mode)
    fam = defaultdict(lambda: [0, 0])
    for r in recs:
        if r["qid"] in ("action", "diagnosis") or r["id"] not in rows:
            continue
        p = probs(r, taus, "kind" if taus else "raw")
        ok = ((p[0] >= 0.5) == (r["target"][0] >= 0.5)) if r["kind"] == "noul" else int(p.argmax()) == int(r["target"].argmax())
        key = r["qid"].rstrip("0123456789")
        fam[key][0] += 1
        fam[key][1] += int(ok)
    report["primitive_acc"] = {k: {"n": n, "acc": round(c / n, 4)} for k, (n, c) in sorted(fam.items())}
    txt = json.dumps(report, indent=1, default=float)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(txt)
    if args.write_calibration and taus:
        use_hdr = args.header_calibration
        cal = {"noul": round(taus["noul"], 4), "choice": round(taus["choice"], 4), "score": round(taus["score"], 4),
               "by_header": ({h: round(v, 4) for h, v in taus["by_header"].items()} if use_hdr else {}),
               "_fit": {"split": args.fit_split, "data": str(args.data), "taus": report["taus"]}}
        args.write_calibration.write_text(json.dumps(cal, indent=2))
    d = report.get("decisions_kind") or report["decisions_raw"]
    print(json.dumps({"n_rows": len(rows), "questions": (report.get("questions_kind") or report["questions_raw"]).get("all"),
                      "action_acc": d["action_acc"], "diag_acc": d["diag_acc"], "modes": d["modes"],
                      "taus": report.get("taus")}, indent=1))


if __name__ == "__main__":
    main()
