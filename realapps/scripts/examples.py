#!/usr/bin/env python3
"""Pretty-print rows for auditing (EXAMPLES.md drafts).

  python3 realapps/scripts/examples.py <dataset dir> [--pick trigger:diagnosis:best ...] [--n 12] [--ids id1,id2]
Prints each row's situation (as the model reads it), the questions, labels, per-action mean costs (and per-future
costs), cost parts, and the diagnosis provenance.
"""
import glob, json, os, sys

def rows(d):
    for split in ("train", "dev", "test"):
        p = os.path.join(d, f"{split}.jsonl")
        if os.path.exists(p):
            for line in open(p):
                if line.strip():
                    yield json.loads(line)

def render_state(st):
    out = []
    for k, v in st.items():
        if isinstance(v, list):
            out.append(f"{k}:")
            out += [f"  {x}" for x in v]
        else:
            out.append(f"{k}: {v}")
    return "\n".join(out)

def render_q(qs):
    out = []
    for qid, q in qs.items():
        crit = q.get("criteria") or {}
        opts = " | ".join(f"{k}: {v}" if v else k for k, v in crit.items())
        out.append(f"{qid} ({q['type']}): {q['instructions']}  [{opts}]")
    return "\n".join(out)

def show(r):
    m = r["meta"]
    print(f"### {r['id']} — {m['app']} ({m['framework']}; {', '.join(m['libs'])}), {m['trigger']}, chaos {m['chaos']}, budget {m['budget']}")
    print(f"flags: {', '.join(p.split('/', 1)[1] for p in m.get('patterns', [])) or 'none'}")
    print("```")
    print(render_state(r["state"]))
    print("questions:")
    print(render_q(r["questions"]))
    print("```")
    print(f"labels: {json.dumps(r['labels'])}")
    if not m.get("diagnosis_only"):
        print(f"costs (mean): {json.dumps(m['costs'])}; futures: {json.dumps(m['cost_futures'])}; best {m['best']}, non-passive mass {m['non_passive_mass']}")
        parts = {a: {k: v for k, v in p.items() if v} for a, p in m.get("cost_parts", {}).items()}
        print(f"cost parts (future 0): {json.dumps(parts)}")
    print(f"diagnosis {m.get('diagnosis')} (why: {m.get('diag_why')}); subject {json.dumps(m.get('subject'))[:300]}")
    print()

def main():
    d = sys.argv[1]
    args = sys.argv[2:]
    n = int(args[args.index("--n") + 1]) if "--n" in args else 12
    ids = set(args[args.index("--ids") + 1].split(",")) if "--ids" in args else None
    picks = []
    if "--pick" in args:
        i = args.index("--pick") + 1
        while i < len(args) and not args[i].startswith("--"):
            picks.append(args[i].split(":"))
            i += 1
    shown = 0
    used = set()
    for r in rows(d):
        m = r["meta"]
        if ids is not None:
            if r["id"] in ids:
                show(r)
            continue
        if picks:
            for j, (t, dg, b) in enumerate(picks):
                if j in used:
                    continue
                if (t in ("*", m["trigger"])) and (dg in ("*", str(m.get("diagnosis")))) and (b in ("*", str(m.get("best")))):
                    show(r)
                    used.add(j)
                    break
            if len(used) == len(picks):
                break
            continue
        show(r)
        shown += 1
        if shown >= n:
            break

if __name__ == "__main__":
    main()
