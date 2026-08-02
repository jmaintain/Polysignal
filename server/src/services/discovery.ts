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
 * Kalshi market discovery. Series tickers are probe-verified constants
 * (config.SERIES_DEFAULTS, overridable via env). Within a series we take
 * the session closing soonest and, for strike ladders (hourly/daily), the
 * at-the-money strike.
 */

export interface DiscoveredMarket {
  info: MarketInfo;
}

export async function discoverMarket(
  api: KalshiApi,
  asset: AssetId,
  horizon: HorizonId,
  nowMs: number,
  spotHint: number | null,
  log: (m: string) => void,
): Promise<DiscoveredMarket> {
  void log;
  const seriesTicker = seriesFor(asset, horizon);
  if (!seriesTicker) {
    throw new Error(`Kalshi has no ${horizon} series for ${asset.toUpperCase()}`);
  }

  const body = await api.getMarkets({ series_ticker: seriesTicker, status: "open", limit: 100 });
  const markets = (body.markets ?? []).filter((m) => {
    const close = Date.parse(m.close_time ?? "");
    return Number.isFinite(close) && close > nowMs + 5000 && m.status !== "settled";
  });
  if (markets.length === 0) throw new Error(`${seriesTicker}: no open markets ahead of now`);

  // The active session = the earliest close time still in the future.
  const sessionClose = Math.min(...markets.map((m) => Date.parse(m.close_time!)));
  const sessionMarkets = markets.filter((m) => Date.parse(m.close_time!) === sessionClose);

  // Never pick from a strike ladder blind: without a live spot price the
  // fallback can land on an arbitrary far-out strike. Discovery retries in
  // a few seconds, by which time the index proxy is ticking.
  if (sessionMarkets.length > 1 && spotHint == null) {
    throw new Error(`${seriesTicker}: waiting for index spot before picking an ATM strike`);
  }

  const market = pickAtmMarket(sessionMarkets, spotHint);
  if (!market) throw new Error(`${seriesTicker}: no usable strike market in session`);

  const strike = Number(market.floor_strike ?? market.cap_strike);
  if (!Number.isFinite(strike)) {
    throw new Error(`${market.ticker}: missing floor_strike`);
  }

  // Settlement references the final minute BEFORE close_time (the rules'
  // "sixty seconds before <time>"); expected_expiration_time is the later
  // certification timestamp and must NOT shift the averaging window.
  const endTs = sessionClose;

  const info: MarketInfo = {
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
  return { info };
}

/**
 * From one session's markets (a single up/down market or a strike ladder),
 * pick the at-the-money strike: nearest floor_strike to spot, falling back
 * to the market whose yes price is closest to 50c.
 */
function pickAtmMarket(markets: KalshiMarket[], spotHint: number | null): KalshiMarket | null {
  const usable = markets.filter(
    (m) => m.strike_type !== "between" && Number.isFinite(Number(m.floor_strike ?? m.cap_strike)),
  );
  const pool = usable.length > 0 ? usable : markets;
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];
  if (spotHint != null) {
    return [...pool].sort(
      (a, b) =>
        Math.abs(Number(a.floor_strike ?? a.cap_strike) - spotHint) -
        Math.abs(Number(b.floor_strike ?? b.cap_strike) - spotHint),
    )[0];
  }
  return [...pool].sort((a, b) => {
    const pa = priceDollars(a, "yes_bid") ?? 0.5;
    const pb = priceDollars(b, "yes_bid") ?? 0.5;
    return Math.abs(pa - 0.5) - Math.abs(pb - 0.5);
  })[0];
}

export { HORIZON_IDS };
