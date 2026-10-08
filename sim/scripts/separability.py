#!/usr/bin/env python3
"""Separability of clear actionable rows vs benign look-alikes (stage 1: rows only).

  python3 sim/scripts/separability.py ROWS.jsonl [ROWS2.jsonl ...] --out DIR [--procs 16] [--limit N]

Classes (per row, using each future's cost + tier premium, i.e. exactly what the label sees):
  clear   : best non-passive beats passive by >= 2 on average, in every future, with the same action
  benign  : passive is best in every future (no non-passive action beats passive + premium in any future)
  mild    : everything else
Canonical facts: the runtime's fact lines with strings / numbers / ids / paths / store keys abstracted, so two rows
with the same canonical fact set are look-alikes as far as the fact templates go (numbers are compared separately).
Writes DIR/summary.json (per trigger x diagnosis: counts, look-alike rates, purity, cost-part attribution) and
DIR/pairs.jsonl (clear row + its nearest benign look-alike, both full rows).
"""
import argparse, collections, json, math, os, random, re, sys
from multiprocessing import Pool

PREM = {"passive": 0.0, "guard": 0.25, "heal": 0.5}
PARTS = ["area", "final_client", "final_server", "relation_s", "relation_final", "errors", "uncaught", "wasted", "latency_s"]
# cost weights (sim/src/oracle/cost.ts W) applied to cost_parts so the attribution is in cost units
PART_W = {"area": 1, "final_client": 4, "final_server": 1, "relation_s": 0.8, "relation_final": 2, "errors": 1.5,
          "uncaught": 1, "wasted": 0.08, "latency_s": 0.25}

R_STR = re.compile(r'"(?:[^"\\]|\\.)*"?')
R_OBJ = re.compile(r"\{[^{}]*\}")
R_ARR = re.compile(r"\[[^\[\]]*\]")
R_URL = re.compile(r"\b[\w-]+(?:\.[\w-]+)+/[\w/:.\-?=&%]*|(?<![\w.])/[\w/:.\-?=&%{}]+")
R_KEY = re.compile(r"\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+\b")
R_REF = re.compile(r"#\d+(?:–#\d+)?")
R_NUM = re.compile(r"-?\d+(?:\.\d+)?")


def canon(s: str) -> str:
    s = s.rstrip("…")
    s = R_STR.sub("S", s)
    for _ in range(3):
        s2 = R_OBJ.sub("{O}", s)
        if s2 == s:
            break
        s = s2
    for _ in range(2):
        s = R_ARR.sub("[A]", s)
    s = R_URL.sub("P", s)
    s = R_KEY.sub("K", s)
    s = R_REF.sub("#", s)
    s = R_NUM.sub("N", s)
    return re.sub(r"\s+", " ", s).strip()


def nums(s: str):
    s = R_STR.sub("S", s)
    s = R_REF.sub("#", s)
    return [float(x) for x in R_NUM.findall(s)]


def state_obj(r):
    st = r.get("state")
    if isinstance(st, str):
        try:
            st = json.loads(st)
        except Exception:
            st = {"facts": [st]}
    return st or {}


def lines(v):
    if v is None or v == "none":
        return []
    return v if isinstance(v, list) else [v]


def classify(m: dict, permitted: list[str]):
    cf = m.get("cost_futures") or {k: [v] for k, v in (m.get("costs") or {}).items()}
    passive = m.get("passive") or next((a for a, t in (m.get("tiers") or {}).items() if t == "passive"), None)
    if not cf or passive not in cf:
        return None
    tiers = m.get("tiers") or {}
    K = min(len(v) for v in cf.values())
    gaps, bests = [], []
    for f in range(K):
        cp = cf[passive][f]
        cand = [(cf[a][f] + PREM.get(tiers.get(a, "heal"), 0.5), a) for a in permitted if a != passive and a in cf]
        if not cand:
            return None
        c, a = min(cand)
        gaps.append(cp - c)
        bests.append(a)
    g = sum(gaps) / K
    if g >= 2 and min(gaps) > 0 and len(set(bests)) == 1:
        cls = "clear"
    elif max(gaps) <= 0:
        cls = "benign"
    else:
        cls = "mild"
    return cls, g, min(gaps), bests[0], passive, K


def featurize(line: str):
    r = json.loads(line)
    m = r.get("meta") or {}
    trig = m.get("trigger")
    if trig in (None, "ask") or m.get("diagnosis_only") or "action" not in (r.get("labels") or {}):
        return None
    q = (r.get("questions") or {}).get("action") or {}
    permitted = list((q.get("criteria") or {}).keys()) or list((m.get("costs") or {}).keys())
    c = classify(m, permitted)
    if c is None:
        return None
    cls, gap, mingap, best_np, passive, K = c
    st = state_obj(r)
    facts = lines(st.get("facts"))
    ftpl = sorted(set(canon(x) for x in facts))
    trig_t = canon(st.get("trigger") or "")
    inflight = lines(st.get("in_flight"))
    tl = lines(st.get("timeline"))
    stl = lines(st.get("state"))
    toks = set()
    for part, ls in (("f", facts), ("i", inflight), ("s", stl), ("l", tl[-10:])):
        for x in ls:
            for w in canon(x).split():
                toks.add(part + ":" + w)
    parts = m.get("cost_parts") or {}
    pdelta = None
    if best_np in parts and passive in parts:
        pdelta = {k: round(PART_W[k] * ((parts[best_np].get(k) or 0) - (parts[passive].get(k) or 0)), 3) for k in PARTS}
    lab = (r.get("labels") or {}).get("action", {}).get("dist") or {}
    return {
        "id": r["id"], "split": r.get("split"), "trigger": trig, "diag": m.get("diagnosis") or (r.get("labels", {}).get("diagnosis") or {}).get("label"),
        "cls": cls, "gap": round(gap, 3), "mingap": round(mingap, 3), "best_np": best_np, "passive": passive, "K": K,
        "sig": trig_t + " || " + " | ".join(ftpl), "ftpl": ftpl, "toks": sorted(toks), "nfacts": len(facts), "ninflight": len(inflight),
        "feature": m.get("subject_feature"), "chaos": m.get("chaos"), "budget": m.get("budget"), "pdelta": pdelta,
        "npmass": m.get("non_passive_mass"), "label_np_max": max([v for a, v in lab.items() if a != passive] or [0]),
        "seed": m.get("seed"), "decision": m.get("decision"), "family": m.get("family"),
    }


def read_lines(paths, limit):
    n = 0
    for p in paths:
        with open(p) as fh:
            for line in fh:
                yield line
                n += 1
                if limit and n >= limit:
                    return


def jacc(a, b):
    if not a and not b:
        return 1.0
    return len(a & b) / max(1, len(a | b))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rows", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--procs", type=int, default=16)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--pairs-per-group", type=int, default=40)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    with Pool(a.procs) as pool:
        recs = [x for x in pool.imap(featurize, read_lines(a.rows, a.limit), chunksize=500) if x]
    print(f"rows {len(recs)}", file=sys.stderr)

    by_trig = collections.defaultdict(list)
    for x in recs:
        by_trig[x["trigger"]].append(x)
    summary = {"rows": len(recs), "definition": {"clear": "mean gap >= 2, every future > 0, same best action", "benign": "passive best in every future"}, "triggers": {}}
    pairs = []
    rnd = random.Random(7)
    for trig, xs in sorted(by_trig.items()):
        cnt = collections.Counter(x["cls"] for x in xs)
        sig_cnt = collections.defaultdict(collections.Counter)
        for x in xs:
            sig_cnt[x["sig"]][x["cls"]] += 1
        clear = [x for x in xs if x["cls"] == "clear"]
        benign = [x for x in xs if x["cls"] == "benign"]
        # look-alike rate: clear rows whose canonical fact signature also occurs on benign rows
        with_twin = sum(1 for x in clear if sig_cnt[x["sig"]]["benign"] > 0)
        # signature-only oracle: rank signatures by clear purity, recall at a precision floor (clear vs benign)
        sigs = [(c["clear"] / (c["clear"] + c["benign"]), c["clear"], c["benign"]) for c in sig_cnt.values() if c["clear"] + c["benign"]]
        sigs.sort(reverse=True)
        curve = {}
        for floor in (0.95, 0.9, 0.8, 0.5):
            tp = fp = 0
            best_tp = 0
            for pur, cc, bb in sigs:
                tp += cc
                fp += bb
                if tp and tp / (tp + fp) >= floor:
                    best_tp = tp
            curve[f"recall_at_precision_{floor}"] = round(best_tp / max(1, len(clear)), 4)
        # purity of each clear row's signature (benign share among clear+benign with the same signature)
        pur = sorted(sig_cnt[x["sig"]]["clear"] / (sig_cnt[x["sig"]]["clear"] + sig_cnt[x["sig"]]["benign"]) for x in clear)
        groups = collections.defaultdict(list)
        for x in clear:
            groups[(x["diag"], x["best_np"])].append(x)
        gsum = {}
        bidx = collections.defaultdict(list)
        for b in benign:
            bidx[b["sig"]].append(b)
        bdiag = collections.defaultdict(list)
        for b in benign:
            bdiag[b["diag"]].append(b)
        for (dg, act), cs in sorted(groups.items(), key=lambda kv: -len(kv[1])):
            tw = sum(1 for x in cs if sig_cnt[x["sig"]]["benign"] > 0)
            # benign rows in the same signatures: what share of them carry the same diagnosis label
            same_diag = [b for x in cs[:400] for b in bidx.get(x["sig"], [])[:20]]
            part_mean = collections.defaultdict(float)
            for x in cs:
                for k, v in (x["pdelta"] or {}).items():
                    part_mean[k] += v / len(cs)
            gsum[f"{dg}/{act}"] = {
                "clear_rows": len(cs), "with_benign_twin_signature": round(tw / len(cs), 3),
                "twin_benign_same_diag": round(sum(1 for b in same_diag if b["diag"] == dg) / max(1, len(same_diag)), 3),
                "mean_gap": round(sum(x["gap"] for x in cs) / len(cs), 2),
                "cost_part_delta_best_minus_passive": {k: round(v, 2) for k, v in part_mean.items()},
                "features": collections.Counter(x["feature"] for x in cs).most_common(8),
            }
            # pairs: nearest benign by token jaccard, same signature first, else same diagnosis label
            for x in rnd.sample(cs, min(a.pairs_per_group, len(cs))):
                pool_ = bidx.get(x["sig"]) or []
                how = "same-signature"
                if not pool_:
                    pool_ = bdiag.get(x["diag"]) or benign
                    how = "same-diagnosis" if bdiag.get(x["diag"]) else "same-trigger"
                cand = rnd.sample(pool_, min(3000, len(pool_)))
                tx = set(x["toks"])
                best = max(cand, key=lambda b: jacc(tx, set(b["toks"])), default=None)
                if best:
                    pairs.append({"trigger": trig, "group": f"{dg}/{act}", "how": how, "jaccard": round(jacc(tx, set(best["toks"])), 3),
                                  "clear": {k: x[k] for k in ("id", "diag", "gap", "best_np", "feature", "pdelta", "seed", "decision")},
                                  "benign": {k: best[k] for k in ("id", "diag", "gap", "best_np", "feature", "pdelta", "seed", "decision")}})
        summary["triggers"][trig] = {
            "rows": len(xs), "classes": dict(cnt),
            "clear_with_benign_twin_signature": round(with_twin / max(1, len(clear)), 3),
            "clear_signature_purity_p10_p50_p90": [round(pur[int(q * (len(pur) - 1))], 3) for q in (0.1, 0.5, 0.9)] if pur else None,
            "signature_only_oracle": curve,
            "distinct_signatures": len(sig_cnt),
            "groups": gsum,
        }
    with open(os.path.join(a.out, "summary.json"), "w") as fh:
        json.dump(summary, fh, indent=1)
    with open(os.path.join(a.out, "pairs.jsonl"), "w") as fh:
        for p in pairs:
            fh.write(json.dumps(p) + "\n")
    # compact features for later stages (classifier, hidden facts join)
    with open(os.path.join(a.out, "feats.jsonl"), "w") as fh:
        for x in recs:
            if x["cls"] in ("clear", "benign") or rnd.random() < 0.1:
                fh.write(json.dumps({k: x[k] for k in ("id", "trigger", "diag", "cls", "gap", "best_np", "sig", "toks", "feature", "seed", "decision", "budget", "chaos")}) + "\n")
    print(json.dumps({t: {k: v for k, v in s.items() if k != "groups"} for t, s in summary["triggers"].items()}, indent=1))


if __name__ == "__main__":
    main()
