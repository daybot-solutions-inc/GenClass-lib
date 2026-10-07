// Serializer port vs jev_local/serialize.py, and the Python number/whitespace semantics it relies on.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pyFloatRepr, pyNumber, pyRound, pyStrip } from "../../src/model/pyutil.js";
import { entryText, pyJson, questionBlock, stateSegments, stateText, toJsonValue } from "../../src/model/serialize.js";
import { pyFixturesPath, readJson } from "./helpers.js";

const py = existsSync(pyFixturesPath) ? readJson<any>(pyFixturesPath) : null;

describe.skipIf(!py)("serialize vs Python", () => {
  it("state_segments on edge-case states", () => {
    for (const c of py.serialize.states as Array<{ state: unknown; segments: [string, string][] }>) {
      expect(stateSegments(c.state).map((s) => [s.key, s.text]), JSON.stringify(c.state).slice(0, 80)).toEqual(c.segments);
    }
  });

  it("question_block on edge-case questions", () => {
    (py.serialize.questions as Array<any>).forEach((c, i) => {
      const b = questionBlock(`q${i}`, c.question);
      expect({ kind: b.kind, header: b.header, items: b.items, labels: b.labels }).toEqual({ kind: c.kind, header: c.header, items: c.items, labels: c.labels });
    });
  });
});

describe("Python semantics", () => {
  it("numbers print like Python after a JSON round trip", () => {
    const cases: Array<[number, string]> = [
      [0, "0"],
      [-0, "0"],
      [42, "42"],
      [1e16, "10000000000000000"],
      [1e21, "1e+21"],
      [1.5e22, "1.5e+22"],
      [0.1, "0.1"],
      [-2.25, "-2.25"],
      [0.0001, "0.0001"],
      [0.00001, "1e-05"],
      [0.000123, "0.000123"],
      [0.0000123, "1.23e-05"],
      [1.5e-7, "1.5e-07"],
      [-3.2e-6, "-3.2e-06"],
      [5e-324, "5e-324"],
      [1.5e300, "1.5e+300"],
      [123.456, "123.456"],
      [3.141592653589793, "3.141592653589793"],
    ];
    for (const [x, want] of cases) expect(pyNumber(x), String(x)).toBe(want);
    expect(pyFloatRepr(2.5)).toBe("2.5");
  });

  it("json.dumps separators and non-finite values", () => {
    expect(pyJson({ a: [1, 2.5, null, "x"], b: { c: true } })).toBe('{"a": [1, 2.5, null, "x"], "b": {"c": true}}');
    expect(pyJson([NaN, Infinity, 1e-5])).toBe("[null, null, 1e-05]");
    expect(pyJson("é\n")).toBe('"é\\n"');
  });

  it("str.strip() whitespace set (not JS trim)", () => {
    expect(pyStrip("\u0085x\u0085")).toBe("x");
    expect(pyStrip("﻿x")).toBe("﻿x");
    expect(pyStrip("\u001fx\u001c")).toBe("x");
    expect(pyStrip("  x　")).toBe("x");
  });

  it("values the trainer only sees after JSON: undefined keys vanish, NaN is null, Dates are strings", () => {
    const d = new Date(Date.UTC(2026, 9, 7, 12, 0, 0));
    const state = { a: undefined, b: NaN, c: d, e: [undefined, 1], f: () => 1 } as Record<string, unknown>;
    expect(toJsonValue(state)).toEqual({ b: null, c: "2026-10-07T12:00:00.000Z", e: [null, 1] });
    expect(stateSegments(state)).toEqual([
      { key: "b", text: "" },
      { key: "c", text: "2026-10-07T12:00:00.000Z" },
      { key: "e", text: "[null, 1]" },
    ]);
    expect(entryText(1e-5)).toBe("1e-05");
    expect(entryText(true)).toBe("True");
  });

  it("situation-shaped states: arrays of strings render one per line, object values as key: value", () => {
    const s = { app: "Shop", facts: ["one", "two"], state: { "cart.total": 3, items: ["a"] } };
    expect(stateSegments(s)).toEqual([
      { key: "app", text: "Shop" },
      { key: "facts", text: "one\ntwo" },
      { key: "state", text: 'cart.total: 3 | items: a' },
    ]);
    expect(stateText(s)).toBe("app:\nShop\n\nfacts:\none\ntwo\n\nstate:\ncart.total: 3 | items: a");
  });

  it("round(x, 2) is half-even on exact ties", () => {
    expect(pyRound(0.125, 2)).toBe(0.12);
    expect(pyRound(0.375, 2)).toBe(0.38);
    expect(pyRound(0.5, 0)).toBe(0);
    expect(pyRound(1.5, 0)).toBe(2);
  });
});
