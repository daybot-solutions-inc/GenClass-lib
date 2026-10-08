#!/usr/bin/env python3
"""Re-derive gold action labels from the stored per-future costs (meta.cost_futures), without regenerating.

  python3 relabel.py IN.jsonl[.gz] OUT.jsonl[.gz] [--tau0 0.1] [--se-mul 1.0] [--guard 0.25] [--heal 0.5]
                     [--tie-eps 0.05] [--tie-penalty 1.5]

Mirrors actionLabel() in sim/src/oracle/cost.ts exactly (defaults = the generator's): tier premiums per action, a
practical tie with passive pinned to passive + tie-penalty, gap to the best action averaged over paired futures, and a
per-action temperature tau0 + se_mul * SE(paired difference). Rows without cost_futures (ask, diagnosis-only,
unlabeled) pass through unchanged. Prints how many rows changed their best action.
"""
import argparse, gzip, json, math

TIER = {"apply": "passive", "send": "passive", "deliver": "passive", "wait": "passive", "ignore": "passive",
        "discard": "guard", "defer": "guard", "coalesce": "guard", "delay": "guard",
        "block": "heal", "serve_cached": "heal", "retry": "heal", "hedge": "heal", "rollback": "heal", "resync": "heal"}


def label(costs, passive, a):
    prem = {"passive": 0.0, "guard": a.guard, "heal": a.heal}
    acts = list(costs)
    K = min(len(costs[x]) for x in acts)
    cp = costs.get(passive)
    mp = sum(cp[:K]) / K if cp else None
    adj = {}
    for x in acts:
        xs = costs[x][:K]
        if x != passive and cp and abs(sum(xs) / K - mp) < a.tie_eps:
            adj[x] = [c + a.tie_penalty for c in cp[:K]]
        else:
            adj[x] = [c + prem[TIER.get(x, "heal")] for c in xs]
    best = passive if passive in acts else acts[0]
    for x in acts:
        if sum(adj[x]) / K < sum(adj[best]) / K - 1e-12:
            best = x
    raw = {}
    for x in acts:
        d = [adj[x][j] - adj[best][j] for j in range(K)]
        gap = max(0.0, sum(d) / K)
        if K > 1:
            m = sum(d) / K
            se = math.sqrt(sum((v - m) ** 2 for v in d) / (K - 1)) / math.sqrt(K)
        else:
            se = 0.0
        raw[x] = math.exp(-gap / (a.tau0 + a.se_mul * se))
    z = sum(raw.values())
    return {x: round(raw[x] / z, 4) for x in acts}, best


def opener(p, mode):
    return gzip.open(p, mode + "t") if p.endswith(".gz") else open(p, mode)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inp"); ap.add_argument("out")
    ap.add_argument("--tau0", type=float, default=0.1); ap.add_argument("--se-mul", type=float, default=1.0)
    ap.add_argument("--guard", type=float, default=0.25); ap.add_argument("--heal", type=float, default=0.5)
    ap.add_argument("--tie-eps", type=float, default=0.05); ap.add_argument("--tie-penalty", type=float, default=1.5)
    a = ap.parse_args()
    n = changed = relabelled = 0
    with opener(a.inp, "r") as src, opener(a.out, "w") as dst:
        for line in src:
            if not line.strip():
                continue
            r = json.loads(line)
            n += 1
            m = r.get("meta", {})
            cf = m.get("cost_futures")
            if cf and "action" in r.get("labels", {}):
                shown = set((r["questions"].get("action") or {}).get("criteria", {}).keys())
                dist, best = label({k: v for k, v in cf.items()}, m.get("passive") or next(iter(cf)), a)
                # keep only offered options (the post-transform may have dropped one) and renormalise
                if shown:
                    dist = {k: v for k, v in dist.items() if k in shown}
                    z = sum(dist.values()) or 1.0
                    dist = {k: round(v / z, 4) for k, v in dist.items()}
                if best != m.get("best"):
                    changed += 1
                r["labels"]["action"] = {"type": "choice", "dist": dist}
                m["best"] = best
                m["passive_best"] = best == m.get("passive")
                relabelled += 1
            dst.write(json.dumps(r) + "\n")
    print(f"rows {n}, relabelled {relabelled}, best action changed {changed}")


if __name__ == "__main__":
    main()
