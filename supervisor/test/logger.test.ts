import { describe, it, expect } from "vitest";
import { LogRing } from "../src/logger.js";

describe("LogRing", () => {
  it("returns entries in insertion order", () => {
    const ring = new LogRing(5);
    for (let i = 0; i < 3; i++) {
      ring.push({ ts: "t", level: 30, levelLabel: "info", msg: `m${i}` });
    }
    expect(ring.tail().map((e) => e.msg)).toEqual(["m0", "m1", "m2"]);
  });

  it("wraps around without losing order semantics", () => {
    const ring = new LogRing(3);
    for (let i = 0; i < 5; i++) {
      ring.push({ ts: "t", level: 30, levelLabel: "info", msg: `m${i}` });
    }
    expect(ring.tail().map((e) => e.msg)).toEqual(["m2", "m3", "m4"]);
  });

  it("filters by sinceSeq", () => {
    const ring = new LogRing(10);
    for (let i = 0; i < 5; i++) {
      ring.push({ ts: "t", level: 30, levelLabel: "info", msg: `m${i}` });
    }
    const after2 = ring.tail(2);
    expect(after2.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it("respects limit", () => {
    const ring = new LogRing(100);
    for (let i = 0; i < 50; i++) {
      ring.push({ ts: "t", level: 30, levelLabel: "info", msg: `m${i}` });
    }
    expect(ring.tail(undefined, 10)).toHaveLength(10);
  });
});
