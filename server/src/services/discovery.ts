import type { AssetId, HorizonId, MarketInfo } from "@polysignal/shared";
import {
  ASSETS,
  HORIZONS,
  HORIZON_IDS,
  KALSHI_FEE_RATE,
  SETTLE_WINDOW_SEC,
  seriesOverride,
} from "../config.js";
import type { KalshiApi, KalshiMarket } from "./kalshiApi.js";

/**
 * Kalshi market discovery.
 *
 * Rather than guessing ticker formats, we scan open events for series whose
 * tickers mention the asset, then classify each series' horizon from the
 * cadence of its open markets' close times (15m closes every quarter hour,
 * hourly on the hour, daily ~24h apart). KALSHI_SERIES_<ASSET>_<HORIZON>
 * env vars pin a series explicitly when needed.
 */

interface SeriesCatalog {
  /** asset -> horizon -> series ticker */
  map: Map<string, string>;
  builtAt: number;
}

let catalog: SeriesCatalog | null = null;
let catalogPromise: Promise<SeriesCatalog> | null = null;
const CATALOG_TTL_MS = 30 * 60 * 1000;

const key = (asset: AssetId, horizon: HorizonId) => `${asset}:${horizon}`;

async function scanSeries(api: KalshiApi, log: (m: string) => void): Promise<SeriesCatalog> {
  const seriesByAsset = new Map<AssetId, Set<string>>();
  for (const a of Object.keys(ASSETS) as AssetId[]) seriesByAsset.set(a, new Set());

  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const body = await api.getEvents({ status: "open", limit: 200, cursor: cursor || undefined });
    for (const ev of body.events ?? []) {
      const st = ev.series_ticker;
      if (!st) continue;
      for (const a of Object.keys(ASSETS) as AssetId[]) {
        if (ASSETS[a].tickerMatch.test(st) || ASSETS[a].tickerMatch.test(ev.event_ticker)) {
          seriesByAsset.get(a)!.add(st);
        }
      }
    }
    cursor = body.cursor ?? "";
    if (!cursor) break;
  }

  const map = new Map<string, string>();
  for (const [asset, tickers] of seriesByAsset) {
    for (const st of tickers) {
      try {
        const horizon = await classifySeries(api, st);
        if (horizon && !map.has(key(asset, horizon))) {
          map.set(key(asset, horizon), st);
          log(`discovery: ${asset.toUpperCase()} ${horizon} -> series ${st}`);
        }
      } catch {
        /* skip unclassifiable series */
      }
    }
  }
  return { map, builtAt: Date.now() };
}

/** Infer a series' horizon from the cadence of its open markets. */
async function classifySeries(api: KalshiApi, seriesTicker: string): Promise<HorizonId | null> {
  const body = await api.getMarkets({ series_ticker: seriesTicker, status: "open", limit: 40 });
  const markets = body.markets ?? [];
  const closes = [...new Set(markets.map((m) => Date.parse(m.close_time ?? "")))].filter(
    Number.isFinite,
  );
  if (closes.length === 0) return null;
  closes.sort((a, b) => a - b);
  // Cadence between distinct close times, when multiple sessions are open.
  if (closes.length >= 2) {
    const gaps = closes.slice(1).map((c, i) => (c - closes[i]) / 1000);
    const minGap = Math.min(...gaps);
    if (minGap <= 1200) return "15m";
    if (minGap <= 7200) return "1h";
    return "1d";
  }
  // Single session open: use alignment of the close time.
  const d = new Date(closes[0]);
  if (d.getUTCMinutes() % 15 === 0 && d.getUTCMinutes() !== 0) return "15m";
  // Ambiguous — check how far out it closes.
  const hoursOut = (closes[0] - Date.now()) / 3.6e6;
  if (hoursOut <= 0.3) return null; // about to roll; skip this pass
  return hoursOut <= 1.5 ? "1h" : "1d";
}

async function getCatalog(api: KalshiApi, log: (m: string) => void): Promise<SeriesCatalog> {
  if (catalog && Date.now() - catalog.builtAt < CATALOG_TTL_MS) return catalog;
  if (!catalogPromise) {
    catalogPromise = scanSeries(api, log)
      .then((c) => {
        catalog = c;
        return c;
      })
      .finally(() => {
        catalogPromise = null;
      });
  }
  return catalogPromise;
}

export function invalidateCatalog(): void {
  catalog = null;
}

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
  const pinned = seriesOverride(asset, horizon);
  let seriesTicker = pinned;
  if (!seriesTicker) {
    const cat = await getCatalog(api, log);
    seriesTicker = cat.map.get(key(asset, horizon)) ?? null;
  }
  if (!seriesTicker) {
    throw new Error(
      `no Kalshi series found for ${asset} ${horizon} (pin with KALSHI_SERIES_${asset.toUpperCase()}_${horizon.toUpperCase()})`,
    );
  }

  const body = await api.getMarkets({ series_ticker: seriesTicker, status: "open", limit: 100 });
  const markets = (body.markets ?? []).filter((m) => {
    const close = Date.parse(m.close_time ?? "");
    return Number.isFinite(close) && close > nowMs + 5000;
  });
  if (markets.length === 0) throw new Error(`${seriesTicker}: no open markets ahead of now`);

  // The active session = the earliest close time still in the future.
  const closes = markets.map((m) => Date.parse(m.close_time!));
  const sessionClose = Math.min(...closes);
  const sessionMarkets = markets.filter((m) => Date.parse(m.close_time!) === sessionClose);

  const market = pickAtmMarket(sessionMarkets, spotHint);
  if (!market) throw new Error(`${seriesTicker}: no usable strike market in session`);

  const strike = Number(market.floor_strike ?? market.cap_strike);
  if (!Number.isFinite(strike)) {
    throw new Error(`${market.ticker}: missing floor_strike`);
  }
  const endTs = Number.isFinite(Date.parse(market.expected_expiration_time ?? ""))
    ? Date.parse(market.expected_expiration_time!)
    : sessionClose;

  const info: MarketInfo = {
    ticker: market.ticker,
    eventTicker: market.event_ticker,
    seriesTicker,
    title: market.title ?? market.ticker,
    yesSubTitle: market.yes_sub_title ?? market.subtitle ?? null,
    strike,
    strikeType: market.strike_type === "less" ? "less" : "greater",
    startTs: endTs - HORIZONS[horizon].seconds * 1000,
    endTs,
    tickSize: 0.01,
    feeSchedule: KALSHI_FEE_RATE > 0 ? { rate: KALSHI_FEE_RATE, exponent: 1 } : null,
    settleWindowSec: SETTLE_WINDOW_SEC,
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
  return [...pool].sort(
    (a, b) => Math.abs((a.yes_bid ?? 50) - 50) - Math.abs((b.yes_bid ?? 50) - 50),
  )[0];
}

export { HORIZON_IDS };
