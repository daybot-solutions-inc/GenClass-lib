#!/usr/bin/env python3
"""Counts for the certification dev set (realapps/scripts/cert.sh): per trigger x mode (clean / chaos) x category.

  python3 realapps/scripts/cert_report.py /data/real-out/v23-cert [--target 5000]

Categories of an action-labelled row: passive-best (benign; the FIR denominator), of which confident (passive label
mass >= 0.95) and salient (confident and every non-passive action >= 0.5 worse in every future); action-best by best
action; diagnosis; and the eval-set cases of realapps/scripts/evalset.py. Writes cert_report.md / .json into the
directory and prints the markdown.
"""
import collections, glob, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from evalset import PASSIVE, classify  # noqa: E402

TRIGGERS = ["request", "delivery", "mutation", "failure", "stall", "inconsistency", "transition", "error"]


def main():
    d = sys.argv[1]
    target = int(sys.argv[sys.argv.index("--target") + 1]) if "--target" in sys.argv else 5000
    C = collections.defaultdict(collections.Counter)  # (trigger, mode) -> counter
    apps = collections.defaultdict(collections.Counter)  # trigger -> app -> passive-best rows
    traj = collections.Counter()
    seen_split = collections.Counter()
    parts = []
    for part in sorted(glob.glob(os.path.join(d, "cert-*"))):
        st = json.load(open(os.path.join(part, "stats.json"))) if os.path.exists(os.path.join(part, "stats.json")) else {}
        parts.append({"part": os.path.basename(part), "trajectories": st.get("trajectories"), "rows": st.get("rows"), "drops": st.get("drops"), "skipped": st.get("skipped"), "seeds": (json.load(open(os.path.join(part, "manifest.json"))).get("seeds") if os.path.exists(os.path.join(part, "manifest.json")) else None)})
        for f in glob.glob(os.path.join(part, "*.jsonl")):
            for line in open(f):
                r = json.loads(line)
                m = r["meta"]
                seen_split[r["split"]] += 1
                mode = m.get("cert", "?")
                t = m["trigger"]
                c = C[(t, mode)]
                if m.get("diagnosis_only"):
                    c["diagnosis-only"] += 1
                    continue
                c["labelled"] += 1
                P = PASSIVE.get(t, m.get("passive"))
                dist = r["labels"]["action"]["dist"]
                if m["passive_best"]:
                    c["passive-best"] += 1
                    apps[t][m["app"]] += 1
                    if dist.get(P, 0) >= 0.95:
                        c["confident"] += 1
                        cf = m.get("cost_futures") or {}
                        others = [a for a in m["costs"] if a != P]
                        if others and all(cf.get(a) and all(x - p >= 0.5 for x, p in zip(cf[a], cf.get(P, []))) for a in others):
                            c["salient"] += 1
                else:
                    c["action-best"] += 1
                    c["best:" + m["best"]] += 1
                c["diag:" + str(m.get("diagnosis"))] += 1
                k = classify(r)
                if k:
                    c["case:" + k[0]] += 1
        for f in glob.glob(os.path.join(part, "done.txt")):
            traj[part] = sum(1 for _ in open(f))
    tot = lambda t, key: sum(C[(t, mo)][key] for mo in ("clean", "chaos"))
    lines = [f"# v23-cert: certification dev set (situation-v2.3, dev-split scenarios only)", "",
             f"Trajectories {sum(traj.values())} over {len(parts)} parts; rows by split {dict(seen_split)}.", "",
             f"## Passive-best rows per trigger (target {target})", "",
             "| trigger | labelled | passive-best | clean | chaos | confident (mass>=0.95) | salient | action-best | diagnosis-only | apps (passive-best) | target |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    out = {"parts": parts, "triggers": {}}
    for t in TRIGGERS + sorted({k[0] for k in C} - set(TRIGGERS)):
        pb = tot(t, "passive-best")
        lines.append(f"| {t} | {tot(t, 'labelled')} | **{pb}** | {C[(t, 'clean')]['passive-best']} | {C[(t, 'chaos')]['passive-best']} | {tot(t, 'confident')} | {tot(t, 'salient')} | {tot(t, 'action-best')} | {tot(t, 'diagnosis-only')} | {len(apps[t])} | {'met' if pb >= target else ('too rare' if pb < target / 4 else 'short')} |")
        out["triggers"][t] = {mo: dict(C[(t, mo)]) for mo in ("clean", "chaos")}
        out["triggers"][t]["apps_passive_best"] = dict(apps[t].most_common())
    lines += ["", "## Trigger x mode x category", ""]
    for t in TRIGGERS + sorted({k[0] for k in C} - set(TRIGGERS)):
        for mo in ("clean", "chaos"):
            c = C[(t, mo)]
            if not c:
                continue
            best = ", ".join(f"{k[5:]} {v}" for k, v in sorted(c.items()) if k.startswith("best:"))
            diag = ", ".join(f"{k[5:]} {v}" for k, v in c.most_common() if k.startswith("diag:"))
            cases = ", ".join(f"{k[5:]} {v}" for k, v in c.most_common() if k.startswith("case:"))
            lines.append(f"- **{t} / {mo}**: labelled {c['labelled']}, passive-best {c['passive-best']} (confident {c['confident']}, salient {c['salient']}), action-best {c['action-best']}" + (f" [{best}]" if best else "") + f"; diagnosis-only {c['diagnosis-only']}; diagnoses: {diag or '-'}; eval cases: {cases or '-'}")
        top = ", ".join(f"{a} {n}" for a, n in apps[t].most_common(5))
        if top:
            lines.append(f"  - top apps (passive-best): {top}")
    md = "\n".join(lines) + "\n"
    open(os.path.join(d, "cert_report.md"), "w").write(md)
    json.dump(out, open(os.path.join(d, "cert_report.json"), "w"), indent=1)
    print(md)


if __name__ == "__main__":
    main()
