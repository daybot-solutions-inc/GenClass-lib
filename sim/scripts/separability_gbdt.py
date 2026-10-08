#!/usr/bin/env python3
"""Nonlinear check for the separability probes: gradient-boosted trees on [out-of-fold visible-text score +
probe values], clear vs benign per trigger, held-out by trajectory seed. Same rows/definitions as
separability_probe.py.

  ~/jev/.venv/bin/python sim/scripts/separability_gbdt.py ROWS.jsonl [...] [--procs 16]
"""
import argparse, collections, importlib.util, math, os, random, sys
from multiprocessing import Pool

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("sp", os.path.join(HERE, "separability_probe.py"))
sp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sp)


def _load(line):
    return sp.load(line)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rows", nargs="+")
    ap.add_argument("--procs", type=int, default=16)
    a = ap.parse_args()
    import numpy as np
    from scipy import sparse
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.linear_model import LogisticRegression

    with Pool(a.procs) as pool:
        recs = [x for x in pool.imap(_load, sp.sep.read_lines(a.rows, 0), chunksize=200) if x]
    by = collections.defaultdict(list)
    for x in recs:
        if x["cls"] in ("clear", "benign"):
            by[x["trigger"]].append(x)
    for trig, data in sorted(by.items()):
        y = np.array([1 if x["cls"] == "clear" else 0 for x in data])
        if y.sum() < 100:
            continue
        seeds = sorted({x["seed"] for x in data})
        rnd = random.Random(11)
        test = set(rnd.sample(seeds, int(len(seeds) * 0.3)))
        te = np.array([x["seed"] in test for x in data])
        # out-of-fold visible score (2 folds over training seeds; test rows scored by a model fit on all train rows)
        rows, cs = [], []
        for i, x in enumerate(data):
            rows.extend([i] * len(x["vis"]))
            cs.extend(x["vis"])
        X = sparse.csr_matrix((np.ones(len(cs), np.float32), (rows, cs)), shape=(len(data), sp.NB))
        vis = np.zeros(len(data))
        tr_idx = np.where(~te)[0]
        fold = np.array([hash(data[i]["seed"]) % 2 for i in tr_idx])
        for f in (0, 1):
            fit, pred = tr_idx[fold != f], tr_idx[fold == f]
            m = LogisticRegression(C=0.5, max_iter=400, solver="liblinear").fit(X[fit], y[fit])
            vis[pred] = m.decision_function(X[pred])
        m = LogisticRegression(C=0.5, max_iter=400, solver="liblinear").fit(X[tr_idx], y[tr_idx])
        vis[te] = m.decision_function(X[te])
        keys_n = sorted({k for x in data for k in x["probe"] if k.startswith("n_")})
        keys_l = sorted({k for x in data for k in x["probe"] if k.startswith("l_")})
        cats = collections.defaultdict(dict)

        def val(x, k):
            v = x["probe"].get(k)
            if v is None:
                return np.nan
            if isinstance(v, bool):
                return float(v)
            if isinstance(v, (int, float)):
                return float(v)
            return float(cats[k].setdefault(v, len(cats[k])))

        out = []
        for name, keys in (("visible score only", []), ("+ now probes", keys_n), ("+ now + latent probes", keys_n + keys_l), ("latent probes only (no text)", keys_l)):
            cols = [vis] if "only (no text)" not in name else []
            for k in keys:
                cols.append(np.array([val(x, k) for x in data]))
            if not cols:
                continue
            F = np.vstack(cols).T
            g = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.08, max_leaf_nodes=31, random_state=0)
            g.fit(F[~te], y[~te])
            s = g.predict_proba(F[te])[:, 1]
            pos, neg = s[y[te] == 1], np.sort(s[y[te] == 0])
            res = {"auc": sp.auc(list(pos), list(neg))}
            for fir in (0.01, 0.005):
                thr = neg[min(len(neg) - 1, int(math.ceil(len(neg) * (1 - fir))))]
                res[f"recall@FIR{fir}"] = round(float((pos > thr).mean()), 3)
            out.append((name, res))
        print(f"== {trig} clear={int(y.sum())} benign={int((1 - y).sum())} test_clear={int(y[te].sum())}", flush=True)
        for n_, r_ in out:
            print(f"   {n_:30s} {r_}", flush=True)


if __name__ == "__main__":
    main()
