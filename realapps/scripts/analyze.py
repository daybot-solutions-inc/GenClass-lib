#!/usr/bin/env python3
"""Summarise a realapps dataset and compare it with the sim's final-A statistics.

  python3 realapps/scripts/analyze.py ~/gcl/real-out/pilot [--sim sim/samples/stats-final-a.json] [--json out.json]
"""
import collections, glob, json, os, sys

PASSIVE = {"mutation": "apply", "delivery": "deliver", "request": "send", "failure": "deliver", "stall": "wait", "inconsistency": "ignore", "transition": "ignore", "error": "ignore"}

def rows_of(d):
    for split in ("train", "dev", "test"):
        files = [os.path.join(d, f"{split}.jsonl")] if os.path.exists(os.path.join(d, f"{split}.jsonl")) else sorted(glob.glob(os.path.join(d, "**", f"*.{split}.jsonl"), recursive=True))
        for f in files:
            for line in open(f):
                if line.strip():
                    yield split, json.loads(line)

def main():
    d = sys.argv[1]
    sim_path = sys.argv[sys.argv.index("--sim") + 1] if "--sim" in sys.argv else os.path.join(os.path.dirname(__file__), "../../sim/samples/stats-final-a.json")
    out_json = sys.argv[sys.argv.index("--json") + 1] if "--json" in sys.argv else None
    n = 0
    splits = collections.Counter()
    trig = collections.Counter()
    diag = collections.defaultdict(collections.Counter)
    best = collections.defaultdict(collections.Counter)
    joint = collections.defaultdict(collections.Counter)
    pbest = collections.Counter()
    conf = collections.defaultdict(list)
    sharp = collections.defaultdict(collections.Counter)
    harm = collections.defaultdict(lambda: collections.defaultdict(list))
    apps = collections.defaultdict(collections.Counter)
    fw = collections.Counter()
    diag_only = collections.Counter()
    budgets = collections.Counter()
    clean = collections.Counter()
    chars = []
    ask_kinds = collections.Counter()
    for split, r in rows_of(d):
        n += 1
        m = r["meta"]
        t = m["trigger"]
        splits[split] += 1
        apps[m["app"]][t] += 1
        fw[m.get("framework", "?")] += 1
        budgets[m.get("budget")] += 1
        if len(chars) < 20000:
            chars.append(len(json.dumps(r["state"])))
        if t == "ask":
            trig["ask"] += 1
            for k in m.get("kinds", []):
                ask_kinds[k] += 1
            continue
        if m.get("diagnosis_only"):
            diag_only[(t, m.get("diagnosis"))] += 1
            trig[t + " (diag-only)"] += 1
            continue
        trig[t] += 1
        dg = m.get("diagnosis")
        diag[t][dg] += 1
        best[t][m["best"]] += 1
        joint[t][(dg, m["best"])] += 1
        if m["passive_best"]:
            pbest[t] += 1
        dist = r["labels"]["action"]["dist"]
        conf[t].append(max(dist.values()))
        npm = m.get("non_passive_mass", 0)
        costs = m["costs"]
        P = PASSIVE[t]
        gain = costs[P] - min(costs.values())
        if m["passive_best"]:
            sharp["passive-best"]["rows"] += 1
            sharp["passive-best"]["passive>=0.9"] += 1 if 1 - npm >= 0.9 else 0
            for a, c in costs.items():
                if a != P:
                    harm[t][a].append(c - costs[P])
        else:
            b = "gain<0.5" if gain < 0.5 else "gain 0.5-2" if gain < 2 else "gain>=2"
            sharp[b]["rows"] += 1
            sharp[b]["nonpassive>=0.9"] += 1 if npm >= 0.9 else 0
        if m.get("clean"):
            clean["rows"] += 1
            clean["passive-best"] += 1 if m["passive_best"] else 0
    sim = json.load(open(sim_path)) if os.path.exists(sim_path) else None
    lines = []
    p = lines.append
    p(f"rows {n} {dict(splits)}; diagnosis-only {sum(diag_only.values())}; frameworks {dict(fw)}")
    p(f"apps: {len(apps)}; budgets {dict(budgets)}; state chars median {sorted(chars)[len(chars)//2] if chars else 0}")
    if clean["rows"]:
        p(f"clean rows {clean['rows']}, passive best {clean['passive-best']/clean['rows']:.1%}")
    p("")
    sim_rows = collections.Counter()
    if sim:
        for s, c in sim["rows_by_split_trigger"].items():
            for t, v in c.items():
                if t != "ask":
                    sim_rows[t] += v
    tot = sum(v for k, v in trig.items() if "(diag" not in k and k != "ask") or 1
    stot = sum(sim_rows.values()) or 1
    p(f"{'trigger':<14}{'real rows':>10}{'share':>8}{'sim share':>10}{'passive':>9}{'sim pass':>9}  label max-p median")
    for t in PASSIVE:
        if not trig[t] and not sim_rows[t]:
            continue
        cs = sorted(conf[t])
        simpb = None
        if sim:
            num = den = 0
            for k, v in sim["best_action_by_split_trigger"].items():
                if k.endswith("|" + t):
                    for a, c in v.items():
                        den += c
                        num += c if a == PASSIVE[t] else 0
            simpb = num / den if den else None
        p(f"{t:<14}{trig[t]:>10}{trig[t]/tot:>8.1%}{sim_rows[t]/stot:>10.1%}{(pbest[t]/trig[t] if trig[t] else 0):>9.1%}{(simpb if simpb is not None else 0):>9.1%}  {cs[len(cs)//2] if cs else 0:.2f}")
    p("")
    for t in PASSIVE:
        if not trig[t]:
            continue
        sd = collections.Counter()
        if sim:
            for k, v in sim["diagnosis_by_split_trigger"].items():
                if k.endswith("|" + t):
                    sd.update(v)
        sdt = sum(sd.values()) or 1
        p(f"{t}: diagnosis real {{{', '.join(f'{k}: {v/trig[t]:.0%}' for k, v in diag[t].most_common())}}}")
        if sd:
            p(f"{' ' * len(t)}  diagnosis sim  {{{', '.join(f'{k}: {v/sdt:.0%}' for k, v in sd.most_common())}}}")
        p(f"{' ' * len(t)}  best real {{{', '.join(f'{k}: {v/trig[t]:.0%}' for k, v in best[t].most_common())}}}")
        if sim:
            sb = collections.Counter()
            for k, v in sim["best_action_by_split_trigger"].items():
                if k.endswith("|" + t):
                    sb.update(v)
            sbt = sum(sb.values()) or 1
            p(f"{' ' * len(t)}  best sim  {{{', '.join(f'{k}: {v/sbt:.0%}' for k, v in sb.most_common())}}}")
        hm = {a: round(sum(x) / len(x), 2) for a, x in harm[t].items() if x}
        p(f"{' ' * len(t)}  harm of non-passive on passive-best rows (mean cost increase) {hm}")
        p(f"{' ' * len(t)}  top (diagnosis -> best): " + ", ".join(f"{dg}->{b} {v}" for (dg, b), v in joint[t].most_common(8)))
    p("")
    p("label sharpness: " + json.dumps({k: dict(v) for k, v in sharp.items()}))
    p("diagnosis-only rows: " + json.dumps({f"{a}|{b}": v for (a, b), v in diag_only.items()}))
    p("ask rows: " + str(trig["ask"]) + " " + json.dumps(dict(ask_kinds)))
    p("")
    p("per app (decision rows by trigger):")
    for a, c in sorted(apps.items()):
        p(f"  {a:<28} {sum(c.values()):>6}  {dict(c.most_common())}")
    print("\n".join(lines))
    if out_json:
        json.dump({"rows": n, "splits": splits, "triggers": trig, "diagnosis": diag, "best": best, "passive_best": pbest, "apps": apps, "frameworks": fw, "sharpness": sharp, "clean": clean, "report": lines}, open(out_json, "w"), indent=1, default=lambda o: dict(o) if isinstance(o, collections.Counter) else str(o))

if __name__ == "__main__":
    main()
