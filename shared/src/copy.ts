/**
 * Simple Mode copy: plain-English sentences and phrase mappings.
 *
 * All wording lives in the SIMPLE_COPY dictionary so it can be edited
 * without touching classification logic. Template functions receive
 * pre-formatted strings only.
 */
import type { SessionState, SignalPhase } from "./types.js";
import type { VerdictResult } from "./verdict.js";

export interface SentenceContext {
  /** e.g. "BTC" */
  assetLabel: string;
  spot: number | null;
  strike: number | null;
  secondsLeft: number | null;
  probUp: number | null;
  phase: SignalPhase | null;
  verdict: VerdictResult;
}

export const SIMPLE_COPY = {
  situation: {
    /** {asset} {amount} {aboveBelow} {time} */
    withStrike: (asset: string, amount: string, aboveBelow: "above" | "below", time: string) =>
      `${asset} is ${amount} ${aboveBelow} the price to beat with ${time} left.`,
    atStrike: (asset: string, time: string) =>
      `${asset} is sitting right at the price to beat with ${time} left.`,
  },
  strong: {
    withDirection: (dir: "UP" | "DOWN", chance: string) =>
      `The model likes ${dir} (${chance} chance) and other exchanges are already leading the move. Worth a look.`,
  },
  weak: {
    withDirection: (dir: "UP" | "DOWN") =>
      `The model leans ${dir}, but other exchanges aren't confirming the move yet. Not strong enough to act on.`,
    flat: () => `The model sees no meaningful edge right now. Sit tight.`,
  },
  noRead: {
    warmingUp: () => `Signal still warming up for this market.`,
    locked: () => `Too close to resolution to trade — spreads eat the edge.`,
    noMarket: () => `No active market found for this horizon.`,
    noStrike: () => `Waiting for this session's opening price to lock in.`,
    default: () => `No read on this market yet.`,
  },
  /** Plain-language translations of the composite's sub-signals ("Why?"). */
  components: {
    model_edge: (score: number) =>
      `Model edge: ${leanPhrase(score, "in favor of UP", "in favor of DOWN", "no real lean either way")}`,
    basis_lead: (score: number) =>
      Math.abs(score) < 0.17
        ? `Other exchanges: barely moving ahead of the official price — not a strong confirmation`
        : `Other exchanges: ${score > 0 ? "moving up ahead of" : "moving down ahead of"} the official price — ${
            Math.abs(score) >= 0.5 ? "solid confirmation" : "mild confirmation"
          }`,
    book_flow: (score: number) =>
      `Order book: ${leanPhrase(score, "lean toward UP", "lean toward DOWN", "balanced")}`,
  },
  badges: {
    STRONG: { emoji: "🟢", label: "Good signal" },
    WEAK: { emoji: "🟡", label: "Weak signal" },
    NO_READ: { emoji: "⚪", label: "No read yet" },
  },
} as const;

function leanPhrase(score: number, up: string, down: string, flat: string): string {
  const a = Math.abs(score);
  if (a < 0.1) return flat;
  const side = score > 0 ? up : down;
  return a >= 0.5 ? `clearly ${side}` : a >= 0.25 ? `moderately ${side}` : `slightly ${side}`;
}

function fmtMoney(v: number): string {
  if (v >= 100) return `$${Math.round(v).toLocaleString("en-US")}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `${(v * 100).toFixed(1)}¢`;
}

function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} seconds`;
  if (s < 5400) {
    const m = Math.round(s / 60);
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  const h = Math.round(s / 3600);
  return `about ${h} hour${h === 1 ? "" : "s"}`;
}

/** 1-2 plain-English sentences for a market's current state. */
export function verdictSentence(ctx: SentenceContext): string {
  const { verdict } = ctx;

  if (verdict.verdict === "NO_READ") {
    const c = SIMPLE_COPY.noRead;
    if (ctx.phase === "NO_MARKET") return c.noMarket();
    if (ctx.phase === "LOCKED") return c.locked();
    if (ctx.phase === "WARMING_UP") return c.warmingUp();
    if (ctx.strike == null) return c.noStrike();
    return c.default();
  }

  const parts: string[] = [];
  if (ctx.spot != null && ctx.strike != null && ctx.secondsLeft != null) {
    const diff = ctx.spot - ctx.strike;
    const time = fmtTime(ctx.secondsLeft);
    if (Math.abs(diff) < ctx.strike * 1e-6) {
      parts.push(SIMPLE_COPY.situation.atStrike(ctx.assetLabel, time));
    } else {
      parts.push(
        SIMPLE_COPY.situation.withStrike(
          ctx.assetLabel,
          fmtMoney(Math.abs(diff)),
          diff >= 0 ? "above" : "below",
          time,
        ),
      );
    }
  }

  if (verdict.verdict === "STRONG" && verdict.direction) {
    const p = verdict.direction === "UP" ? ctx.probUp : ctx.probUp != null ? 1 - ctx.probUp : null;
    const chance = p != null ? `${Math.round(p * 100)}%` : "better than even";
    parts.push(SIMPLE_COPY.strong.withDirection(verdict.direction, chance));
  } else if (verdict.direction) {
    parts.push(SIMPLE_COPY.weak.withDirection(verdict.direction));
  } else {
    parts.push(SIMPLE_COPY.weak.flat());
  }
  return parts.join(" ");
}

/** Convenience: build the sentence context straight from a SessionState. */
export function sentenceForSession(s: SessionState, verdict: VerdictResult): string {
  return verdictSentence({
    assetLabel: s.asset.toUpperCase(),
    spot: s.spot,
    strike: s.strike,
    secondsLeft: s.secondsLeft,
    probUp: s.signal?.probUp ?? null,
    phase: s.signal?.phase ?? (s.market == null ? "NO_MARKET" : null),
    verdict,
  });
}
