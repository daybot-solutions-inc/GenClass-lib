// Calibration lookup/application (calibrate.py) and answer math (confidence.py).
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildAnswer,
  calibrateLogits,
  choiceConfidence,
  headerKey,
  kBucket,
  parseCalibration,
  scoreConfidence,
  tauFor,
  type Calibration,
} from "../../src/model/calibrate.js";
import { ModelUnsupportedError } from "../../src/model/errors.js";
import { sha1Hex, sha256Hex, sha256HexSync } from "../../src/model/hash.js";
import { hasModelFile, modelFile, packs, pyFixturesPath, readJson, torch } from "./helpers.js";

const py = existsSync(pyFixturesPath) ? readJson<any>(pyFixturesPath) : null;

describe("hashes", () => {
  it("sha1 header keys match Python hashlib.sha1(header)[:12] (torch fixtures)", () => {
    const pf = packs();
    for (const tf of torch().slice(0, 5)) {
      const p = pf.find((x) => x.id === tf.id)!;
      for (const [qid, qi] of Object.entries(p.q_index)) expect(headerKey(qi.header)).toBe(tf.header_key[qid]);
    }
    expect(sha1Hex("")).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });

  it("sha256 (pure TS and WebCrypto) on edge lengths", async () => {
    const { createHash } = await import("node:crypto");
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_003]) {
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 255;
      const want = createHash("sha256").update(b).digest("hex");
      expect(sha256HexSync(b), `n=${n}`).toBe(want);
      expect(await sha256Hex(b)).toBe(want);
    }
  });
});

describe.skipIf(!hasModelFile("calibration.json"))("calibration vs PyTorch (torch fixtures, the model's calibration.json)", () => {
  it("reproduces PyTorch's calibrated probabilities from its raw logits (< 1e-9)", () => {
    const calib = parseCalibration(readJson(modelFile("calibration.json")));
    const pf = packs();
    let mx = 0;
    let n = 0;
    for (const tf of torch()) {
      const p = pf.find((x) => x.id === tf.id)!;
      for (const [qid, qi] of Object.entries(p.q_index)) {
        const got = calibrateLogits(qi.kind as "choice", tf.header_key[qid], tf.logits[qid], calib);
        got.forEach((x, i) => {
          mx = Math.max(mx, Math.abs(x - tf.probs[qid][i]));
        });
        n++;
      }
    }
    expect(n).toBeGreaterThan(50);
    expect(mx).toBeLessThan(1e-9);
  });
});

describe.skipIf(!py)("calibration and confidence vs Python", () => {
  it("v1 and v2 calibration files (by_header, by_bucket, tau_k, noul_platt)", () => {
    const calibs: Record<string, Calibration> = {
      v1: parseCalibration(py.calibrate.calibrations.v1),
      v2: parseCalibration(py.calibrate.calibrations.v2),
    };
    let mx = 0;
    for (const c of py.calibrate.cases as Array<any>) {
      expect(headerKey(c.header)).toBe(c.header_key);
      const got = calibrateLogits(c.kind, c.header_key, c.logits, calibs[c.calib]);
      got.forEach((x, i) => {
        mx = Math.max(mx, Math.abs(x - c.probs[i]));
      });
    }
    expect(mx).toBeLessThan(1e-12);
  });

  it("choice confidence, score value and score confidence (mode centre)", () => {
    for (const c of py.confidence as Array<any>) {
      expect(choiceConfidence(c.p)).toBeCloseTo(c.choice_confidence, 12);
      expect(scoreConfidence(c.p)).toBeCloseTo(c.score_confidence, 12);
      const a = buildAnswer({ type: "score", criteria: c.p.map(String) }, c.p);
      expect(a.type === "score" && a.score).toBeCloseTo(c.score, 12);
    }
  });
});

describe("answers", () => {
  it("choice: plain object in criteria order (object or Map), argmax of unrounded p, ties to the first label", () => {
    const q = { type: "choice", criteria: { b: "B", a: "A", c: null } };
    const a = buildAnswer(q, [0.25, 0.5, 0.25]);
    expect(a).toEqual({ type: "choice", choice: "a", confidence: 0.25, probabilities: { b: 0.25, a: 0.5, c: 0.25 } });
    expect(Object.keys((a as any).probabilities)).toEqual(["b", "a", "c"]);
    const m = buildAnswer({ type: "choice", criteria: new Map([["2", "x"], ["1", "y"]]) }, [0.5, 0.5]);
    expect(m.type === "choice" && m.choice).toBe("2");
    expect(m.type === "choice" && m.probabilities).toBeInstanceOf(Object);
    expect(m.type === "choice" && m.probabilities instanceof Map).toBe(false);
    const r = buildAnswer(q, [0.333333, 0.333334, 0.333333], "round");
    expect(r).toEqual({ type: "choice", choice: "a", confidence: 0, probabilities: { b: 0.33, a: 0.33, c: 0.33 } });
  });

  it("noul and score", () => {
    expect(buildAnswer({ type: "noul" }, [0.73])).toEqual({ type: "noul", noul: 0.73 });
    expect(buildAnswer({ type: "noul" }, [NaN])).toEqual({ type: "noul", noul: 0.5 });
    const s = buildAnswer({ type: "score", criteria: ["low", "mid", "high"] }, [0.1, 0.2, 0.7]);
    expect(s.type === "score" && s.score).toBeCloseTo(1.6, 12);
    expect(s.type === "score" && Object.keys(s.probabilities)).toEqual(["0", "1", "2"]);
  });

  it("calibration lookups and validation", () => {
    const c = parseCalibration({ choice: 2, by_header: { abc: 0.5 }, by_bucket: { "choice:3-5": 1.5 }, tau_k: { score: [1, 0.5] }, bucket_clamp: [0.5, 5] });
    expect(tauFor(c, "choice", "abc", 4)).toBe(0.5);
    expect(tauFor(c, "choice", "zzz", 4)).toBe(1.5);
    expect(tauFor(c, "choice", "zzz", 7)).toBe(2);
    expect(tauFor(c, "score", "zzz", 2)).toBeCloseTo(1 + 0.5 * Math.log(2), 12);
    expect(tauFor(c, "score", "zzz", 10_000)).toBe(5);
    expect(kBucket(2)).toBe("2");
    expect(kBucket(7)).toBe("6-10");
    expect(kBucket(999)).toBe("101-255");
    expect(() => parseCalibration({ choice: -1 })).toThrow(ModelUnsupportedError);
    expect(() => parseCalibration([])).toThrow(ModelUnsupportedError);
  });
});
