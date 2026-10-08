#!/usr/bin/env python3
"""Stage 2 of the separability analysis: rows generated with SIM_PROBE=1 (meta.probe = sim-only hidden facts).

  ~/jev/.venv/bin/python sim/scripts/separability_probe.py ROWS.jsonl [...] --out DIR [--procs 24]

For each trigger, clear actionable rows vs benign rows (definitions in separability.py):
  1. look-alike rate (same canonical fact signature) as in stage 1;
  2. per probe: value distribution on clear rows vs on their benign look-alikes, and the probe's AUC inside
     look-alike sets (signatures holding both classes): how much of the twin difference it explains;
  3. a linear classifier on the visible situation (hashed canonical n-grams, numbers bucketed) vs + n_* probes
     (computable now) vs + n_* + l_* (latent/future): AUC and recall at a 1% / 0.5% false-intervention rate on
     held-out trajectories (split by seed);
  4. expected-advantage policy vs probability-of-best policy on the visible classifier's score bins (held-out rows of
     all classes, mild included).
Writes DIR/probe_summary.json and prints a compact report.
"""
import argparse, collections, hashlib, importlib.util, json, math, os, random, re, sys
from multiprocessing import Pool

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("sep", os.path.join(HERE, "separability.py"))
sep = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sep)

NB = 1 << 20
R_NUM = re.compile(r"-?\d+(?:\.\d+)?")


def numtok(m):
    x = float(m.group(0))
    if x.is_integer() and 100 <= x <= 599 and "." not in m.group(0):
        return f"c{int(x)}"  # status-like codes stay exact
    if x == 0:
        return "n0"
    b = round(math.log2(abs(x)) * 2) / 2
    return f"n{'-' if x < 0 else ''}{b}"


def vis_tokens(st: dict) -> list:
    out = []
    def line_toks(prefix, s):
        s = s.rstrip("…")
        s = sep.R_STR.sub(" S ", s)
        for _ in range(3):
            s2 = sep.R_OBJ.sub(" O ", s)
            if s2 == s:
                break
            s = s2
        s = sep.R_URL.sub(" P ", s)
        s = sep.R_KEY.sub(" K ", s)
        s = sep.R_REF.sub(" # ", s)
        s = R_NUM.sub(lambda m: " " + numtok(m) + " ", s)
        ws = re.findall(r"[\w×%#.-]+", s.lower())
        out.extend(prefix + w for w in ws)
        out.extend(prefix + a + "_" + b for a, b in zip(ws, ws[1:]))
    line_toks("t:", st.get("trigger") or "")
    for x in sep.lines(st.get("facts")):
        line_toks("f:", x)
    for x in sep.lines(st.get("in_flight")):
        line_toks("i:", x)
    for x in sep.lines(st.get("state"))[:6]:
        line_toks("s:", x)
    for x in sep.lines(st.get("timeline"))[-8:]:
        line_toks("l:", x)
    return out


def probe_tokens(pr: dict, fam: str) -> list:
    out = []
    for k, v in sorted(pr.items()):
        if not k.startswith(fam):
            continue
        if isinstance(v, bool):
            out.append(f"{k}={int(v)}")
        elif isinstance(v, (int, float)):
            if v == -1:
                out.append(f"{k}=none")
            else:
                out.append(f"{k}={numtok(_M(v))}")
                out.append(f"{k}>0={int(v > 0)}")
        else:
            out.append(f"{k}={v}")
    return out


class _M:
    def __init__(self, v):
        self.v = v

    def group(self, _):
        return str(self.v)


def h(tok: str) -> int:
    return int.from_bytes(hashlib.blake2b(tok.encode(), digest_size=8).digest(), "little") % NB


def load(line: str):
    x = sep.featurize(line)
    if x is None:
        return None
    r = json.loads(line)
    m = r["meta"]
    pr = m.get("probe") or {}
    st = sep.state_obj(r)
    cf = m.get("cost_futures") or {}
    passive = x["passive"]
    tiers = m.get("tiers") or {}
    gains = {}
    if passive in cf:
        cp = sum(cf[passive]) / len(cf[passive])
        for a, v in cf.items():
            if a != passive:
                gains[a] = round(cp - sum(v) / len(v) - sep.PREM.get(tiers.get(a, "heal"), 0.5), 3)
    x.update({"probe": pr, "vis": sorted(set(h(t) for t in vis_tokens(st))),
              "pn": sorted(set(h(t) for t in probe_tokens(pr, "n_"))), "pl": sorted(set(h(t) for t in probe_tokens(pr, "l_"))),
              "gains": gains})
    x.pop("toks", None)
    return x


def auc(pos, neg):
    """AUC of scores (pos higher = clear)."""
    allv = sorted([(v, 1) for v in pos] + [(v, 0) for v in neg])
    if not pos or not neg:
        return None
    rank_sum = 0.0
    i = 0
    n = len(allv)
    while i < n:
        j = i
        while j < n and allv[j][0] == allv[i][0]:
            j += 1
        r = (i + j - 1) / 2 + 1
        for k in range(i, j):
            if allv[k][1]:
                rank_sum += r
        i = j
    npos, nneg = len(pos), len(neg)
    return round((rank_sum - npos * (npos + 1) / 2) / (npos * nneg), 3)


def as_num(v):
    if isinstance(v, bool):
        return float(v)
    if isinstance(v, (int, float)):
        return float(v)
    return None


def advantage(scores, rows, nb=40):
    """Bin held-out rows by the visible classifier's score (a stand-in for what a model can know) and compare
    firing rules: P(best) >= 0.5 (what hindsight-best labels teach), E[gain] > 0 (expected cost), and the
    1%-false-intervention threshold. gain(a) = passive cost - a's cost - tier premium (mean over futures)."""
    import numpy as np
    order = np.argsort(scores)
    bins = [list(b) for b in np.array_split(order, nb)]
    n_clear = sum(1 for x in rows if x["cls"] == "clear")
    n_benign = sum(1 for x in rows if x["cls"] == "benign")
    oracle = sum(max([0.0] + [g for g in x["gains"].values()]) for x in rows)
    margins = (0, 1, 2, 4)
    pols = {"P(best)>=0.5": []}
    for mg_ in margins:
        pols[f"E[gain]>{mg_}"] = []
    table = []
    for b in bins:
        rr = [rows[i] for i in b]
        acts = sorted({a for x in rr for a in x["gains"]})
        mg = {a: sum(x["gains"][a] for x in rr if a in x["gains"]) / max(1, sum(1 for x in rr if a in x["gains"])) for a in acts}
        pb = {a: sum(1 for x in rr if x["cls"] == "clear" and x["best_np"] == a) / len(rr) for a in acts}
        a_e = max(mg, key=mg.get) if mg else None
        a_p = max(pb, key=pb.get) if pb else None
        table.append({"n": len(rr), "best_mean_gain_action": a_e, "mean_gain": round(mg.get(a_e, 0), 3) if a_e else None,
                      "p_clear": round(sum(1 for x in rr if x["cls"] == "clear") / len(rr), 3), "p_benign": round(sum(1 for x in rr if x["cls"] == "benign") / len(rr), 3)})
        if a_p and pb[a_p] >= 0.5:
            pols["P(best)>=0.5"].append((rr, a_p))
        for mg_ in margins:
            if a_e and mg[a_e] > mg_:
                pols[f"E[gain]>{mg_}"].append((rr, a_e))
    out = {}
    for name, fired in pols.items():
        rr_all = [(x, a) for rr, a in fired for x in rr if a in x["gains"]]
        out[name] = {
            "fired_share": round(len(rr_all) / max(1, len(rows)), 3),
            "recall_clear": round(sum(1 for x, a in rr_all if x["cls"] == "clear" and x["best_np"] == a) / max(1, n_clear), 3),
            "benign_fired": round(sum(1 for x, a in rr_all if x["cls"] == "benign") / max(1, n_benign), 3),
            "harmful_fired_share(gain<-1)": round(sum(1 for x, a in rr_all if x["gains"][a] < -1) / max(1, len(rows)), 4),
            "gain_captured": round(sum(x["gains"][a] for x, a in rr_all) / max(1e-9, oracle), 3),
        }
    return {"bins": table, "policies": out, "oracle_gain_per_row": round(oracle / max(1, len(rows)), 3)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rows", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--procs", type=int, default=24)
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    with Pool(a.procs) as pool:
        recs = [x for x in pool.imap(load, sep.read_lines(a.rows, a.limit), chunksize=200) if x]
    print(f"rows {len(recs)}", file=sys.stderr)
    import numpy as np
    from scipy import sparse
    from sklearn.linear_model import LogisticRegression

    by = collections.defaultdict(list)
    for x in recs:
        by[x["trigger"]].append(x)
    report = {"rows": len(recs), "triggers": {}}
    for trig, xs in sorted(by.items()):
        cnt = collections.Counter(x["cls"] for x in xs)
        sigc = collections.defaultdict(collections.Counter)
        for x in xs:
            sigc[x["sig"]][x["cls"]] += 1
        clear = [x for x in xs if x["cls"] == "clear"]
        benign = [x for x in xs if x["cls"] == "benign"]
        if len(clear) < 30:
            report["triggers"][trig] = {"classes": dict(cnt), "note": "too few clear rows"}
            continue
        twin = sum(1 for x in clear if sigc[x["sig"]]["benign"] > 0) / len(clear)
        mixed = {s for s, c in sigc.items() if c["clear"] and c["benign"]}
        mc = [x for x in clear if x["sig"] in mixed]
        mb = [x for x in benign if x["sig"] in mixed]
        # --- per-probe separation inside look-alike sets
        keys = sorted({k for x in mc + mb for k in x["probe"]})
        probes = {}
        for k in keys:
            vc = [x["probe"].get(k) for x in mc if k in x["probe"]]
            vb = [x["probe"].get(k) for x in mb if k in x["probe"]]
            if len(vc) < 20 or len(vb) < 20:
                continue
            nc = [as_num(v) for v in vc]
            nb_ = [as_num(v) for v in vb]
            entry = {"n_clear": len(vc), "n_benign": len(vb)}
            if all(v is not None for v in nc + nb_):
                au = auc(nc, nb_)
                entry["auc_in_lookalikes"] = au
                entry["sep"] = round(abs(au - 0.5) * 2, 3) if au is not None else None
                if all(isinstance(v, bool) for v in vc + vb):
                    entry["p_true_clear"] = round(sum(vc) / len(vc), 3)
                    entry["p_true_benign"] = round(sum(vb) / len(vb), 3)
                else:
                    srt = lambda l: sorted(l)
                    qc, qb = srt(nc), srt(nb_)
                    entry["median_clear"] = qc[len(qc) // 2]
                    entry["median_benign"] = qb[len(qb) // 2]
                    entry["p_pos_clear"] = round(sum(1 for v in nc if v > 0) / len(nc), 3)
                    entry["p_pos_benign"] = round(sum(1 for v in nb_ if v > 0) / len(nb_), 3)
            else:
                cc = collections.Counter(str(v) for v in vc)
                cb = collections.Counter(str(v) for v in vb)
                entry["dist_clear"] = {k2: round(v / len(vc), 3) for k2, v in cc.most_common(6)}
                entry["dist_benign"] = {k2: round(v / len(vb), 3) for k2, v in cb.most_common(6)}
                # AUC of the clear-rate of each category (in-sample upper bound for a categorical probe)
                rate = {k2: cc[k2] / (cc[k2] + cb[k2]) for k2 in set(cc) | set(cb)}
                au = auc([rate[str(v)] for v in vc], [rate[str(v)] for v in vb])
                entry["auc_in_lookalikes"] = au
                entry["sep"] = round(abs(au - 0.5) * 2, 3) if au is not None else None
            probes[k] = entry
        # --- classifiers: visible vs + n_* vs + n_* + l_*
        data = clear + benign
        seeds = sorted({x["seed"] for x in data})
        rnd = random.Random(11)
        test_seeds = set(rnd.sample(seeds, max(1, int(len(seeds) * 0.3))))
        y = np.array([1 if x["cls"] == "clear" else 0 for x in data])
        te = np.array([x["seed"] in test_seeds for x in data])

        def mat(cols):
            rows, cs = [], []
            for i, x in enumerate(data):
                c = x["vis"] + (x["pn"] if "n" in cols else []) + (x["pl"] if "l" in cols else [])
                rows.extend([i] * len(c))
                cs.extend(c)
            return sparse.csr_matrix((np.ones(len(cs), np.float32), (rows, cs)), shape=(len(data), NB))

        mild_te = [x for x in xs if x["cls"] == "mild" and x["seed"] in test_seeds]
        clf_rep = {}
        scores_vis = None
        has_probe = any(x["pn"] or x["pl"] for x in data)
        variants = (("visible", ""), ("visible+now", "n"), ("visible+now+latent", "nl"), ("probes_only_latent", "L")) if has_probe else (("visible", ""),)
        for name, cols in variants:
            if cols == "L":
                rows, cs = [], []
                for i, x in enumerate(data):
                    c = x["pl"]
                    rows.extend([i] * len(c))
                    cs.extend(c)
                X = sparse.csr_matrix((np.ones(len(cs), np.float32), (rows, cs)), shape=(len(data), NB))
            else:
                X = mat(cols)
            m = LogisticRegression(C=0.5, max_iter=400, solver="liblinear", class_weight=None)
            m.fit(X[~te], y[~te])
            s = m.decision_function(X[te])
            yt = y[te]
            pos = s[yt == 1]
            neg = np.sort(s[yt == 0])
            res = {"auc": auc(list(pos), list(neg)), "test_clear": int(len(pos)), "test_benign": int(len(neg))}
            for fir in (0.01, 0.005):
                thr = neg[min(len(neg) - 1, int(math.ceil(len(neg) * (1 - fir))))] if len(neg) else 0
                res[f"recall_at_fir_{fir}"] = round(float((pos > thr).mean()), 3) if len(pos) else None
            clf_rep[name] = res
            if name == "visible":
                rows_te = [x for x, t in zip(data, te) if t] + mild_te
                if mild_te:
                    rr, cs = [], []
                    for i, x in enumerate(mild_te):
                        rr.extend([i] * len(x["vis"]))
                        cs.extend(x["vis"])
                    Xm = sparse.csr_matrix((np.ones(len(cs), np.float32), (rr, cs)), shape=(len(mild_te), NB))
                    s_all = np.concatenate([s, m.decision_function(Xm)])
                else:
                    s_all = s
                scores_vis = (s_all, rows_te)
        # --- expected advantage vs probability of best (visible score bins over held-out rows of all classes)
        adv = None
        if scores_vis is not None:
            s_all, rows_te = scores_vis
            adv = advantage(np.asarray(s_all), rows_te)
        report["triggers"][trig] = {"classes": dict(cnt), "clear_with_benign_twin_signature": round(twin, 3),
                                    "lookalike_sets": len(mixed), "lookalike_clear": len(mc), "lookalike_benign": len(mb),
                                    "probes": dict(sorted(probes.items(), key=lambda kv: -(kv[1].get("sep") or 0))),
                                    "classifier": clf_rep, "advantage": adv}
        print(f"== {trig} {dict(cnt)} twin={twin:.2f} lookalike clear/benign={len(mc)}/{len(mb)}", flush=True)
        for n_, r_ in clf_rep.items():
            print(f"   {n_:22s} {r_}", flush=True)
        for k, v in list(report["triggers"][trig]["probes"].items())[:10]:
            print(f"   probe {k:24s} {v}", flush=True)
        if adv:
            for k_, v_ in adv["policies"].items():
                print(f"   policy {k_:22s} {v_}", flush=True)
    with open(os.path.join(a.out, "probe_summary.json"), "w") as fh:
        json.dump(report, fh, indent=1)


if __name__ == "__main__":
    main()
