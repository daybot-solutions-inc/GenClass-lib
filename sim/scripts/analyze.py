#!/usr/bin/env python3
"""Summarise a generated dataset: python3 sim/scripts/analyze.py sim/out/r300k"""
import collections, json, sys, os

d = sys.argv[1]
joint = collections.defaultdict(collections.Counter)
conf = collections.defaultdict(list)
splits = collections.Counter()
kinds = collections.Counter()
transform = collections.Counter()
vocab_default = collections.Counter()
domains = collections.defaultdict(set)
families = collections.defaultdict(set)
per_split_trigger = collections.defaultdict(collections.Counter)
diag_only = collections.Counter()
expl = collections.Counter()
sharp = collections.defaultdict(lambda: collections.Counter())
fut = collections.Counter()
budget_rows = collections.Counter()
budget_pb = collections.defaultdict(lambda: [0, 0])
budget_chars = collections.defaultdict(list)
nrows = 0
import glob
def files_for(split):
    merged = os.path.join(d, f"{split}.jsonl")
    if os.path.exists(merged):
        return [merged]
    return sorted(glob.glob(os.path.join(d, "parts", f"part-*.{split}.jsonl")))
def lines_for(split):
    for p in files_for(split):
        for line in open(p):
            yield line
for split in ("train", "dev", "test"):
    for line in lines_for(split):
        r = json.loads(line)
        nrows += 1
        m = r["meta"]
        t = m["trigger"]
        splits[split] += 1
        per_split_trigger[split][t] += 1
        domains[split].add(m["domain"])
        b = m.get("budget", 0)
        budget_rows[b] += 1
        if len(budget_chars[b]) < 50000: budget_chars[b].append(len(json.dumps(r["state"])))
        families[split].add(m["family"])
        if t == "ask":
            for k in m.get("kinds", []):
                kinds[k] += 1
            continue
        if m.get("diagnosis_only"):
            diag_only[(t, m.get("diagnosis"))] += 1
            continue
        joint[t][(m.get("diagnosis"), m["best"])] += 1
        budget_pb[(b, t)][0] += 1
        budget_pb[(b, t)][1] += 1 if m["passive_best"] else 0
        dist = r["labels"]["action"]["dist"]
        conf[t].append(max(dist.values()))
        transform[m.get("transform", "?").split(",")[0] if m.get("transform") else "?"] += 1
        dq = r["questions"].get("diagnosis", {}).get("criteria", {})
        vocab_default["default" if dq.get("stale") == "outdated data or an older operation is about to replace newer state" else "paraphrased/subset"] += 1
        expl["after-exploration" if m.get("explored_before") else "passive-path"] += 1
        fut[m.get("futures", 1)] += 1
        npm = m.get("non_passive_mass")
        if npm is not None:
            costs = m["costs"]
            P = {"mutation": "apply", "request": "send", "failure": "deliver", "stall": "wait", "inconsistency": "ignore", "transition": "ignore", "error": "ignore"}[t]
            gain = costs[P] - min(costs.values())
            if m["passive_best"]:
                b = "passive-best"
                sharp[b]["rows"] += 1
                sharp[b]["passive>=0.9"] += 1 if 1 - npm >= 0.9 else 0
            else:
                b = "gain<0.5" if gain < 0.5 else "gain 0.5-2" if gain < 2 else "gain>=2"
                sharp[b]["rows"] += 1
                sharp[b]["nonpassive>=0.95"] += 1 if npm >= 0.95 else 0
                sharp[b]["nonpassive>=0.9"] += 1 if npm >= 0.9 else 0
                sharp[b]["nonpassive<0.6"] += 1 if npm < 0.6 else 0

print("rows", nrows, dict(splits))
for s in ("train", "dev", "test"):
    print(f"  {s}: {dict(per_split_trigger[s])}  domains={len(domains[s])} families={len(families[s])}")
print("held-out domains only in test:", sorted(domains["test"] - domains["train"] - domains["dev"]))
print()
for t, c in joint.items():
    tot = sum(c.values())
    pb = sum(v for (dg, b), v in c.items() if b in ("apply", "send", "deliver", "wait", "ignore"))
    cs = sorted(conf[t])
    print(f"{t}: {tot} rows, passive best {pb/tot:.1%}, label max-prob median {cs[len(cs)//2]:.2f}")
    for (dg, b), v in sorted(c.items(), key=lambda x: -x[1])[:12]:
        print(f"    {dg:>12} -> {b:<12} {v:6d}  ({v/tot:.1%})")
print()
print("diagnosis-only rows", dict(diag_only))
print("ask question kinds", dict(kinds))
print("transform", dict(transform))
print("diagnosis vocabulary", dict(vocab_default))
print("exploration", dict(expl))
print()
for b in sorted(budget_rows):
    cs = sorted(budget_chars[b])
    pb = {t: f"{v[1]/v[0]:.1%}" for (bb, t), v in sorted(budget_pb.items()) if bb == b}
    print(f"budget {b}: rows {budget_rows[b]}, state JSON chars p50 {cs[len(cs)//2]} max {cs[-1]}, passive-best {pb}")
print()
print("futures per labelled point", dict(fut))
for b, c in sharp.items():
    n = c["rows"]
    print(f"label sharpness [{b}] rows={n} " + " ".join(f"{k}={v/n:.1%}" for k, v in c.items() if k != "rows"))
