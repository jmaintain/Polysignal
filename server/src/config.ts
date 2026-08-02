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

/**
 * Assets the monitor tracks. BTC only by default — it is the one market
 * with spreads tight enough to trade (1c vs 6c on SOL). Widen with
 * POLYSIGNAL_ASSETS=btc,eth,sol.
 */
const enabledAssets = (process.env.POLYSIGNAL_ASSETS ?? "btc")
  .split(",")
  .map((s) => s.trim().toLowerCase());

export const ASSET_IDS = (Object.keys(ASSETS) as AssetId[]).filter((a) =>
  enabledAssets.includes(a),
);
export const HORIZON_IDS = Object.keys(HORIZONS) as HorizonId[];

/** Final-minute recorder (see services/recorder.ts). */
export const RECORD_ENABLED = process.env.RECORD !== "false";
export const RECORD_DIR = process.env.RECORD_DIR ?? "./data";

/**
 * Kalshi series tickers per asset/horizon, verified live via `npm run
 * probe` (2026-08-02): the 15m series are the "price up down" family, the
 * hourly are the "Above/below"/"Directional" family, dailies are the
 * legacy above/below series. SOL has no daily series on Kalshi today.
 * KALSHI_SERIES_<ASSET>_<HORIZON> env vars override.
 */
export const SERIES_DEFAULTS: Record<AssetId, Record<HorizonId, string[]>> = {
  btc: { "15m": ["KXBTC15M"], "1h": ["KXBTCD"], "1d": ["BTCD", "BTCD-B"] },
  eth: { "15m": ["KXETH15M"], "1h": ["KXETHD"], "1d": ["ETHD"] },
  // Kalshi lists no SOL daily above/below series today.
  sol: { "15m": ["KXSOL15M"], "1h": ["KXSOLD"], "1d": [] },
};

/** Candidate series for an asset/horizon, most likely first. */
export function seriesFor(asset: AssetId, horizon: HorizonId): string[] {
  const key = `KALSHI_SERIES_${asset.toUpperCase()}_${horizon.toUpperCase()}`;
  const override = process.env[key];
  if (override) return override.split(",").map((s) => s.trim()).filter(Boolean);
  return SERIES_DEFAULTS[asset][horizon];
}

/** CF Benchmarks settlement rule: average of the final 60 seconds. */
export const SETTLE_WINDOW_SEC = 60;

/**
 * Fractional uncertainty of our RTI proxy versus the official index.
 * Measured live at 0.8bp against a published Kalshi settlement
 * (`npm run validate:settle`); 1.5bp is a deliberately conservative
 * default because near-the-money settlements are decided by margins of
 * exactly this size. Set INDEX_UNCERTAINTY_BPS=0 to price the proxy as
 * exact (not recommended).
 */
export const INDEX_UNCERTAINTY = Number(process.env.INDEX_UNCERTAINTY_BPS ?? "1.5") / 10000;

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
