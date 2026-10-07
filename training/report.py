"""Markdown tables from eval_runtime.py reports (for EVAL.md).

    python training/report.py name1=out/eval/a.json name2=out/eval/b.json [--mode kind|raw|group|header]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def pct(x) -> str:
    return "–" if x is None else f"{100 * x:.1f}"


def fir(x) -> str:
    return "–" if x is None else f"{100 * x:.2f}%"


def main() -> None:
    mode = "kind"
    args = []
    for a in sys.argv[1:]:
        if a.startswith("--mode="):
            mode = a.split("=", 1)[1]
        else:
            args.append(a)
    reps = []
    for a in args:
        name, path = a.split("=", 1)
        reps.append((name, json.loads(Path(path).read_text())))

    def dec(r):
        return r.get(f"decisions_{mode}") or r["decisions_raw"]

    def qs(r):
        return r.get(f"questions_{mode}") or r["questions_raw"]

    print(f"calibration mode: `{mode}`\n")
    print("| model | rows | action acc | diagnosis acc | guard: FIR | guard: precision | guard: recall | heal: FIR | heal: precision | heal: recall | ECE action | ECE diag | all-question acc |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for name, r in reps:
        d = dec(r)
        q = qs(r)
        g, h = d["modes"]["guard"], d["modes"]["heal"]
        print(f"| {name} | {d['n']} | {pct(d['action_acc'])} | {pct(d['diag_acc'])} | {fir(g['false_intervention_rate'])} "
              f"({g['false_fires']}/{g['passive_rows']}) | {pct(g['precision'])} ({g['fires']}) | {pct(g['recall'])} | "
              f"{fir(h['false_intervention_rate'])} ({h['false_fires']}/{h['passive_rows']}) | {pct(h['precision'])} ({h['fires']}) | "
              f"{pct(h['recall'])} | {q.get('action', {}).get('ece', '–')} | {q.get('diagnosis', {}).get('ece', '–')} | "
              f"{pct(q['all']['acc'])} |")
    print()
    costs = [(n, dec(r)["modes"]) for n, r in reps if dec(r)["modes"]["heal"].get("mean_cost")]
    if costs:
        print("Counterfactual cost per decision (SIM rows; lower is better): gated policy vs always-passive vs oracle\n")
        print("| model | guard: policy / passive / oracle | heal: policy / passive / oracle | harm on passive rows (guard / heal) |")
        print("|---|---|---|---|")
        for n, m in costs:
            g, h = m["guard"]["mean_cost"], m["heal"]["mean_cost"]
            print(f"| {n} | {g['policy']} / {g['always_passive']} / {g['oracle']} | {h['policy']} / {h['always_passive']} / "
                  f"{h['oracle']} | {g['harm_on_passive_rows']} / {h['harm_on_passive_rows']} |")
        print()
    trigs = sorted({t for _, r in reps for t in dec(r)["by_trigger"]})
    print("Per trigger (action acc / diagnosis acc / heal-mode FIR / heal precision):\n")
    print("| trigger | " + " | ".join(n for n, _ in reps) + " |")
    print("|---|" + "---|" * len(reps))
    for t in trigs:
        cells = []
        for _, r in reps:
            x = dec(r)["by_trigger"].get(t)
            if not x:
                cells.append("–")
                continue
            cells.append(f"{pct(x['action_acc'])} / {pct(x['diag_acc'])} / {fir(x['heal']['false_intervention_rate'])} / "
                         f"{pct(x['heal']['precision'])} (n={x['n']}, passive {x['passive_frac']})")
        print(f"| {t} | " + " | ".join(cells) + " |")
    print()
    print("Threshold sweep (heal-mode permitted set: summed probability ≥ t, candidate = argmax among permitted, diagnosis gate on): fires / false fires / precision\n")
    print("| threshold | " + " | ".join(n for n, _ in reps) + " |")
    print("|---|" + "---|" * len(reps))
    for thr in ("0.5", "0.6", "0.7", "0.8", "0.9", "0.95"):
        cells = []
        for _, r in reps:
            x = dec(r)["sweep"].get(thr, {})
            cells.append(f"{x.get('fires')} / {x.get('false')} / {pct(x.get('precision'))}")
        print(f"| {thr} | " + " | ".join(cells) + " |")
    print()
    for name, r in reps:
        if r.get("taus"):
            sh = r.get("split_half", {})
            print(f"- {name}: taus {json.dumps({k: v for k, v in r['taus'].items() if k != 'by_header'})}; "
                  f"split-half NLL raw {sh.get('odd_raw', {}).get('nll')} → kind {sh.get('odd_with_even_taus_kind', {}).get('nll')}"
                  f" / group {sh.get('odd_with_even_taus_group', {}).get('nll')} / header {sh.get('odd_with_even_taus_header', {}).get('nll')};"
                  f" ECE raw {sh.get('odd_raw', {}).get('ece')} → kind {sh.get('odd_with_even_taus_kind', {}).get('ece')}")


if __name__ == "__main__":
    main()
