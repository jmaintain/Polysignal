import type { AssetId, HorizonId } from "@polysignal/shared";

export const KALSHI_API_URL = "https://api.elections.kalshi.com/trade-api/v2";
export const KALSHI_WS_URL = "wss://api.elections.kalshi.com/trade-api/ws/v2";
/** Signed-path prefix used in API-key signatures. */
export const KALSHI_API_PATH_PREFIX = "/trade-api/v2";
export const KALSHI_WS_PATH = "/trade-api/ws/v2";

export interface AssetConfig {
  id: AssetId;
  name: string;
  /** Regex fragment matching this asset in Kalshi tickers. */
  tickerMatch: RegExp;
  /** Constituent exchange product ids for the CF RTI proxy. */
  coinbaseProduct: string;
  krakenPair: string;
  bitstampChannelSuffix: string;
  /** Binance stream symbol (lowercase) for the lead indicator. */
  binanceSymbol: string;
}

export const ASSETS: Record<AssetId, AssetConfig> = {
  btc: {
    id: "btc",
    name: "Bitcoin",
    tickerMatch: /BTC|XBT|BITCOIN/i,
    coinbaseProduct: "BTC-USD",
    krakenPair: "XBT/USD",
    bitstampChannelSuffix: "btcusd",
    binanceSymbol: "btcusdt",
  },
  eth: {
    id: "eth",
    name: "Ethereum",
    tickerMatch: /ETH|ETHEREUM/i,
    coinbaseProduct: "ETH-USD",
    krakenPair: "ETH/USD",
    bitstampChannelSuffix: "ethusd",
    binanceSymbol: "ethusdt",
  },
  sol: {
    id: "sol",
    name: "Solana",
    tickerMatch: /SOL|SOLANA/i,
    coinbaseProduct: "SOL-USD",
    krakenPair: "SOL/USD",
    bitstampChannelSuffix: "solusd",
    binanceSymbol: "solusdt",
  },
};

export interface HorizonConfig {
  id: HorizonId;
  seconds: number;
  label: string;
}

export const HORIZONS: Record<HorizonId, HorizonConfig> = {
  "15m": { id: "15m", seconds: 900, label: "15 min" },
  "1h": { id: "1h", seconds: 3600, label: "1 hour" },
  "1d": { id: "1d", seconds: 86400, label: "Daily" },
};

export const ASSET_IDS = Object.keys(ASSETS) as AssetId[];
export const HORIZON_IDS = Object.keys(HORIZONS) as HorizonId[];

/**
 * Kalshi series tickers per asset/horizon. Auto-discovered at runtime by
 * scanning open events (see discovery.ts); these env vars pin them when the
 * scan is ambiguous, e.g. KALSHI_SERIES_BTC_15M=KXBTC15M.
 */
export function seriesOverride(asset: AssetId, horizon: HorizonId): string | null {
  const key = `KALSHI_SERIES_${asset.toUpperCase()}_${horizon.toUpperCase()}`;
  return process.env[key] || null;
}

/** CF Benchmarks settlement rule: average of the final 60 seconds. */
export const SETTLE_WINDOW_SEC = 60;

/** Kalshi taker fee: fee = rate * p * (1-p) per contract. */
export const KALSHI_FEE_RATE = Number(process.env.KALSHI_FEE_RATE ?? "0.07");

/** Vol estimator half-lives (seconds), fast to slow. */
export const VOL_HALF_LIVES = [60, 300, 1800, 21600];

export const SERVER_PORT = Number(process.env.PORT ?? "8788");

/** How much tick history to retain per asset/source (charts + vol). */
export const TICK_BUFFER_MS = 45 * 60 * 1000;

/** Index proxy sampling cadence (RTI publishes ~1/sec). */
export const INDEX_SAMPLE_MS = 1000;

/** A constituent quote older than this is excluded from the composite. */
export const INDEX_STALE_MS = 6000;

export const USER_AGENT = "polysignal/2.0 (open-source monitor)";
