#!/usr/bin/env python3
"""Targeted tables for sim/SEPARABILITY.md on SIM_PROBE=1 rows (see separability_probe.py).

  python3 sim/scripts/separability_extra.py ROWS.jsonl [...] [--procs 16] > tables.txt
"""
import argparse, collections, importlib.util, json, os, sys
from multiprocessing import Pool

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("sep", os.path.join(HERE, "separability.py"))
sep = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sep)


def load(line):
    x = sep.featurize(line)
    if x is None:
        return None
    r = json.loads(line)
    m = r["meta"]
    x.pop("toks", None)
    x["probe"] = m.get("probe") or {}
    st = sep.state_obj(r)
    x["method"] = (st.get("trigger") or "").split(" ")[0]
    cf = m.get("cost_futures") or {}
    tiers = m.get("tiers") or {}
    p = x["passive"]
    x["gains"] = {}
    if p in cf:
        cp = sum(cf[p]) / len(cf[p])
        for a, v in cf.items():
            if a != p:
                x["gains"][a] = cp - sum(v) / len(v) - sep.PREM.get(tiers.get(a, "heal"), 0.5)
    return x


def table(title, rows, key, order=None):
    """P(clear), P(benign) and n per value of key(x)."""
    c = collections.defaultdict(collections.Counter)
    for x in rows:
        k = key(x)
        if k is None:
            continue
        c[k][x["cls"]] += 1
    print(f"\n### {title}")
    print("| value | rows | clear | benign | mild |")
    print("|---|---|---|---|---|")
    ks = order if order else sorted(c, key=lambda k: -sum(c[k].values()))
    for k in ks:
        if k not in c:
            continue
        n = sum(c[k].values())
        print(f"| {k} | {n} | {c[k]['clear'] / n:.1%} | {c[k]['benign'] / n:.1%} | {c[k]['mild'] / n:.1%} |")


def bucket(v, edges):
    if v is None:
        return None
    for e in edges:
        if v <= e:
            return f"<= {e}"
    return f"> {edges[-1]}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rows", nargs="+")
    ap.add_argument("--procs", type=int, default=16)
    a = ap.parse_args()
    with Pool(a.procs) as pool:
        recs = [x for x in pool.imap(load, sep.read_lines(a.rows, 0), chunksize=200) if x]
    by = collections.defaultdict(list)
    for x in recs:
        by[x["trigger"]].append(x)
    P = lambda x, k: x["probe"].get(k)

    # ---------------- request: repeated identical request from a separate user action
    rq = [x for x in by["request"] if P(x, "n_prev_same_intent_gap") is not None and x["method"] != "GET"]
    table("request (non-GET, an identical earlier request from another user action): by hidden intent", rq,
          lambda x: f"accidental={P(x, 'l_accidental')}")
    table("same rows by observable gap between the two user actions (s)", rq,
          lambda x: bucket(P(x, "n_prev_same_intent_gap"), [0.2, 0.5, 1, 2, 5]), [f"<= {e}" for e in [0.2, 0.5, 1, 2, 5]] + ["> 5"])
    table("same rows: gap bucket x hidden intent", rq,
          lambda x: f"{bucket(P(x, 'n_prev_same_intent_gap'), [0.2, 0.5, 1, 2])} / accidental={P(x, 'l_accidental')}")
    rg = [x for x in by["request"] if P(x, "n_prev_same_intent_gap") is not None and x["method"] == "GET"]
    table("request (GET, identical earlier request from another user action): by hidden intent", rg, lambda x: f"accidental={P(x, 'l_accidental')}")

    # ---------------- failure
    fl = by["failure"]
    table("failure: by method x hidden commit (did the failed request take effect on the server?)", fl,
          lambda x: f"{'GET' if x['method'] == 'GET' else 'write'} committed={P(x, 'l_committed')}")
    table("failure (writes): observable status x hidden commit", [x for x in fl if x["method"] != "GET"],
          lambda x: f"status={P(x, 'n_status') or 'neterr'} committed={P(x, 'l_committed')}")
    table("failure: hidden cause", fl, lambda x: P(x, "l_cause"))
    table("failure: outage still on 1 s later (hidden)", fl, lambda x: f"outage_1s={P(x, 'l_outage_1s')}")
    table("failure: the app retried this request itself (future)", fl, lambda x: f"app_retried={P(x, 'l_app_retried')}")
    table("failure: app retried earlier failures of this endpoint (observable history)", fl, lambda x: f"app_retry_seen={P(x, 'n_app_retry_seen')}")
    table("failure: background vs user-initiated (observable)", fl, lambda x: f"background={P(x, 'n_background')}")

    # ---------------- mutation
    mu = by["mutation"]
    table("mutation: write changes a cell (item field) a NEWER operation set (computable now)", mu,
          lambda x: f"revert_newer={(P(x, 'n_revert_newer') or 0) > 0}")
    table("mutation: adds an item whose id / content is already in the list (computable now)", mu,
          lambda x: f"dup_id={(P(x, 'n_dup_id') or 0) > 0} dup_content={(P(x, 'n_dup_content') or 0) > 0}")
    table("mutation: overwrites cells the user edited after the cause started (computable now)", mu,
          lambda x: f"user_since={(P(x, 'n_user_since') or 0) > 0}")
    table("mutation: write is a no-op at cell level (computable now)", mu, lambda x: f"noop={P(x, 'n_noop')}")
    table("mutation: cause failed; did it commit (hidden)", [x for x in mu if P(x, "n_cause_failed")],
          lambda x: f"cause_committed={P(x, 'l_cause_committed')}")
    table("mutation: same cells overwritten again within 10 s in the base run (future)", mu,
          lambda x: bucket(P(x, "l_overwritten_s"), [-1, 0.5, 2, 5, 10]), ["<= -1", "<= 0.5", "<= 2", "<= 5", "<= 10"])
    table("mutation: periodic refresh of the cause's endpoint observed (computable now)", mu,
          lambda x: "no periodic refresh" if P(x, "n_period_s") is None else f"next refresh in {bucket(P(x, 'n_next_refresh_s'), [1, 3, 10])}")

    # ---------------- client already wrong (hidden) for inconsistency / transition / stall / mutation
    for t in ("inconsistency", "transition", "stall", "mutation", "request", "failure"):
        table(f"{t}: client divergence from the ideal at decision time (hidden)", by[t],
              lambda x: bucket(P(x, "l_div_now"), [0, 0.05, 0.25, 1]), ["<= 0", "<= 0.05", "<= 0.25", "<= 1", "> 1"])

    # ---------------- clear rows labelled `expected`: what is going on (latent)
    print("\n### clear rows whose gold diagnosis is `expected` (the production gate cannot fire on them)")
    for t, xs in sorted(by.items()):
        cl = [x for x in xs if x["cls"] == "clear"]
        ce = [x for x in cl if x["diag"] == "expected"]
        if not cl:
            continue
        acc = sum(1 for x in ce if P(x, "l_accidental"))
        com = sum(1 for x in ce if P(x, "l_cause_committed") or P(x, "l_committed"))
        div = sum(1 for x in ce if (P(x, "l_div_now") or 0) > 0.05)
        print(f"- {t}: {len(ce)}/{len(cl)} clear rows ({len(ce) / len(cl):.0%}) are `expected`; of these: accidental intent {acc}, "
              f"failed-but-committed cause {com}, client already diverged (>0.05) {div}; best actions {collections.Counter(x['best_np'] for x in ce).most_common(4)}")


if __name__ == "__main__":
    main()
