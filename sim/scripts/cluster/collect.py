#!/usr/bin/env python3
"""Collect a distributed SIM run: pull finished parts from every node, dedupe, write gz shards + manifest.

  python3 collect.py RUN OUTDIR HOST [HOST ...]      (HOST = private IP serving ~/simgen/out on :8811)
  python3 collect.py RUN OUTDIR --local DIR [DIR ...] (parts already on this machine)

Only parts with a finished marker (part-NNNNNN.json) are taken, so it can run while nodes are still generating
(re-run to pick up new parts; already-downloaded parts are skipped). Dedupe is global over sha1(state + questions);
test rows are processed first, then dev, then train, so a situation that occurs in several splits stays in test only
(no leakage). Output: OUTDIR/{train,dev,test}-NNNNN.jsonl.gz (<= 500k rows each) and OUTDIR/manifest.json.
"""
import gzip, hashlib, html.parser, json, os, re, sys, urllib.request

SHARD = 500_000


class Links(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            for k, v in attrs:
                if k == "href" and v:
                    self.links.append(v)


def fetch(url, dst):
    tmp = dst + ".tmp"
    with urllib.request.urlopen(url, timeout=600) as r, open(tmp, "wb") as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
    os.replace(tmp, dst)


def pull(run, raw, host):
    base = f"http://{host}:8811/{run}/parts/"
    try:
        with urllib.request.urlopen(base, timeout=60) as r:
            p = Links()
            p.feed(r.read().decode())
    except Exception as e:  # node down or not serving
        print(f"[collect] {host}: {e}")
        return 0
    names = set(p.links)
    markers = sorted(n for n in names if re.fullmatch(r"part-\d+\.json", n))
    d = os.path.join(raw, host)
    os.makedirs(d, exist_ok=True)
    got = 0
    for m in markers:
        stem = m[:-5]
        if os.path.exists(os.path.join(d, m)):
            continue
        for split in ("train", "dev", "test"):
            n = f"{stem}.{split}.jsonl"
            if n in names:
                fetch(base + n, os.path.join(d, n))
        fetch(base + m, os.path.join(d, m))  # marker last: a part counts only when complete locally
        got += 1
    print(f"[collect] {host}: {len(markers)} finished parts, {got} new")
    return got


def part_files(dirs, split):
    out = []
    for d in dirs:
        for n in sorted(os.listdir(d)):
            if n.endswith(f".{split}.jsonl") and os.path.exists(os.path.join(d, n.replace(f".{split}.jsonl", ".json"))):
                out.append(os.path.join(d, n))
    return out


def merge(dirs, outdir):
    seen = set()
    counts, dups = {}, {}
    for split in ("test", "dev", "train"):
        shard, n_in_shard, total, dup = 0, 0, 0, 0
        f = None
        for path in part_files(dirs, split):
            with open(path) as src:
                for line in src:
                    if not line.strip():
                        continue
                    r = json.loads(line)
                    h = hashlib.sha1((json.dumps(r["state"], sort_keys=True) + json.dumps(r["questions"], sort_keys=True)).encode()).digest()[:12]
                    if h in seen:
                        dup += 1
                        continue
                    seen.add(h)
                    if f is None or n_in_shard >= SHARD:
                        if f:
                            f.close()
                        f = gzip.open(os.path.join(outdir, f"{split}-{shard:05d}.jsonl.gz"), "wt", compresslevel=6)
                        shard += 1
                        n_in_shard = 0
                    f.write(line if line.endswith("\n") else line + "\n")
                    n_in_shard += 1
                    total += 1
        if f:
            f.close()
        counts[split], dups[split] = total, dup
        print(f"[collect] {split}: {total} rows in {shard} shards, {dup} duplicates dropped")
    json.dump({"rows": counts, "duplicates_dropped": dups, "shard_rows": SHARD, "sources": dirs}, open(os.path.join(outdir, "manifest.json"), "w"), indent=1)


def main():
    run, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    if sys.argv[3] == "--local":
        dirs = sys.argv[4:]
    else:
        raw = os.path.join(outdir, "raw")
        for host in sys.argv[3:]:
            pull(run, raw, host)
        dirs = [os.path.join(raw, h) for h in sys.argv[3:] if os.path.isdir(os.path.join(raw, h))]
    merge(dirs, outdir)


if __name__ == "__main__":
    main()
