import type { AssetId, HorizonId, MarketInfo } from "@polysignal/shared";
import {
  HORIZONS,
  HORIZON_IDS,
  KALSHI_FEE_RATE,
  SETTLE_WINDOW_SEC,
  seriesFor,
} from "../config.js";
import { priceDollars, type KalshiApi, type KalshiMarket } from "./kalshiApi.js";

/**
 * Kalshi market discovery.
 *
 * Series tickers are probe-verified constants (config.SERIES_DEFAULTS,
 * overridable via env). Hourly and daily series are **strike ladders**: one
 * session (event) holds dozens of "above $X" markets. We therefore resolve
 * the session's *event* first and read that event's complete market list —
 * a flat /markets?series_ticker=… query truncates at the page limit and can
 * hide the at-the-money rung entirely.
 */

/** Raised when a series exists but the exchange lists nothing open now. */
export class NotListedError extends Error {
  readonly notListed = true;
}

export function isNotListed(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { notListed?: boolean }).notListed === true
  );
}

export interface DiscoveredMarket {
  info: MarketInfo;
}

export interface DiscoverOptions {
  /** Re-check the ATM strike within a known session without re-listing events. */
  preferEventTicker?: string | null;
  log?: (m: string) => void;
}

export async function discoverMarket(
  api: KalshiApi,
  asset: AssetId,
  horizon: HorizonId,
  nowMs: number,
  spotHint: number | null,
  opts: DiscoverOptions = {},
): Promise<DiscoveredMarket> {
  const candidates = seriesFor(asset, horizon);
  if (candidates.length === 0) {
    throw new NotListedError(`Kalshi lists no ${horizon} market for ${asset.toUpperCase()}`);
  }

  // Cheap path: same session, just re-center the ladder on the ATM strike.
  if (opts.preferEventTicker) {
    try {
      const body = await api.getMarkets({ event_ticker: opts.preferEventTicker, limit: 200 });
      const built = buildFromMarkets(
        body.markets ?? [],
        seriesOf(opts.preferEventTicker, candidates),
        horizon,
        nowMs,
        spotHint,
      );
      if (built) return { info: built };
    } catch {
      /* fall through to a full lookup */
    }
  }

  const errors: string[] = [];
  let allNotListed = true;
  for (const seriesTicker of candidates) {
    try {
      return { info: await discoverInSeries(api, seriesTicker, horizon, nowMs, spotHint) };
    } catch (err) {
      if (!isNotListed(err)) allNotListed = false;
      errors.push((err as Error).message);
    }
  }
  const message = errors.join(" | ");
  throw allNotListed ? new NotListedError(message) : new Error(message);
}

function seriesOf(eventTicker: string, candidates: string[]): string {
  return candidates.find((c) => eventTicker.startsWith(c)) ?? eventTicker.split("-")[0];
}

async function discoverInSeries(
  api: KalshiApi,
  seriesTicker: string,
  horizon: HorizonId,
  nowMs: number,
  spotHint: number | null,
): Promise<MarketInfo> {
  // Events carry their full ladder when requested with nested markets.
  const body = await api.getEvents({
    series_ticker: seriesTicker,
    status: "open",
    limit: 50,
    with_nested_markets: "true",
  });
  const events = body.events ?? [];
  if (events.length === 0) {
    throw new NotListedError(`${seriesTicker}: no open sessions listed right now`);
  }

  // Rank sessions by their soonest still-future close.
  const ranked: { eventTicker: string; close: number; markets: KalshiMarket[] }[] = [];
  for (const ev of events) {
    const markets = (ev.markets ?? []).filter((m) => isTradeable(m, nowMs));
    if (markets.length === 0) continue;
    const close = Math.min(...markets.map((m) => Date.parse(m.close_time!)));
    ranked.push({ eventTicker: ev.event_ticker, close, markets });
  }
  ranked.sort((a, b) => a.close - b.close);

  // Fall back to per-event market fetches when nested markets are absent.
  if (ranked.length === 0) {
    for (const ev of events.slice(0, 6)) {
      const fetched = await api.getMarkets({ event_ticker: ev.event_ticker, limit: 200 });
      const markets = (fetched.markets ?? []).filter((m) => isTradeable(m, nowMs));
      if (markets.length === 0) continue;
      const close = Math.min(...markets.map((m) => Date.parse(m.close_time!)));
      ranked.push({ eventTicker: ev.event_ticker, close, markets });
    }
    ranked.sort((a, b) => a.close - b.close);
  }
  if (ranked.length === 0) {
    throw new NotListedError(`${seriesTicker}: no open markets ahead of now`);
  }

  const session = ranked[0];
  const info = buildFromMarkets(session.markets, seriesTicker, horizon, nowMs, spotHint);
  if (!info) {
    throw new Error(
      `${seriesTicker}: ladder of ${session.markets.length} needs a live index price to pick the ATM strike`,
    );
  }
  return info;
}

function isTradeable(m: KalshiMarket, nowMs: number): boolean {
  const close = Date.parse(m.close_time ?? "");
  return (
    Number.isFinite(close) &&
    close > nowMs + 5000 &&
    m.status !== "settled" &&
    m.status !== "closed" &&
    Number.isFinite(Number(m.floor_strike ?? m.cap_strike))
  );
}

function buildFromMarkets(
  all: KalshiMarket[],
  seriesTicker: string,
  horizon: HorizonId,
  nowMs: number,
  spotHint: number | null,
): MarketInfo | null {
  const markets = all.filter((m) => isTradeable(m, nowMs));
  if (markets.length === 0) return null;
  const sessionClose = Math.min(...markets.map((m) => Date.parse(m.close_time!)));
  const sessionMarkets = markets.filter((m) => Date.parse(m.close_time!) === sessionClose);

  // Never pick from a ladder blind: without a live spot the "nearest 50c"
  // fallback can land on an arbitrary far-out strike.
  if (sessionMarkets.length > 1 && spotHint == null) return null;

  const market = pickAtmMarket(sessionMarkets, spotHint);
  if (!market) return null;
  const strike = Number(market.floor_strike ?? market.cap_strike);
  if (!Number.isFinite(strike)) return null;

  // Settlement averages the final minute BEFORE close_time;
  // expected_expiration_time is the later certification stamp.
  const endTs = sessionClose;
  return {
    ticker: market.ticker,
    eventTicker: market.event_ticker,
    seriesTicker,
    title: market.title ?? market.ticker,
    yesSubTitle: market.yes_sub_title && market.yes_sub_title !== "na" ? market.yes_sub_title : null,
    strike,
    strikeType: market.strike_type === "less" ? "less" : "greater",
    startTs: endTs - HORIZONS[horizon].seconds * 1000,
    endTs,
    tickSize: 0.01,
    feeSchedule: KALSHI_FEE_RATE > 0 ? { rate: KALSHI_FEE_RATE, exponent: 1 } : null,
    settleWindowSec: SETTLE_WINDOW_SEC,
    ladderSize: sessionMarkets.length,
  };
}

/** Nearest strike to spot; ties broken toward the more liquid (two-sided) book. */
function pickAtmMarket(markets: KalshiMarket[], spotHint: number | null): KalshiMarket | null {
  const pool = markets.filter((m) => m.strike_type !== "between");
  const usable = pool.length > 0 ? pool : markets;
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0];
  if (spotHint != null) {
    return [...usable].sort((a, b) => {
      const da = Math.abs(Number(a.floor_strike ?? a.cap_strike) - spotHint);
      const db = Math.abs(Number(b.floor_strike ?? b.cap_strike) - spotHint);
      if (Math.abs(da - db) > 1e-9) return da - db;
      return quoteQuality(b) - quoteQuality(a);
    })[0];
  }
  return [...usable].sort((a, b) => {
    const pa = priceDollars(a, "yes_bid") ?? 0.5;
    const pb = priceDollars(b, "yes_bid") ?? 0.5;
    return Math.abs(pa - 0.5) - Math.abs(pb - 0.5);
  })[0];
}

/** 1 when both sides are quoted inside the spread, else 0. */
function quoteQuality(m: KalshiMarket): number {
  const bid = priceDollars(m, "yes_bid");
  const ask = priceDollars(m, "yes_ask");
  return bid != null && ask != null && bid > 0.01 && ask < 0.99 ? 1 : 0;
}

export { HORIZON_IDS };
