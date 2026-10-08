"""T1 (sim/SEPARABILITY.md §7): expected-advantage action labels from `meta.cost_futures`, no new data.

    python training/t1_relabel.py --in data/s3/simA --out data/s3/simAg10 --tau 1.0 [--workers 16]

For each SIM decision row with an `action` question and `meta.cost_futures`:
    gain(a) = mean_f cost(passive, f) − mean_f cost(a, f) − premium(tier(a))     (premium: guard 0.25, heal 0.5)
    gain(passive) = 0;  gains clipped to ±30
    label = softmax(gain / τ) over the offered actions
so a calibrated model's log-odds of an action against passive estimate gain/τ, and the runtime's §8 gate (summed
permitted mass ≥ 0.8 / 0.9) becomes an expected-gain gate (≈ gain ≥ τ·ln 4 / τ·ln 9 for one dominant action).
`meta.egain` keeps the gains. Other rows and the diagnosis labels are unchanged.
"""

from __future__ import annotations

import argparse
import json
import math
from multiprocessing import Pool
from pathlib import Path

PREM = {"passive": 0.0, "guard": 0.25, "heal": 0.5}
CLIP = 30.0


def gains_of(m: dict, offered: list[str]) -> tuple[dict[str, float], str] | None:
    cf = m.get("cost_futures") or ({k: [v] for k, v in (m.get("costs") or {}).items()} if m.get("costs") else None)
    tiers = m.get("tiers") or {}
    passive = m.get("passive") or next((a for a, t in tiers.items() if t == "passive"), None)
    if not cf or passive not in cf:
        return None
    cp = sum(cf[passive]) / len(cf[passive])
    g = {}
    for a in offered:
        if a == passive:
            g[a] = 0.0
        elif a in cf and cf[a]:
            v = cp - sum(cf[a]) / len(cf[a]) - PREM.get(tiers.get(a, "heal"), 0.5)
            g[a] = max(-CLIP, min(CLIP, v))
    if passive not in g or len(g) < 2:
        return None
    return g, passive


def relabel_row(r: dict, tau: float, keep_dist: bool = False) -> tuple[dict, bool]:
    m = r.get("meta") or {}
    q = (r.get("questions") or {}).get("action")
    if not q or "action" not in (r.get("labels") or {}):
        return r, False
    offered = list((q.get("criteria") or {}).keys())
    got = gains_of(m, offered)
    if got is None:
        return r, False
    g, _ = got
    if keep_dist:  # gain-head variant: keep SIM's label for the choice head, add the gains for the regression head
        r["labels"]["action"] = {**r["labels"]["action"], "gain": {a: round(v, 4) for a, v in g.items()}}
        m["egain"] = {a: round(v, 4) for a, v in g.items()}
        r["meta"] = m
        return r, True
    mx = max(v / tau for v in g.values())
    ex = {a: math.exp(v / tau - mx) for a, v in g.items()}
    s = sum(ex.values())
    r["labels"]["action"] = {"type": "choice", "dist": {a: round(ex[a] / s, 6) for a in offered if a in ex}}
    m["egain"] = {a: round(v, 4) for a, v in g.items()}
    r["meta"] = m
    return r, True


def work(args: tuple) -> tuple[str, int, int]:
    src, dst, tau, keep = args
    n = changed = 0
    with open(src) as f, open(dst, "w") as g:
        for line in f:
            r = json.loads(line)
            r, ch = relabel_row(r, tau, keep)
            n += 1
            changed += int(ch)
            g.write(json.dumps(r, ensure_ascii=False) + "\n")
    return src, n, changed


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--tau", type=float, required=True)
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--keep-dist", action="store_true", help="keep SIM's action dist; add label['gain'] for the gain head")
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    files = sorted(a.inp.glob("*.jsonl"))
    with Pool(a.workers) as p:
        res = p.map(work, [(str(f), str(a.out / f.name), a.tau, a.keep_dist) for f in files])
    print(json.dumps({"files": len(res), "rows": sum(r[1] for r in res), "relabelled": sum(r[2] for r in res), "tau": a.tau}))


if __name__ == "__main__":
    main()
