import type { AssetId, HorizonId, MarketInfo } from "@polysignal/shared";
import { ASSETS, GAMMA_URL, HORIZONS, USER_AGENT } from "../config.js";

interface GammaMarket {
  id?: string | number;
  question?: string;
  slug?: string;
  conditionId?: string;
  clobTokenIds?: string | string[];
  outcomes?: string | string[];
  endDate?: string;
  startDate?: string;
  negRisk?: boolean;
  orderPriceMinTickSize?: number | string;
  [key: string]: unknown;
}

interface GammaEvent {
  id?: string | number;
  slug?: string;
  title?: string;
  startDate?: string;
  endDate?: string;
  markets?: GammaMarket[];
  [key: string]: unknown;
}

export interface DiscoveredMarket {
  info: MarketInfo;
  /** Strike published by Gamma, when the API exposes one. */
  gammaStrike: number | null;
}

export async function fetchJson<T>(url: string, timeoutMs = 10000): Promise<T> {
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Slot start (unix seconds) of the session containing `nowMs`. */
export function slotStartSec(nowMs: number, horizon: HorizonId): number {
  const len = HORIZONS[horizon].seconds;
  return Math.floor(nowMs / 1000 / len) * len;
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** Legacy hourly slug: "ethereum-up-or-down-august-2-5am-et" (ET clock). */
function legacyHourlySlug(legacyName: string, slotSec: number): string {
  const et = new Date(slotSec * 1000).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    hour12: true,
  });
  // e.g. "8/2, 5 AM"
  const m = et.match(/(\d+)\/(\d+),\s*(\d+)\s*(AM|PM)/i);
  if (!m) return "";
  const [, month, day, hour, ampm] = m;
  return `${legacyName}-up-or-down-${MONTHS[Number(month) - 1]}-${day}-${hour}${ampm.toLowerCase()}-et`;
}

/** Legacy daily slug: "bitcoin-up-or-down-on-august-2" (ET date). */
function legacyDailySlug(legacyName: string, slotSec: number): string {
  const et = new Date(slotSec * 1000).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "numeric",
    day: "numeric",
  });
  const m = et.match(/(\d+)\/(\d+)/);
  if (!m) return "";
  const [, month, day] = m;
  return `${legacyName}-up-or-down-on-${MONTHS[Number(month) - 1]}-${day}`;
}

/**
 * Candidate Gamma slugs for the session covering `nowMs`, most likely first.
 * The updown slug family (`btc-updown-15m-<slot>`) is verified for 15m; other
 * horizons include fallbacks that are tried in order until one resolves.
 */
export function candidateSlugs(asset: AssetId, horizon: HorizonId, nowMs: number): string[] {
  const a = ASSETS[asset];
  const slot = slotStartSec(nowMs, horizon);
  switch (horizon) {
    case "5m":
      return [`${a.slugPrefix}-updown-5m-${slot}`];
    case "15m":
      return [`${a.slugPrefix}-updown-15m-${slot}`];
    case "1h":
      // Hourly series uses legacy word slugs ("bitcoin-up-or-down-august-1-10pm-et",
      // verified live); the next hour is a fallback around rollover.
      return [
        legacyHourlySlug(a.legacyName, slot),
        legacyHourlySlug(a.legacyName, slot + 3600),
        `${a.slugPrefix}-updown-1h-${slot}`,
      ].filter(Boolean);
    case "1d": {
      // Daily series uses "…-up-or-down-on-<et-date>" (noon-ET to noon-ET,
      // verified live). Today's ET date may already be resolved after noon,
      // so tomorrow is a first-class candidate; expired markets are rejected
      // by discoverMarket.
      return [
        legacyDailySlug(a.legacyName, nowMs / 1000),
        legacyDailySlug(a.legacyName, nowMs / 1000 + 86400),
        `${a.slugPrefix}-updown-1d-${slot}`,
      ].filter(Boolean);
    }
  }
}

function parseList(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Keys under which Gamma has been observed to expose an updown strike. */
const STRIKE_KEYS = [
  "line", "strikePrice", "strike_price", "priceToBeat", "price_to_beat",
  "targetPrice", "target_price", "openPrice", "open_price", "referencePrice",
];

function findStrike(objs: Record<string, unknown>[]): number | null {
  for (const obj of objs) {
    for (const key of STRIKE_KEYS) {
      const v = obj[key];
      const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/**
 * crypto_fees_v2: fee/share = rate * min(p, 1-p)^exponent, taker-only.
 * Falls back to takerBaseFee (bps) when feesEnabled without a schedule.
 */
function parseFeeSchedule(
  market: GammaMarket,
): { rate: number; exponent: number } | null {
  let sched = market.feeSchedule as unknown;
  if (typeof sched === "string") {
    try {
      sched = JSON.parse(sched);
    } catch {
      sched = null;
    }
  }
  if (sched && typeof sched === "object") {
    const s = sched as { rate?: number; exponent?: number };
    if (typeof s.rate === "number" && s.rate > 0) {
      return { rate: s.rate, exponent: typeof s.exponent === "number" ? s.exponent : 1 };
    }
  }
  if (market.feesEnabled === true) {
    const bps = Number(market.takerBaseFee);
    if (Number.isFinite(bps) && bps > 0) return { rate: bps / 10000, exponent: 1 };
  }
  return null;
}

export async function discoverMarket(
  asset: AssetId,
  horizon: HorizonId,
  nowMs: number,
): Promise<DiscoveredMarket> {
  const slugs = candidateSlugs(asset, horizon, nowMs);
  const errors: string[] = [];
  for (const slug of slugs) {
    try {
      const events = await fetchJson<GammaEvent[]>(
        `${GAMMA_URL}/events?slug=${encodeURIComponent(slug)}`,
      );
      const event = events?.[0];
      const market = event?.markets?.[0];
      if (!event || !market) {
        errors.push(`${slug}: no event/market`);
        continue;
      }
      const tokens = parseList(market.clobTokenIds);
      const outcomes = parseList(market.outcomes).map((o) => o.toLowerCase());
      if (tokens.length < 2) {
        errors.push(`${slug}: missing clobTokenIds`);
        continue;
      }
      let upIdx = outcomes.findIndex((o) => o === "up" || o === "yes");
      let downIdx = outcomes.findIndex((o) => o === "down" || o === "no");
      if (upIdx < 0 || downIdx < 0) {
        upIdx = 0;
        downIdx = 1;
      }
      const len = HORIZONS[horizon].seconds * 1000;
      const slotStartMs = slotStartSec(nowMs, horizon) * 1000;
      const endFromApi = market.endDate ? Date.parse(market.endDate) : NaN;
      // event.startTime / market.eventStartTime carry the authoritative
      // session open (market.startDate is the *creation* time — not usable).
      const sessionStart = Date.parse(
        String(market.eventStartTime ?? event.startTime ?? ""),
      );
      const endTs = Number.isFinite(endFromApi) ? endFromApi : slotStartMs + len;
      const startTs = Number.isFinite(sessionStart)
        ? sessionStart
        : slug.includes("-updown-")
          ? slotStartMs
          : endTs - len;
      if (endTs <= nowMs) {
        errors.push(`${slug}: already ended`);
        continue;
      }
      const info: MarketInfo = {
        slug,
        question: market.question ?? event.title ?? slug,
        conditionId: String(market.conditionId ?? ""),
        negRisk: Boolean(market.negRisk),
        upTokenId: tokens[upIdx],
        downTokenId: tokens[downIdx],
        startTs,
        endTs,
        tickSize: market.orderPriceMinTickSize != null ? Number(market.orderPriceMinTickSize) : null,
        gammaMarketId: market.id != null ? String(market.id) : null,
        feeSchedule: parseFeeSchedule(market),
      };
      const gammaStrike = findStrike([
        market as Record<string, unknown>,
        event as Record<string, unknown>,
      ]);
      return { info, gammaStrike };
    } catch (err) {
      errors.push(`${slug}: ${(err as Error).message}`);
    }
  }
  throw new Error(`no market found (tried: ${errors.join(" | ")})`);
}
