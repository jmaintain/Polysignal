/**
 * Simple Mode verdict classifier: collapses the expert-level numbers
 * (composite score, basis z-score, net-of-fee edge, session phase) into a
 * three-state read a non-trader can act on. Pure re-labeling of values the
 * engine already computes — no new signal math.
 */
import type { SessionState, SignalDirection, SignalPhase, StrikeSource } from "./types.js";

export type Verdict = "STRONG" | "WEAK" | "NO_READ";
export type VerdictConfidence = "low" | "medium" | "high";

export interface VerdictResult {
  verdict: Verdict;
  direction: "UP" | "DOWN" | null;
  confidence: VerdictConfidence;
}

/** Tunable thresholds, kept in one place. */
export const VERDICT_THRESHOLDS = {
  /** Minimum composite strength (0-100) for a STRONG verdict / medium confidence. */
  strongScore: 40,
  /** Composite strength above which confidence reads high. */
  highScore: 65,
  /** Minimum |basis z-score| for the cross-exchange move to count as confirmation. */
  confirmZ: 1.5,
  /** Sessions with less time than this (seconds) are unreadable (spread-dominated). */
  lockSeconds: 10,
} as const;

export interface VerdictInputs {
  phase: SignalPhase | null;
  strikeSource: StrikeSource;
  direction: SignalDirection;
  /** Composite strength 0-100. */
  strength: number;
  basisZ: number | null;
  /** Buy edges net of fee, in dollars per share. */
  upBuyEdge: number | null;
  downBuyEdge: number | null;
  secondsLeft: number | null;
}

export function classifyVerdict(inp: VerdictInputs): VerdictResult {
  const T = VERDICT_THRESHOLDS;

  const unreadable =
    inp.phase == null ||
    inp.phase === "WARMING_UP" ||
    inp.phase === "NO_MARKET" ||
    inp.phase === "LOCKED" ||
    inp.strikeSource === "unknown" ||
    inp.secondsLeft == null ||
    inp.secondsLeft < T.lockSeconds;
  if (unreadable) {
    return { verdict: "NO_READ", direction: null, confidence: "low" };
  }

  const direction = inp.direction === "NONE" ? null : inp.direction;
  const favoredEdge =
    direction === "UP" ? inp.upBuyEdge : direction === "DOWN" ? inp.downBuyEdge : null;
  const zConfirms = inp.basisZ != null && Math.abs(inp.basisZ) >= T.confirmZ;

  // Confidence maps from composite magnitude, downgraded one notch when the
  // cross-exchange basis is not confirming (the dashboard's own noise gate).
  let confidence: VerdictConfidence =
    inp.strength >= T.highScore ? "high" : inp.strength >= T.strongScore ? "medium" : "low";
  if (!zConfirms) {
    confidence = confidence === "high" ? "medium" : "low";
  }

  const strong =
    direction !== null &&
    inp.strength >= T.strongScore &&
    zConfirms &&
    favoredEdge != null &&
    favoredEdge > 0;

  return { verdict: strong ? "STRONG" : "WEAK", direction, confidence };
}

/** Adapter: classify straight from a SessionState as sent to the frontend. */
export function verdictForSession(s: SessionState): VerdictResult {
  const sig = s.signal;
  return classifyVerdict({
    phase: sig?.phase ?? null,
    strikeSource: s.strikeSource,
    direction: sig?.direction ?? "NONE",
    strength: sig?.strength ?? 0,
    basisZ: sig?.basisZ ?? null,
    upBuyEdge: sig?.upBuyEdge ?? null,
    downBuyEdge: sig?.downBuyEdge ?? null,
    secondsLeft: s.secondsLeft,
  });
}
