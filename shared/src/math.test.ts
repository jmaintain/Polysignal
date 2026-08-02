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
  probAvgAbove,
  probUp,
  sigmaPerSqrtSec,
  takerFeePerShare,
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

describe("probAvgAbove (60s-average settlement, CF Benchmarks rule)", () => {
  const sigma = 0.0002;

  it("outside the window it prices with tauEff = (tau - w) + w/3", () => {
    const direct = probAvgAbove(100050, 100000, sigma, 900, 60);
    const equivalent = probUp(100050, 100000, sigma, 840 + 20);
    expect(direct).toBeCloseTo(equivalent, 12);
  });

  it("average settlement is sharper than point settlement near expiry", () => {
    // At tau = 70s, only ~10s of open drift plus a damped window remain.
    const avg = probAvgAbove(100050, 100000, sigma, 70, 60);
    const point = probUp(100050, 100000, sigma, 70);
    expect(avg).toBeGreaterThan(point);
  });

  it("is monotonic in spot", () => {
    const lo = probAvgAbove(99950, 100000, sigma, 300, 60);
    const hi = probAvgAbove(100050, 100000, sigma, 300, 60);
    expect(hi).toBeGreaterThan(lo);
  });

  it("pins to 1 when the observed average has banked the strike", () => {
    // 50s observed averaging $100,200 vs strike $100,000: even a crash to
    // zero over the last 10s cannot pull the mean below the strike
    // (50*100200/60 = 83,500 > 60*100000/60? -> kAdj <= 0 when
    // w*K - e*avgObs <= 0: 6,000,000 - 5,010,000 > 0, so use a bigger lead).
    const banked = probAvgAbove(100200, 100000, sigma, 10, 60, {
      avgSoFar: 120100,
      elapsedSec: 50,
    });
    expect(banked).toBe(1);
  });

  it("inside the window, a strong observed average dominates a spot dip", () => {
    // Spot dipped just below the strike, but 50 of 60 seconds averaged well
    // above it — the settlement average is still overwhelmingly likely to
    // finish above.
    const p = probAvgAbove(99990, 100000, sigma, 10, 60, {
      avgSoFar: 100100,
      elapsedSec: 50,
    });
    expect(p).toBeGreaterThan(0.95);
    // Whereas a point-settlement model would call this a loser.
    expect(probUp(99990, 100000, sigma, 10)).toBeLessThan(0.5);
  });

  it("degenerates to the indicator on the observed average at expiry", () => {
    expect(probAvgAbove(99000, 100000, sigma, 0, 60, { avgSoFar: 100010, elapsedSec: 60 })).toBe(1);
    expect(probAvgAbove(101000, 100000, sigma, 0, 60, { avgSoFar: 99990, elapsedSec: 60 })).toBe(0);
  });

  it("index uncertainty prevents false certainty near the money", () => {
    // The real settlement from validate:settle — official 63427.35 against
    // strike 63431.24, a $3.89 margin, while our proxy tracks the official
    // index to ~0.8bp ($5 on $63k). Treating our price as exact reports
    // ~99% certainty on a call the data genuinely cannot resolve.
    const partial = { avgSoFar: 63435, elapsedSec: 55 };
    const asExact = probAvgAbove(63431, 63431.24, sigma, 5, 60, partial);
    const honest = probAvgAbove(63431, 63431.24, sigma, 5, 60, partial, 0.0001);
    expect(asExact).toBeGreaterThan(0.99);
    expect(honest).toBeLessThan(0.8);
    expect(honest).toBeGreaterThan(0.55);
  });

  it("index uncertainty still allows certainty when the margin is wide", () => {
    const p = probAvgAbove(
      63800,
      63431.24,
      sigma,
      5,
      60,
      { avgSoFar: 63790, elapsedSec: 55 },
      0.0001,
    );
    expect(p).toBeGreaterThan(0.999);
  });

  it("uncertainty widens the distribution outside the window too", () => {
    const tight = probAvgAbove(100050, 100000, sigma, 300, 60);
    const wide = probAvgAbove(100050, 100000, sigma, 300, 60, null, 0.0005);
    // Both favor UP, but uncertainty pulls the estimate toward 50/50.
    expect(tight).toBeGreaterThan(0.5);
    expect(wide).toBeLessThan(tight);
    expect(wide).toBeGreaterThan(0.5);
  });

  it("zero uncertainty reproduces the exact prior behavior", () => {
    const a = probAvgAbove(100050, 100000, sigma, 300, 60, null, 0);
    const b = probAvgAbove(100050, 100000, sigma, 300, 60);
    expect(a).toBe(b);
  });

  it("falls back to point pricing when the window is zero", () => {
    expect(probAvgAbove(100050, 100000, sigma, 300, 0)).toBeCloseTo(
      probUp(100050, 100000, sigma, 300),
      12,
    );
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

  it("Kalshi taker fee = rate * p * (1-p)", () => {
    expect(takerFeePerShare(0.115, 0.07)).toBeCloseTo(0.07 * 0.115 * 0.885, 9);
    expect(takerFeePerShare(0.5, 0.07)).toBeCloseTo(0.07 * 0.25, 9);
    expect(takerFeePerShare(0.9, 0.07)).toBeCloseTo(0.07 * 0.09, 9);
    expect(takerFeePerShare(0.5, 0)).toBe(0);
  });

  it("entry fee comes straight off the edge", () => {
    const fee = takerFeePerShare(0.5, 0.07);
    expect(buyEdge(0.6, 0.5, fee)).toBeCloseTo(0.1 - fee, 9);
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
    fee: null,
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

  it("taker fees shrink the edge and can kill a marginal signal", () => {
    const noFee = compositeSignal({ ...base, probUp: 0.525 });
    const withFee = compositeSignal({ ...base, probUp: 0.525, fee: { rate: 0.07, exponent: 1 } });
    expect(noFee.upBuyEdge!).toBeCloseTo(0.025, 9);
    // Kalshi fee at 50c: 0.07 * 0.5 * 0.5 = 1.75c off the edge.
    expect(withFee.upBuyEdge!).toBeCloseTo(0.025 - 0.0175, 9);
    expect(noFee.direction).toBe("UP");
    expect(withFee.direction).toBe("NONE");
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
