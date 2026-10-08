#!/usr/bin/env python3
"""Build the real-app evaluation set: rows whose correct behaviour is unambiguous, so TRAIN can report real-app
precision/recall separately from sim numbers.

  python3 realapps/scripts/evalset.py <dataset dir> [<dataset dir> ...] --out <dir> [--splits test,dev]

Cases (each row gets meta.eval_case and meta.eval_expect):
  stale-overwrite   mutation, diagnosis stale, best in {discard, defer}, label mass on {discard, defer} >= 0.9,
                    gain over apply >= 1.0 in every counterfactual future         expect: a guard action (discard/defer)
  duplicate-submit  request, diagnosis duplicate, best in {coalesce, block}, mass on them >= 0.9, gain >= 1.0 in
                    every future                                                  expect: coalesce/block
  clean-benign      clean trajectory (calm network, default flags, no accidental clicks), passive best with label
                    mass >= 0.95 and every non-passive action at least 0.25 worse  expect: passive (any action = FP)
  benign-salient    non-clean, diagnosis expected, passive best with mass >= 0.95, every non-passive action >= 0.5
                    worse in every future                                         expect: passive
  genuine-break     inconsistency/mutation with diagnosis inconsistent and passive best = False with mass >= 0.9 on
                    {rollback, resync, discard, defer}                            expect: non-passive
Rows are balanced per case (--per-case, default 2000) and keep their original split.
"""
import collections, json, os, sys, glob

PASSIVE = {"mutation": "apply", "delivery": "deliver", "request": "send", "failure": "deliver", "stall": "wait", "inconsistency": "ignore", "transition": "ignore", "error": "ignore"}

def rows(d, splits):
    for split in splits:
        for f in [os.path.join(d, f"{split}.jsonl")] + sorted(glob.glob(os.path.join(d, "**", f"*.{split}.jsonl"), recursive=True)):
            if os.path.exists(f):
                for line in open(f):
                    if line.strip():
                        yield json.loads(line)

def every_future(m, acts, min_gain):
    cf = m.get("cost_futures") or {}
    P = m["passive"]
    if P not in cf:
        return False
    best_alt = None
    for a in acts:
        if a in cf:
            xs = cf[a]
            best_alt = xs if best_alt is None else [min(x, y) for x, y in zip(best_alt, xs)]
    if best_alt is None:
        return False
    return all(p - b >= min_gain for p, b in zip(cf[P], best_alt))

def classify(r):
    m = r["meta"]
    if m.get("diagnosis_only") or "action" not in r["labels"]:
        return None
    t = m["trigger"]
    dist = r["labels"]["action"]["dist"]
    P = PASSIVE[t]
    dg = m.get("diagnosis")
    mass = lambda acts: sum(dist.get(a, 0) for a in acts)
    if t == "mutation" and dg == "stale" and m["best"] in ("discard", "defer") and mass(("discard", "defer")) >= 0.9 and every_future(m, ("discard", "defer"), 1.0):
        return "stale-overwrite", ["discard", "defer"]
    if t == "request" and dg == "duplicate" and m["best"] in ("coalesce", "block") and mass(("coalesce", "block")) >= 0.9 and every_future(m, ("coalesce", "block"), 1.0):
        return "duplicate-submit", ["coalesce", "block"]
    costs = m["costs"]
    others = [a for a in costs if a != P]
    if m.get("clean") and m["passive_best"] and dist.get(P, 0) >= 0.95 and all(costs[a] - costs[P] >= 0.25 for a in others):
        return "clean-benign", [P]
    if not m.get("clean") and dg == "expected" and m["passive_best"] and dist.get(P, 0) >= 0.95:
        cf = m.get("cost_futures") or {}
        if all(all(x - p >= 0.5 for x, p in zip(cf.get(a, []), cf.get(P, []))) and cf.get(a) for a in others):
            return "benign-salient", [P]
    if dg == "inconsistent" and not m["passive_best"] and mass(("rollback", "resync", "discard", "defer")) >= 0.9:
        return "genuine-break", [a for a in ("rollback", "resync", "discard", "defer") if a in dist]
    return None

def main():
    args = sys.argv[1:]
    out = args[args.index("--out") + 1]
    splits = args[args.index("--splits") + 1].split(",") if "--splits" in args else ["test", "dev", "train"]
    per_case = int(args[args.index("--per-case") + 1]) if "--per-case" in args else 2000
    dirs = [a for i, a in enumerate(args) if not a.startswith("--") and (i == 0 or not args[i - 1].startswith("--"))]
    os.makedirs(out, exist_ok=True)
    picked = collections.defaultdict(list)
    for d in dirs:
        for r in rows(d, splits):
            c = classify(r)
            if c and len(picked[c[0]]) < per_case:
                r["meta"]["eval_case"] = c[0]
                r["meta"]["eval_expect"] = c[1]
                picked[c[0]].append(r)
    n = 0
    with open(os.path.join(out, "real_eval.jsonl"), "w") as f:
        for case, rs in picked.items():
            for r in rs:
                f.write(json.dumps(r) + "\n")
                n += 1
    summary = {case: {"rows": len(rs), "splits": dict(collections.Counter(r["split"] for r in rs)), "apps": dict(collections.Counter(r["meta"]["app"] for r in rs))} for case, rs in picked.items()}
    json.dump({"rows": n, "cases": summary, "sources": dirs, "splits": splits}, open(os.path.join(out, "manifest.json"), "w"), indent=1)
    print(json.dumps({"rows": n, "cases": {k: v["rows"] for k, v in summary.items()}}))

if __name__ == "__main__":
    main()
