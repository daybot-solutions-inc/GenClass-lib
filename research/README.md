# research/

Earlier GenClass/Jev research: a voice-control Chrome extension (`extension/`), the typed-decision encoder and
Jev-compatible server it ran on (`jev_local/`, a Python package; `pyproject.toml`, `tests/`), its classifier
benchmarks (`BENCHMARKS.md`, `scripts/`) and the build contract of that project (`docs/CONTRACT.md`).
Not part of `@genclass/runtime`. See [GENCLASS.md](GENCLASS.md) for what it was.

`training/` (the runtime model) still imports `jev_local` for the encoder, tokenizer packing and calibration; the
training scripts sync this directory to the training nodes. To use it locally:

```bash
cd research && python -m venv .venv && .venv/bin/pip install -e .
```
