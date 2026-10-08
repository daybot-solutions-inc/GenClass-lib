#!/usr/bin/env python3
"""On-policy (DAgger) report: what the model did through each gate, by trigger.

  python3 sim/scripts/onpolicy_report.py DIR [--examples N] [--out report.json]

DIR holds gz shards (collect.py output: {train,dev,test}-NNNNN.jsonl.gz) or parts/ / plain jsonl files.
Per gate (meta.gate) and trigger, over counterfactual-labelled on-policy rows:
  acted         the gate ran a non-passive action (meta.ran != passive)
  false int.    acted while passive is best in the labels (meta.false_intervention)
  harmful       acted and the action's mean cost exceeds passive's by > 1 (meta.ran_harm > 1)
  good acts     acted and the ran action is the label's best
  miss          passive ran while a non-passive action has >= 0.9 label mass (meta.miss)
  gain lost     sum over misses of (passive cost - best cost)
plus the model's diagnosis on false interventions, the actions involved, and the worst cases (row ids).
"""
import argparse, collections, glob, gzip, json, os


def rows(d):
    files = sorted(glob.glob(os.path.join(d, "*.jsonl.gz"))) or sorted(glob.glob(os.path.join(d, "parts", "*.jsonl"))) or sorted(glob.glob(os.path.join(d, "*.jsonl")))
    for f in files:
        op = gzip.open if f.endswith(".gz") else open
        with op(f, "rt") as fh:
            for line in fh:
                r = json.loads(line)
                m = r.get("meta") or {}
                if m.get("on_policy") and "costs" in m:
                    yield r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--examples", type=int, default=5)
    ap.add_argument("--out")
    a = ap.parse_args()
    C = collections.defaultdict(lambda: collections.Counter())
    gainlost = collections.defaultdict(float)
    fi_diag = collections.defaultdict(collections.Counter)
    fi_act = collections.defaultdict(collections.Counter)
    harm_sum = collections.defaultdict(float)
    worst = collections.defaultdict(list)
    for r in rows(a.dir):
        m = r["meta"]
        g, t = m.get("gate", "?"), m["trigger"]
        k = (g, t)
        passive = m["passive"]
        ran = m.get("ran") or passive
        c = C[k]
        c["rows"] += 1
        c["passive_best"] += int(m["passive_best"])
        acted = ran != passive
        if acted:
            c["acted"] += 1
            if m.get("false_intervention"):
                c["false"] += 1
                fi_diag[k][m.get("model_diagnosis") or "?"] += 1
                fi_act[k][ran] += 1
            h = float(m.get("ran_harm") or 0)
            if h > 1:
                c["harmful"] += 1
                harm_sum[k] += h
                worst[k].append((h, r["id"], ran, m.get("diagnosis"), m.get("model_diagnosis"), r["split"]))
            if ran == m["best"]:
                c["good"] += 1
        if m.get("miss"):
            c["miss"] += 1
            costs = m["costs"]
            gainlost[k] += costs[passive] - min(costs.values())
    out = {}
    for g in sorted({k[0] for k in C}):
        print(f"\n## gate = {g}")
        print("| trigger | rows | passive best | acted | false int. (% of acts) | harmful >1 | good acts | misses | gain lost / miss |")
        print("|---|---|---|---|---|---|---|---|---|")
        tot = collections.Counter()
        for (gg, t), c in sorted(C.items()):
            if gg != g:
                continue
            tot.update(c)
            fa = f"{c['false']} ({c['false'] / c['acted']:.0%})" if c["acted"] else "0"
            gl = f"{gainlost[(gg, t)] / c['miss']:.2f}" if c["miss"] else "-"
            print(f"| {t} | {c['rows']} | {c['passive_best'] / c['rows']:.0%} | {c['acted']} | {fa} | {c['harmful']} | {c['good']} | {c['miss']} | {gl} |")
            out[f"{g}/{t}"] = {**c, "gain_lost": round(gainlost[(gg, t)], 2), "harm_sum": round(harm_sum[(gg, t)], 2),
                              "false_by_model_diagnosis": dict(fi_diag[(gg, t)].most_common()), "false_by_action": dict(fi_act[(gg, t)].most_common()),
                              "worst": [dict(zip(("harm", "id", "ran", "gold_diag", "model_diag", "split"), w)) for w in sorted(worst[(gg, t)], reverse=True)[: a.examples]]}
        fa = f"{tot['false']} ({tot['false'] / tot['acted']:.0%})" if tot["acted"] else "0"
        print(f"| **all** | {tot['rows']} | {tot['passive_best'] / max(1, tot['rows']):.0%} | {tot['acted']} | {fa} | {tot['harmful']} | {tot['good']} | {tot['miss']} | |")
        for (gg, t) in sorted(C):
            if gg != g or not fi_act[(gg, t)]:
                continue
            print(f"- {t}: false interventions by action {dict(fi_act[(gg, t)].most_common(4))}, model diagnosis {dict(fi_diag[(gg, t)].most_common(4))}")
            for w in sorted(worst[(gg, t)], reverse=True)[: min(3, a.examples)]:
                print(f"    worst: harm {w[0]:.1f} `{w[1]}` ran {w[2]} (gold diagnosis {w[3]}, model said {w[4]}, {w[5]})")
    if a.out:
        with open(a.out, "w") as fh:
            json.dump(out, fh, indent=1)


if __name__ == "__main__":
    main()
