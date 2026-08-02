import { describe, expect, it } from "vitest";
import { classifyVerdict, VERDICT_THRESHOLDS, type VerdictInputs } from "./verdict.js";

/** A readable, mid-session baseline; tests override what they exercise. */
const base: VerdictInputs = {
  phase: "TRADEABLE",
  strikeSource: "boundary_tick",
  direction: "NONE",
  strength: 0,
  basisZ: 0,
  upBuyEdge: 0,
  downBuyEdge: 0,
  secondsLeft: 400,
};

describe("classifyVerdict — fixtures from the live dashboard", () => {
  it("BTC 15m row (composite 16, basis z 0.18, edge +0.9c) reads WEAK", () => {
    // Strength 16 is below the engine's own direction threshold, so the
    // expert view showed FLAT; Simple Mode calls it WEAK with no direction.
    const v = classifyVerdict({
      ...base,
      direction: "NONE",
      strength: 16,
      basisZ: 0.18,
      upBuyEdge: 0.009,
      downBuyEdge: -0.02,
    });
    expect(v).toEqual({ verdict: "WEAK", direction: null, confidence: "low" });
  });

  it("BTC 5m row (DOWN 53, basis z -0.14, DOWN edge +11.4c) reads WEAK — basis not confirming", () => {
    const v = classifyVerdict({
      ...base,
      direction: "DOWN",
      strength: 53,
      basisZ: -0.14,
      upBuyEdge: -0.146,
      downBuyEdge: 0.114,
    });
    expect(v.verdict).toBe("WEAK");
    expect(v.direction).toBe("DOWN");
    // Medium by score, downgraded to low because |z| < confirmZ.
    expect(v.confidence).toBe("low");
  });

  it("same row with a confirming basis (z -2.2) upgrades to STRONG/medium", () => {
    const v = classifyVerdict({
      ...base,
      direction: "DOWN",
      strength: 53,
      basisZ: -2.2,
      upBuyEdge: -0.146,
      downBuyEdge: 0.114,
    });
    expect(v).toEqual({ verdict: "STRONG", direction: "DOWN", confidence: "medium" });
  });
});

describe("classifyVerdict — STRONG gating", () => {
  it("requires positive edge on the favored side", () => {
    const v = classifyVerdict({
      ...base,
      direction: "UP",
      strength: 70,
      basisZ: 2.5,
      upBuyEdge: -0.01,
      downBuyEdge: 0.03,
    });
    expect(v.verdict).toBe("WEAK");
    expect(v.confidence).toBe("high");
  });

  it("requires composite strength at the threshold", () => {
    const at = classifyVerdict({
      ...base,
      direction: "UP",
      strength: VERDICT_THRESHOLDS.strongScore,
      basisZ: 2,
      upBuyEdge: 0.02,
    });
    const below = classifyVerdict({
      ...base,
      direction: "UP",
      strength: VERDICT_THRESHOLDS.strongScore - 1,
      basisZ: 2,
      upBuyEdge: 0.02,
    });
    expect(at.verdict).toBe("STRONG");
    expect(below.verdict).toBe("WEAK");
  });

  it("a null basis z-score never confirms", () => {
    const v = classifyVerdict({
      ...base,
      direction: "UP",
      strength: 80,
      basisZ: null,
      upBuyEdge: 0.05,
    });
    expect(v.verdict).toBe("WEAK");
    expect(v.confidence).toBe("medium"); // high downgraded one notch
  });
});

describe("classifyVerdict — NO_READ conditions", () => {
  it.each([
    ["warming up", { phase: "WARMING_UP" as const }],
    ["locked", { phase: "LOCKED" as const }],
    ["no market", { phase: "NO_MARKET" as const }],
    ["no signal yet", { phase: null }],
    ["unknown strike", { strikeSource: "unknown" as const }],
    ["under the lock window", { secondsLeft: VERDICT_THRESHOLDS.lockSeconds - 1 }],
    ["no countdown", { secondsLeft: null }],
  ])("%s", (_label, override) => {
    const v = classifyVerdict({
      ...base,
      direction: "UP",
      strength: 90,
      basisZ: 3,
      upBuyEdge: 0.1,
      ...override,
    });
    expect(v).toEqual({ verdict: "NO_READ", direction: null, confidence: "low" });
  });
});
