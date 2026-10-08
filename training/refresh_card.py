"""Recompute bytes + sha256 of every file listed in an export's model.json (after calibration/meta edits).
    python training/refresh_card.py out/export-M"""
import hashlib, json, sys
from pathlib import Path
d = Path(sys.argv[1])
c = json.loads((d / "model.json").read_text())
for v in list(c.get("variants", {}).values()) + list(c.get("files", {}).values()):
    b = (d / v["file"]).read_bytes()
    v["bytes"], v["sha256"] = len(b), hashlib.sha256(b).hexdigest()
(d / "model.json").write_text(json.dumps(c, indent=1) + "\n")
print({v["file"]: v["sha256"][:12] for v in list(c["variants"].values()) + list(c["files"].values())})
