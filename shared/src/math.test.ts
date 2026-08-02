import { describe, expect, it } from "vitest";
import {
  annualizedVol,
  basisZ,
  binaryDelta,
  blendSigma,
  bookImbalance,
  buyEdge,
  compositeSignal,
  erfc,
  initBasis,
  initEwmaVar,
  kellyFraction,
  microprice,
  normCdf,
  probUp,
  sigmaPerSqrtSec,
  updateBasis,
  updateEwmaVar,
  type EwmaVarState,
} from "./math.js";

describe("normCdf", () => {
  it("matches known values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1)).toBeCloseTo(0.8413447, 5);
    expect(normCdf(-1)).toBeCloseTo(0.1586553, 5);
    expect(normCdf(1.96)).toBeCloseTo(0.9750021, 5);
    expect(normCdf(-2.5758293)).toBeCloseTo(0.005, 4);
    expect(normCdf(6)).toBeGreaterThan(0.999999);
  });

  it("is symmetric", () => {
    for (const x of [0.3, 1.7, 2.9]) {
      expect(normCdf(x) + normCdf(-x)).toBeCloseTo(1, 9);
    }
  });

  it("erfc bounds", () => {
    expect(erfc(0)).toBeCloseTo(1, 7);
    expect(erfc(10)).toBeLessThan(1e-40);
    expect(erfc(-10)).toBeCloseTo(2, 10);
  });
});

describe("probUp", () => {
  const sigma = 0.0002; // per sqrt(sec); ~38% annualized

  it("is ~50% at the strike", () => {
    // Driftless GBM has a small downward median drag of sigma^2*tau/2.
    const p = probUp(100000, 100000, sigma, 900);
    expect(p).toBeGreaterThan(0.49);
    expect(p).toBeLessThan(0.501);
  });

  it("increases with spot above strike", () => {
    const below = probUp(99900, 100000, sigma, 900);
    const at = probUp(100000, 100000, sigma, 900);
    const above = probUp(100100, 100000, sigma, 900);
    expect(below).toBeLessThan(at);
    expect(at).toBeLessThan(above);
  });

  it("approaches indicator as tau -> 0", () => {
    // sigma*sqrt(0.5s) is ~$14 on $100k, so a $100 lead is ~7 sigma.
    expect(probUp(100100, 100000, sigma, 0.5)).toBeGreaterThan(0.95);
    expect(probUp(99900, 100000, sigma, 0.5)).toBeLessThan(0.05);
    expect(probUp(100010, 100000, sigma, 0)).toBe(1);
    expect(probUp(99990, 100000, sigma, 0)).toBe(0);
  });

  it("longer horizon pulls probability toward 1/2", () => {
    const short = probUp(100050, 100000, sigma, 60);
    const long = probUp(100050, 100000, sigma, 86400);
    expect(short).toBeGreaterThan(long);
    expect(long).toBeGreaterThan(0.5 - 0.02);
  });

  it("positive drift raises the probability", () => {
    const flat = probUp(100000, 100000, sigma, 900, 0);
    const up = probUp(100000, 100000, sigma, 900, 1e-7);
    expect(up).toBeGreaterThan(flat);
  });

  it("handles zero sigma deterministically", () => {
    expect(probUp(101, 100, 0, 900)).toBe(1);
    expect(probUp(99, 100, 0, 900)).toBe(0);
  });
});

describe("binaryDelta", () => {
  it("peaks near the strike and decays away from it", () => {
    const sigma = 0.0002;
    const atm = binaryDelta(100000, 100000, sigma, 300);
    const otm = binaryDelta(101000, 100000, sigma, 300);
    expect(atm).toBeGreaterThan(otm);
    expect(atm).toBeGreaterThan(0);
  });

  it("integrates (roughly) to the probability change", () => {
    const sigma = 0.0002;
    const d = binaryDelta(100000, 100000, sigma, 300);
    const dp = probUp(100001, 100000, sigma, 300) - probUp(100000, 100000, sigma, 300);
    expect(d).toBeCloseTo(dp, 5);
  });
});

describe("EWMA variance", () => {
  it("recovers sigma of a synthetic GBM within 20%", () => {
    const sigma = 0.0003;
    // Deterministic pseudo-random via mulberry32.
    let seed = 42;
    const rand = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const gauss = () => {
      const u = Math.max(rand(), 1e-12);
      const v = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    let price = 100000;
    let ts = 0;
    let st: EwmaVarState = initEwmaVar(price, ts);
    for (let i = 0; i < 5000; i++) {
      const dt = 1000; // 1s ticks
      ts += dt;
      price *= Math.exp(sigma * gauss());
      st = updateEwmaVar(st, price, ts, 300);
    }
    const est = sigmaPerSqrtSec(st);
    expect(est).toBeGreaterThan(sigma * 0.8);
    expect(est).toBeLessThan(sigma * 1.2);
  });

  it("ignores out-of-order and duplicate ticks", () => {
    let st = initEwmaVar(100, 1000);
    st = updateEwmaVar(st, 101, 2000, 60);
    const frozen = updateEwmaVar(st, 50, 1500, 60);
    expect(frozen).toEqual(st);
    const dup = updateEwmaVar(st, 102, 2000, 60);
    expect(dup).toEqual(st);
  });

  it("handles irregular spacing without bias blowups", () => {
    let st = initEwmaVar(100, 0);
    st = updateEwmaVar(st, 100.1, 500, 60);
    st = updateEwmaVar(st, 100.05, 10_000, 60);
    st = updateEwmaVar(st, 100.2, 10_500, 60);
    expect(st.varPerSec).toBeGreaterThan(0);
    expect(Number.isFinite(st.varPerSec)).toBe(true);
  });
});

describe("blendSigma", () => {
  it("weights the estimator whose half-life matches the horizon", () => {
    const fast: EwmaVarState = { varPerSec: 4e-8, lastPrice: 1, lastTs: 0, samples: 100 };
    const slow: EwmaVarState = { varPerSec: 1e-8, lastPrice: 1, lastTs: 0, samples: 100 };
    const short = blendSigma(
      [
        { halfLifeSec: 60, state: fast },
        { halfLifeSec: 3600, state: slow },
      ],
      60,
    );
    const long = blendSigma(
      [
        { halfLifeSec: 60, state: fast },
        { halfLifeSec: 3600, state: slow },
      ],
      3600,
    );
    expect(short).toBeGreaterThan(long);
  });

  it("returns 0 with no warmed-up estimators", () => {
    const cold: EwmaVarState = { varPerSec: 1e-8, lastPrice: 1, lastTs: 0, samples: 2 };
    expect(blendSigma([{ halfLifeSec: 60, state: cold }], 60)).toBe(0);
  });
});

describe("edges and sizing", () => {
  it("buyEdge is p - price for feeless markets", () => {
    expect(buyEdge(0.6, 0.5)).toBeCloseTo(0.1, 9);
    expect(buyEdge(0.4, 0.5)).toBeCloseTo(-0.1, 9);
  });

  it("fees only tax winnings", () => {
    // p*(1-c)*(1-f) - (1-p)*c
    expect(buyEdge(0.6, 0.5, 0.1)).toBeCloseTo(0.6 * 0.5 * 0.9 - 0.4 * 0.5, 9);
  });

  it("kelly is (p-c)/(1-c) clamped", () => {
    expect(kellyFraction(0.6, 0.5)).toBeCloseTo(0.2, 9);
    expect(kellyFraction(0.4, 0.5)).toBe(0);
    expect(kellyFraction(1, 0.5)).toBe(1);
  });
});

describe("microstructure", () => {
  it("microprice leans toward the heavier side", () => {
    // Large bid size pushes microprice toward the ask.
    const mp = microprice(0.48, 1000, 0.52, 100)!;
    expect(mp).toBeGreaterThan(0.5);
  });

  it("imbalance sign and bounds", () => {
    expect(bookImbalance(300, 100)).toBeCloseTo(0.5, 9);
    expect(bookImbalance(0, 0)).toBeNull();
  });
});

describe("basis tracking", () => {
  it("flags a stretched basis", () => {
    let st = initBasis();
    // Stable small basis for a while...
    for (let i = 0; i < 200; i++) {
      st = updateBasis(st, 100000, 100000 + (i % 2 === 0 ? 2 : -2));
    }
    // ...then Binance jumps $60 above Chainlink.
    const z = basisZ(st, 100000, 100060);
    expect(z).not.toBeNull();
    expect(z!).toBeGreaterThan(3);
  });

  it("needs warm-up", () => {
    let st = initBasis();
    st = updateBasis(st, 100, 100.1);
    expect(basisZ(st, 100, 100.1)).toBeNull();
  });
});

describe("compositeSignal", () => {
  const base = {
    upAsk: 0.5,
    upBid: 0.48,
    downAsk: 0.5,
    downBid: 0.48,
    basisZ: 0,
    upImbalance: 0,
    downImbalance: 0,
    secondsLeft: 400,
    horizonSec: 900,
    feeRate: 0,
  };

  it("recommends UP when the model sees cheap UP shares", () => {
    const s = compositeSignal({ ...base, probUp: 0.65 });
    expect(s.direction).toBe("UP");
    expect(s.upBuyEdge!).toBeCloseTo(0.15, 9);
    expect(s.kellyFraction!).toBeGreaterThan(0);
    expect(s.kellyFraction!).toBeLessThanOrEqual(0.1);
  });

  it("recommends DOWN symmetrically", () => {
    const s = compositeSignal({ ...base, probUp: 0.35 });
    expect(s.direction).toBe("DOWN");
  });

  it("stays flat without edge", () => {
    const s = compositeSignal({ ...base, probUp: 0.5 });
    expect(s.direction).toBe("NONE");
  });

  it("locks near expiry", () => {
    const s = compositeSignal({ ...base, probUp: 0.9, secondsLeft: 5 });
    expect(s.phase).toBe("LOCKED");
    expect(s.direction).toBe("NONE");
  });

  it("basis lead can tip a marginal call", () => {
    const flat = compositeSignal({ ...base, probUp: 0.51 });
    const led = compositeSignal({ ...base, probUp: 0.51, basisZ: 4 });
    expect(flat.direction).toBe("NONE");
    expect(led.direction).toBe("UP");
  });
});

describe("annualizedVol", () => {
  it("scales by sqrt(seconds per year)", () => {
    expect(annualizedVol(0.0002)).toBeCloseTo(0.0002 * Math.sqrt(365 * 24 * 3600), 9);
  });
});
