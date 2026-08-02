/**
 * Pure quantitative functions for pricing Polymarket crypto up/down sessions.
 *
 * Everything in this file is a deterministic function of its inputs: no I/O,
 * no clocks, no hidden state. The server threads estimator state through
 * these functions explicitly.
 */

// ---------------------------------------------------------------------------
// Normal distribution
// ---------------------------------------------------------------------------

/**
 * Complementary error function, Numerical Recipes 6.2 rational Chebyshev
 * approximation. |relative error| < 1.2e-7 everywhere.
 */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const ans =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t *
                                  (1.48851587 +
                                    t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? ans : 2 - ans;
}

/** Standard normal CDF. */
export function normCdf(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2);
}

/** Standard normal PDF. */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// ---------------------------------------------------------------------------
// Volatility estimation (irregularly spaced ticks)
// ---------------------------------------------------------------------------

export interface EwmaVarState {
  /** Variance rate per second of log price (sigma^2 * 1s). */
  varPerSec: number;
  lastPrice: number;
  /** Unix ms of the last accepted tick. */
  lastTs: number;
  /** Number of returns absorbed; used for warm-up detection. */
  samples: number;
}

/** Start an estimator from the first observed tick. */
export function initEwmaVar(price: number, ts: number): EwmaVarState {
  return { varPerSec: 0, lastPrice: price, lastTs: ts, samples: 0 };
}

/**
 * Update an exponentially weighted variance-rate estimate with a new tick.
 *
 * Handles irregular tick spacing by decaying with lambda^dt where
 * lambda = 2^(-1/halfLifeSec), and normalizing the squared log return by dt
 * so the state tracks variance *per second*.
 *
 * Duplicate or out-of-order timestamps are ignored (returned unchanged).
 */
export function updateEwmaVar(
  state: EwmaVarState,
  price: number,
  ts: number,
  halfLifeSec: number,
): EwmaVarState {
  const dtSec = (ts - state.lastTs) / 1000;
  if (!(dtSec > 0) || !(price > 0)) return state;
  // Guard against pathological gaps blowing up the normalization.
  const dt = Math.min(dtSec, halfLifeSec);
  const r = Math.log(price / state.lastPrice);
  const instVarPerSec = (r * r) / dt;
  const decay = Math.pow(2, -dt / halfLifeSec);
  const varPerSec =
    state.samples === 0
      ? instVarPerSec
      : decay * state.varPerSec + (1 - decay) * instVarPerSec;
  return { varPerSec, lastPrice: price, lastTs: ts, samples: state.samples + 1 };
}

/** Sigma per sqrt(second) from an estimator state. */
export function sigmaPerSqrtSec(state: EwmaVarState): number {
  return Math.sqrt(Math.max(state.varPerSec, 0));
}

/**
 * Blend multiple half-life estimators for a target horizon: weight each
 * estimator by how close (in log space) its half-life is to the remaining
 * time, so short sessions listen to fast estimators and long sessions to
 * slow ones.
 */
export function blendSigma(
  estimators: { halfLifeSec: number; state: EwmaVarState }[],
  tauSec: number,
): number {
  const usable = estimators.filter((e) => e.state.samples >= 5);
  if (usable.length === 0) return 0;
  let wSum = 0;
  let vSum = 0;
  for (const e of usable) {
    const d = Math.abs(Math.log(e.halfLifeSec / Math.max(tauSec, 1)));
    const w = 1 / (1 + d * d);
    wSum += w;
    vSum += w * Math.max(e.state.varPerSec, 0);
  }
  return wSum > 0 ? Math.sqrt(vSum / wSum) : 0;
}

// ---------------------------------------------------------------------------
// Binary option pricing
// ---------------------------------------------------------------------------

/**
 * Probability that a driftless geometric Brownian motion ends above `strike`
 * after `tauSec` seconds, given the current `spot` and a volatility rate of
 * `sigmaSqrtSec` per sqrt(second).
 *
 *   P(S_T > K) = Phi( (ln(S/K) - sigma^2 tau / 2) / (sigma sqrt(tau)) )
 *
 * An optional `driftPerSec` (mu, per second, in log space) shifts the mean.
 * Degenerate cases resolve to the indicator ln(S/K) > 0.
 */
export function probUp(
  spot: number,
  strike: number,
  sigmaSqrtSec: number,
  tauSec: number,
  driftPerSec = 0,
): number {
  if (!(spot > 0) || !(strike > 0)) return NaN;
  const m = Math.log(spot / strike);
  if (!(tauSec > 0)) return m > 0 ? 1 : m < 0 ? 0 : 0.5;
  const sT = sigmaSqrtSec * Math.sqrt(tauSec);
  if (!(sT > 0)) {
    const shifted = m + driftPerSec * tauSec;
    return shifted > 0 ? 1 : shifted < 0 ? 0 : 0.5;
  }
  const d2 = (m + (driftPerSec - (sigmaSqrtSec * sigmaSqrtSec) / 2) * tauSec) / sT;
  return normCdf(d2);
}

/** Partially observed settlement window (the final `elapsedSec` seconds). */
export interface PartialAverage {
  /** Mean of the index prices observed so far inside the window. */
  avgSoFar: number;
  /** Seconds of the window already observed (0..window). */
  elapsedSec: number;
}

/**
 * Probability that the **time-average** of the price over the final
 * `avgWindowSec` seconds ends above `strike` — the CF Benchmarks settlement
 * rule (e.g. Kalshi crypto markets: mean of the 60 one-second RTI prices
 * before expiry).
 *
 * Outside the window (tau > w): the average of a driftless GBM over the
 * final w seconds is approximately lognormal with variance
 * sigma^2 * ((tau - w) + w/3), so we price with that effective tau. The
 * w/3 term is the classic variance of a Brownian time-average.
 *
 * Inside the window (tau <= w): settlement is
 *   X = (e * avgObserved + tau * avgFuture) / w,   e = w - tau observed,
 * so X > K  <=>  avgFuture > K' = (w*K - e*avgObserved) / tau, and the
 * future short-window average has variance ~ sigma^2 * tau/3. When the
 * observed average has already banked enough, K' drops to/below zero and
 * the probability pins to 1 (a "locked by the average" market) — this is
 * exactly the regime where these markets misprice most.
 */
export function probAvgAbove(
  spot: number,
  strike: number,
  sigmaSqrtSec: number,
  tauSec: number,
  avgWindowSec = 60,
  partial: PartialAverage | null = null,
): number {
  if (!(spot > 0) || !(strike > 0)) return NaN;
  const w = avgWindowSec;
  if (!(w > 0)) return probUp(spot, strike, sigmaSqrtSec, tauSec);

  if (tauSec >= w) {
    const tauEff = (tauSec - w) + w / 3;
    return probUp(spot, strike, sigmaSqrtSec, tauEff);
  }

  const tau = Math.max(tauSec, 0);
  const elapsed = Math.min(Math.max(partial?.elapsedSec ?? w - tau, 0), w);
  // Without observed data, the best estimate of the observed leg is spot.
  const avgObs = partial?.avgSoFar ?? spot;

  if (tau <= 0.001) {
    return avgObs > strike ? 1 : avgObs < strike ? 0 : 0.5;
  }

  // The future leg carries weight (w - elapsed) of the window average.
  const futureSec = Math.max(w - elapsed, 0.001);
  const kAdj = (w * strike - elapsed * avgObs) / futureSec;
  if (kAdj <= 0) return 1; // average already banked above the strike
  return probUp(spot, kAdj, sigmaSqrtSec, futureSec / 3);
}

/**
 * Sensitivity of the UP probability to a $1 move in spot (binary delta):
 * dP/dS = phi(d2) / (S sigma sqrt(tau)).
 */
export function binaryDelta(
  spot: number,
  strike: number,
  sigmaSqrtSec: number,
  tauSec: number,
): number {
  if (!(spot > 0) || !(strike > 0) || !(tauSec > 0)) return 0;
  const sT = sigmaSqrtSec * Math.sqrt(tauSec);
  if (!(sT > 0)) return 0;
  const d2 = (Math.log(spot / strike) - (sigmaSqrtSec * sigmaSqrtSec * tauSec) / 2) / sT;
  return normPdf(d2) / (spot * sT);
}

/**
 * The absolute spot move (in $) that would take the UP probability to 50%,
 * i.e. the distance to the strike. Positive means spot must rise.
 */
export function breakevenMove(spot: number, strike: number): number {
  return strike - spot;
}

// ---------------------------------------------------------------------------
// Edges, sizing and market microstructure
// ---------------------------------------------------------------------------

/**
 * Kalshi taker fee per contract at a given price (in dollars, 0..1):
 * fee = rate * (price * (1 - price))^exponent — Kalshi's published formula
 * with rate 0.07 and exponent 1. (The exchange rounds the total up to the
 * next cent per order; per-share sizing uses the unrounded value.)
 */
export function takerFeePerShare(price: number, rate: number, exponent = 1): number {
  if (!(price > 0) || price >= 1 || !(rate > 0)) return 0;
  return rate * Math.pow(price * (1 - price), exponent);
}

/**
 * Expected value per $1 share of buying at `price` when the true win
 * probability is `p`: p - price - feePerShare. `feePerShare` is the taker
 * fee paid on entry (see takerFeePerShare).
 */
export function buyEdge(p: number, price: number, feePerShare = 0): number {
  if (!isFinite(p) || !(price > 0) || price >= 1) return NaN;
  return p - price - feePerShare;
}

/**
 * Full Kelly fraction for a binary contract bought at `price` with win
 * probability `p`: f* = (p - price) / (1 - price), clamped to [0, 1].
 */
export function kellyFraction(p: number, price: number): number {
  if (!(price > 0) || price >= 1 || !isFinite(p)) return 0;
  return Math.min(1, Math.max(0, (p - price) / (1 - price)));
}

/** Size-weighted mid ("microprice") from best bid/ask. */
export function microprice(
  bidPrice: number,
  bidSize: number,
  askPrice: number,
  askSize: number,
): number | null {
  const den = bidSize + askSize;
  if (!(den > 0)) return null;
  return (askPrice * bidSize + bidPrice * askSize) / den;
}

/** Depth imbalance in [-1, 1]: positive means more bid-side depth. */
export function bookImbalance(bidDepth: number, askDepth: number): number | null {
  const den = bidDepth + askDepth;
  if (!(den > 0)) return null;
  return (bidDepth - askDepth) / den;
}

// ---------------------------------------------------------------------------
// Basis (Binance leads Chainlink) tracking
// ---------------------------------------------------------------------------

export interface BasisState {
  /** EWMA of the basis (fractional: (binance-chainlink)/chainlink). */
  mean: number;
  /** EWMA of squared deviation from the mean. */
  varr: number;
  samples: number;
}

export function initBasis(): BasisState {
  return { mean: 0, varr: 0, samples: 0 };
}

/**
 * Update the basis tracker with a simultaneous (chainlink, binance) pair.
 * `alpha` is the EWMA weight of the new observation.
 */
export function updateBasis(
  state: BasisState,
  chainlink: number,
  binance: number,
  alpha = 0.05,
): BasisState {
  if (!(chainlink > 0) || !(binance > 0)) return state;
  const b = (binance - chainlink) / chainlink;
  if (state.samples === 0) {
    return { mean: b, varr: 0, samples: 1 };
  }
  const mean = (1 - alpha) * state.mean + alpha * b;
  const dev = b - state.mean;
  const varr = (1 - alpha) * state.varr + alpha * dev * dev;
  return { mean, varr, samples: state.samples + 1 };
}

/**
 * Z-score of the *current* basis against its own history. Chainlink
 * aggregates many venues, so a persistently stretched basis suggests the
 * oracle print will drift toward the leading venue.
 */
export function basisZ(
  state: BasisState,
  chainlink: number,
  binance: number,
): number | null {
  if (state.samples < 30 || !(chainlink > 0) || !(binance > 0)) return null;
  const sd = Math.sqrt(state.varr);
  if (!(sd > 1e-12)) return null;
  const b = (binance - chainlink) / chainlink;
  return (b - state.mean) / sd;
}

// ---------------------------------------------------------------------------
// Composite signal
// ---------------------------------------------------------------------------

export interface SignalInputs {
  probUp: number;
  upAsk: number | null;
  upBid: number | null;
  downAsk: number | null;
  downBid: number | null;
  /** Basis z-score (positive: Binance above Chainlink). */
  basisZ: number | null;
  /** UP-token book imbalance in [-1,1]. */
  upImbalance: number | null;
  /** DOWN-token book imbalance in [-1,1]. */
  downImbalance: number | null;
  secondsLeft: number;
  horizonSec: number;
  /** Taker fee schedule; null for feeless markets. */
  fee: { rate: number; exponent: number } | null;
}

export interface CompositeSignal {
  direction: "UP" | "DOWN" | "NONE";
  strength: number;
  upBuyEdge: number | null;
  downBuyEdge: number | null;
  kellyFraction: number | null;
  components: { id: string; label: string; score: number; detail: string }[];
  phase: "WARMING_UP" | "TRADEABLE" | "NEAR_LOCK" | "LOCKED";
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Combine model edge, basis lead and book imbalance into a single
 * recommendation. Weights favor the pricing model; microstructure terms act
 * as confirmation. Pure function: same inputs, same answer.
 */
export function compositeSignal(inp: SignalInputs): CompositeSignal {
  const components: CompositeSignal["components"] = [];

  const feeAt = (price: number) =>
    inp.fee ? takerFeePerShare(price, inp.fee.rate, inp.fee.exponent) : 0;
  const upEdge =
    inp.upAsk != null ? buyEdge(inp.probUp, inp.upAsk, feeAt(inp.upAsk)) : null;
  const downEdge =
    inp.downAsk != null ? buyEdge(1 - inp.probUp, inp.downAsk, feeAt(inp.downAsk)) : null;

  // 1. Model edge: scaled so a 5-cent edge saturates the component.
  let modelScore = 0;
  if (upEdge != null && downEdge != null) {
    const best = upEdge >= downEdge ? upEdge : -downEdge;
    modelScore = clamp(best / 0.05, -1, 1);
    components.push({
      id: "model_edge",
      label: "Model edge vs market",
      score: modelScore,
      detail:
        `fair UP ${(inp.probUp * 100).toFixed(1)}c; ` +
        `UP buy edge ${upEdge >= 0 ? "+" : ""}${(upEdge * 100).toFixed(1)}c, ` +
        `DOWN buy edge ${downEdge >= 0 ? "+" : ""}${(downEdge * 100).toFixed(1)}c`,
    });
  }

  // 2. Basis lead: |z| of 3 saturates.
  let basisScore = 0;
  if (inp.basisZ != null) {
    basisScore = clamp(inp.basisZ / 3, -1, 1);
    components.push({
      id: "basis_lead",
      label: "Binance leads Chainlink",
      score: basisScore,
      detail: `basis z-score ${inp.basisZ.toFixed(2)} (positive = spot venues above oracle)`,
    });
  }

  // 3. Order book imbalance: bid pressure on UP minus bid pressure on DOWN.
  let bookScore = 0;
  if (inp.upImbalance != null && inp.downImbalance != null) {
    bookScore = clamp((inp.upImbalance - inp.downImbalance) / 2, -1, 1);
    components.push({
      id: "book_flow",
      label: "Order book pressure",
      score: bookScore,
      detail:
        `UP imbalance ${(inp.upImbalance * 100).toFixed(0)}%, ` +
        `DOWN imbalance ${(inp.downImbalance * 100).toFixed(0)}%`,
    });
  }

  const score = 0.6 * modelScore + 0.25 * basisScore + 0.15 * bookScore;

  // Session phase gates.
  const frac = inp.secondsLeft / inp.horizonSec;
  let phase: CompositeSignal["phase"];
  if (inp.secondsLeft <= 10) phase = "LOCKED";
  else if (inp.secondsLeft <= Math.max(20, inp.horizonSec * 0.05)) phase = "NEAR_LOCK";
  else if (frac > 0.97) phase = "WARMING_UP";
  else phase = "TRADEABLE";

  const strength = Math.round(Math.abs(score) * 100);
  let direction: CompositeSignal["direction"] = "NONE";
  if (phase === "TRADEABLE" || phase === "NEAR_LOCK") {
    if (score > 0.15) direction = "UP";
    else if (score < -0.15) direction = "DOWN";
  }

  let kelly: number | null = null;
  if (direction === "UP" && inp.upAsk != null) {
    // Kelly on the fee-inclusive effective price (half-Kelly).
    kelly = 0.5 * kellyFraction(inp.probUp, Math.min(0.999, inp.upAsk + feeAt(inp.upAsk)));
  } else if (direction === "DOWN" && inp.downAsk != null) {
    kelly = 0.5 * kellyFraction(1 - inp.probUp, Math.min(0.999, inp.downAsk + feeAt(inp.downAsk)));
  }
  if (kelly != null) kelly = Math.min(kelly, 0.1); // hard cap at 10% of bankroll

  return {
    direction,
    strength,
    upBuyEdge: upEdge,
    downBuyEdge: downEdge,
    kellyFraction: kelly,
    components,
    phase,
  };
}

// ---------------------------------------------------------------------------
// Annualization helper (display only)
// ---------------------------------------------------------------------------

const SECONDS_PER_YEAR = 365 * 24 * 3600;

export function annualizedVol(sigmaSqrtSec: number): number {
  return sigmaSqrtSec * Math.sqrt(SECONDS_PER_YEAR);
}
